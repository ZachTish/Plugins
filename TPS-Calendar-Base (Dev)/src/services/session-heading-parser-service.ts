import { App } from "obsidian";

export interface ParsedSessionHeading {
    text: string;
    filePath: string;
    lineNumber: number;
    scheduledDate: Date;
    hasScheduledTime: boolean;
    durationMinutes: number | null;
    inlineProperties: Record<string, string>;
}

const SESSION_HEADING_RE = /^[\t ]*#{1,6}\s+Session:\s+(.*)$/i;
const INLINE_PROPERTY_RE = /\[([a-zA-Z0-9_-]+)::\s*([^\]]+)\]/g;

function parseYmd(value: string): Date | null {
    const parts = value.split("-").map(Number);
    if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return null;
    const parsed = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function extractInlineProperties(text: string): Record<string, string> {
    const properties: Record<string, string> = {};
    INLINE_PROPERTY_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_PROPERTY_RE.exec(text)) !== null) {
        const key = String(match[1] ?? "").trim().toLowerCase();
        const value = String(match[2] ?? "").trim();
        if (!key || !value) continue;
        properties[key] = value;
    }
    return properties;
}

function extractScheduledDate(rawValue: string): { date: Date | null; hasTime: boolean } {
    const value = String(rawValue || "").trim();
    if (!value) return { date: null, hasTime: false };

    const match = value.match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!match?.[1]) return { date: null, hasTime: false };

    const base = parseYmd(match[1]);
    if (!base) return { date: null, hasTime: false };

    const hasTime = match[2] != null && match[3] != null;
    if (hasTime) {
        base.setHours(Number(match[2]), Number(match[3]), Number(match[4] ?? 0), 0);
    }

    return { date: base, hasTime };
}

function extractDurationMinutes(properties: Record<string, string>): number | null {
    for (const key of ["timeestimate", "duration", "durationminutes", "time-estimate"]) {
        const rawValue = String(properties[key] || "").trim();
        if (!rawValue) continue;
        const value = Number(rawValue);
        if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
}

function cleanSessionText(rawText: string): string {
    return String(rawText || "")
        .replace(/\[[a-zA-Z0-9_-]+::\s*[^\]]+\]/g, "")
        .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target, alias) => {
            const visible = String(alias || "").trim();
            if (visible) return visible;
            const fallback = String(target || "").trim().split("/").pop() || String(target || "").trim();
            return fallback;
        })
        .replace(/\s{2,}/g, " ")
        .trim();
}

export function parseSessionHeadingsFromContent(content: string, filePath: string): ParsedSessionHeading[] {
    const results: ParsedSessionHeading[] = [];
    const lines = content.split("\n");

    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(SESSION_HEADING_RE);
        if (!match?.[1]) continue;

        const headingBody = String(match[1] || "").trim();
        const inlineProperties = extractInlineProperties(headingBody);
        const scheduledRaw = String(
            inlineProperties.scheduled || inlineProperties.scheduleddate || inlineProperties["scheduled-date"] || "",
        ).trim();
        const scheduled = extractScheduledDate(scheduledRaw);
        if (!scheduled.date) continue;

        results.push({
            text: cleanSessionText(headingBody) || "Session",
            filePath,
            lineNumber: index,
            scheduledDate: scheduled.date,
            hasScheduledTime: scheduled.hasTime,
            durationMinutes: extractDurationMinutes(inlineProperties),
            inlineProperties,
        });
    }

    return results;
}

export async function parseAllSessionHeadings(app: App): Promise<ParsedSessionHeading[]> {
    const results: ParsedSessionHeading[] = [];

    for (const file of app.vault.getMarkdownFiles()) {
        try {
            const content = await app.vault.cachedRead(file);
            results.push(...parseSessionHeadingsFromContent(content, file.path));
        } catch {
            // Skip unreadable files.
        }
    }

    return results;
}
