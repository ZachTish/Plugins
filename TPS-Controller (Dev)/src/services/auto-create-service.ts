import { App, TFile, normalizePath, Notice } from "obsidian";
import * as logger from "../logger";
import { ExternalCalendarService } from "./external-calendar-service";
import { ExternalCalendarEvent } from "../types";
import { buildExternalEventNoteBasename, createMeetingNoteFromExternalEvent } from "./external-event-modal";
import { formatDateTimeForFrontmatter, parseFrontmatterDate, matchesExclusionPattern, normalizeCalendarUrl, normalizeComparablePath } from "../utils";
import { mergeTagInputs, normalizeTagValue, parseTagInput } from "../utils/tag-utils";
import { getDailyNoteResolver } from "../utils/daily-note-resolver";
import { ensureDailyNoteFile } from "../utils/daily-note-create";
import { applyTemplateVars, buildTemplateVars } from "../utils/template-variable-service";
import { resolveTemplateFile } from "../utils/template-resolution-service";
import { CheckboxPatterns } from "./checkbox-pattern-service";

interface CalendarAutoCreateConfig {
    mode?: "note" | "task-list";
    typeFolder?: string | null;
    folder?: string | null;
    tag?: string | null;
    template?: string | null;
    taskListPath?: string | null;
    taskListHeading?: string | null;
    autoCreateEnabled?: boolean;
}

interface EventComparison {
    normalizedTitle: string;
    normalizedLocation: string;
    expectedStart: string;
    expectedEnd: string | number;
}

export interface AutoCreateServiceConfig {
    startProperty: string;
    endProperty: string;
    useEndDuration: boolean;
    dateFormat?: string;
    orphanArchiveGraceCycles: number;
    archiveFolder: string;
    archiveNotePath: string;
    globalIgnorePaths: string[];
    canceledStatusValue: string | null;
    allowAutoCreate?: boolean;
    eventIdKey: string;
    uidKey: string;
    sourceUrlKey: string;
    titleKey: string;
    statusKey: string;
    previousStatusKey: string;
    scheduledDateProperty: string;
    scheduledStartProperty: string;
    scheduledEndProperty: string;
    orphanCandidateAtKey: string;
    orphanMissCountKey: string;
    orphanReasonKey: string;
    cancelledAtKey: string;
    scanRootFolders: string[];
    syncBackfillDays?: number;
}

/** Vault note with stored frontmatter values for string-based comparison. */
interface VaultNote {
    file: TFile;
    eventId: string | null;
    /** Raw frontmatter string — compared as-is, never re-parsed to Date for matching. */
    storedStart: string;
    storedEnd: string | number;
    storedTitle: string;
    storedLocation: string;
    /** Parsed start date, used for range-limited orphan handling. */
    startDate: Date | null;
    orphanCandidateAt: string | null;
    isArchived: boolean;
}

interface TaskListItemRecord {
    eventId: string;
    sourceUrl: string | null;
    scheduledValue: string | null;
    title: string;
    lineNumber: number;
    line: string;
    checkboxState: string;
    isCompleted: boolean;
    inlineProperties: Record<string, string>;
}

interface TaskListState {
    file: TFile;
    lines: string[];
    heading: string | null;
    itemsByEventId: Map<string, TaskListItemRecord>;
    touchedEventIds: Set<string>;
    changed: boolean;
}

interface NoteCreateResult {
    file: TFile | null;
    reusedExisting: boolean;
}

interface GcmItemSemanticsApi {
    extractInlineProperty?: (text: string, ...keys: string[]) => string | null;
    stripInlineProperties?: (text: string) => string;
}

export class AutoCreateService {
    app: App;
    config: AutoCreateServiceConfig;
    private isSyncing = false;
    /**
     * Orphan grace period: tracks how many consecutive sync cycles a note
     * has gone unmatched. Persists across sync calls (instance-level state).
     * Key = file.path, Value = consecutive miss count.
     */
    private orphanMissCount: Map<string, number> = new Map();
    private static readonly ORPHAN_GRACE_CYCLES = 2;
    private orphanDeletionTombstones: Map<string, number> = new Map();
    private static readonly ORPHAN_TOMBSTONE_TTL_MS = 6 * 60 * 60 * 1000;
    private readonly taskListStateByPath = new Map<string, TaskListState>();

    constructor(app: App) {
        this.app = app;
        this.config = {
            startProperty: "scheduled",
            endProperty: "timeEstimate",
            useEndDuration: true,
            orphanArchiveGraceCycles: 5,
            archiveFolder: "",
            archiveNotePath: "",
            globalIgnorePaths: [],
            canceledStatusValue: null,
            allowAutoCreate: false,
            eventIdKey: "externalEventId",
            uidKey: "tpsCalendarUid",
            sourceUrlKey: "tpsCalendarSourceUrl",
            titleKey: "title",
            statusKey: "status",
            previousStatusKey: "tpsCalendarPrevStatus",
            scheduledDateProperty: "",
            scheduledStartProperty: "",
            scheduledEndProperty: "",
            orphanCandidateAtKey: "tpsCalendarOrphanCandidateAt",
            orphanMissCountKey: "tpsCalendarOrphanMissCount",
            orphanReasonKey: "tpsCalendarOrphanReason",
            cancelledAtKey: "tpsCalendarCancelledAt",
            scanRootFolders: [],
        };
    }

    updateConfig(config: Partial<AutoCreateServiceConfig>) {
        this.config = { ...this.config, ...config };
    }

