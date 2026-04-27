import { App, TFile, normalizePath } from "obsidian";
import * as logger from "../logger";
import type { ExternalCalendarEvent, TPSControllerSettings } from "../types";
import { getDailyNoteResolver } from "../utils/daily-note-resolver";
import {
    parseKanbanCheckboxTasks,
    isKanbanBoardFileFromFrontmatter,
    getKanbanTaskReminderPropertyValue,
    buildKanbanTaskSourceKey,
    type GcmTaskSemanticsApi,
    type KanbanCheckboxTaskItem,
} from "./kanban-task-item-service";

export type ReminderTargetType = "file" | "kanban-task" | "task-item" | "external-event";

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

    const isKanbanBoard = isKanbanBoardFileFromFrontmatter(frontmatter);
    const isTaskListFile = isConfiguredTaskListReminderFile(app, file, settings);

    if (!isKanbanBoard && !isTaskListFile) return targets;
    if (!settings.kanbanTaskReminders.enabled && !isTaskListFile) return targets;

    let tasks: KanbanCheckboxTaskItem[] = [];
    try {
        const content = await app.vault.cachedRead(file);
        tasks = parseKanbanCheckboxTasks(content, getGcmTaskSemanticsApi(app));
    } catch {
        tasks = [];
    }

    if (tasks.length === 0 && (isTaskListFile || isKanbanBoard)) {
        const anyCheckbox = (await app.vault.cachedRead(file)).split(/\r?\n/);
        const checkboxLines = anyCheckbox.filter(l => /^\s*(?:[-*+]|\d+\.)\s*\[([^\]]*)\]/.test(l));
        if (checkboxLines.length > 0 && settings.enableLogging) {
            logger.warn(`[ReminderTargets] ${file.path}: isTaskListFile=${isTaskListFile} isKanbanBoard=${isKanbanBoard} found ${checkboxLines.length} checkbox lines but parseKanbanCheckboxTasks returned 0`);
        }
    }

    tasks.sort((a, b) => a.lineNumber - b.lineNumber);
    if (tasks.length > 0 && settings.enableLogging) {
        logger.log(`[ReminderTargets] ${file.path}: found ${tasks.length} task-item targets (isKanbanBoard=${isKanbanBoard}, isTaskListFile=${isTaskListFile})`);
    }
    for (const task of tasks) {
        targets.push({
            sourceKey: isKanbanBoard
                ? buildKanbanTaskSourceKey(file, task.lineNumber)
                : `${file.path}::task-item:${task.lineNumber}`,
            sourceType: isKanbanBoard ? "kanban-task" : "task-item",
            task,
        });
    }
    return targets;
}

function isConfiguredTaskListReminderFile(app: App, file: TFile, settings: TPSControllerSettings): boolean {
    const normalizedFilePath = normalizePath(file.path);
    const taskListPaths = new Set(
        (settings.externalCalendars || [])
            .filter((calendar) => (calendar.autoCreateMode || "note") === "task-list")
            .map((calendar) => normalizePath(String(calendar.autoCreateTaskListPath || "").trim()))
            .filter(Boolean),
    );
    if (taskListPaths.has(normalizedFilePath)) return true;

    const hasDailyFallbackTaskLists = (settings.externalCalendars || []).some(
        (calendar) => (calendar.autoCreateMode || "note") === "task-list" && !String(calendar.autoCreateTaskListPath || "").trim(),
    );
    if (!hasDailyFallbackTaskLists) return false;

    const dailyResolver = getDailyNoteResolver(app);
    if (!dailyResolver.isDailyNoteBasename(file.basename)) return false;

    const dailyFolderNorm = normalizePath(String(dailyResolver.folder || "").trim());
    if (!dailyFolderNorm) return true;
    return normalizePath(file.parent?.path || "") === dailyFolderNorm;
}

