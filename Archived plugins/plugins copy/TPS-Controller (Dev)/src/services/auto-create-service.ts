import { App, TFile, normalizePath, Notice, parseYaml } from "obsidian";
import * as logger from "../logger";
import { ExternalCalendarService } from "../external-calendar-service";
import { ExternalCalendarEvent } from "../types";
import { createMeetingNoteFromExternalEvent } from "../external-event-modal";
import { formatDateTimeForFrontmatter } from "../utils";
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
    syncOnEventDelete: 'delete' | 'archive' | 'nothing';
    archiveFolder: string;
    canceledStatusValue: string | null;
    allowAutoCreate?: boolean;
    eventIdKey: string;
    uidKey: string;
    titleKey: string;
    statusKey: string;
    previousStatusKey: string;
}

interface VaultNoteIndex {
    file: TFile;
    eventId: string;     // Refactored from googleEventId
    uid: string;
    startDate: Date | null;
}

interface UnlinkedNoteIndex {
    file: TFile;
    titleKey: string;
    startDate: Date;
    dateKey: string;
}

export class AutoCreateService {
    app: App;
    config: AutoCreateServiceConfig;
    private isSyncing = false;
    private lastVaultChangeTimestamp: number;
    private hasCompletedInitialSettle = false;
    private readonly VAULT_IDLE_THRESHOLD_MS = 5000;
    private readonly VAULT_START_DELAY_MS = 1000;
    private readonly VAULT_INITIAL_SYNC_DELAY_MS = 15000;
    private readonly VAULT_MAX_WAIT_MS = 60000;

    constructor(app: App) {
        this.app = app;
        this.config = {
            startProperty: "scheduled",
            endProperty: "timeEstimate",
            useEndDuration: true,
            syncOnEventDelete: 'nothing',
            archiveFolder: "",
            canceledStatusValue: null,
            allowAutoCreate: false,
            eventIdKey: "externalEventId",
            uidKey: "tpsCalendarUid",
            titleKey: "title",
            statusKey: "status",
            previousStatusKey: "tpsCalendarPrevStatus",
        };
        this.lastVaultChangeTimestamp = Date.now() - this.VAULT_IDLE_THRESHOLD_MS * 2;
        const updateTimestamp = () => {
            this.lastVaultChangeTimestamp = Date.now();
        };
        this.app.vault.on("modify", updateTimestamp);
        this.app.vault.on("create", updateTimestamp);
        this.app.vault.on("delete", updateTimestamp);
        this.app.vault.on("rename", updateTimestamp);
    }

    updateConfig(config: Partial<AutoCreateServiceConfig>) {
        this.config = { ...this.config, ...config };
    }

    /**
     * Main Sync Entry Point
     */
    async checkAndCreateMeetingNotes(
        externalCalendarService: ExternalCalendarService,
        urls: string[],
        externalCalendarFilter: string,
        calendarConfigs: Record<string, CalendarAutoCreateConfig>,
        forceRegenerate = false
    ) {

        if (this.config.allowAutoCreate === false) {
            return;
        }
        if (this.isSyncing) {
            return;
        }

        const hasAutoCreate = Object.values(calendarConfigs).some(
            (config) => (config?.autoCreateEnabled ?? true) !== false,
        );
        if (!hasAutoCreate) {
            return;
        }

        await this.waitForVaultToSettle();

        this.isSyncing = true;
        logger.log('[AutoCreateService] Starting robust sync...');

        try {
            // 1. Define Sync Window
            const start = new Date();
            start.setDate(start.getDate() - 7);
            const end = new Date();
            end.setDate(end.getDate() + 14);

            // 2. Fetch All Remote Events
            const filterTerms = externalCalendarFilter
                .split(',')
                .map((term) => term.trim().toLowerCase())
                .filter(Boolean);
            const remoteEvents = await this.fetchAllRemoteEvents(externalCalendarService, urls, start, end);
            const remoteIdsByUid = new Map<string, Set<string>>();
            for (const event of remoteEvents) {
                const ids = remoteIdsByUid.get(event.uid) ?? new Set<string>();
                ids.add(event.id);
                remoteIdsByUid.set(event.uid, ids);
            }


            // 3. Index Local Notes
            logger.log('[AutoCreateService] Building vault index...');
            let vaultIndex = await this.buildVaultIndex();
            logger.log(`[AutoCreateService] Found ${vaultIndex.length} notes with ${this.config.eventIdKey}`);
            const duplicateCleanupCount = await this.cleanupDuplicateEventNotes(vaultIndex, remoteEvents, calendarConfigs);
            if (duplicateCleanupCount > 0) {
                vaultIndex = await this.buildVaultIndex();
                logger.warn(`[AutoCreateService] Removed ${duplicateCleanupCount} duplicate event notes; rebuilt vault index (${vaultIndex.length} notes)`);
            }
            const unlinkedIndex = await this.buildUnlinkedIndex(start, end);

            // 4. Reconcile Events with Notes
            logger.log('[AutoCreateService] Starting reconciliation...');
            logger.log(`[AutoCreateService] Processing ${remoteEvents.length} remote events`);

            let created = 0;
            let updated = 0;
            let deleted = 0;

            const matchedFiles = new Set<string>();
            const processedEventIds = new Set<string>();

            for (const event of remoteEvents) {
                // Detect duplicate events in feed
                if (processedEventIds.has(event.id)) {
                    logger.warn(`[AutoCreateService] ⚠️  Duplicate event in feed: ${event.id} ("${event.title}")`);
                    continue;
                }
                processedEventIds.add(event.id);

                try {
                    const result = await this.processEvent(
                        event,
                        vaultIndex,
                        unlinkedIndex,
                        calendarConfigs[event.sourceUrl || ""],
                        filterTerms,
                        forceRegenerate
                    );

                    if (result.action === 'created') {
                        created++;
                        logger.log(`[AutoCreateService] ✓ Created (${created}): ${result.file?.path}`);
                    }
                    if (result.action === 'updated') {
                        updated++;
                        logger.log(`[AutoCreateService] ✓ Updated (${updated}): ${result.file?.path}`);
                    }
                    if (result.action === 'deleted') {
                        deleted++;
                        logger.log(`[AutoCreateService] ✓ Deleted (${deleted}): ${result.file?.path}`);
                    }

                    if (result.file) {
                        matchedFiles.add(result.file.path);
                    }
                } catch (error) {
                    logger.error(`[AutoCreateService] ✗ Error processing event "${event.title}" (${event.id}):`, error);
                }
            }

            logger.log(`[AutoCreateService] Reconciliation complete: ${created} created, ${updated} updated, ${deleted} deleted`);

            // Safety check: Don't run orphan cleanup if we got no remote events
            if (urls.length > 0 && remoteEvents.length === 0) {
                logger.warn('[AutoCreateService] ⚠️  No remote events returned; skipping orphan cleanup to prevent mass deletion');
                logger.warn('[AutoCreateService] This could indicate a network issue or calendar feed problem');
                if (created + updated + deleted > 0) {
                    new Notice(`Calendar Sync: ${created} created, ${updated} updated, ${deleted} deleted`);
                } else {
                    logger.log('[AutoCreateService] No changes.');
                }
                return;
            }


            // 5. Handle Orphans (Events deleted from calendar but note exists)
            logger.log(`[AutoCreateService] Checking for orphaned notes...`);
            logger.log(`[AutoCreateService] Matched ${matchedFiles.size} notes to remote events`);
            logger.log(`[AutoCreateService] Total vault notes with ${this.config.eventIdKey}: ${vaultIndex.length}`);

            let orphansChecked = 0;
            let orphansDeleted = 0;
            let orphansKept = 0;

            // Grace period: Don't archive notes created/modified in the last 24 hours
            const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;
            const now = Date.now();

            for (const note of vaultIndex) {
                if (matchedFiles.has(note.file.path)) continue;

                orphansChecked++;
                if (this.isArchivedNote(note.file)) {
                    logger.log(`[AutoCreateService] ⏭️  Skipping already archived note: ${note.file.path}`);
                    orphansKept++;
                    continue;
                }

                // Check if note is within grace period
                const fileAge = now - note.file.stat.mtime;
                if (fileAge < GRACE_PERIOD_MS) {
                    logger.log(`[AutoCreateService] ⏭️  Skipping note within grace period (${Math.round(fileAge / 1000 / 60)} minutes old): ${note.file.path}`);
                    orphansKept++;
                    continue;
                }

                const noteDate = note.startDate ?? this.getRecurrenceDateFromId(note.eventId);
                const hasRemoteUid = remoteIdsByUid.has(note.uid);
                const uidHasNoteId = remoteIdsByUid.get(note.uid)?.has(note.eventId) ?? false;

                // Log unmatched note details for debugging
                logger.log(`[AutoCreateService] 🔍 Unmatched note: ${note.file.path}`);
                logger.log(`[AutoCreateService]   UID: ${note.uid} | ID: ${note.eventId}`);
                logger.log(`[AutoCreateService]   Date: ${noteDate?.toISOString() || 'unknown'}`);
                logger.log(`[AutoCreateService]   Has Remote UID: ${hasRemoteUid} | UID Has Note ID: ${uidHasNoteId}`);

                // Only process notes within sync window
                if (noteDate && noteDate >= start && noteDate <= end) {
                    // Orphan Detection Logic - BE CONSERVATIVE
                    if (!hasRemoteUid) {
                        // UID completely missing from remote - event series was deleted
                        // BUT: Only archive if we're confident this isn't a matching failure

                        // Check if there are ANY remote events with similar titles/dates
                        const similarEvents = remoteEvents.filter(e => {
                            if (!e.startDate || !noteDate) return false;
                            const timeDiff = Math.abs(e.startDate.getTime() - noteDate.getTime());
                            // Within 2 hours
                            return timeDiff < 120 * 60 * 1000;
                        });

                        if (similarEvents.length > 0) {
                            logger.warn(`[AutoCreateService] ⚠️  UID missing but ${similarEvents.length} events with similar dates found - keeping note to avoid false positive`);
                            logger.warn(`[AutoCreateService]   This might be a UID extraction or matching issue`);
                            logger.warn(`[AutoCreateService]   Note: ${note.file.path}`);
                            orphansKept++;
                            continue;
                        }

                        logger.warn(`[AutoCreateService] 🗑️  Orphan detected (UID missing, no similar events): ${note.file.path}`);
                        logger.warn(`[AutoCreateService]   UID: ${note.uid} | ID: ${note.eventId}`);
                        logger.warn(`[AutoCreateService]   Date: ${noteDate.toISOString()}`);

                        const wasDeleted = await this.deleteOrArchive(note.file);
                        if (wasDeleted) {
                            deleted++;
                            orphansDeleted++;
                        }
                    } else if (hasRemoteUid && !uidHasNoteId) {
                        // UID exists but specific instance ID is missing
                        // This could be:
                        // 1. A rescheduled recurring instance (safe to keep - fuzzy match will update it)
                        // 2. A deleted single instance from a series (should delete)
                        // 3. A matching failure due to ID format differences

                        const remoteEventsWithUid = remoteEvents.filter(e => e.uid === note.uid);
                        const isRecurringNote = note.eventId.includes('-') && note.eventId !== note.uid;

                        if (isRecurringNote && remoteEventsWithUid.length > 0) {
                            // Recurring instance - keep it, fuzzy matching will handle updates
                            logger.log(`[AutoCreateService] ✓ Keeping orphan (recurring instance, UID exists): ${note.file.path}`);
                            logger.log(`[AutoCreateService]   UID: ${note.uid} | ID: ${note.eventId}`);
                            logger.log(`[AutoCreateService]   Remote has ${remoteEventsWithUid.length} events with this UID`);
                            orphansKept++;
                        } else {
                            // Keep it to be safe - this could be a matching issue
                            logger.log(`[AutoCreateService] ✓ Keeping orphan (ambiguous case - possible matching issue): ${note.file.path}`);
                            logger.log(`[AutoCreateService]   UID: ${note.uid} | ID: ${note.eventId}`);
                            logger.log(`[AutoCreateService]   Remote events with UID: ${remoteEventsWithUid.length}`);
                            orphansKept++;
                        }
                    }
                } else {
                    // Note is outside sync window - don't touch it
                    logger.log(`[AutoCreateService] ⏭️  Skipping note outside sync window: ${note.file.path} (date: ${noteDate?.toISOString() || 'unknown'})`);
                }
            }

            logger.log(`[AutoCreateService] Orphan check complete: ${orphansChecked} checked, ${orphansDeleted} deleted, ${orphansKept} kept`);


            if (created + updated + deleted > 0) {
                new Notice(`Calendar Sync: ${created} created, ${updated} updated, ${deleted} deleted`);
            } else {
                logger.log('[AutoCreateService] No changes.');
            }

        } catch (e) {
            logger.error('[AutoCreateService] Sync failed:', e);
        } finally {
            this.isSyncing = false;
        }
    }

