import React, { useCallback, useRef } from "react";
import { createPortal } from "react-dom";

interface CalendarNavigationProps {
  showNavButtons?: boolean;
  navigationLocked?: boolean;
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
}

/**
 * Renders calendar navigation controls — either into a header portal
 * (desktop) or as a floating bar (mobile fallback).
 */
export const CalendarNavigation: React.FC<CalendarNavigationProps> = ({
  showNavButtons,
  navigationLocked = false,
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
}) => {
  const navDateInputRef = useRef<HTMLInputElement | null>(null);

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
    if (!showNavButtons || !headerPortalTarget || navigationLocked) return null;

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
              disabled={navigationLocked}
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
                opacity: navigationLocked ? 0.5 : 1,
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
            disabled={navigationLocked}
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
                opacity: navigationLocked ? 0.5 : 1,
              }}
            >
              &#8249;
            </button>

            <button
            className="bases-calendar-nav-button"
            onClick={onTodayCentered}
            aria-label="Today"
            disabled={navigationLocked}
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
                opacity: navigationLocked ? 0.5 : 1,
              }}
            >
              Today
            </button>

          <button
            className="bases-calendar-nav-button"
            onClick={onNextClick}
            aria-label="Next"
            title="Next"
            disabled={navigationLocked}
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
                opacity: navigationLocked ? 0.5 : 1,
              }}
            >
              &#8250;
            </button>
        </div>
      </div>,
      headerPortalTarget
    );
  };

  // Floating mobile navigation (fallback when no portal target)
  const renderFloatingNavigation = () => {
    if (!isMobile || headerPortalTarget || !showNavButtons || mobileNavHidden || navigationLocked) return null;

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

        <button className="bases-calendar-nav-button" onClick={onPrevClick} title="Previous" disabled={navigationLocked} style={{ pointerEvents: 'auto', opacity: navigationLocked ? 0.5 : 1 }}>&#8249;</button>
        <button className="bases-calendar-nav-button" onClick={onTodayCentered} disabled={navigationLocked} style={{ fontSize: '0.8rem', padding: '2px 8px', pointerEvents: 'auto', opacity: navigationLocked ? 0.5 : 1 }}>Today</button>
        <button className="bases-calendar-nav-button" onClick={onNextClick} title="Next" disabled={navigationLocked} style={{ pointerEvents: 'auto', opacity: navigationLocked ? 0.5 : 1 }}>&#8250;</button>
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
