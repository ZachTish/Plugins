import { App, TFile, WorkspaceLeaf, moment } from "obsidian";
import { NOTIFICATION_VIEW_TYPE } from "../views/notification-view";
import * as logger from "../logger";
import type { TPSControllerSettings, OverdueItem } from "../types";
import {
    parseDate, parseTimeRange, parseDuration, getEffectiveEndTime,
    formatTemplate, checkStopCondition, hasRequiredStatus,
    shouldIgnoreForReminder, isAllDayEvent,
} from "../utils/time-calculation-service";
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

                    const ctx = buildEffectiveReminderContextForTarget(target, fm, reminder.property, settings);
                    if (!ctx) continue;
                    const effectiveFm = ctx.frontmatter;
                    const propertyValue = ctx.propertyValue;

                    if (shouldIgnoreForReminder(file, cache, effectiveFm, reminder, ignorePaths, ignoreTags, ignoreStatuses)) continue;
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

                    const isAllDaySafe = isAllDayEvent(propertyValue, effectiveFm);
                    if (isAllDaySafe && reminder.allDayBaseTime) {
                        const match = reminder.allDayBaseTime.match(/^(\d{1,2}):(\d{2})$/);
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
                    if (now < triggerTime) continue;

                    const diff = this.formatTimeDiff(now - finalTriggerBase);
                    const vars: Record<string, string> = {
                        filename: buildReminderDisplayName(file, target),
                        time: moment(finalTriggerBase).format("HH:mm"),
                        remaining: diff,
                        duration: String(effectiveFm["duration"] ?? ""),
                    };
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
                        title: formatTemplate(reminder.title, vars),
                        body: formatTemplate(reminder.body, vars),
                        snoozedUntil,
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
    }

    private upsertInlineProperty(line: string, key: string, value: string): string {
        const taskMatch = line.match(/^([\t ]*-\s+\[[^\]]\]\s+)(.*)$/);
        if (!taskMatch) return line;
        const prefix = taskMatch[1];
        let body = taskMatch[2] ?? "";
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const propRe = new RegExp(`\\[${escaped}::\\s*[^\\]]*\\]`, "i");
        if (propRe.test(body)) {
            body = body.replace(propRe, `[${key}:: ${value}]`);
        } else {
            body = `${body.trimEnd()} [${key}:: ${value}]`;
        }
        return `${prefix}${body}`.trimEnd();
    }

    private setTaskCheckboxState(line: string, stateChar: " " | "x" | "-"): string {
        return line.replace(/^([\t ]*-\s+\[)[ xX-](\]\s+)/, `$1${stateChar}$2`);
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
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            fm[snoozeKey] = snoozeTimeStr;
        });
    }

    openFile(file: TFile): void {
        const leaf = this.app.workspace.getLeaf(false);
        if (leaf) void leaf.openFile(file);
    }

    async markFileComplete(file: TFile): Promise<void> {
        await this.app.fileManager.processFrontMatter(file, (fm) => { fm.status = "complete"; });
    }

    async markFileWontDo(file: TFile): Promise<void> {
        await this.app.fileManager.processFrontMatter(file, (fm) => { fm.status = "wont-do"; });
    }
}
