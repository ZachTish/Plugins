import React, { useCallback, useRef } from "react";

interface CalendarNavigationProps {
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
}

/**
 * Calendar navigation is intentionally floating on every platform.
 * Header portal controls were removed to keep the Bases header clean.
 */
export const CalendarNavigation: React.FC<CalendarNavigationProps> = ({
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
}) => {
  const prevDisabled = navigationLocked || !canNavigatePrev;
  const nextDisabled = navigationLocked || !canNavigateNext;
  const todayDisabled = navigationLocked || !canNavigateToday;
  const datePickerDisabled = navigationLocked;
  const navDateInputRef = useRef<HTMLInputElement | null>(null);
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

  return (
    <div className="bases-calendar-floating-nav" style={floatingNavStyle}>
      <div style={{ position: "relative", display: "flex" }}>
        <button
          className="bases-calendar-title-text"
          style={{
            cursor: "pointer",
            fontWeight: 600,
            fontSize: "0.9rem",
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
          width: "1px",
          height: "16px",
          background: "var(--background-modifier-border)",
          margin: "0 2px",
        }}
      />

      <button
        className="bases-calendar-nav-button"
        onClick={onPrevClick}
        title="Previous"
        disabled={prevDisabled}
        style={{ pointerEvents: "auto", opacity: prevDisabled ? 0.5 : 1 }}
      >
        &#8249;
      </button>
      <button
        className="bases-calendar-nav-button"
        onClick={onTodayCentered}
        disabled={todayDisabled}
        style={{
          fontSize: "0.8rem",
          padding: "2px 8px",
          pointerEvents: "auto",
          opacity: todayDisabled ? 0.5 : 1,
        }}
      >
        Today
      </button>
      <button
        className="bases-calendar-nav-button"
        onClick={onNextClick}
        title="Next"
        disabled={nextDisabled}
        style={{ pointerEvents: "auto", opacity: nextDisabled ? 0.5 : 1 }}
      >
        &#8250;
      </button>
    </div>
  );
};
