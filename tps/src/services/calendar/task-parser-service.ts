import { App } from "obsidian";

/**
 * A parsed inline task item extracted from a vault note.
 */
export interface ParsedTaskItem {
    /** Task text with date emojis stripped. */
    text: string;
    /** Vault-relative file path. */
    filePath: string;
    /** 0-based line number within the source file. */
    lineNumber: number;
    /** True if the checkbox status is `[x]` or `[X]`. */
    isCompleted: boolean;
    /** Parsed value of the 📅 due-date annotation, or null. */
    dueDate: Date | null;
    /** Parsed value of the ⏳ scheduled-date annotation, or null. */
    scheduledDate: Date | null;
    /** True when a scheduled time token (e.g. @@{12:15pm}) is present. */
    hasScheduledTime: boolean;
    /** Parsed value of the 🛫 start-date annotation, or null. */
    startDate: Date | null;
}

// ---- Tasks-plugin emoji date regexes ----
const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const SCHEDULED_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/;
const START_RE = /🛫\s*(\d{4}-\d{2}-\d{2})/;
// Obsidian Kanban card schedule token (e.g. @{2026-03-18})
const KANBAN_SCHEDULED_RE = /(^|[^@])@\{([^}]+)\}/;
const KANBAN_TIME_RE = /@@\{([^}]+)\}/;
const YMD_IN_TOKEN_RE = /(\d{4}-\d{2}-\d{2})/;

// Matches any markdown task line (any indentation level).
// Group 1 = status char(s), Group 2 = remaining text.
const TASK_LINE_RE = /^[\t ]*-\s+\[([^\]]*)\]\s+(.*)/;
// Matches a plain bullet list item (used by some Kanban card styles).
const BULLET_LINE_RE = /^[\t ]*-\s+(.*)/;

function parseYMD(str: string): Date | null {
    const parts = str.split("-").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return null;
    const d = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
}

function extractEmojiDate(text: string, re: RegExp): Date | null {
    const m = text.match(re);
    return m ? parseYMD(m[1]) : null;
}

function extractKanbanScheduledDate(text: string): Date | null {
    const match = text.match(KANBAN_SCHEDULED_RE);
    if (!match?.[2]) return null;
    const token = match[2].trim();
    const ymd = token.match(YMD_IN_TOKEN_RE);
    if (ymd?.[1]) {
        return parseYMD(ymd[1]);
    }
    const parsed = new Date(token);
    if (isNaN(parsed.getTime())) return null;
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 0, 0, 0, 0);
}

function parseTimeToMinutes(raw: string): number | null {
    const token = String(raw || "").trim().toLowerCase();
    if (!token) return null;

    const compact = token.replace(/\s+/g, "");
    let m = compact.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm)$/i);
    if (m) {
        let hour = parseInt(m[1], 10);
        const minute = m[2] ? parseInt(m[2], 10) : 0;
        const meridiem = m[3].toLowerCase();
        if (minute < 0 || minute > 59 || hour < 1 || hour > 12) return null;
        if (hour === 12) hour = 0;
        if (meridiem === "pm") hour += 12;
        return hour * 60 + minute;
    }

    m = compact.match(/^(\d{1,2})(?::?(\d{2}))$/);
    if (!m) return null;
    const hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
}

function extractKanbanTimeMinutes(text: string): number | null {
    const match = text.match(KANBAN_TIME_RE);
    if (!match?.[1]) return null;
    return parseTimeToMinutes(match[1]);
}

/** Remove all Tasks-plugin emoji annotations and Dataview inline fields from task text. */
function cleanText(raw: string): string {
    return raw
        .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, "")
        .replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, "")
        .replace(/🛫\s*\d{4}-\d{2}-\d{2}/g, "")
        .replace(/@@\{[^}]+\}/g, "")
        .replace(/@\{[^}]+\}/g, "")
        .replace(/✅\s*\d{4}-\d{2}-\d{2}/g, "")
        .replace(/➕\s*\d{4}-\d{2}-\d{2}/g, "")
        .replace(/❌\s*\d{4}-\d{2}-\d{2}/g, "")
        .replace(/🔁\s*\S+/g, "")
        .replace(/\[(?:due|scheduled|start|completion|created|cancelled)::\s*[^\]]+\]/gi, "")
        .trim();
}

