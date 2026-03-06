import { App, TFile, WorkspaceLeaf, moment } from "obsidian";
import { NOTIFICATION_VIEW_TYPE } from "../views/notification-view";
import * as logger from "../logger";
import type { TPSControllerSettings, OverdueItem } from "../types";
import {
    parseDate, parseTimeRange, parseDuration, getEffectiveEndTime,
    formatTemplate, checkStopCondition, hasRequiredStatus,
    shouldIgnoreForReminder, isAllDayEvent
} from "../utils/time-calculation-service";

/**
 * Handles overdue reminder detection, the notification sidebar view,
 * and file-level actions (snooze, open, mark complete/won't-do).
 */
export class OverdueService {
    constructor(
        private app: App,
        private getSettings: () => TPSControllerSettings
    ) {}

    async openNotificationModal(): Promise<void> {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(NOTIFICATION_VIEW_TYPE);
        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                leaf = rightLeaf;
                await leaf.setViewState({ type: NOTIFICATION_VIEW_TYPE, active: true });
            } else {
                logger.error('[TPS Controller] Failed to get right leaf');
            }
        }
        if (leaf) workspace.revealLeaf(leaf);
    }

    async getOverdueItems(): Promise<OverdueItem[]> {
        const settings = this.getSettings();
        const now = Date.now();
        const overdueItems: OverdueItem[] = [];
        const reminders = settings.reminders || [];
        if (!reminders.length) return overdueItems;

        const ignorePaths = settings.globalIgnorePaths || [];
        const ignoreTags = settings.globalIgnoreTags || [];
        const ignoreStatuses = settings.globalIgnoreStatuses || [];
        const snoozeKey = settings.snoozeProperty || 'reminderSnooze';

        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter || {};

            for (const reminder of reminders) {
                if (!reminder.enabled) continue;
                if (shouldIgnoreForReminder(file, cache, fm, reminder, ignorePaths, ignoreTags, ignoreStatuses)) continue;
                if (!hasRequiredStatus(fm, reminder)) continue;

                let snoozedUntil: number | undefined;
                const snoozeVal = fm[snoozeKey];
                if (snoozeVal) {
                    const snoozeTime = parseDate(snoozeVal);
                    if (snoozeTime && now < snoozeTime) snoozedUntil = snoozeTime;
                }

                const propertyValue = fm[reminder.property];
                const { start: propertyTime, end: rangeEndTime } = parseTimeRange(propertyValue);
                if (!propertyTime) continue;

                const effectiveEndTime = getEffectiveEndTime(propertyTime, rangeEndTime, fm);
                if (reminder.mode === 'timeblock' && effectiveEndTime && !reminder.triggerAtEnd) {
                    if (now > effectiveEndTime) continue;
                }

                const stopped = reminder.stopConditions.some(cond => checkStopCondition(fm, cond));
                if (stopped) continue;

                let finalTriggerBase = propertyTime;
                if (reminder.triggerAtEnd && effectiveEndTime) finalTriggerBase = effectiveEndTime;

                const isAllDaySafe = isAllDayEvent(propertyValue, fm);
                if (isAllDaySafe && reminder.allDayBaseTime) {
                    const match = reminder.allDayBaseTime.match(/^(\d{1,2}):(\d{2})$/);
                    if (match) {
                        const [_, h, m] = match;
                        finalTriggerBase = moment(finalTriggerBase).set({
                            hour: parseInt(h, 10), minute: parseInt(m, 10),
                            second: 0, millisecond: 0
                        }).valueOf();
                    }
                }

                let offsetMs = reminder.offsetMinutes * 60 * 1000;
                if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                    const durationMins = parseDuration(fm[reminder.smartOffsetProperty]);
                    const smartMs = durationMins * 60 * 1000;
                    offsetMs = reminder.smartOffsetOperator === 'add' ? smartMs : -smartMs;
                }

                const triggerTime = finalTriggerBase + offsetMs;
                if (now < triggerTime) continue;

                const diffMs = now - finalTriggerBase;
                const diffMins = Math.floor(diffMs / 60000);
                let diff = '';
                if (diffMins < 0) {
                    const absM = Math.abs(diffMins);
                    if (absM < 60) diff = `in ${absM} min`;
                    else if (absM < 1440) diff = `in ${Math.floor(absM / 60)}h ${absM % 60}m`;
                    else { const d = Math.floor(absM / 1440); diff = `in ${d}d ${Math.floor((absM % 1440) / 60)}h ${absM % 60}m`; }
                } else if (diffMins < 60) {
                    diff = `${diffMins} min ago`;
                } else if (diffMins < 1440) {
                    diff = `${Math.floor(diffMins / 60)}h ${diffMins % 60}m ago`;
                } else {
                    const d = Math.floor(diffMins / 1440);
                    diff = `${d}d ${Math.floor((diffMins % 1440) / 60)}h ${diffMins % 60}m ago`;
                }

                const vars: Record<string, string> = {
                    filename: file.basename,
                    time: moment(finalTriggerBase).format('HH:mm'),
                    remaining: diff,
                    duration: fm['duration'] || '',
                };
                overdueItems.push({
                    file,
                    reminder,
                    propertyTime: finalTriggerBase,
                    diff,
                    id: reminder.id,
                    title: formatTemplate(reminder.title, vars),
                    body: formatTemplate(reminder.body, vars),
                    snoozedUntil,
                });
            }
        }

        overdueItems.sort((a, b) => a.propertyTime - b.propertyTime);
        const seenKeys = new Set<string>();
        const deduplicated: OverdueItem[] = [];
        for (const item of overdueItems) {
            if (!seenKeys.has(item.file.path)) {
                seenKeys.add(item.file.path);
                deduplicated.push(item);
            }
        }
        return deduplicated;
    }

    async snoozeFile(file: TFile, minutes: number): Promise<void> {
        const snoozeKey = this.getSettings().snoozeProperty || 'reminderSnooze';
        const snoozeTimeStr = minutes > 0
            ? moment().add(minutes, 'minutes').format('YYYY-MM-DD HH:mm')
            : '';
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            fm[snoozeKey] = snoozeTimeStr;
        });
    }

    openFile(file: TFile): void {
        const leaf = this.app.workspace.getLeaf(false);
        if (leaf) void leaf.openFile(file);
    }

    async markFileComplete(file: TFile): Promise<void> {
        await this.app.fileManager.processFrontMatter(file, (fm) => { fm.status = 'complete'; });
    }

    async markFileWontDo(file: TFile): Promise<void> {
        await this.app.fileManager.processFrontMatter(file, (fm) => { fm.status = 'wont-do'; });
    }
}
