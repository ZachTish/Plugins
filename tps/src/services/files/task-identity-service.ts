/**
 * TaskIdentityService — Item classification, status normalization, and property inspection.
 *
 * Defines what constitutes each "kind" of item in the TPS note system and
 * provides utilities for classifying files at runtime without reading disk.
 *
 * All classification is driven by the pre-fetched frontmatter record — the
 * caller is responsible for supplying it (typically from the metadata cache).
 *
 * Pure utility functions are also exported individually for use in other
 * services that don't need or can't instantiate the class.
 */
import { TFile } from 'obsidian';
import { isDailyBasename } from '../../utils/daily-file-date';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** High-level classification of an item in the TPS vault. */
export type ItemKind = 'task' | 'event' | 'daily-note' | 'note';

/**
 * Classification result for a single vault file.
 * Produced by `TaskIdentityService.identify()`.
 */
export interface ItemIdentity {
    /** High-level classification of this item. */
    kind: ItemKind;
    /**
     * Primary normalized status (first value when status is an array),
     * or null if the status property is absent / empty.
     */
    status: string | null;
    /** All normalized status values (status can be a scalar or list). */
    allStatuses: string[];
    /** True when any resolved status matches a completion status. */
    isComplete: boolean;
    /** True when any resolved status matches a wont-do status. */
    isWontDo: boolean;
    /** True when any resolved status matches an in-progress / pending status. */
    isPending: boolean;
    /**
     * True when the file has at least one non-empty scheduled/date property.
     */
    isScheduled: boolean;
    /**
     * True when the scheduled value is a date-only string (YYYY-MM-DD) with no
     * time component, or when `fm.allDay === true`.
     */
    isAllDay: boolean;
    /** True when the file has a non-empty recurrence rule property. */
    isRecurring: boolean;
    /**
     * True when the file appears to be a daily note — either by basename
     * pattern (YYYY-MM-DD) or by living inside a configured daily-notes folder.
     */
    isDailyNote: boolean;
}

/**
 * Configuration knobs for identity resolution.
 * All fields are optional — sensible defaults are used when omitted.
 */
