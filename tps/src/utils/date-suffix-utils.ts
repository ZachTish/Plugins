/**
 * Centralized date-suffix utilities for filenames.
 * Replaces duplicated regex patterns across file-naming-service.ts,
 * menu-controller.ts, and bulk-edit-service.ts.
 */

const ISO_DATE_PATTERN = "\\d{4}[-_/]\\d{2}[-_/]\\d{2}";
const PRETTY_DATE_PATTERN = "[A-Za-z]+,\\s+[A-Za-z]+\\s+\\d{1,2}(?:st|nd|rd|th)\\s+\\d{4}";

/** Matches a trailing date suffix (ISO or pretty format), optionally followed by a conflict number. */
export const DATE_SUFFIX_REGEX = new RegExp(
    ` (?:${ISO_DATE_PATTERN}|${PRETTY_DATE_PATTERN})(?:\\s+\\d+)?$`,
);

/** Matches a string that is exactly a date (ISO or pretty format), optionally followed by a conflict number. */
export const FULL_DATE_REGEX = new RegExp(
    `^(?:${ISO_DATE_PATTERN}|${PRETTY_DATE_PATTERN})(?:\\s+\\d+)?$`,
);

/**
 * Strip a trailing date suffix (" YYYY-MM-DD") from text.
 * Returns the text unchanged if no suffix is found.
 */
export function stripDateSuffix(text: string): string {
    let result = text;
    while (DATE_SUFFIX_REGEX.test(result)) {
        result = result.replace(DATE_SUFFIX_REGEX, '');
    }
    return result;
}

/**
 * Extract a trailing date suffix from text.
 * Returns the base text and the date string (or null if not found).
 */
export function extractDateSuffix(text: string): { base: string; dateStr: string | null } {
    const match = text.match(
        new RegExp(`^(.*)\\s(${ISO_DATE_PATTERN}|${PRETTY_DATE_PATTERN})(?:\\s+\\d+)?$`),
    );
    if (match) {
        return { base: match[1], dateStr: match[2] };
    }
    return { base: text, dateStr: null };
}
