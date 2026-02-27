import { moment, getAllTags, TFile } from 'obsidian';
import type { PropertyReminder, TPSNotifierSettings } from './types';

// ============================================================================
// Date/Time Parsing
// ============================================================================

export function parseDate(input: any): number | null {
    if (!input) return null;
    let raw = Array.isArray(input) ? input[0] : input;
    if (!raw) return null;
    raw = String(raw).replace(/[\[\]]/g, '');

    // Handle property ranges - extract START only
    if (typeof raw === 'string') {
        let split = raw.split(/\s+[-–]\s+/);
        if (split.length > 1) {
            raw = split[0].trim();
        } else {
            const compactMatch = raw.match(/(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/);
            if (compactMatch) {
                raw = compactMatch[1];
            }
        }

        // Extract date from strings
        const dateTimeMatch = raw.match(/(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}(?:\s*[AP]M?)?))?/i);
        if (dateTimeMatch) {
            raw = dateTimeMatch[0];
        }
    }

    const formats = [
        'YYYY-MM-DD HH:mm',
        'YYYY-MM-DD H:mm',
        'YYYY-MM-DD HH:mm A',
        'YYYY-MM-DD h:mm A',
        'YYYY-MM-DDTHH:mm:ss',
        'YYYY-MM-DDTHH:mm',
        'YYYY-MM-DD',
        'HH:mm',
        'H:mm',
        'hh:mm A',
        'h:mm A',
        moment.ISO_8601
    ];

    const m = moment(raw, formats, true);
    if (m.isValid()) {
        return m.valueOf();
    }

    if (/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(raw) || /\d{1,2}:\d{2}/.test(raw)) {
        const originalSuppress = moment.suppressDeprecationWarnings;
        moment.suppressDeprecationWarnings = true;
        let fallback;
        try {
            fallback = moment(raw);
        } finally {
            moment.suppressDeprecationWarnings = originalSuppress;
        }
        return fallback.isValid() ? fallback.valueOf() : null;
    }

    return null;
}

export function parseTimeRange(input: any): { start: number | null, end: number | null } {
    if (!input) return { start: null, end: null };
    let raw = Array.isArray(input) ? input[0] : input;
    if (!raw) return { start: null, end: null };
    raw = String(raw).replace(/[\[\]]/g, '');

    let startRaw = raw;
    let endRaw = null;

    if (typeof raw === 'string') {
        const split = raw.split(/\s+[-–]\s+/);
        if (split.length > 1) {
            startRaw = split[0].trim();
            endRaw = split[split.length - 1].trim();
        } else {
            const compactMatch = raw.match(/\b(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\b/);
            if (compactMatch) {
                endRaw = compactMatch[2];
            }
        }
    }

    const start = parseDate(startRaw);
    if (!start) return { start: null, end: null };

    let end = null;
    if (endRaw) {
        if (/^\d{1,2}:\d{2}(?:\s*[AP]M?)?$/i.test(endRaw)) {
            end = moment(start).set({
                hour: moment(endRaw, ['H:mm', 'HH:mm', 'h:mm A'], true).hour(),
                minute: moment(endRaw, ['H:mm', 'HH:mm', 'h:mm A'], true).minute()
            }).valueOf();

            if (end < start) {
                end = moment(end).add(1, 'day').valueOf();
            }
        } else {
            end = parseDate(endRaw);
        }
    }

    return { start, end };
}

// ============================================================================
// Duration Parsing
// ============================================================================

export function parseDuration(input: any): number {
    if (typeof input === 'number') return input; // Assume minutes
    if (!input) return 0;

    const str = String(input).trim().toLowerCase();

    const hoursMatch = str.match(/(\d+(?:\.\d+)?)h/);
    const minsMatch = str.match(/(\d+(?:\.\d+)?)m/);

    let minutes = 0;
    if (hoursMatch) minutes += parseFloat(hoursMatch[1]) * 60;
    if (minsMatch) minutes += parseFloat(minsMatch[1]);

    if (minutes > 0) return minutes;

    const num = parseFloat(str);
    if (!isNaN(num)) return num;

    return 0;
}

export function getEffectiveEndTime(propertyTime: number, rangeEndTime: number | null, fm: any): number | null {
    if (rangeEndTime) return rangeEndTime;

    // Prefer duration-like fields (duration, timeEstimate)
    const durationCandidates = [fm?.duration, fm?.timeEstimate];
    for (const candidate of durationCandidates) {
        const durationMins = parseDuration(candidate);
        if (durationMins > 0) {
            return propertyTime + (durationMins * 60 * 1000);
        }
    }

    // Fallback to explicit End/EndTime
    const endProp = fm?.end || fm?.endTime;
    if (endProp) {
        const parsedEnd = parseDate(endProp);
        if (parsedEnd) return parsedEnd;
        if (/^\d{1,2}:\d{2}(?:\s*[AP]M?)?$/i.test(endProp)) {
            let effectiveEndTime = moment(propertyTime).set({
                hour: moment(endProp, ['H:mm', 'HH:mm', 'h:mm A'], true).hour(),
                minute: moment(endProp, ['H:mm', 'HH:mm', 'h:mm A'], true).minute()
            }).valueOf();
            if (effectiveEndTime < propertyTime) {
                effectiveEndTime = moment(effectiveEndTime).add(1, 'day').valueOf();
            }
            return effectiveEndTime;
        }
    }

    return null;
}

// ============================================================================
// Formatting
// ============================================================================

export function formatTemplate(template: string, vars: Record<string, any>): string {
    let result = template;
    for (const key in vars) {
        result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(vars[key] ?? ''));
    }
    return result;
}

