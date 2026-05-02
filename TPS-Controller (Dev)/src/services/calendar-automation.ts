import { App, Notice } from "obsidian";
import { AutoCreateService } from "./auto-create-service";
import { ExternalCalendarService } from "./external-calendar-service";
import {
    getExternalCalendarConfigWarning,
    normalizeExternalCalendarScanRoot,
    resolveExternalCalendarNoteTargetFolder,
} from "./external-calendar-destination";
import type { TPSControllerSettings, ExternalCalendarConfig } from "../types";
import { normalizeCalendarUrl, normalizeCalendarTag } from "../utils";
import { getDailyNoteResolver } from "../utils/daily-note-resolver";
import * as logger from "../logger";

interface CalendarPluginAPI {
    getSettings?(): any;
}

/**
 * Manages the calendar sync interval loop, calendar event fetching,
 * and orphan/quarantine review. Holds its own interval ID.
 */
export class CalendarAutomationService {
    private calendarSyncIntervalId: number | null = null;
    private initialSyncRetryId: number | null = null;
    private initialSyncCompleted = false;

    constructor(
        private app: App,
        private autoCreateService: AutoCreateService,
        private externalCalendarService: ExternalCalendarService,
        private getSettings: () => TPSControllerSettings,
        private getCalendarPlugin: () => CalendarPluginAPI | null,
        private onSyncComplete: () => Promise<void>,
        private getSyncReadiness: () => { ready: boolean; reason: string }
    ) {}

    start(): void {
        this.stop();
        this.initialSyncCompleted = false;

        const settings = this.getSettings();
        const initialScanRoots = this.buildScanRoots(settings.externalCalendars || [], settings.archiveFolder);
        this.autoCreateService.updateConfig({
            allowAutoCreate: true,
            orphanArchiveGraceCycles: settings.orphanArchiveGraceCycles ?? 5,
            eventIdKey: settings.eventIdKey,
            uidKey: settings.uidKey,
            titleKey: settings.titleKey,
            statusKey: settings.statusKey,
            previousStatusKey: settings.previousStatusKey,
            startProperty: settings.startProperty,
            endProperty: settings.endProperty,
            archiveFolder: settings.archiveFolder,
            globalIgnorePaths: settings.globalIgnorePaths || [],
            canceledStatusValue: settings.canceledStatusValue,
            scanRootFolders: initialScanRoots,
            syncBackfillDays: settings.syncBackfillDays ?? 0,
        });

        // Defer the first sync until after the workspace and metadata cache are
        // ready. Calling runSync() during onload() means getFileCache() returns
        // null for almost every file, byEventId is empty, and the service tries
        // to create notes that already exist → "File already exists" errors.
        this.app.workspace.onLayoutReady(() => {
            void this.runSync();
        });

        const minutes = Math.max(1, settings.syncIntervalMinutes || 5);
        const intervalMs = minutes * 60 * 1000;
        logger.log(`📅 Calendar sync interval: ${minutes} min`);
        this.calendarSyncIntervalId = window.setInterval(() => {
            logger.log("⏲️ CALENDAR SYNC TICK");
            void this.runSync();
        }, intervalMs);
    }

    stop(): void {
        if (this.calendarSyncIntervalId !== null) {
            window.clearInterval(this.calendarSyncIntervalId);
            this.calendarSyncIntervalId = null;
        }
        if (this.initialSyncRetryId !== null) {
            window.clearTimeout(this.initialSyncRetryId);
            this.initialSyncRetryId = null;
        }
    }

