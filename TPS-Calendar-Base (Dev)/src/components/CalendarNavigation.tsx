import React, { useCallback, useRef, useState } from "react";

interface UnscheduledEntry {
  file: { path: string; basename: string };
  title: string;
}

/** Single unscheduled entry row. Suppresses click after drag to avoid opening the note. */
const UnscheduledItem: React.FC<{
  entry: UnscheduledEntry;
  onClick: () => void;
}> = ({ entry, onClick }) => {
  const suppressClickRef = useRef(false);
  const clearTimerRef = useRef<number | null>(null);

  const scheduleReset = useCallback(() => {
    if (clearTimerRef.current != null) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = window.setTimeout(() => {
      suppressClickRef.current = false;
      clearTimerRef.current = null;
    }, 300);
  }, []);

  return (
    <div
      draggable
      onDragStart={(e) => {
        suppressClickRef.current = true;
        scheduleReset();
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("obsidian/file", entry.file.path);
        if (entry.title && entry.file.path) {
          e.dataTransfer.setData("application/x-tps-card-reference", JSON.stringify({
            title: entry.title,
            linkPath: entry.file.path,
          }));
        }
        e.dataTransfer.setData("text/plain", `[[${entry.file.path}|${entry.title}]]`);
        (e.currentTarget as HTMLElement).style.opacity = "0.5";
      }}
      onDragEnd={(e) => {
        (e.currentTarget as HTMLElement).style.opacity = "1";
        scheduleReset();
      }}
      onClick={(e) => {
        if (suppressClickRef.current) {
          e.stopPropagation();
          suppressClickRef.current = false;
          if (clearTimerRef.current != null) {
            window.clearTimeout(clearTimerRef.current);
            clearTimerRef.current = null;
          }
          return;
        }
        onClick();
      }}
      style={{
        padding: "5px 10px",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "0.82em",
        color: "var(--text-normal)",
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        borderLeft: "3px solid var(--interactive-accent)",
        marginLeft: "4px",
        marginBottom: "2px",
        borderRadius: "0 4px 4px 0",
        background: "var(--background-secondary)",
        transition: "background-color 0.1s ease",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor =
          "var(--background-modifier-hover)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.backgroundColor =
          "var(--background-secondary)";
      }}
      title={entry.file.path}
    >
      <span
        style={{
          cursor: "grab",
          color: "var(--text-faint)",
          fontSize: "0.7rem",
          lineHeight: 1,
          flexShrink: 0,
          userSelect: "none",
          letterSpacing: "-0.5px",
        }}
        title="Drag to calendar"
      >
        ⠿
      </span>
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          fontWeight: 500,
        }}
      >
        {entry.title}
      </span>
    </div>
  );
};

interface CalendarNavigationProps {
  isMobile: boolean;
  showNavButtons?: boolean;
  navigationLocked?: boolean;
  canNavigatePrev?: boolean;
  canNavigateNext?: boolean;
  canNavigateToday?: boolean;
  navigationBoundsStart?: Date;
  navigationBoundsEnd?: Date;
  headerTitle: string;
  currentDate?: Date;
  onDateChange?: (date: Date) => void;
  onPrevClick: () => void;
  onNextClick: () => void;
  onTodayCentered: () => void;
  mobileNavHidden: boolean;
  floatingNavStyle: React.CSSProperties;
  /** Unscheduled entries to show in the popover. When provided and non-empty, the button appears. */
  unscheduledEntries?: UnscheduledEntry[];
  /** Called when an unscheduled entry is clicked (to open the note). */
  onUnscheduledEntryClick?: (file: { path: string }) => void;
}

/**
 * Calendar navigation is intentionally floating on every platform.
 * Header portal controls were removed to keep the Bases header clean.
 */
