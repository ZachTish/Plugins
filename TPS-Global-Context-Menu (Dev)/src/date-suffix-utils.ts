/**
 * Centralized date-suffix utilities for filenames.
 * Replaces duplicated regex patterns across file-naming-service.ts,
 * menu-controller.ts, and bulk-edit-service.ts.
 */

/** Matches a trailing " YYYY-MM-DD" at the end of a string (optionally followed by a conflict number). */
export const DATE_SUFFIX_REGEX = / \d{4}-\d{2}-\d{2}(?:\s+\d+)?$/;

/** Matches a string that is exactly "YYYY-MM-DD". */
export const FULL_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(?:\s+\d+)?$/;

/**
 * Strip a trailing date suffix (" YYYY-MM-DD") from text.
 * Returns the text unchanged if no suffix is found.
 */
export function stripDateSuffix(text: string): string {
    return text.replace(DATE_SUFFIX_REGEX, '');
}

/**
 * Extract a trailing date suffix from text.
 * Returns the base text and the date string (or null if not found).
 */
export function extractDateSuffix(text: string): { base: string; dateStr: string | null } {
    const match = text.match(/^(.*)\s(\d{4}-\d{2}-\d{2})(?:\s+\d+)?$/);
    if (match) {
        return { base: match[1], dateStr: match[2] };
    }
    return { base: text, dateStr: null };
}