export function formatRemaining(ms: number): string {
    const absMs = Math.abs(ms);
    const minutes = Math.round(absMs / 60000);

    if (minutes < 60) {
        const label = minutes === 1 ? 'minute' : 'minutes';
        return ms >= 0 ? `in ${minutes} ${label}` : `${minutes} ${label} ago`;
    }

    const hours = Math.round(minutes / 60);
    const label = hours === 1 ? 'hour' : 'hours';
    return ms >= 0 ? `in ${hours} ${label}` : `${hours} ${label} ago`;
}

// ============================================================================
// Frontmatter Condition Checks
// ============================================================================

export function checkStopCondition(fm: any, condition: string): boolean {
    const parts = condition.split(':');
    if (parts.length < 2) return false;

    const key = parts[0].trim();
    const expectedValue = parts.slice(1).join(':').trim().toLowerCase();
    const actualValue = fm[key];

    if (actualValue === undefined || actualValue === null) return false;
    return String(actualValue).toLowerCase() === expectedValue;
}

export function normalizeStatus(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

export function getStatuses(fm: any): string[] {
    const rawStatus = fm?.status;
    if (Array.isArray(rawStatus)) {
        return rawStatus.map((s) => normalizeStatus(s)).filter(Boolean);
    }
    const single = normalizeStatus(rawStatus);
    return single ? [single] : [];
}

export function hasRequiredStatus(fm: any, reminder: PropertyReminder): boolean {
    if (!reminder.requiredStatuses || reminder.requiredStatuses.length === 0) return true;
    const required = reminder.requiredStatuses.map((s) => normalizeStatus(s)).filter(Boolean);
    if (required.length === 0) return true;
    const statuses = getStatuses(fm);
    return statuses.some((s) => required.includes(s));
}

/**
 * Check if a file/reminder should be ignored based on per-reminder or global settings.
 * Pass the global fallback arrays from settings for when the reminder doesn't have its own.
 */
export function shouldIgnoreForReminder(
    file: TFile,
    cache: any,
    fm: any,
    reminder: PropertyReminder,
    globalIgnorePaths: string[],
    globalIgnoreTags: string[],
    globalIgnoreStatuses: string[]
): boolean {
    const ignorePaths =
        Array.isArray(reminder.ignorePaths) ? reminder.ignorePaths : globalIgnorePaths;
    const ignoreTags =
        Array.isArray(reminder.ignoreTags) ? reminder.ignoreTags : globalIgnoreTags;
    const ignoreStatuses =
        Array.isArray(reminder.ignoreStatuses) ? reminder.ignoreStatuses : globalIgnoreStatuses;

    if (ignorePaths.some(p => p && file.path.startsWith(p))) {
        return true;
    }

    const statuses = new Set<string>(getStatuses(fm));
    const normalizedIgnoreStatuses = ignoreStatuses.map(s => normalizeStatus(s)).filter(Boolean);
    if (normalizedIgnoreStatuses.some(s => statuses.has(s))) {
        return true;
    }

    const tags = (cache ? getAllTags(cache) : []) || [];
    const hasIgnoredTag = tags.some(tag => {
        const pureTag = tag.replace('#', '').toLowerCase();
        return ignoreTags.some(ignored => {
            const cleanIgnored = String(ignored).toLowerCase().replace('#', '').trim();
            if (!cleanIgnored) return false;
            return pureTag === cleanIgnored || pureTag.startsWith(cleanIgnored + '/');
        });
    });
    if (hasIgnoredTag) {
        return true;
    }

    return false;
}
