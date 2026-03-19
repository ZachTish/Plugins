export function normalizeCalendarUrl(url: string): string { return String(url || '').trim(); }
export function formatDateTimeForFrontmatter(date: Date | string): string { return (date instanceof Date) ? date.toISOString() : String(date); }
export const DEFAULT_CONDENSE_LEVEL = 2;
export function normalizeExternalCalendar(cal: any): any { return cal; }
export const DEFAULT_PRIORITY_COLOR_MAP: Record<string, string> = {};
export const DEFAULT_STATUS_STYLE_MAP: Record<string, any> = {};
