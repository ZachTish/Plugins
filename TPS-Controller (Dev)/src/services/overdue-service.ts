import { App, TFile, WorkspaceLeaf, moment } from "obsidian";
import { NOTIFICATION_VIEW_TYPE } from "../views/notification-view";
import { NotificationItemsModal } from "../modals/notification-modal";
import * as logger from "../logger";
import type { TPSControllerSettings, OverdueItem } from "../types";
import {
    parseDate, parseTimeRange, parseDuration, getEffectiveEndTime,
    formatTemplate, checkStopCondition, hasRequiredStatus,
    shouldIgnoreForReminder, isAllDayEvent, hasExplicitTimeInValue,
} from "../utils/time-calculation-service";
import { CheckboxPatterns } from "./checkbox-pattern-service";
import {
    buildReminderTargetsForFile,
    buildEffectiveReminderContextForTarget,
    buildReminderDisplayName,
} from "./reminder-target-service";

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
        const settings = this.getSettings();
        if ((settings.notificationPresentationMode || "sidebar") === "modal") {
            new NotificationItemsModal(this.app, {
                settings,
                getOverdueItems: () => this.getOverdueItems(),
                snoozeFile: (file, minutes) => this.snoozeFile(file, minutes),
                snoozeOverdueItem: (item, minutes) => this.snoozeItem(item, minutes),
                openFile: (file) => this.openFile(file),
                markFileComplete: (file) => this.markFileComplete(file),
                markFileWontDo: (file) => this.markFileWontDo(file),
                markOverdueItemComplete: (item) => this.markItemComplete(item),
                markOverdueItemWontDo: (item) => this.markItemWontDo(item),
            }).open();
            return;
        }
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
                logger.error("[TPS Controller] Failed to get right leaf");
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
        const snoozeKey = settings.snoozeProperty || "reminderSnooze";
        const files = [...this.app.vault.getMarkdownFiles()].sort((a, b) => a.path.localeCompare(b.path));

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
            const targets = await buildReminderTargetsForFile(this.app, file, fm, settings);

            for (const target of targets) {
                for (const reminder of reminders) {
                    if (!reminder.enabled) continue;

                    const ctx = buildEffectiveReminderContextForTarget(this.app, target, fm, reminder.property, settings);
                    if (!ctx) continue;
                    const effectiveFm = ctx.frontmatter;
                    const propertyValue = ctx.propertyValue;

                    if (shouldIgnoreForReminder(file, cache, effectiveFm, reminder, ignorePaths, ignoreTags, ignoreStatuses,
                        { skipPathIgnore: target.sourceType === "task-item" || target.sourceType === "kanban-task", skipTagIgnore: target.sourceType === "task-item" || target.sourceType === "kanban-task" })) continue;
                    if (!hasRequiredStatus(effectiveFm, reminder)) continue;

                    let snoozedUntil: number | undefined;
                    const snoozeVal = effectiveFm[snoozeKey];
                    if (snoozeVal) {
                        const snoozeTime = parseDate(snoozeVal);
                        if (snoozeTime && now < snoozeTime) snoozedUntil = snoozeTime;
                    }

                    const { start: propertyTime, end: rangeEndTime } = parseTimeRange(propertyValue);
                    if (!propertyTime) continue;
                    const effectiveEndTime = getEffectiveEndTime(propertyTime, rangeEndTime, effectiveFm);
                    if (reminder.mode === "timeblock" && effectiveEndTime && !reminder.triggerAtEnd && now > effectiveEndTime) {
                        continue;
                    }

                    const stopped = reminder.stopConditions.some((cond) => checkStopCondition(effectiveFm, cond));
                    if (stopped) continue;

                    let finalTriggerBase = propertyTime;
                    if (reminder.triggerAtEnd && effectiveEndTime) finalTriggerBase = effectiveEndTime;

                    const isAllDaySafe = isAllDayEvent(propertyValue, effectiveFm) &&
                        (!hasExplicitTimeInValue(propertyValue) || String(effectiveFm?.allDay ?? '').toLowerCase() === 'true');

                    // Respect allDayFilter — must match event's all-day nature before continuing.
                    if (reminder.allDayFilter && reminder.allDayFilter !== 'any') {
                        if (reminder.allDayFilter === 'true' && !isAllDaySafe) continue;
                        if (reminder.allDayFilter === 'false' && isAllDaySafe) continue;
                    }
                    const effectiveAllDayBaseTime = reminder.allDayBaseTime || settings.defaultAllDayBaseTime;
                    if (isAllDaySafe && effectiveAllDayBaseTime) {
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

                    let offsetMs = reminder.offsetMinutes * 60 * 1000;
                    if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                        const durationMins = parseDuration(effectiveFm[reminder.smartOffsetProperty]);
                        const smartMs = durationMins * 60 * 1000;
                        offsetMs = reminder.smartOffsetOperator === "add" ? smartMs : -smartMs;
                    }

                    const triggerTime = finalTriggerBase + offsetMs;
                    // Never show items before their trigger time — applies to both timed and all-day events.
                    if (now < triggerTime) continue;
                    // For all-day events, include past days too — if stop conditions haven't been met the
                    // item is still "open" and should surface until explicitly completed or snoozed.

                    const diff = this.formatTimeDiff(now - finalTriggerBase);
                    const vars: Record<string, string> = {
                        filename: buildReminderDisplayName(file, target),
                        time: moment(finalTriggerBase).format("HH:mm"),
                        remaining: diff,
                        duration: String(effectiveFm["duration"] ?? ""),
                    };
                    const isTaskItem = target.sourceType === 'task-item' || target.sourceType === 'kanban-task';
                    overdueItems.push({
                        file,
                        reminder,
                        propertyTime: finalTriggerBase,
                        diff,
                        id: reminder.id,
                        sourceKey: target.sourceKey,
                        sourceType: target.sourceType,
                        taskLineNumber: target.task?.lineNumber,
                        taskText: target.task?.text,
                        checkboxState: target.task?.checkboxState,
                        title: formatTemplate(reminder.title, vars),
                        body: formatTemplate(reminder.body, vars),
                        snoozedUntil,
                        isAllDay: isAllDaySafe,
                        status: String(effectiveFm[this.getSettings().statusKey] ?? effectiveFm['status'] ?? ''),
                        icon: isTaskItem ? '' : (effectiveFm['icon'] ? String(effectiveFm['icon']) : ''),
                        color: isTaskItem ? '' : (effectiveFm['color'] ? String(effectiveFm['color']) : ''),
                    });
                }
            }
        }

        overdueItems.sort((a, b) => {
            const delta = a.propertyTime - b.propertyTime;
            if (delta !== 0) return delta;
            return String(a.sourceKey || a.file.path).localeCompare(String(b.sourceKey || b.file.path));
        });

        const seenKeys = new Set<string>();
        const deduplicated: OverdueItem[] = [];
        for (const item of overdueItems) {
            const key = item.sourceKey || item.file.path;
            if (seenKeys.has(key)) continue;
            seenKeys.add(key);
            deduplicated.push(item);
        }

        // Annotate each deduplicated item with its next upcoming trigger time.
        // Two-phase approach:
        // 1. First check if the CURRENT reminder (that created this item) will fire again
        // 2. If not, show when the next DIFFERENT reminder will start
        for (const item of deduplicated) {
            const cache = this.app.metadataCache.getFileCache(item.file);
            const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
            
            const currentReminderId = item.reminder.id;
            const currentReminderLabel = item.reminder.label || item.reminder.id;
            
            let nextTime: number | undefined;
            let nextLabel: string | undefined;
            let isRepeatingCurrent = false;
            let intervalMins: number | undefined;

            const target: import('./reminder-target-service').ReminderEvaluationTarget = {
                sourceKey: item.sourceKey || item.file.path,
                sourceType: item.sourceType || 'file',
                task: item.taskLineNumber !== undefined ? { lineNumber: item.taskLineNumber, text: item.taskText || '', rawText: item.taskText || '', checked: false, checkboxState: ' ', propertyMap: {}, scheduledDateToken: null, scheduledTimeToken: null } as any : undefined,
            };

            // PHASE 1: Check if the CURRENT reminder will fire again
            const currentReminder = reminders.find(r => r.id === currentReminderId);
            if (currentReminder?.enabled) {
                const reminder = currentReminder;
                const ctx = buildEffectiveReminderContextForTarget(this.app, target, fm, reminder.property, settings);
                if (ctx && 
                    !shouldIgnoreForReminder(item.file, cache, ctx.frontmatter, reminder, ignorePaths, ignoreTags, ignoreStatuses,
                        { skipPathIgnore: target.sourceType === "task-item" || target.sourceType === "kanban-task", skipTagIgnore: target.sourceType === "task-item" || target.sourceType === "kanban-task" }) &&
                    hasRequiredStatus(ctx.frontmatter, reminder) &&
                    !reminder.stopConditions.some((cond) => checkStopCondition(ctx.frontmatter, cond))) {
                    
                    const { start: pt, end: ret } = parseTimeRange(ctx.propertyValue);
                    if (pt) {
                        const eet = getEffectiveEndTime(pt, ret, ctx.frontmatter);
                        let base = pt;
                        if (reminder.triggerAtEnd && eet) base = eet;
                        const isAllDayCtx = isAllDayEvent(ctx.propertyValue, ctx.frontmatter) &&
                            (!hasExplicitTimeInValue(ctx.propertyValue) || String(ctx.frontmatter?.allDay ?? '').toLowerCase() === 'true');
                        if (reminder.allDayFilter && reminder.allDayFilter !== 'any') {
                            if ((reminder.allDayFilter === 'true' && !isAllDayCtx) ||
                                (reminder.allDayFilter === 'false' && isAllDayCtx)) {
                                // Skip
                            } else {
                                if (isAllDayCtx) {
                                    const effectiveBase = reminder.allDayBaseTime || settings.defaultAllDayBaseTime;
                                    if (effectiveBase) {
                                        const m = effectiveBase.match(/^(\d{1,2}):(\d{2})$/);
                                        if (m) {
                                            base = moment(base).set({
                                                hour: parseInt(m[1], 10),
                                                minute: parseInt(m[2], 10),
                                                second: 0,
                                                millisecond: 0,
                                            }).valueOf();
                                        }
                                    }
                                }
                                let offMs = reminder.offsetMinutes * 60 * 1000;
                                if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                                    const dm = parseDuration(ctx.frontmatter[reminder.smartOffsetProperty]);
                                    const sm = dm * 60 * 1000;
                                    offMs = reminder.smartOffsetOperator === 'add' ? sm : -sm;
                                }
                                const tTime = base + offMs;
                                const isRepeating = !!(reminder.repeatUntilComplete && reminder.repeatIntervalMinutes > 0);
                                
                                if (isRepeating) {
                                    // Repeating reminder - compute next occurrence
                                    const intervalMs = (reminder.repeatIntervalMinutes || 0) * 60 * 1000;
                                    let nextRepeat = tTime;
                                    if (intervalMs > 0 && nextRepeat <= now) {
                                        const elapsed = now - nextRepeat;
                                        const cycles = Math.floor(elapsed / intervalMs) + 1;
                                        nextRepeat = nextRepeat + cycles * intervalMs;
                                    }
                                    nextTime = nextRepeat;
                                    nextLabel = currentReminderLabel;
                                    isRepeatingCurrent = true;
                                    intervalMins = reminder.repeatIntervalMinutes;
                                } else if (now < tTime) {
                                    // Future non-repeating trigger
                                    nextTime = tTime;
                                    nextLabel = currentReminderLabel;
                                }
                            }
                        } else {
                            // No allDayFilter restriction
                            if (isAllDayCtx) {
                                const effectiveBase = reminder.allDayBaseTime || settings.defaultAllDayBaseTime;
                                if (effectiveBase) {
                                    const m = effectiveBase.match(/^(\d{1,2}):(\d{2})$/);
                                    if (m) {
                                        base = moment(base).set({
                                            hour: parseInt(m[1], 10),
                                            minute: parseInt(m[2], 10),
                                            second: 0,
                                            millisecond: 0,
                                        }).valueOf();
                                    }
                                }
                            }
                            let offMs = reminder.offsetMinutes * 60 * 1000;
                            if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                                const dm = parseDuration(ctx.frontmatter[reminder.smartOffsetProperty]);
                                const sm = dm * 60 * 1000;
                                offMs = reminder.smartOffsetOperator === 'add' ? sm : -sm;
                            }
                            const tTime = base + offMs;
                            const isRepeating = !!(reminder.repeatUntilComplete && reminder.repeatIntervalMinutes > 0);
                            
                            if (isRepeating) {
                                // Repeating reminder - compute next occurrence
                                const intervalMs = (reminder.repeatIntervalMinutes || 0) * 60 * 1000;
                                let nextRepeat = tTime;
                                if (intervalMs > 0 && nextRepeat <= now) {
                                    const elapsed = now - nextRepeat;
                                    const cycles = Math.floor(elapsed / intervalMs) + 1;
                                    nextRepeat = nextRepeat + cycles * intervalMs;
                                }
                                nextTime = nextRepeat;
                                nextLabel = currentReminderLabel;
                                isRepeatingCurrent = true;
                                intervalMins = reminder.repeatIntervalMinutes;
                            } else if (now < tTime) {
                                // Future non-repeating trigger
                                nextTime = tTime;
                                nextLabel = currentReminderLabel;
                            }
                        }
                    }
                }
            }

            // PHASE 2: If current reminder won't fire again, look for next DIFFERENT reminder
            if (nextTime === undefined) {
                for (const reminder of reminders) {
                    if (!reminder.enabled) continue;
                    // Skip the current reminder - we want to see what's NEXT
                    if (reminder.id === currentReminderId) continue;
                    const ctx = buildEffectiveReminderContextForTarget(this.app, target, fm, reminder.property, settings);
                    if (!ctx) continue;
                    if (shouldIgnoreForReminder(item.file, cache, ctx.frontmatter, reminder, ignorePaths, ignoreTags, ignoreStatuses,
                        { skipPathIgnore: target.sourceType === "task-item" || target.sourceType === "kanban-task", skipTagIgnore: target.sourceType === "task-item" || target.sourceType === "kanban-task" })) continue;
                    if (!hasRequiredStatus(ctx.frontmatter, reminder)) continue;
                    if (reminder.stopConditions.some((cond) => checkStopCondition(ctx.frontmatter, cond))) continue;
                    const { start: pt, end: ret } = parseTimeRange(ctx.propertyValue);
                    if (!pt) continue;
                    const eet = getEffectiveEndTime(pt, ret, ctx.frontmatter);
                    let base = pt;
                    if (reminder.triggerAtEnd && eet) base = eet;
                    const isAllDayCtx = isAllDayEvent(ctx.propertyValue, ctx.frontmatter) &&
                        (!hasExplicitTimeInValue(ctx.propertyValue) || String(ctx.frontmatter?.allDay ?? '').toLowerCase() === 'true');
                    if (reminder.allDayFilter && reminder.allDayFilter !== 'any') {
                        if (reminder.allDayFilter === 'true' && !isAllDayCtx) continue;
                        if (reminder.allDayFilter === 'false' && isAllDayCtx) continue;
                    }
                    if (isAllDayCtx) {
                        const effectiveBase = reminder.allDayBaseTime || settings.defaultAllDayBaseTime;
                        if (effectiveBase) {
                            const m = effectiveBase.match(/^(\d{1,2}):(\d{2})$/);
                            if (m) {
                                base = moment(base).set({
                                    hour: parseInt(m[1], 10),
                                    minute: parseInt(m[2], 10),
                                    second: 0,
                                    millisecond: 0,
                                }).valueOf();
                            }
                        }
                    }
                    let offMs = reminder.offsetMinutes * 60 * 1000;
                    if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                        const dm = parseDuration(ctx.frontmatter[reminder.smartOffsetProperty]);
                        const sm = dm * 60 * 1000;
                        offMs = reminder.smartOffsetOperator === 'add' ? sm : -sm;
                    }
                    const tTime = base + offMs;
                    
                    // Only consider FUTURE triggers (not currently firing)
                    if (now < tTime) {
                        if (nextTime === undefined || tTime < nextTime) {
                            nextTime = tTime;
                            nextLabel = reminder.label || reminder.id;
                        }
                    }
                }
            }
            
            // Set the annotation fields
            if (nextTime !== undefined) {
                item.nextTriggerTime = nextTime;
                item.nextRuleLabel = nextLabel;
                item.isRepeating = isRepeatingCurrent;
                if (isRepeatingCurrent) {
                    item.nextReminderIntervalMinutes = intervalMins;
                }
            }
        }

        return deduplicated;
    }

    private formatTimeDiff(diffMs: number): string {
        const diffMins = Math.floor(diffMs / 60000);
        if (diffMins < 0) {
            const absM = Math.abs(diffMins);
            if (absM < 60) return `in ${absM} min`;
            if (absM < 1440) return `in ${Math.floor(absM / 60)}h ${absM % 60}m`;
            const d = Math.floor(absM / 1440);
            return `in ${d}d ${Math.floor((absM % 1440) / 60)}h ${absM % 60}m`;
        }
        if (diffMins < 60) return `${diffMins} min ago`;
        if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ${diffMins % 60}m ago`;
        const d = Math.floor(diffMins / 1440);
        return `${d}d ${Math.floor((diffMins % 1440) / 60)}h ${diffMins % 60}m ago`;
    }

    private async updateKanbanTaskLine(
        file: TFile,
        lineNumber: number,
        updater: (line: string) => string,
    ): Promise<void> {
        const content = await this.app.vault.cachedRead(file);
        const lines = content.split("\n");
        if (lineNumber < 0 || lineNumber >= lines.length) return;
        const oldLine = lines[lineNumber];
        const nextLine = updater(oldLine);
        if (!nextLine || nextLine === oldLine) return;
        lines[lineNumber] = nextLine;
        await this.app.vault.modify(file, lines.join("\n"));
        (this.app.workspace as any)?.trigger?.("tps-task-line-updated", {
            path: file.path,
            lineNumber,
        });
    }

    private upsertInlineProperty(line: string, key: string, value: string): string {
        const taskMatch = line.match(CheckboxPatterns.CHECKBOX_LINE_CAPTURE);
        if (!taskMatch) return line;
        const prefix = taskMatch[1];
        let body = taskMatch[3] ?? "";
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const propRe = new RegExp(`\\[${escaped}::\\s*[^\\]]*\\]`, "i");
        if (propRe.test(body)) {
            body = body.replace(propRe, `[${key}:: ${value}]`);
        } else {
            body = `${body.trimEnd()} [${key}:: ${value}]`;
        }
        return `${prefix}[${taskMatch[2]}]${body}`.trimEnd();
    }

    private setTaskCheckboxState(line: string, stateChar: " " | "x" | "-"): string {
        return line.replace(CheckboxPatterns.CHECKBOX_LINE_CAPTURE, `$1[${stateChar}]$3`);
    }

    async snoozeItem(item: OverdueItem, minutes: number): Promise<void> {
        const settings = this.getSettings();
        const snoozeKey = settings.snoozeProperty || "reminderSnooze";
        const snoozeTimeStr = minutes > 0
            ? moment().add(minutes, "minutes").format("YYYY-MM-DD HH:mm")
            : "";
        if (item.sourceType === "kanban-task" && typeof item.taskLineNumber === "number") {
            await this.updateKanbanTaskLine(item.file, item.taskLineNumber, (line) =>
                this.upsertInlineProperty(line, snoozeKey, snoozeTimeStr)
            );
            return;
        }
        await this.snoozeFile(item.file, minutes);
    }

    async markItemComplete(item: OverdueItem): Promise<void> {
        const settings = this.getSettings();
        const statusKey = settings.kanbanTaskReminders.statusProperty || "status";
        const value = settings.kanbanTaskReminders.completeStatusValue || "complete";
        if (item.sourceType === "kanban-task" && typeof item.taskLineNumber === "number") {
            await this.updateKanbanTaskLine(item.file, item.taskLineNumber, (line) =>
                this.setTaskCheckboxState(this.upsertInlineProperty(line, statusKey, value), "x")
            );
            return;
        }
        await this.markFileComplete(item.file);
    }

    async markItemWontDo(item: OverdueItem): Promise<void> {
        const settings = this.getSettings();
        const statusKey = settings.kanbanTaskReminders.statusProperty || "status";
        const value = settings.kanbanTaskReminders.wontDoStatusValue || "wont-do";
        if (item.sourceType === "kanban-task" && typeof item.taskLineNumber === "number") {
            await this.updateKanbanTaskLine(item.file, item.taskLineNumber, (line) =>
                this.setTaskCheckboxState(this.upsertInlineProperty(line, statusKey, value), "-")
            );
            return;
        }
        await this.markFileWontDo(item.file);
    }

    async snoozeFile(file: TFile, minutes: number): Promise<void> {
        const snoozeKey = this.getSettings().snoozeProperty || "reminderSnooze";
        const snoozeTimeStr = minutes > 0
            ? moment().add(minutes, "minutes").format("YYYY-MM-DD HH:mm")
            : "";
        const gcmApi = (this.app as any)?.plugins?.getPlugin?.('tps-global-context-menu')?.api;
        if (!gcmApi?.applyCalendarFrontmatterMutation) {
            throw new Error('TPS Global Context Menu API unavailable for overdue snooze mutation');
        }
        await gcmApi.applyCalendarFrontmatterMutation({ file, updates: { [snoozeKey]: snoozeTimeStr }, folderPath: file.parent?.path || '/', userInitiated: true });
    }

    openFile(file: TFile): void {
        const leaf = this.app.workspace.getLeaf(false);
        if (leaf) void leaf.openFile(file);
    }

    private getCompletionTimestamp(): string {
        return moment().format('YYYY-MM-DD HH:mm:ss');
    }

    async markFileComplete(file: TFile): Promise<void> {
        const now = this.getCompletionTimestamp();
        const gcmApi = (this.app as any)?.plugins?.getPlugin?.('tps-global-context-menu')?.api;
        if (!gcmApi?.applyCalendarFrontmatterMutation) {
            throw new Error('TPS Global Context Menu API unavailable for overdue completion mutation');
        }
        await gcmApi.applyCalendarFrontmatterMutation({ file, updates: { status: 'complete', completedDate: now }, folderPath: file.parent?.path || '/', userInitiated: true });
    }

    async markFileWontDo(file: TFile): Promise<void> {
        const now = this.getCompletionTimestamp();
        const gcmApi = (this.app as any)?.plugins?.getPlugin?.('tps-global-context-menu')?.api;
        if (!gcmApi?.applyCalendarFrontmatterMutation) {
            throw new Error('TPS Global Context Menu API unavailable for overdue wont-do mutation');
        }
        await gcmApi.applyCalendarFrontmatterMutation({ file, updates: { status: 'wont-do', completedDate: now }, folderPath: file.parent?.path || '/', userInitiated: true });
    }
}
