/**
 * ReminderEngine - Extracted from TPS-Notifier's runReminders() logic.
 * Evaluates reminder rules against vault files and produces notification payloads.
 * Does NOT send notifications directly — the Controller calls the Notifier's API for dispatch.
 */
import { App, TFile, moment, normalizePath } from "obsidian";
import * as logger from "../logger";
import type { ExternalCalendarEvent, PropertyReminder, TPSControllerSettings } from "../types";
import { normalizeCalendarUrl, parseFrontmatterDate } from "../utils";
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

export interface PendingNotification {
    title: string;
    body: string;
    file?: TFile;
    isAllDay: boolean;
    reminderId: string;
    sourceKey?: string;
    sourceType?: "file" | "kanban-task" | "external-event";
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
    uidStartKeys: Set<string>;
    titleDayKeys: Set<string>;
}

export class ReminderEngine {
    private app: App;
    private externalCalendarService: ExternalCalendarService;

    constructor(app: App, externalCalendarService: ExternalCalendarService) {
        this.app = app;
        this.externalCalendarService = externalCalendarService;
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

            const ctx = buildEffectiveReminderContextForTarget(target, baseFrontmatter, reminder.property, settings);
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

            if (!reminder.triggerAtEnd && reminder.mode === "timeblock" && effectiveEndTime) {
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
                if (reminder.mode === "timeblock") {
                    const staleMs = 5 * 60 * 1000;
                    if (params.now - triggerTime > staleMs) {
                        state.triggered = true;
                        state.repeatCount = 0;
                        state.lastTriggerKey = triggerKey;
                        stateChanged = true;
                        continue;
                    }
                }
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
                logger.log(`[ReminderEngine] Firing notification: "${title}" for ${fileRef.basename} (rule: "${reminder.label || reminder.id}")`);
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
                const events = await this.externalCalendarService.fetchEvents(url, rangeStart, rangeEnd, false, false);
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
        const uidStartKeys = new Set<string>();
        const titleDayKeys = new Set<string>();
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
            const uidValue = this.normalizeIdentityValue(this.findKeyInsensitive(fm, settings.uidKey));
            const startValue = this.normalizeIdentityValue(
                this.findKeyInsensitive(fm, settings.startProperty) ?? this.findKeyInsensitive(fm, "scheduled"),
            );
            const titleValue = this.normalizeIdentityValue(this.findKeyInsensitive(fm, settings.titleKey));

            if (eventId) eventIds.add(eventId);

            const startDate = startValue ? parseFrontmatterDate(startValue) : null;
            const uidForMatch = uidValue || (eventId ? this.extractUid(eventId) || eventId : null);
            const uidStartKey = this.buildUidStartKey(uidForMatch, startDate);
            if (uidStartKey) uidStartKeys.add(uidStartKey);

            const titleDayKey = this.buildTitleDayKey(titleValue, startDate);
            if (titleDayKey) titleDayKeys.add(titleDayKey);

            if (!taskListPaths.has(normalizePath(file.path))) continue;

            try {
                const content = await this.app.vault.cachedRead(file);
                for (const line of content.split(/\r?\n/)) {
                    const parsed = this.parseTaskListMatchLine(line, settings);
                    if (!parsed) continue;
                    if (parsed.eventId) eventIds.add(parsed.eventId);
                    const parsedUidStartKey = this.buildUidStartKey(parsed.uid || parsed.eventId, parsed.startDate);
                    if (parsedUidStartKey) uidStartKeys.add(parsedUidStartKey);
                    const parsedTitleDayKey = this.buildTitleDayKey(parsed.title, parsed.startDate);
                    if (parsedTitleDayKey) titleDayKeys.add(parsedTitleDayKey);
                }
            } catch (error) {
                logger.warn(`[ReminderEngine] Failed reading task-list reminder file ${file.path}`, error);
            }
        }

        return { eventIds, uidStartKeys, titleDayKeys };
    }

    private parseTaskListMatchLine(
        line: string,
        settings: TPSControllerSettings,
    ): { eventId: string | null; uid: string | null; title: string | null; startDate: Date | null } | null {
        const checkboxMatch = line.match(/^\s*-\s+\[[^\]]*\]\s+(.*)$/);
        if (!checkboxMatch) return null;

        const body = checkboxMatch[1] || "";
        const eventId = this.extractInlineFieldValue(body, settings.eventIdKey);
        const uid = this.extractInlineFieldValue(body, settings.uidKey);
        const scheduled = this.extractInlineFieldValue(body, settings.startProperty)
            || this.extractInlineFieldValue(body, "scheduled");
        const title = this.stripInlineFields(body);
        const startDate = scheduled ? parseFrontmatterDate(scheduled) : null;

        if (!eventId && !uid && !title) return null;
        return { eventId, uid, title, startDate };
    }

    private matchesLocalEvent(index: LocalEventMatchIndex, event: ExternalCalendarEvent): boolean {
        if (index.eventIds.has(event.id)) return true;

        const uidStartKey = this.buildUidStartKey(event.uid || this.extractUid(event.id) || event.id, event.startDate);
        if (uidStartKey && index.uidStartKeys.has(uidStartKey)) return true;

        const titleDayKey = this.buildTitleDayKey(event.title, event.startDate);
        return !!titleDayKey && index.titleDayKeys.has(titleDayKey);
    }

    private buildUidStartKey(uid: string | null | undefined, startDate: Date | null | undefined): string | null {
        const normalizedUid = this.normalizeIdentityValue(uid);
        if (!normalizedUid || !startDate || !Number.isFinite(startDate.getTime())) return null;
        const roundedMs = Math.round(startDate.getTime() / 60000) * 60000;
        return `${normalizedUid}|${roundedMs}`;
    }

    private buildTitleDayKey(title: string | null | undefined, startDate: Date | null | undefined): string | null {
        const normalizedTitle = this.normalizeIdentityValue(title)?.toLowerCase();
        if (!normalizedTitle || !startDate || !Number.isFinite(startDate.getTime())) return null;
        return `${normalizedTitle}|${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;
    }

    private extractInlineFieldValue(text: string, key: string): string | null {
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = text.match(new RegExp(`\\[${escaped}::\\s*([^\\]]+)\\]`, "i"));
        return match?.[1] ? String(match[1]).trim() : null;
    }

    private stripInlineFields(text: string): string {
        return text.replace(/\s*\[[a-zA-Z0-9_-]+::\s*[^\]]+\]/g, "").trim();
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

    private extractUid(id: string): string | null {
        const suffixPattern = /[-_](?:dup[-_])?(?:\d{4}\d{2}\d{2}T\d{2}\d{2}\d{2}|\d{13,})$/;
        const match = id.match(suffixPattern);
        if (match && match.index && match.index > 0) {
            return id.substring(0, match.index);
        }
        return null;
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
