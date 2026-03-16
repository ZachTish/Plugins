import { TFile } from "obsidian";
import type { KanbanTaskReminderSettings } from "../types";

export interface KanbanCheckboxTaskItem {
    lineNumber: number;
    rawText: string;
    text: string;
    checked: boolean;
    propertyMap: Record<string, string>;
    scheduledDateToken: string | null;
    scheduledTimeToken: string | null;
}

const TASK_LINE_RE = /^[\t ]*-\s+\[([ xX])\]\s+(.*)$/;
const INLINE_PROP_RE = /\[([a-zA-Z0-9_-]+)::\s*([^\]]+)\]/g;
const KANBAN_DATE_RE = /@\{([^}]+)\}/;
const KANBAN_TIME_RE = /@@\{([^}]+)\}/;
const TASKS_EMOJI_DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?)/i;
const TASKS_EMOJI_SCHEDULED_RE = /⏳\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?)/i;
const TASKS_EMOJI_START_RE = /🛫\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?)/i;

export function isKanbanBoardFileFromFrontmatter(frontmatter: Record<string, unknown> | undefined): boolean {
    const fm = frontmatter || {};
    const value = String(fm["kanban-plugin"] ?? fm["kanbanPlugin"] ?? "").trim().toLowerCase();
    return value === "board";
}

function normalizeTaskText(raw: string): string {
    return String(raw || "")
        .replace(/@@\{[^}]*\}/g, "")
        .replace(/@\{[^}]*\}/g, "")
        .replace(INLINE_PROP_RE, "")
        .replace(/\s+#([^\s#]+)/g, "")
        .trim();
}

function extractInlineProperties(rawText: string): Record<string, string> {
    const map: Record<string, string> = {};
    INLINE_PROP_RE.lastIndex = 0;
    let match: RegExpExecArray | null = null;
    while ((match = INLINE_PROP_RE.exec(rawText)) !== null) {
        const key = String(match[1] ?? "").trim().toLowerCase();
        const value = String(match[2] ?? "").trim();
        if (!key || !value) continue;
        map[key] = value;
    }
    return map;
}

function combineKanbanDateTime(datePart: string, timePart: string | null): string {
    const d = String(datePart || "").trim();
    if (!d) return "";
    const t = String(timePart || "").trim();
    return t ? `${d} ${t}` : d;
}

export function parseKanbanCheckboxTasks(content: string): KanbanCheckboxTaskItem[] {
    const lines = String(content || "").split("\n");
    const tasks: KanbanCheckboxTaskItem[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(TASK_LINE_RE);
        if (!m) continue;
        const checked = String(m[1] || "").toLowerCase() === "x";
        const rawText = String(m[2] || "");
        const propertyMap = extractInlineProperties(rawText);
        const dateMatch = rawText.match(KANBAN_DATE_RE);
        const timeMatch = rawText.match(KANBAN_TIME_RE);
        tasks.push({
            lineNumber: i,
            rawText,
            text: normalizeTaskText(rawText),
            checked,
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
