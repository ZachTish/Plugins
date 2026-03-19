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
import { parseDateFromFilename } from '../../utils/daily-file-date';

// Extracted components
import { useEventRenderer } from "./components/EventRenderer";
import { CalendarNavigation } from "./components/CalendarNavigation";
import { ContinuousScrollView } from "./components/ContinuousScrollView";

const DEFAULT_SLOT_MIN_TIME = "00:00:00";
const DEFAULT_SLOT_MAX_TIME = "24:00:00";
const DEFAULT_SCROLL_TIME = "08:00:00";
const PLUGINS = [dayGridPlugin, timeGridPlugin, interactionPlugin];

const HEADER_HEIGHT_VAR = "var(--tps-bases-header-height, 84px)";
type ViewMode = "day" | "3d" | "4d" | "5d" | "7d" | "week" | "month" | "continuous" | "filter-based";
type ScrollSnapshotKind = "timegrid" | "continuous" | "surface";
const HOURS_TOGGLE_EDGE_THRESHOLD_PX = 24;
const IDLE_RETURN_TO_NOW_MS = 30_000;

// ---------------------------------------------------------------------------
// Persistent canvas-scale BCR patch
// ---------------------------------------------------------------------------
// Obsidian canvas applies transform:scale() to its viewport. FullCalendar's
// PositionCache builds slot top/height arrays via getBoundingClientRect(),
// which returns *visual* (scaled) pixels. FC then uses those values as
// layout-pixel `style.top` offsets for events and the now-indicator, so
// everything is mis-positioned at any canvas zoom ≠ 100%.
//
// Patching only during updateSize() doesn't help because PositionCache is
// also rebuilt on every React componentDidUpdate (resize, slot-zoom change,
// event data change, etc.).
//
// Solution: while any embed is mounted, temporarily override
// Element.prototype.getBoundingClientRect so that calls on elements *inside*
// a registered canvas-embed container return unscaled layout-pixel values.
// Multiple simultaneous embeds are handled via a shared Set + ref count.
// ---------------------------------------------------------------------------
const _canvasEmbedContainers = new Set<HTMLElement>();
const _origBCR = Element.prototype.getBoundingClientRect;
let _bcrPatched = false;
const _scaleCache = new Map<HTMLElement, { scale: number; ts: number }>();
const _SCALE_TTL = 80; // ms — short-lived cache so zoom changes propagate quickly

function _getContainerScale(container: HTMLElement): number {
  const now = Date.now();
  const hit = _scaleCache.get(container);
  if (hit && now - hit.ts < _SCALE_TTL) return hit.scale;
  const fcEl = container.querySelector('.fc') as HTMLElement | null;
  if (!fcEl || fcEl.offsetWidth === 0) {
    _scaleCache.set(container, { scale: 1, ts: now });
    return 1;
  }
  const r = _origBCR.call(fcEl);
  const scale = r.width / fcEl.offsetWidth;
  _scaleCache.set(container, { scale, ts: now });
  return scale;
}

// FullCalendar's coordinate system under canvas scale(n) — two problems:
//
// 1. RENDERING (PositionCache.build):
//    FC calls getBoundingClientRect() on structural slat/col elements to build
//    position arrays, then writes the values directly to style.top (CSS px).
//    BCR returns visual pixels; style.top needs CSS (layout) pixels.
//    Fix: unscale BCR for the four structural measurement elements.
//
// 2. HIT-TESTING / INTERACTION (PointerDragging + HitDragging):
//    FC computes: relativePos = event.clientY − positionCache.originRect.top
//    The "origin" element for both PositionCache.build AND for hit-testing is
//    the *same* .fc-timegrid-slots element.  After fix #1 its BCR.top is
//    returned as visualTop/scale.  So the hit equation needs:
//
//      event.clientY / scale − originBCR.top/scale
//      = (event.clientY − originBCR_visual.top) / scale
//      = visualRelY / scale
//      = layoutRelY  ✓  matches PositionCache layout-px entries.
//
//    So we only need to scale event.clientX/Y by 1/scale.
//    We do this by stopping the original event and re-dispatching a
//    *synthetic* PointerEvent / MouseEvent whose coords are already scaled.
//    Synthetic events are ordinary JS objects — all properties writable.
//
// NOTE: contextmenu and click are intentionally excluded from re-dispatch so
// context-menu popup positioning and link clicks stay in visual-px space.

function _isFCMeasurementEl(el: Element): boolean {
  const tag = el.tagName;
  if (tag === 'TR') return true;                                              // slat rows
  if (tag === 'TD' && el.classList.contains('fc-timegrid-col')) return true; // col cells
  if (el.classList.contains('fc-timegrid-slots')) return true;               // slat/hit origin
  if (el.classList.contains('fc-timegrid-cols')) return true;                // col origin
  return false;
}

// Symbol used to mark synthetic events we create so our listener ignores them.
const _SCALED_SYM = Symbol('tps-canvas-scaled');
const _DRAG_EVENT_TYPES = ['pointerdown','pointermove','pointerup','mousedown','mousemove','mouseup'] as const;
let _pointerPatchInstalled = false;

function _interceptAndScaleEvent(e: Event): void {
  if ((e as any)[_SCALED_SYM]) return; // our own re-dispatched event — skip
  const target = e.target as Element | null;
  if (!target) return;
  for (const container of _canvasEmbedContainers) {
    if (!container.contains(target)) continue;
    const scale = _getContainerScale(container);
    if (Math.abs(scale - 1) < 0.005) return;

    // Stop the original so FC never sees it; we'll re-dispatch with correct coords.
    e.stopImmediatePropagation();

    const me = e as MouseEvent;
    const pe = e instanceof PointerEvent ? e : null;
    const inv = 1 / scale;

    const base: MouseEventInit = {
      bubbles: e.bubbles,
      cancelable: e.cancelable,
      composed: true,
      view: me.view,
      clientX:   me.clientX   * inv,
      clientY:   me.clientY   * inv,
      screenX:   me.screenX   * inv,
      screenY:   me.screenY   * inv,
      movementX: me.movementX * inv,
      movementY: me.movementY * inv,
      button:    me.button,
      buttons:   me.buttons,
      ctrlKey:   me.ctrlKey,
      shiftKey:  me.shiftKey,
      altKey:    me.altKey,
      metaKey:   me.metaKey,
      relatedTarget: me.relatedTarget,
    };

    let synth: MouseEvent;
    if (pe) {
      synth = new PointerEvent(e.type, {
        ...base,
        pointerId:   pe.pointerId,
        pointerType: pe.pointerType,
        isPrimary:   pe.isPrimary,
        width:       pe.width,
        height:      pe.height,
        pressure:    pe.pressure,
        tiltX:       pe.tiltX,
        tiltY:       pe.tiltY,
      } as PointerEventInit);
    } else {
      synth = new MouseEvent(e.type, base);
    }
    (synth as any)[_SCALED_SYM] = true;
    target.dispatchEvent(synth);
    return;
  }
}

