/**
 * ReminderEngine - Extracted from TPS-Notifier's runReminders() logic.
 * Evaluates reminder rules against vault files and produces notification payloads.
 * Does NOT send notifications directly — the Controller calls the Notifier's API for dispatch.
 */
import { App, TFile, moment } from "obsidian";
import * as logger from "../logger";
import type { AlertState, TPSControllerSettings } from "../types";
import {
    parseDate, parseTimeRange, parseDuration, getEffectiveEndTime,
    formatTemplate, formatRemaining, checkStopCondition,
    normalizeStatus, getStatuses, hasRequiredStatus, shouldIgnoreForReminder,
    isAllDayEvent,
} from "../utils/time-calculation-service";
import {
    buildReminderTargetsForFile,
    buildEffectiveReminderContextForTarget,
    buildReminderDisplayName,
} from "./reminder-target-service";

export interface PendingNotification {
    title: string;
    body: string;
    file: TFile;
    isAllDay: boolean;
    reminderId: string;
    sourceKey?: string;
    sourceType?: "file" | "kanban-task";
    taskLineNumber?: number;
    taskText?: string;
}

export interface ReminderRunResult {
    notifications: PendingNotification[];
    stateChanged: boolean;
}

export class ReminderEngine {
    private app: App;

    constructor(app: App) {
        this.app = app;
    }

    async evaluateReminders(settings: TPSControllerSettings): Promise<ReminderRunResult> {
        const now = Date.now();
        const alertState = settings.alertState;
        let stateChanged = false;
        const pendingNotifications: PendingNotification[] = [];

        const files = [...this.app.vault.getMarkdownFiles()].sort((a, b) => a.path.localeCompare(b.path));
        if (settings.enableLogging) {
            logger.log(`[ReminderEngine] Checking ${files.length} files...`);
        }

        for (const file of files) {
            try {
                const cache = this.app.metadataCache.getFileCache(file);
                const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
                const targets = await buildReminderTargetsForFile(this.app, file, fm, settings);

                for (const target of targets) {
                    if (!alertState[target.sourceKey]) alertState[target.sourceKey] = {};

                    for (const reminder of settings.reminders) {
                        if (!reminder.enabled) continue;

                        const ctx = buildEffectiveReminderContextForTarget(target, fm, reminder.property, settings);
                        if (!ctx) continue;
                        const effectiveFm = ctx.frontmatter;
                        const propValue = ctx.propertyValue;

                        if (shouldIgnoreForReminder(
                            file, cache, effectiveFm, reminder,
                            settings.globalIgnorePaths,
                            settings.globalIgnoreTags,
                            settings.globalIgnoreStatuses
                        )) continue;

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
                        const hasExplicitTime = this.propertyValueHasExplicitTime(normalizedPropValue);
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

                        if (now < triggerTime) {
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
                                if (now - triggerTime > staleMs) {
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
                            const timeSinceLastSent = state.lastSent ? (now - state.lastSent) : Infinity;
                            if (timeSinceLastSent >= repeatMs && (reminder.maxRepeats === -1 || state.repeatCount < reminder.maxRepeats)) {
                                shouldNotify = true;
                                state.repeatCount++;
                                stateChanged = true;
                            }
                        }

                        if (!shouldNotify) continue;

                        const remaining = formatRemaining(propTime - now);
                        const timeStr = moment(propTime).format("h:mm A");
                        const displayName = buildReminderDisplayName(file, target);
                        const title = formatTemplate(reminder.title, { filename: displayName, time: timeStr, remaining });
                        const body = formatTemplate(reminder.body, { filename: displayName, time: timeStr, remaining });

                        pendingNotifications.push({
                            title,
                            body,
                            file,
                            isAllDay: isAllDaySafe,
                            reminderId: reminder.id,
                            sourceKey: target.sourceKey,
                            sourceType: target.sourceType,
                            taskLineNumber: target.task?.lineNumber,
                            taskText: target.task?.text,
                        });
                        state.lastSent = now;
                        state.lastTriggerKey = triggerKey;
                        stateChanged = true;

                        if (settings.enableLogging) {
                            logger.log(`[ReminderEngine] Firing notification: "${title}" for ${file.basename} (rule: "${reminder.label || reminder.id}")`);
                        }

                        break;
                    }
                }
            } catch (err) {
                logger.error(`[ReminderEngine] Error processing reminders for ${file.path}:`, err);
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

    private normalizeReminderPropertyValue(value: unknown): string {
        const raw = Array.isArray(value) ? value[0] : value;
        return String(raw ?? "").replace(/[\[\]]/g, "").trim();
    }

    private propertyValueHasExplicitTime(value: string): boolean {
        if (!value) return false;
        if (/[T ]\d{1,2}:\d{2}/.test(value)) return true;
        if (/\b\d{1,2}:\d{2}\s*(AM|PM)\b/i.test(value)) return true;
        return false;
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
