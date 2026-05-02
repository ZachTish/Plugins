import { useMemo } from "react";
import { BasesEntry, BasesPropertyId, Value } from "obsidian";
import type { CalendarEntry } from "../CalendarReactView";
import { compareCalendarOrderValues } from "../utils/calendar-presentation";

/**
 * Normalizes a potentially UTC-midnight Date to local midnight for all-day events.
 *
 * JavaScript parses bare ISO date strings like "2026-03-30" as UTC midnight.
 * In timezones west of UTC, getFullYear()/getMonth()/getDate() on such a Date
 * returns the *previous* calendar day. This helper detects that situation and
 * re-anchors using UTC methods, matching the approach in date-value-utils.ts.
 */
const toLocalMidnight = (d: Date): Date => {
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0) {
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

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
  /** Status values that are considered "done" and should be dimmed. */
  doneStatuses?: string[];
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
  doneStatuses = ["complete", "wont-do", "wont do"],
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
    const mappedEvents = entries.map((calEntry) => {
      const startDate = new Date(calEntry.startDate);
      const endDate = calEntry.endDate
        ? new Date(calEntry.endDate)
        : new Date(startDate.getTime() + 60 * 60 * 1000);

      const classNames = ["bases-calendar-event", ...(calEntry.cssClasses || [])];
      const isAdditionalDateSource = classNames.includes("is-additional-date-source");
      const effectiveColor = calEntry.isExternal
        ? (calEntry.color || "#3788d8")
        : isAdditionalDateSource
          ? ""
          : (calEntry.backgroundColor || "var(--background-modifier-border)");
      const backgroundColor = effectiveColor;
      const borderColor = calEntry.borderColor || (isAdditionalDateSource ? "var(--background-modifier-border)" : backgroundColor);
      const taskColor = calEntry.isTask && !isAdditionalDateSource ? backgroundColor : "";
      const eventMinHeightValue = calEntry.isTask && !isAllDayTask(calEntry)
        ? 0
        : minEventHeight;

      const allDaySource = allDayProperty
        ? tryGetValue(calEntry.entry, allDayProperty)
        : null;
      const normalizedAllDaySource = normalizeValue(allDaySource).trim().toLowerCase();
      const isAllDay = calEntry.isTask
        ? !calEntry.taskTimed
        : calEntry.isExternal
        ? !!calEntry.externalEvent?.isAllDay
        : calEntry.forceAllDay === true || ["true", "yes", "y", "1"].includes(normalizedAllDaySource);

      let eventStart = startDate;
      let eventEnd = endDate;
      if (isAllDay) {
        eventStart = toLocalMidnight(startDate);
        // FullCalendar expects all-day `end` to be exclusive; guarantee at least 1 full day.
        const candidateEnd = toLocalMidnight(endDate);
        if (candidateEnd.getTime() > eventStart.getTime()) {
          eventEnd = candidateEnd;
        } else {
          eventEnd = new Date(eventStart);
          eventEnd.setDate(eventEnd.getDate() + 1);
        }
      }

      // Dim events that are in a "done" state (complete / wont-do / configured equivalent).
      // Time-based past detection is intentionally not used: an incomplete past event
      // should remain fully visible so the user notices it still needs attention.
      const statusNormalized = String(calEntry.status ?? "").trim().toLowerCase();
      const normalizedDoneStatuses = doneStatuses.map((s) => s.trim().toLowerCase());
      const isPast = normalizedDoneStatuses.includes(statusNormalized);

      const baseTitle = calEntry.title || calEntry.entry?.file?.basename || "Untitled";
      const title = calEntry.isGhost ? `${baseTitle} (upcoming)` : baseTitle;

      return {
        id: calEntry.isGhost
          ? `ghost-${(calEntry.entry as any).path}-${startDate.getTime()}`
          : calEntry.isTask
            ? [
                "task",
                (calEntry.entry as any).file?.path || "unknown",
                (calEntry.entry as any).__taskItem?.lineNumber ?? "na",
                startDate.getTime(),
                endDate.getTime(),
                calEntry.taskCheckboxState || "",
                calEntry.status || "",
                calEntry.iconName || "",
                backgroundColor || "",
              ].join("-")
            : ((calEntry.entry as any).file?.path + (calEntry.isExternal ? "" : `-${backgroundColor}`)),
        title,
        start: eventStart,
        end: eventEnd,
        allDay: isAllDay,
        classNames: [...classNames, isAllDay ? "bases-all-day-event" : "", isPast ? "is-past" : ""],
        extendedProps: {
          calendarEntry: calEntry,
          entry: calEntry.entry,
          entryPath: (calEntry.entry as any).file?.path,
          sourceLinkPath: calEntry.isTask
            ? (calEntry.entry as any).__taskItem?.filePath || (calEntry.entry as any).file?.path
            : (calEntry.entry as any).file?.path,
          calEntryTitle: calEntry.title,
          sortKey: calEntry.sortKey,
          iconName: calEntry.iconName,
          iconColor: calEntry.iconColor,
          status: calEntry.status,
          priorityColor: calEntry.isTask || isAdditionalDateSource ? "" : backgroundColor,
          taskColor,
          minEventHeight: eventMinHeightValue,
          isExternal: calEntry.isExternal,
          isAdditionalDateSource,
          externalEvent: calEntry.externalEvent,
          isGhost: calEntry.isGhost,
          ghostDate: calEntry.ghostDate ? calEntry.ghostDate.toISOString() : undefined,
          isTask: calEntry.isTask,
          taskCheckboxState: calEntry.taskCheckboxState,
          taskInlineProperties: calEntry.taskInlineProperties,
          taskIsDone: calEntry.taskIsDone,
          isPast,
        },
        display: "block",
        backgroundColor: backgroundColor,
        borderColor: borderColor,
        textColor: isAdditionalDateSource ? "var(--text-normal)" : "#ffffff",
        "data-priority-color": isAdditionalDateSource ? "" : backgroundColor,
      };
    });

    mappedEvents.sort((left, right) => {
      const result = compareCalendarOrderValues(
        {
          sortKey: left.extendedProps?.sortKey,
          start: left.start as Date,
          end: left.end as Date,
          title: left.title,
        },
        {
          sortKey: right.extendedProps?.sortKey,
          start: right.start as Date,
          end: right.end as Date,
          title: right.title,
        },
      );
      // Stable sort fallback: preserve original array order for equal events
      // to avoid React reconciliation churn from unstable sort permutations.
      return result;
    });

    return mappedEvents;
  }, [entries, allDayProperty, minEventHeight, tick]);

  return { basesEntryMap, events };
}

// Re-export helpers used by other modules in CalendarReactView
export { normalizeValue, isDateValue, tryGetValue };

function isAllDayTask(entry: CalendarEntry): boolean {
  return !!entry.isTask && !entry.taskTimed;
}
