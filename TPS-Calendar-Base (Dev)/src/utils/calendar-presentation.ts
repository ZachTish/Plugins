interface CalendarOrderComparable {
  sortKey?: unknown;
  start?: Date | null;
  end?: Date | null;
  title?: unknown;
}

const LUCIDE_PREFIX_RE = /^lucide[:\-]/i;
const MAX_ICON_STRIP_ITERATIONS = 5;

/**
 * Strips repeated `lucide:` / `lucide-` prefixes from a raw icon name.
 * Returns the bare icon identifier or null if nothing usable remains.
 */
export const normalizeCalendarIconName = (raw: unknown): string | null => {
  if (raw == null) return null;
  let normalized = String(raw).trim();
  if (!normalized) return null;

  let iterations = 0;
  while (LUCIDE_PREFIX_RE.test(normalized) && iterations < MAX_ICON_STRIP_ITERATIONS) {
    normalized = normalized.replace(LUCIDE_PREFIX_RE, "").trim();
    iterations++;
  }

  return normalized || null;
};

/**
 * Extracts a comparable string from a sort key value.
 * Does NOT lowercase — localeCompare with sensitivity:"base" handles case.
 */
const normalizeSortKey = (raw: unknown): string => {
  if (raw == null) return "";
  const s = typeof raw === "string" ? raw : String(raw);
  return s.trim();
};

/**
 * Compares two calendar event descriptors for ordering.
 * Primary: sort key (string collation, numeric-aware).
 * Secondary: start time (earlier first).
 * Tertiary: duration (longer first — FullCalendar convention).
 * Final fallback: title (alphabetical).
 */
export const compareCalendarOrderValues = (
  left: CalendarOrderComparable,
  right: CalendarOrderComparable,
): number => {
  const leftSortKey = normalizeSortKey(left.sortKey);
  const rightSortKey = normalizeSortKey(right.sortKey);

  if (leftSortKey || rightSortKey) {
    if (!leftSortKey) return 1;
    if (!rightSortKey) return -1;
    const sortCompare = leftSortKey.localeCompare(rightSortKey, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (sortCompare !== 0) return sortCompare;
  }

  const leftStart = toSafeTimestamp(left.start);
  const rightStart = toSafeTimestamp(right.start);
  if (leftStart !== rightStart) {
    // If one is NaN, push it after the valid one
    if (!Number.isFinite(leftStart)) return 1;
    if (!Number.isFinite(rightStart)) return -1;
    return leftStart - rightStart;
  }

  const leftEnd = toSafeTimestamp(left.end, leftStart);
  const rightEnd = toSafeTimestamp(right.end, rightStart);
  if (Number.isFinite(leftEnd) && Number.isFinite(rightEnd)) {
    const leftDuration = leftEnd - leftStart;
    const rightDuration = rightEnd - rightStart;
    if (leftDuration !== rightDuration) {
      return rightDuration - leftDuration; // longer first
    }
  }

  return String(left.title ?? "").localeCompare(String(right.title ?? ""), undefined, {
    numeric: true,
    sensitivity: "base",
  });
};

/** Safely extracts a numeric timestamp from a potential Date value. */
const toSafeTimestamp = (value: unknown, fallback: number = Number.NaN): number => {
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) ? ts : fallback;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
};