export interface IdentitySettings {
    /** Frontmatter key to read as the status. Default: 'status'. */
    statusProperty?: string;
    /** Statuses that indicate the item is finished. Default: see DEFAULTS. */
    completionStatuses?: string[];
    /** Statuses that indicate the item was explicitly skipped. Default: see DEFAULTS. */
    wontDoStatuses?: string[];
    /** Statuses that indicate the item is still actionable. Default: see DEFAULTS. */
    pendingStatuses?: string[];
    /** Ordered list of frontmatter keys to probe for a scheduled date/time. */
    scheduledProperties?: string[];
    /** Ordered list of frontmatter keys to probe for a recurrence rule. */
    recurrenceProperties?: string[];
    /** Folder paths that exclusively contain daily notes. */
    dailyNoteFolders?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** (deprecated) YYYY-MM-DD basename pattern was replaced by dynamic parser. */

/** YYYY-MM-DD date-only pattern used to detect all-day values. */
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const DEFAULT_COMPLETION_STATUSES = ['complete', 'done', 'finished'];
const DEFAULT_WONT_DO_STATUSES    = ['wont-do', 'cancelled', 'canceled', 'skipped'];
const DEFAULT_PENDING_STATUSES    = ['open', 'working', 'blocked', 'in-progress', 'pending'];
const DEFAULT_SCHEDULED_PROPS     = ['scheduled', 'date', 'due', 'start'];
const DEFAULT_RECURRENCE_PROPS    = ['recurrence', 'recurrenceRule', 'rrule'];

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export class TaskIdentityService {
    /**
     * Classify a file and produce a full `ItemIdentity`.
     *
     * @param file     — TFile reference (used for basename / folder detection).
     * @param fm       — Pre-fetched frontmatter record (empty `{}` when absent).
     * @param settings — Optional overrides for status keys, completion lists, etc.
     */
    identify(
        file: TFile,
        fm: Record<string, unknown>,
        settings: IdentitySettings = {},
    ): ItemIdentity {
        const statusProp        = settings.statusProperty      ?? 'status';
        const completionNorm    = (settings.completionStatuses ?? DEFAULT_COMPLETION_STATUSES).map(normalizeStatus);
        const wontDoNorm        = (settings.wontDoStatuses     ?? DEFAULT_WONT_DO_STATUSES).map(normalizeStatus);
        const pendingNorm       = (settings.pendingStatuses    ?? DEFAULT_PENDING_STATUSES).map(normalizeStatus);
        const scheduledKeys     = settings.scheduledProperties ?? DEFAULT_SCHEDULED_PROPS;
        const recurrenceKeys    = settings.recurrenceProperties ?? DEFAULT_RECURRENCE_PROPS;
        const dailyFolders      = settings.dailyNoteFolders    ?? [];

        const allStatuses = getStatuses(fm, statusProp);
        const status      = allStatuses[0] ?? null;
        const isComplete  = allStatuses.some((s) => completionNorm.includes(s));
        const isWontDo    = allStatuses.some((s) => wontDoNorm.includes(s));
        const isPending   = allStatuses.some((s) => pendingNorm.includes(s));

        const scheduledRaw  = firstDefinedProperty(fm, scheduledKeys);
        const isScheduled   = scheduledRaw != null && String(scheduledRaw).trim().length > 0;
        const isAllDay      = isScheduled && isAllDayValue(scheduledRaw, fm);

        const recurrenceRaw = firstDefinedProperty(fm, recurrenceKeys);
        const isRecurring   = recurrenceRaw != null && String(recurrenceRaw).trim().length > 0;

        const isDailyNote = detectDailyNote(file, dailyFolders);

        const kind = resolveItemKind({ isDailyNote, allStatuses, isScheduled });

        return {
            kind,
            status,
            allStatuses,
            isComplete,
            isWontDo,
            isPending,
            isScheduled,
            isAllDay,
            isRecurring,
            isDailyNote,
        };
    }

    // ── Instance wrappers around the exported pure functions ─────────────────

    /** Normalize a raw status value to lowercase-trimmed string. */
    normalizeStatus(raw: unknown): string {
        return normalizeStatus(raw);
    }

    /**
     * Extract all normalized status strings from a frontmatter record.
     * Handles scalar, array, and comma-separated string values.
     */
    getStatuses(fm: Record<string, unknown>, property = 'status'): string[] {
        return getStatuses(fm, property);
    }

    /**
     * True if the given value should be treated as an all-day date.
     * Accepts an optional frontmatter record to check the `allDay` override flag.
     */
    isAllDayValue(value: unknown, fm?: Record<string, unknown>): boolean {
        return isAllDayValue(value, fm);
    }

    /**
     * True if `value` can be parsed as any date or datetime string.
     * Used to determine whether a property contains a recognizable date.
     */
    isDateTimeValue(value: unknown): boolean {
        return isDateTimeValue(value);
    }

    /**
     * True if a file looks like a daily note (by basename or folder).
     */
    isDailyNote(file: TFile, dailyNoteFolders: string[] = []): boolean {
        return detectDailyNote(file, dailyNoteFolders);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure utility exports
//
// These are also exposed individually so that callers that only need one
// helper don't have to instantiate the service class.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a raw status value: trim whitespace and lowercase.
 * Handles null / undefined gracefully (returns empty string).
 */
export function normalizeStatus(raw: unknown): string {
    return String(raw ?? '').trim().toLowerCase();
}

/**
 * Extract all normalized status values from a frontmatter record.
 *
 * The status property may be:
 *   - absent / null → `[]`
 *   - a scalar string → `['working']`
 *   - an array → `['working', 'blocked']`
 */
export function getStatuses(
    fm: Record<string, unknown>,
    property = 'status',
): string[] {
    const raw = fm[property];
    if (raw == null) return [];

    if (Array.isArray(raw)) {
        return raw.map(normalizeStatus).filter(Boolean);
    }

    const single = normalizeStatus(raw);
    return single ? [single] : [];
}

/**
 * Returns true when `value` should be treated as an all-day (date-only) event.
 *
 * Rules (first match wins):
 *  1. `fm.allDay === true` — explicit override flag in frontmatter.
 *  2. The string representation of `value` matches `/^\d{4}-\d{2}-\d{2}$/`
 *     (a bare date with no time component).
 */
export function isAllDayValue(
    value: unknown,
    fm?: Record<string, unknown>,
): boolean {
    if (fm && fm['allDay'] === true) return true;
    if (value == null) return false;
    return DATE_ONLY_PATTERN.test(String(value).trim());
}

/**
 * Returns true if `value` can be parsed as any date or datetime string.
 */
export function isDateTimeValue(value: unknown): boolean {
    if (value == null) return false;
    const str = String(value).trim();
    if (!str) return false;
    return !isNaN(Date.parse(str));
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers (not exported)
// ─────────────────────────────────────────────────────────────────────────────

/** Return the first non-null / non-empty value found under the given keys. */
function firstDefinedProperty(
    fm: Record<string, unknown>,
    keys: string[],
): unknown | null {
    for (const key of keys) {
        const val = fm[key];
        if (val != null && String(val).trim()) return val;
    }
    return null;
}

/** Detect whether a file is a daily note by basename pattern or configured folder. */
/** Detect whether a file is a daily note by basename pattern or configured folder. */
function detectDailyNote(file: TFile, dailyNoteFolders: string[]): boolean {
    // Prefer dynamic basename parsing (supports user formats)
    if (isDailyBasename(file.basename)) return true;

    const folderPath = file.parent?.path ?? '';
    return dailyNoteFolders.some((f) => {
        const norm = f.endsWith('/') ? f : `${f}/`;
        return folderPath.startsWith(norm) || folderPath === f.replace(/\/$/, '');
    });
}

/** Determine item kind from classification signals. */
function resolveItemKind(ctx: {
    isDailyNote: boolean;
    allStatuses: string[];
    isScheduled: boolean;
}): ItemKind {
    if (ctx.isDailyNote) return 'daily-note';
    // Files with a status property are tasks
    if (ctx.allStatuses.length > 0) return 'task';
    // Files with a scheduled date but no status are events
    if (ctx.isScheduled) return 'event';
    return 'note';
}