    /**
     * Manual Duplicate Cleanup.
     * Builds index and runs cleanup logic without fetching remote events or creating new notes.
     */
    async runDuplicateCleanupOnly(calendarConfigs: Record<string, CalendarAutoCreateConfig>): Promise<number> {
        if (this.isSyncing) {
            new Notice("Sync in progress, please wait.");
            return 0;
        }

        this.isSyncing = true;
        logger.log('[AutoCreateService] Starting manual duplicate cleanup...');

        try {
            // 1. Build Index
            let vaultIndex = await this.buildVaultIndex();
            logger.log(`[AutoCreateService] Found ${vaultIndex.length} notes with ${this.config.eventIdKey}`);

            // 2. Fetch remote events just to get canonical IDs/UIDs for better decision making?
            // Actually, cleanupDuplicateEventNotes relies on remoteEvents for canonical decision.
            // If we pass empty remoteEvents, it falls back to timestamps/paths, which is fine for duplicates of same event.
            // But if we want to know growing/shrinking preferred folders, we need configs.

            // We'll pass empty remoteEvents array, so it uses local heuristics (file path, modification time).
            const cleaned = await this.cleanupDuplicateEventNotes(vaultIndex, [], calendarConfigs);

            logger.log(`[AutoCreateService] Manual cleanup finished. Removed ${cleaned} duplicates.`);
            return cleaned;

        } catch (e) {
            logger.error('[AutoCreateService] Cleanup failed:', e);
            new Notice("Cleanup failed. Check logs.");
            return 0;
        } finally {
            this.isSyncing = false;
        }
    }

