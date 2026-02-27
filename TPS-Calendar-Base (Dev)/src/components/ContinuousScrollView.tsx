import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import timeGridPlugin from "@fullcalendar/timegrid";
import { EventContentArg, EventMountArg } from "@fullcalendar/core";
import { Platform } from "obsidian";

const PLUGINS = [dayGridPlugin, timeGridPlugin, interactionPlugin];

interface ContinuousScrollViewProps {
  currentDate?: Date;
  events: any[];
  allDayMaxRows?: number;
  slotMinTimeValue: string;
  slotMaxTimeValue: string;
  defaultScrollTime: string;
  resolvedShowFullDay: boolean;
  safeWeekStartDay: number;
  allowEdit: boolean;
  allowSelect: boolean;
  onEventResize?: (...args: any[]) => any;
  // Handlers (shared with main calendar)
  handleEventClick: (info: any) => void;
  renderEventContent: (info: EventContentArg) => any;
  handleDrop: (info: any) => void;
  handleResize: (info: any) => void;
  handleEventMount: (arg: EventMountArg) => void;
  handleEventWillUnmount: (arg: EventMountArg) => void;
  handleDragStart: (info: any) => void;
  handleDragStop: (info: any) => void;
  handleResizeStart: (info: any) => void;
  handleResizeStop: (info: any) => void;
  handleSelect?: (selection: any) => void;
  onDateClick?: (date: Date) => void;
  onDateChange?: (date: Date) => void;
  handleMoreLinkClick?: (arg: any) => void;
  renderMoreLinkContent?: (arg: any) => any;
  allDayExpanded?: boolean;
}

/**
 * Renders a continuous vertical scroll view with one FullCalendar
 * per day, infinite scroll up/down (capped at 14 days).
 */
