import { App, TFile, normalizePath, Notice, parseYaml } from "obsidian";
import * as logger from "../logger";
import { ExternalCalendarService } from "./external-calendar-service";
import { ExternalCalendarEvent } from "../types";
import { createMeetingNoteFromExternalEvent } from "./external-event-modal";
import { formatDateTimeForFrontmatter, parseFrontmatterDate, matchesExclusionPattern, normalizeCalendarUrl, normalizeComparablePath } from "../utils";
import { mergeTagInputs, normalizeTagValue, parseTagInput } from "./tag-utils";

interface CalendarAutoCreateConfig {
    typeFolder?: string | null;
    folder?: string | null;
    tag?: string | null;
    template?: string | null;
    autoCreateEnabled?: boolean;
}

export interface AutoCreateServiceConfig {
    startProperty: string;
    endProperty: string;
    useEndDuration: boolean;
    dateFormat?: string;
    noLossSyncMode: boolean;
    syncOnEventDelete: 'delete' | 'archive' | 'nothing';
    archiveFolder: string;
    globalIgnorePaths: string[];
    canceledStatusValue: string | null;
    allowAutoCreate?: boolean;
    eventIdKey: string;
    uidKey: string;
    sourceUrlKey: string;
    titleKey: string;
    statusKey: string;
    previousStatusKey: string;
    orphanCandidateAtKey: string;
    orphanMissCountKey: string;
    orphanReasonKey: string;
    cancelledAtKey: string;
}

/** Vault note with stored frontmatter values for string-based comparison. */
interface VaultNote {
    file: TFile;
    eventId: string | null;
    uid: string;
    /** Raw frontmatter string — compared as-is, never re-parsed to Date for matching. */
    storedStart: string;
    storedEnd: string | number;
    storedTitle: string;
    storedLocation: string;
    /** Parsed start date, only used for uid+start fallback matching. */
    startDate: Date | null;
    sourceUrl: string | null;
    orphanCandidateAt: string | null;
    isArchived: boolean;
}

export class AutoCreateService {
    app: App;
    config: AutoCreateServiceConfig;
    private isSyncing = false;
    private readonly malformedFrontmatterWarnedPaths = new Set<string>();

    /**
     * Orphan grace period: tracks how many consecutive sync cycles a note
     * has gone unmatched. Persists across sync calls (instance-level state).
     * Key = file.path, Value = consecutive miss count.
     */
    private orphanMissCount: Map<string, number> = new Map();
    private static readonly ORPHAN_GRACE_CYCLES = 2;
    private orphanDeletionTombstones: Map<string, number> = new Map();
    private static readonly ORPHAN_TOMBSTONE_TTL_MS = 6 * 60 * 60 * 1000;

    constructor(app: App) {
        this.app = app;
        this.config = {
            startProperty: "scheduled",
            endProperty: "timeEstimate",
            useEndDuration: true,
            noLossSyncMode: true,
            syncOnEventDelete: 'nothing',
            archiveFolder: "",
            globalIgnorePaths: [],
            canceledStatusValue: null,
            allowAutoCreate: false,
            eventIdKey: "externalEventId",
            uidKey: "tpsCalendarUid",
            sourceUrlKey: "tpsCalendarSourceUrl",
            titleKey: "title",
            statusKey: "status",
            previousStatusKey: "tpsCalendarPrevStatus",
            orphanCandidateAtKey: "tpsCalendarOrphanCandidateAt",
            orphanMissCountKey: "tpsCalendarOrphanMissCount",
            orphanReasonKey: "tpsCalendarOrphanReason",
            cancelledAtKey: "tpsCalendarCancelledAt",
        };
    }

    updateConfig(config: Partial<AutoCreateServiceConfig>) {
        this.config = { ...this.config, ...config };
    }