function _installCanvasBCRPatch(): void {
  if (_bcrPatched) return;
  _bcrPatched = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Element.prototype as any).getBoundingClientRect = function (this: Element) {
    const r = _origBCR.call(this);
    if (!_isFCMeasurementEl(this)) return r;
    for (const container of _canvasEmbedContainers) {
      if (!container.contains(this)) continue;
      const scale = _getContainerScale(container);
      if (Math.abs(scale - 1) < 0.005) return r;
      return new DOMRect(r.x / scale, r.y / scale, r.width / scale, r.height / scale);
    }
    return r;
  };

  if (!_pointerPatchInstalled) {
    _pointerPatchInstalled = true;
    for (const type of _DRAG_EVENT_TYPES) {
      // Non-passive so we can call stopImmediatePropagation
      window.addEventListener(type, _interceptAndScaleEvent, { capture: true, passive: false });
    }
  }
}

function _uninstallCanvasBCRPatch(): void {
  if (_canvasEmbedContainers.size > 0) return;
  if (!_bcrPatched) return;
  _bcrPatched = false;
  Element.prototype.getBoundingClientRect = _origBCR;
  if (_pointerPatchInstalled) {
    _pointerPatchInstalled = false;
    for (const type of _DRAG_EVENT_TYPES) {
      window.removeEventListener(type, _interceptAndScaleEvent, { capture: true });
    }
  }
}

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
  iconName?: string;
  iconColor?: string;
  isTask?: boolean;
  taskTimed?: boolean;
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
  entryBoundsStart?: Date;
  entryBoundsEnd?: Date;
  navigationBoundsStart?: Date;
  navigationBoundsEnd?: Date;

  // Calendar appearance settings
  allDayEventHeight?: number;
  allDayMaxRows?: number;
  allDayStickyScroll?: boolean;
  dayHeaderFormatSetting?: "short" | "long" | "narrow";
  dayHeaderShowDate?: boolean;
  timeFormatSetting?: "12h" | "24h";
  slotDurationMinutes?: number;
  minEventHeight?: number;
  snapDurationMinutes?: number;
  defaultScrollTimeSetting?: string;
  showNowIndicator?: boolean;
  pastEventOpacity?: number;
  eventFontSize?: "small" | "default" | "large";
  activeEventHighlightColor?: string;
  dailyNoteDateFormat?: string;
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

const normalizeComparablePath = (rawPath: string | null | undefined): string => {
  const value = String(rawPath || "").trim();
  if (!value) return "";
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Best effort.
  }
  return decoded.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
};

const stripMdExtension = (path: string): string => path.replace(/\.md$/i, "");

const pathsLikelyMatch = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const left = normalizeComparablePath(a);
  const right = normalizeComparablePath(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return stripMdExtension(left) === stripMdExtension(right);
};

const extractDailyNoteDateKey = (path: string | null | undefined, userFormat?: string): string | null => {
  const raw = String(path || "").trim();
  if (!raw) return null;
  const filename = raw.split("/").pop() || raw;
  const basename = filename.replace(/\.[^.]+$/, "");
  try {
    const m = parseDateFromFilename(basename, userFormat);
    if (!m || !m.isValid || !m.isValid()) return null;
    return (m as any).format('YYYY-MM-DD');
  } catch {
    return null;
  }
};

const applyActiveNoteEventHighlight = (eventEl: HTMLElement, shouldHighlight: boolean): void => {
  const snapshotAttr = "data-tps-active-style-snapshot";
  const readSnapshot = (): Record<string, string | null> | null => {
    const raw = eventEl.getAttribute(snapshotAttr);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, string | null>;
    } catch {
      return null;
    }
  };
  const writeSnapshot = () => {
    const snapshot: Record<string, string | null> = {
      background: eventEl.style.getPropertyValue("background") || null,
      backgroundImage: eventEl.style.getPropertyValue("background-image") || null,
      borderColor: eventEl.style.getPropertyValue("border-color") || null,
      priorityColor: eventEl.style.getPropertyValue("--priority-color") || null,
      opacity: eventEl.style.getPropertyValue("opacity") || null,
      boxShadow: eventEl.style.getPropertyValue("box-shadow") || null,
      filter: eventEl.style.getPropertyValue("filter") || null,
      zIndex: eventEl.style.getPropertyValue("z-index") || null,
    };
    eventEl.setAttribute(snapshotAttr, JSON.stringify(snapshot));
  };
  const restoreSnapshot = () => {
    const snapshot = readSnapshot();
    if (!snapshot) return;
    const restore = (prop: string, value: string | null) => {
      if (value) eventEl.style.setProperty(prop, value);
      else eventEl.style.removeProperty(prop);
    };
    restore("background", snapshot.background);
    restore("background-image", snapshot.backgroundImage);
    restore("border-color", snapshot.borderColor);
    restore("--priority-color", snapshot.priorityColor);
    restore("opacity", snapshot.opacity);
    restore("box-shadow", snapshot.boxShadow);
    restore("filter", snapshot.filter);
    restore("z-index", snapshot.zIndex);
    eventEl.removeAttribute(snapshotAttr);
  };

  eventEl.classList.toggle("tps-calendar-active-note-event", shouldHighlight);
  if (shouldHighlight) {
    if (!eventEl.hasAttribute(snapshotAttr)) {
      writeSnapshot();
    }
    eventEl.style.setProperty(
      "background",
      "color-mix(in srgb, var(--tps-active-note-highlight-color, var(--interactive-accent)) 82%, black 18%)",
      "important",
    );
    eventEl.style.setProperty("background-image", "none", "important");
    eventEl.style.setProperty(
      "border-color",
      "color-mix(in srgb, var(--tps-active-note-highlight-color, var(--interactive-accent)) 65%, white 35%)",
      "important",
    );
    eventEl.style.setProperty("--priority-color", "var(--tps-active-note-highlight-color, var(--interactive-accent))");
    eventEl.style.setProperty("opacity", "1", "important");
    eventEl.style.setProperty(
      "box-shadow",
      "inset 0 0 0 1px color-mix(in srgb, var(--tps-active-note-highlight-color, var(--interactive-accent)) 72%, white 28%), 0 0 0 2px color-mix(in srgb, var(--tps-active-note-highlight-color, var(--interactive-accent)) 45%, transparent), 0 8px 20px color-mix(in srgb, var(--tps-active-note-highlight-color, var(--interactive-accent)) 26%, black 74%)",
      "important",
    );
    eventEl.style.setProperty("filter", "saturate(1.08)");
    eventEl.style.setProperty("z-index", "140", "important");
  } else {
    restoreSnapshot();
  }
};

