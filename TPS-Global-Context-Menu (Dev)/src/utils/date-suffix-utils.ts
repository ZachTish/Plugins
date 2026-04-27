const ISO_DATE_PATTERN = "\\d{4}[-_/]\\d{2}[-_/]\\d{2}";
const SHORT_PRETTY_DATE_PATTERN = "[A-Za-z]{3},\\s+[A-Za-z]{3}\\s+\\d{1,2}\\s+\\d{4}";
const LONG_PRETTY_DATE_PATTERN = "[A-Za-z]+,\\s+[A-Za-z]+\\s+\\d{1,2}(?:st|nd|rd|th)?\\s+\\d{4}";
const PRETTY_DATE_PATTERN = `(?:${SHORT_PRETTY_DATE_PATTERN}|${LONG_PRETTY_DATE_PATTERN})`;

const TIME_SUFFIX_PATTERN = "\\d{1,2}\\.\\d{2}[ap]m";

export const DATE_SUFFIX_REGEX = new RegExp(
    ` (?:${ISO_DATE_PATTERN}|${PRETTY_DATE_PATTERN})(?:\\s+\\d+)?$`,
);

export const DATE_OR_TIME_SUFFIX_REGEX = new RegExp(
    ` (?:${ISO_DATE_PATTERN}|${PRETTY_DATE_PATTERN})(?:\\s+${TIME_SUFFIX_PATTERN})?(?:\\s+\\d+)?$`,
);

export const TIME_SUFFIX_REGEX = new RegExp(
    `\\s+${TIME_SUFFIX_PATTERN}$`,
);

export const FULL_DATE_REGEX = new RegExp(
    `^(?:${ISO_DATE_PATTERN}|${PRETTY_DATE_PATTERN})(?:\\s+\\d+)?$`,
);

export function stripDateSuffix(text: string): string {
    let result = text;
    while (DATE_SUFFIX_REGEX.test(result)) {
        result = result.replace(DATE_SUFFIX_REGEX, '');
    }
    return result;
}

export function stripDateAndTimeSuffix(text: string): string {
    let result = text;
    while (DATE_OR_TIME_SUFFIX_REGEX.test(result)) {
        result = result.replace(DATE_OR_TIME_SUFFIX_REGEX, '');
    }
    return result;
}

export function extractDateSuffix(text: string): { base: string; dateStr: string | null } {
    const match = text.match(
        new RegExp(`^(.*)\\s(${ISO_DATE_PATTERN}|${PRETTY_DATE_PATTERN})(?:\\s+\\d+)?$`),
    );
    if (match) {
        return { base: match[1], dateStr: match[2] };
    }
    return { base: text, dateStr: null };
}

export function extractDateAndTimeSuffix(text: string): { base: string; dateStr: string | null; timeStr: string | null } {
    const match = text.match(
        new RegExp(`^(.*)\\s(${ISO_DATE_PATTERN}|${PRETTY_DATE_PATTERN})(?:\\s+(${TIME_SUFFIX_PATTERN}))?(?:\\s+\\d+)?$`),
    );
    if (match) {
        return { base: match[1], dateStr: match[2], timeStr: match[3] || null };
    }
    return { base: text, dateStr: null, timeStr: null };
}