    async checkAndCreateMeetingNotes(
        externalCalendarService: ExternalCalendarService,
        urls: string[],
        externalCalendarFilter: string,
        calendarConfigs: Record<string, CalendarAutoCreateConfig>,
        forceRegenerate = false
    ) {
        if (this.config.allowAutoCreate === false || this.isSyncing) return;

        const hasAutoCreate = Object.values(calendarConfigs).some(config => (config?.autoCreateEnabled ?? true) !== false);
        if (!hasAutoCreate) return;

        this.isSyncing = true;
        logger.log('[AutoCreateService] Starting change-aware sync...');

        try {
            this.pruneOrphanDeletionTombstones();

            const rangeStart = new Date();
            rangeStart.setDate(rangeStart.getDate() - 14);
            const rangeEnd = new Date();
            rangeEnd.setDate(rangeEnd.getDate() + 60);

            const filterTerms = externalCalendarFilter.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
            const fetchResult = await this.fetchAllRemoteEvents(externalCalendarService, urls, rangeStart, rangeEnd);
            const remoteEvents = fetchResult.events;
            const successfulUrls = fetchResult.successfulUrls;
            const failedUrls = fetchResult.failedUrls;
            const configuredUrlSet = new Set(urls.map((url) => normalizeCalendarUrl(url)).filter(Boolean));
            const hadFetchFailure = failedUrls.size > 0;

            // Build O(1) lookup maps from vault notes
            logger.log('[AutoCreateService] Building vault index...');
            const { byEventId, byUidStart, allNotes } = await this.buildVaultIndex();

            let created = 0, updated = 0, deleted = 0, quarantined = 0, restored = 0;
            const processedEventIds = new Set<string>();
            const processedUidStartKeys = new Set<string>();
            const matchedFilePaths = new Set<string>();

            for (const event of remoteEvents) {
                const uidStartKey = this.buildUidStartKey(event);
                if (processedEventIds.has(event.id) || processedUidStartKeys.has(uidStartKey)) {
                    continue;
                }
                processedEventIds.add(event.id);
                processedUidStartKeys.add(uidStartKey);

                try {
                    const result = await this.processEvent(
                        event,
                        byEventId,
                        byUidStart,
                        calendarConfigs[event.sourceUrl || ""],
                        filterTerms,
                        forceRegenerate
                    );

                    if (result.action === 'created') created++;
                    if (result.action === 'updated') updated++;
                    if (result.action === 'deleted') deleted++;
                    if (result.file) {
                        matchedFilePaths.add(result.file.path);
                        if (result.action === 'created') {
                            // Keep in-memory index current so this run stays idempotent.
                            const note: VaultNote = {
                                file: result.file,
                                eventId: event.id,
                                uid: event.uid || event.id,
                                storedStart: formatDateTimeForFrontmatter(event.startDate),
                                storedEnd: this.config.useEndDuration
                                    ? Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60000)
                                    : formatDateTimeForFrontmatter(event.endDate),
                                storedTitle: event.title,
                                storedLocation: event.location || "",
                                startDate: event.startDate,
                                sourceUrl: this.normalizeSourceUrl(event.sourceUrl),
                                orphanCandidateAt: null,
                                isArchived: false,
                            };
                            byEventId.set(event.id, note);
                            byUidStart.set(uidStartKey, note);
                        }
                    }
                } catch (error) {
                    logger.error(`[AutoCreateService] Error processing event "${event.title}"`, error);
                }
            }

            // Orphan Cleanup with grace period
            logger.log(`[AutoCreateService] Checking for orphaned notes...`);
            const currentOrphanPaths = new Set<string>();
            const skipOrphanCleanupBecauseNoRemoteEvents = remoteEvents.length === 0;
            if (skipOrphanCleanupBecauseNoRemoteEvents) {
                logger.warn('[AutoCreateService] Skipping orphan cleanup because remote event set is empty.');
            }
            if (hadFetchFailure) {
                logger.warn(`[AutoCreateService] Fetch failures detected for ${failedUrls.size} calendar(s); orphan cleanup will only evaluate notes tied to successful calendars.`);
            }

            for (const note of allNotes) {
                if (note.isArchived) continue;
                if (matchedFilePaths.has(note.file.path)) {
                    // Matched — reset miss count if any
                    this.orphanMissCount.delete(note.file.path);
                    if (this.config.noLossSyncMode && note.orphanCandidateAt) {
                        const wasCleared = await this.clearOrphanCandidate(note.file);
                        if (wasCleared) restored++;
                    }
                    continue;
                }
                if (!note.eventId) continue;
                if (skipOrphanCleanupBecauseNoRemoteEvents) {
                    this.orphanMissCount.delete(note.file.path);
                    continue;
                }
                if (!this.canEvaluateOrphanForNote(note, configuredUrlSet, successfulUrls, failedUrls)) {
                    this.orphanMissCount.delete(note.file.path);
                    continue;
                }

                const noteDate = note.startDate ?? this.getRecurrenceDateFromId(note.eventId);
                if (!noteDate || noteDate < rangeStart || noteDate > rangeEnd) continue;

                currentOrphanPaths.add(note.file.path);
                const missCount = (this.orphanMissCount.get(note.file.path) || 0) + 1;
                this.orphanMissCount.set(note.file.path, missCount);

                if (missCount < AutoCreateService.ORPHAN_GRACE_CYCLES) {
                    logger.warn(`[AutoCreateService] Orphan candidate (miss ${missCount}/${AutoCreateService.ORPHAN_GRACE_CYCLES}): ${note.file.path}`);
                } else {
                    logger.warn(`[AutoCreateService] Orphan confirmed (miss ${missCount}): ${note.file.path}`);
                    if (this.config.noLossSyncMode) {
                        if (await this.markOrphanCandidate(note, missCount)) {
                            quarantined++;
                        }
                    } else if (await this.deleteOrArchive(note.file)) {
                        deleted++;
                        this.recordOrphanDeletion(note.eventId);
                    }
                    this.orphanMissCount.delete(note.file.path);
                }
            }

            // Clean up stale entries from orphanMissCount (files that no longer exist in vault)
            for (const path of this.orphanMissCount.keys()) {
                if (!currentOrphanPaths.has(path) && !matchedFilePaths.has(path)) {
                    this.orphanMissCount.delete(path);
                }
            }

            if (created + updated + deleted + quarantined + restored > 0) {
                const summary = [
                    `${created} created`,
                    `${updated} updated`,
                    `${deleted} archived/deleted`,
                ];
                if (quarantined > 0) summary.push(`${quarantined} quarantined`);
                if (restored > 0) summary.push(`${restored} restored`);
                new Notice(`Calendar Sync: ${summary.join(", ")}`);
            } else {
                logger.log('[AutoCreateService] No changes.');
            }

        } catch (e) {
            logger.error('[AutoCreateService] Sync failed:', e);
        } finally {
            this.isSyncing = false;
        }
    }

    // ========================================================================
    // Fetching
    // ========================================================================

    private async fetchAllRemoteEvents(
        service: ExternalCalendarService,
        urls: string[],
        start: Date,
        end: Date
    ): Promise<{
        events: ExternalCalendarEvent[];
        successfulUrls: Set<string>;
        failedUrls: Set<string>;
    }> {
        const results: ExternalCalendarEvent[] = [];
        const successfulUrls = new Set<string>();
        const failedUrls = new Set<string>();
        for (const url of urls) {
            const normalizedUrl = normalizeCalendarUrl(url);
            if (!normalizedUrl) {
                failedUrls.add(url);
                continue;
            }
            try {
                const fetchResult = await service.fetchEventsWithStatus(normalizedUrl, start, end, true, true);
                if (fetchResult.ok) {
                    successfulUrls.add(normalizedUrl);
                    results.push(...fetchResult.events);
                } else {
                    failedUrls.add(normalizedUrl);
                    logger.warn(`[AutoCreateService] Fetch failed for ${normalizedUrl}`, fetchResult.error ?? fetchResult.statusCode ?? 'unknown error');
                }
            } catch (e) {
                failedUrls.add(normalizedUrl);
                logger.error(`Failed to fetch ${normalizedUrl}`, e);
            }
        }
        return { events: results, successfulUrls, failedUrls };
    }

    // ========================================================================
    // Vault Index
    // ========================================================================

    private async buildVaultIndex(): Promise<{
        byEventId: Map<string, VaultNote>;
        byUidStart: Map<string, VaultNote>;
        allNotes: VaultNote[];
    }> {
        const byEventId = new Map<string, VaultNote>();
        const byUidStart = new Map<string, VaultNote>();
        const allNotes: VaultNote[] = [];

        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            const isTrash = normalizePath(file.path).toLowerCase().startsWith(".trash");
            if (isTrash) continue;

            const normPath = normalizeComparablePath(file.path);
            const normBase = normalizeComparablePath(file.basename);

            const isGloballyIgnored = (this.config.globalIgnorePaths || []).some(
                p => matchesExclusionPattern(normPath, normBase, p)
            );
            if (isGloballyIgnored) continue;

            const fm = await this.getFrontmatterForFile(file);
            if (!fm) continue;

            const eventId = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.eventIdKey));
            const uidRaw = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.uidKey));
            const uid = uidRaw || (eventId ? (this.extractUid(eventId) || eventId) : "");
            if (!uid && !eventId) continue;

            // Store raw frontmatter values as strings for comparison — no Date re-parsing
            const storedStartRaw = this.findKeyInsensitive(fm, this.config.startProperty)
                ?? this.findKeyInsensitive(fm, "scheduled");
            const storedStart = storedStartRaw != null ? String(storedStartRaw).trim() : "";

            const storedEndRaw = this.findKeyInsensitive(fm, this.config.endProperty);
            const storedEnd = storedEndRaw != null
                ? (typeof storedEndRaw === 'number' ? storedEndRaw : String(storedEndRaw).trim())
                : "";

            const storedTitle = String(this.findKeyInsensitive(fm, this.config.titleKey) ?? "").trim();
            const storedLocation = String(this.findKeyInsensitive(fm, "location") ?? "").trim();
            const sourceUrl = this.normalizeSourceUrl(this.findKeyInsensitive(fm, this.config.sourceUrlKey));
            const orphanCandidateAt = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.orphanCandidateAtKey));

            // Parse start date deterministically for uid+start fallback matching only
            let startDate: Date | null = null;
            if (storedStart) {
                startDate = parseFrontmatterDate(storedStart);
            }

            const note: VaultNote = {
                file,
                eventId,
                uid,
                storedStart,
                storedEnd,
                storedTitle,
                storedLocation,
                startDate,
                sourceUrl,
                orphanCandidateAt,
                isArchived: this.isArchivedNote(file),
            };

            allNotes.push(note);

            // Primary index: eventId → note
            if (eventId) {
                byEventId.set(eventId, note);
            }

            // Secondary index: uid|startMs → note (for fallback matching)
            if (uid && startDate && Number.isFinite(startDate.getTime())) {
                // Round to nearest minute to absorb minor timestamp jitter
                const roundedMs = Math.round(startDate.getTime() / 60000) * 60000;
                const key = `${uid}|${roundedMs}`;
                if (!byUidStart.has(key)) {
                    byUidStart.set(key, note);
                }
            }
        }

        return { byEventId, byUidStart, allNotes };
    }

    // ========================================================================
    // Process a single event
    // ========================================================================

    private async processEvent(
        event: ExternalCalendarEvent,
        byEventId: Map<string, VaultNote>,
        byUidStart: Map<string, VaultNote>,
        calendarInfo: CalendarAutoCreateConfig | null,
        filterTerms: string[],
        forceRegenerate: boolean
    ): Promise<{ action: 'created' | 'updated' | 'deleted' | 'none', file?: TFile }> {
        const normalizedSourceUrl = this.normalizeSourceUrl(event.sourceUrl);

        // 1. Find match — primary by eventId, fallback by uid+start
        let match = byEventId.get(event.id) || null;
        let repairedEventId = false;

        if (!match) {
            const uidStartKey = this.buildUidStartKey(event);
            const fallback = byUidStart.get(uidStartKey);
            if (fallback && !fallback.isArchived) {
                // uid+start matched but eventId didn't — repair the identity binding
                // instead of skipping. This fixes stale IDs from timezone jitter or
                // ID format changes across parser updates.
                logger.log(`[AutoCreateService] Repairing eventId for "${event.title}": ${fallback.eventId} -> ${event.id} (matched via uid+start)`);
                match = fallback;
                repairedEventId = true;
            }
        }

        // 2. Existing note found — check for changes
        if (match) {
            if (match.isArchived) {
                return { action: 'none', file: match.file };
            }

            if (event.isCancelled) {
                logger.log(`[AutoCreateService] Event CANCELLED: ${event.title}`);
                const cancellationAction = await this.handleCancelledMatch(match.file);
                return { action: cancellationAction, file: match.file };
            }

            // Compare stored values against remote event — string equality, no Date parsing
            const expectedStart = formatDateTimeForFrontmatter(event.startDate);
            const expectedEnd = this.config.useEndDuration
                ? Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60000)
                : formatDateTimeForFrontmatter(event.endDate);

            const startChanged = match.storedStart !== expectedStart;
            const endChanged = match.storedEnd !== expectedEnd;
            const titleMissing = !match.storedTitle && !!event.title;
            const locationMissing = !match.storedLocation && !!event.location;
            const sourceChanged = !!normalizedSourceUrl && match.sourceUrl !== normalizedSourceUrl;

            // Fast path: nothing changed and no identity repair needed — skip entirely, no file I/O
            if (!startChanged && !endChanged && !titleMissing && !locationMissing && !sourceChanged && !repairedEventId && !forceRegenerate) {
                return { action: 'none', file: match.file };
            }

            // Something changed — update only the changed fields
            let didUpdate = false;

            await this.processFrontmatterSafely(match.file, "update-existing-event", (fm) => {
                if (repairedEventId) {
                    fm[this.config.eventIdKey] = event.id;
                    didUpdate = true;
                }

                if (titleMissing) {
                    fm[this.config.titleKey] = event.title;
                    didUpdate = true;
                }

                if (locationMissing) {
                    fm["location"] = event.location;
                    didUpdate = true;
                }

                if (sourceChanged && normalizedSourceUrl) {
                    fm[this.config.sourceUrlKey] = normalizedSourceUrl;
                    didUpdate = true;
                }

                if (startChanged) {
                    logger.log(`[AutoCreateService] Start changed: '${match!.storedStart}' -> '${expectedStart}'`);
                    fm[this.config.startProperty] = expectedStart;
                    didUpdate = true;
                }

                if (endChanged) {
                    logger.log(`[AutoCreateService] End/duration changed: '${match!.storedEnd}' -> '${expectedEnd}'`);
                    fm[this.config.endProperty] = expectedEnd;
                    didUpdate = true;
                }
            });

            if (didUpdate) {
                logger.log(`[AutoCreateService] Updated: ${match.file.path}`);
                // Update in-memory state so subsequent events in this cycle see current values
                match.storedStart = expectedStart;
                match.storedEnd = expectedEnd;
                if (titleMissing) match.storedTitle = event.title;
                if (locationMissing) match.storedLocation = event.location || "";
                if (sourceChanged && normalizedSourceUrl) match.sourceUrl = normalizedSourceUrl;
                if (repairedEventId) {
                    match.eventId = event.id;
                    byEventId.set(event.id, match);
                }
                this.orphanDeletionTombstones.delete(event.id);
            }
            return { action: didUpdate ? 'updated' : 'none', file: match.file };
        }

        // 3. No match — create new note (if eligible)
        if (event.isCancelled) {
            return { action: 'none' };
        }
        if (filterTerms.some(t => event.title.toLowerCase().includes(t))) {
            return { action: 'none' };
        }
        if (calendarInfo?.autoCreateEnabled === false) {
            return { action: 'none' };
        }
        if (!forceRegenerate && this.hasRecentOrphanDeletion(event.id)) {
            logger.warn(`[AutoCreateService] Skipping recreation shortly after orphan deletion: ${event.id}`);
            return { action: 'none' };
        }

        // Check if there is an archived version of THIS EXACT INSTANCE (so we don't resurrect it).
        // Strictly match by eventId — using uid would falsely block the entire recurring series
        // if even a single past instance was archived.
        const archivedMatch = byEventId.get(event.id);
        if (archivedMatch?.isArchived) {
            logger.log(`[AutoCreateService] Skipping creation (archived version exists): ${archivedMatch.file.path}`);
            return { action: 'none' };
        }

        logger.log(`[AutoCreateService] Creating new note for: ${event.title}`);

        const resolvedFolder = calendarInfo?.folder || calendarInfo?.typeFolder || "";
        const resolvedTemplate = calendarInfo?.template || null;

        const file = await createMeetingNoteFromExternalEvent(
            this.app,
            event,
            resolvedTemplate,
            resolvedFolder,
            this.config.startProperty,
            this.config.endProperty,
            this.config.useEndDuration,
            calendarInfo?.tag || null,
            undefined,
            undefined,
            undefined,
            {
                eventIdKey: this.config.eventIdKey,
                uidKey: this.config.uidKey,
                sourceUrlKey: this.config.sourceUrlKey,
                titleKey: this.config.titleKey,
                statusKey: this.config.statusKey,
            }
        );

        return file ? { action: 'created', file } : { action: 'none' };
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private async handleCancelledMatch(file: TFile): Promise<'deleted' | 'updated' | 'none'> {
        if (!this.config.noLossSyncMode) {
            return (await this.deleteOrArchive(file)) ? 'deleted' : 'none';
        }

        // No-Loss mode: never hard-delete. If delete/archive is requested, archive safely.
        if (this.config.syncOnEventDelete === 'archive' || this.config.syncOnEventDelete === 'delete') {
            const archived = await this.archiveFile(file);
            if (archived) return 'deleted';

            // If archival destination is unavailable, fall back to status mark instead of loss.
            if (this.config.syncOnEventDelete === 'delete') {
                logger.warn(`[AutoCreateService] No-Loss mode prevented hard delete for cancelled event: ${file.path}`);
            }
        }

        return (await this.markCancelledWithoutDelete(file)) ? 'updated' : 'none';
    }

    private async markCancelledWithoutDelete(file: TFile): Promise<boolean> {
        const cancelledStatus = this.normalizeIdentityValue(this.config.canceledStatusValue) || "cancelled";
        const cancelledAt = new Date().toISOString();
        let didUpdate = false;

        await this.processFrontmatterSafely(file, "mark-cancelled", (fm) => {
            const currentStatus = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.statusKey));
            const previousStatus = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.previousStatusKey));
            const existingCancelledAt = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.cancelledAtKey));

            if (currentStatus && currentStatus.toLowerCase() !== cancelledStatus.toLowerCase() && !previousStatus) {
                fm[this.config.previousStatusKey] = currentStatus;
                didUpdate = true;
            }
            if (currentStatus !== cancelledStatus) {
                fm[this.config.statusKey] = cancelledStatus;
                didUpdate = true;
            }
            if (!existingCancelledAt) {
                fm[this.config.cancelledAtKey] = cancelledAt;
                didUpdate = true;
            }

            didUpdate = this.deleteFrontmatterKeyIfPresent(fm, this.config.orphanCandidateAtKey) || didUpdate;
            didUpdate = this.deleteFrontmatterKeyIfPresent(fm, this.config.orphanMissCountKey) || didUpdate;
            didUpdate = this.deleteFrontmatterKeyIfPresent(fm, this.config.orphanReasonKey) || didUpdate;
        });

        return didUpdate;
    }

    private async markOrphanCandidate(note: VaultNote, missCount: number): Promise<boolean> {
        const now = new Date().toISOString();
        let didUpdate = false;

        await this.processFrontmatterSafely(note.file, "mark-orphan-candidate", (fm) => {
            const currentAt = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.orphanCandidateAtKey));
            if (!currentAt) {
                fm[this.config.orphanCandidateAtKey] = now;
                didUpdate = true;
            }

            const currentMiss = this.findKeyInsensitive(fm, this.config.orphanMissCountKey);
            if (Number(currentMiss) !== missCount) {
                fm[this.config.orphanMissCountKey] = missCount;
                didUpdate = true;
            }

            const reason = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.orphanReasonKey));
            if (reason !== "missing-from-source") {
                fm[this.config.orphanReasonKey] = "missing-from-source";
                didUpdate = true;
            }
        });

        if (didUpdate) {
            logger.warn(`[AutoCreateService] Quarantined orphan candidate: ${note.file.path}`);
        }

        return didUpdate;
    }

    private async clearOrphanCandidate(file: TFile): Promise<boolean> {
        let didUpdate = false;
        await this.processFrontmatterSafely(file, "clear-orphan-candidate", (fm) => {
            didUpdate = this.deleteFrontmatterKeyIfPresent(fm, this.config.orphanCandidateAtKey) || didUpdate;
            didUpdate = this.deleteFrontmatterKeyIfPresent(fm, this.config.orphanMissCountKey) || didUpdate;
            didUpdate = this.deleteFrontmatterKeyIfPresent(fm, this.config.orphanReasonKey) || didUpdate;
        });
        return didUpdate;
    }

    public async getOrphanCandidateFiles(): Promise<TFile[]> {
        const candidates: TFile[] = [];
        for (const file of this.app.vault.getMarkdownFiles()) {
            const fm = await this.getFrontmatterForFile(file);
            if (!fm) continue;
            const candidateAt = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.orphanCandidateAtKey));
            if (candidateAt) candidates.push(file);
        }
        candidates.sort((a, b) => a.path.localeCompare(b.path));
        return candidates;
    }

    private async deleteOrArchive(file: TFile): Promise<boolean> {
        try {
            if (this.config.syncOnEventDelete === 'delete') {
                await this.app.vault.delete(file);
                return true;
            } else if (this.config.syncOnEventDelete === 'archive') {
                return this.archiveFile(file);
            }
        } catch (e) {
            logger.error(`[AutoCreateService] Failed to delete/archive ${file.path}:`, e);
        }
        return false;
    }

    private async archiveFile(file: TFile): Promise<boolean> {
        const folder = this.config.archiveFolder;
        if (!folder || this.isArchivedNote(file)) return false;

        await this.ensureFolder(folder);
        let newPath = normalizePath(`${folder}/${file.name}`);
        let counter = 1;

        while (this.app.vault.getAbstractFileByPath(newPath)) {
            newPath = normalizePath(`${folder}/${file.basename} (${counter}).${file.extension}`);
            counter++;
        }

        await this.app.vault.rename(file, newPath);
        return true;
    }

    private async ensureFolder(folderPath: string) {
        let current = "";
        for (const segment of normalizePath(folderPath).split('/').filter(Boolean)) {
            current = current ? `${current}/${segment}` : segment;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                try {
                    await this.app.vault.createFolder(current);
                } catch (e: any) {
                    if (!e.message?.includes('already exists')) {
                        throw e;
                    }
                }
            }
        }
    }

    private async getFrontmatterForFile(file: TFile): Promise<Record<string, any> | null> {
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.frontmatter) return cache.frontmatter;
        try {
            const content = await this.app.vault.cachedRead(file);
            const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
            if (match) {
                const parsed = parseYaml(match[1]);
                if (typeof parsed === 'object') return parsed;
            }
        } catch { }
        return null;
    }

    private async processFrontmatterSafely(
        file: TFile,
        reason: string,
        mutate: (fm: Record<string, any>) => void,
    ): Promise<boolean> {
        const safety = await this.canMutateFrontmatterSafely(file);
        if (!safety.safe) {
            if (!this.malformedFrontmatterWarnedPaths.has(file.path)) {
                this.malformedFrontmatterWarnedPaths.add(file.path);
                new Notice(`Skipped frontmatter update for "${file.basename}" (${safety.reason}).`);
            }
            logger.warn(`[AutoCreateService] Skipping frontmatter mutation (${reason})`, {
                file: file.path,
                reason: safety.reason,
            });
            return false;
        }

        try {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                mutate((fm ?? {}) as Record<string, any>);
            });
            return true;
        } catch (error) {
            logger.warn(`[AutoCreateService] Frontmatter mutation failed (${reason})`, {
                file: file.path,
                error,
            });
            return false;
        }
    }

    private async canMutateFrontmatterSafely(
        file: TFile,
    ): Promise<{ safe: boolean; reason?: string }> {
        let content = "";
        try {
            content = await this.app.vault.cachedRead(file);
        } catch (error) {
            logger.warn("[AutoCreateService] Failed reading file for frontmatter safety check", {
                file: file.path,
                error,
            });
            return { safe: false, reason: "file read failed" };
        }

        const normalized = content.replace(/\r\n/g, "\n");
        const bomOffset = normalized.startsWith("\uFEFF") ? 1 : 0;
        if (!normalized.startsWith("---\n", bomOffset)) {
            return { safe: true };
        }

        const firstClose = normalized.indexOf("\n---\n", bomOffset + 4);
        if (firstClose === -1) {
            return { safe: false, reason: "missing frontmatter closing delimiter" };
        }

        const afterFirst = normalized.slice(firstClose + "\n---\n".length);
        const trimmedAfterFirst = afterFirst.replace(/^\s*/, "");
        if (!trimmedAfterFirst.startsWith("---\n")) {
            return { safe: true };
        }

        const secondClose = trimmedAfterFirst.indexOf("\n---\n", 4);
        if (secondClose === -1) {
            return { safe: true };
        }

        const secondBody = trimmedAfterFirst.slice(4, secondClose);
        const hasYamlLikeEntry = secondBody
            .split("\n")
            .some((line) => /^[A-Za-z0-9_"'.-]+\s*:/.test(line.trim()));

        if (!hasYamlLikeEntry) {
            return { safe: true };
        }

        return { safe: false, reason: "duplicate leading frontmatter blocks detected" };
    }

    private findKeyInsensitive(obj: Record<string, any>, key: string): any {
        const normalized = String(key || "").trim().toLowerCase();
        const found = Object.keys(obj).find(k => k.trim().toLowerCase() === normalized);
        return found ? obj[found] : undefined;
    }

    private deleteFrontmatterKeyIfPresent(obj: Record<string, any>, key: string): boolean {
        const normalized = String(key || "").trim().toLowerCase();
        const found = Object.keys(obj).find(k => k.trim().toLowerCase() === normalized);
        if (!found) return false;
        delete obj[found];
        return true;
    }

    private isArchivedNote(file: TFile): boolean {
        const archive = this.config.archiveFolder;
        if (!archive) return false;
        const norm = normalizePath(archive);
        return file.path === norm || file.path.startsWith(`${norm}/`);
    }

    /**
     * Extract the base UID from a composite event ID like "uid-20240226T093000".
     * Looks for the LAST segment that matches a date/timestamp pattern and strips it.
     * This is more robust than the old regex which would truncate hyphenated UIDs.
     */
    private extractUid(id: string): string | null {
        // Match known suffix patterns appended by the iCal parser:
        // - Stable string: "20240226T093000"
        // - Legacy millisecond: pure digits (13+ chars)
        // - Duplicate marker: "dup-20240226T093000" or "dup-1234567890000"
        const suffixPattern = /[-_](?:dup[-_])?(?:\d{4}\d{2}\d{2}T\d{2}\d{2}\d{2}|\d{13,})$/;
        const match = id.match(suffixPattern);
        if (match && match.index && match.index > 0) {
            return id.substring(0, match.index);
        }
        return null;
    }

    private getRecurrenceDateFromId(id: string): Date | null {
        // Match the stable string format "YYYYMMDDTHHmmss" at the end of the ID
        const stableMatch = id.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
        if (stableMatch) {
            return new Date(+stableMatch[1], +stableMatch[2] - 1, +stableMatch[3], +stableMatch[4], +stableMatch[5], +stableMatch[6]);
        }
        // Legacy: pure millisecond timestamp
        const msMatch = id.match(/[-_](\d{13,})$/);
        if (msMatch) {
            return new Date(parseInt(msMatch[1], 10));
        }
        return null;
    }

    private buildUidStartKey(event: ExternalCalendarEvent): string {
        const uid = (event.uid || this.extractUid(event.id) || event.id || "").trim();
        const ts = Number.isFinite(event.startDate?.getTime?.())
            ? Math.round(event.startDate.getTime() / 60000) * 60000
            : 0;
        return `${uid}|${ts}`;
    }

    private normalizeIdentityValue(value: any): string | null {
        if (typeof value !== "string") return null;
        const normalized = value.trim();
        if (!normalized) return null;
        const lower = normalized.toLowerCase();
        if (lower === "null" || lower === "undefined" || lower === "none" || lower === "n/a") {
            return null;
        }
        return normalized;
    }

    private normalizeSourceUrl(value: unknown): string | null {
        if (typeof value !== "string") return null;
        const normalized = normalizeCalendarUrl(value);
        return normalized || null;
    }

    private pruneOrphanDeletionTombstones(now: number = Date.now()): void {
        for (const [eventId, ts] of this.orphanDeletionTombstones.entries()) {
            if (now - ts > AutoCreateService.ORPHAN_TOMBSTONE_TTL_MS) {
                this.orphanDeletionTombstones.delete(eventId);
            }
        }
    }

    private recordOrphanDeletion(eventId: string | null): void {
        if (!eventId) return;
        this.orphanDeletionTombstones.set(eventId, Date.now());
    }

    private hasRecentOrphanDeletion(eventId: string | null): boolean {
        if (!eventId) return false;
        const deletedAt = this.orphanDeletionTombstones.get(eventId);
        if (!deletedAt) return false;
        if (Date.now() - deletedAt > AutoCreateService.ORPHAN_TOMBSTONE_TTL_MS) {
            this.orphanDeletionTombstones.delete(eventId);
            return false;
        }
        return true;
    }

    private canEvaluateOrphanForNote(
        note: VaultNote,
        configuredUrlSet: Set<string>,
        successfulUrls: Set<string>,
        failedUrls: Set<string>
    ): boolean {
        // Without source mapping, only evaluate when every configured calendar fetch succeeded.
        if (!note.sourceUrl) {
            if (configuredUrlSet.size === 0) return false;
            return successfulUrls.size === configuredUrlSet.size && failedUrls.size === 0;
        }

        // Notes from calendars no longer configured should not be auto-deleted by orphan logic.
        if (!configuredUrlSet.has(note.sourceUrl)) {
            return false;
        }

        // Safe to evaluate only when this note's source calendar succeeded in this cycle.
        if (successfulUrls.has(note.sourceUrl)) {
            return true;
        }

        // Source failed or is otherwise unknown this cycle -> defer deletion.
        if (failedUrls.has(note.sourceUrl)) {
            return false;
        }
        return false;
    }
}
