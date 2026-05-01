/**
 * ReminderEngine - Extracted from TPS-Notifier's runReminders() logic.
 * Evaluates reminder rules against vault files and produces notification payloads.
 * Does NOT send notifications directly — the Controller calls the Notifier's API for dispatch.
 */
import { App, TFile, moment, normalizePath } from "obsidian";
import * as logger from "../logger";
import type { ExternalCalendarEvent, PropertyReminder, TPSControllerSettings } from "../types";
import { normalizeCalendarUrl, parseFrontmatterDate } from "../utils";
import { getDailyNoteResolver } from "../utils/daily-note-resolver";
import { CheckboxPatterns } from "./checkbox-pattern-service";
import {
    parseDate, parseTimeRange, parseDuration, getEffectiveEndTime,
    formatTemplate, formatRemaining, checkStopCondition,
    normalizeStatus, getStatuses, hasRequiredStatus, shouldIgnoreForReminder,
    isAllDayEvent, hasExplicitTimeInValue,
} from "../utils/time-calculation-service";
import {
    buildReminderTargetsForFile,
    buildEffectiveReminderContextForTarget,
    buildReminderDisplayName,
    type ReminderEvaluationTarget,
} from "./reminder-target-service";
import { ExternalCalendarService } from "./external-calendar-service";

interface GcmItemSemanticsApi {
    extractInlineProperty?: (text: string, ...keys: string[]) => string | null;
    stripInlineProperties?: (text: string) => string;
}

export interface PendingNotification {
    title: string;
    body: string;
    file?: TFile;
    isAllDay: boolean;
    reminderId: string;
    sourceKey?: string;
    sourceType?: "file" | "kanban-task" | "task-item" | "external-event";
    taskLineNumber?: number;
    taskText?: string;
}

export interface ReminderRunResult {
    notifications: PendingNotification[];
    stateChanged: boolean;
}

interface ReminderFileLike {
    path: string;
    basename: string;
}

interface LocalEventMatchIndex {
    eventIds: Set<string>;
}

export class ReminderEngine {
    private app: App;
    private externalCalendarService: ExternalCalendarService;

    constructor(app: App, externalCalendarService: ExternalCalendarService) {
        this.app = app;
        this.externalCalendarService = externalCalendarService;
    }

    private getGcmItemSemanticsApi(): GcmItemSemanticsApi | null {
        return (this.app as any)?.plugins?.getPlugin?.('tps-global-context-menu')?.api
            || (this.app as any)?.plugins?.plugins?.['TPS-Global-Context-Menu (Dev)']?.api
            || null;
    }

    async evaluateReminders(settings: TPSControllerSettings): Promise<ReminderRunResult> {
        const now = Date.now();
        const alertState = settings.alertState;
        let stateChanged = false;
        const pendingNotifications: PendingNotification[] = [];

        const files = [...this.app.vault.getMarkdownFiles()].sort((a, b) => a.path.localeCompare(b.path));
        const needsExternalEvents = settings.reminders.some(
            (reminder) => reminder.enabled && reminder.includeUnmatchedExternalEvents,
        );

        if (settings.enableLogging) {
            logger.log(`[ReminderEngine] Checking ${files.length} files${needsExternalEvents ? " + unmatched external events" : ""}...`);
        }

        for (const file of files) {
            try {
                const cache = this.app.metadataCache.getFileCache(file);
                const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
                const targets = await buildReminderTargetsForFile(this.app, file, fm, settings);
                if (targets.length > 0) {
                    logger.debug('[ReminderEngine] Built reminder targets for file', {
                        file: file.path,
                        count: targets.length,
                        sourceTypes: Array.from(new Set(targets.map((target) => target.sourceType))),
                    });
                }

                for (const target of targets) {
                    const result = this.evaluateTarget({
                        target,
                        fileRef: file,
                        cache,
                        baseFrontmatter: fm,
                        settings,
                        now,
                        alertState,
                    });
                    pendingNotifications.push(...result.notifications);
                    stateChanged = stateChanged || result.stateChanged;
                }
            } catch (err) {
                logger.error(`[ReminderEngine] Error processing reminders for ${file.path}:`, err);
            }
        }

        if (needsExternalEvents) {
            const externalTargets = await this.buildUnmatchedExternalReminderTargets(files, settings);
            if (externalTargets.length > 0) {
                logger.debug('[ReminderEngine] Built unmatched external reminder targets', {
                    count: externalTargets.length,
                });
            }
            for (const target of externalTargets) {
                const event = target.externalEvent;
                if (!event) continue;
                const syntheticFile = this.buildSyntheticExternalFile(event);
                const result = this.evaluateTarget({
                    target,
                    fileRef: syntheticFile,
                    cache: null,
                    baseFrontmatter: {},
                    settings,
                    now,
                    alertState,
                    reminderFilter: (reminder) => !!reminder.includeUnmatchedExternalEvents,
                });
                pendingNotifications.push(...result.notifications);
                stateChanged = stateChanged || result.stateChanged;
            }
        }

        if (settings.enableLogging) {
            const notifSummary = pendingNotifications.length > 0
                ? `${pendingNotifications.length} notification(s) queued`
                : "no notifications triggered";
            const activeRules = settings.reminders.filter((r) => r.enabled).length;
            logger.log(`[ReminderEngine] Scan complete: ${notifSummary} (${files.length} files, ${activeRules} active rule(s))`);
        }

        return { notifications: pendingNotifications, stateChanged };
    }