    async runSync(force = false): Promise<void> {
        logger.log(`📅 RUN CALENDAR SYNC (force=${force})...`);
        if (!force && !this.initialSyncCompleted) {
            const readiness = this.getSyncReadiness();
            if (!readiness.ready) {
                logger.warn(`📅 Delaying initial calendar sync: ${readiness.reason}`);
                if (force) new Notice(`Calendar sync waiting: ${readiness.reason}`);
                this.scheduleInitialSyncRetry();
                return;
            }
        }

        const settings = this.getSettings();

        let calendars: ExternalCalendarConfig[] = settings.externalCalendars || [];

        if (!calendars.length) {
            const calPlugin = this.getCalendarPlugin();
            if (calPlugin) {
                const calSettings = calPlugin.getSettings?.();
                if (calSettings?.externalCalendars?.length) {
                    calendars = calSettings.externalCalendars;
                    logger.log(`📅 Using ${calendars.length} calendars from Calendar Plugin (fallback).`);
                }
            }
        }

        if (!calendars.length) {
            logger.log("⚠️ No external calendars configured, skipping sync.");
            if (force) new Notice("Calendar sync skipped: no external calendars configured. Add one in Controller settings.");
            return;
        }

        const urls: string[] = Array.from(new Set(
            calendars
                .filter((c) => c.enabled !== false)
                .map((c) => normalizeCalendarUrl(c.url))
                .filter(Boolean)
        ));

        for (const calendar of calendars) {
            const warning = getExternalCalendarConfigWarning(calendar);
            if (warning) {
                logger.warn(`[CalendarAutomation] ${warning}`);
            }
        }

        if (!urls.length) {
            logger.log("⚠️ No calendar URLs configured, skipping sync.");
            if (force) new Notice("Calendar sync skipped: no calendar URLs configured.");
            return;
        }

        const scanRoots = this.buildScanRoots(calendars, settings.archiveFolder);
        const hasTaskListMode = calendars.some(
            (calendar) => calendar.enabled !== false && (calendar.autoCreateMode || 'note') === 'task-list',
        );
        if (!scanRoots.length && !hasTaskListMode) {
            logger.warn("📅 Skipping calendar sync: no scoped calendar folders configured (vault-wide scan is disabled).");
            if (force) new Notice("Calendar sync skipped: no destination folders configured for any calendar.");
            return;
        }

        const calendarConfigs: Record<string, any> = Object.fromEntries(
            calendars
                .filter((c) => c.url)
                .map((c) => [
                    normalizeCalendarUrl(c.url),
                    {
                        mode: c.autoCreateMode || "note",
                        folder: resolveExternalCalendarNoteTargetFolder(c),
                        tag: normalizeCalendarTag(c.autoCreateTag || ""),
                        template: c.autoCreateTemplate || "",
                        taskListPath: c.autoCreateTaskListPath || "",
                        taskListHeading: c.autoCreateTaskListHeading || "",
                        autoCreateEnabled: c.autoCreateEnabled !== false,
                    },
                ])
        );

        this.autoCreateService.updateConfig({
            allowAutoCreate: true,
            orphanArchiveGraceCycles: settings.orphanArchiveGraceCycles ?? 5,
            eventIdKey: settings.eventIdKey,
            uidKey: settings.uidKey,
            titleKey: settings.titleKey,
            statusKey: settings.statusKey,
            previousStatusKey: settings.previousStatusKey,
            startProperty: settings.startProperty,
            endProperty: settings.endProperty,
            archiveFolder: settings.archiveFolder,
            globalIgnorePaths: settings.globalIgnorePaths || [],
            canceledStatusValue: settings.canceledStatusValue,
            scanRootFolders: scanRoots,
            syncBackfillDays: settings.syncBackfillDays ?? 0,
        });

        await this.autoCreateService.checkAndCreateMeetingNotes(
            this.externalCalendarService,
            urls,
            settings.externalCalendarFilter,
            calendarConfigs,
            force
        );

        await this.onSyncComplete();
        this.initialSyncCompleted = true;
        if (this.initialSyncRetryId !== null) {
            window.clearTimeout(this.initialSyncRetryId);
            this.initialSyncRetryId = null;
        }
        logger.log("✅ CALENDAR SYNC COMPLETED");
        if (force) new Notice("Calendar sync complete.");
    }

    private scheduleInitialSyncRetry(): void {
        if (this.initialSyncCompleted || this.initialSyncRetryId !== null) return;
        this.initialSyncRetryId = window.setTimeout(() => {
            this.initialSyncRetryId = null;
            void this.runSync();
        }, 5000);
    }

    private buildScanRoots(calendars: ExternalCalendarConfig[], archiveFolder: string): string[] {
        const roots = new Set<string>();
        const addRoot = (value: string | null | undefined) => {
            const normalized = this.normalizeScanRoot(value);
            if (normalized) roots.add(normalized);
        };

        const dailyResolver = getDailyNoteResolver(this.app);
        const dailyFolder = String(dailyResolver.folder || "").trim();
        for (const calendar of calendars || []) {
            if ((calendar?.autoCreateMode || "note") === "task-list") {
                const taskFilePath = normalizeExternalCalendarScanRoot(calendar?.autoCreateTaskListPath);
                if (taskFilePath) {
                    const slashIndex = taskFilePath.lastIndexOf("/");
                    if (slashIndex > 0) {
                        roots.add(taskFilePath.slice(0, slashIndex));
                    }
                } else if (dailyFolder) {
                    addRoot(dailyFolder);
                }
                continue;
            }
            addRoot(resolveExternalCalendarNoteTargetFolder(calendar));
        }

        return Array.from(roots);
    }

    private normalizeScanRoot(value: string | null | undefined): string | null {
        return normalizeExternalCalendarScanRoot(value);
    }

    async reviewQuarantine(): Promise<void> {
        const candidates = await this.autoCreateService.getOrphanCandidateFiles();
        if (!candidates.length) {
            new Notice("No calendar quarantine candidates found.");
            return;
        }
        const first = candidates[0];
        const leaf = this.app.workspace.getLeaf(false);
        if (leaf) await leaf.openFile(first, { active: true });
        new Notice(`Calendar quarantine: ${candidates.length} candidate notes. Opened: ${first.basename}`);
    }
}