const applyActiveDayLabelHighlight = (labelEl: HTMLElement, shouldHighlight: boolean): void => {
  const snapshotAttr = "data-tps-active-day-label-style";
  const readSnapshot = (): Record<string, string | null> | null => {
    const raw = labelEl.getAttribute(snapshotAttr);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Record<string, string | null>;
    } catch {
      return null;
    }
  };
  const writeSnapshot = () => {
    const snapshot: Record<string, string | null> = {
      color: labelEl.style.getPropertyValue("color") || null,
      background: labelEl.style.getPropertyValue("background") || null,
      backgroundImage: labelEl.style.getPropertyValue("background-image") || null,
      boxShadow: labelEl.style.getPropertyValue("box-shadow") || null,
      textShadow: labelEl.style.getPropertyValue("text-shadow") || null,
      borderRadius: labelEl.style.getPropertyValue("border-radius") || null,
      fontWeight: labelEl.style.getPropertyValue("font-weight") || null,
      padding: labelEl.style.getPropertyValue("padding") || null,
    };
    labelEl.setAttribute(snapshotAttr, JSON.stringify(snapshot));
  };
  const restoreSnapshot = () => {
    const snapshot = readSnapshot();
    if (!snapshot) return;
    const restore = (prop: string, value: string | null) => {
      if (value) labelEl.style.setProperty(prop, value);
      else labelEl.style.removeProperty(prop);
    };
    restore("color", snapshot.color);
    restore("background", snapshot.background);
    restore("background-image", snapshot.backgroundImage);
    restore("box-shadow", snapshot.boxShadow);
    restore("text-shadow", snapshot.textShadow);
    restore("border-radius", snapshot.borderRadius);
    restore("font-weight", snapshot.fontWeight);
    restore("padding", snapshot.padding);
    labelEl.removeAttribute(snapshotAttr);
  };

  labelEl.classList.toggle("tps-calendar-active-day-label", shouldHighlight);
  if (shouldHighlight) {
    if (!labelEl.hasAttribute(snapshotAttr)) {
      writeSnapshot();
    }
    labelEl.style.setProperty("color", "var(--text-on-accent, #ffffff)", "important");
    labelEl.style.setProperty(
      "background",
      "color-mix(in srgb, var(--tps-active-note-highlight-color, var(--interactive-accent)) 78%, black 22%)",
      "important",
    );
    labelEl.style.setProperty("background-image", "none", "important");
    labelEl.style.setProperty(
      "box-shadow",
      "0 0 0 1px color-mix(in srgb, var(--tps-active-note-highlight-color, var(--interactive-accent)) 45%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--tps-active-note-highlight-color, var(--interactive-accent)) 70%, white 30%)",
      "important",
    );
    labelEl.style.setProperty("text-shadow", "0 1px 2px rgba(0,0,0,0.35)");
    labelEl.style.setProperty("border-radius", "6px");
    labelEl.style.setProperty("font-weight", "700", "important");
    labelEl.style.setProperty("padding", "0 6px");
  } else {
    restoreSnapshot();
  }
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
  entryBoundsStart,
  entryBoundsEnd,
  navigationBoundsStart,
  navigationBoundsEnd,
  onDateMouseEnter,
  allDayLimit,

  // Calendar appearance settings
  allDayEventHeight = 24,
  allDayMaxRows,
  allDayStickyScroll = true,
  dayHeaderFormatSetting = "short",
  dayHeaderShowDate = true,
  timeFormatSetting = "12h",
  slotDurationMinutes = 30,
  minEventHeight = 20,
  snapDurationMinutes = 5,
  defaultScrollTimeSetting = "08:00",
  showNowIndicator = true,
  pastEventOpacity = 55,
  eventFontSize = "default",
  activeEventHighlightColor = "#3b82f6",
  dailyNoteDateFormat,
}) => {
  const app = useApp() || ((window as any).app as App);
  const calendarRef = useRef<FullCalendar>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerHeight, setContainerHeight] = useState<number>(0);
  // Ref and state for the flex child that holds FullCalendar (excludes nav chrome).
  // Used in embed mode so fullCalendarHeight doesn't include the toolbar height.
  const calendarBodyRef = useRef<HTMLDivElement>(null);
  const [calendarBodyHeight, setCalendarBodyHeight] = useState<number>(0);
  const [isEmbedMode, setIsEmbedMode] = useState(false);
  const [localShowFullDay, setLocalShowFullDay] = useState(
    showFullDay ?? true,
  );
  const [isTodayVisible, setIsTodayVisible] = useState(true);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(() => app?.workspace?.getActiveFile?.()?.path ?? null);
  const [visibleDateRange, setVisibleDateRange] = useState<{ start: Date; end: Date } | null>(null);
  const [headerTitle, setHeaderTitle] = useState("");
  const [hiddenTimeVisible, setHiddenTimeVisible] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isInternalDragging, setIsInternalDragging] = useState(false);
  const suppressEntryClickUntilRef = useRef(0);
  const [isMobileNavHidden, setIsMobileNavHidden] = useState(false);
  const [allDayExpanded, setAllDayExpanded] = useState(false);
  const [selectionPreview, setSelectionPreview] = useState<{ start: Date; end: Date; allDay: boolean } | null>(null);
  const [externalDropPreview, setExternalDropPreview] = useState<{ start: Date; end: Date; allDay: boolean } | null>(null);
  const [hoursToggleEdge, setHoursToggleEdge] = useState<"top" | "bottom">("bottom");
  const [hoursToggleVisible, setHoursToggleVisible] = useState(false);

  const dragCounterRef = useRef(0);
  const eventContextMenuHandlersRef = useRef(new Map<HTMLElement, (event: MouseEvent) => void>());
  const dayHeaderHoverHandlersRef = useRef(new Map<HTMLElement, (event: MouseEvent) => void>());
  // Ref so closures (eventDidMount handlers) can always read the current value without being rebuilt.
  const isEmbedModeRef = useRef(isEmbedMode);
  useEffect(() => { isEmbedModeRef.current = isEmbedMode; }, [isEmbedMode]);
  const activeFilePathRef = useRef<string | null>(activeFilePath);
  useEffect(() => { activeFilePathRef.current = activeFilePath; }, [activeFilePath]);
  const dailyNoteDateFormatRef = useRef<string | undefined>(dailyNoteDateFormat);
  useEffect(() => { dailyNoteDateFormatRef.current = dailyNoteDateFormat; }, [dailyNoteDateFormat]);
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
    if (!app?.workspace) return;
    const syncActiveFilePath = () => {
      const nextPath = app.workspace.getActiveFile()?.path ?? null;
      setActiveFilePath((prev) => (prev === nextPath ? prev : nextPath));
    };
    syncActiveFilePath();
    const onActiveLeafChangeRef = app.workspace.on("active-leaf-change", syncActiveFilePath);
    const onFileOpenRef = app.workspace.on("file-open", syncActiveFilePath);
    return () => {
      app.workspace.offref(onActiveLeafChangeRef);
      app.workspace.offref(onFileOpenRef);
    };
  }, [app]);

  useEffect(() => {
    const rootEl = containerRef.current;
    if (!rootEl) return;
    const eventEls = rootEl.querySelectorAll<HTMLElement>(".fc-event.tps-calendar-entry[data-path]");
    eventEls.forEach((eventEl) => {
      const path = eventEl.getAttribute("data-path");
      const shouldHighlight = pathsLikelyMatch(path, activeFilePath);
      applyActiveNoteEventHighlight(eventEl, shouldHighlight);
    });
  }, [activeFilePath, entries, viewMode, currentDate]);

  useEffect(() => {
    const rootEl = containerRef.current;
    if (!rootEl) return;
    const activeDateKey = extractDailyNoteDateKey(activeFilePath, dailyNoteDateFormat);
    const labelEls = rootEl.querySelectorAll<HTMLElement>(
      ".fc-col-header-cell[data-date] a.fc-col-header-cell-cushion, .fc-daygrid-day[data-date] a.fc-daygrid-day-number",
    );
    labelEls.forEach((labelEl) => {
      const carrier =
        labelEl.closest<HTMLElement>(".fc-col-header-cell[data-date]") ??
        labelEl.closest<HTMLElement>(".fc-daygrid-day[data-date]");
      const dateKey = carrier?.getAttribute("data-date") || "";
      applyActiveDayLabelHighlight(labelEl, !!activeDateKey && dateKey === activeDateKey);
    });
  }, [activeFilePath, viewMode, currentDate, visibleDateRange, entries]);

  useEffect(() => {
    if (!isMobile) return;
    setIsMobileNavHidden(false);
  }, [isMobile]);

  // --- View Configuration ---
  const safeWeekStartDay = Number.isFinite(weekStartDay)
    ? Math.max(0, Math.min(6, weekStartDay))
    : 1;
  const derivedFilterRangeDays = useMemo(() => {
    if (viewMode !== "filter-based") return null;
    if (!entryBoundsStart || !entryBoundsEnd) return null;
    const start = new Date(entryBoundsStart);
    const end = new Date(entryBoundsEnd);
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    const diffMs = end.getTime() - start.getTime();
    if (!Number.isFinite(diffMs)) return null;
    const inclusiveDays = Math.floor(diffMs / (24 * 60 * 60 * 1000)) + 1;
    if (!Number.isFinite(inclusiveDays) || inclusiveDays < 1) return 1;
    return inclusiveDays;
  }, [viewMode, entryBoundsStart, entryBoundsEnd]);

  const resolvedFilterViewMode: ViewMode = useMemo(() => {
    if (viewMode !== "filter-based") return viewMode;
    const span = derivedFilterRangeDays;
    if (!span) return "week";
    if (span <= 1) return "day";
    if (span <= 3) return "3d";
    if (span <= 4) return "4d";
    if (span <= 5) return "5d";
    if (span <= 7) return "7d";
    return "month";
  }, [viewMode, derivedFilterRangeDays]);

  const targetDayCount =
    resolvedFilterViewMode === "day" ? 1 :
      resolvedFilterViewMode === "3d" ? 3 :
        resolvedFilterViewMode === "4d" ? 4 :
        resolvedFilterViewMode === "5d" ? 5 :
          resolvedFilterViewMode === "7d" ? 7 :
            resolvedFilterViewMode === "week" ? 7 :
              7;
  const viewName =
    resolvedFilterViewMode === "month" ? "dayGridMonth" :
      resolvedFilterViewMode === "week" ? "timeGridWeek" :
        resolvedFilterViewMode === "day" ? "timeGridDay" :
          resolvedFilterViewMode === "continuous" ? "timeGridDay" :
              `timeGridRange-${targetDayCount}`;

  const navStepValue = typeof navStep === "number" ? navStep : 0;
  // Only the 'week' view snaps by a full week; every other view defaults to 1 day.
  const isWeekView = resolvedFilterViewMode === "week";

  const resolvedNavDays =
    isWeekView
      ? targetDayCount
      : Number.isFinite(navStepValue) && navStepValue > 0
        ? Math.round(navStepValue)
        : 1;

  // Center the initial date in the view
  const initialDateRef = useRef<Date | null>(null);
  const lastViewModeRef = useRef<ViewMode | null>(null);
  const lastAppliedViewNameRef = useRef<string | null>(null);
  if (lastViewModeRef.current !== resolvedFilterViewMode) {
    lastViewModeRef.current = resolvedFilterViewMode;
    initialDateRef.current = null;
    lastAppliedViewNameRef.current = null;
  }

  if (!initialDateRef.current) {
    if (initialDate) {
      initialDateRef.current = initialDate;
    } else {
      const baseDate = currentDate ?? entries[0]?.startDate ?? new Date();
      if (resolvedFilterViewMode === "month") {
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
      const primaryKind: ScrollSnapshotKind = resolvedFilterViewMode === "continuous" ? "continuous" : "timegrid";
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
  }, [getScrollTargetByKind, resolvedFilterViewMode]);

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

  // --- Directional navigation availability ---
  // Explicit date filters bound navigation within the selected range.
  const { canNavigatePrev, canNavigateNext, canNavigateToday } = useMemo(() => {
    if (!navigationBoundsStart && !navigationBoundsEnd) {
      return { canNavigatePrev: true, canNavigateNext: true, canNavigateToday: true };
    }

    if (!visibleDateRange) {
      return { canNavigatePrev: true, canNavigateNext: true, canNavigateToday: true };
    }

    const boundsStart = navigationBoundsStart ? new Date(navigationBoundsStart) : null;
    boundsStart?.setHours(0, 0, 0, 0);
    const boundsEnd = navigationBoundsEnd ? new Date(navigationBoundsEnd) : null;
    boundsEnd?.setHours(23, 59, 59, 999);

    const viewStart = visibleDateRange.start;
    const viewEnd = visibleDateRange.end;

    const canPrev = boundsStart ? boundsStart < viewStart : true;
    const canNext = boundsEnd ? boundsEnd >= viewEnd : true;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const canToday =
      (!boundsStart || today >= boundsStart) &&
      (!boundsEnd || today <= boundsEnd);

    return { canNavigatePrev: canPrev, canNavigateNext: canNext, canNavigateToday: canToday };
  }, [navigationBoundsStart, navigationBoundsEnd, visibleDateRange]);

  const validRange = useMemo(() => {
    if (!navigationBoundsStart && !navigationBoundsEnd) return undefined;
    const range: { start?: Date; end?: Date } = {};
    if (navigationBoundsStart) {
      const start = new Date(navigationBoundsStart);
      start.setHours(0, 0, 0, 0);
      range.start = start;
    }
    if (navigationBoundsEnd) {
      const end = new Date(navigationBoundsEnd);
      end.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() + 1);
      range.end = end;
    }
    return range;
  }, [navigationBoundsStart, navigationBoundsEnd]);

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
  }, [hiddenTimeIndicatorDates, resolvedFilterViewMode]);

  // --- Embed mode detection ---
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const embedSelectors = ".markdown-embed, .internal-embed, .cm-embed-block, .sync-embed, .sync-container, .markdown-reading-view, .markdown-preview-view, .canvas-node-content";
    const isInEmbed = !!containerRef.current.closest(embedSelectors);
    const previewView = containerRef.current.closest('.markdown-preview-view');
    const isInReadingModeEmbed = previewView && !!containerRef.current.closest('.internal-embed, .markdown-embed');
    const leafContent = containerRef.current.closest('.workspace-leaf-content');
    const viewType = leafContent?.getAttribute('data-type');
    const isBasesInMarkdown = viewType === 'markdown' && !!containerRef.current.closest('.internal-embed');
    const isInCanvas = viewType === 'canvas' || !!containerRef.current.closest('.canvas-node-content, .canvas-node');
    setIsEmbedMode(isInEmbed || isInReadingModeEmbed || isBasesInMarkdown || isInCanvas);
  }, []);

  // --- Zoom / Condense ---
  const effectiveCondenseLevel = condenseLevel ?? DEFAULT_CONDENSE_LEVEL;
  const zoom = calculateSlotZoom(effectiveCondenseLevel);
  const effectiveZoom = isEmbedMode && isMobile ? Math.min(zoom, 0.85) : zoom;
  const computedSlotHeight = calculateSlotHeightFromZoom(effectiveZoom);
  const embedFallbackHeight = 420;
  // Use calendarBodyHeight (the flex child below the nav bar) so FullCalendar is
  // sized to exactly the available space, preventing bottom-overflow in canvas nodes.
  const computedEmbedCalendarHeight = calendarBodyHeight > 0
    ? Math.max(320, calendarBodyHeight)
    : embedFallbackHeight;

  const fullCalendarHeight: number | "auto" | "100%" = isEmbedMode
    ? computedEmbedCalendarHeight
    : isMobile
      ? "auto"
      : "100%";
  const fullCalendarContentHeight: number | "auto" | "100%" = fullCalendarHeight;

  const scrollSurfaceHeight = isEmbedMode
    ? "100%"
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
  }, [effectiveCondenseLevel, resolvedShowFullDay, resolvedFilterViewMode, computedSlotHeight]);

  useEffect(() => {
    if (!isEmbedMode || !calendarRef.current) return;

    // Embedded bases can stay hidden/offscreen while rendering; force late size sync after reveal.
    // Include an immediate RAF call + staggered delays to handle canvas layout settling.
    let rafId = requestAnimationFrame(() => {
      const api = calendarRef.current?.getApi();
      if (api) api.updateSize();
    });

    const timeouts = [100, 250, 600, 1200, 2000].map((delay) =>
      window.setTimeout(() => {
        const api = calendarRef.current?.getApi();
        if (!api) return;
        api.updateSize();
      }, delay),
    );

    return () => {
      cancelAnimationFrame(rafId);
      timeouts.forEach((id) => window.clearTimeout(id));
    };
  }, [isEmbedMode, fullCalendarHeight, resolvedFilterViewMode]);

  // Canvas resize fix: FullCalendar only listens to the window 'resize' event.
  // Canvas node resizes don't trigger window resize, so FC never calls
  // computeScrollerDims() and tables keep stale pixel widths, causing
  // header/body misalignment. A ResizeObserver on the container detects
  // width changes and calls updateSize() so FC remeasures and recalibrates.
  useEffect(() => {
    if (!isEmbedMode || !containerRef.current) return;
    const container = containerRef.current;
    let lastWidth = container.getBoundingClientRect().width;
    let debounceId: ReturnType<typeof setTimeout> | null = null;

    const ro = new ResizeObserver(() => {
      const newWidth = container.getBoundingClientRect().width;
      if (Math.abs(newWidth - lastWidth) < 1) return;
      lastWidth = newWidth;
      if (debounceId !== null) clearTimeout(debounceId);
      debounceId = setTimeout(() => {
        debounceId = null;
        const api = calendarRef.current?.getApi();
        if (api) api.updateSize();
      }, 50);
    });

    ro.observe(container);
    return () => {
      ro.disconnect();
      if (debounceId !== null) clearTimeout(debounceId);
    };
  }, [isEmbedMode]);

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
    initialFollowingNow: !isEmbedMode,
  });

  // Events hook
  const { basesEntryMap, events } = useCalendarEvents({
    entries,
    allDayProperty,
    defaultEventDuration,
    minEventHeight,
    tick,
  });

  // Canvas BCR patch: register this container so the module-level patch
  // unscales getBoundingClientRect() for every FC measurement (PositionCache
  // builds, scroll dims, now-indicator, events) while this embed is mounted.
  useEffect(() => {
    if (!isEmbedMode || !containerRef.current) return;
    const container = containerRef.current;
    _canvasEmbedContainers.add(container);
    _installCanvasBCRPatch();
    return () => {
      _canvasEmbedContainers.delete(container);
      _scaleCache.delete(container);
      _uninstallCanvasBCRPatch();
    };
  }, [isEmbedMode]);

  // Data-refresh size sync: when events change (Obsidian file watcher fires ~every minute),
  // React re-renders FC with new props, triggering componentDidUpdate → handleSizing() →
  // computeScrollerDims(). If the DOM is in a transient state at that exact moment the
  // harness width measurement can be stale and the wrong pixel widths get cached.
  // Schedule a corrective updateSize() after the DOM has settled so FC remeasures correctly.
  useEffect(() => {
    if (!isEmbedMode) return;
    const id = window.setTimeout(() => {
      const api = calendarRef.current?.getApi();
      if (api) api.updateSize();
    }, 100);
    return () => window.clearTimeout(id);
  }, [isEmbedMode, events]);

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
    if (isEmbedMode) return;
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
    isEmbedMode,
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
        // In canvas embeds, FullCalendar sets inline pixel widths that go stale.
        // Fire updateSize immediately via RAF, then again after a delay for layout settling.
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          if (calendarRef.current) {
            calendarRef.current.getApi().updateSize();
          }
        });
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
    } else {
      // In embed mode (especially canvas), observe ancestor containers
      // so we catch canvas node resize / scroll changes
      const canvasNode = containerEl.closest('.canvas-node-content') || containerEl.closest('.canvas-node');
      if (canvasNode) {
        resizeObserver.observe(canvasNode);
        if (canvasNode.parentElement) resizeObserver.observe(canvasNode.parentElement);
      }
      // Also observe a few parent levels for general embeds
      let parent = containerEl.parentElement;
      let depth = 0;
      while (parent && depth < 3) {
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

  // Measure the calendar body flex child (below nav chrome) separately so that
  // fullCalendarHeight excludes the toolbar and matches the exact available space.
  useEffect(() => {
    const el = calendarBodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const h = Math.round(entry.contentRect.height);
      setCalendarBodyHeight(prev => h > 0 && Math.abs(prev - h) > 1 ? h : prev);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      if (resolvedFilterViewMode !== "month" && resolvedFilterViewMode !== "week") {
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
  }, [currentDate, resolvedFilterViewMode, targetDayCount]);

  // FullCalendar treats `initialView` as one-time setup. When filter-based logic
  // derives a different concrete mode after mount, force the calendar API to
  // switch so the rendered columns match the computed mode.
  useEffect(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    if (lastAppliedViewNameRef.current === viewName) return;

    let targetDate = currentDate ? new Date(currentDate) : api.getDate();
    if (resolvedFilterViewMode !== "month" && resolvedFilterViewMode !== "week" && resolvedFilterViewMode !== "continuous") {
      const offset = Math.floor((targetDayCount - 1) / 2);
      targetDate = new Date(targetDate);
      targetDate.setHours(0, 0, 0, 0);
      targetDate.setDate(targetDate.getDate() - offset);
    }

    logger.log(
      `[CalendarReactView] Syncing FullCalendar view desired=${viewName} actual=${api.view.type} target=${targetDate.toDateString()}`,
    );
    api.changeView(viewName, targetDate);
    lastAppliedViewNameRef.current = viewName;
  }, [viewName, currentDate, resolvedFilterViewMode, targetDayCount]);

  // --- Event handlers ---
  const handleEventClick = useCallback(
    (clickInfo: EventClickArg) => {
      clickInfo.jsEvent.preventDefault();
      if (Date.now() < suppressEntryClickUntilRef.current) {
        clickInfo.jsEvent.stopPropagation();
        return;
      }
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
      const directCalendarEntry = dropInfo.event.extendedProps.calendarEntry as CalendarEntry | undefined;
      const directEntry = directCalendarEntry?.entry;
      const entryPath = dropInfo.event.extendedProps.entryPath;
      const entry = directEntry ?? (entryPath ? basesEntryMap.get(entryPath) : undefined);
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
      const directCalendarEntry = resizeInfo.event.extendedProps.calendarEntry as CalendarEntry | undefined;
      const directEntry = directCalendarEntry?.entry;
      const entryPath = resizeInfo.event.extendedProps.entryPath;
      const entry = directEntry ?? (entryPath ? basesEntryMap.get(entryPath) : undefined);
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
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hour12: timeFormatSetting === "12h",
    });
  }, [timeFormatSetting]);

  const formatSelectionPreview = useCallback((start: Date, end: Date, allDay: boolean) => {
    if (!allDay) {
      return `${formatTime(start)} - ${formatTime(end)}`;
    }
    const endInclusive = new Date(end.getTime() - 1);
    const startLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endLabel = endInclusive.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return startLabel === endLabel ? startLabel : `${startLabel} - ${endLabel}`;
  }, [formatTime]);

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

      const isPastEvent = !!event.extendedProps?.isPast || event.classNames.includes("is-past");
      if (isPastEvent) {
        element.style.setProperty("opacity", "var(--tps-past-event-opacity, 0.55)", "important");
      } else {
        element.style.removeProperty("opacity");
      }

      const priorityColor = (event.extendedProps.priorityColor as string | undefined) ?? "";
      if (priorityColor) {
        element.style.setProperty("--priority-color", priorityColor);
        element.style.setProperty("background", priorityColor, "important");
        element.style.setProperty(
          "background-image",
          `linear-gradient(180deg, ${priorityColor}, color-mix(in srgb, ${priorityColor}, black 10%))`,
          "important",
        );
        element.style.setProperty("border-color", priorityColor, "important");
      } else {
        element.style.removeProperty("--priority-color");
        element.style.removeProperty("background");
        element.style.removeProperty("background-image");
        element.style.removeProperty("border-color");
      }

      const isExternalDropPreview = !!event.extendedProps?.isExternalDropPreview;
      if (isExternalDropPreview) {
        element.style.opacity = "0.7";
        element.style.borderStyle = "dashed";
        element.style.pointerEvents = "none";
      }

      if (event.extendedProps.entryPath) {
        element.setAttribute('data-path', event.extendedProps.entryPath);
        element.classList.add('tps-calendar-entry');
        const shouldHighlight = pathsLikelyMatch(event.extendedProps.entryPath, activeFilePathRef.current);
        applyActiveNoteEventHighlight(element, shouldHighlight);
      }
      if (!event.allDay) {
        const eventMinHeight = event.extendedProps.minEventHeight as number | undefined;
        if (typeof eventMinHeight === "number" && Number.isFinite(eventMinHeight) && eventMinHeight > 0) {
          element.style.minHeight = `${eventMinHeight}px`;
        }
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

      const isMirrorEvent = Boolean((arg as any)?.isMirror) || element.classList.contains("fc-event-mirror");
      if (isMirrorEvent && !event.allDay) {
        // For create-selection mirrors (the temporary "Untitled" block), keep the range
        // visible directly on the card so users can see start/end while dragging.
        const mirrorObserver = new MutationObserver(() => updateTimeLabels(event, element));
        mirrorObserver.observe(element, { attributes: true, attributeFilter: ["style"] });
        (element as any)._timeObserver = mirrorObserver;
        updateTimeLabels(event, element);
        setLabelsVisible(element, true);

        top.style.top = "2px";
        top.style.left = "6px";
        top.style.transform = "none";
        top.style.fontSize = "11px";
        bottom.style.bottom = "2px";
        bottom.style.left = "6px";
        bottom.style.transform = "none";
        bottom.style.fontSize = "11px";
      } else {
        top.style.removeProperty("top");
        top.style.removeProperty("left");
        top.style.removeProperty("transform");
        top.style.removeProperty("font-size");
        bottom.style.removeProperty("bottom");
        bottom.style.removeProperty("left");
        bottom.style.removeProperty("transform");
        bottom.style.removeProperty("font-size");
      }

      // Sticky title: keep the event title visible at the top of the visible
      // portion of the event as the user scrolls, for tall timegrid events.
      if (!event.allDay) {
        const titleEl = element.querySelector('.bases-calendar-event-title') as HTMLElement | null;
        const scroller = element.closest(
          '.fc-scroller-liquid-absolute, .fc-scroller-liquid, .fc-scroller'
        ) as HTMLElement | null;
        if (titleEl && scroller) {
          const updateStickyTitle = () => {
            const eventRect = element.getBoundingClientRect();
            const scrollerRect = scroller.getBoundingClientRect();
            const eventHeight = eventRect.height;
            const titleHeight = titleEl.offsetHeight || 18;
            // Pixels of event top that have scrolled above the scroller's top edge
            const hiddenAbove = Math.max(0, scrollerRect.top - eventRect.top);
            // Never push title below the event bottom (leave 2px buffer)
            const maxTranslate = Math.max(0, eventHeight - titleHeight - 2);
            const translateY = Math.min(hiddenAbove, maxTranslate);
            titleEl.style.transform = translateY > 0 ? `translateY(${translateY}px)` : '';
          };
          scroller.addEventListener('scroll', updateStickyTitle, { passive: true });
          (element as any)._stickyScroller = scroller;
          (element as any)._stickyHandler = updateStickyTitle;
          // Run once on mount in case the event is already partially scrolled out
          updateStickyTitle();
        }
      }

      const contextMenuHandler = (e: MouseEvent) => {
        e.preventDefault();
        // In canvas embed mode, allow the contextmenu event to keep propagating
        // so the canvas node context menu (GCM) can still appear. In normal mode
        // stop propagation to prevent workspace-level handlers from firing.
        if (!isEmbedModeRef.current) {
          e.stopPropagation();
        }
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
      const activeDateKey = extractDailyNoteDateKey(activeFilePathRef.current, dailyNoteDateFormatRef.current);
      applyActiveDayLabelHighlight(linkEl, !!activeDateKey && formatDateKey(date) === activeDateKey);
    }

    if (Platform.isMobile) {
      // Mobile header injection removed in favor of floating controls
    }
  }, [onDateMouseEnter, resolvedFilterViewMode, resolvedNavDays, onDateChange]);

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
    // Sticky title cleanup
    const stickyScroller = (element as any)._stickyScroller as HTMLElement | undefined;
    const stickyHandler = (element as any)._stickyHandler as EventListener | undefined;
    if (stickyScroller && stickyHandler) {
      stickyScroller.removeEventListener('scroll', stickyHandler);
      delete (element as any)._stickyScroller;
      delete (element as any)._stickyHandler;
    }
  }, []);

  const handleDragStart = useCallback(
    (info: any) => {
      setIsInternalDragging(true);
      suppressEntryClickUntilRef.current = Date.now() + 800;
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
      suppressEntryClickUntilRef.current = Date.now() + 800;
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
        setSelectionPreview(null);
        await onCreateSelection(start, end);
      } catch (error) {
        logger.error('[Calendar] Error creating event:', error);
      } finally {
        setSelectionPreview(null);
        calendarRef.current?.getApi()?.unselect();
      }
    },
    [onCreateSelection],
  );

  const handleSelectAllow = useCallback((selectionInfo: any) => {
    const toDate = (value: any): Date | null => {
      if (!value) return null;
      if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    };
    const start = toDate(selectionInfo?.start);
    const end = toDate(selectionInfo?.end);
    if (start && end && end.getTime() > start.getTime()) {
      setSelectionPreview({ start, end, allDay: !!selectionInfo?.allDay });
    }
    return true;
  }, []);

  const handleUnselect = useCallback(() => {
    setSelectionPreview(null);
  }, []);

  useEffect(() => {
    const mirrors = Array.from(
      (containerRef.current ?? document).querySelectorAll<HTMLElement>(".fc-event-mirror"),
    );
    if (!mirrors.length) return;

    for (const mirror of mirrors) {
      const top = mirror.querySelector<HTMLElement>(".bases-calendar-time-top");
      const bottom = mirror.querySelector<HTMLElement>(".bases-calendar-time-bottom");
      if (!top || !bottom) continue;

      if (!selectionPreview || selectionPreview.allDay) {
        top.textContent = "";
        bottom.textContent = "";
        continue;
      }

      top.textContent = formatTime(selectionPreview.start);
      bottom.textContent = formatTime(selectionPreview.end);
      top.classList.add("is-visible");
      bottom.classList.add("is-visible");
    }
  }, [selectionPreview, formatTime]);

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

    // 1. Obsidian native drag types (Notebook Navigator, file explorer)
    const obsidianFile = e.dataTransfer.getData("obsidian/file");
    if (obsidianFile && obsidianFile.trim().length > 0) {
      const cleaned = obsidianFile.trim();
      return cleaned.endsWith('.md') ? cleaned : `${cleaned}.md`;
    }

    const obsidianFiles = e.dataTransfer.getData("obsidian/files");
    if (obsidianFiles) {
      try {
        const paths = JSON.parse(obsidianFiles);
        if (Array.isArray(paths) && paths.length > 0 && typeof paths[0] === "string") {
          const first = paths[0].trim();
          return first.endsWith('.md') ? first : `${first}.md`;
        }
      } catch { /* ignore */ }
    }

    // 2. text/plain — could be obsidian:// URL, raw .md path, or markdown link
    const textData = e.dataTransfer.getData("text/plain");
    if (textData) {
      if (textData.startsWith('obsidian://')) {
        const parsed = parseObsidianUrl(textData);
        if (parsed) return parsed;
      }
      const cleaned = textData.trim();
      if (cleaned.endsWith(".md")) return cleaned;

      // Parse markdown wikilink [[path]] or [[path|alias]]
      const wikiMatch = cleaned.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
      if (wikiMatch) {
        const linkTarget = wikiMatch[1].trim();
        return linkTarget.endsWith('.md') ? linkTarget : `${linkTarget}.md`;
      }

      // Parse markdown link [text](path)
      const mdLinkMatch = cleaned.match(/^\[.*?\]\((.+?)\)$/);
      if (mdLinkMatch) {
        const linkTarget = mdLinkMatch[1].trim();
        return linkTarget.endsWith('.md') ? linkTarget : `${linkTarget}.md`;
      }
    }

    // 3. text/uri-list
    const uriData = e.dataTransfer.getData("text/uri-list");
    if (uriData && uriData.startsWith('obsidian://')) {
      const parsed = parseObsidianUrl(uriData);
      if (parsed) return parsed;
    }

    // 4. OS file drop
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
    const stack = document.elementsFromPoint(e.clientX, e.clientY) as HTMLElement[];
    const elementAtPoint = stack[0] ?? document.elementFromPoint(e.clientX, e.clientY);
    if (!elementAtPoint) return null;

    let dateStr: string | null = null;
    let timeStr: string | null = null;
    let isAllDay = false;

    // Prefer the full hit stack, since timegrid slats often sit under event/overlay layers.
    for (const node of stack) {
      const slot = node.closest('.fc-timegrid-slot[data-time]') as HTMLElement | null;
      if (slot) {
        timeStr = slot.getAttribute('data-time');
        break;
      }
    }

    const timeGridBody =
      (stack.find((node) => node.closest('.fc-timegrid-body'))?.closest('.fc-timegrid-body') as HTMLElement | null)
      ?? (elementAtPoint.closest('.fc-timegrid-body') as HTMLElement | null);
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

    // If we couldn't directly hit a slat, derive time from slot geometry at this Y.
    if (!timeStr) {
      const fcRoot =
        (stack.find((node) => node.closest('.fc'))?.closest('.fc') as HTMLElement | null)
        ?? (elementAtPoint.closest('.fc') as HTMLElement | null);
      if (fcRoot) {
        const slotRows = Array.from(
          fcRoot.querySelectorAll<HTMLElement>('.fc-timegrid-slot[data-time]'),
        );
        if (slotRows.length > 0) {
          const y = e.clientY;
          let bestSlot: HTMLElement | null = null;
          let bestDist = Number.POSITIVE_INFINITY;
          for (const slot of slotRows) {
            const rect = slot.getBoundingClientRect();
            // Prefer the slot that contains the pointer Y.
            if (y >= rect.top && y < rect.bottom) {
              bestSlot = slot;
              break;
            }
            const dist = Math.min(Math.abs(y - rect.top), Math.abs(y - rect.bottom));
            if (dist < bestDist) {
              bestDist = dist;
              bestSlot = slot;
            }
          }
          if (bestSlot) {
            timeStr = bestSlot.getAttribute('data-time');
          }
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
      const colHeader =
        (stack.find((node) => node.closest('[data-date]'))?.closest('[data-date]') as HTMLElement | null)
        ?? (elementAtPoint.closest('[data-date]') as HTMLElement | null);
      if (colHeader) {
        dateStr = colHeader.getAttribute('data-date');
      }
    }

    if (!isAllDay) {
      const inAllDayRow = stack.some(
        (node) => !!node.closest('.fc-timegrid-allday, .fc-daygrid-day-events, .fc-daygrid-day'),
      );
      if (inAllDayRow && !timeStr) {
        isAllDay = true;
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

  const hasDroppableData = useCallback((types: readonly string[]): boolean => {
    return types.includes('Files') || types.includes('text/plain') || types.includes('obsidian/file') || types.includes('obsidian/files');
  }, []);

  const handleExternalDragOver = useCallback((e: React.DragEvent) => {
    if (hasDroppableData(e.dataTransfer.types) && onExternalDrop) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const dropInfo = getDateFromDropEvent(e);
      if (dropInfo) {
        const durationMinutes = Math.max(5, snapDurationMinutes || defaultEventDuration || 30);
        const start = new Date(dropInfo.date);
        const end = dropInfo.allDay
          ? new Date(start.getTime() + 24 * 60 * 60 * 1000)
          : new Date(start.getTime() + durationMinutes * 60 * 1000);
        setExternalDropPreview((prev) => {
          if (
            prev &&
            prev.allDay === dropInfo.allDay &&
            prev.start.getTime() === start.getTime() &&
            prev.end.getTime() === end.getTime()
          ) {
            return prev;
          }
          return { start, end, allDay: dropInfo.allDay };
        });
      } else {
        setExternalDropPreview(null);
      }
    }
  }, [onExternalDrop, getDateFromDropEvent, snapDurationMinutes, defaultEventDuration]);

  const handleExternalDragEnter = useCallback((e: React.DragEvent) => {
    dragCounterRef.current++;
    if (hasDroppableData(e.dataTransfer.types) && onExternalDrop) {
      e.preventDefault();
      setIsDraggingOver(true);
    }
  }, [onExternalDrop]);

  const handleExternalDragLeave = useCallback((e: React.DragEvent) => {
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
      setExternalDropPreview(null);
    }
  }, []);

  const handleExternalDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDraggingOver(false);
    setExternalDropPreview(null);
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

  const eventsWithExternalDropPreview = useMemo(() => {
    if (!externalDropPreview) return events;
    return [
      ...events,
      {
        id: "__tps_external_drop_preview__",
        title: "Drop here",
        start: externalDropPreview.start,
        end: externalDropPreview.end,
        allDay: externalDropPreview.allDay,
        classNames: ["bases-calendar-event", "bases-calendar-external-drop-preview"],
        extendedProps: { isExternalDropPreview: true },
        display: "block",
        backgroundColor: "var(--interactive-accent)",
        borderColor: "var(--interactive-accent)",
        textColor: "#ffffff",
      },
    ];
  }, [events, externalDropPreview]);

  const handleDatesSet = useCallback((arg: DatesSetArg) => {
    logger.log(
      `[CalendarReactView] datesSet view.type=${arg.view.type} title=${arg.view.title} start=${arg.start.toDateString()} end=${arg.end.toDateString()} desired=${viewName}`,
    );
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
      if (resolvedFilterViewMode !== "month" && resolvedFilterViewMode !== "week" && resolvedFilterViewMode !== "continuous") {
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
  }, [onDateChange, currentDate, resolvedFilterViewMode, targetDayCount, isFollowingNow, scrollToNow, viewName]);

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
    if (navigationLocked || !canNavigateToday) return;
    if (resolvedFilterViewMode === "month" || resolvedFilterViewMode === "week") {
      api.today();
      if (onDateChange) onDateChange(api.getDate());
      if (resolvedFilterViewMode === "week") {
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
  }, [targetDayCount, resolvedFilterViewMode, onDateChange, scrollToNow, navigationLocked, canNavigateToday]);

  const handlePrevClick = useCallback(() => {
    if (navigationLocked || !canNavigatePrev) return;
    if (resolvedFilterViewMode === 'continuous') {
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
    if (resolvedFilterViewMode === "month") {
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
  }, [resolvedNavDays, resolvedFilterViewMode, onDateChange, targetDayCount, navigationLocked, canNavigatePrev]);

  const handleNextClick = useCallback(() => {
    if (navigationLocked || !canNavigateNext) return;
    if (resolvedFilterViewMode === 'continuous') {
      const el = document.querySelector('.bases-calendar-continuous-scroll-container') as HTMLElement;
      if (el) {
        const currentScroll = el.scrollTop;
        el.scrollTo({ top: currentScroll + 800, behavior: 'smooth' });
      }
      return;
    }
    const api = calendarRef.current?.getApi();
    if (!api) return;
    if (resolvedFilterViewMode === "month") {
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
  }, [resolvedNavDays, resolvedFilterViewMode, onDateChange, targetDayCount, navigationLocked, canNavigateNext]);

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
        "--tps-active-note-highlight-color": activeEventHighlightColor || "#3b82f6",
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
        canNavigatePrev={canNavigatePrev}
        canNavigateNext={canNavigateNext}
        canNavigateToday={canNavigateToday}
        navigationBoundsStart={navigationBoundsStart}
        navigationBoundsEnd={navigationBoundsEnd}
        headerTitle={headerTitle}
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

      {selectionPreview && (
        <div
          className="bases-calendar-selection-preview"
          style={{
            position: "fixed",
            top: 12,
            right: 12,
            zIndex: 100000,
            background: "var(--background-primary)",
            border: "1px solid var(--background-modifier-border)",
            borderRadius: "999px",
            padding: "4px 10px",
            fontSize: "12px",
            fontWeight: 600,
            color: "var(--text-normal)",
            pointerEvents: "none",
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
          }}
        >
          {formatSelectionPreview(selectionPreview.start, selectionPreview.end, selectionPreview.allDay)}
        </div>
      )}

      <div ref={calendarBodyRef} style={{ flex: "1 1 0%", height: "100%", overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
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
          {resolvedFilterViewMode !== 'continuous' && (
            <FullCalendar
              height={fullCalendarHeight}
              contentHeight={fullCalendarContentHeight}
              expandRows={resolvedFilterViewMode === "month" && !isMobile}
              plugins={activePlugins}
              key={`calendar-${resolvedFilterViewMode}-${resolvedShowFullDay}-${effectiveCondenseLevel}-${slotDurationMinutes}-${snapDurationMinutes}-${dayHeaderFormatSetting}-${dayHeaderShowDate}-${timeFormatSetting}-${defaultScrollTimeSetting}-${showNowIndicator}`}
              ref={calendarRef}
              initialView={viewName}
              initialDate={safeInitialDate}
              views={views}
              headerToolbar={false}
              selectable={allowSelect}
              selectMirror={allowSelect}
              selectOverlap={allowSelect}
              selectAllow={allowSelect ? handleSelectAllow : undefined}
              slotEventOverlap={false}
              select={allowSelect ? handleSelect : undefined}
              selectLongPressDelay={isMobile ? 600 : 300}
              longPressDelay={isMobile ? 600 : 300}
              eventLongPressDelay={isMobile ? 600 : 300}
              eventDragMinDistance={isMobile ? 10 : 5}
              unselectAuto={true}
              unselectCancel=".fc-event"
              unselect={allowSelect ? handleUnselect : undefined}
              editable={allowEdit}
              eventStartEditable={allowEdit}
              eventDurationEditable={allowEdit && !!onEventResize}
              events={eventsWithExternalDropPreview}
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
                resolvedFilterViewMode === "month"
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
              validRange={validRange}
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

          {resolvedFilterViewMode === 'continuous' && (
            <ContinuousScrollView
              currentDate={currentDate}
              events={eventsWithExternalDropPreview}
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
              handleSelectAllow={allowSelect ? handleSelectAllow : undefined}
              handleUnselect={allowSelect ? handleUnselect : undefined}
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