export function buildEffectiveReminderContextForTarget(
    app: App,
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
        if (settings.scheduledDateProperty) {
            frontmatter[settings.scheduledDateProperty] = scheduledValue.split(" ")[0];
        }
        if (settings.scheduledStartProperty) {
            frontmatter[settings.scheduledStartProperty] = scheduledValue;
        }
        if (settings.scheduledEndProperty) {
            frontmatter[settings.scheduledEndProperty] = event.isAllDay
                ? scheduledValue
                : `${dateOnly} ${String(event.endDate.getHours()).padStart(2, "0")}:${String(event.endDate.getMinutes()).padStart(2, "0")}`;
        }
        return {
            frontmatter,
            propertyValue: frontmatter[reminderProperty],
        };
    }

    if ((target.sourceType !== "kanban-task" && target.sourceType !== "task-item") || !target.task) {
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
    const inlineStatus = target.task.propertyMap[statusKey];
    const checkboxStatus = getMappedStatusForCheckboxState(app, target.task.checkboxState, settings);
    const mappedStatus = inlineStatus
        ?? checkboxStatus
        ?? (target.task.checked ? settings.kanbanTaskReminders.completeStatusValue : undefined);
    if (settings.enableLogging) {
        logger.log(`[ReminderTargets] task-item context: line ${target.task.lineNumber}, checkbox="${target.task.checkboxState}", inlineStatus="${inlineStatus ?? ''}", checkboxStatus="${checkboxStatus ?? ''}", mappedStatus="${mappedStatus ?? ''}", property="${reminderProperty}"="${taskValue}"`);
    }
    const frontmatter: Record<string, unknown> = {
        ...baseFrontmatter,
        ...target.task.propertyMap,
        [reminderProperty]: taskValue,
        [statusKey]: mappedStatus,
        taskText: target.task.text,
    };
    if (/[T ]\d{1,2}:\d{2}/.test(String(taskValue))) {
        frontmatter.allDay = false;
    }
    if (!inlineStatus && mappedStatus) {
        delete frontmatter.icon;
        delete frontmatter.color;
    }
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
    if ((target.sourceType === "kanban-task" || target.sourceType === "task-item") && target.task?.text) {
        displayName = target.task.text;
    }
    return displayName;
}

function getMappedStatusForCheckboxState(app: App, checkboxState: string, settings: TPSControllerSettings): string | undefined {
    const normalizedState = String(checkboxState || " ").trim() || " ";
    const gcm = (app as any)?.plugins?.getPlugin?.('tps-global-context-menu')
        ?? (app as any)?.plugins?.plugins?.['TPS-Global-Context-Menu (Dev)'];
    const mappings = Array.isArray(gcm?.settings?.linkedSubitemCheckboxMappings)
        ? gcm.settings.linkedSubitemCheckboxMappings
        : [];
    const bracketedState = normalizedState.startsWith('[') ? normalizedState : `[${normalizedState}]`;
    const mapping = mappings.find((entry: any) => String(entry?.checkboxState || '').trim() === bracketedState);
    const mapped = String(mapping?.statuses?.[0] || '').trim();
    if (mapped) return mapped;

    if (normalizedState.toLowerCase() === 'x') return settings.kanbanTaskReminders.completeStatusValue || 'complete';
    if (normalizedState === '-') return settings.kanbanTaskReminders.wontDoStatusValue || 'wont-do';
    if (normalizedState === '/') return 'working';
    if (normalizedState === '?') return 'holding';
    return 'todo';
}

function getGcmTaskSemanticsApi(app: App): GcmTaskSemanticsApi | null {
    const gcm =
        (app as any)?.plugins?.getPlugin?.('tps-global-context-menu') ??
        (app as any)?.plugins?.plugins?.['TPS-Global-Context-Menu (Dev)'];
    const api = gcm?.api ?? gcm;
    if (!api?.parseTaskLine && !api?.parseInlineProperties && !api?.cleanTaskText) return null;
    return api as GcmTaskSemanticsApi;
}
