import { App, Notice, normalizePath } from "obsidian";
import { AutoCreateService } from "./auto-create-service";
import { ExternalCalendarService } from "./external-calendar-service";
import type { TPSControllerSettings, ExternalCalendarConfig } from "../types";
import { normalizeCalendarUrl, normalizeCalendarTag } from "../utils";
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

        const settings = this.getSettings();
        const initialScanRoots = this.buildScanRoots(settings.externalCalendars || [], settings.archiveFolder);
        this.autoCreateService.updateConfig({
            allowAutoCreate: true,
            noLossSyncMode: settings.noLossSyncMode ?? true,
            eventIdKey: settings.eventIdKey,
            uidKey: settings.uidKey,
            titleKey: settings.titleKey,
            statusKey: settings.statusKey,
            previousStatusKey: settings.previousStatusKey,
            startProperty: settings.startProperty,
            endProperty: settings.endProperty,
            syncOnEventDelete: settings.syncOnEventDelete,
            archiveFolder: settings.archiveFolder,
            globalIgnorePaths: settings.globalIgnorePaths || [],
            canceledStatusValue: settings.canceledStatusValue,
            scanRootFolders: initialScanRoots,
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
    }

    async runSync(force = false): Promise<void> {
        logger.log(`📅 RUN CALENDAR SYNC (force=${force})...`);
        const readiness = this.getSyncReadiness();
        if (!readiness.ready) {
            logger.warn(`📅 Skipping calendar sync: ${readiness.reason}`);
            return;
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

        const urls: string[] = Array.from(new Set(
            calendars
                .filter((c) => c.enabled !== false)
                .map((c) => normalizeCalendarUrl(c.url))
                .filter(Boolean)
        ));

        if (!urls.length) {
            logger.log("⚠️ No calendar URLs configured, skipping sync.");
            return;
        }

        const scanRoots = this.buildScanRoots(calendars, settings.archiveFolder);
        if (!scanRoots.length) {
            logger.warn("📅 Skipping calendar sync: no scoped calendar folders configured (vault-wide scan is disabled).");
            return;
        }

        const calendarConfigs: Record<string, any> = Object.fromEntries(
            calendars
                .filter((c) => c.url)
                .map((c) => [
                    normalizeCalendarUrl(c.url),
                    {
                        mode: c.autoCreateMode || "note",
                        typeFolder: c.autoCreateTypeFolder || "",
                        folder: c.autoCreateFolder || "",
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
            noLossSyncMode: settings.noLossSyncMode ?? true,
            eventIdKey: settings.eventIdKey,
            uidKey: settings.uidKey,
            titleKey: settings.titleKey,
            statusKey: settings.statusKey,
            previousStatusKey: settings.previousStatusKey,
            startProperty: settings.startProperty,
            endProperty: settings.endProperty,
            syncOnEventDelete: settings.syncOnEventDelete,
            archiveFolder: settings.archiveFolder,
            globalIgnorePaths: settings.globalIgnorePaths || [],
            canceledStatusValue: settings.canceledStatusValue,
            scanRootFolders: scanRoots,
        });

        await this.autoCreateService.checkAndCreateMeetingNotes(
            this.externalCalendarService,
            urls,
            settings.externalCalendarFilter,
            calendarConfigs,
            force
        );

        await this.onSyncComplete();
        logger.log("✅ CALENDAR SYNC COMPLETED");
    }

    private buildScanRoots(calendars: ExternalCalendarConfig[], archiveFolder: string): string[] {
        const roots = new Set<string>();
        const addRoot = (value: string | null | undefined) => {
            const normalized = this.normalizeScanRoot(value);
            if (normalized) roots.add(normalized);
        };

        addRoot(archiveFolder);
        for (const calendar of calendars || []) {
            if ((calendar?.autoCreateMode || "note") === "task-list") {
                const taskFilePath = this.normalizeScanRoot(calendar?.autoCreateTaskListPath);
                if (taskFilePath) {
                    const slashIndex = taskFilePath.lastIndexOf("/");
                    if (slashIndex > 0) {
                        roots.add(taskFilePath.slice(0, slashIndex));
                    }
                }
                continue;
            }
            addRoot(calendar?.autoCreateFolder);
            addRoot(calendar?.autoCreateTypeFolder);
        }

        return Array.from(roots);
    }

    private normalizeScanRoot(value: string | null | undefined): string | null {
        if (typeof value !== "string") return null;
        const normalized = normalizePath(value).replace(/^\/+|\/+$/g, "").trim();
        if (!normalized) return null;
        if (normalized === "." || normalized === "/") return null;
        return normalized;
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
