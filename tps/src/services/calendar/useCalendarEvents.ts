import { useMemo } from "react";
import { BasesEntry, BasesPropertyId, Value } from "obsidian";
import type { CalendarEntry } from "./all-day-events-modal";

const normalizeValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("data" in (value as object)) {
      return normalizeValue((value as { data: unknown }).data);
    }
    if (Array.isArray(value)) {
      return value.map((item) => normalizeValue(item)).filter(Boolean).join(", ");
    }
    if (isDateValue(value)) {
      return value.date ? value.date.toISOString() : "";
    }
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
};

const isDateValue = (value: unknown): value is { date: Date; time?: boolean } => {
  return (
    typeof value === "object" &&
    value !== null &&
    "date" in value &&
    (value as any).date instanceof Date
  );
};

const tryGetValue = (
  entry: BasesEntry,
  propId: BasesPropertyId,
): Value | null => {
  try {
    return entry.getValue(propId);
  } catch {
    return null;
  }
};

interface UseCalendarEventsOptions {
  entries: CalendarEntry[];
  allDayProperty?: BasesPropertyId | null;
  defaultEventDuration: number;
  minEventHeight: number;
  tick: number;
}

/**
 * Transforms CalendarEntry[] into FullCalendar event objects and builds
 * a path->BasesEntry lookup map.
 */
export function useCalendarEvents({
  entries,
  allDayProperty,
  defaultEventDuration,
  minEventHeight,
  tick,
}: UseCalendarEventsOptions) {
  const basesEntryMap = useMemo(() => {
    const map = new Map<string, BasesEntry>();
    entries.forEach(ce => {
      if (ce.entry?.file?.path) {
        map.set(ce.entry.file.path, ce.entry);
      }
    });
    return map;
  }, [entries]);

  const events = useMemo(() => {
    const now = new Date();
    const nowTime = now.getTime();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    return entries.map((calEntry) => {
      const startDate = new Date(calEntry.startDate);
      const endDate = calEntry.endDate
        ? new Date(calEntry.endDate)
        : new Date(startDate.getTime() + 60 * 60 * 1000);

      const classNames = ["bases-calendar-event", ...(calEntry.cssClasses || [])];
      const effectiveColor = calEntry.isExternal
        ? (calEntry.color || "#3788d8")
        : (calEntry.backgroundColor || "var(--background-modifier-border)");
      const backgroundColor = effectiveColor;
      const borderColor = calEntry.borderColor || backgroundColor;

      const allDaySource = allDayProperty
        ? tryGetValue(calEntry.entry, allDayProperty)
        : null;
      const normalizedAllDaySource = normalizeValue(allDaySource).trim().toLowerCase();
      const isAllDay = calEntry.isTask
        ? !calEntry.taskTimed
        : calEntry.isExternal
        ? !!calEntry.externalEvent?.isAllDay
        : ["true", "yes", "y", "1"].includes(normalizedAllDaySource);

      // Keep "past" classification aligned with calendar semantics:
      // all-day events become past after their end day boundary; timed events after end datetime.
      const statusNormalized = String(calEntry.status ?? "").trim().toLowerCase();
      const isDoneStatus = [
        "complete",
        "completed",
        "wont-do",
        "wont do",
      ].includes(statusNormalized);
      const isPastByTime = isAllDay
        ? endDate.getTime() <= startOfToday
        : endDate.getTime() <= nowTime;
      const isPast = isPastByTime || (isAllDay && isDoneStatus);

      const baseTitle = calEntry.title || calEntry.entry?.file?.basename || "Untitled";
      const title = calEntry.isGhost ? `${baseTitle} (upcoming)` : baseTitle;

      return {
        id: calEntry.isGhost
          ? `ghost-${(calEntry.entry as any).path}-${startDate.getTime()}`
          : ((calEntry.entry as any).file?.path + (calEntry.isExternal ? "" : `-${backgroundColor}`)),
        title,
        start: startDate,
        end: endDate,
        allDay: isAllDay,
        classNames: [...classNames, isAllDay ? "bases-all-day-event" : "", isPast ? "is-past" : ""],
        extendedProps: {
          calendarEntry: calEntry,
          entry: calEntry.entry,
          entryPath: (calEntry.entry as any).file?.path,
          calEntryTitle: calEntry.title,
          iconName: calEntry.iconName,
          iconColor: calEntry.iconColor,
          status: calEntry.status,
          priorityColor: backgroundColor,
          minEventHeight,
          isExternal: calEntry.isExternal,
          externalEvent: calEntry.externalEvent,
          isGhost: calEntry.isGhost,
          ghostDate: calEntry.ghostDate ? calEntry.ghostDate.toISOString() : undefined,
          isTask: calEntry.isTask,
          isPast,
        },
        display: "block",
        backgroundColor: backgroundColor,
        borderColor: borderColor,
        textColor: "#ffffff",
        "data-priority-color": backgroundColor,
      };
    });
  }, [entries, allDayProperty, minEventHeight, tick]);

  return { basesEntryMap, events };
}

// Re-export helpers used by other modules in CalendarReactView
export { normalizeValue, isDateValue, tryGetValue };