    private async waitForVaultToSettle(): Promise<void> {
        const startTime = Date.now();
        const isInitialSettle = !this.hasCompletedInitialSettle;
        const requiredDelayMs = isInitialSettle
            ? this.VAULT_INITIAL_SYNC_DELAY_MS
            : this.VAULT_START_DELAY_MS;
        let hadRecentChanges = false;

        while (true) {
            const now = Date.now();
            const elapsed = now - startTime;
            const sinceLastChange = now - this.lastVaultChangeTimestamp;
            const changeWindowStart = startTime - this.VAULT_IDLE_THRESHOLD_MS;
            const hadRecentActivity = this.lastVaultChangeTimestamp >= changeWindowStart;

            if (hadRecentActivity) {
                hadRecentChanges = true;
            }

            const vaultIdle = sinceLastChange >= this.VAULT_IDLE_THRESHOLD_MS;
            const minDelayElapsed = elapsed >= requiredDelayMs;
            if (vaultIdle && minDelayElapsed) {
                break;
            }

            if (elapsed >= this.VAULT_MAX_WAIT_MS) {
                logger.warn(`[AutoCreateService] Vault settle wait exceeded ${this.VAULT_MAX_WAIT_MS}ms; continuing sync`);
                break;
            }

            await this.delay(250);
        }

        this.hasCompletedInitialSettle = true;

        if (hadRecentChanges || isInitialSettle) {
            logger.log(`[AutoCreateService] Vault activity settled after ${Date.now() - startTime}ms`);
        }
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async fetchAllRemoteEvents(
        service: ExternalCalendarService,
        urls: string[],
        start: Date,
        end: Date
    ): Promise<ExternalCalendarEvent[]> {
        const results: ExternalCalendarEvent[] = [];

        for (const url of urls) {
            try {
                // Fetch ALL events, including cancelled, FORCE REFRESH
                const events = await service.fetchEvents(url, start, end, true, true);

                results.push(...events);
            } catch (e) {
                logger.error(`Failed to fetch ${url}`, e);
            }
        }
        return results;
    }

    private async buildVaultIndex(): Promise<VaultNoteIndex[]> {
        const index: VaultNoteIndex[] = [];
        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            // Skip archived/trash notes - they should not be matched or updated
            if (this.shouldSkipSyncFile(file)) {
                continue;
            }

            const fm = await this.getFrontmatterForFile(file);
            if (!fm) continue;

            const googleEventId = this.getFrontmatterStringCaseInsensitive(fm, this.config.eventIdKey);
            if (!googleEventId) continue;

            // Extract UID
            // Format 1 (Standard): UID
            // Format 2 (Recurring): UID-Timestamp
            let uid = this.getFrontmatterStringCaseInsensitive(fm, this.config.uidKey) || googleEventId;
            if (!this.getFrontmatterStringCaseInsensitive(fm, this.config.uidKey)) {
                const extracted = this.extractUidFromGoogleEventId(googleEventId);
                if (extracted) {
                    uid = extracted;
                }
            }

            // Start Date
            let startDate: Date | null = null;
            const startVal =
                this.getFrontmatterValueCaseInsensitive(fm, this.config.startProperty)
                ?? this.getFrontmatterValueCaseInsensitive(fm, "scheduled");
            if (startVal) {
                const parsed = new Date(startVal);
                startDate = Number.isFinite(parsed.getTime()) ? parsed : null;
            }
            if (!startDate) {
                startDate = this.getRecurrenceDateFromId(googleEventId);
            }

            index.push({
                file,
                eventId: googleEventId,
                uid,
                startDate
            });
        }
        return index;
    }

    private async buildUnlinkedIndex(start: Date, end: Date): Promise<Map<string, UnlinkedNoteIndex[]>> {
        const index = new Map<string, UnlinkedNoteIndex[]>();
        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            // Skip archived/trash notes - they should not be matched
            if (this.shouldSkipSyncFile(file)) {
                continue;
            }

            const fm = await this.getFrontmatterForFile(file);
            if (!fm) continue;

            const googleEventId = this.getFrontmatterStringCaseInsensitive(fm, this.config.eventIdKey) || "";
            const tpsCalendarUid = this.getFrontmatterStringCaseInsensitive(fm, this.config.uidKey) || "";
            if (googleEventId || tpsCalendarUid) continue;

            const startVal =
                this.getFrontmatterValueCaseInsensitive(fm, this.config.startProperty)
                ?? this.getFrontmatterValueCaseInsensitive(fm, "scheduled");
            if (!startVal) continue;
            const parsed = new Date(startVal);
            if (!Number.isFinite(parsed.getTime())) continue;

            if (parsed < start || parsed > end) continue;

            const dateKey = this.formatDateKey(parsed);
            const configuredTitle = this.getFrontmatterValueCaseInsensitive(fm, this.config.titleKey);
            const rawTitle = typeof configuredTitle === "string" && configuredTitle.trim()
                ? configuredTitle
                : file.basename;
            const titleKey = this.normalizeTitleKey(this.stripDateSuffix(rawTitle));
            if (!titleKey) continue;

            const key = `${titleKey}::${dateKey}`;
            const existing = index.get(key) ?? [];
            existing.push({ file, titleKey, startDate: parsed, dateKey });
            index.set(key, existing);
        }

