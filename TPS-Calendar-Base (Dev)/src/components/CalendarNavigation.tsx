import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface CalendarNavigationProps {
  showNavButtons?: boolean;
  navigationLocked?: boolean;
  canNavigatePrev?: boolean;
  canNavigateNext?: boolean;
  canNavigateToday?: boolean;
  headerPortalTarget?: HTMLElement | null;
  headerTitle: string;
  isMobile: boolean;
  currentDate?: Date;
  onDateChange?: (date: Date) => void;
  onPrevClick: () => void;
  onNextClick: () => void;
  onTodayCentered: () => void;
  mobileNavHidden: boolean;
  floatingNavStyle: React.CSSProperties;
  viewMode?: string;
  onViewModeChange?: (mode: string) => void;
  onCreateNow?: () => void;
  onUnscheduledEntries?: { filePath: string; title: string }[];
  onUnscheduledEntryClick?: (filePath: string) => void;
}

/**
 * Renders calendar navigation controls — either into a header portal
 * (desktop) or as a floating bar (mobile fallback).
 */
const VIEW_MODE_OPTIONS: { value: string; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: '3d', label: '3 Day' },
  { value: '5d', label: '5 Day' },
  { value: '7d', label: '7 Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
];

export const CalendarNavigation: React.FC<CalendarNavigationProps> = ({
  showNavButtons,
  navigationLocked = false,
  canNavigatePrev = true,
  canNavigateNext = true,
  canNavigateToday = true,
  headerPortalTarget,
  headerTitle,
  isMobile,
  currentDate,
  onDateChange,
  onPrevClick,
  onNextClick,
  onTodayCentered,
  mobileNavHidden,
  floatingNavStyle,
  viewMode,
  onViewModeChange,
  onCreateNow,
  onUnscheduledEntries,
  onUnscheduledEntryClick,
}) => {
  const prevDisabled = navigationLocked || !canNavigatePrev;
  const nextDisabled = navigationLocked || !canNavigateNext;
  const todayDisabled = navigationLocked || !canNavigateToday;
  const datePickerDisabled = navigationLocked;
  const viewPickerDisabled = navigationLocked;
  const navDateInputRef = useRef<HTMLInputElement | null>(null);

  // Unscheduled dropdown state
  const unscheduledBtnRef = useRef<HTMLButtonElement | null>(null);
  const unscheduledPanelRef = useRef<HTMLDivElement | null>(null);
  const [showUnscheduledPanel, setShowUnscheduledPanel] = useState(false);
  const [panelPos, setPanelPos] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (!showUnscheduledPanel) return;
    const handler = (e: MouseEvent) => {
      if (
        panelRef.current && panelRef.current.contains(e.target as Node)
      ) return;
      if (
        unscheduledBtnRef.current && unscheduledBtnRef.current.contains(e.target as Node)
      ) return;
      setShowUnscheduledPanel(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showUnscheduledPanel]);

  // alias so the useEffect above can ref the same element
  const panelRef = unscheduledPanelRef;

  const handleUnscheduledBtnClick = useCallback(() => {
    if (!showUnscheduledPanel && unscheduledBtnRef.current) {
      const rect = unscheduledBtnRef.current.getBoundingClientRect();
      setPanelPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setShowUnscheduledPanel(p => !p);
  }, [showUnscheduledPanel]);

  const handleDatePickerOpen = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (navigationLocked) return;
    const wrapper = e.currentTarget.parentElement;
    const input = wrapper?.querySelector('input');
    if (input) {
      try {
        if (currentDate) {
          const d = new Date(currentDate);
          const year = d.getFullYear();
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const day = String(d.getDate()).padStart(2, '0');
          input.value = `${year}-${month}-${day}`;
        } else {
          input.valueAsDate = new Date();
        }
        if (typeof (input as any).showPicker === 'function') {
          (input as any).showPicker();
        } else {
          input.focus();
          input.click();
        }
      } catch (err) {
        input.focus();
        input.click();
      }
    }
  }, [currentDate, navigationLocked]);

  const handleDateInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (navigationLocked) return;
    if (e.target.value) {
      const [y, m, d] = e.target.value.split('-').map(Number);
      if (onDateChange) onDateChange(new Date(y, m - 1, d));
    }
  }, [onDateChange, navigationLocked]);

  // Header portal navigation (desktop)
  const renderPortalNavigation = () => {
    if (!showNavButtons || !headerPortalTarget) return null;

    return createPortal(
      <div
        className="tps-calendar-header-nav"
        onClick={e => e.stopPropagation()}
      >
        <div className="bases-calendar-nav-group" style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
          {/* Calendar Picker */}
          <div style={{ position: 'relative', display: 'flex', marginRight: '2px' }}>
            <button
              className="bases-calendar-nav-button"
              aria-label="Jump to date"
              title="Jump to date"
              disabled={datePickerDisabled}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '4px',
                width: '24px',
                height: '24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                borderRadius: '4px',
                pointerEvents: isMobile ? 'none' : 'auto',
                opacity: datePickerDisabled ? 0.5 : 1,
              }}
              onClick={handleDatePickerOpen}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
            </button>
            <input
              type="date"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '24px',
                height: '24px',
                opacity: 0,
                zIndex: isMobile ? 10 : -1,
                pointerEvents: isMobile ? 'auto' : 'none',
                cursor: 'pointer'
              }}
              tabIndex={-1}
              onClick={(e) => {
                if (isMobile && currentDate) {
                  const d = new Date(currentDate);
                  const year = d.getFullYear();
                  const month = String(d.getMonth() + 1).padStart(2, '0');
                  const day = String(d.getDate()).padStart(2, '0');
                  e.currentTarget.value = `${year}-${month}-${day}`;
                }
              }}
              onChange={handleDateInputChange}
            />
          </div>

            <button
            className="bases-calendar-nav-button"
            onClick={onPrevClick}
            aria-label="Previous"
            title="Previous"
            disabled={prevDisabled}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              padding: '0',
              width: '24px',
              height: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
                borderRadius: '4px',
                fontSize: '18px',
                lineHeight: '1',
                opacity: prevDisabled ? 0.5 : 1,
              }}
            >
              &#8249;
            </button>

            <button
            className="bases-calendar-nav-button"
            onClick={onTodayCentered}
            aria-label="Today"
            disabled={todayDisabled}
              style={{
                background: 'transparent',
                border: '1px solid var(--background-modifier-border)',
                cursor: 'pointer',
              fontSize: '0.7rem',
              padding: '2px 8px',
              height: '24px',
                borderRadius: '4px',
                color: 'var(--text-normal)',
                margin: '0 2px',
                opacity: todayDisabled ? 0.5 : 1,
              }}
            >
              Today
            </button>

          <button
            className="bases-calendar-nav-button"
            onClick={onNextClick}
            aria-label="Next"
            title="Next"
            disabled={nextDisabled}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              padding: '0',
              width: '24px',
              height: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
                borderRadius: '4px',
                fontSize: '18px',
                lineHeight: '1',
                opacity: nextDisabled ? 0.5 : 1,
              }}
            >
              &#8250;
            </button>
        </div>

        {/* View Mode Picker */}
        {onViewModeChange && (
          <select
            className="tps-calendar-view-picker"
            value={viewMode || '7d'}
            onChange={(e) => onViewModeChange(e.target.value)}
            disabled={viewPickerDisabled}
            style={{
              background: 'var(--background-secondary)',
              border: '1px solid var(--background-modifier-border)',
              borderRadius: '4px',
              color: 'var(--text-normal)',
              fontSize: '0.7rem',
              padding: '2px 4px',
              height: '24px',
              cursor: viewPickerDisabled ? 'not-allowed' : 'pointer',
              marginLeft: '6px',
              outline: 'none',
              opacity: viewPickerDisabled ? 0.5 : 1,
            }}
          >
            {VIEW_MODE_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        )}

        {/* Create event button removed — base plugin provides a plus */}

        {/* Show unscheduled dropdown button */}
        {onUnscheduledEntries !== undefined && (
          <>
            <button
              ref={unscheduledBtnRef}
              className="bases-calendar-nav-button"
              aria-label="Show unscheduled notes"
              title="Show unscheduled notes"
              style={{
                background: showUnscheduledPanel ? 'var(--background-modifier-hover)' : 'transparent',
                border: 'none',
                marginLeft: '6px',
                cursor: 'pointer',
                padding: '4px',
                width: '24px',
                height: '24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: showUnscheduledPanel ? 'var(--text-normal)' : 'var(--text-muted)',
                borderRadius: '4px',
              }}
              onClick={handleUnscheduledBtnClick}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line><line x1="10" y1="14" x2="14" y2="18"></line><line x1="14" y1="14" x2="10" y2="18"></line></svg>
            </button>
            {showUnscheduledPanel && panelPos && createPortal(
              <div
                ref={unscheduledPanelRef}
                style={{
                  position: 'fixed',
                  top: panelPos.top,
                  right: panelPos.right,
                  width: '320px',
                  maxHeight: '400px',
                  overflowY: 'auto',
                  background: 'var(--background-primary)',
                  border: '1px solid var(--background-modifier-border)',
                  borderRadius: '8px',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
                  zIndex: 10000,
                  padding: '6px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0',
                }}
                onClick={e => e.stopPropagation()}
              >
                <div style={{
                  fontSize: '0.72em',
                  fontWeight: 600,
                  color: 'var(--text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  padding: '4px 6px 8px',
                }}>
                  {onUnscheduledEntries.length === 0
                    ? 'No unscheduled notes'
                    : `${onUnscheduledEntries.length} unscheduled note${onUnscheduledEntries.length === 1 ? '' : 's'}`}
                </div>
                {onUnscheduledEntries.map(entry => (
                  <div
                    key={entry.filePath}
                    draggable
                    onDragStart={(e: React.DragEvent<HTMLDivElement>) => {
                      e.dataTransfer.effectAllowed = 'copy';
                      e.dataTransfer.setData('obsidian/file', entry.filePath);
                      e.dataTransfer.setData('text/plain', entry.filePath);
                    }}
                    onDragEnd={() => {
                      // Close the panel after the drag completes so the browser
                      // doesn't cancel the drag when the source element is removed.
                      setShowUnscheduledPanel(false);
                    }}
                    onClick={() => {
                      onUnscheduledEntryClick?.(entry.filePath);
                      setShowUnscheduledPanel(false);
                    }}
                    style={{
                      padding: '5px 8px',
                      marginBottom: '2px',
                      borderRadius: '4px',
                      background: 'var(--background-secondary)',
                      borderLeft: '3px solid var(--interactive-accent)',
                      cursor: 'pointer',
                      fontSize: '0.82em',
                      color: 'var(--text-normal)',
                      fontWeight: 500,
                      wordBreak: 'break-word',
                      userSelect: 'none',
                      transition: 'background-color 0.1s',
                    }}
                    onMouseOver={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--background-modifier-hover)'; }}
                    onMouseOut={(e) => { (e.currentTarget as HTMLDivElement).style.backgroundColor = 'var(--background-secondary)'; }}
                  >
                    {entry.title}
                  </div>
                ))}
              </div>,
              document.body
            )}
          </>
        )}
      </div>,
      headerPortalTarget
    );
  };

  // Floating mobile navigation (fallback when no portal target)
  const renderFloatingNavigation = () => {
    if (!isMobile || headerPortalTarget || !showNavButtons || mobileNavHidden) return null;

    return (
      <div className="bases-calendar-floating-nav" style={floatingNavStyle}>
        <div style={{ position: 'relative', display: 'flex' }}>
          <button
            className="bases-calendar-title-text"
            style={{
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.9rem',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
              maxWidth: '100%',
              background: 'transparent',
              border: 'none',
              padding: 0,
              pointerEvents: 'auto',
              opacity: navigationLocked ? 0.5 : 1,
            }}
            title="Jump to date"
            onClick={() => {
              if (navigationLocked) return;
              const input = navDateInputRef.current;
              if (!input) return;
              if (currentDate) {
                const d = new Date(currentDate);
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                input.value = `${year}-${month}-${day}`;
              }
              if (typeof (input as any).showPicker === 'function') {
                (input as any).showPicker();
              } else {
                input.click();
              }
            }}
          >
            {headerTitle}
            <span style={{ fontSize: '0.6em', opacity: 0.7 }}>&#9660;</span>
          </button>
        </div>

        <input
          ref={navDateInputRef}
          type="date"
          style={{
            position: 'absolute',
            opacity: 0,
            width: '1px',
            height: '1px',
            pointerEvents: 'none',
          }}
          tabIndex={-1}
          onChange={handleDateInputChange}
        />

        <div style={{ width: '1px', height: '16px', background: 'var(--background-modifier-border)', margin: '0 2px' }} />

        <button className="bases-calendar-nav-button" onClick={onPrevClick} title="Previous" disabled={prevDisabled} style={{ pointerEvents: 'auto', opacity: prevDisabled ? 0.5 : 1 }}>&#8249;</button>
        <button className="bases-calendar-nav-button" onClick={onTodayCentered} disabled={todayDisabled} style={{ fontSize: '0.8rem', padding: '2px 8px', pointerEvents: 'auto', opacity: todayDisabled ? 0.5 : 1 }}>Today</button>
        <button className="bases-calendar-nav-button" onClick={onNextClick} title="Next" disabled={nextDisabled} style={{ pointerEvents: 'auto', opacity: nextDisabled ? 0.5 : 1 }}>&#8250;</button>

        {/* View Mode Picker */}
        {onViewModeChange && (
          <>
            <div style={{ width: '1px', height: '16px', background: 'var(--background-modifier-border)', margin: '0 2px' }} />
            <select
              className="tps-calendar-view-picker"
              value={viewMode || '7d'}
              onChange={(e) => onViewModeChange(e.target.value)}
              disabled={viewPickerDisabled}
              style={{
                background: 'var(--background-secondary)',
                border: '1px solid var(--background-modifier-border)',
                borderRadius: '4px',
                color: 'var(--text-normal)',
                fontSize: '0.8rem',
                padding: '2px 4px',
                height: '28px',
                cursor: viewPickerDisabled ? 'not-allowed' : 'pointer',
                outline: 'none',
                pointerEvents: 'auto',
                opacity: viewPickerDisabled ? 0.5 : 1,
              }}
            >
              {VIEW_MODE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </>
        )}

        {/* Create event button removed for consistency with base plugin */}
      </div>
    );
  };

  return (
    <>
      {renderPortalNavigation()}
      {renderFloatingNavigation()}
    </>
  );
};
