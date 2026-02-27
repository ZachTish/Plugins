/**
 * ReminderEngine - Extracted from TPS-Notifier's runReminders() logic.
 * Evaluates reminder rules against vault files and produces notification payloads.
 * Does NOT send notifications directly — the Controller calls the Notifier's API for dispatch.
 */
import { App, TFile, moment } from "obsidian";
import * as logger from "../logger";
import type { PropertyReminder, AlertState, TPSControllerSettings } from "../types";
import {
    parseDate, parseTimeRange, parseDuration, getEffectiveEndTime,
    formatTemplate, formatRemaining, checkStopCondition,
    normalizeStatus, getStatuses, hasRequiredStatus, shouldIgnoreForReminder
} from "./time-calculation-service";

export interface PendingNotification {
    title: string;
    body: string;
    file: TFile;
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

    /**
     * Evaluate all reminder rules against all vault files.
     * Returns notification payloads — does NOT send them.
     */
    async evaluateReminders(settings: TPSControllerSettings): Promise<ReminderRunResult> {
        const now = Date.now();
        const alertState = settings.alertState;
        let stateChanged = false;
        const pendingNotifications: PendingNotification[] = [];

        const files = this.app.vault.getMarkdownFiles();
        if (settings.enableLogging) {
            logger.log(`[ReminderEngine] Checking ${files.length} files...`);
        }

        for (const file of files) {
            try {
                const cache = this.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter || {};

                // Initialize state for this file
                if (!alertState[file.path]) {
                    alertState[file.path] = {};
                }

                // Process each enabled reminder
                for (const reminder of settings.reminders) {
                    if (!reminder.enabled) continue;
                    if (shouldIgnoreForReminder(
                        file, cache, fm, reminder,
                        settings.globalIgnorePaths,
                        settings.globalIgnoreTags,
                        settings.globalIgnoreStatuses
                    )) {
                        continue;
                    }

                    // Get the property value
                    const propValue = fm[reminder.property];
                    const { start: propTime, end: rangeEndTime } = parseTimeRange(propValue);
                    if (!propTime) continue;

                    // Check Required Statuses
                    if (!hasRequiredStatus(fm, reminder)) continue;

                    // Calculate offset
                    let offsetMs = reminder.offsetMinutes * 60 * 1000;

                    // Determine effective End Time
                    const effectiveEndTime = getEffectiveEndTime(propTime, rangeEndTime, fm);

                    // Check Timeblock Expiration
                    if (reminder.mode === 'timeblock' && !reminder.triggerAtEnd && effectiveEndTime) {
                        if (now > effectiveEndTime) {
                            continue;
                        }
                    }

                    // All-Day Base Time Logic
                    let finalTriggerBase = propTime;

                    if (reminder.triggerAtEnd) {
                        if (!effectiveEndTime) continue;
                        finalTriggerBase = effectiveEndTime;
                    }

                    const isAllDaySafe = fm['allDay'] === true || String(fm['allDay']).toLowerCase() === 'true';

                    if (!reminder.triggerAtEnd && isAllDaySafe && reminder.allDayBaseTime) {
                        const match = reminder.allDayBaseTime.match(/^(\d{1,2}):(\d{2})$/);
                        if (match) {
                            const [_, h, m] = match;
                            finalTriggerBase = moment(finalTriggerBase).set({
                                hour: parseInt(h, 10),
                                minute: parseInt(m, 10),
                                second: 0,
                                millisecond: 0
                            }).valueOf();
                        }
                    }

                    // Smart Offset Logic
                    if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                        const offsetVal = fm[reminder.smartOffsetProperty];
                        const durationMins = parseDuration(offsetVal);
                        const smartMs = durationMins * 60 * 1000;
                        if (reminder.smartOffsetOperator === 'add') {
                            offsetMs = smartMs;
                        } else {
                            offsetMs = -smartMs;
                        }
                    }

                    const triggerTime = finalTriggerBase + offsetMs;

                    // Initialize state for this reminder
                    if (!alertState[file.path][reminder.id]) {
                        alertState[file.path][reminder.id] = {
                            triggered: false,
                            repeatCount: 0,
                            lastSent: undefined
                        };
                    }

                    const state = alertState[file.path][reminder.id];

                    // Check Snooze
                    const snoozeVal = fm[settings.snoozeProperty || 'reminderSnooze'];
                    if (snoozeVal) {
                        const snoozeTime = parseDate(snoozeVal);
                        if (snoozeTime && now < snoozeTime) {
                            continue;
                        }
                    }

                    // All-Day Filter
                    if (reminder.allDayFilter && reminder.allDayFilter !== 'any') {
                        if (reminder.allDayFilter === 'true' && !isAllDaySafe) continue;
                        if (reminder.allDayFilter === 'false' && isAllDaySafe) continue;
                    }

                    // Check if event is currently ongoing (for working status)
                    if (effectiveEndTime) {
                        const currentStatuses = getStatuses(fm);
                        const isWorking = currentStatuses.includes('working');
                        if (isWorking && now < effectiveEndTime) {
                            const requiresWorking = reminder.requiredStatuses?.some(s =>
                                normalizeStatus(s) === 'working'
                            );
                            if (!requiresWorking) {
                                continue;
                            }
                        }
                    }

                    // Check stop conditions
                    const shouldStop = reminder.stopConditions.some(cond =>
                        checkStopCondition(fm, cond)
                    );

                    if (shouldStop) {
                        if (state.triggered) {
                            state.triggered = false;
                            state.repeatCount = 0;
                            state.lastSent = undefined;
                            stateChanged = true;
                        }
                        continue;
                    }

                    // Check if we should trigger
                    const pastTriggerTime = now >= triggerTime;

                    if (!pastTriggerTime) {
                        if (state.triggered) {
                            state.triggered = false;
                            state.repeatCount = 0;
                            stateChanged = true;
                        }
                        continue;
                    }

                    // Check if we should send a notification
                    let shouldNotify = false;

                    if (!state.triggered) {
                        // Staleness Check for One-Shot Reminders
                        if (reminder.mode === 'timeblock') {
                            const STALE_THRESHOLD_MS = 5 * 60 * 1000;
                            if (now - triggerTime > STALE_THRESHOLD_MS) {
                                state.triggered = true;
                                state.repeatCount = 0;
                                stateChanged = true;
                                continue;
                            }
                        }

                        shouldNotify = true;
                        state.triggered = true;
                        state.repeatCount = 0;
                        stateChanged = true;
                    } else if (reminder.repeatUntilComplete && (!reminder.mode || reminder.mode === 'task') && state.triggered) {
                        if (!hasRequiredStatus(fm, reminder)) continue;
                        const repeatMs = reminder.repeatIntervalMinutes * 60 * 1000;
                        const timeSinceLastSent = state.lastSent ? (now - state.lastSent) : Infinity;
                        if (timeSinceLastSent >= repeatMs) {
                            if (reminder.maxRepeats === -1 || state.repeatCount < reminder.maxRepeats) {
                                shouldNotify = true;
                                state.repeatCount++;
                                stateChanged = true;
                            }
                        }
                    }

                    if (shouldNotify) {
                        const remaining = formatRemaining(propTime - now);
                        const timeStr = moment(propTime).format('h:mm A');

                        let displayName = file.basename;
                        if (!/^\d{4}-\d{2}-\d{2}$/.test(displayName)) {
                            displayName = displayName.replace(/ \d{4}-\d{2}-\d{2}$/, '');
                        }

                        const title = formatTemplate(reminder.title, {
                            filename: displayName,
                            time: timeStr,
                            remaining: remaining
                        });

                        const body = formatTemplate(reminder.body, {
                            filename: displayName,
                            time: timeStr,
                            remaining: remaining
                        });

                        pendingNotifications.push({ title, body, file });
                        state.lastSent = now;
                        stateChanged = true;

                        // Break after first trigger for this file to prevent redundancy
                        break;
                    }
                }

            } catch (err) {
                logger.error(`[ReminderEngine] Error processing reminders for ${file.path}:`, err);
            }
        }

        return { notifications: pendingNotifications, stateChanged };
    }
}
