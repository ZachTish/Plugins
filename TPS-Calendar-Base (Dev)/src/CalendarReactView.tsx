import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import "../styles.css";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import timeGridPlugin from "@fullcalendar/timegrid";
import {
  DateSelectArg,
  EventClickArg,
  EventDropArg,
  EventMountArg,
  DatesSetArg,
} from "@fullcalendar/core";
import { BasesEntry, BasesPropertyId, Platform, Value, App } from "obsidian";
import { useApp } from "./hooks";
import * as logger from "./logger";
import {
  calculateSlotHeightFromZoom,
  calculateSlotZoom,
  DEFAULT_CONDENSE_LEVEL,
  DEFAULT_PRIORITY_COLOR_MAP,
} from "./utils";
import { ExternalCalendarEvent } from "./types";

// Extracted hooks
import { useCalendarZoom } from "./hooks/useCalendarZoom";
import { useTimeFollowing } from "./hooks/useTimeFollowing";
import { useCalendarEvents, normalizeValue, tryGetValue } from "./hooks/useCalendarEvents";

// Extracted components
import { useEventRenderer } from "./components/EventRenderer";
import { CalendarNavigation } from "./components/CalendarNavigation";
import { ContinuousScrollView } from "./components/ContinuousScrollView";

const DEFAULT_SLOT_MIN_TIME = "00:00:00";
const DEFAULT_SLOT_MAX_TIME = "24:00:00";
const DEFAULT_SCROLL_TIME = "08:00:00";
const PLUGINS = [dayGridPlugin, timeGridPlugin, interactionPlugin];

const HEADER_HEIGHT_VAR = "var(--tps-bases-header-height, 84px)";
type ViewMode = "day" | "3d" | "4d" | "5d" | "7d" | "week" | "month" | "continuous";
type ScrollSnapshotKind = "timegrid" | "continuous" | "surface";
const HOURS_TOGGLE_EDGE_THRESHOLD_PX = 24;
const IDLE_RETURN_TO_NOW_MS = 30_000;

export interface CalendarEntry {
  entry: BasesEntry;
  startDate: Date;
  endDate?: Date;
  title?: string;
  isGhost?: boolean;
  ghostDate?: Date;
  isExternal?: boolean;
  externalEvent?: ExternalCalendarEvent;
  color?: string;
  isHidden?: boolean;
  status?: string;
  priority?: string;
  style?: string;

  // Pre-calculated styles to avoid logic in View
  cssClasses?: string[];
  backgroundColor?: string;
  borderColor?: string;
}

interface CalendarReactViewProps {
  entries: CalendarEntry[];
  weekStartDay: number;
  properties: BasesPropertyId[];
  onEntryClick: (entry: CalendarEntry, isModEvent: boolean) => void;
  onEntryContextMenu: (evt: React.MouseEvent, entry: BasesEntry) => void;
  onEventDrop?: (
    entry: BasesEntry,
    newStart: Date,
    newEnd?: Date,
    allDay?: boolean,
    scope?: "all" | "single",
    oldStart?: Date,
    oldEnd?: Date,
  ) => Promise<void>;
  onEventResize?: (
    entry: BasesEntry,
    newStart: Date,
    newEnd?: Date,
    allDay?: boolean,
    scope?: "all" | "single",
    oldStart?: Date,
    oldEnd?: Date,
  ) => Promise<void>;
  onCreateSelection?: (start: Date, end: Date) => Promise<void>;
  onExternalDrop?: (filePath: string, start: Date, allDay: boolean) => Promise<void>;
  editable: boolean;

  condenseLevel?: number;
  onCondenseLevelChange?: (level: number) => void;
  showFullDay?: boolean;
  viewMode: ViewMode;
  slotRange?: { min: string; max: string };
  navStep?: number;
  onToggleFullDay?: () => void;
  allDayProperty?: BasesPropertyId | null;
  initialDate?: Date;
  currentDate?: Date;
  onDateChange?: (date: Date) => void;
  showHiddenHoursToggle?: boolean;
  defaultEventDuration?: number;
  onDateClick?: (date: Date) => void;
  allDayLimit?: number;
  onDateMouseEnter?: (date: Date, targetEl: HTMLElement, event: MouseEvent) => void;
  headerContainer?: HTMLElement;
  showNavButtons?: boolean;
  navigationLocked?: boolean;
  onDateSelectorClick?: () => void;
  headerPortalTarget?: HTMLElement | null;

  // Calendar appearance settings
  allDayEventHeight?: number;
  allDayMaxRows?: number;
  allDayStickyScroll?: boolean;
  dayHeaderFormatSetting?: "short" | "long" | "narrow";
  dayHeaderShowDate?: boolean;
  timeFormatSetting?: "12h" | "24h";
  slotDurationMinutes?: number;
  snapDurationMinutes?: number;
  defaultScrollTimeSetting?: string;
  showNowIndicator?: boolean;
  pastEventOpacity?: number;
  eventFontSize?: "small" | "default" | "large";
}

const normalizeDisplayTitle = (raw: string): string => {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(trimmed)) return trimmed;
  return trimmed.replace(/ \\d{4}-\\d{2}-\\d{2}$/, "");
};

const formatDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const timeToMinutes = (value: string): number => {
  const [hoursRaw, minutesRaw] = value.split(":");
  const hours = Number.parseInt(hoursRaw ?? "0", 10) || 0;
  const minutes = Number.parseInt(minutesRaw ?? "0", 10) || 0;
  return Math.max(0, hours * 60 + minutes);
};

