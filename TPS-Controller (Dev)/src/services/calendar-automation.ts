import { App, Notice } from "obsidian";
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
        private onSyncComplete: () => Promise<void>
    ) {}

    start(): void {
        this.stop();

        const settings = this.getSettings();
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
        });

        void this.runSync();

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

        const calendarConfigs: Record<string, any> = Object.fromEntries(
            calendars
                .filter((c) => c.url)
                .map((c) => [
                    normalizeCalendarUrl(c.url),
                    {
                        typeFolder: c.autoCreateTypeFolder || "",
                        folder: c.autoCreateFolder || "",
                        tag: normalizeCalendarTag(c.autoCreateTag || ""),
                        template: c.autoCreateTemplate || "",
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
