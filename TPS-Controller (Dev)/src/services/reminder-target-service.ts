import { App, TFile } from "obsidian";
import type { TPSControllerSettings } from "../types";
import {
    parseKanbanCheckboxTasks,
    isKanbanBoardFileFromFrontmatter,
    getKanbanTaskReminderPropertyValue,
    buildKanbanTaskSourceKey,
    type KanbanCheckboxTaskItem,
} from "./kanban-task-item-service";

export type ReminderTargetType = "file" | "kanban-task";

export interface ReminderEvaluationTarget {
    sourceKey: string;
    sourceType: ReminderTargetType;
    task?: KanbanCheckboxTaskItem;
}

export interface EffectiveReminderContext {
    frontmatter: Record<string, unknown>;
    propertyValue: unknown;
}

export async function buildReminderTargetsForFile(
    app: App,
    file: TFile,
    frontmatter: Record<string, unknown>,
    settings: TPSControllerSettings,
): Promise<ReminderEvaluationTarget[]> {
    const targets: ReminderEvaluationTarget[] = [];
    const includeFileTarget = settings.kanbanTaskReminders.includeBoardFileTarget || !isKanbanBoardFileFromFrontmatter(frontmatter);
    if (includeFileTarget) {
        targets.push({ sourceKey: file.path, sourceType: "file" });
    }

    if (!settings.kanbanTaskReminders.enabled) return targets;
    if (!isKanbanBoardFileFromFrontmatter(frontmatter)) return targets;

    let tasks: KanbanCheckboxTaskItem[] = [];
    try {
        const content = await app.vault.cachedRead(file);
        tasks = parseKanbanCheckboxTasks(content);
    } catch {
        tasks = [];
    }

    tasks.sort((a, b) => a.lineNumber - b.lineNumber);
    for (const task of tasks) {
        targets.push({
            sourceKey: buildKanbanTaskSourceKey(file, task.lineNumber),
            sourceType: "kanban-task",
            task,
        });
    }
    return targets;
}

export function buildEffectiveReminderContextForTarget(
    target: ReminderEvaluationTarget,
    baseFrontmatter: Record<string, unknown>,
    reminderProperty: string,
    settings: TPSControllerSettings,
): EffectiveReminderContext | null {
    if (target.sourceType !== "kanban-task" || !target.task) {
        return {
            frontmatter: baseFrontmatter,
            propertyValue: baseFrontmatter[reminderProperty],
        };
    }

    const taskValue = getKanbanTaskReminderPropertyValue(
        target.task,
        reminderProperty,
        settings.kanbanTaskReminders,
    );
    if (!taskValue) return null;

    const statusKey = settings.kanbanTaskReminders.statusProperty || "status";
    const statusValue = target.task.checked
        ? settings.kanbanTaskReminders.completeStatusValue
        : (target.task.propertyMap[statusKey] ?? baseFrontmatter[statusKey]);
    const frontmatter: Record<string, unknown> = {
        ...baseFrontmatter,
        ...target.task.propertyMap,
        [reminderProperty]: taskValue,
        [statusKey]: statusValue,
        taskText: target.task.text,
    };
    return {
        frontmatter,
        propertyValue: taskValue,
    };
}

export function buildReminderDisplayName(file: TFile, target: ReminderEvaluationTarget): string {
    let displayName = file.basename;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(displayName)) {
        displayName = displayName.replace(/ \d{4}-\d{2}-\d{2}$/, "");
    }
    if (target.sourceType === "kanban-task" && target.task?.text) {
        displayName = `${displayName}: ${target.task.text}`;
    }
    return displayName;
}