    private evaluateTarget(params: {
        target: ReminderEvaluationTarget;
        fileRef: ReminderFileLike;
        cache: unknown;
        baseFrontmatter: Record<string, unknown>;
        settings: TPSControllerSettings;
        now: number;
        alertState: TPSControllerSettings["alertState"];
        reminderFilter?: (reminder: PropertyReminder) => boolean;
    }): ReminderRunResult {
        const {
            target,
            fileRef,
            cache,
            baseFrontmatter,
            settings,
            now,
            alertState,
            reminderFilter,
        } = params;
        const notifications: PendingNotification[] = [];
        let stateChanged = false;

        if (!alertState[target.sourceKey]) alertState[target.sourceKey] = {};

        for (const reminder of settings.reminders) {
            if (!reminder.enabled) continue;
            if (reminderFilter && !reminderFilter(reminder)) continue;

            const ctx = buildEffectiveReminderContextForTarget(this.app, target, baseFrontmatter, reminder.property, settings);
            if (!ctx) continue;
            const effectiveFm = ctx.frontmatter;
            const propValue = ctx.propertyValue;

            if (shouldIgnoreForReminder(
                fileRef,
                cache,
                effectiveFm,
                reminder,
                settings.globalIgnorePaths,
                settings.globalIgnoreTags,
                settings.globalIgnoreStatuses,
                {
                    skipPathIgnore: target.sourceType === "task-item" || target.sourceType === "kanban-task",
                    skipTagIgnore: target.sourceType === "task-item" || target.sourceType === "kanban-task",
                },
            )) {
                continue;
            }

            const { start: propTime, end: rangeEndTime } = parseTimeRange(propValue);
            if (!propTime) continue;
            if (!hasRequiredStatus(effectiveFm, reminder)) continue;

            let offsetMs = reminder.offsetMinutes * 60 * 1000;
            const effectiveEndTime = getEffectiveEndTime(propTime, rangeEndTime, effectiveFm);
            if (reminder.mode === "timeblock" && !reminder.triggerAtEnd && effectiveEndTime && now > effectiveEndTime) {
                continue;
            }

            let finalTriggerBase = propTime;
            if (reminder.triggerAtEnd) {
                if (!effectiveEndTime) continue;
                finalTriggerBase = effectiveEndTime;
            }

            const normalizedPropValue = this.normalizeReminderPropertyValue(propValue);
            const hasExplicitTime = hasExplicitTimeInValue(propValue);
            const isAllDaySafe = isAllDayEvent(propValue, effectiveFm) &&
                (!hasExplicitTime || String(effectiveFm?.allDay ?? "").toLowerCase() === "true");

            const effectiveAllDayBaseTime = reminder.allDayBaseTime || settings.defaultAllDayBaseTime;
            if (!reminder.triggerAtEnd && isAllDaySafe && effectiveAllDayBaseTime) {
                const match = effectiveAllDayBaseTime.match(/^(\d{1,2}):(\d{2})$/);
                if (match) {
                    finalTriggerBase = moment(finalTriggerBase).set({
                        hour: parseInt(match[1], 10),
                        minute: parseInt(match[2], 10),
                        second: 0,
                        millisecond: 0,
                    }).valueOf();
                }
            }

            if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                const durationMins = parseDuration(effectiveFm[reminder.smartOffsetProperty]);
                if (durationMins > 0) {
                    const smartMs = durationMins * 60 * 1000;
                    offsetMs = reminder.smartOffsetOperator === "add" ? smartMs : -smartMs;
                }
            }

            const triggerTime = finalTriggerBase + offsetMs;
            const triggerKey = this.buildTriggerKey(triggerTime, isAllDaySafe, hasExplicitTime, normalizedPropValue);
            if (!alertState[target.sourceKey][reminder.id]) {
                alertState[target.sourceKey][reminder.id] = {
                    triggered: false,
                    repeatCount: 0,
                    lastSent: undefined,
                    lastTriggerKey: undefined,
                };
            }
            const state = alertState[target.sourceKey][reminder.id];

            if (state.lastTriggerKey && state.lastTriggerKey !== triggerKey && state.triggered) {
                logger.debug('[ReminderEngine] Reset reminder state because trigger key changed', {
                    sourceKey: target.sourceKey,
                    reminderId: reminder.id,
                    previousTriggerKey: state.lastTriggerKey,
                    nextTriggerKey: triggerKey,
                });
                state.triggered = false;
                state.repeatCount = 0;
                state.lastSent = undefined;
                stateChanged = true;
            }

            const snoozeVal = effectiveFm[settings.snoozeProperty || "reminderSnooze"];
            if (snoozeVal) {
                const snoozeTime = parseDate(snoozeVal);
                if (snoozeTime && now < snoozeTime) continue;
            }

            if (reminder.allDayFilter && reminder.allDayFilter !== "any") {
                if (reminder.allDayFilter === "true" && !isAllDaySafe) continue;
                if (reminder.allDayFilter === "false" && isAllDaySafe) continue;
            }

            if (effectiveEndTime) {
                const isWorking = getStatuses(effectiveFm).includes("working");
                if (isWorking && now < effectiveEndTime) {
                    const requiresWorking = reminder.requiredStatuses?.some((s) => normalizeStatus(s) === "working");
                    if (!requiresWorking) continue;
                }
            }

            const shouldStop = reminder.stopConditions.some((cond) => checkStopCondition(effectiveFm, cond));
            if (shouldStop) {
                if (state.triggered) {
                    logger.debug('[ReminderEngine] Cleared reminder state because a stop condition matched', {
                        sourceKey: target.sourceKey,
                        reminderId: reminder.id,
                    });
                    state.triggered = false;
                    state.repeatCount = 0;
                    state.lastSent = undefined;
                    state.lastTriggerKey = undefined;
                    stateChanged = true;
                }
                continue;
            }

            if (params.now < triggerTime) {
                if (state.triggered && reminder.repeatUntilComplete) {
                    state.triggered = false;
                    state.repeatCount = 0;
                    stateChanged = true;
                }
                continue;
            }

            let shouldNotify = false;
            if (!state.triggered) {
                if (!reminder.repeatUntilComplete && state.lastTriggerKey === triggerKey && state.lastSent) continue;
                shouldNotify = true;
                state.triggered = true;
                state.repeatCount = 0;
                state.lastTriggerKey = triggerKey;
                stateChanged = true;
            } else if (
                reminder.repeatUntilComplete &&
                (!reminder.mode || reminder.mode === "task") &&
                !isAllDaySafe
            ) {
                if (!hasRequiredStatus(effectiveFm, reminder)) continue;
                const repeatMs = reminder.repeatIntervalMinutes * 60 * 1000;
                const timeSinceLastSent = state.lastSent ? (params.now - state.lastSent) : Infinity;
                if (timeSinceLastSent >= repeatMs && (reminder.maxRepeats === -1 || state.repeatCount < reminder.maxRepeats)) {
                    shouldNotify = true;
                    state.repeatCount++;
                    stateChanged = true;
                }
            }

            if (!shouldNotify) continue;

            const remaining = formatRemaining(propTime - params.now);
            const timeStr = moment(propTime).format("h:mm A");
            const displayName = buildReminderDisplayName(fileRef, target);
            const title = formatTemplate(reminder.title, { filename: displayName, time: timeStr, remaining });
            const body = formatTemplate(reminder.body, { filename: displayName, time: timeStr, remaining });

            notifications.push({
                title,
                body,
                file: fileRef instanceof TFile ? fileRef : undefined,
                isAllDay: isAllDaySafe,
                reminderId: reminder.id,
                sourceKey: target.sourceKey,
                sourceType: target.sourceType,
                taskLineNumber: target.task?.lineNumber,
                taskText: target.task?.text,
            });
            state.lastSent = params.now;
            state.lastTriggerKey = triggerKey;
            stateChanged = true;

            if (settings.enableLogging) {
                logger.log(`[ReminderEngine] Firing notification: "${title}" for ${fileRef.basename} (rule: "${reminder.label || reminder.id}")`, {
                    sourceType: target.sourceType,
                    sourceKey: target.sourceKey,
                    reminderId: reminder.id,
                });
            }

            break;
        }

