import { TFile } from "obsidian";
import type { KanbanTaskReminderSettings } from "../types";

export interface KanbanCheckboxTaskItem {
    lineNumber: number;
    rawText: string;
    text: string;
    checked: boolean;
    checkboxState: string;
    propertyMap: Record<string, string>;
    scheduledDateToken: string | null;
    scheduledTimeToken: string | null;
}

const TASKS_EMOJI_DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?)/i;
const TASKS_EMOJI_SCHEDULED_RE = /⏳\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?)/i;
const TASKS_EMOJI_START_RE = /🛫\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?)/i;

export interface GcmTaskSemanticsApi {
    parseTaskLine?: (line: string) => {
        checkboxState: string | null;
        body: string;
        text: string;
        inlineProperties: Record<string, string>;
        scheduledDateToken: string | null;
        scheduledTimeToken: string | null;
    } | null;
}

export function isKanbanBoardFileFromFrontmatter(frontmatter: Record<string, unknown> | undefined): boolean {
    const fm = frontmatter || {};
    const value = String(fm["kanban-plugin"] ?? fm["kanbanPlugin"] ?? "").trim().toLowerCase();
    return value === "board";
}

function combineKanbanDateTime(datePart: string, timePart: string | null): string {
    const d = String(datePart || "").trim();
    if (!d) return "";
    const t = String(timePart || "").trim();
    return t ? `${d} ${t}` : d;
}

export function parseKanbanCheckboxTasks(content: string, semanticsApi?: GcmTaskSemanticsApi | null): KanbanCheckboxTaskItem[] {
    const lines = String(content || "").split("\n");
    const tasks: KanbanCheckboxTaskItem[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const parsed = semanticsApi?.parseTaskLine?.(line) || null;
        if (parsed) {
            const checkboxState = String(parsed.checkboxState || "").trim();
            tasks.push({
                lineNumber: i,
                rawText: String(parsed.body || ""),
                text: String(parsed.text || "").trim() || String(parsed.body || "").trim(),
                checked: checkboxState.toLowerCase() === "x",
                checkboxState,
                propertyMap: parsed.inlineProperties || {},
                scheduledDateToken: parsed.scheduledDateToken || null,
                scheduledTimeToken: parsed.scheduledTimeToken || null,
            });
            continue;
        }

        const m = line.match(/^[\t ]*(?:[-*+]|\d+\.)\s+\[([^\]]*)\]\s+(.*)$/);
        if (!m) continue;
        const checkboxState = String(m[1] || "").trim();
        const checked = checkboxState.toLowerCase() === "x";
        const rawText = String(m[2] || "");
        const propertyMap: Record<string, string> = {};
        for (const match of rawText.matchAll(/\[([a-zA-Z0-9_-]+)::\s*([^\]]+)\]/g)) {
            const key = String(match[1] ?? "").trim().toLowerCase();
            const value = String(match[2] ?? "").trim();
            if (key && value) propertyMap[key] = value;
        }
        const dateMatch = rawText.match(/@\{([^}]+)\}/);
        const timeMatch = rawText.match(/@@\{([^}]+)\}/);
        tasks.push({
            lineNumber: i,
            rawText,
            text: rawText
                .replace(/@@\{[^}]*\}/g, "")
                .replace(/@\{[^}]*\}/g, "")
                .replace(/\[[a-zA-Z0-9_-]+::\s*[^\]]+\]/g, "")
                .replace(/\s+#([^\s#]+)/g, "")
                .trim(),
            checked,
            checkboxState,
            propertyMap,
            scheduledDateToken: dateMatch?.[1]?.trim() || null,
            scheduledTimeToken: timeMatch?.[1]?.trim() || null,
        });
    }

    return tasks;
}

const DEFAULT_SETTINGS: KanbanTaskReminderSettings = {
    enabled: true,
    includeBoardFileTarget: true,
    parseInlineProperties: true,
    parseKanbanDateTokens: true,
    parseTasksEmojiDates: true,
    statusProperty: "status",
    completeStatusValue: "complete",
    wontDoStatusValue: "wont-do",
    scheduledPropertyAliases: ["scheduled", "start"],
    duePropertyAliases: ["due", "duedate", "due-date"],
    startPropertyAliases: ["start", "startdate", "start-date"],
};

function normalizeAliasSet(values: string[]): Set<string> {
    return new Set(values.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean));
}

export function getKanbanTaskReminderPropertyValue(
    task: KanbanCheckboxTaskItem,
    reminderProperty: string,
    options?: KanbanTaskReminderSettings,
): string | null {
    const cfg = { ...DEFAULT_SETTINGS, ...(options || {}) };
    const prop = String(reminderProperty || "").trim().toLowerCase();
    if (!prop) return null;

    if (cfg.parseInlineProperties) {
        const inline = task.propertyMap[prop];
        if (inline) return inline;
    }

    const scheduledAliases = normalizeAliasSet(cfg.scheduledPropertyAliases);
    const dueAliases = normalizeAliasSet(cfg.duePropertyAliases);
    const startAliases = normalizeAliasSet(cfg.startPropertyAliases);

    if (cfg.parseKanbanDateTokens && scheduledAliases.has(prop)) {
        if (!task.scheduledDateToken) return null;
        return combineKanbanDateTime(task.scheduledDateToken, task.scheduledTimeToken);
    }

    if (cfg.parseTasksEmojiDates && dueAliases.has(prop)) {
        const dueMatch = task.rawText.match(TASKS_EMOJI_DUE_RE);
        if (dueMatch?.[1]) return dueMatch[1].trim();
    }

    if (cfg.parseTasksEmojiDates && scheduledAliases.has(prop)) {
        const schedMatch = task.rawText.match(TASKS_EMOJI_SCHEDULED_RE);
        if (schedMatch?.[1]) return schedMatch[1].trim();
    }

    if (cfg.parseTasksEmojiDates && startAliases.has(prop)) {
        const startMatch = task.rawText.match(TASKS_EMOJI_START_RE);
        if (startMatch?.[1]) return startMatch[1].trim();
    }

    return null;
}

export function buildKanbanTaskSourceKey(file: TFile, lineNumber: number): string {
    return `${file.path}::kanban-task:${lineNumber}`;
}