        return index;
    }

    private shouldSkipSyncFile(file: TFile): boolean {
        if (this.isArchivedNote(file)) return true;
        const normalizedPath = normalizePath(file.path).toLowerCase();
        return normalizedPath === ".trash" || normalizedPath.startsWith(".trash/");
    }

    private async getFrontmatterForFile(file: TFile): Promise<Record<string, any> | null> {
        const cache = this.app.metadataCache.getFileCache(file);
        const cachedFrontmatter = cache?.frontmatter;
        if (cachedFrontmatter && typeof cachedFrontmatter === "object") {
            return cachedFrontmatter as Record<string, any>;
        }

        try {
            const content = await this.app.vault.cachedRead(file);
            const yaml = this.extractFrontmatterYaml(content);
            if (!yaml) return null;
            const parsed = parseYaml(yaml);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, any>;
            }
        } catch (error) {
            logger.warn(`[AutoCreateService] Unable to parse frontmatter for ${file.path}`, error);
        }

        return null;
    }

    private extractFrontmatterYaml(content: string): string | null {
        const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        return match ? match[1] : null;
    }

    private normalizeTitleKey(title: string): string {
        return title.replace(/\s+/g, " ").trim().toLowerCase();
    }

    private stripDateSuffix(title: string): string {
        return title.replace(/\s+\d{4}-\d{2}-\d{2}$/, "").trim();
    }

    private formatDateKey(date: Date): string {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, "0");
        const d = String(date.getDate()).padStart(2, "0");
        return `${y}-${m}-${d}`;
    }

    private resolveCalendarFolderPath(calendarInfo: CalendarAutoCreateConfig | null | undefined): string {
        const resolvedInfo: CalendarAutoCreateConfig = calendarInfo ?? {};
        const preferredTypeFolder =
            typeof resolvedInfo.typeFolder === "string" ? resolvedInfo.typeFolder.trim() : "";
        const preferredFolder =
            typeof resolvedInfo.folder === "string" ? resolvedInfo.folder.trim() : "";
        if (preferredTypeFolder) return preferredTypeFolder;
        if (preferredFolder) return preferredFolder;
        return "";
    }

    private pathInFolder(filePath: string, folderPath: string): boolean {
        if (!folderPath) return false;
        const normalizedFolder = normalizePath(folderPath);
        const normalizedFile = normalizePath(filePath);
        return normalizedFile === normalizedFolder || normalizedFile.startsWith(`${normalizedFolder}/`);
    }

    private getExpectedBasenamePrefix(event: ExternalCalendarEvent | null | undefined): string {
        if (!event) return "";
        const sanitizedTitle = event.title.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
        const dateSuffix = `${event.startDate.getFullYear()}-${String(event.startDate.getMonth() + 1).padStart(2, "0")}-${String(event.startDate.getDate()).padStart(2, "0")}`;
        return `${sanitizedTitle} ${dateSuffix}`.trim();
    }

    private isConflictLikeBasename(basename: string): boolean {
        const lower = basename.toLowerCase();
        if (
            lower.includes("conflict")
            || lower.includes("conflicted copy")
            || /\bcopy\b/.test(lower)
        ) {
            return true;
        }
        // Files ending with " <number>" are commonly conflict clones.
        return /\s\d+$/.test(basename.trim());
    }

    private isLegacyEventsSubfolder(filePath: string, preferredFolderPath: string): boolean {
        if (!preferredFolderPath) return false;
        const normalizedPreferred = normalizePath(preferredFolderPath).toLowerCase();
        const normalizedFile = normalizePath(filePath).toLowerCase();
        return normalizedFile.startsWith(`${normalizedPreferred}/events/`);
    }

    private compareCanonicalCandidates(
        a: VaultNoteIndex,
        b: VaultNoteIndex,
        preferredFolderPath: string,
        event: ExternalCalendarEvent | null | undefined,
    ): number {
        const expectedPrefix = this.getExpectedBasenamePrefix(event);

        const aInPreferred = this.pathInFolder(a.file.path, preferredFolderPath);
        const bInPreferred = this.pathInFolder(b.file.path, preferredFolderPath);
        if (aInPreferred !== bInPreferred) {
            return aInPreferred ? -1 : 1;
        }

        const aMatchesExpected = expectedPrefix.length > 0 && a.file.basename.startsWith(expectedPrefix);
        const bMatchesExpected = expectedPrefix.length > 0 && b.file.basename.startsWith(expectedPrefix);
        if (aMatchesExpected !== bMatchesExpected) {
            return aMatchesExpected ? -1 : 1;
        }

        const aLegacyEvents = this.isLegacyEventsSubfolder(a.file.path, preferredFolderPath);
        const bLegacyEvents = this.isLegacyEventsSubfolder(b.file.path, preferredFolderPath);
        if (aLegacyEvents !== bLegacyEvents) {
            return aLegacyEvents ? 1 : -1;
        }

        const aConflictLike = this.isConflictLikeBasename(a.file.basename);
        const bConflictLike = this.isConflictLikeBasename(b.file.basename);
        if (aConflictLike !== bConflictLike) {
            return aConflictLike ? 1 : -1;
        }

        // 1. Status Priority (Completed/Working > Todo/None)
        // We need to read frontmatter again here (cached), which is fast enough.
        const aStatus = this.getNoteStatusWeight(a.file);
        const bStatus = this.getNoteStatusWeight(b.file);
        if (aStatus !== bStatus) {
            return bStatus - aStatus; // Higher weight comes first
        }

        // 2. Content Length Priority (More content > Less content)
        // Heuristic: The "real" note usually has more text (notes, agenda) than the auto-created stub.
        const aSize = a.file.stat.size;
        const bSize = b.file.stat.size;
        // Only prioritize if difference is significant (> 10%)
        if (Math.abs(aSize - bSize) > (Math.max(aSize, bSize) * 0.1)) {
            return bSize - aSize; // Larger comes first
        }

        // 3. Folder Depth (Shallower > Deeper)? 
        // No, user organization varies.

        // 4. Creation Time (Older > Newer)?
        // The original note is usually older. The duplicate is newer.
        // We want the OLDER note.
        const ctimeDiff = a.file.stat.ctime - b.file.stat.ctime;
        if (ctimeDiff !== 0) return ctimeDiff; // Smaller (older) comes first

        // Fallback: Mtime (Older > Newer)
        // If we edited the original note recently, it might be newer mtime.
        // But if we just created the duplicate, duplicate is newer.
        // If both are "conflict", we might want the one with more edits?
        // Let's stick to CTIME for stability.

        return a.file.path.localeCompare(b.file.path);
    }

    private getNoteStatusWeight(file: TFile): number {
        const cache = this.app.metadataCache.getFileCache(file);
        const status = String(cache?.frontmatter?.[this.config.statusKey] || "").toLowerCase().trim();
        if (status === "complete" || status === "completed" || status === "done") return 3;
        if (status === "working" || status === "in-progress" || status === "doing") return 2;
        if (status === "todo" || status === "notes") return 1;
        return 0;
    }

    private pickCanonicalDuplicateNote(
        candidates: VaultNoteIndex[],
        preferredFolderPath: string,
        event: ExternalCalendarEvent | null | undefined = null,
    ): VaultNoteIndex {
        return [...candidates].sort((a, b) =>
            this.compareCanonicalCandidates(a, b, preferredFolderPath, event),
        )[0];
    }

    private async findExistingNoteForCreateGuard(
        event: ExternalCalendarEvent,
        preferredFolderPath: string,
    ): Promise<VaultNoteIndex | null> {
        const freshIndex = await this.buildVaultIndex();
        const exact = freshIndex.filter((note) => note.eventId === event.id);
        if (exact.length > 0) {
            return this.pickCanonicalDuplicateNote(exact, preferredFolderPath, event);
        }

        const uidCandidates = freshIndex.filter((note) => note.uid === event.uid);
        if (!uidCandidates.length) return null;

        const closeByStart = uidCandidates.filter((candidate) => {
            if (!candidate.startDate) return false;
            const diff = Math.abs(candidate.startDate.getTime() - event.startDate.getTime());
            // Keep guard tolerant enough for timezone drift while still specific to one occurrence.
            return diff <= 120 * 60 * 1000;
        });
        if (closeByStart.length) {
            return this.pickCanonicalDuplicateNote(closeByStart, preferredFolderPath, event);
        }

        const isRecurringInstance = event.id.includes('-') && event.id !== event.uid;
        if (!isRecurringInstance && uidCandidates.length === 1) {
            return this.pickCanonicalDuplicateNote(uidCandidates, preferredFolderPath, event);
        }

        return null;
    }

    private buildOccurrenceSignature(uid: string, startDate: Date | null): string | null {
        const normalizedUid = (uid || "").trim().toLowerCase();
        if (!normalizedUid || !startDate) return null;
        const startTime = startDate.getTime();
        if (!Number.isFinite(startTime)) return null;
        const minuteBucket = Math.round(startTime / 60000);
        return `${normalizedUid}::${minuteBucket}`;
    }

    private async cleanupDuplicateEventNotes(
        vaultIndex: VaultNoteIndex[],
        remoteEvents: ExternalCalendarEvent[],
        calendarConfigs: Record<string, CalendarAutoCreateConfig>,
    ): Promise<number> {
        if (!vaultIndex.length) return 0;

        const remoteById = new Map<string, ExternalCalendarEvent>();
        const remoteByUid = new Map<string, ExternalCalendarEvent[]>();
        for (const event of remoteEvents) {
            if (!remoteById.has(event.id)) {
                remoteById.set(event.id, event);
            }
            const uidKey = (event.uid || "").trim().toLowerCase();
            if (!uidKey) continue;
            const existing = remoteByUid.get(uidKey) ?? [];
            existing.push(event);
            remoteByUid.set(uidKey, existing);
        }

        const cleanupGroupedDuplicates = async (
            groups: Map<string, VaultNoteIndex[]>,
            reason: "eventId" | "occurrence",
        ): Promise<number> => {
            let cleaned = 0;

            for (const [groupKey, notes] of groups.entries()) {
                if (notes.length <= 1) continue;

                let remoteEvent: ExternalCalendarEvent | null = null;
                if (reason === "eventId") {
                    remoteEvent = remoteById.get(groupKey) ?? null;
                } else {
                    const sample = notes[0];
                    const uidKey = (sample.uid || "").trim().toLowerCase();
                    const remoteCandidates = uidKey ? (remoteByUid.get(uidKey) ?? []) : [];
                    const sampleStart = sample.startDate ?? this.getRecurrenceDateFromId(sample.eventId);

                    if (remoteCandidates.length > 0) {
                        if (sampleStart) {
                            remoteEvent = [...remoteCandidates].sort((a, b) => {
                                const aDiff = Math.abs(a.startDate.getTime() - sampleStart.getTime());
                                const bDiff = Math.abs(b.startDate.getTime() - sampleStart.getTime());
                                return aDiff - bDiff;
                            })[0] ?? null;
                        } else {
                            remoteEvent = remoteCandidates[0];
                        }
                    }
                }

                const preferredFolderPath = this.resolveCalendarFolderPath(
                    remoteEvent ? calendarConfigs[remoteEvent.sourceUrl || ""] : null,
                );
                const canonical = this.pickCanonicalDuplicateNote(notes, preferredFolderPath, remoteEvent ?? null);

                logger.warn(
                    `[AutoCreateService] Duplicate ${reason === "eventId" ? "event ID" : "occurrence"} notes detected for ${groupKey}; keeping ${canonical.file.path} and cleaning ${notes.length - 1} duplicate(s)`,
                );

                for (const note of notes) {
                    if (note.file.path === canonical.file.path) continue;
                    const didClean = await this.cleanupDuplicateNote(note.file);
                    if (didClean) {
                        cleaned++;
                    }
                }
            }

            return cleaned;
        };

        let cleanedCount = 0;

        const groupedByEventId = new Map<string, VaultNoteIndex[]>();
        for (const note of vaultIndex) {
            const existing = groupedByEventId.get(note.eventId) ?? [];
            existing.push(note);
            groupedByEventId.set(note.eventId, existing);
        }
        cleanedCount += await cleanupGroupedDuplicates(groupedByEventId, "eventId");

        if (cleanedCount > 0) {
            vaultIndex = await this.buildVaultIndex();
        }

        const groupedByOccurrence = new Map<string, VaultNoteIndex[]>();
        for (const note of vaultIndex) {
            const noteStart = note.startDate ?? this.getRecurrenceDateFromId(note.eventId);
            const occurrenceKey = this.buildOccurrenceSignature(note.uid, noteStart);
            if (!occurrenceKey) continue;
            const existing = groupedByOccurrence.get(occurrenceKey) ?? [];
            existing.push(note);
            groupedByOccurrence.set(occurrenceKey, existing);
        }
        cleanedCount += await cleanupGroupedDuplicates(groupedByOccurrence, "occurrence");

        return cleanedCount;
    }

    private async cleanupDuplicateNote(file: TFile): Promise<boolean> {
        // Respect user archive/delete behavior first.
        if (await this.deleteOrArchive(file)) {
            return true;
        }

        // Fallback when syncOnEventDelete is "nothing": archive duplicate notes
        // in a deterministic folder so they stop participating in sync.
        const duplicateArchiveFolder = this.getDuplicateArchiveFolder();
        const baseName = file.basename.replace(/\s+duplicate(\s+\d+)?$/i, "");
        try {
            await this.ensureFolderExists(duplicateArchiveFolder);
            await this.renameFileUnique(file, `${baseName} duplicate`, duplicateArchiveFolder);
            return true;
        } catch (error) {
            logger.warn(
                `[AutoCreateService] Failed duplicate archive path (${duplicateArchiveFolder}) for ${file.path}; retrying fallback`,
                error,
            );
        }


        const fallbackArchiveFolder = normalizePath("System/Archive/Calendar Duplicates");

        if (duplicateArchiveFolder === fallbackArchiveFolder) {
            logger.error(`[AutoCreateService] Failed to archive duplicate note: ${file.path}`);
            return false;
        }

        try {
            await this.ensureFolderExists(fallbackArchiveFolder);
            await this.renameFileUnique(file, `${baseName} duplicate`, fallbackArchiveFolder);
            return true;
        } catch (fallbackError) {
            logger.error(`[AutoCreateService] Failed to archive duplicate note: ${file.path}`, fallbackError);
            return false;
        }
    }

    private getDuplicateArchiveFolder(): string {
        const configuredArchive = typeof this.config.archiveFolder === "string"
            ? this.config.archiveFolder.trim()
            : "";
        if (configuredArchive) {
            return normalizePath(`${configuredArchive}/Duplicates`);
        }
        return normalizePath("System/Archive/Calendar Duplicates");
    }

    private async processEvent(
        event: ExternalCalendarEvent,
        index: VaultNoteIndex[],
        unlinkedIndex: Map<string, UnlinkedNoteIndex[]>,
        calendarInfo: CalendarAutoCreateConfig | null,
        filterTerms: string[],
        forceRegenerate = false
    ): Promise<{ action: 'created' | 'updated' | 'deleted' | 'none', file?: TFile }> {
        const resolvedInfo: CalendarAutoCreateConfig = calendarInfo ?? {};
        const calendarTag = this.normalizeAutoCreateTag(resolvedInfo.tag);
        const resolvedFolderPath = this.resolveCalendarFolderPath(resolvedInfo);

        // 1. Find Matching Note - EXACT ID MATCH (Highest Priority)
        const exactMatches = index.filter((note) => note.eventId === event.id);
        let match: VaultNoteIndex | undefined;
        if (exactMatches.length === 1) {
            match = exactMatches[0];
        } else if (exactMatches.length > 1) {
            match = this.pickCanonicalDuplicateNote(exactMatches, resolvedFolderPath, event);
            logger.warn(
                `[AutoCreateService] Multiple exact matches (${exactMatches.length}) for ${event.id}; using canonical note ${match.file.path}`,
            );
        }

        if (match) {
            logger.log(`[AutoCreateService] ✓ Exact ID Match: ${event.id} -> ${match.file.path}`);
        } else {
            logger.log(`[AutoCreateService] ✗ No Exact ID Match for: ${event.id} (UID: ${event.uid})`);
        }

        // 2. Fuzzy Match (For Reschedules & Timezone Drift)
        if (!match) {
            const candidates = index.filter(n => n.uid === event.uid);
            logger.log(`[AutoCreateService] Found ${candidates.length} candidates with matching UID: ${event.uid}`);

            if (candidates.length > 0) {
                const isRecurringInstance = event.id.includes('-') && event.id !== event.uid;

                if (isRecurringInstance) {
                    // RECURRING INSTANCE MATCHING
                    const eventRecurrenceId = event.id.substring(event.id.lastIndexOf('-') + 1);
                    const eventRidTsRaw = parseInt(eventRecurrenceId, 10);
                    const eventRidTs = this.normalizeRecurrenceTimestamp(eventRidTsRaw);

                    if (!isNaN(eventRidTs)) {
                        // Try timestamp-based matching first (most accurate)
                        match = candidates.find(n => {
                            const noteRid = n.eventId.substring(n.eventId.lastIndexOf('-') + 1);
                            const noteRidTsRaw = parseInt(noteRid, 10);
                            const noteRidTs = this.normalizeRecurrenceTimestamp(noteRidTsRaw);

                            if (isNaN(noteRidTs)) return false;

                            // Strict: 5 minute tolerance for exact matches
                            if (Math.abs(eventRidTs - noteRidTs) < 5 * 60 * 1000) {
                                logger.log(`[AutoCreateService] ✓ Strict timestamp match (5min): ${n.file.path}`);
                                return true;
                            }

                            // Relaxed: 2 hour tolerance for timezone drift
                            if (Math.abs(eventRidTs - noteRidTs) < 120 * 60 * 1000) {
                                logger.log(`[AutoCreateService] ✓ Relaxed timestamp match (2h): ${n.file.path}`);
                                return true;
                            }

                            // Date component match (same day, ignore time)
                            const d1 = new Date(eventRidTs);
                            const d2 = new Date(noteRidTs);
                            if (
                                d1.getUTCFullYear() === d2.getUTCFullYear() &&
                                d1.getUTCMonth() === d2.getUTCMonth() &&
                                d1.getUTCDate() === d2.getUTCDate()
                            ) {
                                logger.log(`[AutoCreateService] ✓ Date component match: ${n.file.path}`);
                                return true;
                            }
                            return false;
                        });

                        // Fallback: Match by actual start time if recurrence ID matching failed
                        if (!match && candidates.length > 0) {
                            match = candidates.find(n => {
                                if (n.startDate) {
                                    const timeDiff = Math.abs(n.startDate.getTime() - event.startDate.getTime());
                                    // 5 minute tolerance for start time matching
                                    if (timeDiff < 5 * 60 * 1000) {
                                        logger.log(`[AutoCreateService] ✓ Start time match (5min): ${n.file.path}, diff: ${timeDiff}ms`);
                                        return true;
                                    }
                                }
                                return false;
                            });
                        }

                        // Log if we still haven't found a match
                        if (!match) {
                            logger.warn(`[AutoCreateService] ⚠️  Fuzzy match failed for recurring event: ${event.id} (UID: ${event.uid})`);
                            logger.warn(`[AutoCreateService]   Event start: ${event.startDate.toISOString()}`);
                            logger.warn(`[AutoCreateService]   Candidates checked: ${candidates.length}`);
                            candidates.forEach(c => {
                                logger.warn(`[AutoCreateService]     - ${c.file.path}: ID=${c.eventId}, Start=${c.startDate?.toISOString() || 'unknown'}`);
                            });
                        }
                    }
                } else {
                    // SINGLE EVENT MATCHING
                    if (candidates.length === 1) {
                        match = candidates[0];
                        logger.log(`[AutoCreateService] ✓ Single candidate match: ${match.file.path}`);
                    } else if (candidates.length > 0) {
                        // Multiple candidates - pick best by start time
                        logger.warn(`[AutoCreateService] Multiple candidates (${candidates.length}) for UID ${event.uid}. Matching by start time...`);

                        // Try strict 5-minute match first
                        match = candidates.find(n => n.startDate && Math.abs(n.startDate.getTime() - event.startDate.getTime()) < 5 * 60 * 1000);

                        if (!match) {
                            // Fallback to 2-hour tolerance
                            match = candidates.find(n => n.startDate && Math.abs(n.startDate.getTime() - event.startDate.getTime()) < 120 * 60 * 1000);
                        }

                        if (!match) {
                            // Last resort: take the first one to prevent duplicates
                            match = candidates[0];
                            logger.warn(`[AutoCreateService] Using first candidate as fallback: ${match.file.path}`);
                        } else {
                            logger.log(`[AutoCreateService] ✓ Best time match selected: ${match.file.path}`);
                        }
                    }
                }
            } else {
                // No candidates with matching UID - log for debugging
                logger.log(`[AutoCreateService] ℹ️  No candidates with matching UID for event: ${event.id} (UID: ${event.uid})`);
                logger.log(`[AutoCreateService]   Event: "${event.title}" at ${event.startDate.toISOString()}`);
            }
        }

        // 2b. Fallback Match: Unlinked local note by title + date
        if (!match) {
            const titleKey = this.normalizeTitleKey(this.stripDateSuffix(event.title));
            const dateKey = this.formatDateKey(event.startDate);
            const key = `${titleKey}::${dateKey}`;
            const candidates = unlinkedIndex.get(key) ?? [];

            if (candidates.length > 0) {
                let best = candidates[0];
                let bestDiff = Math.abs(best.startDate.getTime() - event.startDate.getTime());
                for (const candidate of candidates.slice(1)) {
                    const diff = Math.abs(candidate.startDate.getTime() - event.startDate.getTime());
                    if (diff < bestDiff) {
                        best = candidate;
                        bestDiff = diff;
                    }
                }

                // Only accept within 2 hours to avoid bad attachments
                if (bestDiff <= 120 * 60 * 1000) {
                    match = {
                        file: best.file,
                        eventId: "",
                        uid: event.uid,
                        startDate: best.startDate,
                    };
                    logger.log(`[AutoCreateService] ✓ Unlinked note matched by title/date: ${best.file.path}`);
                } else {
                    logger.log(`[AutoCreateService] ✗ Unlinked candidates rejected (time mismatch): ${event.title}`);
                }
            }
        }

        // 3. Process Match - UPDATE OR CANCEL
        if (match) {
            const file = match.file;

            // HANDLE CANCELLATION
            if (event.isCancelled) {
                logger.log(`[AutoCreateService] 🚫 Event CANCELLED: "${event.title}" (ID: ${event.id})`);
                logger.log(`[AutoCreateService] Marking note as cancelled: ${file.path}`);
                await this.markAsCancelled(file);
                return { action: 'updated', file };
            }

            // HANDLE UPDATE
            let updated = false;
            const cache = this.app.metadataCache.getFileCache(file);
            const oldFm = cache?.frontmatter || {};
            const hasExternalId = !!(
                this.getFrontmatterValueCaseInsensitive(oldFm, this.config.eventIdKey)
                || this.getFrontmatterValueCaseInsensitive(oldFm, this.config.uidKey)
            );

            // Update Frontmatter
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                const previousStatusRaw = this.getFrontmatterValueCaseInsensitive(fm, this.config.statusKey);
                const previousStatus = previousStatusRaw != null ? String(previousStatusRaw) : "";
                const previousStatusNormalized = previousStatus.toLowerCase().trim();
                const preserveCompletedStatus = previousStatusNormalized === "complete" || previousStatusNormalized === "wont-do";
                // Update IDs
                const existingEventId = this.getFrontmatterValueCaseInsensitive(fm, this.config.eventIdKey);
                if (existingEventId !== event.id) {
                    logger.log(`[AutoCreateService] Updating ${this.config.eventIdKey}: ${existingEventId} -> ${event.id}`);
                    if (this.setFrontmatterValueCaseInsensitive(fm, this.config.eventIdKey, event.id)) {
                        updated = true;
                    }
                }
                const existingUid = this.getFrontmatterValueCaseInsensitive(fm, this.config.uidKey);
                if (existingUid !== event.uid) {
                    logger.log(`[AutoCreateService] Updating ${this.config.uidKey}: ${existingUid} -> ${event.uid}`);
                    if (this.setFrontmatterValueCaseInsensitive(fm, this.config.uidKey, event.uid)) {
                        updated = true;
                    }
                }

                // Migration: Remove legacy googleEventId if we are using a different key
                if (this.config.eventIdKey !== "googleEventId" && this.getFrontmatterValueCaseInsensitive(fm, "googleEventId") != null) {
                    logger.log(`[AutoCreateService] Migrating legacy googleEventId to ${this.config.eventIdKey}`);
                    if (this.deleteFrontmatterValueCaseInsensitive(fm, "googleEventId")) {
                        updated = true;
                    }
                }

                // Update Start Time
                const fmtStart = formatDateTimeForFrontmatter(event.startDate);
                const existingStart = this.getFrontmatterValueCaseInsensitive(fm, this.config.startProperty);
                if (existingStart !== fmtStart) {
                    logger.log(`[AutoCreateService] Updating start time: ${existingStart} -> ${fmtStart}`);
                    if (this.setFrontmatterValueCaseInsensitive(fm, this.config.startProperty, fmtStart)) {
                        updated = true;
                    }
                }

                // Do not force-update unrelated fields.

                // Update End Time/Duration
                if (!this.config.useEndDuration) {
                    const fmtEnd = formatDateTimeForFrontmatter(event.endDate);
                    const existingEnd = this.getFrontmatterValueCaseInsensitive(fm, this.config.endProperty);
                    if (existingEnd !== fmtEnd) {
                        logger.log(`[AutoCreateService] Updating end time: ${existingEnd} -> ${fmtEnd}`);
                        if (this.setFrontmatterValueCaseInsensitive(fm, this.config.endProperty, fmtEnd)) {
                            updated = true;
                        }
                    }
                } else {
                    const dur = Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60000);
                    const existingDuration = this.getFrontmatterValueCaseInsensitive(fm, this.config.endProperty);
                    if (existingDuration !== dur) {
                        logger.log(`[AutoCreateService] Updating duration: ${existingDuration} -> ${dur} minutes`);
                        if (this.setFrontmatterValueCaseInsensitive(fm, this.config.endProperty, dur)) {
                            updated = true;
                        }
                    }
                }

                // Update Title
                const existingTitle = this.getFrontmatterValueCaseInsensitive(fm, this.config.titleKey);
                if (existingTitle !== event.title) {
                    logger.log(`[AutoCreateService] Updating ${this.config.titleKey}: "${existingTitle}" -> "${event.title}"`);
                    if (this.setFrontmatterValueCaseInsensitive(fm, this.config.titleKey, event.title)) {
                        updated = true;
                    }
                }

                if (hasExternalId) {
                    // Clear previous cancelled status if event is no longer cancelled
                    const previousStatusValue = this.getFrontmatterValueCaseInsensitive(fm, this.config.previousStatusKey);
                    if (previousStatusValue != null && !event.isCancelled) {
                        const canceledStatus = (this.config.canceledStatusValue || "").toLowerCase().trim();
                        const currentStatusRaw = this.getFrontmatterValueCaseInsensitive(fm, this.config.statusKey);
                        const currentStatus = currentStatusRaw ? String(currentStatusRaw).toLowerCase().trim() : "";
                        if (canceledStatus && currentStatus === canceledStatus) {
                            logger.log(`[AutoCreateService] Restoring previous status: ${previousStatusValue}`);
                            if (this.setFrontmatterValueCaseInsensitive(fm, this.config.statusKey, previousStatusValue)) {
                                updated = true;
                            }
                        }
                        // Always clear the stored previous status once the event is active again,
                        // but do not override user-changed status values.
                        if (this.deleteFrontmatterValueCaseInsensitive(fm, this.config.previousStatusKey)) {
                            updated = true;
                        }
                    }
                }

                // Protect completed states from being reset during sync (always, not just for external IDs).
                if (!event.isCancelled && preserveCompletedStatus) {
                    const currRaw = this.getFrontmatterValueCaseInsensitive(fm, this.config.statusKey);
                    const curr = currRaw ? String(currRaw).toLowerCase().trim() : "";
                    if (curr !== previousStatusNormalized) {
                        logger.log(`[AutoCreateService] Preserving completed status: ${previousStatus}`);
                        if (this.setFrontmatterValueCaseInsensitive(fm, this.config.statusKey, previousStatus)) {
                            updated = true;
                        }
                    }
                }

                if (calendarTag && this.mergeTagIntoFrontmatter(fm, calendarTag)) {
                    logger.log(`[AutoCreateService] Added calendar tag "${calendarTag}" to ${file.path}`);
                    updated = true;
                }
            });

            // REGENERATE LOGIC
            if (forceRegenerate && event.endDate.getTime() > Date.now()) {
                logger.log(`[AutoCreateService] ♻️ Regenerating future note: ${file.path}`);
                try {
                    const updatedFile = await createMeetingNoteFromExternalEvent(
                        this.app,
                        event,
                        resolvedInfo.template || null,
                        resolvedFolderPath,
                        this.config.startProperty,
                        this.config.endProperty,
                        this.config.useEndDuration,
                        calendarTag || null,
                        undefined,
                        undefined,
                        undefined,
                        {
                            eventIdKey: this.config.eventIdKey,
                            uidKey: this.config.uidKey,
                            titleKey: this.config.titleKey,
                            statusKey: this.config.statusKey,
                        },
                        file
                    );
                    if (updatedFile) {
                        logger.log(`[AutoCreateService] ✓ Regenerated: ${file.path}`);
                        return { action: 'updated', file: updatedFile };
                    }
                } catch (e) {
                    logger.error(`[AutoCreateService] Failed to regenerate ${file.path}`, e);
                }
            }

            // Rename File if needed
            const sanitizedTitle = event.title.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
            const dateSuffix = `${event.startDate.getFullYear()}-${String(event.startDate.getMonth() + 1).padStart(2, "0")}-${String(event.startDate.getDate()).padStart(2, "0")}`;
            const expectedPrefix = `${sanitizedTitle} ${dateSuffix}`;

            if (!file.basename.startsWith(expectedPrefix)) {
                logger.log(`[AutoCreateService] Renaming file: "${file.basename}" -> "${expectedPrefix}"`);
                try {
                    await this.renameFileUnique(file, expectedPrefix, file.parent?.path || "");
                    updated = true;
                } catch (error) {
                    logger.error(`[AutoCreateService] Failed to rename file: ${error}`);
                }
            }

            if (updated) {
                logger.log(`[AutoCreateService] ✓ Updated note: ${file.path}`);
            } else {
                logger.log(`[AutoCreateService] ✓ Note already in sync: ${file.path}`);
            }

            return { action: updated ? 'updated' : 'none', file };
        }

        // 4. CREATE NEW NOTE (No Match Found)
        const autoCreateEnabled = resolvedInfo.autoCreateEnabled !== false;

        // Don't create notes for cancelled events
        if (event.isCancelled) {
            logger.log(`[AutoCreateService] Skipping creation for cancelled event: "${event.title}" (ID: ${event.id})`);
            return { action: 'none' };
        }

        // Check filter terms
        if (filterTerms.length > 0) {
            const lowerTitle = (event.title || "").toLowerCase();
            if (filterTerms.some((term) => lowerTitle.includes(term))) {
                logger.log(`[AutoCreateService] Skipping filtered event: "${event.title}"`);
                return { action: 'none' };
            }
        }

        // Check auto-create enabled
        if (!autoCreateEnabled) {
            logger.log(`[AutoCreateService] Auto-create disabled for calendar: ${event.sourceUrl}`);
            return { action: 'none' };
        }

        // Late guard against stale metadata/index races across devices.
        const lateExisting = await this.findExistingNoteForCreateGuard(event, resolvedFolderPath);
        if (lateExisting) {
            logger.warn(
                `[AutoCreateService] Late create guard prevented duplicate for ${event.id}; existing note: ${lateExisting.file.path}`,
            );
            return { action: 'none', file: lateExisting.file };
        }

        // Check if an archived version of this event exists
        // If so, don't re-create it - respect the user's decision to archive
        const archivedVersion = await this.findArchivedEvent(event.id, event.uid);
        if (archivedVersion) {
            logger.log(`[AutoCreateService] ⏭️  Skipping creation - archived version exists: ${archivedVersion.path}`);
            logger.log(`[AutoCreateService]   Event: "${event.title}" (ID: ${event.id}, UID: ${event.uid})`);
            return { action: 'none' };
        }

        // CREATE NOTE
        try {
            logger.log(`[AutoCreateService] 📝 Creating new note for: "${event.title}" (ID: ${event.id}, UID: ${event.uid})`);
            const file = await createMeetingNoteFromExternalEvent(
                this.app,
                event,
                resolvedInfo.template || null,
                resolvedFolderPath,
                this.config.startProperty,
                this.config.endProperty,
                this.config.useEndDuration,
                calendarTag || null,
                undefined,
                undefined,
                undefined,
                {
                    eventIdKey: this.config.eventIdKey,
                    uidKey: this.config.uidKey,
                    titleKey: this.config.titleKey,
                    statusKey: this.config.statusKey,
                },
            );
            if (file) {
                logger.log(`[AutoCreateService] ✓ Created note: ${file.path}`);
                return { action: 'created', file };
            }
        } catch (e) {
            logger.error(`[AutoCreateService] ✗ Failed to create note for "${event.title}":`, e);
        }

        return { action: 'none' };
    }

    private normalizeAutoCreateTag(tag: string | null | undefined): string {
        return normalizeTagValue(tag);
    }

    private normalizeFrontmatterKey(key: string): string {
        return String(key || "").trim().toLowerCase();
    }

    private findFrontmatterKeyCaseInsensitive(target: Record<string, any>, key: string): string | null {
        const normalized = this.normalizeFrontmatterKey(key);
        if (!normalized) return null;
        return Object.keys(target).find((candidate) => this.normalizeFrontmatterKey(candidate) === normalized) || null;
    }

    private getFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string): any {
        const existing = this.findFrontmatterKeyCaseInsensitive(target, key);
        return existing ? target[existing] : undefined;
    }

    private getFrontmatterStringCaseInsensitive(target: Record<string, any>, key: string): string | null {
        const value = this.getFrontmatterValueCaseInsensitive(target, key);
        if (value == null) return null;
        const asString = String(value).trim();
        return asString.length > 0 ? asString : null;
    }

    private setFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string, value: any): boolean {
        const existing = this.findFrontmatterKeyCaseInsensitive(target, key);
        const targetKey = existing || key;
        if (target[targetKey] === value) return false;
        target[targetKey] = value;
        return true;
    }

    private deleteFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string): boolean {
        const existing = this.findFrontmatterKeyCaseInsensitive(target, key);
        if (!existing) return false;
        delete target[existing];
        return true;
    }

    private mergeTagIntoFrontmatter(fm: Record<string, any>, tag: string): boolean {
        const normalizedTag = this.normalizeAutoCreateTag(tag);
        const incoming = parseTagInput(normalizedTag);
        if (!incoming.length) return false;
        const existing = parseTagInput(fm.tags);
        const changed = incoming.some((tagValue) => !existing.includes(tagValue));
        const merged = mergeTagInputs(existing, incoming);
        fm.tags = merged;
        return changed;
    }

    private async deleteOrArchive(file: TFile): Promise<boolean> {
        if (this.config.syncOnEventDelete === 'delete') {
            await this.app.vault.delete(file);
            return true;
        } else if (this.config.syncOnEventDelete === 'archive') {
            const archiveFolder = this.config.archiveFolder;
            if (archiveFolder) {
                if (this.isArchivedNote(file)) return false;
                await this.ensureFolderExists(archiveFolder);
                await this.renameFileUnique(file, file.basename, archiveFolder);
                return true;
            }
        }
        // "nothing" means do nothing
        return false;
    }

    private async ensureFolderExists(folderPath: string): Promise<void> {
        const normalized = normalizePath(folderPath);
        if (!normalized) return;

        const segments = normalized.split("/").filter(Boolean);
        let currentPath = "";

        for (const segment of segments) {
            currentPath = currentPath ? `${currentPath}/${segment}` : segment;
            if (this.app.vault.getAbstractFileByPath(currentPath)) continue;
            try {
                await this.app.vault.createFolder(currentPath);
            } catch {
                // Race condition: another process may have created the folder
                // between our check and our createFolder call. If the folder
                // exists now, that's fine — swallow the error unconditionally.
                if (!this.app.vault.getAbstractFileByPath(currentPath)) {
                    // Folder truly doesn't exist and we can't create it.
                    throw new Error(`Could not create folder: ${currentPath}`);
                }
            }
        }
    }

    private isArchivedNote(file: TFile): boolean {
        if (this.config.syncOnEventDelete !== 'archive') return false;
        const archiveFolder = this.config.archiveFolder;
        if (!archiveFolder) return false;
        const normalized = normalizePath(archiveFolder);
        return file.path === normalized || file.path.startsWith(`${normalized}/`);
    }

    private async findArchivedEvent(eventId: string, uid: string): Promise<TFile | null> {
        if (this.config.syncOnEventDelete !== 'archive') return null;
        const archiveFolder = this.config.archiveFolder;
        if (!archiveFolder) return null;

        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            if (!this.isArchivedNote(file)) continue;

            const fm = await this.getFrontmatterForFile(file);
            if (!fm) continue;

            // Check if this archived file matches the event ID or UID
            const fileEventId = this.getFrontmatterStringCaseInsensitive(fm, this.config.eventIdKey);
            const fileUid = this.getFrontmatterStringCaseInsensitive(fm, this.config.uidKey);

            // Match by exact event ID
            if (fileEventId && fileEventId === eventId) {
                return file;
            }

            // Match by UID (for recurring events that might have different instance IDs)
            if (fileUid && fileUid === uid) {
                return file;
            }
        }

        return null;
    }

    private async markAsCancelled(file: TFile) {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter || {};
        const hasExternalId = !!(
            this.getFrontmatterValueCaseInsensitive(fm, this.config.eventIdKey)
            || this.getFrontmatterValueCaseInsensitive(fm, this.config.uidKey)
        );
        if (!hasExternalId) return;
        const statusValue = this.config.canceledStatusValue;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            if (statusValue) {
                const currentStatus = this.getFrontmatterValueCaseInsensitive(fm, this.config.statusKey);
                const previousStatus = this.getFrontmatterValueCaseInsensitive(fm, this.config.previousStatusKey);
                if (currentStatus != null && currentStatus !== statusValue && previousStatus == null) {
                    this.setFrontmatterValueCaseInsensitive(
                        fm,
                        this.config.previousStatusKey,
                        currentStatus,
                    );
                }
                this.setFrontmatterValueCaseInsensitive(fm, this.config.statusKey, statusValue);
            }
        });
    }

    private async renameFileUnique(file: TFile, baseName: string, folderPath: string) {
        let newPath = normalizePath(`${folderPath}/${baseName}.${file.extension}`);
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(newPath)) {
            const existing = this.app.vault.getAbstractFileByPath(newPath);
            if (existing === file) return;
            newPath = normalizePath(`${folderPath}/${baseName} ${counter}.${file.extension}`);
            counter++;
        }
        // Use vault.rename instead of fileManager.renameFile to stay consistent
        // with ensureFolderExists which uses vault.createFolder. fileManager.renameFile
        // ultimately calls native fs.rename which fails if the parent folder was
        // created via the vault abstraction but doesn't yet exist on disk.
        await this.app.vault.rename(file, newPath);
    }

    private getRecurrenceDateFromId(googleEventId: string): Date | null {
        // Find last separator
        const match = googleEventId.match(/[-_]([^-_]+)$/);
        if (!match) return null;

        const suffix = match[1];

        // 1. Epoch Timestamp
        if (/^\d+$/.test(suffix)) {
            const ts = this.normalizeRecurrenceTimestamp(parseInt(suffix, 10));
            if (!Number.isFinite(ts) || ts <= 0) return null;
            return new Date(ts);
        }

        // 2. ISO Basic Format (YYYYMMDDTHHMMSSZ)
        const iso = suffix.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
        if (iso) {
            // Note: Months are 0-indexed in JS Date
            return new Date(Date.UTC(
                parseInt(iso[1]),
                parseInt(iso[2]) - 1,
                parseInt(iso[3]),
                parseInt(iso[4]),
                parseInt(iso[5]),
                parseInt(iso[6])
            ));
        }

        return null;
    }

    private normalizeRecurrenceTimestamp(ts: number): number {
        if (!Number.isFinite(ts) || ts <= 0) return NaN;
        // Handle recurrence ids expressed in seconds (10-digit) vs milliseconds (13-digit)
        if (ts < 1_000_000_000_000) {
            return ts * 1000;
        }
        return ts;
    }

    private extractUidFromGoogleEventId(googleEventId: string): string | null {
        // Handle "UID-Timestamp" or "UID_Timestamp"
        // Google often uses UNDERSCORE.
        const match = googleEventId.match(/[-_]([^-_]+)$/);
        if (!match) return null;

        const suffix = match[1];

        // Check 1: Epoch digits
        if (/^\d+$/.test(suffix)) {
            const ts = this.normalizeRecurrenceTimestamp(parseInt(suffix, 10));
            if (Number.isFinite(ts)) {
                const date = new Date(ts);
                if (date.getUTCFullYear() >= 2000 && date.getUTCFullYear() <= 2100) {
                    return googleEventId.substring(0, match.index);
                }
            }
        }

        // Check 2: ISO Basic Format (YYYYMMDDTHHMMSSZ or similar)
        // e.g. 20250122T150000Z or just 20250122T150000
        // We just check if it looks like a date string 
        if (/^\d{8}T\d{6}Z?$/.test(suffix)) {
            return googleEventId.substring(0, match.index);
        }

        // Check 3: Fallback log
        logger.warn(`[AutoCreateService] UID Extraction Failed. ID: "${googleEventId}", Suffix: "${suffix}"`);

        return null;
    }
}