export const CalendarReactView: React.FC<CalendarReactViewProps> = ({
  entries,
  weekStartDay,
  properties,
  onEntryClick,
  onEntryContextMenu,
  onEventDrop,
  onEventResize,
  onCreateSelection,
  onExternalDrop,
  editable,

  condenseLevel,
  onCondenseLevelChange,
  showFullDay,
  viewMode,
  slotRange,
  navStep,
  onToggleFullDay,
  allDayProperty,
  initialDate,
  currentDate,
  onDateChange,
  showHiddenHoursToggle = true,
  defaultEventDuration = 60,
  onDateClick,
  headerContainer,
  showNavButtons,
  navigationLocked = false,
  onDateMouseEnter,
  onDateSelectorClick,
  headerPortalTarget,
  allDayLimit,

  // Calendar appearance settings
  allDayEventHeight = 24,
  allDayMaxRows,
  allDayStickyScroll = true,
  dayHeaderFormatSetting = "short",
  dayHeaderShowDate = true,
  timeFormatSetting = "12h",
  slotDurationMinutes = 30,
  snapDurationMinutes = 5,
  defaultScrollTimeSetting = "08:00",
  showNowIndicator = true,
  pastEventOpacity = 55,
  eventFontSize = "default",
}) => {
  const app = useApp() || ((window as any).app as App);
  const calendarRef = useRef<FullCalendar>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState<number>(0);
  const [isEmbedMode, setIsEmbedMode] = useState(false);
  const [localShowFullDay, setLocalShowFullDay] = useState(
    showFullDay ?? true,
  );
  const [isTodayVisible, setIsTodayVisible] = useState(true);
  const [visibleDateRange, setVisibleDateRange] = useState<{ start: Date; end: Date } | null>(null);
  const [headerTitle, setHeaderTitle] = useState("");
  const [hiddenTimeVisible, setHiddenTimeVisible] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isInternalDragging, setIsInternalDragging] = useState(false);
  const [isMobileNavHidden, setIsMobileNavHidden] = useState(false);
  const [allDayExpanded, setAllDayExpanded] = useState(false);
  const [hoursToggleEdge, setHoursToggleEdge] = useState<"top" | "bottom">("bottom");
  const [hoursToggleVisible, setHoursToggleVisible] = useState(false);

  const dragCounterRef = useRef(0);
  const eventContextMenuHandlersRef = useRef(new Map<HTMLElement, (event: MouseEvent) => void>());
  const dayHeaderHoverHandlersRef = useRef(new Map<HTMLElement, (event: MouseEvent) => void>());
  const lastObservedScrollTopRef = useRef(0);
  const lastObservedScrollTargetRef = useRef<HTMLElement | null>(null);
  const [pendingChange, setPendingChange] = useState<{
    type: 'drop' | 'resize';
    info: any;
    entry: BasesEntry;
    newStart: Date;
    newEnd: Date | null;
    allDay: boolean;
    oldStart?: Date;
    oldEnd?: Date;
  } | null>(null);

  const [pendingCreation, setPendingCreation] = useState<{
    start: Date;
    end: Date;
  } | null>(null);

  // Tick for updating "past" status
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 60000);
    return () => clearInterval(interval);
  }, []);

  // Detect mobile platform
  const isMobile = Platform.isMobile;
  const mobileNavHidden = isInternalDragging || isMobileNavHidden;
  const showFloatingNav = !(showNavButtons === false) && !isMobile;
  const activePlugins = isMobile ? [dayGridPlugin, timeGridPlugin, interactionPlugin] : PLUGINS;
  const allowEdit = editable;
  const allowSelect = !!onCreateSelection;
  const floatingNavStyle: React.CSSProperties = {
    position: 'absolute',
    top: 'auto',
    bottom: '24px',
    left: '50%',
    transform: 'translateX(-50%)',
    backgroundColor: 'var(--background-primary)',
    border: '1px solid var(--background-modifier-border)',
    borderRadius: '20px',
    padding: '4px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
    flexWrap: 'nowrap',
    minWidth: 0,
    pointerEvents: 'none',
    touchAction: 'pan-y',
    zIndex: 10010,
  };

  useEffect(() => {
    if (!isMobile) return;
    setIsMobileNavHidden(false);
  }, [isMobile]);

  const handleCreateNow = useCallback(() => {
    if (!onCreateSelection) return;
    const now = new Date();
    const durationMinutes = Math.max(1, defaultEventDuration || 30);
    const end = new Date(now.getTime() + durationMinutes * 60 * 1000);
    onCreateSelection(now, end);
  }, [onCreateSelection, defaultEventDuration]);

  // --- View Configuration ---
  const safeWeekStartDay = Number.isFinite(weekStartDay)
    ? Math.max(0, Math.min(6, weekStartDay))
    : 1;
  const targetDayCount =
    viewMode === "day" ? 1 :
      viewMode === "3d" ? 3 :
        viewMode === "4d" ? 4 :
        viewMode === "5d" ? 5 :
          viewMode === "7d" ? 7 :
            viewMode === "week" ? 7 :
              7;
  const viewName =
    viewMode === "month" ? "dayGridMonth" :
      viewMode === "week" ? "timeGridWeek" :
        viewMode === "day" ? "timeGridDay" :
          viewMode === "continuous" ? "timeGridDay" :
            `timeGridRange-${targetDayCount}`;

  const navStepValue = typeof navStep === "number" ? navStep : 0;
  const isWeekView = viewMode === "week" || viewMode === "7d";

  const resolvedNavDays =
    !isWeekView && Number.isFinite(navStepValue) && navStepValue > 0
      ? Math.round(navStepValue)
      : targetDayCount;

  // Center the initial date in the view
  const initialDateRef = useRef<Date | null>(null);
  const lastViewModeRef = useRef<ViewMode | null>(null);
  if (lastViewModeRef.current !== viewMode) {
    lastViewModeRef.current = viewMode;
    initialDateRef.current = null;
  }

  if (!initialDateRef.current) {
    if (initialDate) {
      initialDateRef.current = initialDate;
    } else {
      const baseDate = currentDate ?? entries[0]?.startDate ?? new Date();
      if (viewMode === "month") {
        initialDateRef.current = baseDate;
      } else {
        const offset = Math.floor((targetDayCount - 1) / 2);
        const centered = new Date(baseDate);
        centered.setHours(0, 0, 0, 0);
        centered.setDate(centered.getDate() - offset);
        initialDateRef.current = centered;
      }
    }
  }

  const safeInitialDate = initialDateRef.current!;
  const resolvedShowFullDay =
    typeof showFullDay === "boolean" ? showFullDay : localShowFullDay;
  const hasCustomSlotRange = !!slotRange && (
    slotRange.min !== DEFAULT_SLOT_MIN_TIME ||
    slotRange.max !== DEFAULT_SLOT_MAX_TIME
  );
  const shouldEnableScrollHoursToggle = showHiddenHoursToggle && hasCustomSlotRange;
  const slotMinTimeValue = hiddenTimeVisible
    ? DEFAULT_SLOT_MIN_TIME
    : slotRange?.min ?? DEFAULT_SLOT_MIN_TIME;
  const slotMaxTimeValue = hiddenTimeVisible
    ? DEFAULT_SLOT_MAX_TIME
    : slotRange?.max ?? DEFAULT_SLOT_MAX_TIME;

  const getScrollTargetByKind = useCallback((kind: ScrollSnapshotKind): HTMLElement | null => {
    const root = containerRef.current;
    if (!root) return null;

    if (kind === "timegrid") {
      const nowLineScroller = root
        .querySelector<HTMLElement>(".fc-timegrid-now-indicator-line")
        ?.closest<HTMLElement>(".fc-scroller");
      if (nowLineScroller) return nowLineScroller;

      const bodyScroller = root
        .querySelector<HTMLElement>(".fc-timegrid-body")
        ?.closest<HTMLElement>(".fc-scroller");
      if (bodyScroller) return bodyScroller;

      const colsScroller = root
        .querySelector<HTMLElement>(".fc-timegrid-cols")
        ?.closest<HTMLElement>(".fc-scroller");
      if (colsScroller) return colsScroller;

      const slotsScroller = root
        .querySelector<HTMLElement>(".fc-timegrid-slots")
        ?.closest<HTMLElement>(".fc-scroller");
      if (slotsScroller) return slotsScroller;

      const scrollers = Array.from(root.querySelectorAll<HTMLElement>(".fc-scroller"));
      if (!scrollers.length) return null;

      const overflow = scrollers
        .filter((el) => el.scrollHeight > el.clientHeight + 1)
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));

      return overflow[0] || scrollers[0] || null;
    }
    if (kind === "continuous") {
      return root.querySelector<HTMLElement>(".bases-calendar-continuous-scroll-container");
    }
    return root.querySelector<HTMLElement>(".bases-calendar-scroll-surface");
  }, []);

  const scrollToTimelineEdge = useCallback((edge: "top" | "bottom") => {
    const apply = () => {
      const primaryKind: ScrollSnapshotKind = viewMode === "continuous" ? "continuous" : "timegrid";
      const target = getScrollTargetByKind(primaryKind) || getScrollTargetByKind("surface");
      if (!target) return;

      if (edge === "top") {
        target.scrollTop = 0;
      } else {
        target.scrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
      }
    };

    [0, 40, 120, 260].forEach((delayMs) => {
      window.setTimeout(() => {
        requestAnimationFrame(apply);
      }, delayMs);
    });
  }, [getScrollTargetByKind, viewMode]);

  // --- Hidden time indicator ---
  const hiddenTimeIndicatorDates = useMemo(() => {
    if (!hasCustomSlotRange || hiddenTimeVisible || !slotRange) {
      return new Set<string>();
    }

    const minMinutes = timeToMinutes(slotRange.min);
    const maxMinutes = timeToMinutes(slotRange.max);
    const dates = new Set<string>();

    entries.forEach((calEntry) => {
      const allDayValue = allDayProperty
        ? tryGetValue(calEntry.entry, allDayProperty)
        : null;
      const normalizedAllDay = normalizeValue(allDayValue).trim().toLowerCase();
      const isAllDay = ["true", "yes", "y", "1"].includes(normalizedAllDay);
      if (isAllDay) return;

      const start = calEntry.startDate;
      const end = calEntry.endDate
        ? calEntry.endDate
        : new Date(start.getTime() + defaultEventDuration * 60 * 1000);

      const startMinutes = start.getHours() * 60 + start.getMinutes();
      const endMinutes = end.getHours() * 60 + end.getMinutes();
      const spansDays = formatDateKey(start) !== formatDateKey(end);
      const isHidden =
        startMinutes < minMinutes ||
        startMinutes >= maxMinutes ||
        endMinutes <= minMinutes ||
        endMinutes > maxMinutes ||
        spansDays;

      if (isHidden) {
        dates.add(formatDateKey(start));
        if (spansDays) {
          dates.add(formatDateKey(end));
        }
      }
    });

    return dates;
  }, [entries, slotRange, hiddenTimeVisible, hasCustomSlotRange, allDayProperty, defaultEventDuration]);

  const hasHiddenTimeEventsInVisibleRange = useMemo(() => {
    if (hiddenTimeVisible || !visibleDateRange || hiddenTimeIndicatorDates.size === 0) {
      return false;
    }

    const startKey = formatDateKey(visibleDateRange.start);
    const endKey = formatDateKey(visibleDateRange.end);
    for (const dateKey of hiddenTimeIndicatorDates) {
      if (dateKey >= startKey && dateKey < endKey) {
        return true;
      }
    }
    return false;
  }, [hiddenTimeVisible, visibleDateRange, hiddenTimeIndicatorDates]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const dateEls = container.querySelectorAll<HTMLElement>(
      ".fc-timegrid-col[data-date], .fc-col-header-cell[data-date]"
    );
    dateEls.forEach((el) => {
      const date = el.getAttribute("data-date");
      if (date && hiddenTimeIndicatorDates.has(date)) {
        el.classList.add("has-hidden-time-event");
      } else {
        el.classList.remove("has-hidden-time-event");
      }
    });
  }, [hiddenTimeIndicatorDates, viewMode]);

  // --- Embed mode detection ---
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const embedSelectors = ".markdown-embed, .internal-embed, .cm-embed-block, .sync-embed, .sync-container, .markdown-reading-view, .markdown-preview-view";
    const isInEmbed = !!containerRef.current.closest(embedSelectors);
    const previewView = containerRef.current.closest('.markdown-preview-view');
    const isInReadingModeEmbed = previewView && !!containerRef.current.closest('.internal-embed, .markdown-embed');
    const leafContent = containerRef.current.closest('.workspace-leaf-content');
    const viewType = leafContent?.getAttribute('data-type');
    const isBasesInMarkdown = viewType === 'markdown' && !!containerRef.current.closest('.internal-embed');
    setIsEmbedMode(isInEmbed || isInReadingModeEmbed || isBasesInMarkdown);
  }, []);

  // --- Zoom / Condense ---
  const effectiveCondenseLevel = condenseLevel ?? DEFAULT_CONDENSE_LEVEL;
  const zoom = calculateSlotZoom(effectiveCondenseLevel);
  const effectiveZoom = isEmbedMode && isMobile ? Math.min(zoom, 0.85) : zoom;
  const computedSlotHeight = calculateSlotHeightFromZoom(effectiveZoom);
  const embedFallbackHeight = 420;
  const computedEmbedCalendarHeight = containerHeight > 0
    ? Math.max(320, Math.round(containerHeight))
    : embedFallbackHeight;

  const fullCalendarHeight: number | "auto" | "100%" = isEmbedMode
    ? computedEmbedCalendarHeight
    : isMobile
      ? "auto"
      : "100%";
  const fullCalendarContentHeight: number | "auto" | "100%" = fullCalendarHeight;

  const scrollSurfaceHeight = isEmbedMode
    ? `${computedEmbedCalendarHeight}px`
    : isMobile
      ? "auto"
      : "100%";

  const scrollSurfaceOverflowY = isEmbedMode
    ? "auto"
    : isMobile
      ? "visible"
      : "hidden";

  useEffect(() => {
    const api = calendarRef.current?.getApi();
    if (containerRef.current) {
      containerRef.current.style.setProperty('--calendar-slot-height', `${computedSlotHeight}px`);
    }
    if (api) {
      api.updateSize();
    }
  }, [effectiveCondenseLevel, resolvedShowFullDay, viewMode, computedSlotHeight]);

  useEffect(() => {
    if (!isEmbedMode || !calendarRef.current) return;

    // Embedded bases can stay hidden/offscreen while rendering; force late size sync after reveal.
    const timeouts = [250, 600, 1200, 2000].map((delay) =>
      window.setTimeout(() => {
        const api = calendarRef.current?.getApi();
        if (!api) return;
        api.updateSize();
      }, delay),
    );

    return () => {
      timeouts.forEach((id) => window.clearTimeout(id));
    };
  }, [isEmbedMode, fullCalendarHeight, viewMode]);

  // Pinch-to-zoom hook
  const { currentSlotHeightRef } = useCalendarZoom({
    containerRef: containerRef as React.RefObject<HTMLDivElement>,
    computedSlotHeight,
    onCondenseLevelChange,
  });

  // Time-following hook
  const { isFollowingNow, setIsFollowingNow, scrollToNow } = useTimeFollowing({
    calendarRef: calendarRef as React.RefObject<FullCalendar>,
    containerRef: containerRef as React.RefObject<HTMLDivElement>,
    computedSlotHeight,
  });

  // Events hook
  const { basesEntryMap, events } = useCalendarEvents({
    entries,
    allDayProperty,
    defaultEventDuration,
    tick,
  });

  // Event renderer hook
  const sanitizedProperties = properties ?? [];
  const { renderEventContent } = useEventRenderer({
    app,
    sanitizedProperties,
    basesEntryMap,
  });

  // --- Sync effects ---
  useEffect(() => {
    if (typeof showFullDay === "boolean") {
      setLocalShowFullDay(showFullDay);
    }
  }, [showFullDay]);

  useEffect(() => {
    if (!slotRange) {
      setHiddenTimeVisible(false);
    }
  }, [slotRange]);

  useEffect(() => {
    if (!shouldEnableScrollHoursToggle) {
      setHoursToggleVisible(false);
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const handleScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.scrollHeight <= target.clientHeight + 1) return;

      const isTimegridScroller = target.classList.contains("fc-scroller") && !!target.closest(".fc-timegrid");
      const isContinuousScroller = target.classList.contains("bases-calendar-continuous-scroll-container");
      if (!isTimegridScroller && !isContinuousScroller) return;

      const nextTop = target.scrollTop;
      if (lastObservedScrollTargetRef.current !== target) {
        lastObservedScrollTargetRef.current = target;
        lastObservedScrollTopRef.current = nextTop;
        return;
      }
      const prevTop = lastObservedScrollTopRef.current;
      const delta = nextTop - prevTop;
      if (Math.abs(delta) < 2) return;

      const maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
      const distanceToTop = Math.max(0, nextTop);
      const distanceToBottom = Math.max(0, maxScrollTop - nextTop);
      const isNearTop = distanceToTop <= HOURS_TOGGLE_EDGE_THRESHOLD_PX;
      const isNearBottom = distanceToBottom <= HOURS_TOGGLE_EDGE_THRESHOLD_PX;

      lastObservedScrollTopRef.current = nextTop;
      if (hiddenTimeVisible) {
        if (hoursToggleVisible) {
          setHoursToggleVisible(false);
        }
        return;
      }

      if (!(isNearTop || isNearBottom)) {
        if (hoursToggleVisible) {
          const oppositeDirectionForTop = hoursToggleEdge === "top" && delta > 0;
          const oppositeDirectionForBottom = hoursToggleEdge === "bottom" && delta < 0;
          if (oppositeDirectionForTop || oppositeDirectionForBottom) {
            setHoursToggleVisible(false);
          }
        }
        return;
      }

      if (isNearTop && !isNearBottom) {
        setHoursToggleEdge("top");
      } else if (isNearBottom && !isNearTop) {
        setHoursToggleEdge("bottom");
      } else {
        setHoursToggleEdge(delta > 0 ? "bottom" : "top");
      }
      setHoursToggleVisible(true);
    };

    container.addEventListener("scroll", handleScroll, true);
    return () => {
      container.removeEventListener("scroll", handleScroll, true);
    };
  }, [
    shouldEnableScrollHoursToggle,
    hiddenTimeVisible,
    hoursToggleEdge,
    hoursToggleVisible,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let inactivityTimeoutId: number | null = null;

    const engageFollowNow = () => {
      if (!isTodayVisible) return;

      const shouldRestoreNowState = hiddenTimeVisible || !isFollowingNow;
      if (!shouldRestoreNowState) return;

      setHiddenTimeVisible(false);
      setHoursToggleVisible(false);
      setIsFollowingNow(true);
      if (hiddenTimeVisible) {
        window.setTimeout(() => scrollToNow(), 80);
        return;
      }
      scrollToNow();
    };

    const armInactivityTimeout = () => {
      if (inactivityTimeoutId !== null) {
        window.clearTimeout(inactivityTimeoutId);
      }
      inactivityTimeoutId = window.setTimeout(engageFollowNow, IDLE_RETURN_TO_NOW_MS);
    };

    const handleActivity = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !container.contains(target)) return;
      armInactivityTimeout();
    };

    const capture = true;
    container.addEventListener("scroll", handleActivity, capture);
    container.addEventListener("wheel", handleActivity, capture);
    container.addEventListener("touchstart", handleActivity, capture);
    container.addEventListener("pointerdown", handleActivity, capture);
    container.addEventListener("click", handleActivity, capture);
    container.addEventListener("contextmenu", handleActivity, capture);
    container.addEventListener("keydown", handleActivity, capture);

    armInactivityTimeout();

    return () => {
      if (inactivityTimeoutId !== null) {
        window.clearTimeout(inactivityTimeoutId);
      }
      container.removeEventListener("scroll", handleActivity, capture);
      container.removeEventListener("wheel", handleActivity, capture);
      container.removeEventListener("touchstart", handleActivity, capture);
      container.removeEventListener("pointerdown", handleActivity, capture);
      container.removeEventListener("click", handleActivity, capture);
      container.removeEventListener("contextmenu", handleActivity, capture);
      container.removeEventListener("keydown", handleActivity, capture);
    };
  }, [
    hiddenTimeVisible,
    isFollowingNow,
    isTodayVisible,
    scrollToNow,
    setIsFollowingNow,
  ]);

  // Container resize handling
  useEffect(() => {
    if (!containerRef.current || !calendarRef.current) return;

    const containerEl = containerRef.current;
    const lastSizeRef = { width: 0, height: 0 };
    let resizeTimeout: NodeJS.Timeout | null = null;
    let rafId: number | null = null;

    const timeouts = [50, 200, 500].map(delay =>
      setTimeout(() => {
        if (calendarRef.current) {
          calendarRef.current.getApi().updateSize();
        }
      }, delay)
    );

    const handleResize = () => {
      if (!containerEl) return;
      const rect = containerEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      setContainerHeight((prev) => {
        const next = Math.round(rect.height);
        return Math.abs(prev - next) > 1 ? next : prev;
      });
      const widthDiff = Math.abs(rect.width - lastSizeRef.width);
      const heightDiff = Math.abs(rect.height - lastSizeRef.height);
      if (widthDiff < 1 && heightDiff < 1) return;
      lastSizeRef.width = rect.width;
      lastSizeRef.height = rect.height;

      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }

      const runUpdate = (delay: number) => {
        resizeTimeout = setTimeout(() => {
          if (calendarRef.current) {
            const api = calendarRef.current.getApi();
            if (isEmbedMode) {
              if (rafId) cancelAnimationFrame(rafId);
              rafId = requestAnimationFrame(() => {
                api.updateSize();
              });
              return;
            }
            const currentHeight = api.getOption("height");
            api.setOption("height", "auto");
            requestAnimationFrame(() => {
              api.setOption("height", currentHeight);
              api.updateSize();
            });
          }
        }, delay);
      };

      if (isEmbedMode) {
        runUpdate(200);
        return;
      }

      requestAnimationFrame(() => {
        if (calendarRef.current) {
          const api = calendarRef.current.getApi();
          const currentHeight = api.getOption('height');
          api.setOption('height', 'auto');
          requestAnimationFrame(() => {
            api.setOption('height', currentHeight);
            api.updateSize();
          });
        }
      });

      runUpdate(150);
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerEl);

    if (!isEmbedMode) {
      let parent = containerEl.parentElement;
      let depth = 0;
      while (parent && depth < 5) {
        resizeObserver.observe(parent);
        parent = parent.parentElement;
        depth++;
      }
    }

    return () => {
      resizeObserver.disconnect();
      timeouts.forEach(clearTimeout);
      if (resizeTimeout) {
        clearTimeout(resizeTimeout);
      }
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [isEmbedMode]);

  // Window resize fallback
  useEffect(() => {
    if (isEmbedMode) return;
    const handleResize = () => {
      if (calendarRef.current) {
        calendarRef.current.getApi().updateSize();
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [isEmbedMode]);

  // Sync current date from outside
  useEffect(() => {
    if (currentDate && calendarRef.current) {
      const api = calendarRef.current.getApi();
      if (viewMode !== "month" && viewMode !== "week") {
        const offset = Math.floor((targetDayCount - 1) / 2);
        const centered = new Date(currentDate);
        centered.setHours(0, 0, 0, 0);
        centered.setDate(centered.getDate() - offset);
        if (api.getDate().getTime() !== centered.getTime()) {
          api.gotoDate(centered);
        }
      } else {
        if (api.getDate().getTime() !== currentDate.getTime()) {
          api.gotoDate(currentDate);
        }
      }
    }
  }, [currentDate, viewMode, targetDayCount]);

  // --- Event handlers ---
  const handleEventClick = useCallback(
    (clickInfo: EventClickArg) => {
      clickInfo.jsEvent.preventDefault();
      const directCalendarEntry = clickInfo.event.extendedProps.calendarEntry as CalendarEntry | undefined;
      const entryPath = clickInfo.event.extendedProps.entryPath as string | undefined;
      const entry =
        directCalendarEntry ??
        entries.find((candidate) => candidate.entry.file.path === entryPath);

      const isModEvent = clickInfo.jsEvent.ctrlKey || clickInfo.jsEvent.metaKey;
      if (!entry) return;

      if (Platform.isMobile) {
        const syntheticEvent = {
          nativeEvent: clickInfo.jsEvent,
          currentTarget: clickInfo.el,
          target: clickInfo.el,
          preventDefault: () => clickInfo.jsEvent.preventDefault(),
          stopPropagation: () => clickInfo.jsEvent.stopPropagation(),
        } as unknown as React.MouseEvent;
        (syntheticEvent.nativeEvent as any).fullCalendarEvent = clickInfo.event;
        onEntryContextMenu(syntheticEvent, entry.entry);
        return;
      }
      onEntryClick(entry, isModEvent);
    },
    [onEntryClick, onEntryContextMenu, entries],
  );

  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }

      for (const [element, handler] of eventContextMenuHandlersRef.current.entries()) {
        element.removeEventListener("contextmenu", handler);
      }
      eventContextMenuHandlersRef.current.clear();

      for (const [element, handler] of dayHeaderHoverHandlersRef.current.entries()) {
        element.removeEventListener("mouseenter", handler);
      }
      dayHeaderHoverHandlersRef.current.clear();
    };
  }, []);

  const handleEventMouseEnter = useCallback(
    (mouseEnterInfo: { event: any; el: HTMLElement; jsEvent: MouseEvent }) => {
      const entryPath = mouseEnterInfo.event.extendedProps.entryPath;
      const entry = entryPath ? basesEntryMap.get(entryPath) : undefined;
      if (!entry) return;

      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }

      hoverTimeoutRef.current = setTimeout(() => {
        if (app && entry) {
          app.workspace.trigger("hover-link", {
            event: mouseEnterInfo.jsEvent,
            source: "bases",
            hoverParent: app.renderContext,
            targetEl: mouseEnterInfo.el,
            linktext: entry.file.path,
          });
        }
      }, 300);
    },
    [app, basesEntryMap],
  );

  const handleMoreLinkClick = useCallback((_arg: any) => {
    setAllDayExpanded(prev => !prev);
    return false;
  }, []);

  const renderMoreLinkContent = useCallback((arg: any) => {
    if (allDayExpanded) {
      return { html: '<span class="tps-allday-collapse-link">↑ less</span>' };
    }
    return { html: `<span class="tps-allday-more-link">+${arg.num} more</span>` };
  }, [allDayExpanded]);

  const handleEventMouseLeave = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  const handleDrop = useCallback(
    async (dropInfo: EventDropArg) => {
      const allDay = dropInfo.event.allDay;
      if (!onEventDrop) {
        dropInfo.revert();
        return;
      }
      const entryPath = dropInfo.event.extendedProps.entryPath;
      const entry = entryPath ? basesEntryMap.get(entryPath) : undefined;
      if (!entry) { dropInfo.revert(); return; }
      const newStart = dropInfo.event.start;
      const newEnd = dropInfo.event.end;
      if (!newStart) { dropInfo.revert(); return; }
      const oldStart = dropInfo.oldEvent?.start ?? undefined;
      const oldEnd = dropInfo.oldEvent?.end ?? undefined;
      setPendingChange({ type: 'drop', info: dropInfo, entry, newStart, newEnd: newEnd ?? newStart, allDay, oldStart, oldEnd });
    },
    [onEventDrop, basesEntryMap],
  );

  const handleResize = useCallback(
    async (resizeInfo: any) => {
      if (!onEventResize) { resizeInfo.revert(); return; }
      const entryPath = resizeInfo.event.extendedProps.entryPath;
      const entry = entryPath ? basesEntryMap.get(entryPath) : undefined;
      if (!entry) { resizeInfo.revert(); return; }
      const newStart = resizeInfo.event.start;
      const newEnd = resizeInfo.event.end;
      if (!newStart || !newEnd) { resizeInfo.revert(); return; }
      const oldStart = resizeInfo.oldEvent?.start ?? undefined;
      const oldEnd = resizeInfo.oldEvent?.end ?? undefined;
      setPendingChange({ type: 'resize', info: resizeInfo, entry, newStart, newEnd, allDay: resizeInfo.event.allDay, oldStart, oldEnd });
    },
    [onEventResize, basesEntryMap],
  );

  const confirmChangeWithScope = useCallback(async (scope: "all" | "single") => {
    if (!pendingChange) return;
    try {
      if (pendingChange.type === 'drop' && onEventDrop) {
        await onEventDrop(pendingChange.entry, pendingChange.newStart, pendingChange.newEnd ?? undefined, pendingChange.allDay, scope, pendingChange.oldStart, pendingChange.oldEnd ?? undefined);
      } else if (pendingChange.type === 'resize' && onEventResize) {
        await onEventResize(pendingChange.entry, pendingChange.newStart, pendingChange.newEnd ?? undefined, pendingChange.allDay, scope, pendingChange.oldStart, pendingChange.oldEnd ?? undefined);
      }
      setPendingChange(null);
    } catch (error) {
      logger.error(error);
      pendingChange.info.revert();
      setPendingChange(null);
    }
  }, [pendingChange, onEventDrop, onEventResize]);

  const handleCancelChange = useCallback(() => {
    if (!pendingChange) return;
    pendingChange.info.revert();
    setPendingChange(null);
  }, [pendingChange]);

  // --- Time labels for drag/resize ---
  const formatTime = useCallback((date: Date) => {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }, []);

  const updateTimeLabels = useCallback(
    (event: any, element: HTMLElement) => {
      const start = event.start;
      const end = event.end;
      const topLabel = element.querySelector(".bases-calendar-time-top") as HTMLElement;
      const bottomLabel = element.querySelector(".bases-calendar-time-bottom") as HTMLElement;
      if (!topLabel || !bottomLabel || !start || !end) return;
      topLabel.textContent = formatTime(start);
      bottomLabel.textContent = formatTime(end);
    },
    [formatTime],
  );

  const setLabelsVisible = useCallback((element: HTMLElement, visible: boolean) => {
    const labels = element.querySelectorAll(
      ".bases-calendar-time-top, .bases-calendar-time-bottom",
    );
    labels.forEach((label) => {
      if (visible) {
        label.classList.add("is-visible");
      } else {
        label.classList.remove("is-visible");
      }
    });
  }, []);

  const handleEventMount = useCallback(
    (arg: EventMountArg) => {
      const element = arg.el;
      const event = arg.event;
      if (!element) return;

      const priorityColor = (event.extendedProps.priorityColor as string | undefined) ?? "";
      if (priorityColor) {
        element.style.setProperty("--priority-color", priorityColor);
      }

      if (event.extendedProps.entryPath) {
        element.setAttribute('data-path', event.extendedProps.entryPath);
        element.classList.add('tps-calendar-entry');
      }

      let top = element.querySelector(".bases-calendar-time-top") as HTMLElement;
      let bottom = element.querySelector(".bases-calendar-time-bottom") as HTMLElement;
      if (!top) {
        top = document.createElement("div");
        top.className = "bases-calendar-time-top";
        element.prepend(top);
      }
      if (!bottom) {
        bottom = document.createElement("div");
        bottom.className = "bases-calendar-time-bottom";
        element.append(bottom);
      }

      updateTimeLabels(event, element);
      setLabelsVisible(element, false);

      const contextMenuHandler = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const entry = event.extendedProps.entry as BasesEntry;
        if (entry && onEntryContextMenu) {
          (e as any).fullCalendarEvent = event;
          const syntheticEvent = {
            nativeEvent: e,
            currentTarget: element,
            target: e.target as HTMLElement,
            preventDefault: () => e.preventDefault(),
            stopPropagation: () => e.stopPropagation(),
          } as unknown as React.MouseEvent;
          (syntheticEvent.nativeEvent as any).fullCalendarEvent = event;
          onEntryContextMenu(syntheticEvent, entry);
        }
      };
      const previousContextHandler = eventContextMenuHandlersRef.current.get(element);
      if (previousContextHandler) {
        element.removeEventListener("contextmenu", previousContextHandler);
      }
      eventContextMenuHandlersRef.current.set(element, contextMenuHandler);
      element.addEventListener('contextmenu', contextMenuHandler);
    },
    [setLabelsVisible, updateTimeLabels, onEntryContextMenu],
  );

  const handleDayMount = useCallback((arg: any) => {
    const { date, el } = arg;
    const link = el.querySelector('a.fc-col-header-cell-cushion, a.fc-daygrid-day-number');
      if (link) {
        if (!(link as HTMLElement).dataset?.tpsDailyNoteBound) {
        (link as HTMLElement).dataset.tpsDailyNoteBound = "true";
        link.addEventListener('click', (e: MouseEvent) => {
          if (onDateClick) {
            e.preventDefault();
            e.stopPropagation();
            onDateClick(date);
          }
        });
      }
      const linkEl = link as HTMLElement;
      const previousHoverHandler = dayHeaderHoverHandlersRef.current.get(linkEl);
      if (previousHoverHandler) {
        linkEl.removeEventListener("mouseenter", previousHoverHandler);
      }
      const hoverHandler = (e: MouseEvent) => {
        if (onDateMouseEnter) onDateMouseEnter(date, linkEl, e);
      };
      dayHeaderHoverHandlersRef.current.set(linkEl, hoverHandler);
      linkEl.addEventListener("mouseenter", hoverHandler);
    }

    if (Platform.isMobile) {
      // Mobile header injection removed in favor of floating controls
    }
  }, [onDateMouseEnter, viewMode, resolvedNavDays, onDateChange]);

  const handleEventWillUnmount = useCallback((arg: EventMountArg) => {
    const element = arg.el;
    const contextMenuHandler = eventContextMenuHandlersRef.current.get(element);
    if (contextMenuHandler) {
      element.removeEventListener("contextmenu", contextMenuHandler);
      eventContextMenuHandlersRef.current.delete(element);
    }
    const observer = (element as any)._timeObserver as MutationObserver | undefined;
    if (observer) {
      observer.disconnect();
      delete (element as any)._timeObserver;
    }
  }, []);

  const handleDragStart = useCallback(
    (info: any) => {
      setIsInternalDragging(true);
      const element = info.el;
      const event = info.event;
      if (event.allDay) return;
      const observer = new MutationObserver(() => updateTimeLabels(event, element));
      observer.observe(element, { attributes: true, attributeFilter: ["style"] });
      (element as any)._timeObserver = observer;
      updateTimeLabels(event, element);
      setLabelsVisible(element, true);
    },
    [setLabelsVisible, updateTimeLabels],
  );

  const handleDragStop = useCallback(
    (info: any) => {
      setIsInternalDragging(false);
      const element = info.el;
      const observer = (element as any)._timeObserver as MutationObserver | undefined;
      if (observer) {
        observer.disconnect();
        delete (element as any)._timeObserver;
      }
      setLabelsVisible(element, false);
    },
    [setLabelsVisible],
  );

  const handleResizeStart = useCallback(
    (info: any) => {
      setIsInternalDragging(true);
      const element = info.el;
      const event = info.event;
      if (event.allDay) return;
      const observer = new MutationObserver(() => updateTimeLabels(event, element));
      observer.observe(element, { attributes: true, attributeFilter: ["style"] });
      (element as any)._timeObserver = observer;
      updateTimeLabels(event, element);
      setLabelsVisible(element, true);
    },
    [setLabelsVisible, updateTimeLabels],
  );

  const handleResizeStop = useCallback(
    (info: any) => {
      const element = info.el;
      const observer = (element as any)._timeObserver as MutationObserver | undefined;
      if (observer) {
        observer.disconnect();
        delete (element as any)._timeObserver;
      }
      setLabelsVisible(element, false);
    },
    [setLabelsVisible],
  );

  const handleSelect = useCallback(
    async (selection: DateSelectArg) => {
      if (!onCreateSelection) return;
      const start = selection.start ?? new Date();
      const end = selection.end ?? new Date(start.getTime() + 30 * 60000);
      try {
        await onCreateSelection(start, end);
      } catch (error) {
        logger.error('[Calendar] Error creating event:', error);
      } finally {
        calendarRef.current?.getApi()?.unselect();
      }
    },
    [onCreateSelection],
  );

  // --- External file drop handling ---
  const extractFilePathFromDrag = useCallback((e: React.DragEvent): string | null => {
    const parseObsidianUrl = (url: string): string | null => {
      try {
        const fileMatch = url.match(/[?&]file=([^&]+)/);
        if (fileMatch) {
          const filePath = decodeURIComponent(fileMatch[1]);
          return filePath.endsWith('.md') ? filePath : `${filePath}.md`;
        }
      } catch (err) { /* ignore */ }
      return null;
    };

    const textData = e.dataTransfer.getData("text/plain");
    if (textData) {
      if (textData.startsWith('obsidian://')) {
        const parsed = parseObsidianUrl(textData);
        if (parsed) return parsed;
      }
      const cleaned = textData.trim();
      if (cleaned.endsWith(".md")) return cleaned;
    }

    const uriData = e.dataTransfer.getData("text/uri-list");
    if (uriData && uriData.startsWith('obsidian://')) {
      const parsed = parseObsidianUrl(uriData);
      if (parsed) return parsed;
    }

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const file = files[0];
      if (file.name.endsWith(".md")) {
        return (file as any).path || file.name;
      }
    }
    return null;
  }, []);

  const getDateFromDropEvent = useCallback((e: React.DragEvent): { date: Date; allDay: boolean } | null => {
    const api = calendarRef.current?.getApi();
    if (!api) return null;

    const elementAtPoint = document.elementFromPoint(e.clientX, e.clientY);
    if (!elementAtPoint) return null;

    let dateStr: string | null = null;
    let timeStr: string | null = null;
    let isAllDay = false;

    const slot = elementAtPoint.closest('.fc-timegrid-slot');
    if (slot) {
      timeStr = slot.getAttribute('data-time');
    }

    const timeGridBody = elementAtPoint.closest('.fc-timegrid-body');
    if (timeGridBody) {
      const cols = timeGridBody.querySelectorAll('.fc-timegrid-col[data-date]');
      const dropX = e.clientX;
      for (const col of Array.from(cols)) {
        const rect = col.getBoundingClientRect();
        if (dropX >= rect.left && dropX <= rect.right) {
          dateStr = col.getAttribute('data-date');
          break;
        }
      }
    }

    if (!dateStr) {
      const dayGridCell = elementAtPoint.closest('.fc-daygrid-day');
      if (dayGridCell) {
        dateStr = dayGridCell.getAttribute('data-date');
        if (dateStr) isAllDay = true;
      }
    }

    if (!dateStr) {
      const colHeader = elementAtPoint.closest('[data-date]');
      if (colHeader) {
        dateStr = colHeader.getAttribute('data-date');
      }
    }

    if (!dateStr) return null;

    const date = new Date(dateStr + 'T00:00:00');
    if (timeStr) {
      const [hours, minutes] = timeStr.split(':').map(Number);
      date.setHours(hours, minutes, 0, 0);
      isAllDay = false;
    } else if (!isAllDay) {
      date.setHours(9, 0, 0, 0);
    }

    return { date, allDay: isAllDay };
  }, []);

  const handleExternalDragOver = useCallback((e: React.DragEvent) => {
    const hasFiles = e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain');
    if (hasFiles && onExternalDrop) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, [onExternalDrop]);

  const handleExternalDragEnter = useCallback((e: React.DragEvent) => {
    dragCounterRef.current++;
    const hasFiles = e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/plain');
    if (hasFiles && onExternalDrop) {
      e.preventDefault();
      setIsDraggingOver(true);
    }
  }, [onExternalDrop]);

  const handleExternalDragLeave = useCallback((e: React.DragEvent) => {
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  }, []);

  const handleExternalDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);
    if (!onExternalDrop) return;
    const filePath = extractFilePathFromDrag(e);
    if (!filePath) return;
    const dropInfo = getDateFromDropEvent(e);
    if (!dropInfo) return;
    try {
      await onExternalDrop(filePath, dropInfo.date, dropInfo.allDay);
    } catch (error) {
      logger.error('[Calendar] Error handling external drop:', error);
    }
  }, [onExternalDrop, extractFilePathFromDrag, getDateFromDropEvent]);

  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(arg.start);
    start.setHours(0, 0, 0, 0);
    const end = new Date(arg.end);
    end.setHours(0, 0, 0, 0);
    const isVisible = today >= start && today < end;
    setIsTodayVisible(isVisible);
    setVisibleDateRange({ start: new Date(start), end: new Date(end) });
    setHeaderTitle(arg.view?.title ?? "");

    if (isVisible && isFollowingNow) {
      window.setTimeout(() => scrollToNow(), 50);
    }

    // Sync the current date back to the parent view to persist state across re-renders
    if (onDateChange && arg.view) {
      let currentApiDate = arg.view.calendar.getDate();

      // If in a centered view mode (3d, 5d, 7d), we need to shift the date back to center
      // because the parent expects the center date, but FullCalendar reports the start date.
      if (viewMode !== "month" && viewMode !== "week" && viewMode !== "continuous") {
        const offset = Math.floor((targetDayCount - 1) / 2);
        const centered = new Date(currentApiDate);
        centered.setDate(centered.getDate() + offset);
        currentApiDate = centered;
      }

      // Avoid infinite loops by checking if the date actually changed
      if (!currentDate || currentApiDate.getTime() !== currentDate.getTime()) {
        onDateChange(currentApiDate);
      }
    }
  }, [onDateChange, currentDate, viewMode, targetDayCount, isFollowingNow, scrollToNow]);

  const handleHiddenTimeToggle = useCallback(() => {
    if (hiddenTimeVisible) return;

    // Prevent follow-now from snapping to current time after toggling slot bounds.
    setIsFollowingNow(false);
    const edge = hoursToggleEdge;
    setHiddenTimeVisible(true);
    setHoursToggleVisible(false);
    scrollToTimelineEdge(edge);
  }, [
    hiddenTimeVisible,
    hoursToggleEdge,
    scrollToTimelineEdge,
    setIsFollowingNow,
  ]);

  const handleToggleFullDay = useCallback(() => {
    if (onToggleFullDay) {
      onToggleFullDay();
      return;
    }
    setLocalShowFullDay((value) => !value);
  }, [onToggleFullDay]);

  // --- Navigation handlers ---
  const handleTodayCentered = useCallback(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    if (navigationLocked) return;
    if (viewMode === "month" || viewMode === "week") {
      api.today();
      if (onDateChange) onDateChange(api.getDate());
      if (viewMode === "week") {
        setIsFollowingNow(true);
        setTimeout(() => scrollToNow(), 50);
      }
      return;
    }
    const offset = Math.floor((targetDayCount - 1) / 2);
    const calendarStart = new Date();
    calendarStart.setHours(0, 0, 0, 0);
    calendarStart.setDate(calendarStart.getDate() - offset);
    api.gotoDate(calendarStart);
    if (onDateChange) onDateChange(new Date());
    setIsFollowingNow(true);
    setTimeout(() => scrollToNow(), 50);
  }, [targetDayCount, viewMode, onDateChange, scrollToNow, navigationLocked]);

  const handlePrevClick = useCallback(() => {
    if (navigationLocked) return;
    if (viewMode === 'continuous') {
      if (document.querySelector('.bases-calendar-continuous-scroll-container')) {
        const el = document.querySelector('.bases-calendar-continuous-scroll-container') as HTMLElement;
        if (el) {
          const currentScroll = el.scrollTop;
          el.scrollTo({ top: currentScroll - 800, behavior: 'smooth' });
        }
      }
      return;
    }
    const api = calendarRef.current?.getApi();
    if (!api) return;
    if (viewMode === "month") {
      api.prev();
      if (onDateChange) onDateChange(api.getDate());
      return;
    }
    const apiDate = api.getDate();
    const newStartDate = new Date(apiDate);
    newStartDate.setDate(newStartDate.getDate() - resolvedNavDays);
    api.gotoDate(newStartDate);
    const offset = Math.floor((targetDayCount - 1) / 2);
    const centerDate = new Date(newStartDate);
    centerDate.setDate(centerDate.getDate() + offset);
    if (onDateChange) onDateChange(centerDate);
  }, [resolvedNavDays, viewMode, onDateChange, targetDayCount, navigationLocked]);

  const handleNextClick = useCallback(() => {
    if (navigationLocked) return;
    if (viewMode === 'continuous') {
      const el = document.querySelector('.bases-calendar-continuous-scroll-container') as HTMLElement;
      if (el) {
        const currentScroll = el.scrollTop;
        el.scrollTo({ top: currentScroll + 800, behavior: 'smooth' });
      }
      return;
    }
    const api = calendarRef.current?.getApi();
    if (!api) return;
    if (viewMode === "month") {
      api.next();
      if (onDateChange) onDateChange(api.getDate());
      return;
    }
    const apiDate = api.getDate();
    const newStartDate = new Date(apiDate);
    newStartDate.setDate(newStartDate.getDate() + resolvedNavDays);
    api.gotoDate(newStartDate);
    const offset = Math.floor((targetDayCount - 1) / 2);
    const centerDate = new Date(newStartDate);
    centerDate.setDate(centerDate.getDate() + offset);
    if (onDateChange) onDateChange(centerDate);
  }, [resolvedNavDays, viewMode, onDateChange, targetDayCount, navigationLocked]);

  // --- Touch / Haptic ---
  const touchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleWrapperTouchStart = useCallback(() => {
    if (!isMobile) return;
    touchTimerRef.current = setTimeout(() => {
      if (navigator.vibrate) navigator.vibrate(50);
    }, 600);
  }, [isMobile]);

  const handleWrapperTouchEnd = useCallback(() => {
    if (touchTimerRef.current) {
      clearTimeout(touchTimerRef.current);
      touchTimerRef.current = null;
    }
  }, []);

  const handleWrapperTouchMove = useCallback(() => {
    if (touchTimerRef.current) {
      clearTimeout(touchTimerRef.current);
      touchTimerRef.current = null;
    }
  }, []);

  // Mobile nav visibility
  useEffect(() => {
    if (!isMobile) return;
    setIsMobileNavHidden(false);
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) return;
    if (isInternalDragging) {
      setIsMobileNavHidden(true);
    } else {
      setIsMobileNavHidden(false);
    }
  }, [isMobile, isInternalDragging]);

  const handleCondenseChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (onCondenseLevelChange) {
      onCondenseLevelChange(Number(e.target.value));
    }
  }, [onCondenseLevelChange]);

  const [isMini, setIsMini] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setIsMini(entry.contentRect.width < 550);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Manual delegated event listener for 'more' links
  // This is a robust fallback if FullCalendar's moreLinkClick prop fails
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleDelegatedClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const moreLink = target.closest('.fc-more-link');

      if (moreLink) {
        e.preventDefault();
        e.stopPropagation();

        // Try to find the date from the parent day cell (dayGrid or timeGrid)
        const dayCell = moreLink.closest('.fc-daygrid-day') ?? moreLink.closest('.fc-timegrid-col');
        const dateStr = dayCell?.getAttribute('data-date');

        if (dateStr) {
          const [y, m, d] = dateStr.split('-').map(Number);
          const date = new Date(y, m - 1, d); // Month is 0-indexed
          handleMoreLinkClick({ date, jsEvent: e });
        } else {
          // Fallback: use FullCalendar's arg.date if available via moreLinkClick prop
        }
      }
    };

    container.addEventListener('click', handleDelegatedClick, true); // Capture phase
    return () => {
      container.removeEventListener('click', handleDelegatedClick, true);
    };
  }, [handleMoreLinkClick]);

  const views = {
    "timeGridRange-3": { type: "timeGrid", duration: { days: 3 }, buttonText: "3d" },
    "timeGridRange-4": { type: "timeGrid", duration: { days: 4 }, buttonText: "4d" },
    "timeGridRange-5": { type: "timeGrid", duration: { days: 5 }, buttonText: "5d" },
    "timeGridRange-7": { type: "timeGrid", duration: { days: 7 }, buttonText: "7d" },
    timeGridWeek: { buttonText: "Week" },
    timeGridDay: { buttonText: "Day" },
    dayGridMonth: { buttonText: "Month" },
  };

  // --- Render ---
  return (
    <div
      ref={containerRef}
      className={`bases-calendar-wrapper ${isDraggingOver ? 'is-drag-over' : ''} ${isMini ? 'bases-calendar-mini' : ''} ${allDayStickyScroll ? 'allday-sticky' : 'allday-no-sticky'}`}
      style={{
        height: isEmbedMode ? scrollSurfaceHeight : "100%",
        minHeight: isEmbedMode ? `${embedFallbackHeight}px` : undefined,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        "--calendar-slot-height": `${computedSlotHeight}px`,
        "--calendar-slot-zoom": `${effectiveZoom}`,
        "--tps-allday-event-height": `${allDayEventHeight}px`,
        "--tps-allday-max-rows": `${allDayExpanded ? 99 : (allDayMaxRows ?? 3)}`,
        "--tps-past-event-opacity": `${pastEventOpacity / 100}`,
        "--tps-event-font-size": eventFontSize === "small" ? "var(--font-ui-smaller)" : eventFontSize === "large" ? "var(--font-ui-medium)" : "var(--font-ui-small)",
        position: "relative"
      } as React.CSSProperties}
      onDragOver={handleExternalDragOver}
      onDragEnter={handleExternalDragEnter}
      onDragLeave={handleExternalDragLeave}
      onDrop={handleExternalDrop}
      onTouchStart={handleWrapperTouchStart}
      onTouchEnd={handleWrapperTouchEnd}
      onTouchMove={handleWrapperTouchMove}
    >
      {pendingChange && (
        <div
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            backgroundColor: "var(--background-primary)",
            border: "2px solid var(--background-modifier-border)",
            borderRadius: "8px",
            padding: "16px 24px",
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
            zIndex: 1000,
            minWidth: "300px",
            textAlign: "center"
          }}
        >
          <>
            <div style={{ marginBottom: "16px", fontSize: "14px", color: "var(--text-normal)" }}>
              Confirm event {pendingChange.type === 'drop' ? 'move' : 'resize'}?
            </div>
            <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>
              <button
                type="button"
                onClick={() => confirmChangeWithScope("all")}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "var(--interactive-accent)",
                  color: "var(--text-on-accent)",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontWeight: "500"
                }}
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={handleCancelChange}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "var(--background-modifier-border)",
                  color: "var(--text-normal)",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontWeight: "500"
                }}
              >
                Cancel
              </button>
            </div>
          </>
        </div>
      )}

      {pendingChange && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            zIndex: 999
          }}
          onClick={handleCancelChange}
        />
      )}

      <CalendarNavigation
        showNavButtons={showNavButtons}
        navigationLocked={navigationLocked}
        headerPortalTarget={headerPortalTarget}
        headerTitle={headerTitle}
        isMobile={isMobile}
        currentDate={currentDate}
        onDateChange={onDateChange}
        onPrevClick={handlePrevClick}
        onNextClick={handleNextClick}
        onTodayCentered={handleTodayCentered}
        mobileNavHidden={mobileNavHidden}
        floatingNavStyle={floatingNavStyle}
      />

      {shouldEnableScrollHoursToggle && !hiddenTimeVisible && (
        <button
          type="button"
          className={`bases-calendar-scroll-hours-toggle ${hoursToggleEdge === "top" ? "is-top" : "is-bottom"}${hoursToggleVisible ? " is-visible" : ""}${hasHiddenTimeEventsInVisibleRange ? " has-hidden-events" : " has-no-hidden-events"}`}
          onClick={handleHiddenTimeToggle}
          title="Show all hours"
          aria-label="Show all hours"
        >
          {hoursToggleEdge === "top" ? "↑" : "↓"}
        </button>
      )}

      <div style={{ flex: "1 1 0%", height: "100%", overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
        <div
          className="bases-calendar-scroll-surface"
          style={{
            flex: "1 1 0%",
            width: "100%",
            height: scrollSurfaceHeight,
            overflowY: scrollSurfaceOverflowY,
            overflowX: "hidden",
            WebkitOverflowScrolling: "touch"
          }}
        >
          {viewMode !== 'continuous' && (
            <FullCalendar
              height={fullCalendarHeight}
              contentHeight={fullCalendarContentHeight}
              expandRows={viewMode === "month" && !isMobile}
              plugins={activePlugins}
              key={`calendar-${viewMode}-${resolvedShowFullDay}-${effectiveCondenseLevel}-${slotDurationMinutes}-${snapDurationMinutes}-${dayHeaderFormatSetting}-${dayHeaderShowDate}-${timeFormatSetting}-${defaultScrollTimeSetting}-${showNowIndicator}`}
              ref={calendarRef}
              initialView={viewName}
              initialDate={safeInitialDate}
              views={views}
              headerToolbar={false}
              selectable={allowSelect}
              selectMirror={allowSelect}
              selectOverlap={allowSelect}
              slotEventOverlap={false}
              select={allowSelect ? handleSelect : undefined}
              selectLongPressDelay={isMobile ? 600 : 300}
              longPressDelay={isMobile ? 600 : 300}
              eventLongPressDelay={isMobile ? 600 : 300}
              eventDragMinDistance={isMobile ? 10 : 5}
              unselectAuto={true}
              unselectCancel=".fc-event"
              editable={allowEdit}
              eventStartEditable={allowEdit}
              eventDurationEditable={allowEdit && !!onEventResize}
              events={events}
              eventContent={(info) => { return renderEventContent(info); }}
              eventClick={handleEventClick}
              eventMouseEnter={handleEventMouseEnter}
              eventMouseLeave={handleEventMouseLeave}
              eventDrop={handleDrop}
              eventResize={handleResize}
              eventDidMount={handleEventMount}
              dayHeaderDidMount={handleDayMount}
              dayCellDidMount={handleDayMount}
              eventWillUnmount={handleEventWillUnmount}
              eventDragStart={handleDragStart}
              eventDragStop={handleDragStop}
              eventResizeStart={handleDragStart}
              // @ts-ignore
              eventResizeStop={handleDragStop}

              nowIndicator={showNowIndicator}
              dayHeaderFormat={
                viewMode === "month"
                  ? { weekday: dayHeaderFormatSetting }
                  : dayHeaderShowDate
                    ? { weekday: dayHeaderFormatSetting, month: "short", day: "numeric" }
                    : { weekday: dayHeaderFormatSetting }
              }
              firstDay={safeWeekStartDay}
              slotMinTime={slotMinTimeValue}
              slotMaxTime={slotMaxTimeValue}
              scrollTime={`${defaultScrollTimeSetting}:00`}
              scrollTimeReset={false}
              slotDuration={`00:${String(slotDurationMinutes).padStart(2, "0")}:00`}
              snapDuration={`00:${String(snapDurationMinutes).padStart(2, "0")}:00`}
              slotLabelInterval="01:00"

              slotLabelFormat={{
                hour: "numeric",
                minute: "2-digit",
                hour12: timeFormatSetting === "12h",
                meridiem: timeFormatSetting === "12h" ? 'short' : false as any,
              }}
              allDaySlot={resolvedShowFullDay}
              displayEventTime={false}
              displayEventEnd={false}
              navLinks={true}
              navLinkDayClick={(date, jsEvent) => {
                if (onDateClick) onDateClick(date);
              }}
              datesSet={handleDatesSet}
              showNonCurrentDates={true}
              dayMaxEvents={allDayExpanded ? false : (allDayMaxRows ?? 3)}
              dayMaxEventRows={allDayExpanded ? false : (allDayMaxRows ?? 3)}
              // @ts-ignore
              moreLinkClick={handleMoreLinkClick}
              moreLinkContent={renderMoreLinkContent}
              fixedWeekCount={false}
              stickyHeaderDates={false}
              handleWindowResize={true}
              windowResizeDelay={100}
            />
          )}

          {viewMode === 'continuous' && (
            <ContinuousScrollView
              currentDate={currentDate}
              events={events}
              allDayMaxRows={allDayMaxRows}
              slotMinTimeValue={slotMinTimeValue}
              slotMaxTimeValue={slotMaxTimeValue}
              defaultScrollTime={DEFAULT_SCROLL_TIME}
              resolvedShowFullDay={resolvedShowFullDay}
              safeWeekStartDay={safeWeekStartDay}
              allowEdit={allowEdit}
              allowSelect={allowSelect}
              onEventResize={onEventResize}
              handleEventClick={handleEventClick}
              renderEventContent={renderEventContent}
              handleDrop={handleDrop}
              handleResize={handleResize}
              handleEventMount={handleEventMount}
              handleEventWillUnmount={handleEventWillUnmount}
              handleDragStart={handleDragStart}
              handleDragStop={handleDragStop}
              handleResizeStart={handleResizeStart}
              handleResizeStop={handleResizeStop}
              handleSelect={allowSelect ? handleSelect : undefined}
              onDateClick={onDateClick}
              handleMoreLinkClick={handleMoreLinkClick}
              renderMoreLinkContent={renderMoreLinkContent}
              allDayExpanded={allDayExpanded}
            />
          )}
        </div>
      </div>
    </div>
  );
};
