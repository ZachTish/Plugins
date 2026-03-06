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
    /** Parsed value of the 🛫 start-date annotation, or null. */
    startDate: Date | null;
}

// ---- Tasks-plugin emoji date regexes ----
const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const SCHEDULED_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/;
const START_RE = /🛫\s*(\d{4}-\d{2}-\d{2})/;

// Matches any markdown task line (any indentation level).
// Group 1 = status char(s), Group 2 = remaining text.
const TASK_LINE_RE = /^[\t ]*-\s+\[([^\]]*)\]\s+(.*)/;

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

/** Remove all Tasks-plugin emoji annotations and Dataview inline fields from task text. */
function cleanText(raw: string): string {
    return raw
        .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, "")
        .replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, "")
        .replace(/🛫\s*\d{4}-\d{2}-\d{2}/g, "")
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
): ParsedTaskItem[] {
    const results: ParsedTaskItem[] = [];
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(TASK_LINE_RE);
        if (!m) continue;

        const statusChar = m[1];
        const isCompleted = /^[xX]$/.test(statusChar);
        const rawText = m[2];

        const dueDate = extractEmojiDate(rawText, DUE_RE);
        const scheduledDate = extractEmojiDate(rawText, SCHEDULED_RE);
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
            startDate,
        });
    }

    return results;
}

/**
 * Scan the entire vault (optionally filtered by folder) and return all
 * dated task items.  Uses `metadataCache.listItems` as a fast pre-filter so
 * only files that actually contain checkbox items get their content read.
 */
export async function parseAllTaskItems(
    app: App,
    folderFilter: string,
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
        // Apply optional folder filter.
        if (prefixes.length > 0) {
            const lp = file.path.toLowerCase();
            if (!prefixes.some((p) => lp.startsWith(p))) continue;
        }

        // Skip files whose metadata cache has no checkbox list items (fast path).
        const cache = app.metadataCache.getFileCache(file);
        if (!cache?.listItems?.some((li) => li.task !== undefined)) continue;

        try {
            const content = await app.vault.cachedRead(file);
            results.push(...parseTasksFromContent(content, file.path));
        } catch {
            // skip unreadable files
        }
    }

    return results;
}