export const ContinuousScrollView: React.FC<ContinuousScrollViewProps> = ({
  currentDate,
  events,
  allDayMaxRows,
  slotMinTimeValue,
  slotMaxTimeValue,
  defaultScrollTime,
  resolvedShowFullDay,
  safeWeekStartDay,
  allowEdit,
  allowSelect,
  onEventResize,
  handleEventClick,
  renderEventContent,
  handleDrop,
  handleResize,
  handleEventMount,
  handleEventWillUnmount,
  handleDragStart,
  handleDragStop,
  handleResizeStart,
  handleResizeStop,
  handleSelect,
  onDateClick,
  onDateChange,
  handleMoreLinkClick,
  renderMoreLinkContent,
  allDayExpanded,
}) => {
  const isMobile = Platform.isMobile;
  const [continuousDays, setContinuousDays] = useState<Date[]>([]);
  const continuousContainerRef = useRef<HTMLDivElement>(null);
  const prevScrollHeightRef = useRef(0);
  const isPrependingRef = useRef(false);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize days on mount or date change
  useEffect(() => {
    const base = currentDate || new Date();

    const days = [];
    for (let i = -2; i <= 2; i++) {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      days.push(d);
    }
    setContinuousDays(days);

    setTimeout(() => {
      if (continuousContainerRef.current) {
        const centerEl = continuousContainerRef.current.children[2] as HTMLElement;
        if (centerEl) {
          continuousContainerRef.current.scrollTop = centerEl.offsetTop - 50;
        }
      }
    }, 50);
  }, [currentDate]);

  // Restore scroll position after prepend
  useLayoutEffect(() => {
    if (continuousContainerRef.current && isPrependingRef.current) {
      const el = continuousContainerRef.current;
      const heightDiff = el.scrollHeight - prevScrollHeightRef.current;
      if (heightDiff > 0) {
        el.scrollTop += heightDiff;
      }
      isPrependingRef.current = false;
    }
  }, [continuousDays]);

  const handleContinuousScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const threshold = 200;

    if (el.scrollTop < threshold) {
      prevScrollHeightRef.current = el.scrollHeight;
      isPrependingRef.current = true;
      setContinuousDays(prev => {
        const newDay = new Date(prev[0]);
        newDay.setDate(newDay.getDate() - 1);
        const next = [newDay, ...prev];
        if (next.length > 14) next.pop();
        return next;
      });
    }

    if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold) {
      setContinuousDays(prev => {
        const newDay = new Date(prev[prev.length - 1]);
        newDay.setDate(newDay.getDate() + 1);
        const next = [...prev, newDay];
        if (next.length > 14) next.shift();
        return next;
      });
    }

    // Debounce update to parent
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => {
      if (!onDateChange || !continuousContainerRef.current) return;

      // Find the visible day (closest to top + padding)
      const container = continuousContainerRef.current;
      const containerRect = container.getBoundingClientRect();
      const midY = containerRect.top + containerRect.height / 2;

      // Find child closest to midpoint
      let bestDay: Date | null = null;
      let minDist = Number.MAX_VALUE;

      // Children correspond to continuousDays (plus maybe spacers?)
      // The structure is flat divs.
      const children = Array.from(container.children).filter(c => c.classList.contains('bases-calendar-continuous-day-block'));

      children.forEach((child, index) => {
        const rect = child.getBoundingClientRect();
        const dist = Math.abs((rect.top + rect.height / 2) - midY);
        if (dist < minDist) {
          minDist = dist;
          const candidate = continuousDays[index];
          if (candidate) {
            bestDay = candidate;
          }
        }
      });

      if (bestDay && (!currentDate || (bestDay as Date).getTime() !== currentDate.getTime())) {
        onDateChange(bestDay as Date);
      }
    }, 300);

  }, [continuousDays, onDateChange, currentDate]);

  return (
    <div
      ref={continuousContainerRef}
      className="bases-calendar-continuous-scroll-container"
      style={{
        height: isMobile ? 'auto' : '100%',
        overflowY: isMobile ? 'visible' : 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        gap: '1px',
        background: 'var(--background-secondary)'
      }}
      onScroll={isMobile ? undefined : handleContinuousScroll}
    >
      {continuousDays.map(day => (
        <div
          key={day.toISOString()}
          className="bases-calendar-continuous-day-block"
          style={{
            minHeight: '800px',
            background: 'var(--background-primary)',
            position: 'relative'
          }}
        >
          <div style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            background: 'var(--background-primary)',
            padding: '8px 16px',
            borderBottom: '1px solid var(--background-modifier-border)',
            fontWeight: 600,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}>
            <span
              onClick={() => onDateClick && onDateClick(day)}
              style={{ cursor: 'pointer', textDecoration: 'none' }}
              className="fc-col-header-cell-cushion"
            >
              {day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
            </span>
            {day.toDateString() === new Date().toDateString() && (
              <span style={{
                fontSize: '0.8em',
                color: 'var(--text-accent)',
                background: 'rgba(var(--interactive-accent-rgb), 0.1)',
                padding: '2px 6px',
                borderRadius: '4px'
              }}>
                Today
              </span>
            )}
          </div>

          <FullCalendar
            key={`continuous-${day.toISOString()}`}
            plugins={PLUGINS}
            initialView="timeGridDay"
            initialDate={day}
            headerToolbar={false}
            height="auto"
            expandRows={!isMobile}
            slotMinTime={slotMinTimeValue}
            slotMaxTime={slotMaxTimeValue}
            scrollTime={defaultScrollTime}
            allDaySlot={resolvedShowFullDay}
            slotDuration="00:30:00"
            slotLabelInterval="01:00"
            events={events}
            firstDay={safeWeekStartDay}
            editable={allowEdit}
            eventStartEditable={allowEdit}
            eventDurationEditable={allowEdit && !!onEventResize}
            selectable={allowSelect}
            selectMirror={allowSelect}
            selectLongPressDelay={isMobile ? 600 : 300}
            longPressDelay={isMobile ? 600 : 300}
            eventLongPressDelay={isMobile ? 600 : 300}
            eventDragMinDistance={isMobile ? 10 : 5}
            eventClick={handleEventClick}
            eventContent={renderEventContent}
            eventDrop={handleDrop}
            eventResize={handleResize}
            eventDidMount={handleEventMount}
            eventWillUnmount={handleEventWillUnmount}
            eventDragStart={handleDragStart}
            eventDragStop={handleDragStop}
            eventResizeStart={handleResizeStart}
            eventResizeStop={handleResizeStop}
            select={allowSelect ? handleSelect : undefined}
            nowIndicator={true}
            dayMaxEvents={allDayExpanded ? false : (allDayMaxRows ?? 3)}
            dayMaxEventRows={allDayExpanded ? false : (allDayMaxRows ?? 3)}
            // @ts-ignore
            moreLinkClick={handleMoreLinkClick}
            moreLinkContent={renderMoreLinkContent}
            weekNumbers={false}
            weekends={true}
          />
        </div>
      ))}
    </div>
  );
};