        return { notifications, stateChanged };
    }

    private async buildUnmatchedExternalReminderTargets(
        files: TFile[],
        settings: TPSControllerSettings,
    ): Promise<ReminderEvaluationTarget[]> {
        const calendars = (settings.externalCalendars || []).filter((calendar) => calendar.enabled !== false);
        const urls = Array.from(new Set(calendars.map((calendar) => normalizeCalendarUrl(calendar.url)).filter(Boolean)));
        if (!urls.length) return [];

        const localIndex = await this.buildLocalEventMatchIndex(files, settings);
        const rangeStart = moment().subtract(14, "days").startOf("day").toDate();
        const rangeEnd = moment().add(60, "days").endOf("day").toDate();
        const seen = new Set<string>();
        const targets: ReminderEvaluationTarget[] = [];

        for (const url of urls) {
            try {
                logger.debug('[ReminderEngine] Fetching unmatched external reminder events', {
                    url,
                    rangeStart,
                    rangeEnd,
                });
                const events = await this.externalCalendarService.fetchEvents(url, rangeStart, rangeEnd, false, false);
                const targetCountBefore = targets.length;
                for (const event of events) {
                    if (event.isCancelled) continue;
                    if (this.matchesLocalEvent(localIndex, event)) continue;

                    const sourceUrl = normalizeCalendarUrl(event.sourceUrl || url);
                    const dedupeKey = `${sourceUrl}::${event.id}`;
                    if (seen.has(dedupeKey)) continue;
                    seen.add(dedupeKey);

                    targets.push({
                        sourceKey: `external-event::${sourceUrl}::${event.id}`,
                        sourceType: "external-event",
                        externalEvent: {
                            ...event,
                            sourceUrl,
                        },
                    });
                }
                logger.debug('[ReminderEngine] Completed unmatched external reminder scan', {
                    url,
                    fetched: events.length,
                    added: targets.length - targetCountBefore,
                });
            } catch (error) {
                logger.warn(`[ReminderEngine] Failed fetching external reminder events for ${url}`, error);
            }
        }

        return targets;
    }

    private async buildLocalEventMatchIndex(
        files: TFile[],
        settings: TPSControllerSettings,
    ): Promise<LocalEventMatchIndex> {
        const eventIds = new Set<string>();
        const dailyResolver = getDailyNoteResolver(this.app);
        const dailyFolderNorm = normalizePath(String(dailyResolver.folder || "").trim());
        const hasDailyFallbackTaskLists = (settings.externalCalendars || []).some(
            (calendar) => (calendar.autoCreateMode || "note") === "task-list" && !String(calendar.autoCreateTaskListPath || "").trim(),
        );
        const taskListPaths = new Set(
            (settings.externalCalendars || [])
                .filter((calendar) => (calendar.autoCreateMode || "note") === "task-list")
                .map((calendar) => normalizePath(String(calendar.autoCreateTaskListPath || "").trim()))
                .filter(Boolean),
        );

        for (const file of files) {
            if (this.isArchivedFile(file, settings.archiveFolder)) continue;

            const cache = this.app.metadataCache.getFileCache(file);
            const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
            const eventId = this.normalizeIdentityValue(this.findKeyInsensitive(fm, settings.eventIdKey));

            if (eventId) eventIds.add(eventId);

            const normalizedFilePath = normalizePath(file.path);
            const isDailyFallbackTaskFile = hasDailyFallbackTaskLists
                && dailyResolver.isDailyNoteBasename(file.basename)
                && normalizePath(file.parent?.path || "") === dailyFolderNorm;
            if (!taskListPaths.has(normalizedFilePath) && !isDailyFallbackTaskFile) continue;

            try {
                const content = await this.app.vault.cachedRead(file);
                for (const line of content.split(/\r?\n/)) {
                    const parsed = this.parseTaskListMatchLine(line, settings);
                    if (!parsed) continue;
                    if (parsed.eventId) eventIds.add(parsed.eventId);
                }
            } catch (error) {
                logger.warn(`[ReminderEngine] Failed reading task-list reminder file ${file.path}`, error);
            }
        }

        return { eventIds };
    }

    private parseTaskListMatchLine(
        line: string,
        settings: TPSControllerSettings,
    ): { eventId: string | null } | null {
        const checkboxMatch = line.match(CheckboxPatterns.ANY_CHECKBOX_CONTENT);
        if (!checkboxMatch) return null;

        const body = checkboxMatch[1] || "";
        const eventId = this.extractInlineFieldValue(body, settings.eventIdKey);
        if (!eventId) return null;
        return { eventId };
    }

    private matchesLocalEvent(index: LocalEventMatchIndex, event: ExternalCalendarEvent): boolean {
        return index.eventIds.has(event.id);
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

    private findKeyInsensitive(obj: Record<string, unknown>, key: string): unknown {
        const normalized = String(key || "").trim().toLowerCase();
        const found = Object.keys(obj).find((candidate) => candidate.trim().toLowerCase() === normalized);
        return found ? obj[found] : undefined;
    }

    private normalizeIdentityValue(value: unknown): string | null {
        if (typeof value !== "string") return null;
        const normalized = value.trim();
        if (!normalized) return null;
        const lower = normalized.toLowerCase();
        if (lower === "null" || lower === "undefined" || lower === "none" || lower === "n/a") {
            return null;
        }
        return normalized;
    }

    private isArchivedFile(file: TFile, archiveFolder: string): boolean {
        const archive = normalizePath(String(archiveFolder || "").trim());
        if (!archive) return false;
        return file.path === archive || file.path.startsWith(`${archive}/`);
    }

    private buildSyntheticExternalFile(event: ExternalCalendarEvent): ReminderFileLike {
        const source = normalizeCalendarUrl(event.sourceUrl || "external-calendar") || "external-calendar";
        return {
            path: `external-calendars/${source}/${event.id}.ics`,
            basename: event.title || "External calendar event",
        };
    }

    private normalizeReminderPropertyValue(value: unknown): string {
        const raw = Array.isArray(value) ? value[0] : value;
        return String(raw ?? "").replace(/[\[\]]/g, "").trim();
    }

    private buildTriggerKey(
        triggerTime: number,
        isAllDay: boolean,
        hasExplicitTime: boolean,
        normalizedPropValue: string,
    ): string {
        return [
            String(triggerTime),
            isAllDay ? "all-day" : "timed",
            hasExplicitTime ? "datetime" : "date-or-implicit",
            normalizedPropValue || "",
        ].join("|");
    }
}
