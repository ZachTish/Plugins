import { App, TFile } from "obsidian";
import type { ExternalCalendarEvent, TPSControllerSettings } from "../types";
import {
    parseKanbanCheckboxTasks,
    isKanbanBoardFileFromFrontmatter,
    getKanbanTaskReminderPropertyValue,
    buildKanbanTaskSourceKey,
    type KanbanCheckboxTaskItem,
} from "./kanban-task-item-service";

export type ReminderTargetType = "file" | "kanban-task" | "external-event";

export interface ReminderEvaluationTarget {
    sourceKey: string;
    sourceType: ReminderTargetType;
    task?: KanbanCheckboxTaskItem;
    externalEvent?: ExternalCalendarEvent;
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
    if (target.sourceType === "external-event" && target.externalEvent) {
        const event = target.externalEvent;
        const durationMinutes = Math.max(1, Math.round((event.endDate.getTime() - event.startDate.getTime()) / 60000));
        const dateOnly = `${event.startDate.getFullYear()}-${String(event.startDate.getMonth() + 1).padStart(2, "0")}-${String(event.startDate.getDate()).padStart(2, "0")}`;
        const scheduledValue = event.isAllDay
            ? dateOnly
            : `${dateOnly} ${String(event.startDate.getHours()).padStart(2, "0")}:${String(event.startDate.getMinutes()).padStart(2, "0")}`;
        const frontmatter: Record<string, unknown> = {
            ...baseFrontmatter,
            title: event.title,
            scheduled: scheduledValue,
            [settings.startProperty || "scheduled"]: scheduledValue,
            timeEstimate: durationMinutes,
            [settings.endProperty || "timeEstimate"]: durationMinutes,
            allDay: event.isAllDay,
            externalEventId: event.id,
            [settings.eventIdKey || "externalEventId"]: event.id,
            tpsCalendarUid: event.uid || event.id,
            [settings.uidKey || "tpsCalendarUid"]: event.uid || event.id,
            tpsCalendarSourceUrl: event.sourceUrl || "",
            location: event.location || "",
            organizer: event.organizer || "",
            status: event.isCancelled ? "cancelled" : "scheduled",
        };
        return {
            frontmatter,
            propertyValue: frontmatter[reminderProperty],
        };
    }

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

export function buildReminderDisplayName(file: Pick<TFile, "basename">, target: ReminderEvaluationTarget): string {
    if (target.sourceType === "external-event" && target.externalEvent) {
        return target.externalEvent.title || "External calendar event";
    }

    let displayName = file.basename;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(displayName)) {
        displayName = displayName.replace(/ \d{4}-\d{2}-\d{2}$/, "");
    }
    if (target.sourceType === "kanban-task" && target.task?.text) {
        displayName = `${displayName}: ${target.task.text}`;
    }
    return displayName;
}