    private getGcmItemSemanticsApi(): GcmItemSemanticsApi | null {
        return (this.app as any)?.plugins?.getPlugin?.('tps-global-context-menu')?.api
            || (this.app as any)?.plugins?.plugins?.['TPS-Global-Context-Menu (Dev)']?.api
            || null;
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
        const hasTaskListMode = Object.values(calendarConfigs).some(
            (config) => (config?.autoCreateEnabled ?? true) !== false && (config?.mode || "note") === "task-list"
        );
        if (!hasTaskListMode && !this.getConfiguredScanRoots().length) {
            logger.warn("[AutoCreateService] Skipping sync: no scoped scan roots configured (vault-wide scan disabled).");
            return;
        }

        this.isSyncing = true;
        logger.log('[AutoCreateService] Starting change-aware sync...');

        try {
            this.pruneOrphanDeletionTombstones();
            this.taskListStateByPath.clear();

            const rangeStart = new Date();
            const backfillDays = this.config.syncBackfillDays ?? 0;
            rangeStart.setDate(rangeStart.getDate() - (backfillDays > 0 ? backfillDays : 14));
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
            const { byEventId, allNotes } = await this.buildVaultIndex();

            let created = 0, updated = 0, deleted = 0, quarantined = 0, restored = 0;
            const uniqueRemoteEvents: ExternalCalendarEvent[] = [];
            const processedEventIds = new Set<string>();

            for (const event of remoteEvents) {
                const normalizedSourceUrl = this.normalizeSourceUrl(event.sourceUrl);
                const eventKey = normalizedSourceUrl
                    ? this.buildSourceScopedKey(normalizedSourceUrl, event.id)
                    : event.id;
                if (processedEventIds.has(eventKey)) {
                    continue;
                }
                processedEventIds.add(eventKey);
                uniqueRemoteEvents.push(event);
            }

            uniqueRemoteEvents.sort((left, right) => {
                const startDelta = left.startDate.getTime() - right.startDate.getTime();
                if (startDelta !== 0) return startDelta;
                const titleDelta = left.title.localeCompare(right.title);
                if (titleDelta !== 0) return titleDelta;
                return left.id.localeCompare(right.id);
            });
            logger.log(`[AutoCreateService] Processing ${uniqueRemoteEvents.length} event(s) sequentially.`);

            const matchedFilePaths = new Set<string>();
            for (let index = 0; index < uniqueRemoteEvents.length; index++) {
                const event = uniqueRemoteEvents[index];
                try {
                    logger.log(`[AutoCreateService] Event ${index + 1}/${uniqueRemoteEvents.length}: ${event.title}`);
                    const normalizedEventSourceUrl = this.normalizeSourceUrl(event.sourceUrl);
                    const result = await this.processEvent(
                        event,
                        byEventId,
                        calendarConfigs[normalizedEventSourceUrl || ""] || calendarConfigs[event.sourceUrl || ""] || null,
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
                                storedStart: formatDateTimeForFrontmatter(event.startDate),
                                storedEnd: this.config.useEndDuration
                                    ? Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60000)
                                    : formatDateTimeForFrontmatter(event.endDate),
                                storedTitle: (event.title || "").trim(),
                                storedLocation: (event.location || "").trim(),
                                startDate: event.startDate,
                                orphanCandidateAt: null,
                                isArchived: false,
                            };
                            if (!byEventId.has(event.id)) {
                                byEventId.set(event.id, note);
                            }
                        }
                    }
                } catch (error) {
                    logger.error(`[AutoCreateService] Error processing event "${event.title}"`, error);
                } finally {
                    await this.pauseBetweenEvents();
                }
            }

            const taskListDeleteResult = await this.cleanupTaskListOrphans(successfulUrls, failedUrls, rangeStart, rangeEnd);
            deleted += taskListDeleteResult.deleted;
            updated += taskListDeleteResult.updated;
            created += taskListDeleteResult.created;
            await this.flushTaskListStates();

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
                    this.orphanMissCount.delete(note.file.path);
                    if (note.orphanCandidateAt) {
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

                const noteDate = note.startDate;
                if (!noteDate || noteDate < rangeStart || noteDate > rangeEnd) continue;

                currentOrphanPaths.add(note.file.path);
                const prevMiss = this.readMissCountFromFrontmatter(note);
                const missCount = prevMiss + 1;
                this.orphanMissCount.set(note.file.path, missCount);

                const hasProtectedBodyContent = await this.hasProtectedBodyContent(note.file);
                const graceCycles = this.config.orphanArchiveGraceCycles;
                if (hasProtectedBodyContent) {
                    logger.warn(`[AutoCreateService] Orphan candidate retained because note has body content: ${note.file.path}`);
                    await this.markOrphanCandidate(note, missCount, "protected-body-content");
                    quarantined++;
                    continue;
                }

                if (graceCycles > 0 && missCount < graceCycles) {
                    logger.warn(`[AutoCreateService] Orphan candidate (miss ${missCount}/${graceCycles}): ${note.file.path}`);
                    await this.markOrphanCandidate(note, missCount);
                    quarantined++;
                } else if (graceCycles > 0 && missCount >= graceCycles) {
                    logger.warn(`[AutoCreateService] Orphan confirmed after ${missCount} misses, archiving: ${note.file.path}`);
                    if (await this.archiveFile(note.file)) {
                        deleted++;
                        this.recordOrphanDeletion(note.eventId);
                    } else {
                        await this.markOrphanCandidate(note, missCount);
                        quarantined++;
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

            const summary = [
                `${created} created`,
                `${updated} updated`,
                `${deleted} archived/deleted`,
            ];
            if (quarantined > 0) summary.push(`${quarantined} quarantined`);
            if (restored > 0) summary.push(`${restored} restored`);
            logger.log(`[AutoCreateService] Sync complete: ${summary.join(', ')} (${remoteEvents.length} remote events processed)`);
            if (created + updated + deleted + quarantined + restored > 0) {
                new Notice(`Calendar Sync: ${summary.join(", ")}`);
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
        allNotes: VaultNote[];
    }> {
        const byEventId = new Map<string, VaultNote>();
        const allNotes: VaultNote[] = [];

        const files = await this.getScopedMarkdownFiles();
        for (const file of files) {
            const isTrash = normalizePath(file.path).toLowerCase().startsWith(".trash");
            if (isTrash) continue;
            if (this.isArchivedNote(file)) continue;

            const normPath = normalizeComparablePath(file.path);
            const normBase = normalizeComparablePath(file.basename);

            const isGloballyIgnored = (this.config.globalIgnorePaths || []).some(
                p => matchesExclusionPattern(normPath, normBase, p)
            );
            if (isGloballyIgnored) continue;

            const fm = await this.getFrontmatterForFile(file);
            if (!fm) continue;

            const eventId = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.eventIdKey));
            if (!eventId) continue;

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
            const orphanCandidateAt = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.orphanCandidateAtKey));

            // Parse start date deterministically for orphan handling only.
            let startDate: Date | null = null;
            if (storedStart) {
                startDate = parseFrontmatterDate(storedStart);
            }

            const note: VaultNote = {
                file,
                eventId,
                storedStart,
                storedEnd,
                storedTitle,
                storedLocation,
                startDate,
                orphanCandidateAt,
                isArchived: this.isArchivedNote(file),
            };

            allNotes.push(note);

            if (eventId) {
                if (!byEventId.has(eventId)) {
                    byEventId.set(eventId, note);
                }
            }
        }

        return { byEventId, allNotes };
    }

    private getConfiguredScanRoots(): string[] {
        const roots = new Set<string>();
        for (const rawRoot of this.config.scanRootFolders || []) {
            if (typeof rawRoot !== "string") continue;
            const normalized = normalizePath(rawRoot).replace(/^\/+|\/+$/g, "").trim();
            if (!normalized || normalized === "." || normalized === "/") continue;
            roots.add(normalized);
        }
        return Array.from(roots);
    }

    public async countTaskListEntriesForCalendar(taskListPath: string, calendarUrl: string): Promise<number> {
        const normalizedPath = normalizePath(String(taskListPath || "").trim());
        const normalizedSource = this.normalizeSourceUrl(calendarUrl);
        if (!normalizedPath || !normalizedSource) return 0;

        const file = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (!(file instanceof TFile)) return 0;

        const content = await this.app.vault.cachedRead(file);
        const lines = content.split(/\r?\n/);
        let count = 0;
        for (let i = 0; i < lines.length; i++) {
            const parsed = this.parseTaskListLine(lines[i], i);
            if (!parsed) continue;
            if (this.normalizeSourceUrl(parsed.sourceUrl) === normalizedSource) {
                count += 1;
            }
        }
        return count;
    }

    public async migrateTaskListCalendarPath(calendarUrl: string, oldPath: string, newPath: string): Promise<number> {
        const normalizedSource = this.normalizeSourceUrl(calendarUrl);
        const normalizedOldPath = normalizePath(String(oldPath || "").trim());
        const normalizedNewPath = normalizePath(String(newPath || "").trim());
        if (!normalizedSource || !normalizedOldPath || !normalizedNewPath || normalizedOldPath === normalizedNewPath) {
            return 0;
        }

        const oldFile = this.app.vault.getAbstractFileByPath(normalizedOldPath);
        if (!(oldFile instanceof TFile)) {
            return 0;
        }

        const oldContent = await this.app.vault.cachedRead(oldFile);
        const oldLines = oldContent.split(/\r?\n/);
        const movedRows: TaskListItemRecord[] = [];
        const keptOldLines: string[] = [];
        for (let i = 0; i < oldLines.length; i++) {
            const parsed = this.parseTaskListLine(oldLines[i], i);
            if (parsed && this.normalizeSourceUrl(parsed.sourceUrl) === normalizedSource) {
                movedRows.push(parsed);
                continue;
            }
            keptOldLines.push(oldLines[i]);
        }

        if (movedRows.length === 0) {
            return 0;
        }

        const destinationState = await this.ensureTaskListState(normalizedNewPath, null, null);
        if (!destinationState) {
            return 0;
        }

        const destinationContent = await this.app.vault.cachedRead(destinationState.file);
        const destinationLines = destinationContent.split(/\r?\n/);
        const movedEventIds = new Set(movedRows.map((row) => row.eventId));

        const filteredDestinationLines: string[] = [];
        for (let i = 0; i < destinationLines.length; i++) {
            const parsed = this.parseTaskListLine(destinationLines[i], i);
            if (parsed && this.normalizeSourceUrl(parsed.sourceUrl) === normalizedSource) {
                if (movedEventIds.has(parsed.eventId)) {
                    continue;
                }
            }
            filteredDestinationLines.push(destinationLines[i]);
        }

        destinationState.lines = filteredDestinationLines;
        const appendIndex = this.getTaskListInsertIndex(destinationState);
        filteredDestinationLines.splice(appendIndex, 0, ...movedRows.map((row) => row.line));
        this.sortTaskListSection(destinationState);
        const normalizedDestinationContent = filteredDestinationLines.join("\n");
        await this.app.vault.modify(destinationState.file, normalizedDestinationContent);

        const normalizedOldContent = keptOldLines.join("\n");
        await this.app.vault.modify(oldFile, normalizedOldContent);
        this.taskListStateByPath.delete(normalizedOldPath);
        this.taskListStateByPath.delete(normalizedNewPath);

        return movedRows.length;
    }

    private async ensureTaskListState(taskListPath: string, heading: string | null | undefined, eventDate?: Date | null): Promise<TaskListState | null> {
        const normalizedPath = normalizePath(String(taskListPath || "").trim());
        if (!normalizedPath) return null;

        const cached = this.taskListStateByPath.get(normalizedPath);
        if (cached) return cached;

        const file = await this.ensureTaskListFile(normalizedPath, eventDate ?? null);
        if (!file) return null;

        const content = await this.app.vault.cachedRead(file);
        const state: TaskListState = {
            file,
            lines: content.split(/\r?\n/),
            heading: heading ? String(heading).trim() || null : null,
            itemsByEventId: new Map(),
            touchedEventIds: new Set(),
            changed: false,
        };
        this.rebuildTaskListIndex(state);
        this.taskListStateByPath.set(normalizedPath, state);
        return state;
    }

    private async ensureTaskListFile(path: string, eventDate: Date | null = null): Promise<TFile | null> {
        if (eventDate instanceof Date && !Number.isNaN(eventDate.getTime())) {
            const resolver = getDailyNoteResolver(this.app);
            const expectedDailyPath = normalizePath(resolver.buildPath(eventDate, "md"));
            if (normalizePath(path) === expectedDailyPath) {
                return await ensureDailyNoteFile(this.app, eventDate);
            }
        }

        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) return existing;
        if (!path.toLowerCase().endsWith(".md")) return null;

        const slashIndex = path.lastIndexOf("/");
        if (slashIndex > 0) {
            await this.ensureFolder(path.slice(0, slashIndex));
        }
        const initialContent = await this.buildTaskListFileInitialContent(path, eventDate);
        const file = await this.app.vault.create(path, initialContent);
        await this.runTemplaterOnFile(file);
        return file;
    }

    private async buildTaskListFileInitialContent(path: string, eventDate: Date | null): Promise<string> {
        const targetDate = eventDate instanceof Date && !Number.isNaN(eventDate.getTime()) ? eventDate : null;
        if (!targetDate) return "";

        const resolver = getDailyNoteResolver(this.app);
        const expectedDailyPath = normalizePath(resolver.buildPath(targetDate, "md"));
        if (normalizePath(path) !== expectedDailyPath) {
            return "";
        }

        const templatePath = String(resolver.template || "").trim();
        if (!templatePath) {
            return "";
        }

        const templateFile = resolveTemplateFile(this.app, templatePath, {
            allowBasenameMatchInTemplaterRoot: true,
            warnOnAmbiguousBasename: true,
        });
        if (!(templateFile instanceof TFile)) {
            return "";
        }

        try {
            const raw = await this.app.vault.read(templateFile);
            const basename = path.replace(/^.*\//, '').replace(/\.md$/i, '');
            const folderPath = path.includes('/') ? path.replace(/\/[^/]+$/, '') : '';
            const vars = buildTemplateVars(null, {
                title: basename,
                date: `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`,
                time: '00:00:00',
                datetime: new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0).toISOString(),
                timestamp: String(new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0).getTime()),
                file_name: `${basename}.md`,
                file_basename: basename,
                file_path: path,
                file_folder: folderPath,
            });
            return applyTemplateVars(raw, vars);
        } catch (error) {
            logger.warn('[AutoCreateService] Failed building daily-note task-list template content', { path, template: templateFile.path, error });
            return '';
        }
    }

    private async runTemplaterOnFile(file: TFile): Promise<void> {
        const templater = (this.app as any)?.plugins?.getPlugin?.('templater-obsidian');
        if (!templater?.templater) return;
        try {
            await templater.templater.overwrite_file_commands(file, false);
        } catch (error) {
            logger.warn('[AutoCreateService] Templater failed during task-list daily note create', { file: file.path, error });
        }
    }

    private rebuildTaskListIndex(state: TaskListState): void {
        state.itemsByEventId.clear();
        for (let lineNumber = 0; lineNumber < state.lines.length; lineNumber++) {
            const parsed = this.parseTaskListLine(state.lines[lineNumber], lineNumber);
            if (parsed && !state.itemsByEventId.has(parsed.eventId)) {
                state.itemsByEventId.set(parsed.eventId, parsed);
            }
        }
    }

    private parseTaskListLine(line: string, lineNumber: number): TaskListItemRecord | null {
        const checkboxMatch = line.match(/^\s*-\s+\[([^\]]*)\]\s+(.*)$/);
        if (!checkboxMatch) return null;
        const body = checkboxMatch[2] || "";
        const eventId = this.extractInlineFieldValue(body, this.config.eventIdKey);
        if (!eventId) return null;

        const sourceUrl = this.normalizeSourceUrl(this.extractInlineFieldValue(body, this.config.sourceUrlKey));
        const scheduledValue = this.extractInlineFieldValue(body, this.config.startProperty);
        const inlineProperties: Record<string, string> = {};
        for (const match of body.matchAll(/\[([a-zA-Z0-9_-]+)::\s*([^\]]+)\]/g)) {
            const key = String(match[1] || "").trim().toLowerCase();
            const value = String(match[2] || "").trim();
            if (!key || !value) continue;
            inlineProperties[key] = value;
        }
        return {
            eventId,
            sourceUrl,
            scheduledValue,
            title: this.stripInlineFields(body),
            lineNumber,
            line,
            checkboxState: String(checkboxMatch[1] || ""),
            isCompleted: /^[xX-]$/.test(checkboxMatch[1] || ""),
            inlineProperties,
        };
    }

    private extractInlineFieldValue(text: string, key: string): string | null {
        const semanticsApi = this.getGcmItemSemanticsApi();
        if (semanticsApi?.extractInlineProperty) {
            return semanticsApi.extractInlineProperty(text, key);
        }
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = text.match(new RegExp(`\\[${escaped}::\\s*([^\\]]+)\\]`, "i"));
        return match?.[1] ? String(match[1]).trim() : null;
    }

    private stripInlineFields(text: string): string {
        const semanticsApi = this.getGcmItemSemanticsApi();
        if (semanticsApi?.stripInlineProperties) {
            return semanticsApi.stripInlineProperties(text);
        }
        return text.replace(/\s*\[[a-zA-Z0-9_-]+::\s*[^\]]+\]/g, "").trim();
    }

    private touchTaskListItem(
        state: TaskListState,
        eventId: string,
    ): void {
        state.touchedEventIds.add(eventId);
    }

    private emitTaskLineUpdated(file: TFile, lineNumber: number | null): void {
        (this.app.workspace as any)?.trigger?.("tps-task-line-updated", {
            path: file.path,
            lineNumber,
        });
    }

    private formatTaskListScheduledValue(date: Date, isAllDay: boolean): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        if (isAllDay) {
            return `${year}-${month}-${day}`;
        }
        const hour = String(date.getHours()).padStart(2, "0");
        const minute = String(date.getMinutes()).padStart(2, "0");
        return `${year}-${month}-${day} ${hour}:${minute}`;
    }

    private buildTaskListLine(
        event: ExternalCalendarEvent,
        checkboxState: string = " ",
        existingInlineProperties: Record<string, string> = {},
    ): string {
        const normalizedCheckboxState = String(checkboxState || "").trim();
        const checkbox = normalizedCheckboxState.length > 0 ? normalizedCheckboxState : " ";
        const sourceUrl = this.normalizeSourceUrl(event.sourceUrl) || "";
        const durationMinutes = Math.max(5, Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60000));
        const reservedKeys = new Set([
            this.config.eventIdKey.toLowerCase(),
            this.config.uidKey.toLowerCase(),
            this.config.sourceUrlKey.toLowerCase(),
            this.config.startProperty.toLowerCase(),
            this.config.endProperty.toLowerCase(),
        ]);
        const passthroughProperties = Object.entries(existingInlineProperties || {})
            .filter(([key, value]) => !!String(key || "").trim() && !!String(value || "").trim())
            .filter(([key]) => !reservedKeys.has(String(key || "").trim().toLowerCase()))
            .map(([key, value]) => `[${key}:: ${String(value).trim()}]`);
        return [
            `- [${checkbox}] ${event.title.trim()}`,
            `[${this.config.eventIdKey}:: ${event.id}]`,
            `[${this.config.uidKey}:: ${event.uid || event.id}]`,
            `[${this.config.sourceUrlKey}:: ${sourceUrl}]`,
            `[${this.config.startProperty}:: ${this.formatTaskListScheduledValue(event.startDate, event.isAllDay)}]`,
            `[${this.config.endProperty}:: ${durationMinutes}]`,
            ...passthroughProperties,
        ].join(" ");
    }

    private getTaskListInsertIndex(state: TaskListState): number {
        if (!state.heading) return state.lines.length;

        const normalizedHeading = state.heading.trim().toLowerCase();
        for (let index = 0; index < state.lines.length; index++) {
            const line = state.lines[index].trim();
            if (!line.startsWith("#")) continue;
            const headingText = line.replace(/^#+\s*/, "").trim().toLowerCase();
            if (headingText !== normalizedHeading) continue;

            let insertAt = index + 1;
            while (insertAt < state.lines.length && !state.lines[insertAt].trim().startsWith("#")) {
                insertAt++;
            }
            return insertAt;
        }

        if (state.lines.length > 0 && state.lines[state.lines.length - 1].trim() !== "") {
            state.lines.push("");
        }
        state.lines.push(`## ${state.heading}`);
        state.lines.push("");
        state.changed = true;
        return state.lines.length;
    }

    private removeTaskListLine(state: TaskListState, lineNumber: number): void {
        if (lineNumber < 0 || lineNumber >= state.lines.length) return;
        state.lines.splice(lineNumber, 1);
        state.changed = true;
        this.rebuildTaskListIndex(state);
    }

    private async cleanupTaskListOrphans(
        successfulUrls: Set<string>,
        failedUrls: Set<string>,
        rangeStart: Date,
        rangeEnd: Date,
    ): Promise<{ created: number; updated: number; deleted: number }> {
        if (this.config.orphanArchiveGraceCycles <= 0) {
            return { created: 0, updated: 0, deleted: 0 };
        }

        let deleted = 0;
        for (const state of this.taskListStateByPath.values()) {
            const uniqueItems = new Map<number, TaskListItemRecord>();
            for (const item of state.itemsByEventId.values()) {
                if (!uniqueItems.has(item.lineNumber)) {
                    uniqueItems.set(item.lineNumber, item);
                }
            }

            const items = Array.from(uniqueItems.values())
                .filter((item) => !!item.sourceUrl)
                .filter((item) => !state.touchedEventIds.has(item.eventId))
                .filter((item) => successfulUrls.has(item.sourceUrl!))
                .filter((item) => !failedUrls.has(item.sourceUrl!))
                .filter((item) => {
                    const scheduledDate = item.scheduledValue ? parseFrontmatterDate(item.scheduledValue) : null;
                    if (!scheduledDate) return false;
                    return scheduledDate >= rangeStart && scheduledDate <= rangeEnd;
                })
                .sort((a, b) => b.lineNumber - a.lineNumber);

            for (const item of items) {
                this.removeTaskListLine(state, item.lineNumber);
                deleted++;
            }
        }

        return { created: 0, updated: 0, deleted };
    }

    private async flushTaskListStates(): Promise<void> {
        for (const state of this.taskListStateByPath.values()) {
            const resorted = this.sortTaskListSection(state);
            if (!state.changed && !resorted) continue;

            const desiredContent = state.lines.join("\n");
            const editor = this.getEditorForFile(state.file);
            if (editor) {
                if (typeof editor.setValue === "function") {
                    editor.setValue(desiredContent);
                }
            }
            await this.app.vault.modify(state.file, desiredContent);
            state.changed = false;
        }
    }

    private getEditorForFile(file: TFile): any | null {
        const leaves = (this.app as any).workspace?.getLeavesOfType?.('markdown');
        if (!Array.isArray(leaves)) return null;
        for (const leaf of leaves) {
            const view = leaf?.view;
            if (view?.file?.path === file.path && view?.editor) {
                return view.editor;
            }
        }
        return null;
    }

    private sortTaskListSection(state: TaskListState): boolean {
        const sectionRange = this.getHeadingSectionRange(state);
        if (!sectionRange) return false;

        const [sectionStart, sectionEnd] = sectionRange;
        const taskIndices: number[] = [];
        for (let i = sectionStart; i < sectionEnd; i++) {
            const parsed = this.parseTaskListLine(state.lines[i], i);
            if (parsed) taskIndices.push(i);
        }
        if (taskIndices.length < 2) return false;

        const parsedMap = new Map<number, TaskListItemRecord>();
        for (const idx of taskIndices) {
            const parsed = this.parseTaskListLine(state.lines[idx], idx);
            if (parsed) parsedMap.set(idx, parsed);
        }

        const originalLines = taskIndices.map(i => state.lines[i]);
        taskIndices.sort((a, b) => {
            const itemA = parsedMap.get(a)!;
            const itemB = parsedMap.get(b)!;

            const dateA = this.parseScheduledDate(itemA.scheduledValue);
            const dateB = this.parseScheduledDate(itemB.scheduledValue);
            if (dateA !== null && dateB !== null) {
                const dateDelta = dateA.getTime() - dateB.getTime();
                if (dateDelta !== 0) return dateDelta;
            } else if (dateA !== null) {
                return -1;
            } else if (dateB !== null) {
                return 1;
            }

            const aDone = itemA.isCompleted ? 1 : 0;
            const bDone = itemB.isCompleted ? 1 : 0;
            if (aDone !== bDone) return aDone - bDone;

            return itemA.title.localeCompare(itemB.title);
        });

        const sortedLines = taskIndices.map(i => state.lines[i]);
        const reordered = sortedLines.some((line, idx) => line !== originalLines[idx]);
        if (!reordered) {
            return false;
        }

        let writeIdx = 0;
        for (const origIdx of taskIndices) {
            state.lines[origIdx] = sortedLines[writeIdx++];
        }
        this.rebuildTaskListIndex(state);
        state.changed = true;
        return true;
    }

    private getHeadingSectionRange(state: TaskListState): [number, number] | null {
        if (!state.heading) {
            const hasTasks = state.lines.some(l => this.parseTaskListLine(l, 0));
            return hasTasks ? [0, state.lines.length] : null;
        }

        const normalizedHeading = state.heading.trim().toLowerCase();
        let headingLine = -1;
        for (let i = 0; i < state.lines.length; i++) {
            const line = state.lines[i].trim();
            if (!line.startsWith("#")) continue;
            const text = line.replace(/^#+\s*/, "").trim().toLowerCase();
            if (text === normalizedHeading) { headingLine = i; break; }
        }
        if (headingLine === -1) return null;

        let end = headingLine + 1;
        while (end < state.lines.length && !state.lines[end].trim().startsWith("#")) {
            end++;
        }
        return end > headingLine + 1 ? [headingLine + 1, end] : null;
    }

    private parseScheduledDate(value: string | null): Date | null {
        if (!value) return null;
        const m = (window as any).moment;
        if (!m) return null;
        const parsed = m(value, ["YYYY-MM-DD HH:mm", "YYYY-MM-DD"], true);
        return parsed.isValid() ? parsed.toDate() : null;
    }

    private async getScopedMarkdownFiles(): Promise<TFile[]> {
        const roots = this.getConfiguredScanRoots();
        if (!roots.length) return [];

        const filesByPath = new Map<string, TFile>();
        for (const root of roots) {
            await this.collectMarkdownFilesUnder(root, filesByPath);
        }
        return Array.from(filesByPath.values());
    }

    private async collectMarkdownFilesUnder(
        root: string,
        target: Map<string, TFile>
    ): Promise<void> {
        const stack: string[] = [root];
        const visitedFolders = new Set<string>();

        while (stack.length > 0) {
            const current = stack.pop();
            if (!current) continue;

            const normalizedCurrent = normalizePath(current);
            if (visitedFolders.has(normalizedCurrent)) continue;
            visitedFolders.add(normalizedCurrent);

            let listing: { files: string[]; folders: string[] } | null = null;
            try {
                listing = await this.app.vault.adapter.list(normalizedCurrent);
            } catch {
                continue;
            }
            if (!listing) continue;

            for (const folderPath of listing.folders || []) {
                const normalizedFolder = normalizePath(folderPath).replace(/^\/+|\/+$/g, "").trim();
                if (!normalizedFolder) continue;
                stack.push(normalizedFolder);
            }

            for (const filePath of listing.files || []) {
                const normalizedFilePath = normalizePath(filePath);
                if (!normalizedFilePath.toLowerCase().endsWith(".md")) continue;

                const file = this.app.vault.getAbstractFileByPath(normalizedFilePath);
                if (file instanceof TFile) {
                    target.set(file.path, file);
                }
            }
        }
    }

    // ========================================================================
    // Process a single event
    // ========================================================================

    private async processEvent(
        event: ExternalCalendarEvent,
        byEventId: Map<string, VaultNote>,
        calendarInfo: CalendarAutoCreateConfig | null,
        filterTerms: string[],
        forceRegenerate: boolean
    ): Promise<{ action: 'created' | 'updated' | 'deleted' | 'none', file?: TFile }> {
        const comparison = this.buildEventComparison(event);
        const vaultMatch = byEventId.get(event.id) || null;

        // If a promoted note owns this event, treat it as note-mode regardless
        // of calendar config so it continues receiving sync updates.
        if (!vaultMatch && (calendarInfo?.mode || "note") === "task-list") {
            return this.processEventAsTaskList(event, calendarInfo, filterTerms);
        }

        // 2. Existing note found — check for changes
        if (vaultMatch) {
            if (vaultMatch.isArchived) {
                return { action: 'none', file: vaultMatch.file };
            }

            if (event.isCancelled) {
                logger.log(`[AutoCreateService] Event CANCELLED: ${event.title}`);
                const marked = await this.markCancelledWithoutDelete(vaultMatch.file);
                return { action: marked ? 'updated' : 'none', file: vaultMatch.file };
            }

            const legacyIdentityStripped = await this.stripLegacyIdentityFields(vaultMatch.file);

            // Compare stored values against remote event — string equality, no Date parsing
            const startChanged = vaultMatch.storedStart !== comparison.expectedStart;
            const endChanged = vaultMatch.storedEnd !== comparison.expectedEnd;
            const titleChanged = vaultMatch.storedTitle !== comparison.normalizedTitle;
            const locationChanged = vaultMatch.storedLocation !== comparison.normalizedLocation;

            // Fast path: nothing changed and no identity repair needed — skip entirely, no file I/O
            if (!startChanged && !endChanged && !titleChanged && !locationChanged && !forceRegenerate && !legacyIdentityStripped) {
                return { action: 'none', file: vaultMatch.file };
            }

            const didUpdate = await this.updateExistingEventViaCanonicalWriter(vaultMatch.file, event, comparison);

            if (didUpdate) {
                await this.renameEventNoteIfNeeded(vaultMatch.file, event, calendarInfo);
                logger.log(`[AutoCreateService] Updated: ${vaultMatch.file.path}`);
                vaultMatch.storedStart = comparison.expectedStart;
                vaultMatch.storedEnd = comparison.expectedEnd;
                if (titleChanged) vaultMatch.storedTitle = comparison.normalizedTitle;
                if (locationChanged) vaultMatch.storedLocation = comparison.normalizedLocation;
                this.orphanDeletionTombstones.delete(event.id);
            }
            return { action: didUpdate ? 'updated' : 'none', file: vaultMatch.file };
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
        // Match by eventId only.
        const archivedMatch = byEventId.get(event.id);
        if (archivedMatch?.isArchived) {
            logger.log(`[AutoCreateService] Skipping creation (archived version exists): ${archivedMatch.file.path}`);
            return { action: 'none' };
        }

        const resolvedFolder = calendarInfo?.folder || calendarInfo?.typeFolder || "";

        // Hard protection: never auto-create at vault root or inside any _ folder.
        const folderSegments = resolvedFolder.split('/').filter(Boolean);
        if (!resolvedFolder || folderSegments.some(seg => seg.startsWith('_'))) {
            logger.warn(`[AutoCreateService] Refusing to create in protected path "${resolvedFolder || '(vault root)'}" for: ${event.title}`);
            return { action: 'none' };
        }

        const resolvedTemplate = calendarInfo?.template || null;

        const createResult = await this.createOrReuseMeetingNote(
            event,
            resolvedTemplate,
            resolvedFolder,
            calendarInfo?.tag || null,
        );

        if (!createResult.file) {
            return { action: 'none' };
        }

        if (createResult.reusedExisting) {
            logger.log(`[AutoCreateService] Reused existing note for: ${event.title} -> ${createResult.file.path}`);
        } else {
            logger.log(`[AutoCreateService] Creating new note for: ${event.title}`);
        }

        return { action: createResult.reusedExisting ? 'none' : 'created', file: createResult.file };
    }

    private async updateExistingEventViaCanonicalWriter(
        file: TFile,
        event: ExternalCalendarEvent,
        comparison: EventComparison,
    ): Promise<boolean> {
        const gcmApi = (this.app as any)?.plugins?.getPlugin?.('tps-global-context-menu')?.api;
        const extraUpdates: Record<string, unknown> = {
            [this.config.titleKey]: comparison.normalizedTitle,
            location: comparison.normalizedLocation,
        };

        if (!gcmApi?.applyCalendarEventMutation) {
            throw new Error('TPS Global Context Menu API unavailable for controller event mutation');
        }
        await gcmApi.applyCalendarEventMutation({
            file,
            start: comparison.expectedStart,
            end: typeof comparison.expectedEnd === 'number'
                ? formatDateTimeForFrontmatter(event.endDate)
                : String(comparison.expectedEnd || ''),
            allDay: event.isAllDay,
            folderPath: file.parent?.path || '/',
            updates: extraUpdates,
            eventFields: {
                dateField: this.config.scheduledDateProperty || null,
                startField: this.config.scheduledStartProperty || this.config.startProperty,
                endField: this.config.scheduledEndProperty || this.config.endProperty,
                allDayField: "allDay",
                useEndDuration: this.config.useEndDuration,
            },
        });
        return true;
    }

    private async createOrReuseMeetingNote(
        event: ExternalCalendarEvent,
        resolvedTemplate: string | null,
        resolvedFolder: string,
        calendarTag: string | null,
    ): Promise<NoteCreateResult> {
        const createResult = await createMeetingNoteFromExternalEvent(
            this.app,
            event,
            resolvedTemplate,
            resolvedFolder,
            this.config.startProperty,
            this.config.endProperty,
            this.config.scheduledDateProperty,
            this.config.scheduledStartProperty,
            this.config.scheduledEndProperty,
            this.config.useEndDuration,
            calendarTag,
            undefined,
            undefined,
            undefined,
            {
                eventIdKey: this.config.eventIdKey,
                titleKey: this.config.titleKey,
                scheduledDateProperty: this.config.scheduledDateProperty,
                scheduledStartProperty: this.config.scheduledStartProperty,
                scheduledEndProperty: this.config.scheduledEndProperty,
            }
        );
        return {
            file: createResult.file,
            reusedExisting: createResult.reusedExisting,
        };
    }

    private async renameEventNoteIfNeeded(
        file: TFile,
        event: ExternalCalendarEvent,
        calendarInfo: CalendarAutoCreateConfig | null,
    ): Promise<void> {
        const resolvedFolder = normalizePath(calendarInfo?.folder || calendarInfo?.typeFolder || file.parent?.path || "");
        if (!resolvedFolder) return;

        const desiredBasename = buildExternalEventNoteBasename(this.app, event);
        if (!desiredBasename || file.basename === desiredBasename) return;

        const desiredPath = normalizePath(`${resolvedFolder}/${desiredBasename}.${file.extension}`);
        if (normalizePath(file.path) === desiredPath) return;

        const existingAtPath = this.app.vault.getAbstractFileByPath(desiredPath);
        if (existingAtPath && existingAtPath !== file) {
            logger.warn(`[AutoCreateService] Skipping rename; target already exists: ${desiredPath}`);
            return;
        }

        try {
            await this.app.vault.rename(file, desiredPath);
            logger.log(`[AutoCreateService] Renamed event note: ${file.path} -> ${desiredPath}`);
        } catch (error) {
            logger.warn(`[AutoCreateService] Failed renaming event note to ${desiredPath}`, error);
        }
    }

    private async processEventAsTaskList(
        event: ExternalCalendarEvent,
        calendarInfo: CalendarAutoCreateConfig | null,
        filterTerms: string[],
    ): Promise<{ action: 'created' | 'updated' | 'deleted' | 'none', file?: TFile }> {
        const taskListPath = this.resolveTaskListTargetPath(event, calendarInfo);
        if (!taskListPath) {
            logger.warn("[AutoCreateService] Task-list mode requires a target markdown file.", { event: event.title });
            return { action: "none" };
        }

        const state = await this.ensureTaskListState(taskListPath, calendarInfo?.taskListHeading || null, event.startDate);
        if (!state) return { action: "none" };

        const existing = state.itemsByEventId.get(event.id) || null;
        if (existing) {
            this.touchTaskListItem(state, event.id);
        }

        if (event.isCancelled) {
            if (!existing) return { action: "none", file: state.file };
            this.touchTaskListItem(state, event.id);
            const graceCycles = this.config.orphanArchiveGraceCycles;
            if (graceCycles <= 0) return { action: "none", file: state.file };
            this.removeTaskListLine(state, existing.lineNumber);
            this.emitTaskLineUpdated(state.file, existing.lineNumber);
            return { action: "deleted", file: state.file };
        }

        if (calendarInfo?.autoCreateEnabled === false) {
            if (existing) this.touchTaskListItem(state, event.id);
            return { action: "none" };
        }

        if (filterTerms.some((t) => event.title.toLowerCase().includes(t))) {
            if (existing) this.touchTaskListItem(state, event.id);
            return { action: "none" };
        }

        const desiredLine = this.buildTaskListLine(event, existing?.checkboxState || " ", existing?.inlineProperties || {});
        if (existing) {
            this.touchTaskListItem(state, event.id);
            if (existing.line === desiredLine) {
                return { action: "none", file: state.file };
            }
            state.lines[existing.lineNumber] = desiredLine;
            state.changed = true;
            this.rebuildTaskListIndex(state);
            this.touchTaskListItem(state, event.id);
            this.emitTaskLineUpdated(state.file, existing.lineNumber);
            return { action: "updated", file: state.file };
        }

        const insertAt = this.getTaskListInsertIndex(state);

        state.lines.splice(insertAt, 0, desiredLine);
        state.changed = true;
        this.rebuildTaskListIndex(state);
        this.touchTaskListItem(state, event.id);
        this.emitTaskLineUpdated(state.file, insertAt);
        return { action: "created", file: state.file };
    }

    private resolveTaskListTargetPath(event: ExternalCalendarEvent, calendarInfo: CalendarAutoCreateConfig | null): string {
        const explicitPath = String(calendarInfo?.taskListPath || "").trim();
        if (explicitPath) return explicitPath;

        const resolver = getDailyNoteResolver(this.app);
        const dailyPath = resolver.buildPath(event.startDate, "md");
        return String(dailyPath || "").trim();
    }

    // ========================================================================
    // Helpers
    // ========================================================================

    private async markCancelledWithoutDelete(file: TFile): Promise<boolean> {
        const cancelledStatus = this.normalizeIdentityValue(this.config.canceledStatusValue) || "cancelled";
        const cancelledAt = new Date().toISOString();
        const fm = await this.getFrontmatterForFile(file);
        const currentStatus = this.normalizeIdentityValue(this.findKeyInsensitive(fm || {}, this.config.statusKey));
        const previousStatus = this.normalizeIdentityValue(this.findKeyInsensitive(fm || {}, this.config.previousStatusKey));
        const existingCancelledAt = this.normalizeIdentityValue(this.findKeyInsensitive(fm || {}, this.config.cancelledAtKey));
        const updates: Record<string, unknown> = {
            [this.config.statusKey]: cancelledStatus,
        };
        if (currentStatus && currentStatus.toLowerCase() !== cancelledStatus.toLowerCase() && !previousStatus) {
            updates[this.config.previousStatusKey] = currentStatus;
        }
        if (!existingCancelledAt) {
            updates[this.config.cancelledAtKey] = cancelledAt;
        }
        return await this.applyCanonicalFrontmatterMutation(file, updates, [
            this.config.orphanCandidateAtKey,
            this.config.orphanMissCountKey,
            this.config.orphanReasonKey,
        ]);
    }

    private async markOrphanCandidate(note: VaultNote, missCount: number, orphanReason: string = "missing-from-source"): Promise<boolean> {
        const now = new Date().toISOString();
        const fm = await this.getFrontmatterForFile(note.file);
        const currentAt = this.normalizeIdentityValue(this.findKeyInsensitive(fm || {}, this.config.orphanCandidateAtKey));
        const currentMiss = this.findKeyInsensitive(fm || {}, this.config.orphanMissCountKey);
        const currentReason = this.normalizeIdentityValue(this.findKeyInsensitive(fm || {}, this.config.orphanReasonKey));
        const updates: Record<string, unknown> = {};
        if (!currentAt) {
            updates[this.config.orphanCandidateAtKey] = now;
        }
        if (Number(currentMiss) !== missCount) {
            updates[this.config.orphanMissCountKey] = missCount;
        }
        if (currentReason !== orphanReason) {
            updates[this.config.orphanReasonKey] = orphanReason;
        }
        const didUpdate = await this.applyCanonicalFrontmatterMutation(note.file, updates, []);

        if (didUpdate) {
            logger.warn(`[AutoCreateService] Quarantined orphan candidate: ${note.file.path}`);
        }

        return didUpdate;
    }

    private async clearOrphanCandidate(file: TFile): Promise<boolean> {
        return await this.applyCanonicalFrontmatterMutation(file, {}, [
            this.config.orphanCandidateAtKey,
            this.config.orphanMissCountKey,
            this.config.orphanReasonKey,
        ]);
    }

    private async applyCanonicalFrontmatterMutation(
        file: TFile,
        updates: Record<string, unknown>,
        deletes: string[],
        userInitiated: boolean = false,
    ): Promise<boolean> {
        const gcmApi = (this.app as any)?.plugins?.getPlugin?.('tps-global-context-menu')?.api;
        if (!gcmApi?.applyCalendarFrontmatterMutation) {
            throw new Error('TPS Global Context Menu API unavailable for canonical frontmatter mutation');
        }
        return await gcmApi.applyCalendarFrontmatterMutation({
            file,
            updates,
            deletes,
            folderPath: file.parent?.path || '/',
            userInitiated,
        });
    }

    public async getOrphanCandidateFiles(): Promise<TFile[]> {
        const candidates: TFile[] = [];
        const files = await this.getScopedMarkdownFiles();
        for (const file of files) {
            const fm = await this.getFrontmatterForFile(file);
            if (!fm) continue;
            const candidateAt = this.normalizeIdentityValue(this.findKeyInsensitive(fm, this.config.orphanCandidateAtKey));
            if (candidateAt) candidates.push(file);
        }
        candidates.sort((a, b) => a.path.localeCompare(b.path));
        return candidates;
    }

    private readMissCountFromFrontmatter(note: VaultNote): number {
        const cache = this.app.metadataCache.getFileCache(note.file);
        const fm = cache?.frontmatter;
        if (!fm) return this.orphanMissCount.get(note.file.path) || 0;
        const key = this.config.orphanMissCountKey;
        const missKey = Object.keys(fm).find(k => k.toLowerCase() === key.toLowerCase());
        const missVal = missKey ? fm[missKey] : undefined;
        if (typeof missVal === 'number' && missVal > 0) return missVal;
        return this.orphanMissCount.get(note.file.path) || 0;
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
        await this.appendArchiveNoteEntry(file, newPath);
        return true;
    }

    private async appendArchiveNoteEntry(file: TFile, archivedPath: string): Promise<void> {
        const archiveNote = await this.ensureArchiveNote();
        if (!archiveNote) return;

        const archivedLinkPath = normalizePath(String(archivedPath || "").trim()).replace(/\.md$/i, "");
        const timestamp = new Date().toISOString();
        const entry = `- [[${archivedLinkPath}]] - ${file.basename} (${timestamp})`;
        const existing = await this.app.vault.cachedRead(archiveNote);
        const spacer = existing.trim().length > 0 && !existing.endsWith("\n\n") ? "\n" : "";
        const next = `${existing}${spacer}${entry}\n`;
        await this.app.vault.modify(archiveNote, next);
    }

    private async ensureArchiveNote(): Promise<TFile | null> {
        const notePath = normalizePath(String(this.config.archiveNotePath || "").trim());
        if (!notePath) return null;

        const existing = this.app.vault.getAbstractFileByPath(notePath);
        if (existing instanceof TFile) return existing;

        const slashIndex = notePath.lastIndexOf("/");
        if (slashIndex > 0) {
            await this.ensureFolder(notePath.slice(0, slashIndex));
        }

        const file = await this.app.vault.create(notePath, `# Archive\n\n`);
        return file;
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
        for (let attempt = 0; attempt < 5; attempt++) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache?.frontmatter) return cache.frontmatter;
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
        }

        try {
            const raw = await this.app.vault.cachedRead(file);
            const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (!fmMatch) return null;
            const fm: Record<string, any> = {};
            for (const line of fmMatch[1].split('\n')) {
                const sep = line.indexOf(':');
                if (sep <= 0) continue;
                const key = line.slice(0, sep).trim();
                let val: any = line.slice(sep + 1).trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                if (val === 'true') val = true;
                else if (val === 'false') val = false;
                else if (/^-?\d+$/.test(val)) val = parseInt(val, 10);
                fm[key] = val;
            }
            return Object.keys(fm).length > 0 ? fm : null;
        } catch {
            return null;
        }
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

    private buildEventComparison(event: ExternalCalendarEvent): EventComparison {
        return {
            normalizedTitle: String(event.title || "").replace(/\s+/g, " ").trim(),
            normalizedLocation: String(event.location || "").replace(/\s+/g, " ").trim(),
            expectedStart: formatDateTimeForFrontmatter(event.startDate),
            expectedEnd: this.config.useEndDuration
                ? Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60000)
                : formatDateTimeForFrontmatter(event.endDate),
        };
    }

    private buildSourceScopedKey(sourceUrl: string, identity: string): string {
        return `${sourceUrl}::${identity}`;
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
        void note;
        void configuredUrlSet;
        void successfulUrls;
        void failedUrls;
        return false;
    }

    private async hasProtectedBodyContent(file: TFile): Promise<boolean> {
        try {
            const content = await this.app.vault.cachedRead(file);
            const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, "");
            return body.trim().length > 0;
        } catch (error) {
            logger.warn(`[AutoCreateService] Failed to inspect body content for ${file.path}; treating as protected.`, error);
            return true;
        }
    }

    private async stripLegacyIdentityFields(file: TFile): Promise<boolean> {
        try {
            const fm = await this.getFrontmatterForFile(file);
            if (!fm) return false;

            const deletes: string[] = [];
            const uidKey = this.config.uidKey;
            if (uidKey && Object.keys(fm).some((key) => key.trim().toLowerCase() === uidKey.trim().toLowerCase())) {
                deletes.push(uidKey);
            }

            const sourceUrlKey = "tpsCalendarSourceUrl";
            if (Object.keys(fm).some((key) => key.trim().toLowerCase() === sourceUrlKey.toLowerCase())) {
                deletes.push(sourceUrlKey);
            }

            if (deletes.length === 0) return false;
            const deleted = await this.applyCanonicalFrontmatterMutation(file, {}, deletes);
            if (deleted) {
                logger.warn(`[AutoCreateService] Removed legacy identity fields from ${file.path}: ${deletes.join(", ")}`);
            }
            return deleted;
        } catch (error) {
            logger.warn(`[AutoCreateService] Failed to strip legacy identity fields from ${file.path}`, error);
            return false;
        }
    }

    private async pauseBetweenEvents(): Promise<void> {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 75));
    }
}