export const CalendarNavigation: React.FC<CalendarNavigationProps> = ({
  isMobile,
  showNavButtons,
  navigationLocked = false,
  canNavigatePrev = true,
  canNavigateNext = true,
  canNavigateToday = true,
  navigationBoundsStart,
  navigationBoundsEnd,
  headerTitle,
  currentDate,
  onDateChange,
  onPrevClick,
  onNextClick,
  onTodayCentered,
  mobileNavHidden,
  floatingNavStyle,
  unscheduledEntries = [],
  onUnscheduledEntryClick,
}) => {
  const prevDisabled = navigationLocked || !canNavigatePrev;
  const nextDisabled = navigationLocked || !canNavigateNext;
  const todayDisabled = navigationLocked || !canNavigateToday;
  const datePickerDisabled = navigationLocked;
  const navDateInputRef = useRef<HTMLInputElement | null>(null);
  const unscheduledPopoverRef = useRef<HTMLDivElement>(null);
  const [showUnscheduled, setShowUnscheduled] = useState(false);
  const formatDateInputValue = useCallback((value?: Date) => {
    if (!value) return undefined;
    const d = new Date(value);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }, []);

  const handleDateInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (navigationLocked) return;
      if (!e.target.value) return;
      const [y, m, d] = e.target.value.split("-").map(Number);
      let nextDate = new Date(y, m - 1, d);
      if (navigationBoundsStart) {
        const min = new Date(navigationBoundsStart);
        min.setHours(0, 0, 0, 0);
        if (nextDate.getTime() < min.getTime()) {
          nextDate = min;
        }
      }
      if (navigationBoundsEnd) {
        const max = new Date(navigationBoundsEnd);
        max.setHours(0, 0, 0, 0);
        if (nextDate.getTime() > max.getTime()) {
          nextDate = max;
        }
      }
      if (onDateChange) onDateChange(nextDate);
    },
    [navigationLocked, onDateChange, navigationBoundsStart, navigationBoundsEnd],
  );

  if (!showNavButtons || mobileNavHidden) return null;

  const navStyle: React.CSSProperties = isMobile
    ? {
        position: "fixed",
        left: "50%",
        right: "auto",
        bottom:
          "calc(max(var(--tps-auto-base-embed-bottom, var(--tps-gcm-live-bottom, 16px)), var(--tps-gcm-mobile-toolbar-offset, 0px)) + env(safe-area-inset-bottom, 0px) + 10px)",
        top: "auto",
        transform: "translateX(-50%)",
        width: "min(calc(100vw - 24px), 420px)",
        maxWidth: "420px",
        backgroundColor: "color-mix(in srgb, var(--background-primary) 92%, transparent)",
        border: "1px solid var(--background-modifier-border)",
        borderRadius: "12px",
        padding: "6px 8px 8px",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: "6px",
        boxShadow: "0 6px 18px rgba(0,0,0,0.22)",
        flexWrap: "nowrap",
        minWidth: 0,
        pointerEvents: "auto",
        touchAction: "manipulation",
        zIndex: 10020,
        opacity: 1,
        visibility: "visible",
      }
    : floatingNavStyle;

  const nav = (
    <div
      className={`bases-calendar-floating-nav${isMobile ? " bases-calendar-floating-nav--mobile" : ""}`}
      style={navStyle}
    >
      <div style={{ position: "relative", display: "flex", minWidth: 0 }}>
        <button
          className="bases-calendar-title-text"
          style={{
            cursor: "pointer",
            fontWeight: 600,
            fontSize: isMobile ? "0.84rem" : "0.9rem",
            display: "flex",
            alignItems: "center",
            gap: "4px",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
            maxWidth: "100%",
            background: "transparent",
            border: "none",
            padding: 0,
            pointerEvents: "auto",
            opacity: datePickerDisabled ? 0.5 : 1,
          }}
          title="Jump to date"
          onClick={() => {
            if (datePickerDisabled) return;
            const input = navDateInputRef.current;
            if (!input) return;
            if (currentDate) {
              input.value = formatDateInputValue(currentDate) || "";
            }
            if (typeof (input as any).showPicker === "function") {
              (input as any).showPicker();
            } else {
              input.click();
            }
          }}
        >
          {headerTitle}
          <span style={{ fontSize: "0.6em", opacity: 0.7 }}>&#9660;</span>
        </button>
      </div>

      <input
        ref={navDateInputRef}
        type="date"
        style={{
          position: "absolute",
          opacity: 0,
          width: "1px",
          height: "1px",
          pointerEvents: "none",
        }}
        tabIndex={-1}
        min={formatDateInputValue(navigationBoundsStart)}
        max={formatDateInputValue(navigationBoundsEnd)}
        onChange={handleDateInputChange}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          flexWrap: "nowrap",
          justifyContent: "space-between",
          minWidth: 0,
        }}
      >
        <button
          className="bases-calendar-nav-button"
          onClick={onPrevClick}
          title="Previous"
          disabled={prevDisabled}
          style={{ pointerEvents: "auto", opacity: prevDisabled ? 0.5 : 1, flex: "0 0 auto" }}
        >
          &#8249;
        </button>
        <button
          className="bases-calendar-nav-button"
          onClick={onTodayCentered}
          disabled={todayDisabled}
          style={{
            fontSize: isMobile ? "0.72rem" : "0.8rem",
            padding: isMobile ? "2px 6px" : "2px 8px",
            pointerEvents: "auto",
            opacity: todayDisabled ? 0.5 : 1,
            flex: "1 1 auto",
            minWidth: 0,
          }}
        >
          Today
        </button>
        <button
          className="bases-calendar-nav-button"
          onClick={onNextClick}
          title="Next"
          disabled={nextDisabled}
          style={{ pointerEvents: "auto", opacity: nextDisabled ? 0.5 : 1, flex: "0 0 auto" }}
        >
          &#8250;
        </button>

        {unscheduledEntries.length > 0 && (
          <div style={{ position: "relative", marginLeft: "4px", flex: "0 0 auto" }}>
            <button
              className="bases-calendar-nav-button"
              title={`${unscheduledEntries.length} unscheduled note${unscheduledEntries.length === 1 ? "" : "s"}`}
              onClick={() => setShowUnscheduled((prev) => !prev)}
              style={{
                pointerEvents: "auto",
                fontSize: isMobile ? "0.72rem" : "0.8rem",
                padding: isMobile ? "2px 6px" : "2px 8px",
                display: "flex",
                alignItems: "center",
                gap: "4px",
                background: showUnscheduled
                  ? "var(--interactive-accent)"
                  : "var(--background-secondary)",
                color: showUnscheduled
                  ? "var(--text-on-accent)"
                  : "var(--text-muted)",
                border: "1px solid var(--background-modifier-border)",
                borderRadius: "4px",
              }}
            >
              <span style={{ fontSize: "0.75rem" }}>&#128197;</span>
              {unscheduledEntries.length}
            </button>

            {showUnscheduled && (
              <>
                <div
                  style={{ position: "fixed", inset: 0, zIndex: 9998 }}
                  onClick={() => setShowUnscheduled(false)}
                />
                <div
                  ref={unscheduledPopoverRef}
                  style={{
                    position: "absolute",
                    bottom: "100%",
                    right: 0,
                    marginBottom: "6px",
                    width: isMobile ? "calc(100vw - 32px)" : "260px",
                    maxHeight: "50vh",
                    overflowY: "auto",
                    background: "var(--background-primary)",
                    border: "1px solid var(--background-modifier-border)",
                    borderRadius: "6px",
                    boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
                    zIndex: 9999,
                    padding: "6px 0",
                  }}
                >
                  <div
                    style={{
                      padding: "4px 10px 8px",
                      fontSize: "0.7em",
                      fontWeight: 600,
                      color: "var(--text-muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                    }}
                  >
                    {unscheduledEntries.length} unscheduled
                  </div>
                  {unscheduledEntries.map((entry) => (
                    <UnscheduledItem
                      key={entry.file.path}
                      entry={entry}
                      onClick={() => {
                        setShowUnscheduled(false);
                        onUnscheduledEntryClick?.(entry.file);
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return nav;
};