/**
 * Parse all task items with at least one date annotation from raw file content.
 * Pure function – no Obsidian API calls.
 */
export function parseTasksFromContent(
    content: string,
    filePath: string,
    isKanbanBoard: boolean = false,
): ParsedTaskItem[] {
    const results: ParsedTaskItem[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const taskMatch = lines[i].match(TASK_LINE_RE);
        const bulletMatch = isKanbanBoard ? lines[i].match(BULLET_LINE_RE) : null;
        if (!taskMatch && !bulletMatch) continue;

        const statusChar = taskMatch?.[1] ?? "";
        const isCompleted = taskMatch ? /^[xX]$/.test(statusChar) : false;
        const rawText = taskMatch ? taskMatch[2] : (bulletMatch?.[1] ?? "");
        if (!rawText) continue;

        const dueDate = extractEmojiDate(rawText, DUE_RE);
        let scheduledDate =
            extractEmojiDate(rawText, SCHEDULED_RE)
            ?? extractKanbanScheduledDate(rawText);
        const scheduledMinutes = extractKanbanTimeMinutes(rawText);
        const hasScheduledTime = scheduledMinutes !== null;
        if (scheduledDate && scheduledMinutes !== null) {
            const h = Math.floor(scheduledMinutes / 60);
            const min = scheduledMinutes % 60;
            scheduledDate = new Date(
                scheduledDate.getFullYear(),
                scheduledDate.getMonth(),
                scheduledDate.getDate(),
                h,
                min,
                0,
                0,
            );
        }
        const startDate = extractEmojiDate(rawText, START_RE);

        // Only keep tasks that have at least one recognised date annotation.
        if (!dueDate && !scheduledDate && !startDate) continue;

        results.push({
            text: cleanText(rawText),
            filePath,
            lineNumber: i,
            isCompleted,
            dueDate,
            scheduledDate,
            hasScheduledTime,
            startDate,
        });
    }

    return results;
}

function getFrontmatterValueCaseInsensitive(
    frontmatter: Record<string, unknown> | undefined,
    targetKey: string,
): unknown {
    if (!frontmatter) return undefined;
    const target = targetKey.trim().toLowerCase();
    for (const [key, value] of Object.entries(frontmatter)) {
        if (String(key).trim().toLowerCase() === target) return value;
    }
    return undefined;
}

/**
 * Scan the entire vault (optionally filtered by folder) and return all
 * dated task items.
 */
export async function parseAllTaskItems(
    app: App,
    folderFilter: string,
    allowedFilePaths?: Set<string> | null,
): Promise<ParsedTaskItem[]> {
    const prefixes = folderFilter
        .split(",")
        .map((s) => {
            const t = s.trim().toLowerCase();
            return t && !t.endsWith("/") ? t + "/" : t;
        })
        .filter(Boolean);

    const results: ParsedTaskItem[] = [];

    for (const file of app.vault.getMarkdownFiles()) {
        if (allowedFilePaths && !allowedFilePaths.has(file.path)) continue;

        // Apply optional folder filter.
        if (prefixes.length > 0) {
            const lp = file.path.toLowerCase();
            if (!prefixes.some((p) => lp.startsWith(p))) continue;
        }

        const cache = app.metadataCache.getFileCache(file);
        const frontmatter = (cache?.frontmatter || {}) as Record<string, unknown>;
        const kanbanPlugin = String(
            getFrontmatterValueCaseInsensitive(frontmatter, "kanban-plugin") ?? "",
        ).trim().toLowerCase();
        const isKanbanBoard = kanbanPlugin === "board";

        try {
            const content = await app.vault.cachedRead(file);
            results.push(...parseTasksFromContent(content, file.path, isKanbanBoard));
        } catch {
            // skip unreadable files
        }
    }

    return results;
}
