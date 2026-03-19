/**
 * Pure utility functions for extracting and resolving date values from Bases entry properties.
 * Used by CalendarView to convert arbitrary property values into Date objects.
 */
import { BasesEntry, BasesPropertyId, Value } from "obsidian";
import * as logger from "../logger";
import { parseDateFromFilename } from "../../../tps/src/utils/daily-file-date";

export function extractDate(entry: BasesEntry, propId: BasesPropertyId, userFormat?: string): Date | null {
  try {
    const value = entry.getValue(propId);
    if (!value) return null;

    const parsedDate = resolveDateValue(value);
    if (parsedDate) return parsedDate;

    // Fallback: try interpreting the string value as a filename-formatted date
    // (handles "get day from title" when startDate property is note.name / note.basename)
    const str = valueToString(value);
    if (str) {
      const cleaned = str.replace(/\.[^.]+$/, ''); // strip extension if present
      try {
        const m = parseDateFromFilename(cleaned, userFormat);
        if (m && m.isValid && m.isValid()) {
          return new Date(m.year(), m.month(), m.date());
        }
      } catch { /* ignore */ }
    }

    return null;
  } catch (error) {
    logger.error(`Error extracting date for ${entry.file.name}:`, error);
    return null;
  }
}

export function extractDuration(entry: BasesEntry, propId: BasesPropertyId): number | null {
  try {
    const value = entry.getValue(propId);
    if (!value) return null;

    // Handle numeric values directly
    if (typeof value === "number") {
      return value;
    }

    // Try to get numeric value from Value object
    const numValue = (value as any).toNumber?.();
    if (typeof numValue === "number" && !Number.isNaN(numValue)) {
      return numValue;
    }

    // Try to parse from string representation
    const strValue = valueToString(value);
    if (strValue) {
      // Handle "1h 30m", "1.5h", "90m" formats
      let minutes = 0;
      let matched = false;

      const hoursMatch = strValue.match(/(\d+(?:\.\d+)?)h/);
      if (hoursMatch) {
        minutes += parseFloat(hoursMatch[1]) * 60;
        matched = true;
      }

      const minsMatch = strValue.match(/(\d+(?:\.\d+)?)m/);
      if (minsMatch) {
        minutes += parseFloat(minsMatch[1]);
        matched = true;
      }

      if (matched) {
        return minutes;
      }

      // Fallback for plain numbers
      const parsed = parseFloat(strValue);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    return null;
  } catch (error) {
    logger.error(`Error extracting duration for ${entry.file.name}:`, error);
    return null;
  }
}

export function resolveDateValue(value: Value | unknown, seen = new Set<unknown>()): Date | null {
  if (!value) return null;

  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return null;
    seen.add(value);

    const nestedDate = resolveFromPotentialDate(value as Record<string, unknown>, seen);
    if (nestedDate) return nestedDate;
  }

  if (value instanceof Date) {
    return value;
  }

  const asString = valueToString(value);
  if (!asString) {
    return null;
  }

  return tryParseDate(asString);
}

export function valueToString(value: Value | unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null) {
    try {
      return (value as { toString: () => string }).toString();
    } catch {
      return null;
    }
  }
  return null;
}

export function tryParseDate(raw: string): Date | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const numericValue = Number(trimmed);
    if (!Number.isNaN(numericValue)) {
      const numericDate = new Date(numericValue);
      if (!Number.isNaN(numericDate.getTime())) {
        return numericDate;
      }
    }
  }

  // Important: `new Date("YYYY-MM-DD")` is parsed as UTC and can shift the local day.
  // Parse common frontmatter formats as local time to keep calendar + daily embeds aligned.
  const localMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (localMatch) {
    const year = Number(localMatch[1]);
    const month = Number(localMatch[2]);
    const day = Number(localMatch[3]);
    const hour = localMatch[4] ? Number(localMatch[4]) : 0;
    const minute = localMatch[5] ? Number(localMatch[5]) : 0;
    const second = localMatch[6] ? Number(localMatch[6]) : 0;
    const local = new Date(year, month - 1, day, hour, minute, second);
    if (!Number.isNaN(local.getTime())) {
      return local;
    }
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function resolveFromPotentialDate(
  value: Record<string, unknown>,
  seen: Set<unknown>,
): Date | null {
  // Handle Obsidian Bases { date: Date, time?: boolean } value objects.
  //
  // Bases constructs these from ISO-8601 frontmatter. A date-only value like
  // "2026-03-16" becomes { date: new Date("2026-03-16T00:00:00.000Z"), time: false }.
  // JavaScript treats bare ISO-date strings as UTC, so in any timezone west of UTC
  // the Date lands on the *previous* local day — causing events to appear one day early.
  //
  // When time === false (date-only, no time component), re-anchor to local midnight
  // using the UTC year/month/day so the calendar shows the correct day in every timezone.
  if ("date" in value && value["date"] instanceof Date) {
    const d = value["date"] as Date;
    if ((value as any)["time"] === false) {
      // Date-only: normalise UTC midnight → local midnight of the same calendar date
      return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
    // Datetime value: return as-is
    return d;
  }

  const candidates = ["date", "value", "timestamp", "start", "end"];
  for (const key of candidates) {
    if (key in value) {
      const candidate = value[key];
      const resolved = resolveDateValue(candidate, seen);
      if (resolved) return resolved;
    }
  }

  const getter = (value as { get?: (key: string) => unknown }).get;
  if (typeof getter === "function") {
    for (const key of candidates) {
      try {
        const nested = getter.call(value, key);
        const resolved = resolveDateValue(nested, seen);
        if (resolved) return resolved;
      } catch {
        // ignore getter errors
      }
    }
  }

  return null;
}
