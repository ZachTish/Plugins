import {
  App,
  BasesEntry,
  BasesPropertyId,
  BasesView,
  CachedMetadata,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  normalizePath,
  parsePropertyId,
  parseYaml,
  QueryController,
  setIcon,
  TFile,
  ViewOption,
  Value,
  WorkspaceLeaf,
  debounce,
  Platform
} from "obsidian";
import { StrictMode } from "react";
import { createRoot, Root } from "react-dom/client";
import { CalendarReactView, CalendarEntry } from "./CalendarReactView";
import { AppContext } from "./context";
import { NewEventService } from "./services/new-event-service";
import { CalendarPluginBridge } from "./plugin-interface";
import {
  DEFAULT_CONDENSE_LEVEL,
  MAX_CONDENSE_LEVEL,
  formatDateTimeForFrontmatter,
  normalizeCalendarUrl,
} from "./utils";
import { ExternalCalendarService } from "./services/external-calendar-service";
import { CalendarViewMode, ExternalCalendarEvent } from "./types";
import { ExternalEventModal, createMeetingNoteFromExternalEvent } from "./modals/external-event-modal";
import { applyParentLinkToChild, createBidirectionalLink } from "./services/parent-child-link";
import { FileSelectionModal } from "./modals/file-selection-modal";
import { HeaderSelectionModal } from "./modals/header-selection-modal";
import {
  isLowerBoundOperator,
  isUpperBoundOperator,
  stripOuterQuotes,
  normalizeFilterValue,
  parseRelativeDurationMs,
  resolveFilterDateAtom,
  resolveFilterDateExpression,
  getAutoRangeViewDayCount,
} from "./utils/filter-date-utils";
import {
  extractDate,
  extractDuration,
  resolveDateValue,
  valueToString,
  tryParseDate,
  resolveFromPotentialDate,
} from "./utils/date-value-utils";
import * as logger from "./logger";
import { parseDateFromFilename } from '../../tps/src/utils/daily-file-date';
import { RRule } from "rrule";
import { parseAllTaskItems, ParsedTaskItem } from "./services/task-parser-service";

export const CalendarViewType = "calendar";

type StartDateSourceSlot = "primary" | "secondary" | "tertiary";
interface ResolvedEntryStartDate {
  date: Date;
  slot: StartDateSourceSlot;
  isDateOnly: boolean;
}


export class CalendarView extends BasesView {
  type = CalendarViewType;
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  root: Root | null = null;
  private plugin: CalendarPluginBridge;

  // Internal rendering data
  private entries: CalendarEntry[] = [];
  private unscheduledEntries: { file: TFile; title: string }[] = [];
  private pendingUpdates = new Map<string, { start: Date; end?: Date; timestamp: number }>();
  private startDateProp: BasesPropertyId | null = null;
  private secondaryStartDateProp: BasesPropertyId | null = null;
  private tertiaryStartDateProp: BasesPropertyId | null = null;
  private includePrimaryDateSource = true;
  private includeSecondaryDateSource = false;
  private includeTertiaryDateSource = false;
  private primaryDurationMinutes: number | null = null;
  private secondaryDurationMinutes: number | null = null;
  private tertiaryDurationMinutes: number | null = null;
  private endDateProp: BasesPropertyId | null = null;
  private titleProp: BasesPropertyId | null = null;
  private weekStartDay: number = 1;
  private refreshTimeout: number | null = null;
  private newEventTemplate: string | null = null;
  private newEventTemplateType: string | null = null;
  private baseTemplatePath: string | null = null;
  private defaultFrontmatter: Record<string, any> = {};
  private allDayProperty: BasesPropertyId | null = null;
  private priorityField: BasesPropertyId | null = null;
  private statusField: BasesPropertyId | null = null;
  private condenseLevel: number = DEFAULT_CONDENSE_LEVEL;

  private getDailyNoteDateFormat(): string | undefined {
    const configured = (this.plugin as any)?.settings?.dailyNoteDateFormat;
    if (typeof configured === "string" && configured.trim()) {
      return configured.trim();
    }

    const dailyNotesFormat = (this.app as any)?.internalPlugins?.plugins?.["daily-notes"]?.instance?.options?.format;
    if (typeof dailyNotesFormat === "string" && dailyNotesFormat.trim()) {
      return dailyNotesFormat.trim();
    }

    return undefined;
  }

  private parseFilenameComponents(basename: string): { cleanTitle: string; dateSuffix: string | null } {
    const userFormat = this.getDailyNoteDateFormat();

    try {
      const whole = parseDateFromFilename(basename, userFormat);
      if (whole && whole.isValid && whole.isValid()) {
        // @ts-ignore
        const momentWhole = (window as any).moment(basename, [userFormat, (window as any).moment.ISO_8601, 'YYYY-MM-DD', 'YYYY_MM_DD', 'YYYYMMDD'], true);
        if (momentWhole && momentWhole.isValid && momentWhole.isValid()) {
          return { cleanTitle: '', dateSuffix: whole.format('YYYY-MM-DD') };
        }
      }

      const datePattern = /\s*(\d{4}[-_/]\d{2}[-_/]\d{2}|\d{8})(?:\s+\d+)?$/;
      const match = basename.match(datePattern);
      if (match) {
        const parsed = parseDateFromFilename(match[1], userFormat);
        if (parsed && parsed.isValid && parsed.isValid()) {
          return { cleanTitle: basename.substring(0, match.index).trim(), dateSuffix: parsed.format('YYYY-MM-DD') };
        }
      }

      const humanDatePattern = /\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?,?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)(?:[a-z]+)?\s+\d{1,2},?\s+\d{4})(?:\s+\d+)?$/i;
      const humanMatch = basename.match(humanDatePattern);
      if (humanMatch) {
        const moment = (window as any).moment;
        const parsed = moment
          ? moment(humanMatch[1], [
            'ddd, MMM D YYYY',
            'ddd MMM D YYYY',
            'dddd, MMMM D YYYY',
            'dddd MMMM D YYYY',
            'ddd, MMMM D YYYY',
            'ddd MMMM D YYYY',
          ], true)
          : null;
        if (parsed && parsed.isValid && parsed.isValid()) {
          return { cleanTitle: basename.substring(0, humanMatch.index).trim(), dateSuffix: parsed.format('YYYY-MM-DD') };
        }
      }
    } catch {
      // Fall through to naive behavior.
    }

    const match = basename.match(/\s*(\d{4}[-/]\d{2}[-/]\d{2}|\d{8})(?:\s+\d+)?$/);
    if (match) {
      return { cleanTitle: basename.substring(0, match.index).trim(), dateSuffix: match[1] };
    }

    return { cleanTitle: basename, dateSuffix: null };
  }

  private dateFromIsoDateOnly(value: string | null): Date | null {
    if (!value) return null;
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  private showFullDay: boolean = false;
  private currentDate: Date | null = null;
  private dayCount: number = 7;
  private navStep: number = 7;
  private minHour: string = "";
  private maxHour: string = "";
  private showHiddenHoursToggle: boolean = true;
  private useEndDuration: boolean = true; // true = duration field, false = end datetime field
  private defaultEventDuration: number = 30;
  private showNavButtons: boolean = true;
  private newEventService: NewEventService;
  private externalCalendarUrls: string[] = [];
  private visibleExternalCalendarUrls: string[] = [];
  private externalCalendarFilterTerms: string[] = [];
  private externalCalendarService: ExternalCalendarService;
  // private showHiddenEvents: boolean = false; // Removed per user request
  private cachedExternalEvents: ExternalCalendarEvent[] = [];
  private isFetchingExternalEvents: boolean = false;
  private cachedRawTaskItems: ParsedTaskItem[] = [];
  private taskItemAllowedPaths: Set<string> | null = null;
  private isFetchingTaskItems: boolean = false;
  private lastTaskItemsFetch: number = 0;
  private viewMode: CalendarViewMode = "week";
  private allDayLimit: number = 3; // New property with default 3

  // Filter-based view mode auto-switching
  private filterRangeAuto: boolean = false; // Enable auto view mode based on entry date range
  private filterRangeStart: Date | null = null; // Computed min date from entries
  private filterRangeEnd: Date | null = null; // Computed max date from entries
  private filterRangeDays: number = 0; // Number of days in the filtered range
  private navigationLockedByAutoRange = false;
  private navigationBoundsStart: Date | null = null; // Explicit filter lower bound for navigation
  private navigationBoundsEnd: Date | null = null; // Explicit filter upper bound for navigation
  private entryBoundsMin: Date | null = null; // Pure entry min date (before filter config override)
  private entryBoundsMax: Date | null = null; // Pure entry max date (before filter config override)
  private autoRangeInitialized = false; // Whether the initial auto-range has been applied
  private lastAutoRangeKey: string | null = null; // Tracks last range to detect significant changes
  private saveDateTimeout: ReturnType<typeof setTimeout> | null = null; // Debounce timer for date persistence
  private explicitViewModePinned = false;

  // Context-aware date detection (for embedding in daily notes)
  private contextDateEnabled: boolean = false; // Enable date detection from parent note

  private contextDateDetected: Date | null = null; // The detected date from parent note
  private lastLoggedContextParentPath: string | null = null;
  private lastLoggedContextDateDetectedKey: string | null = null;
  private lastLoggedContextDateAppliedKey: string | null = null;
  private loggedMissingContextParent = false;
  private lastLoggedFilterRangeKey: string | null = null;
  private pendingFastRefreshLogCount = 0;
  private fastRefreshLogTimer: number | null = null;

  private headerResizeObserver: ResizeObserver | null = null;
  private headerMutationObserver: MutationObserver | null = null;
  private observedHeaders = new WeakSet<HTMLElement>();
  private dayPickerAction: HTMLElement | null = null;
  private datePickerInput: HTMLInputElement | null = null;
  private debouncedUpdateHeaderOffset: () => void;
  private controller: QueryController;
  private pendingDataRetryId: number | null = null;
  private pendingDataRetryCount = 0;
  private readonly pendingDataMaxRetries = 12;

  // Services

  private lastAutoCreateCheck: number = 0;
  private lastExternalFetch: number = 0;
  private lastFrontmatterByPath: Map<string, string> = new Map();
  private lastEditorChangeAt: number = 0;
  private readonly typingQuietWindowMs: number = 4000;



  private debouncedRefresh: () => void;

  constructor(
    controller: QueryController,
    scrollEl: HTMLElement,
    plugin: CalendarPluginBridge,
  ) {
    super(controller);
    // console.log("Updating Calendar...");
    try {
      if (!controller) {
        logger.error("[CalendarView] Controller is null");
        // Depending on how critical the controller is, you might want to throw an error or handle it differently.
        // For now, we'll just return, which might leave the view in an uninitialized state.
        // A more robust solution might involve throwing an error or setting a flag to prevent further operations.
      }
    } catch (e) {
      logger.error("[CalendarView] Error during controller check:", e);
    }
    this.controller = controller;
    this.plugin = plugin;
    this.scrollEl = scrollEl;
    this.scrollEl.classList.add("bases-calendar-scroll");
    this.containerEl = scrollEl.createDiv({
      cls: "bases-calendar-container is-loading",
      attr: { tabIndex: 0 },
    });
    this.lastAutoCreateCheck = 0;
    this.newEventService = new NewEventService({ app: this.app });
    this.externalCalendarService = new ExternalCalendarService();

    // Create debounced version of header update
    this.debouncedUpdateHeaderOffset = debounce(() => {
      this.updateBasesHeaderOffset();
    }, 100, true);

    this.debouncedRefresh = debounce(() => {
      this.updateCalendar();
    }, 500, true);

  }

  onload(): void {
    // React components will handle their own lifecycle
    this.registerEvent(
      this.app.workspace.on("tps-gcm-delete-complete" as any, () => {
        this.newEventService.ensureFocus();
      }),
    );

    this.registerRefreshListeners();
    this.refreshFromPluginSettings(); // Ensure settings (like inProgressStatusValue) are loaded
    this.updateBasesHeaderOffset();
    this.installHeaderResizeObserver();

    // DEBUG polling to ensure we catch the header
    let attempts = 0;
    const pollInterval = window.setInterval(() => {
      attempts++;
      const leaf = this.containerEl.closest('.workspace-leaf');
      const leafContent = this.containerEl.closest('.workspace-leaf-content');
      const root = (leaf || leafContent) as HTMLElement;

      if (root) {
        const headers = root.querySelectorAll('.bases-view-header, .bases-toolbar, .bases-header, .view-header');
        if (headers.length > 0) {
          // new Notice(`Polling attempt ${attempts}: Found header!`);
        }
      }

      if (attempts > 10) window.clearInterval(pollInterval);
    }, 500);

    // Create hidden input
    this.datePickerInput = this.containerEl.createEl('input', {
      type: 'date',
      attr: { style: 'display:none;' }
    });
    this.datePickerInput.addEventListener('change', (e) => {
      const val = (e.target as HTMLInputElement).value;
      if (val) {
        const [y, m, d] = val.split('-').map(Number);
        const safeDate = new Date(y, m - 1, d);
        this.currentDate = safeDate;
        this.renderReactCalendar();
      }
    });

    // Initial Render - only if config is already available
    // If config is null, onDataUpdated() will handle initialization once Bases provides data
    if (this.config) {
      this.loadConfig();
      this.updateCalendar();
    }
    if (!this.data || !this.config) {
      this.scheduleDataRetry();
    }

    // Start background sync timer if auto-create is enabled
  }

  onResize(): void {
    // Check if view is actually visible before doing work
    if (!this.containerEl.isShown()) return;

    // Use debounced update for header offset
    this.debouncedUpdateHeaderOffset();

    // Throttle React render
    if (this.root) {
      this.renderReactCalendar();
    }
  }

  onunload(): void {
    if (this.refreshTimeout !== null) {
      window.clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }
    if (this.pendingDataRetryId !== null) {
      window.clearTimeout(this.pendingDataRetryId);
      this.pendingDataRetryId = null;
    }
    // if (this.syncIntervalId !== null) {
    //   window.clearInterval(this.syncIntervalId);
    //   this.syncIntervalId = null;
    // }
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    if (this.saveDateTimeout) {
      clearTimeout(this.saveDateTimeout);
      this.saveDateTimeout = null;
    }
    if (this.dayPickerAction) {
      this.dayPickerAction.remove();
      this.dayPickerAction = null;
    }
    this.headerResizeObserver?.disconnect();
    this.headerResizeObserver = null;
    this.headerMutationObserver?.disconnect();
    this.headerMutationObserver = null;
    this.entries = [];
  }

  public focus(): void {
    this.containerEl.focus({ preventScroll: true });
  }

  public onDataUpdated(): void {
    this.containerEl.removeClass("is-loading");
    this.loadConfig();
    if (!this.shouldProcessUpdates()) return;
    this.debouncedRefresh();
    this.debouncedUpdateHeaderOffset();
    setTimeout(() => this.debouncedUpdateHeaderOffset(), 0);
  }


  private isEmbeddedCalendarContext(): boolean {
    return !!this.containerEl.closest(
      '.tps-auto-base-embed__panel, .tps-auto-base-embed__content, .block-language-bases, .cm-preview-code-block, .internal-embed, .markdown-embed, .cm-embed-block, .sync-embed, .sync-container',
    );
  }

  private shouldProcessUpdates(): boolean {
    if (!this.containerEl.isConnected) return false;
    return this.containerEl.isShown() || this.isActiveLeaf();
  }

  private updateBasesHeaderOffset(): void {
    // Critical: Stop if view is hidden or detached (prevents background loops)
    if (!this.shouldProcessUpdates()) return;

    const isEmbedded = this.isEmbeddedCalendarContext();

    // 1. Locate the correct header specifically for THIS view instance

    // Check if we are inside an embed block (dataview, bases, etc)
    const embedBlock = this.containerEl.closest(
      '.tps-auto-base-embed__panel, .block-language-bases, .cm-preview-code-block, .internal-embed, .markdown-embed, .cm-embed-block, .sync-embed, .sync-container',
    );

    let targetHeader: HTMLElement | null = null;

    if (embedBlock) {
      // STRICT MODE: Only look inside the embed block
      // We must look for a specific header layout provided by Bases
      const headers = Array.from(
        embedBlock.querySelectorAll<HTMLElement>('.bases-view-header, .base-view-header, .bases-toolbar, .bases-header, .view-header'),
      );
      targetHeader = this.pickNearestHeader(headers, this.containerEl);

      // If no header is found within the embed, we CANNOT safely inject elsewhere.
      if (!targetHeader) {
        // Try checking if the containerEl's previous sibling is the header (common structure)
        const prev = this.containerEl.previousElementSibling;
        if (prev && (
          prev.classList.contains('bases-toolbar') ||
          prev.classList.contains('bases-header') ||
          prev.classList.contains('bases-view-header') ||
          prev.classList.contains('base-view-header') ||
          prev.classList.contains('view-header')
        )) {
          targetHeader = prev as HTMLElement;
        }
      }

      if (!targetHeader) return; // Do not render controls if we can't find the correct place
    } else {
      // Full View Logic (Leaf-based)
      const leaf = this.containerEl.closest('.workspace-leaf') as HTMLElement | null;
      if (leaf) {
        const headers = Array.from(leaf.querySelectorAll<HTMLElement>('.bases-view-header, .bases-toolbar, .bases-header, .view-header'));
        targetHeader = this.pickNearestHeader(headers, this.containerEl);
      }
    }

    if (!targetHeader) return;

    this.syncNativeResultsCountInHeader(targetHeader);

    // Remove legacy desktop header portal controls from previous builds.
    const legacyPortals = this.containerEl
      .closest('.workspace-leaf-content')
      ?.querySelectorAll<HTMLElement>('.tps-calendar-nav-portal');
    legacyPortals?.forEach((el) => el.remove());

    // 3. Update Height Variables
    // Only set variable on our container, not global leaf, to avoid conflict with other embeds
    const height = Math.max(0, Math.round(targetHeader.getBoundingClientRect().height));
    if (height > 0) {
      this.containerEl.style.setProperty('--tps-bases-header-height', `${height}px`);
    }

    // Safety: embedded panes can briefly mount at header-only height; enforce a bounded fallback if absolutely zero.
    if (this.containerEl.offsetHeight === 0 && !isEmbedded) {
      this.containerEl.style.minHeight = '600px';
    } else if (this.containerEl.style.minHeight) {
      this.containerEl.style.removeProperty('min-height');
    }
  }

  private pickNearestHeader(headers: HTMLElement[], anchor: HTMLElement): HTMLElement | null {
    if (!headers.length) return null;
    const preceding = headers.filter((header) => {
      if (header === anchor) return false;
      const relation = header.compareDocumentPosition(anchor);
      return Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    if (preceding.length > 0) {
      return preceding[preceding.length - 1];
    }
    return headers[headers.length - 1];
  }

  private syncNativeResultsCountInHeader(header: HTMLElement): void {
    const countEl =
      header.querySelector<HTMLElement>(".view-header-count") ??
      header.querySelector<HTMLElement>(".bases-view-results-count") ??
      header.querySelector<HTMLElement>(".bases-results-count") ??
      header.querySelector<HTMLElement>(".bases-view-result-count") ??
      header.querySelector<HTMLElement>(".bases-result-count") ??
      header.querySelector<HTMLElement>("[class*=\"results-count\"]") ??
      header.querySelector<HTMLElement>("[class*=\"result-count\"]") ??
      header.querySelector<HTMLElement>(".bases-view-results") ??
      header.querySelector<HTMLElement>(".bases-results");
    if (!countEl) return;

    const count = this.getRenderedResultCount();
    const text = `${count} result${count === 1 ? "" : "s"}`;
    if (countEl.textContent?.trim() !== text) {
      countEl.textContent = text;
    }
  }

  private getRenderedResultCount(): number {
    // Match what the calendar currently renders in this view.
    // Entries are deduped by slot identity in updateCalendar().
    return this.entries.length;
  }



  private installHeaderResizeObserver(): void {
    if (this.headerResizeObserver || this.headerMutationObserver) return;
    const leafContent = this.containerEl.closest('.workspace-leaf-content') as HTMLElement | null;
    if (!leafContent || typeof ResizeObserver === 'undefined') return;

    // Wrap the observer callback with our debounced function
    const observeHeaders = () => {
      const headers = Array.from(
        leafContent.querySelectorAll<HTMLElement>('.bases-view-header, .bases-toolbar, .bases-header, .view-header'),
      );
      if (headers.length === 0) return;
      if (!this.headerResizeObserver) {
        // Use debounced sync
        this.headerResizeObserver = new ResizeObserver(() => this.debouncedUpdateHeaderOffset());
      }
      for (const el of headers) {
        if (!this.observedHeaders.has(el)) {
          this.observedHeaders.add(el);
          this.headerResizeObserver.observe(el);
        }
      }
      this.debouncedUpdateHeaderOffset();
    };

    // Try immediately, then keep watching for late-mounted headers (main panes).
    observeHeaders();
    this.headerMutationObserver = new MutationObserver(() => observeHeaders());
    this.headerMutationObserver.observe(leafContent, { childList: true, subtree: true });
    // setTimeout(() => observeHeaders(), 0); 
  }

  private loadConfig(): void {
    if (!this.config) {
      // console.log("[DEBUG-CALENDAR-V2] loadConfig: Config is null or undefined");
      return;
    }
    // console.log("[DEBUG-CALENDAR-V2] loadConfig: Loading configuration...");
    // Date properties
    // IMPORTANT: BasesPropertyId is a string (e.g. "note.date"). Do not use object fallbacks here;
    // parsePropertyId/Obsidian internals will throw (e.indexOf is not a function) if given a non-string.
    const startProp =
      this.config.getAsPropertyId("startDate") ??
      this.config.getAsPropertyId("startProperty") ??
      this.config.getAsPropertyId("start");
    const secondaryStartProp =
      this.config.getAsPropertyId("secondaryStartDate") ??
      this.config.getAsPropertyId("secondaryStartProperty") ??
      this.config.getAsPropertyId("secondaryStart");
    const tertiaryStartProp =
      this.config.getAsPropertyId("tertiaryStartDate") ??
      this.config.getAsPropertyId("tertiaryStartProperty") ??
      this.config.getAsPropertyId("tertiaryStart");
    const endProp =
      this.config.getAsPropertyId("endDate") ??
      this.config.getAsPropertyId("endProperty") ??
      this.config.getAsPropertyId("end");
    const configuredSecondaryStartProp = this.normalizeConfiguredPropertyId((this.plugin.settings as any)?.secondaryStartProperty);
    const configuredTertiaryStartProp = this.normalizeConfiguredPropertyId((this.plugin.settings as any)?.tertiaryStartProperty);
    const resolvedSecondaryStartProp = secondaryStartProp ?? configuredSecondaryStartProp;
    const resolvedTertiaryStartProp = tertiaryStartProp ?? configuredTertiaryStartProp;
    this.includePrimaryDateSource = this.parseBooleanLike(this.config.get("includePrimaryDateSource"), true);
    this.includeSecondaryDateSource = this.parseBooleanLike(
      this.config.get("includeSecondaryDateSource"),
      false,
    );
    this.includeTertiaryDateSource = this.parseBooleanLike(
      this.config.get("includeTertiaryDateSource"),
      false,
    );
    this.startDateProp = startProp ?? ("note.scheduled" as BasesPropertyId);
    this.secondaryStartDateProp = resolvedSecondaryStartProp;
    this.tertiaryStartDateProp = resolvedTertiaryStartProp;
    this.primaryDurationMinutes = this.parseOptionalDurationMinutes(this.config.get("primaryDurationMinutes"));
    this.secondaryDurationMinutes = this.parseOptionalDurationMinutes(this.config.get("secondaryDurationMinutes"));
    this.tertiaryDurationMinutes = this.parseOptionalDurationMinutes(this.config.get("tertiaryDurationMinutes"));
    this.endDateProp = endProp ?? ("note.timeEstimate" as BasesPropertyId);

    this.titleProp = this.config.getAsPropertyId("titleProperty");

    // Calendar options
    this.priorityField = this.config.getAsPropertyId("priorityField") ?? ("note.priority" as BasesPropertyId);
    this.statusField = this.config.getAsPropertyId("statusField") ?? ("note.status" as BasesPropertyId);

    this.defaultEventDuration = (this.config.get("defaultEventDuration") as number) ?? 30;

    const weekStartDayValue = this.plugin.settings.weekStartDay;
    this.weekStartDay = this.getWeekStartDay(weekStartDayValue || "monday");

    // Condense level
    const configCondenseLevel = this.config.get("condenseLevel") as number | undefined;
    if (configCondenseLevel !== undefined) {
      this.condenseLevel = this.normalizeCondenseLevel(configCondenseLevel);
    } else {
      // Fallback to plugin settings default if not set in view config
      this.condenseLevel = this.plugin.getDefaultCondenseLevel();
    }

    // Time range defaults are global plugin settings.
    const minHourValue = this.plugin.settings.minHour;
    const maxHourValue = this.plugin.settings.maxHour;
    this.minHour = this.normalizeHour(minHourValue || "");
    this.maxHour = this.normalizeHour(maxHourValue || "");

    this.showHiddenHoursToggle = this.plugin.settings.showHiddenHoursToggle !== false;

    // End date type
    const useEndDurationValue = this.config.get("useEndDuration");
    // Default to true if not specified (matching getViewOptions default)
    this.useEndDuration = useEndDurationValue === "false" || useEndDurationValue === false ? false : true;

    // View options

    // View options
    const showFullDayValue = this.config.get("showFullDay");
    this.showFullDay = showFullDayValue === "true" || showFullDayValue === true;

    // const showHiddenEventsValue = this.config.get("showHiddenEvents");
    // this.showHiddenEvents = showHiddenEventsValue === "true" || showHiddenEventsValue === true;

    const viewConfigMode = this.resolveViewConfigMode();
    const configuredViewMode: CalendarViewMode = viewConfigMode || this.getGlobalDefaultViewMode();

    // Restore persisted per-view state (viewMode + currentDate) from config.
    // These are saved whenever the user navigates so they persist across devices.
    const savedViewMode = this.resolveStoredViewMode();
    this.explicitViewModePinned =
      (viewConfigMode != null && viewConfigMode !== "filter-based")
      || (viewConfigMode == null && savedViewMode != null && savedViewMode !== "filter-based");
    // Auto-range should never override a concrete per-view mode like 7d/week/month.
    this.filterRangeAuto =
      viewConfigMode === "filter-based"
      || (this.plugin.settings.filterRangeAuto === true && !this.explicitViewModePinned);

    const savedCurrentDate = this.config.get("tps_currentDate") as string | undefined;

    if (savedCurrentDate) {
      const parsed = new Date(savedCurrentDate);
      if (!isNaN(parsed.getTime())) {
        this.currentDate = parsed;
      }
    }

    // Only use saved viewmode when NOT in filter-based mode
    // In filter-based mode, viewmode is always auto-calculated
    if (!this.filterRangeAuto) {
      // When auto-range is off, use saved per-view mode or fall back to global default
      this.viewMode = savedViewMode || configuredViewMode;
    } else if (!this.filterRangeStart && !this.filterRangeEnd && !this.navigationLockedByAutoRange) {
      // In filter-based mode with no range yet, default to week view until data is loaded
      this.viewMode = "week";
    }

    // Toggle Day Picker Action visibility
    if (this.dayPickerAction) {
      const allowedModes = ['day', '3d', '4d', '5d', '7d', 'week'];
      if (allowedModes.includes(this.viewMode)) {
        this.dayPickerAction.style.display = '';
      } else {
        this.dayPickerAction.style.display = 'none';
      }
    }

    this.navStep = this.parseNumberConfig(this.plugin.settings.navStep, 7);
    this.showNavButtons = this.plugin.settings.showNavButtons !== false;

    // All Day Limit
    this.allDayLimit = this.parseNumberConfig(this.config.get("allDayLimit"), 3);

    // Filter-based auto view mode switching and context date detection are global defaults.
    this.contextDateEnabled = this.plugin.settings.contextDateEnabled === true;


    // If context date detection is enabled, detect the date from parent note
    if (this.contextDateEnabled) {
      this.detectContextDate();
    }

    // Event creation (type-folder first, template support is legacy fallback)
    const tpsTemplatePath = (this.config.get("tpsTemplatePath") as string) || null;
    this.baseTemplatePath = tpsTemplatePath;
    const filterDefaults = this.getFilterCreationDefaults();
    this.newEventTemplate = null;
    this.newEventTemplateType = null;
    this.defaultFrontmatter = filterDefaults.frontmatter;

    this.allDayProperty =
      this.config.getAsPropertyId("allDayProperty") ??
      this.config.getAsPropertyId("allDay") ??
      ("note.allDay" as BasesPropertyId);

    // External calendar
    this.externalCalendarFilterTerms = this.parseFilterTerms(this.plugin.getExternalCalendarFilter());
    this.updateExternalCalendarVisibility();



    // Auto-create config is now managed by TPS-Controller.

    this.updateNewEventService();
  }

  private updateNewEventService(): void {
    // Convert properties for writing
    const convertToNoteProperty = (propId: BasesPropertyId | null): BasesPropertyId | null => {
      if (!propId) return null;
      const parsed = parsePropertyId(propId);

      // Convert formula properties to note properties
      if (parsed.type === 'formula') {
        const propertyName = parsed.name || (parsed as any).property;
        if (propertyName) {
          return `note.${propertyName}` as BasesPropertyId;
        }
      }

      return propId;
    };

    this.newEventService.updateConfig({
      app: this.app,
      startProperty: convertToNoteProperty(this.startDateProp),
      endProperty: convertToNoteProperty(this.endDateProp),
      allDayProperty: convertToNoteProperty(this.allDayProperty),
      folderPath: null,
      templatePath: this.newEventTemplate,
      templateType: this.newEventTemplateType,
      useEndDuration: this.useEndDuration,
      defaultDuration: this.defaultEventDuration,
      defaultTitle: "Untitled",
      additionalFrontmatter: Object.keys(this.defaultFrontmatter).length > 0 ? this.defaultFrontmatter : undefined,
      inProgressStatusValue: this.plugin.settings.inProgressStatusValue,
      parentLinkEnabled: this.plugin.settings.parentLinkEnabled,
      parentLinkKey: this.plugin.settings.parentLinkKey,
      childLinkKey: this.plugin.settings.childLinkKey,
    });
  }

  private getQueryData(): any {
    const controller = this.controller as any;
    return this.data ?? controller?.data ?? controller?.queryResult ?? controller?.result ?? null;
  }

  private scheduleDataRetry(): void {
    if (this.pendingDataRetryId !== null) return;
    if (this.pendingDataRetryCount >= this.pendingDataMaxRetries) return;
    this.pendingDataRetryId = window.setTimeout(() => {
      this.pendingDataRetryId = null;
      this.pendingDataRetryCount += 1;
      this.updateCalendar();
    }, 250);
  }

  public async updateCalendar(): Promise<void> {
    if (!this.shouldProcessUpdates()) {
      return;
    }

    // Ensure config is loaded if available (fixes issue where embedded views allow data update before config is ready)
    if (this.config && (!this.startDateProp || !this.endDateProp)) {
      this.loadConfig();
    }

    const recentlyTyping = this.lastEditorChangeAt && Date.now() - this.lastEditorChangeAt < this.typingQuietWindowMs;
    if (recentlyTyping && !this.isActiveLeaf()) {
      return;
    }

    const queryData = this.getQueryData();
    if (!queryData || !this.startDateProp) {
      this.root?.unmount();
      this.root = null;
      this.containerEl.empty();
      this.containerEl.createDiv("bases-calendar-empty").textContent =
        queryData
          ? "Configure a start date property to display entries"
          : "Loading calendar data...";
      if (!queryData) {
        this.scheduleDataRetry();
      }
      return;
    }

    this.pendingDataRetryCount = 0;
    this.updateExternalCalendarVisibility();
    // Task-item overlays should only surface when their parent note is part of
    // the current Bases result set. This keeps task-list calendar events aligned
    // with the active base filter while still allowing every matching parent note
    // to contribute all of its dated task items.
    const taskAllowedPaths = new Set<string>();
    for (const entry of queryData.data ?? []) {
      if (entry?.file?.path) taskAllowedPaths.add(entry.file.path);
    }
    this.taskItemAllowedPaths = taskAllowedPaths;

    // 0. Update Line Filter from View Config (Standard Filter Integration)
    // We look for filters that use our injected line properties


    const currentEntries: CalendarEntry[] = [];
    const unscheduledEntries: { file: TFile; title: string }[] = [];

    // Determine the time window we'll display/expand events for
    const baseDate = this.currentDate || new Date();
    const calendarStart = new Date(baseDate);
    calendarStart.setDate(calendarStart.getDate() - 30);
    const calendarEnd = new Date(baseDate);
    calendarEnd.setDate(calendarEnd.getDate() + 60);

    // Fetch external calendar events if configured
    // 1. Fetch external calendar events FIRST
    // We use cached events for immediate render, and trigger a background fetch if needed
    const visibleCalendars = new Set(this.visibleExternalCalendarUrls);
    const hiddenExternalEvents = this.getHiddenExternalEventKeySetForCurrentBase();
    const allExternalEvents: ExternalCalendarEvent[] = this.cachedExternalEvents.filter(
      (event) =>
        (!event.sourceUrl || visibleCalendars.has(event.sourceUrl)) &&
        !hiddenExternalEvents.has(this.getExternalEventHideKey(event)),
    );

    // Trigger background fetch (throttled to 1 minute to prevent infinite loops)
    const timeSinceLastFetch = Date.now() - this.lastExternalFetch;
    if (timeSinceLastFetch > 60000 && !recentlyTyping) {
      this.refreshExternalEvents(calendarStart, calendarEnd);
    }

    // 2. Process local entries
    const handledExternalEventIds = new Set<string>();
    const suppressedExternalEventIds = new Set<string>();
    const suppressedExternalUidStartByUid = new Map<string, number[]>();
    const statusFieldName = this.statusField
      ? this.getNoteField(this.statusField)
      : null;
    const allDayFieldName = this.getNoteField(this.allDayProperty);
    const eventIdFieldName = this.plugin.settings.eventIdKey;
    const uidFieldName = this.plugin.settings.uidKey;
    const startFieldNames = this.getStartDateNoteFields();
    const canceledStatusValue = (this.plugin.settings.canceledStatusValue || "").toLowerCase().trim();
    const archiveFolder = this.plugin.settings.archiveFolder
      ? normalizePath(this.plugin.settings.archiveFolder.trim())
      : "";
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm) continue;
      const filePath = normalizePath(file.path);
      const isArchived = archiveFolder ? filePath.startsWith(`${archiveFolder}/`) : false;

      let isCanceled = false;
      if (statusFieldName) {
        const statusValue = this.getFrontmatterValueCaseInsensitive(fm, statusFieldName);
        if (statusValue) {
          const status = String(statusValue).toLowerCase().trim();
          if (canceledStatusValue) {
            isCanceled = status === canceledStatusValue;
          } else {
            isCanceled = status === "wont-do" || status === "wont do";
          }
        }
      }

      // if (!isArchived && !isCanceled) continue; // REMOVED per user request to hide external events if ANY local note exists

      // Check for Event ID (New or Legacy)
      const eventId = this.getFrontmatterStringCaseInsensitive(fm, eventIdFieldName) || "";
      const uid = this.getFrontmatterStringCaseInsensitive(fm, uidFieldName);
      let startValue: unknown = undefined;
      for (const startFieldName of startFieldNames) {
        startValue = this.getFrontmatterValueCaseInsensitive(fm, startFieldName);
        if (startValue !== undefined && startValue !== null && String(startValue).trim().length > 0) {
          break;
        }
      }

      if (!eventId && !uid) continue;

      // Only suppress the specific event ID, NOT the base UID
      // For recurring events, the ID is in format "uid-timestamp"
      // Suppressing the base UID would hide ALL occurrences, not just this one
      if (eventId) {
        suppressedExternalEventIds.add(eventId);
      }
      const normalizedUid = this.normalizeIdentityValue(uid || this.extractUidFromCompositeEventId(eventId));
      const noteStartDate =
        this.parseFrontmatterDateValue(startValue) ??
        this.extractRecurrenceDateFromEventId(eventId);
      this.recordSuppressedUidStart(suppressedExternalUidStartByUid, normalizedUid, noteStartDate);
    }

    // logger.log(`[CalendarView] Processing ${queryData.data.length} local entries against ${allExternalEvents.length} external events`);

    for (const entry of queryData.data) {
      const entryFile = entry.file;
      const startResolution = this.resolveEntryStartDate(entry);
      if (startResolution) {
        let startDate = startResolution.date;
        const forceAllDayFromSource = startResolution.isDateOnly;
        // Read status and priority directly from cache for freshness
        let statusValue: any = null;
        let priorityValue: any = null;

        if (this.statusField) {
          // If it's a note property, read from cache
          const fieldName = this.getNoteField(this.statusField);
          if (fieldName && entryFile) {
            const cache = this.app.metadataCache.getFileCache(entryFile);
            statusValue = this.getFrontmatterValueCaseInsensitive(cache?.frontmatter as Record<string, any> | undefined, fieldName);
            if (statusValue) {
              // console.log(`[CalendarView] Status update for ${entryFile.path}: field=${fieldName}, value=${statusValue}`);
            }
          } else {
            statusValue = this.tryGetValue(entry, this.statusField);
          }
        }

        if (this.priorityField) {
          const fieldName = this.getNoteField(this.priorityField);
          if (fieldName && entryFile) {
            const cache = this.app.metadataCache.getFileCache(entryFile);
            priorityValue = cache?.frontmatter?.[fieldName];
          } else {
            priorityValue = this.tryGetValue(entry, this.priorityField);
          }
        }

        let baseTitle = this.titleProp
          ? (valueToString(entry.getValue(this.titleProp)) as string | undefined)
          : undefined;

        // [Fix] If no title property is explicitly set, check if this is a task/list item with "text".
        // This prevents falling back to the filename (e.g. "2025-12-29") for timeblocks.
        if (!baseTitle) {
          // DEBUG: Inspect entry keys/values
          // console.log(`[CalendarView Debug] Checking entry for ${entryFile?.path}`);

          const textVal = entry.getValue("text" as BasesPropertyId);
          // console.log(`[CalendarView Debug] entry.getValue("text") result:`, textVal);

          // Try other common task properties
          const contentVal = entry.getValue("content" as BasesPropertyId);
          const nameVal = entry.getValue("name" as BasesPropertyId);
          const taskVal = entry.getValue("task" as BasesPropertyId); // Sometimes 'task' is the text

          // console.log(`[CalendarView Debug] Alternatives: content=${contentVal}, name=${nameVal}, task=${taskVal}`);

          if (textVal) {
            const str = valueToString(textVal);
            if (str) baseTitle = str;
          } else if (contentVal) {
            const str = valueToString(contentVal);
            if (str) baseTitle = str;
          } else if (nameVal) {
            const str = valueToString(nameVal);
            if (str) baseTitle = str;
          } else if (taskVal) {
            const str = valueToString(taskVal);
            if (str) baseTitle = str;
          }
        }

        const cache = entryFile ? this.app.metadataCache.getFileCache(entryFile) : null;
        const frontmatterAllDay = allDayFieldName
          ? this.parseBooleanLike(
            this.getFrontmatterValueCaseInsensitive(cache?.frontmatter as Record<string, any> | undefined, allDayFieldName),
            false,
          )
          : false;
        const frontmatterTitle = this.getFrontmatterStringCaseInsensitive(
          cache?.frontmatter as Record<string, any> | undefined,
          "title",
        ) || undefined;
        const isArchived = entryFile && archiveFolder
          ? normalizePath(entryFile.path).startsWith(`${archiveFolder}/`)
          : false;

        const eventIdForMatch = this.getFrontmatterStringCaseInsensitive(
          cache?.frontmatter as Record<string, any> | undefined,
          eventIdFieldName,
        ) || undefined;
        const uidForMatch = this.normalizeIdentityValue(
          this.getFrontmatterStringCaseInsensitive(
            cache?.frontmatter as Record<string, any> | undefined,
            uidFieldName,
          ) || this.extractUidFromCompositeEventId(eventIdForMatch),
        ) || undefined;

        let externalMatch: ExternalCalendarEvent | undefined;

        if (eventIdForMatch) {
          // logger.log(`[CalendarView] Local note "${entryFile?.path}" has eventId: ${eventIdForMatch}`);

          // Try exact match
          externalMatch = allExternalEvents.find(e => e.id === eventIdForMatch);

          // Try fuzzy match if no exact match (Stable UID logic)
          if (!externalMatch) {
            // Logic: if ID has a timestamp suffix (e.g. UID-123456), use that timestamp.
            // If ID is just UID (single instance), then we compare UID only.

            const noteUid = eventIdForMatch.includes('-') ? eventIdForMatch.split('-')[0] : eventIdForMatch;
            const noteSuffix = eventIdForMatch.includes('-') ? eventIdForMatch.substring(eventIdForMatch.lastIndexOf('-') + 1) : null;
            const noteSuffixTs = noteSuffix ? parseInt(noteSuffix) : NaN;

            // Iterate through external events
            for (const extEvent of allExternalEvents) {
              // Check UID first
              if (extEvent.uid !== noteUid) continue;

              // 1. Single Event Match (Both are master)
              if (!noteSuffix && !extEvent.id.includes('-')) {
                externalMatch = extEvent;
                break;
              }

              // 2. Recurring Instance Match (Both have suffixes)
              if (noteSuffix && extEvent.id.includes('-')) {
                const extSuffix = extEvent.id.substring(extEvent.id.lastIndexOf('-') + 1);
                const extTs = parseInt(extSuffix);

                if (!isNaN(noteSuffixTs) && !isNaN(extTs)) {
                  // Check if they represent the same slot (with 65m drift tolerance for TZ)
                  if (Math.abs(noteSuffixTs - extTs) < 65 * 60 * 1000) {
                    externalMatch = extEvent;
                    break;
                  }

                  // Fallback: Component match
                  const d1 = new Date(noteSuffixTs);
                  const d2 = new Date(extTs);
                  if (
                    d1.getUTCHours() === d2.getUTCHours() &&
                    d1.getUTCMinutes() === d2.getUTCMinutes() &&
                    d1.getUTCDate() === d2.getUTCDate()
                  ) {
                    externalMatch = extEvent;
                    break;
                  }
                }
              }
            }
          }
        }

        if (!externalMatch && uidForMatch) {
          for (const extEvent of allExternalEvents) {
            if (handledExternalEventIds.has(extEvent.id)) continue;
            const extUid = this.normalizeIdentityValue(extEvent.uid || this.extractUidFromCompositeEventId(extEvent.id));
            if (extUid !== uidForMatch) continue;
            if (this.areDatesLikelySameSlot(startDate, extEvent.startDate)) {
              externalMatch = extEvent;
              break;
            }
          }
        }

        if (!externalMatch) {
          // No event ID/UID match, try fuzzy match by Title + Start Time.
          // This handles cases where the user created a note manually for an event but didn't link identity keys.
          for (const extEvent of allExternalEvents) {
            if (handledExternalEventIds.has(extEvent.id)) continue;

            // Match Title (case insensitive, trimmed)
            const titleMatch = (baseTitle || "").trim().toLowerCase() === extEvent.title.trim().toLowerCase();

            // Match Start Time (within 1 minute tolerance)
            const timeDiff = Math.abs(startDate.getTime() - extEvent.startDate.getTime());
            const timeMatch = timeDiff < 60000; // 1 minute

            if (titleMatch && timeMatch) {
              externalMatch = extEvent;
              break;
            }
          }
        }

        if (externalMatch) {
          // logger.log(`[CalendarView] Matched local note "${entryFile?.path}" to external event ${externalMatch.id} (${externalMatch.title})`);

          // We found a match, so this local note REPLACES the external event in the view.
          // We do NOT force sync the note to the external event's time here.
          // The local note is the source of truth for the user's intent.

          const isCanceled = statusValue
            ? (canceledStatusValue
              ? String(statusValue).toLowerCase().trim() === canceledStatusValue
              : ["wont-do", "wont do"].includes(String(statusValue).toLowerCase().trim()))
            : false;

          if (isArchived || isCanceled) {
            // Only suppress the specific event ID, NOT the UID
            // For recurring events, suppressing UID would hide ALL occurrences
            suppressedExternalEventIds.add(externalMatch.id);
          }
        }


        // Check filters only if they are configured
        const hasFilters = this.config.get("filters") || (this.config as any).viewFilters || (this.config as any).filtersAll;
        if (hasFilters && !this.passesNameFilters([
          baseTitle,
          frontmatterTitle,
          entryFile?.basename,
          entryFile?.path,
        ])) {
          continue;
        }
        let endDate: Date | undefined;
        let hasExplicitEnd = false;

        if (this.endDateProp) {
          if (this.useEndDuration) {
            // Duration mode: compute end from start + duration (in minutes)
            const durationMinutes = extractDuration(entry, this.endDateProp);
            if (durationMinutes !== null && durationMinutes > 0) {
              endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
              hasExplicitEnd = true;
            }
          } else {
            // End datetime mode: extract end date directly
            endDate = extractDate(entry, this.endDateProp, this.getDailyNoteDateFormat()) ?? undefined;
            hasExplicitEnd = !!endDate;
          }
        }

        const configuredDurationMinutes = this.getSourceDurationMinutes(startResolution.slot);
        if (configuredDurationMinutes !== null) {
          endDate = new Date(startDate.getTime() + configuredDurationMinutes * 60 * 1000);
        } else if (!endDate) {
          // If no per-source duration is set, force a minimum event span.
          const minDurationMinutes = this.getMinimumEventDurationMinutes();
          endDate = new Date(startDate.getTime() + minDurationMinutes * 60 * 1000);
        }
        const startsAtMidnight =
          startDate.getHours() === 0 &&
          startDate.getMinutes() === 0 &&
          startDate.getSeconds() === 0 &&
          startDate.getMilliseconds() === 0;
        const forceAllDay =
          frontmatterAllDay ||
          forceAllDayFromSource ||
          (!hasExplicitEnd && configuredDurationMinutes === null && startsAtMidnight);



        // PENDING UPDATE CHECK (User action overrides iCal sync temporarily)
        const pending = this.pendingUpdates.get(entryFile.path);
        if (pending) {
          const dataStart = startDate?.getTime();
          // If data matches pending (within 1s tolerance), clear pending
          if (dataStart && Math.abs(dataStart - pending.start.getTime()) < 1000) {
            this.pendingUpdates.delete(entryFile.path);
          } else if (Date.now() - pending.timestamp > 5000) {
            // Expired
            this.pendingUpdates.delete(entryFile.path);
          } else {
            // Override with pending
            startDate = pending.start;
            endDate = pending.end;
          }
        }

        let title = baseTitle || frontmatterTitle || entryFile.basename;
        if (title) {
          const { cleanTitle } = this.parseFilenameComponents(title);
          if (cleanTitle) {
            title = cleanTitle;
          }
        }

        // Resolve styles
        const statusStr = statusValue ? String(statusValue) : undefined;
        const priorityStr = priorityValue ? String(priorityValue) : undefined;

        const cssClasses = ["bases-calendar-event"];
        // Do NOT add is-external class to local notes, even if they match an external event.
        // We want them to look like local notes (gradient, priority color).

        if (statusStr) {
          cssClasses.push(`bases-calendar-event-status-${statusStr}`);
        }

        const colorSource = this.plugin.settings.noteEventColorSource || "frontmatter";
        const iconSource = this.plugin.settings.noteEventIconSource || "frontmatter";
        const colorTarget = this.plugin.settings.noteEventFrontmatterColorTarget || "both";
        const applyFrontmatterColor = colorSource === "frontmatter" && colorTarget !== "off";
        const applyFrontmatterColorToCard =
          applyFrontmatterColor && (colorTarget === "card" || colorTarget === "both");
        const applyFrontmatterColorToIcon =
          applyFrontmatterColor && (colorTarget === "icon" || colorTarget === "both");
        let backgroundColor = "";
        let borderColor = "";
        const frontmatterColor = this.resolveFrontmatterEventColor(cache?.frontmatter as Record<string, any> | undefined);
        if (colorSource !== "off" && applyFrontmatterColorToCard && frontmatterColor) {
          backgroundColor = frontmatterColor;
          borderColor = frontmatterColor;
        }

        if (externalMatch) {
          handledExternalEventIds.add(externalMatch.id);
        }

        currentEntries.push({
          entry,
          startDate,
          endDate,
          title,
          forceAllDay,
          isExternal: false, // Local notes are never external, even if synced.
          externalEvent: externalMatch ? {
            ...externalMatch,
            startDate,
            endDate: endDate || startDate
          } : (eventIdForMatch ? {
            id: eventIdForMatch,
            uid: eventIdForMatch.split('-')[0] || eventIdForMatch,
            title: title || "",
            description: "",
            startDate,
            endDate: endDate || startDate,
            isAllDay: false,
            sourceUrl: ""
          } : undefined),
          status: statusStr,
          priority: priorityStr,
          cssClasses,
          backgroundColor,
          borderColor,
          iconName: iconSource === "frontmatter"
            ? (this.resolveFrontmatterEventIcon(cache?.frontmatter as Record<string, any> | undefined) || undefined)
            : undefined,
          iconColor: iconSource === "frontmatter" && applyFrontmatterColorToIcon
            ? this.resolveFrontmatterEventIconColor(cache?.frontmatter as Record<string, any> | undefined, "")
            : undefined,
        });

        // Note: Time logs are now stored in daily notes, not source notes.
        // Source notes only contain daily note links like [[2025-12-10]].
        // Time log entries are read from daily notes in the separate scan below.
      } else if (entryFile) {
        // Apply the same archive + name filter as scheduled entries
        const uIsArchived = archiveFolder
          ? normalizePath(entryFile.path).startsWith(`${archiveFolder}/`)
          : false;
        if (!uIsArchived) {
          const uCache = this.app.metadataCache.getFileCache(entryFile);
          const uFrontmatterTitle = this.getFrontmatterStringCaseInsensitive(
            uCache?.frontmatter as Record<string, any> | undefined, "title",
          ) || undefined;
          const uHasFilters = this.config.get("filters") || (this.config as any).viewFilters || (this.config as any).filtersAll;
          if (!uHasFilters || this.passesNameFilters([uFrontmatterTitle, entryFile.basename, entryFile.path])) {
            unscheduledEntries.push({ file: entryFile, title: uFrontmatterTitle || entryFile.basename });
          }
        }
      }
    }


    if (this.plugin.settings.showTaskItems) {
      for (const task of this.cachedRawTaskItems) {
        const taskEventId = this.normalizeIdentityValue(task.externalEventId);
        if (taskEventId) {
          handledExternalEventIds.add(taskEventId);
          continue;
        }

        const taskUid = this.normalizeIdentityValue(
          task.calendarUid || this.extractUidFromCompositeEventId(task.externalEventId || undefined),
        );
        if (!taskUid || !task.scheduledDate) continue;
        this.recordSuppressedUidStart(suppressedExternalUidStartByUid, taskUid, task.scheduledDate);
      }
    }

    // 3. Add remaining external events (those NOT matched to local notes or task-list items)
    // logger.log(`[CalendarView] Adding unmatched external events. Handled: ${handledExternalEventIds.size}, Total: ${allExternalEvents.length}`);

    for (const extEvent of allExternalEvents) {
      // CRITICAL: Skip if this event was matched to a local note
      if (handledExternalEventIds.has(extEvent.id)) {
        // logger.log(`[CalendarView] Skipping external event ${extEvent.id} (${extEvent.title}) - matched to local note`);
        continue;
      }

      const isSuppressed =
        suppressedExternalEventIds.has(extEvent.id) ||
        this.isExternalEventSuppressedByUidStart(extEvent, suppressedExternalUidStartByUid);
      if (isSuppressed) {
        continue;
      }

      const lowerTitle = (extEvent.title || "").toLowerCase();
      if (this.externalCalendarFilterTerms.some((term) => term && lowerTitle.includes(term))) {
        continue;
      }

      const fakeEntry = this.createExternalEntry(extEvent);

      if (!this.passesNameFilters([
        extEvent.title,
        fakeEntry.file.path,
        fakeEntry.file.basename,
      ])) {
        continue;
      }

      currentEntries.push({
        entry: fakeEntry,
        startDate: extEvent.startDate,
        endDate: extEvent.endDate,
        title: extEvent.title,
        isExternal: true,
        externalEvent: extEvent,
        color: this.plugin.getCalendarColor(extEvent.sourceUrl || ""),
        cssClasses: ["bases-calendar-event", "is-external"],
      });
    }

    // NOTE: Embed sync is now triggered by file-modify events, not calendar refresh
    // This prevents constant updates every few seconds

    // RECURRING GHOST INSTANCES: For each recurring note in the current results,
    // expand its RRULE forward and inject ghost entries for future occurrences that
    // don't yet have a real file counterpart.
    const baseEntries = [...currentEntries];
    for (const calEntry of baseEntries) {
      if (calEntry.isGhost || calEntry.isExternal) continue;
      const entryFile = (calEntry.entry as any).file as TFile | undefined;
      if (!entryFile) continue;

      const entryCache = this.app.metadataCache.getFileCache(entryFile);
      const entryFm = entryCache?.frontmatter;
      if (!entryFm) continue;

      const recurrenceRule = entryFm.recurrenceRule || entryFm.recurrence;
      if (!recurrenceRule || typeof recurrenceRule !== 'string') continue;

      // Never expand template files
      if (entryFm.isRecurrenceTemplate) continue;

      try {
        const opts = RRule.parseString(recurrenceRule);
        opts.dtstart = calEntry.startDate;
        const rule = new RRule(opts);
        const occurrences = rule.between(calEntry.startDate, calendarEnd, false /* exclusive start */);

        const { cleanTitle: baseName } = this.parseFilenameComponents(entryFile.basename);
        const duration = calEntry.endDate
          ? calEntry.endDate.getTime() - calEntry.startDate.getTime()
          : 60 * 60 * 1000;

        for (const occDate of occurrences) {
          // Don't show ghosts in the past
          if (occDate <= new Date()) continue;

          // Build the expected path for a real instance at this date
          const dateStr = `${occDate.getFullYear()}-${String(occDate.getMonth() + 1).padStart(2, '0')}-${String(occDate.getDate()).padStart(2, '0')}`;
          const expectedName = `${(baseName || entryFile.basename)} ${dateStr}.md`;
          const expectedPath = entryFile.parent
            ? normalizePath(`${entryFile.parent.path}/${expectedName}`)
            : normalizePath(expectedName);

          // Skip if a real file already exists at that date
          if (this.app.vault.getAbstractFileByPath(expectedPath)) continue;

          const ghostEnd = new Date(occDate.getTime() + duration);
          currentEntries.push({
            entry: calEntry.entry,
            startDate: occDate,
            endDate: ghostEnd,
            title: calEntry.title,
            isGhost: true,
            ghostDate: occDate,
            isExternal: false,
            status: calEntry.status,
            priority: calEntry.priority,
            cssClasses: [...(calEntry.cssClasses || []), 'is-recurring-instance'],
            backgroundColor: calEntry.backgroundColor || 'rgba(100, 100, 100, 0.3)',
            borderColor: calEntry.borderColor || 'rgba(100, 100, 100, 0.5)',
          });
        }
      } catch (_err) {
        // Silently ignore unparseable RRULE strings
      }
    }

    // 4. Task items (if enabled)
    if (this.plugin.settings.showTaskItems) {
      currentEntries.push(...this.buildTaskItemEntries());
      const timeSinceLastFetch = Date.now() - this.lastTaskItemsFetch;
      if (timeSinceLastFetch > 60000 && !recentlyTyping && !this.isFetchingTaskItems) {
        this.refreshTaskItems();
      }
    }

    // console.log(`[CalendarView] Render update with ${currentEntries.length} events`);

    // DEDUPLICATION STEP: Ensure unique IDs without collapsing valid multi-slot entries.
    const uniqueEntries = new Map<string, CalendarEntry>();
    for (const entry of currentEntries) {
      const startTs = Number.isFinite(entry.startDate?.getTime?.())
        ? entry.startDate.getTime()
        : -1;
      const endTs = Number.isFinite(entry.endDate?.getTime?.())
        ? entry.endDate!.getTime()
        : -1;

      // Keep kind-specific identity stable while allowing multiple rows per file/event across time ranges.
      const id = entry.isGhost
        ? `ghost:${(entry.entry as any).path || "unknown"}:${startTs}:${endTs}`
        : entry.isTask
          ? `task:${(entry.entry as any).file?.path || "unknown"}:${startTs}:${(entry.title || "").slice(0, 40)}`
          : entry.isExternal
          ? `external:${entry.externalEvent?.id || entry.title || "unknown"}:${startTs}:${endTs}`
          : `local:${(entry.entry as any).file?.path || entry.title || "unknown"}:${startTs}:${endTs}`;

      if (!uniqueEntries.has(id)) {
        uniqueEntries.set(id, entry);
      }
    }

    const finalEntries = Array.from(uniqueEntries.values());

    if (finalEntries.length > 0) {
      const first = finalEntries[0];
      // console.log(`[CalendarView] First event: ${first.title} at ${first.startDate} (ghost: ${first.isGhost})`);
    }
    logger.log("[CalendarView] Final local entries summary", finalEntries.slice(0, 5).map((entry) => ({
      path: (entry.entry as any)?.file?.path || "",
      title: entry.title || "",
      start: entry.startDate?.toISOString?.() || String(entry.startDate),
      end: entry.endDate?.toISOString?.() || "",
      forceAllDay: (entry as any).forceAllDay === true,
      isExternal: !!entry.isExternal,
      isTask: !!entry.isTask,
    })));
    this.entries = finalEntries;
    this.unscheduledEntries = unscheduledEntries;

    // Always compute filter bounds so explicit date filters can limit navigation.
    // Auto-derived mode changes are applied inside computeFilterDateRange only when
    // filterRangeAuto is enabled.
    this.computeFilterDateRange(this.getEffectiveFilterRangeEntries(finalEntries));

    this.renderReactCalendar();
    this.updateBasesHeaderOffset(); // Ensure layout is correct
    window.setTimeout(() => this.updateBasesHeaderOffset(), 120);
  }

  /**
   * Returns local, non-virtual entries used as fallback when filter bounds are not explicit.
   */
  private getEffectiveFilterRangeEntries(entries: CalendarEntry[]): CalendarEntry[] {
    return entries.filter((entry) => !entry.isExternal && !entry.isGhost);
  }

  private getCalendarFilterSources(extraSources: unknown[] = []): unknown[] {
    const controllerAny = this.controller as any;
    const sources = [
      this.config.get?.("filters"),
      this.config.get?.("filter"),
      this.config.get?.("query"),
      (this.config as any).filtersAll,
      (this.config as any).filters?.all,
      this.config.get?.("filtersAll"),
      (this.config as any).viewFilters,
      (this.config as any).filters,
      controllerAny?.filters,
      controllerAny?.viewFilters,
      controllerAny?.query,
      ...extraSources,
    ];
    return sources.filter((value, index, arr) => value != null && arr.indexOf(value) === index);
  }

  private getFilterRangeBoundsFromConfig(): { start: Date | null; end: Date | null; hasDateFilter: boolean } {
    const filterSources = this.getCalendarFilterSources();
    const contextFile = this.getFilterExpressionContextFile();

    const propertyAliases = this.getStartDatePropertyAliases();
    let lowerBound: Date | null = null;
    let upperBound: Date | null = null;
    let hasDateFilter = false;

    for (const source of filterSources) {
      let conditions: Array<{ property: string; operator: string; value: unknown }> = [];
      try {
        conditions = this.collectFilterConditions(source);
      } catch (error) {
        logger.warn("[CalendarView] Failed to parse filter source for auto-range:", error);
        continue;
      }
      for (const condition of conditions) {
        if (!this.matchesStartDateFilterProperty(condition.property, propertyAliases)) {
          continue;
        }

        // Any condition referencing the start date property means a date filter exists
        hasDateFilter = true;

        const boundaryDate = this.resolveFilterDateExpressionWithContext(condition.value, contextFile);
        if (!boundaryDate) continue;

        if (isLowerBoundOperator(condition.operator)) {
          if (!lowerBound || boundaryDate.getTime() > lowerBound.getTime()) {
            lowerBound = boundaryDate;
          }
        } else if (isUpperBoundOperator(condition.operator)) {
          if (!upperBound || boundaryDate.getTime() < upperBound.getTime()) {
            upperBound = boundaryDate;
          }
        }
      }
    }

    return { start: lowerBound, end: upperBound, hasDateFilter };
  }

  private getFilterExpressionContextFile(): TFile | null {
    const leafFile = this.resolveContainerLeafFile();
    if (leafFile && leafFile.extension.toLowerCase() === "md") {
      return leafFile;
    }
    const parentPath = this.findParentNotePath();
    if (parentPath) {
      const parent = this.app.vault.getFileByPath(parentPath);
      if (parent && parent.extension.toLowerCase() === "md") return parent;
    }
    return leafFile && leafFile.extension.toLowerCase() === "md" ? leafFile : null;
  }

  private getFilterExpressionContextCandidates(primary: TFile | null): TFile[] {
    const candidates: TFile[] = [];
    const push = (file: TFile | null | undefined) => {
      if (!(file instanceof TFile)) return;
      if (file.extension.toLowerCase() === "base") return;
      if (candidates.some((candidate) => candidate.path === file.path)) return;
      candidates.push(file);
    };

    push(primary);
    const parentPath = this.findParentNotePath();
    push(parentPath ? this.app.vault.getFileByPath(parentPath) : null);
    const active = this.app.workspace.getActiveFile();
    push(active instanceof TFile ? active : null);

    return candidates;
  }

  private resolveFilterDateExpressionWithContext(value: unknown, contextFile: TFile | null): Date | null {
    const direct = resolveFilterDateExpression(value);
    if (direct) return direct;
    if (value === null || value === undefined) return null;

    const raw = String(value).trim();
    if (!raw) return null;
    if (!/this\.file\./i.test(raw)) return null;
    const contextCandidates = this.getFilterExpressionContextCandidates(contextFile);
    if (contextCandidates.length === 0) return null;
    const primaryContext = contextCandidates[0];

    const getFmValue = (key: string): string => {
      const normalized = String(key || "").trim().toLowerCase();
      if (!normalized) return "";
      for (const file of contextCandidates) {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
        const actual = Object.keys(fm).find((candidate) => candidate.toLowerCase() === normalized);
        if (!actual) continue;
        const val = fm[actual];
        if (val == null) continue;
        const asString = String(val);
        if (asString.trim().length > 0) return asString;
      }
      return "";
    };

    const quote = (input: string): string => `"${String(input || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

    let expanded = raw;
    expanded = expanded.replace(/\bthis\.file\.name\b/gi, quote(primaryContext.basename));
    expanded = expanded.replace(/\bthis\.file\.path\b/gi, quote(primaryContext.path));
    expanded = expanded.replace(/\bthis\.file\.basename\b/gi, quote(primaryContext.basename));
    expanded = expanded.replace(/\bthis\.file\.properties\.([A-Za-z0-9_-]+)\b/gi, (_m, key) => quote(getFmValue(String(key))));
    expanded = expanded.replace(/\bthis\.file\.property\.([A-Za-z0-9_-]+)\b/gi, (_m, key) => quote(getFmValue(String(key))));

    return resolveFilterDateExpression(expanded);
  }

  private getStartDatePropertyAliases(): Set<string> {
    const aliases = new Set<string>();

    const addAlias = (value: string | null | undefined) => {
      if (!value) return;
      const normalized = value.trim().toLowerCase();
      if (!normalized) return;
      aliases.add(normalized);
    };

    for (const propId of this.getStartDatePropsInPriorityOrder()) {
      const startField = this.getNoteField(propId);
      addAlias(startField);
      if (startField) {
        addAlias(`note.${startField}`);
      }

      if (typeof propId === "string") {
        addAlias(propId);
        const parsed = parsePropertyId(propId as BasesPropertyId);
        const parsedName = parsed.name || (parsed as any).property;
        addAlias(parsedName || null);
        if (parsedName) {
          addAlias(`note.${parsedName}`);
        }
      }
    }

    if (aliases.size === 0) {
      addAlias("scheduled");
      addAlias("note.scheduled");
      addAlias("start");
      addAlias("startdate");
    }

    return aliases;
  }


  private matchesStartDateFilterProperty(property: string, aliases: Set<string>): boolean {
    const normalized = String(property || "").trim().toLowerCase();
    if (!normalized) return false;
    if (aliases.has(normalized)) return true;
    if (normalized.startsWith("note.") && aliases.has(normalized.slice(5))) return true;
    if (!normalized.startsWith("note.") && aliases.has(`note.${normalized}`)) return true;
    return false;
  }

  /**
   * Computes the date range from explicit date filters when available,
   * otherwise from visible local (non-external, non-virtual) entries.
   * If entries span 7 days or less → day-range views (1d/3d/4d/5d/7d)
   * If entries span more than 7 days → month view
   * Also sets currentDate to the start of the range so filtered events are visible.
   */
  private computeFilterDateRange(entries: CalendarEntry[]): void {
    let entryMinDate: Date | null = null;
    let entryMaxDate: Date | null = null;

    for (const entry of entries) {
      const startDate = entry.startDate;
      const endDate = entry.endDate || startDate;

      if (!entryMinDate || startDate < entryMinDate) {
        entryMinDate = new Date(startDate);
      }
      if (!entryMaxDate || endDate > entryMaxDate) {
        entryMaxDate = new Date(endDate);
      }
      // Also check start date for max (in case end date is not set)
      if (!entryMaxDate || startDate > entryMaxDate) {
        entryMaxDate = new Date(startDate);
      }
    }

    // Save pure entry bounds before filter config override
    this.entryBoundsMin = entryMinDate ? new Date(entryMinDate) : null;
    this.entryBoundsMax = entryMaxDate ? new Date(entryMaxDate) : null;

    let minDate: Date | null = entryMinDate ? new Date(entryMinDate) : null;
    let maxDate: Date | null = entryMaxDate ? new Date(entryMaxDate) : null;

    const filterBounds = this.getFilterRangeBoundsFromConfig();
    // Lock navigation when any date filter condition exists (even if the value
    // is a dynamic expression like `date(this.file.name)` that can't be resolved).
    const hasExplicitBounds = filterBounds.hasDateFilter;
    this.navigationBoundsStart = filterBounds.start ? new Date(filterBounds.start) : null;
    this.navigationBoundsEnd = filterBounds.end ? new Date(filterBounds.end) : null;

    // When explicit date filters exist, they must define the auto-range window.
    // Do not widen from entry-derived min/max (which may include far-future items).
    if (hasExplicitBounds) {
      minDate = filterBounds.start ? new Date(filterBounds.start) : null;
      maxDate = filterBounds.end ? new Date(filterBounds.end) : null;
    }

    if (filterBounds.start) {
      minDate = new Date(filterBounds.start);
    }
    if (filterBounds.end) {
      maxDate = new Date(filterBounds.end);
    }

    if (!minDate && maxDate) {
      minDate = new Date(maxDate);
    }
    if (!maxDate && minDate) {
      maxDate = new Date(minDate);
    }

    // Explicit date filter exists but couldn't resolve either bound:
    // constrain to today's day instead of falling back to all entry dates.
    if (hasExplicitBounds && !minDate && !maxDate) {
      const anchor = this.currentDate ? new Date(this.currentDate) : new Date();
      anchor.setHours(0, 0, 0, 0);
      minDate = new Date(anchor);
      maxDate = new Date(anchor);
      this.navigationBoundsStart = new Date(anchor);
      this.navigationBoundsEnd = new Date(anchor);
    }

    if (minDate && maxDate && minDate.getTime() > maxDate.getTime()) {
      maxDate = new Date(minDate);
    }

    // No dates at all (no filter bounds AND no entries with dates):
    // default to today, allow navigation
    if (!minDate || !maxDate) {
      this.filterRangeStart = null;
      this.filterRangeEnd = null;
      this.navigationBoundsStart = null;
      this.navigationBoundsEnd = null;
      this.entryBoundsMin = null;
      this.entryBoundsMax = null;
      this.filterRangeDays = 0;
      this.navigationLockedByAutoRange = false;
      // Only reset to today on first load, not on subsequent refreshes
      if (!this.autoRangeInitialized) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        this.currentDate = today;
        // In filter-based mode, data/filters can arrive after initial render.
        // Keep initialization open so the next pass can still auto-select
        // day/3d/4d/5d/7d/month from the resolved range instead of staying on
        // the temporary week placeholder.
        if (!this.filterRangeAuto) {
          this.autoRangeInitialized = true;
        }
      }
      this.lastAutoRangeKey = null;
      return;
    }

    this.filterRangeStart = minDate;
    this.filterRangeEnd = maxDate;

    // Calculate number of days (inclusive)
    const startOfMinDay = new Date(minDate);
    startOfMinDay.setHours(0, 0, 0, 0);
    const startOfMaxDay = new Date(maxDate);
    startOfMaxDay.setHours(0, 0, 0, 0);

    const diffMs = startOfMaxDay.getTime() - startOfMinDay.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1; // +1 for inclusive
    this.filterRangeDays = diffDays;

    const filterRangeKey = `${startOfMinDay.getTime()}-${startOfMaxDay.getTime()}-${diffDays}`;
    if (this.lastLoggedFilterRangeKey !== filterRangeKey) {
      logger.log(`[CalendarView] Filter range: ${diffDays} days (${minDate.toDateString()} to ${maxDate.toDateString()})`);
      this.lastLoggedFilterRangeKey = filterRangeKey;
    }

    // Explicit bounds should constrain navigation, not disable it outright.
    this.navigationLockedByAutoRange = false;

    const clampToNavigationBounds = (input: Date): Date => {
      const next = new Date(input);
      next.setHours(0, 0, 0, 0);
      if (this.navigationBoundsStart && next.getTime() < this.navigationBoundsStart.getTime()) {
        return new Date(this.navigationBoundsStart);
      }
      if (this.navigationBoundsEnd) {
        const upper = new Date(this.navigationBoundsEnd);
        upper.setHours(0, 0, 0, 0);
        if (next.getTime() > upper.getTime()) {
          return upper;
        }
      }
      return next;
    };

    if (hasExplicitBounds) {
      if (this.currentDate) {
        this.currentDate = clampToNavigationBounds(this.currentDate);
      } else {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        this.currentDate = clampToNavigationBounds(today);
      }
      if (this.currentDate) {
        this.persistCurrentDate(this.currentDate);
      }
    }

    // Build a key from the date range to detect significant changes.
    // Only auto-switch viewMode/currentDate on first load or when the range actually changes.
    const rangeKey = `${startOfMinDay.getTime()}-${startOfMaxDay.getTime()}`;
    const rangeChanged = this.lastAutoRangeKey !== rangeKey;
    this.lastAutoRangeKey = rangeKey;

    const deriveAutoViewMode = (days: number): CalendarViewMode => {
      if (days <= 1) return "day";
      if (days <= 3) return "3d";
      if (days <= 4) return "4d";
      if (days <= 5) return "5d";
      if (days <= 7) return "7d";
      return "month";
    };

    // In filter-based mode with explicit date bounds, always apply the derived mode.
    // This avoids stale "week" state when bounds resolve after initial context-date pass.
    if (this.filterRangeAuto && hasExplicitBounds) {
      const previousViewMode = this.viewMode;
      const nextViewMode = deriveAutoViewMode(diffDays);
      this.viewMode = nextViewMode;

      if (nextViewMode !== "month") {
        const targetDayCount = getAutoRangeViewDayCount(diffDays);
        const centerOffset = Math.max(0, Math.floor((targetDayCount - 1) / 2));
        this.currentDate = new Date(startOfMinDay);
        this.currentDate.setDate(this.currentDate.getDate() + centerOffset);
        this.currentDate.setHours(0, 0, 0, 0);
      } else {
        this.currentDate = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
      }

      if (previousViewMode !== this.viewMode) {
        logger.log(`[CalendarView] Auto-switched view mode: ${previousViewMode} → ${this.viewMode}`);
      }
      if (this.currentDate) {
        this.persistCurrentDate(this.currentDate);
      }
      this.autoRangeInitialized = true;
      if (this.dayPickerAction) {
        const allowedModes = ['day', '3d', '4d', '5d', '7d', 'week'];
        this.dayPickerAction.style.display = allowedModes.includes(this.viewMode) ? '' : 'none';
      }
      return;
    }

    // Only auto-override viewMode/currentDate when:
    //   (a) the range is explicitly locked by a filter (hasExplicitBounds), or
    //   (b) it's the very first load AND there is no saved user preference.
    // For data-derived (unlocked) ranges we must respect what the user last chose,
    // and default the visible date to *today* rather than the earliest entry date.
    if (this.filterRangeAuto && (!this.autoRangeInitialized || (rangeChanged && hasExplicitBounds))) {
      const previousViewMode = this.viewMode;

      if (!this.autoRangeInitialized) {
        // Data-derived range (not locked), first load only.
        // Use saved viewMode if the user already has a preference; otherwise auto-select.
        const savedViewMode = this.resolveStoredViewMode();
        const concreteSavedViewMode =
          savedViewMode && savedViewMode !== "filter-based" ? savedViewMode : undefined;
        if (!concreteSavedViewMode) {
          this.viewMode = deriveAutoViewMode(diffDays);
        }

        // Default visible date to today when there is no saved/restored date.
        // Never jump the user back to the oldest entry in a large dataset.
        if (!this.currentDate) {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          this.currentDate = today;
        }
      }

      if (previousViewMode !== this.viewMode) {
        logger.log(`[CalendarView] Auto-switched view mode: ${previousViewMode} → ${this.viewMode}`);
      }

      // Only persist viewmode when NOT in filter-based mode
      // In filter-based mode, viewmode is always auto-calculated on load
      if (!this.filterRangeAuto) {
        this.config.set("tps_viewMode", this.viewMode);
      }
      if (this.currentDate) {
        this.persistCurrentDate(this.currentDate);
      }

      this.autoRangeInitialized = true;
    }
    if (this.dayPickerAction) {
      const allowedModes = ['day', '3d', '4d', '5d', '7d', 'week'];
      this.dayPickerAction.style.display = allowedModes.includes(this.viewMode) ? '' : 'none';
    }
  }

  /**
   * Detects the date from the parent note when the calendar is embedded.
   * Looks for dates in the note's filename in common formats:
   * - YYYY-MM-DD (daily notes)
   * - Any variation of year-month-day
   * Falls back to today if no date is detected.
   */
  private detectContextDate(): void {
    this.contextDateDetected = null;

    // Try to find the parent note from the DOM hierarchy
    const parentNote = this.findParentNotePath();

    if (parentNote) {
      const detectedDate = this.extractContextDateFromFrontmatter(parentNote) ?? this.extractDateFromPath(parentNote);
      if (detectedDate) {
        this.contextDateDetected = detectedDate;
        const dateLogKey = `${parentNote}::${detectedDate.getFullYear()}-${detectedDate.getMonth()}-${detectedDate.getDate()}`;
        if (this.lastLoggedContextDateDetectedKey !== dateLogKey) {
          logger.log(`[CalendarView] Detected context date: ${detectedDate.toDateString()} from "${parentNote}"`);
          this.lastLoggedContextDateDetectedKey = dateLogKey;
        }

        // Only update currentDate if we actually detected a context date
        // This preserves user navigation when in standalone mode
        detectedDate.setHours(0, 0, 0, 0);
        this.currentDate = detectedDate;
        const viewStateKey = `${dateLogKey}::${this.viewMode}`;
        if (this.lastLoggedContextDateAppliedKey !== viewStateKey) {
          logger.log(`[CalendarView] Context date set to: ${detectedDate.toDateString()}, keeping existing viewMode: ${this.viewMode}`);
          this.lastLoggedContextDateAppliedKey = viewStateKey;
        }
        this.loggedMissingContextParent = false;
      }
    }
  }

  /**
   * Finds the parent note's path when the calendar is embedded.
   * Traverses the DOM to find the parent markdown view or embed container.
   */
  private findParentNotePath(): string | null {
    try {
      const isMarkdownPath = (path: string | null | undefined): path is string =>
        typeof path === "string" && path.trim().toLowerCase().endsWith(".md");

      // Method 1: Look for data-path on workspace leaf content (most reliable)
      const leafContent = this.containerEl.closest('.workspace-leaf-content');
      if (leafContent) {
        const dataPath = leafContent.getAttribute('data-path');
        if (isMarkdownPath(dataPath)) {
          if (this.lastLoggedContextParentPath !== dataPath) {
            logger.log(`[CalendarView] Found parent via data-path: ${dataPath}`);
            this.lastLoggedContextParentPath = dataPath;
          }
          this.loggedMissingContextParent = false;
          return dataPath;
        }
      }

      // Method 2: Find the workspace leaf and look up the view file.
      const leafFile = this.resolveContainerLeafFile();
      if (leafFile && leafFile.extension.toLowerCase() === "md") {
        if (this.lastLoggedContextParentPath !== leafFile.path) {
          logger.log(`[CalendarView] Found parent via leaf iteration: ${leafFile.path}`);
          this.lastLoggedContextParentPath = leafFile.path;
        }
        this.loggedMissingContextParent = false;
        return leafFile.path;
      }

      // Method 3: Check for markdown-embed container (for sync blocks)
      const embedEl = this.containerEl.closest('.markdown-embed, .internal-embed, .cm-embed-block, .sync-embed');
      if (embedEl) {
        // Walk up to find the parent markdown preview/source
        let parent = embedEl.parentElement;
        while (parent) {
          // Check for markdown-preview-view which has info about the source file
          if (parent.classList.contains('markdown-preview-view') ||
            parent.classList.contains('markdown-source-view') ||
            parent.classList.contains('view-content')) {
            // Try to get the file from the parent leaf
            const parentLeaf = parent.closest('.workspace-leaf-content');
            if (parentLeaf) {
              const dataPath = parentLeaf.getAttribute('data-path');
              if (isMarkdownPath(dataPath)) {
                if (this.lastLoggedContextParentPath !== dataPath) {
                  logger.log(`[CalendarView] Found parent via embed ancestor: ${dataPath}`);
                  this.lastLoggedContextParentPath = dataPath;
                }
                this.loggedMissingContextParent = false;
                return dataPath;
              }
            }
          }
          parent = parent.parentElement;
        }
      }

      // Method 4: controller API (not currently populated, kept for forward-compat)
      const ctrl = this.controller as any;
      const ctrlFilePath: string | undefined = ctrl.file?.path ?? ctrl.sourceFile?.path;
      if (isMarkdownPath(ctrlFilePath)) {
        if (this.lastLoggedContextParentPath !== ctrlFilePath) {
          logger.log(`[CalendarView] Found parent via controller: ${ctrlFilePath}`);
          this.lastLoggedContextParentPath = ctrlFilePath;
        }
        this.loggedMissingContextParent = false;
        return ctrlFilePath;
      }

      // Method 5: Check if we have a parent file path attribute anywhere in the hierarchy
      let el: HTMLElement | null = this.containerEl;
      while (el) {
        const filePath = el.getAttribute('data-path') ||
          el.getAttribute('data-file-path') ||
          el.getAttribute('data-source');
        if (filePath && filePath.endsWith('.md')) {
          if (this.lastLoggedContextParentPath !== filePath) {
            logger.log(`[CalendarView] Found parent via DOM attribute: ${filePath}`);
            this.lastLoggedContextParentPath = filePath;
          }
          this.loggedMissingContextParent = false;
          return filePath;
        }
        el = el.parentElement;
      }

      // Method 6: Last resort - check the hover-link for the containing note
      const hoverLink = this.containerEl.closest('[data-href]');
      if (hoverLink) {
        const href = hoverLink.getAttribute('data-href');
        if (isMarkdownPath(href)) {
          if (this.lastLoggedContextParentPath !== href) {
            logger.log(`[CalendarView] Found parent via hover-link: ${href}`);
            this.lastLoggedContextParentPath = href;
          }
          this.loggedMissingContextParent = false;
          return href;
        }
      }

      // Method 7: final fallback to active markdown file.
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile && activeFile.extension.toLowerCase() === "md") {
        if (this.lastLoggedContextParentPath !== activeFile.path) {
          logger.log(`[CalendarView] Found parent via active file fallback: ${activeFile.path}`);
          this.lastLoggedContextParentPath = activeFile.path;
        }
        this.loggedMissingContextParent = false;
        return activeFile.path;
      }

      // Final fallback: parent is unknown, use today's date.
      this.lastLoggedContextParentPath = null;
      this.lastLoggedContextDateDetectedKey = null;
      this.lastLoggedContextDateAppliedKey = null;
      if (!this.loggedMissingContextParent) {
        logger.log(`[CalendarView] Could not determine parent note, using today's date`);
        this.loggedMissingContextParent = true;
      }
      return null;
    } catch (error) {
      logger.warn("[CalendarView] Error finding parent note:", error);
      return null;
    }
  }

  /**
   * Prefer parent note frontmatter date fields for context anchoring.
   */
  private extractContextDateFromFrontmatter(path: string): Date | null {
    try {
      const normalizedPath = normalizePath(path);
      const target = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (!(target instanceof TFile)) return null;

      const frontmatter = this.app.metadataCache.getFileCache(target)?.frontmatter as Record<string, any> | undefined;
      if (!frontmatter) return null;

      const candidateKeys: string[] = [];
      const addCandidate = (raw: unknown) => {
        if (typeof raw !== "string") return;
        const trimmed = raw.trim();
        if (!trimmed) return;
        const normalized = trimmed.includes(".") ? trimmed.split(".").pop() ?? trimmed : trimmed;
        if (!normalized) return;
        if (!candidateKeys.includes(normalized)) candidateKeys.push(normalized);
      };

      for (const propId of this.getStartDatePropsInPriorityOrder()) {
        addCandidate(this.getFieldFromPropertyId(propId));
      }
      addCandidate((this.plugin as any)?.settings?.startProperty);
      addCandidate((this.plugin as any)?.settings?.secondaryStartProperty);
      addCandidate((this.plugin as any)?.settings?.tertiaryStartProperty);
      addCandidate("scheduled");
      addCandidate("completed");
      addCandidate("completedDate");
      addCandidate("completedAt");
      addCandidate("due");
      addCandidate("start");
      addCandidate("date");
      addCandidate("day");

      for (const key of candidateKeys) {
        const rawValue = this.getFrontmatterValueCaseInsensitive(frontmatter, key);
        const parsed = this.parseContextDateValue(rawValue);
        if (parsed) {
          return parsed;
        }
      }
    } catch (error) {
      logger.warn("[CalendarView] Failed reading context date from frontmatter:", error);
    }

    return null;
  }

  private parseContextDateValue(rawValue: unknown): Date | null {
    if (rawValue === undefined || rawValue === null) return null;
    const moment = (window as any).moment;
    if (!moment) return null;

    if (rawValue instanceof Date && !isNaN(rawValue.getTime())) {
      return new Date(rawValue.getTime());
    }

    if (typeof rawValue === "number") {
      const mNum = moment(rawValue);
      return mNum?.isValid?.() ? mNum.toDate() : null;
    }

    const text = String(rawValue).trim();
    if (!text) return null;
    if (text.toLowerCase() === "invalid date") return null;

    try {
      const byFilenameParser = parseDateFromFilename(text, this.getDailyNoteDateFormat());
      if (byFilenameParser?.isValid?.()) {
        return byFilenameParser.toDate();
      }
    } catch {
      // Continue with explicit datetime parsing below.
    }

    const strict = moment(
      text,
      [
        moment.ISO_8601,
        "YYYY-MM-DD HH:mm:ss",
        "YYYY-MM-DD HH:mm",
        "YYYY-MM-DD",
        "dddd, MMMM Do YYYY",
        "MMMM D, YYYY",
        "MMM D, YYYY",
      ],
      true,
    );
    if (strict?.isValid?.()) {
      return strict.toDate();
    }

    const loose = moment(text);
    return loose?.isValid?.() ? loose.toDate() : null;
  }

  /**
   * Extracts a date from a file path or filename.
   * Supports common formats:
   * - YYYY-MM-DD (e.g., "2025-02-01.md")
   * - YYYY_MM_DD (e.g., "2025_02_01.md")
   * - Date embedded in title (e.g., "Meeting 2025-02-01.md")
   */
  private extractDateFromPath(path: string): Date | null {
    // Get just the filename without extension
    const filename = path.split('/').pop()?.replace(/\.[^.]+$/, '') || '';

    // Try user-configured format first (via parseDateFromFilename)
    try {
      const userFormat = this.getDailyNoteDateFormat();
      const m = parseDateFromFilename(filename, userFormat);
      if (m && m.isValid && m.isValid()) return m.toDate();
    } catch (e) {
      // Fall through to conservative regex fallback below
    }

    // Conservative regex fallback for unambiguous YYYY-MM-DD style filenames
    const isoMatch = filename.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
    if (isoMatch) {
      const year = parseInt(isoMatch[1], 10);
      const month = parseInt(isoMatch[2], 10) - 1; // 0-indexed
      const day = parseInt(isoMatch[3], 10);
      const date = new Date(year, month, day);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }

    return null;
  }

  private async refreshExternalEvents(start: Date, end: Date): Promise<void> {
    if (!this.shouldProcessUpdates()) {
      return;
    }
    // All devices fetch and display external events
    // Only controller creates/syncs notes (checked in runAutoCreateSync)

    const recentlyTyping = this.lastEditorChangeAt && Date.now() - this.lastEditorChangeAt < this.typingQuietWindowMs;
    if (recentlyTyping) {
      return;
    }

    if (this.isFetchingExternalEvents || this.visibleExternalCalendarUrls.length === 0) {
      return;
    }

    this.isFetchingExternalEvents = true;

    try {
      const externalPromises = this.visibleExternalCalendarUrls.map((url) =>
        this.externalCalendarService.fetchEvents(url, start, end, false, true),
      );

      const results = await Promise.allSettled(externalPromises);
      const newEvents: ExternalCalendarEvent[] = [];

      for (const result of results) {
        if (result.status === "fulfilled") {
          newEvents.push(...result.value);
        }
      }

      this.cachedExternalEvents = newEvents;
      this.lastExternalFetch = Date.now();
      this.updateCalendar();

    } catch (error) {
      logger.error("[CalendarView] Error fetching external events:", error);
    } finally {
      this.isFetchingExternalEvents = false;
    }
  }

  private tryGetValue(entry: BasesEntry, propId: BasesPropertyId): any {
    try {
      return entry.getValue(propId);
    } catch {
      return null;
    }
  }

  private async handleCreateRange(start: Date, end: Date): Promise<void> {
    if (!this.startDateProp) return;

    try {
      const baseFilters = await this.readBaseFileFilters();
      const creationDefaults = this.getFilterCreationDefaults(baseFilters);
      const createMode = this.plugin.settings.defaultCreateMode || "note";
      let file: TFile | null = null;
      if (createMode === "task") {
        const targetFile = await this.resolveDefaultTaskTargetFile(start);
        file = await this.newEventService.createTask(start, end, targetFile.path, undefined, {
          useBaseDefaults: true,
          frontmatterDefaults: creationDefaults.frontmatter,
          typeFolderOverride: creationDefaults.folderPath,
        });
      } else {
        file = await this.newEventService.createEvent(start, end, undefined, {
          useBaseDefaults: true,
          frontmatterDefaults: creationDefaults.frontmatter,
          typeFolderOverride: creationDefaults.folderPath,
        });
      }
      if (file) {
        this.updateCalendar();
      }
    } catch (error) {
      logger.error('[CalendarView] Error in handleCreateRange:', error);
      new Notice(`Failed to create event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async resolveDefaultTaskTargetFile(date: Date): Promise<TFile> {
    const configured = String(this.plugin.settings.defaultTaskTargetFile || "").trim();
    if (!configured) {
      return await this.getOrCreateDailyNote(date);
    }

    const normalized = configured.endsWith(".md") ? configured : `${configured}.md`;
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      return existing;
    }
    if (existing) {
      throw new Error(`Configured task target is not a markdown file: ${normalized}`);
    }

    const folderPath = normalized.includes("/") ? normalized.substring(0, normalized.lastIndexOf("/")) : "";
    if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) {
      await this.app.vault.createFolder(folderPath);
    }
    return await this.app.vault.create(normalized, "");
  }



  private async handleCreateMeetingNote(event: ExternalCalendarEvent): Promise<void> {
    try {
      const startField = this.getNoteField(this.startDateProp);
      const endField = this.getNoteField(this.endDateProp);
      const baseFilters = await this.readBaseFileFilters();
      const creationDefaults = this.getFilterCreationDefaults(baseFilters);

      const calendarConfig = event.sourceUrl
        ? this.plugin.getExternalCalendarConfig(event.sourceUrl)
        : null;
      const typeFolderPath =
        typeof calendarConfig?.autoCreateTypeFolder === "string"
          ? calendarConfig.autoCreateTypeFolder.trim()
          : "";
      const folderPath =
        typeof calendarConfig?.autoCreateFolder === "string"
          ? calendarConfig.autoCreateFolder.trim()
          : "";
      const calendarTag =
        typeof calendarConfig?.autoCreateTag === "string"
          ? calendarConfig.autoCreateTag.trim().replace(/^#+/, "").toLowerCase()
          : "";
      const templatePath =
        typeof calendarConfig?.autoCreateTemplate === "string" && calendarConfig.autoCreateTemplate.trim()
          ? calendarConfig.autoCreateTemplate.trim()
          : this.newEventTemplate || this.baseTemplatePath || null;
      const resolvedFolderPath = typeFolderPath || folderPath;
      const finalFolderPath = resolvedFolderPath || creationDefaults.folderPath || null;

      const file = await createMeetingNoteFromExternalEvent(
        this.app,
        event,
        templatePath,
        finalFolderPath,
        startField,
        endField,
        this.useEndDuration,
        calendarTag || null,
        null,
        undefined,
        undefined,
        {
          eventIdKey: this.plugin.settings.eventIdKey,
          uidKey: this.plugin.settings.uidKey || undefined, // undefined will be skipped by createMeetingNoteFromExternalEvent if we modify it, or we need to handle it there.
          titleKey: this.plugin.settings.titleKey,
          statusKey: this.plugin.settings.statusKey,
        }
      );

      if (file) {
        new Notice(`Created meeting note: ${file.basename}`);
        const leaf = this.getTargetLeafForOpen(false);
        if (leaf) {
          await leaf.openFile(file);
        }
        this.updateCalendar();
      }
    } catch (error) {
      logger.error('[CalendarView] Error creating meeting note:', error);
      new Notice(`Failed to create meeting note: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Daily note embed syncing/validation was extracted into the standalone TPS Daily Embeds plugin.

  private forceRerenderMarkdownViews(): void {
    try {
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (!(leaf?.view instanceof MarkdownView)) return;
        const view = leaf.view as any;
        try {
          // Reading mode
          view.previewMode?.rerender?.(true);
          // Live preview / source: best-effort refresh
          view.editor?.refresh?.();
        } catch { }
      });
    } catch { }
  }

  /**
   * Find and highlight an embedded event in the active view
   * Retries up to 5 times if the embed is not found immediately (DOM rendering delay)
   */
  private highlightEventEmbed(
    eventNotePath: string,
    timestamp?: number,
    retryCount = 0,
    options: { wikiLinkOnly?: boolean; preferredFilePath?: string } = {},
  ): void {
    const MAX_RETRIES = 10;
    if (retryCount > MAX_RETRIES) {
      // console.warn(`[CalendarView] Highlight stopped after ${MAX_RETRIES} retries for ${eventNotePath}`);
      return;
    }

    // Helper to escape regex special characters
    const escapeRegExp = (string: string) => {
      return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    };

    // Helper to extract basename from path
    const getBasename = (path: string) => path.split('/').pop() || '';

    const basename = getBasename(eventNotePath);
    const dateSuffixRegex = / \d{4}-\d{2}-\d{2}$/;
    const cleanedBasename = basename.replace(dateSuffixRegex, '');
    const hasSuffix = basename !== cleanedBasename;

    if (!basename) return;

    let scrolled = false;

    // STRATEGY 1: Editor API (Live Preview / Source Mode) - Scroll Only
    const leaf = this.app.workspace.activeLeaf;
    if (leaf?.view instanceof MarkdownView) {
      const view = leaf.view;
      const mode = view.getMode();

      if (mode === 'source') {
        const editor = view.editor;
        const content = editor.getValue();

        let searchBasename = basename;
        let escapedBasename = escapeRegExp(searchBasename);
        const linkPrefix = options.wikiLinkOnly ? '' : '!?';
        let regex = new RegExp(`${linkPrefix}\\[\\[[^\\]]*${escapedBasename}(?:\\|[^\\]]*)?\\]\\]`, 'i');
        let match = content.match(regex);

        if (!match && hasSuffix) {
          searchBasename = cleanedBasename;
          escapedBasename = escapeRegExp(searchBasename);
          regex = new RegExp(`${linkPrefix}\\[\\[[^\\]]*${escapedBasename}(?:\\|[^\\]]*)?\\]\\]`, 'i');
          match = content.match(regex);
        }

        if (match && match.index !== undefined) {
          const pos = editor.offsetToPos(match.index);
          editor.scrollIntoView({
            from: pos,
            to: { line: pos.line + 1, ch: 0 }
          }, true);
          scrolled = true;
        }
      }
    }

    // STRATEGY 2: Persistent DOM Highlighting (Visual Feedback)
    // We check repeatedly for 2 seconds to handle re-renders (e.g. sync blocks loading)
    // If highlighting consistently fails, we assume the embed is broken and try to repair it
    let highlightSucceeded = false;
    let rerenderTriggered = false;

    const sustainHighlight = (durationMs: number = 2000) => {
      const startTime = Date.now();
      const interval = setInterval(() => {
        if (Date.now() - startTime > durationMs) {
          clearInterval(interval);

          if (!highlightSucceeded) {
            logger.log(`[CalendarView] Highlight failed after ${durationMs}ms. Attempting to repair embeds...`);
            // Daily note embed syncing/repair is handled by the standalone TPS Daily Embeds plugin.
          }
          return;
        }

        // Try to highlight and track success
        const ok = this.applyDomHighlight(eventNotePath, cleanedBasename, hasSuffix, scrolled, timestamp, options);
        if (!ok && !rerenderTriggered) {
          // On initial vault load, the daily note can be opened before preview embeds render.
          // Force a re-render once to avoid needing the user to switch days.
          rerenderTriggered = true;
          this.forceRerenderMarkdownViews();
        }
        if (ok) {
          highlightSucceeded = true;
          // Don't clear interval yet - keep ensuring it stays highlighted during renders
        }
      }, 200);

      // Run once immediately
      const firstOk = this.applyDomHighlight(eventNotePath, cleanedBasename, hasSuffix, scrolled, timestamp, options);
      if (!firstOk && !rerenderTriggered) {
        rerenderTriggered = true;
        this.forceRerenderMarkdownViews();
      }
      if (firstOk) {
        highlightSucceeded = true;
      }
    };

    // If we haven't found the container yet, retry the whole function
    if (!leaf?.view?.containerEl) {
      setTimeout(() => this.highlightEventEmbed(eventNotePath, timestamp, retryCount + 1, options), 200);
      return;
    }
    // Trigger the sustain loop
    sustainHighlight();
  }

  /**
   * Applies the CSS highlight class to the matching DOM element.
   * Applies the CSS highlight class to the matching DOM element.
   * Can be called repeatedly to handle re-renders.
   * @returns true if an element was highlighted, false otherwise
   */
  private applyDomHighlight(
    eventNotePath: string,
    cleanedBasename: string,
    hasSuffix: boolean,
    alreadyScrolled: boolean,
    timestamp?: number,
    options: { wikiLinkOnly?: boolean; preferredFilePath?: string } = {},
  ): boolean {
    const isElementVisible = (el: Element): boolean => {
      try {
        const html = el as HTMLElement;
        if (!html.isConnected) return false;
        const style = window.getComputedStyle(html);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = html.getBoundingClientRect?.();
        if (!rect) return true;
        return rect.width > 0 && rect.height > 0;
      } catch {
        return true;
      }
    };

    // Find all markdown leaves that could contain the embed
    const leaves: any[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view?.getViewType() === "markdown") {
        leaves.push(leaf);
      }
    });

    const isLeafVisible = (leaf: any): boolean => {
      try {
        const el = leaf?.view?.containerEl as HTMLElement | undefined;
        if (!el) return false;
        if (!el.isConnected) return false;
        const rect = el.getBoundingClientRect?.();
        if (!rect) return true;
        return rect.width > 0 && rect.height > 0;
      } catch {
        return true;
      }
    };

    // Prefer the intended daily note leaf first so we don't "succeed"
    // in a background pane and stop before highlighting the visible one.
    const activeLeaf = this.app.workspace.activeLeaf;
    const activeFile = this.app.workspace.getActiveFile();
    const prioritizedLeaves: any[] = [];
    const seen = new Set<any>();

    const preferredPath = options.preferredFilePath?.trim();
    const isActiveMarkdownLeaf = activeLeaf?.view?.getViewType?.() === "markdown";
    const activeLeafFilePath = isActiveMarkdownLeaf ? (activeLeaf.view as any)?.file?.path : undefined;

    // 1) Active leaf first (if it is the target file, or if we have no better hint).
    if (isActiveMarkdownLeaf && !seen.has(activeLeaf)) {
      if (!preferredPath || (activeLeafFilePath && activeLeafFilePath === preferredPath)) {
        prioritizedLeaves.push(activeLeaf);
        seen.add(activeLeaf);
      }
    }

    // 2) Any leaves showing the preferred file, visible ones first.
    if (preferredPath) {
      const matchingPreferred = leaves.filter((leaf) => {
        const viewFile = (leaf.view as any)?.file;
        return viewFile?.path && viewFile.path === preferredPath;
      });

      const preferredVisible = matchingPreferred.filter(isLeafVisible);
      const preferredHidden = matchingPreferred.filter((l) => !isLeafVisible(l));

      for (const leaf of [...preferredVisible, ...preferredHidden]) {
        if (seen.has(leaf)) continue;
        prioritizedLeaves.push(leaf);
        seen.add(leaf);
      }
    }

    // 3) Active leaf (if not already included).
    if (isActiveMarkdownLeaf && !seen.has(activeLeaf)) {
      prioritizedLeaves.push(activeLeaf);
      seen.add(activeLeaf);
    }

    if (activeFile) {
      for (const leaf of leaves) {
        if (seen.has(leaf)) continue;
        const viewFile = (leaf.view as any)?.file;
        if (viewFile?.path && viewFile.path === activeFile.path) {
          prioritizedLeaves.push(leaf);
          seen.add(leaf);
        }
      }
    }

    for (const leaf of leaves) {
      if (seen.has(leaf)) continue;
      prioritizedLeaves.push(leaf);
      seen.add(leaf);
    }

    logger.log(`[Highlight] Scanning ${prioritizedLeaves.length} leaves for: ${eventNotePath}`);

    const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const basename = eventNotePath.split('/').pop() || '';

    const highlightWikiLink = (container: HTMLElement): boolean => {
      const targetNoExt = eventNotePath.replace(/\.md$/, '');
      const targetWithExt = targetNoExt + '.md';

      const linkEls = Array.from(
        container.querySelectorAll<HTMLElement>('a.internal-link, .internal-link, [data-href]'),
      );
      for (const linkEl of linkEls) {
        const href = (linkEl.getAttribute('data-href') || linkEl.getAttribute('href') || '').trim();
        if (!href) continue;
        const match =
          href === targetNoExt ||
          href === targetWithExt ||
          href.endsWith('/' + targetNoExt) ||
          href.endsWith('/' + targetWithExt) ||
          href === basename ||
          href === basename + '.md';
        if (!match) continue;

        const row =
          linkEl.closest('.metadata-property') ||
          linkEl.closest('li') ||
          linkEl.closest('p') ||
          linkEl;
        return highlightElement(row, 'wiki-link');
      }
      return false;
    };

    const highlightElement = (el: Element, method: string) => {
      const rect = el.getBoundingClientRect();
      logger.log(`[Highlight] SUCCESS via ${method}`);
      logger.log(`[Highlight] Element: <${el.tagName} class="${el.className}">`);
      logger.log(`[Highlight] Visibility: ${rect.width}x${rect.height} at (${rect.top},${rect.left})`);
      logger.log(`[Highlight] Content: ${el.textContent?.substring(0, 50)}...`);

      if (!isElementVisible(el)) {
        logger.log(`[Highlight] Skipping invisible match via ${method}`);
        return false;
      }

      if (!alreadyScrolled) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      if (!el.classList.contains('tps-calendar-embed-highlight')) {
        el.classList.add('tps-calendar-embed-highlight');
        setTimeout(() => el.classList.remove('tps-calendar-embed-highlight'), 2000);
      }
      return true;
    };

    // Helper to process a specific leaf
    const processLeaf = (leaf: any): boolean => {
      if (!leaf?.view?.containerEl) return false;
      const container = leaf.view.containerEl as HTMLElement;

      if (options.wikiLinkOnly) {
        return highlightWikiLink(container);
      }

      // 1. Try finding by data-calendar-embed attribute with TIMESTAMP TOLERANCE
      let targetMarker: Element | null = null;
      const markers = Array.from(container.querySelectorAll('span[data-calendar-embed]'));

      // Filter candidates by path first
      const candidates = markers.filter(m => {
        const val = m.getAttribute('data-calendar-embed') || '';
        // Check exact path, filename, or stripped basename (suffix)
        return val === eventNotePath || val === eventNotePath + '.md' ||
          val.endsWith('/' + eventNotePath) || val.endsWith('/' + basename) ||
          (hasSuffix && new RegExp(`${escapeRegExp(cleanedBasename)}(\\.md)?$`, 'i').test(val));
      });

      if (timestamp) {
        // Find best match within small tolerance (same instance)
        let bestMatch = null;
        let minDiff = 2000; // 2 seconds tolerance

        for (const m of candidates) {
          const tsStr = m.getAttribute('data-timestamp');
          if (tsStr) {
            const diff = Math.abs(Number(tsStr) - timestamp);
            if (diff < minDiff) {
              minDiff = diff;
              bestMatch = m;
            }
          }
        }
        targetMarker = bestMatch;

        // If we failed to find a tight timestamp match, fall back safely:
        // - If there's only one candidate for this note, highlight it (daily notes generally embed a note once).
        // - Otherwise, prefer a candidate whose timestamp falls on the same local day as the clicked event.
        if (!targetMarker) {
          if (candidates.length === 1) {
            targetMarker = candidates[0];
          } else {
            const moment = (window as any).moment;
            const dayStart = moment(timestamp).startOf('day').valueOf();
            const dayEnd = moment(timestamp).endOf('day').valueOf();

            let bestSameDay: Element | null = null;
            let bestSameDayDiff = Number.POSITIVE_INFINITY;

            for (const m of candidates) {
              const tsStr = m.getAttribute('data-timestamp');
              if (!tsStr) continue;
              const ts = Number(tsStr);
              if (!Number.isFinite(ts)) continue;
              if (ts < dayStart || ts > dayEnd) continue;
              const diff = Math.abs(ts - timestamp);
              if (diff < bestSameDayDiff) {
                bestSameDayDiff = diff;
                bestSameDay = m;
              }
            }

            targetMarker = bestSameDay;
          }
        }
      } else {
        // No timestamp provided, just take the first candidate
        if (candidates.length > 0) targetMarker = candidates[0];
      }
      logger.log(`[Highlight] Marker found via attribute:`, !!targetMarker);

      // 2. If still not found, try finding by stripped path regex (ghost events with suffixes)
      if (!targetMarker && hasSuffix) {
        const markers = Array.from(container.querySelectorAll('span[data-calendar-embed]'));
        targetMarker = markers.find(m => {
          const val = m.getAttribute('data-calendar-embed') || '';
          const regex = new RegExp(`${escapeRegExp(cleanedBasename)}(\\.md)?$`, 'i');
          return regex.test(val);
        }) || null;
      }

      if (targetMarker) {
        // Handle case where marker is wrapped in <p> or cm-html-embed
        const parent = targetMarker.parentElement;
        const grandparent = parent?.parentElement;
        logger.log(`[Highlight] Marker found in leaf! Parent: ${parent?.tagName}.${parent?.className}`);

        // **New Robust Strategy: Linear DOM Scan**
        // Instead of relying on parent/sibling relationships which vary wildly between modes
        // and may be interrupted by wrappers (p, div, etc), we scan the flat list of all
        // elements in the container to find the sync block that appears *after* the marker.

        const allElements = Array.from(container.querySelectorAll('*'));
        const markerIndex = allElements.indexOf(targetMarker);

        logger.log(`[Highlight] Marker found at index ${markerIndex} of ${allElements.length} elements`);

        const isSyncBlockWrapper = (el: Element): boolean => {
          try {
            if (el.matches('.block-language-sync')) return true;
            if (el.matches('.cm-preview-code-block.cm-lang-sync')) return true;
            if (
              el.matches('.cm-preview-code-block') &&
              (el.classList.contains('cm-lang-sync') ||
                !!el.querySelector('.sync-container, .sync-embed') ||
                !!el.querySelector('code.language-sync'))
            ) {
              return true;
            }
            if (el.matches('pre') && !!el.querySelector('code.language-sync')) return true;
          } catch { }
          return false;
        };

        const highlightMarkerAdjacentSyncBlock = (): boolean => {
          if (markerIndex === -1) return false;

          for (let i = markerIndex + 1; i < allElements.length; i++) {
            const candidate = allElements[i];
            if (i - markerIndex > 120) break;

            // If we hit the next marker before finding a sync block, stop to avoid highlighting
            // the wrong embed further down.
            if (candidate.matches?.('span[data-calendar-embed]')) break;

            let wrapper: Element | null = null;

            if (isSyncBlockWrapper(candidate)) {
              wrapper = candidate;
            } else if (candidate.matches?.('.sync-embed, .sync-container')) {
              wrapper =
                candidate.closest?.('.cm-preview-code-block, .block-language-sync, .cm-embed-block') ||
                candidate;
            } else {
              const nested =
                candidate.querySelector?.('.cm-preview-code-block.cm-lang-sync, .block-language-sync') || null;
              if (nested) {
                wrapper = nested;
              } else {
                const code = candidate.querySelector?.('code.language-sync') || null;
                if (code) wrapper = (code.closest?.('pre') as Element | null) || code;
              }
            }

            if (!wrapper) continue;
            if (!isElementVisible(wrapper)) continue;
            return highlightElement(wrapper, 'marker-next-sync');
          }

          return false;
        };

        if (highlightMarkerAdjacentSyncBlock()) return true;

        if (markerIndex !== -1) {
          // Scan forward from the marker
          for (let i = markerIndex + 1; i < allElements.length; i++) {
            const candidate = allElements[i];

            // Limit scan distance to avoid finding the wrong embed further down
            if (i - markerIndex > 50) break;

            // Legacy fallback: keep the scan, but don't treat invisible matches as success.
            if (candidate.matches('.block-language-sync, .sync-embed, .sync-container, .cm-embed-block, .cm-preview-code-block')) {
              const preferred =
                candidate.closest?.('.cm-preview-code-block, .block-language-sync, .cm-embed-block') ||
                candidate;
              if (highlightElement(preferred, 'linear-scan-marker')) return true;
              continue;
            }

            const nested = candidate.querySelector('.sync-embed, .sync-container, .cm-embed-block, .cm-preview-code-block');
            if (nested) {
              const preferred =
                nested.closest?.('.cm-preview-code-block, .block-language-sync, .cm-embed-block') ||
                nested;
              if (highlightElement(preferred, 'linear-scan-marker-nested')) return true;
              continue;
            }
          }
        }

        logger.log(`[Highlight] Linear scan failed to find sync block`);

        logger.log(`[Highlight] No sync block found via marker search`);
      }

      // Fallback: Internal Embeds
      const embeds = container.querySelectorAll('.internal-embed');
      for (const embed of Array.from(embeds)) {
        const src = embed.getAttribute('src') || '';
        // Exact match on filename, not partial includes
        if (src.endsWith(basename) || src.endsWith(basename + '.md') ||
          (hasSuffix && (src.endsWith(cleanedBasename) || src.endsWith(cleanedBasename + '.md')))) {
          if (highlightElement(embed, 'internal-embed')) return true;
        }
      }

      // Fallback: Sync/Code Blocks - match by finding embedded note title
      const blocks = container.querySelectorAll('.block-language-sync, .cm-embed-block, .sync-embed, .sync-container, .cm-preview-code-block');
      for (const block of Array.from(blocks)) {
        // Look for the note title in header elements or alias-header
        const header = block.querySelector('.sync-embed-alias-header, h1, h2, .inline-title');
        const headerText = header?.textContent?.trim() || '';
        const fullText = block.textContent || '';

        // Check exact header match first (most precise)
        if (headerText === basename || headerText === cleanedBasename ||
          headerText === basename.replace(/ \d{4}-\d{2}-\d{2}$/, '')) {
          if (highlightElement(block, 'header-match')) return true;
        }

        // Fallback to text contains with date specificity
        // Only match if the FULL basename (including date) appears
        if (fullText.includes(basename)) {
          if (highlightElement(block, 'text-match')) return true;
        }
      }

      return false;
    };

    // Iterate through leaves until we find a match
    for (const leaf of prioritizedLeaves) {
      if (processLeaf(leaf)) {
        return true; // Stop after first successful highlight
      }
    }

    logger.log(`[Highlight] FAILED - no matching element found in any leaf`);
    return false;
  }

  /**
   * Gets or creates the daily note for a given date
   */
  private async getOrCreateDailyNote(date: Date): Promise<TFile> {
    const path = this.getDailyNotePath(date);
    let file = this.app.vault.getAbstractFileByPath(path);

    if (!file) {
      // Create the folder if needed
      const folderPath = path.substring(0, path.lastIndexOf("/"));
      if (folderPath) {
        const folderFile = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folderFile) {
          await this.app.vault.createFolder(folderPath);
        }
      }

      const content = await this.buildDailyNoteContent(date, path);

      file = await this.app.vault.create(path, content);
      if (file instanceof TFile) {
        await this.ensureDailyNoteTitle(file);
      }
    }

    return file as TFile;
  }

  private async getOrCreateDailyCanvas(date: Date): Promise<TFile> {
    const path = this.getDailyCanvasPath(date);
    let file = this.app.vault.getAbstractFileByPath(path);

    if (!file) {
      const folderPath = path.substring(0, path.lastIndexOf("/"));
      if (folderPath) {
        const folderFile = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folderFile) {
          await this.app.vault.createFolder(folderPath);
        }
      }

      const content = this.buildDailyCanvasContent(date, path);
      file = await this.app.vault.create(path, content);
    }

    if (!(file instanceof TFile)) {
      throw new Error(`Invalid daily canvas path: ${path}`);
    }

    return file;
  }

  private async handleExternalDrop(filePath: string, start: Date, allDay: boolean): Promise<void> {


    // Get the file from the vault
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !(file instanceof TFile)) {
      logger.warn('[CalendarView] File not found:', filePath);
      return;
    }

    // If the dropped file is a template, create a new event from it instead of modifying the template
    if (this.isTemplateFile(file)) {
      try {
        const end = allDay
          ? new Date(start.getTime() + 24 * 60 * 60 * 1000)
          : new Date(start.getTime() + this.defaultEventDuration * 60000);
        const baseFilters = await this.readBaseFileFilters();
        const creationDefaults = this.getFilterCreationDefaults(baseFilters);
        const created = await this.newEventService.createEvent(start, end, undefined, {
          useBaseDefaults: true,
          frontmatterDefaults: creationDefaults.frontmatter,
          typeFolderOverride: creationDefaults.folderPath,
          templateOverride: file.path,
          templateTypeOverride: "file",
        });
        if (created) {
          this.updateCalendar();
        }
      } catch (error) {
        logger.error('[CalendarView] Error creating event from template drop:', error);
        new Notice(`Failed to create event: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    // Get the start field name from config
    const startField = this.getNoteField(this.startDateProp);
    if (!startField) {
      logger.warn('[CalendarView] No start date property configured');
      new Notice("No start date property configured for calendar.");
      return;
    }

    const allDayField = this.getNoteField(this.allDayProperty);

    // Update the frontmatter
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const formatDateTimeForFrontmatter = (date: Date): string => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        const hours = String(date.getHours()).padStart(2, "0");
        const minutes = String(date.getMinutes()).padStart(2, "0");
        const seconds = String(date.getSeconds()).padStart(2, "0");
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
      };

      // Set the scheduled date
      frontmatter[startField] = formatDateTimeForFrontmatter(start);


      // Set all-day flag if configured
      if (allDayField) {
        frontmatter[allDayField] = allDay;
      }
    });

    this.updateCalendar();
  }

  private isTemplateFile(file: TFile): boolean {
    const templatePath = this.baseTemplatePath;
    if (templatePath && normalizePath(templatePath) === normalizePath(file.path)) {
      return true;
    }

    const templater = (this.app as any)?.plugins?.plugins?.["templater-obsidian"];
    const templaterFolder = templater?.settings?.templates_folder || templater?.settings?.template_folder;
    if (templaterFolder) {
      const normalizedFolder = normalizePath(templaterFolder.endsWith("/") ? templaterFolder : `${templaterFolder}/`);
      if (normalizePath(file.path).startsWith(normalizedFolder)) {
        return true;
      }
    }

    const templateFolderNames = ["/Templates/", "/templates/"];
    return templateFolderNames.some((segment) => normalizePath(file.path).includes(segment));
  }

  private getDailyNotePath(date: Date): string {
    const dailyNotesPlugin = (this.app as any).internalPlugins?.getPluginById("daily-notes");

    // Check if daily notes plugin is enabled to get format, otherwise default
    let format = "YYYY-MM-DD";
    let folder = "";

    if (dailyNotesPlugin && dailyNotesPlugin.instance && dailyNotesPlugin.instance.options) {
      format = dailyNotesPlugin.instance.options.format || "YYYY-MM-DD";
      folder = dailyNotesPlugin.instance.options.folder || "";
    }

    const moment = (window as any).moment;
    const momentDate = moment(date);
    const fileName = momentDate.format(format);
    return folder
      ? normalizePath(`${folder}/${fileName}.md`)
      : normalizePath(`${fileName}.md`);
  }

  private getDailyCanvasPath(date: Date): string {
    // Prefer TPS Daily Canvas plugin settings when available.
    const dailyCanvasPlugin = (this.app as any)?.plugins?.plugins?.["tps-daily-canvas"];
    const canvasSettings = dailyCanvasPlugin?.settings;

    let format = "YYYY-MM-DD";
    let folder = "";

    if (canvasSettings) {
      format = canvasSettings.dateFormat || format;
      folder = canvasSettings.folder || "";
    } else {
      // Fallback to core daily-notes config for date format/folder.
      const dailyNotesPlugin = (this.app as any).internalPlugins?.getPluginById("daily-notes");
      if (dailyNotesPlugin && dailyNotesPlugin.instance && dailyNotesPlugin.instance.options) {
        format = dailyNotesPlugin.instance.options.format || format;
        folder = dailyNotesPlugin.instance.options.folder || "";
      }
    }

    const moment = (window as any).moment;
    const momentDate = moment(date);
    const fileName = momentDate.format(format);
    return folder
      ? normalizePath(`${folder}/${fileName}.canvas`)
      : normalizePath(`${fileName}.canvas`);
  }

  private buildDailyCanvasContent(date: Date, path: string): string {
    const title = path.split("/").pop()?.replace(".canvas", "") || "";
    const canvas = {
      nodes: [
        {
          id: `daily-${Date.now()}`,
          type: "text",
          text: `# ${title}`,
          x: 0,
          y: 0,
          width: 520,
          height: 220,
        },
      ],
      edges: [],
    };
    return JSON.stringify(canvas, null, 2);
  }

  private shouldOpenDailyCanvas(): boolean {
    return this.plugin.settings?.dailyDateLinkTarget === "daily-canvas";
  }

  private getDateLinkTargetPath(date: Date): string {
    return this.shouldOpenDailyCanvas()
      ? this.getDailyCanvasPath(date)
      : this.getDailyNotePath(date);
  }

  private handleDateMouseEnter(date: Date, targetEl: HTMLElement, event: MouseEvent): void {
    const path = this.getDateLinkTargetPath(date);
    this.app.workspace.trigger("hover-link", {
      event,
      source: "calendar-view",
      hoverParent: this,
      targetEl,
      linktext: path,
    });
  }

  private async handleDateClick(date: Date): Promise<void> {
    const useCanvas = this.shouldOpenDailyCanvas();

    try {
      const file = useCanvas
        ? await this.getOrCreateDailyCanvas(date)
        : await this.getOrCreateDailyNote(date);

      if (file instanceof TFile) {
        const leaf = this.getTargetLeafForOpen(false);
        if (leaf) {
          await leaf.openFile(file);
        }
      }
    } catch (e) {
      logger.error(`Failed to open ${useCanvas ? "daily canvas" : "daily note"}`, e);
      new Notice(`Failed to open ${useCanvas ? "daily canvas" : "daily note"}: ${e}`);
    }
  }

  private getTargetLeafForOpen(preferNewTab: boolean): WorkspaceLeaf | null {
    if (preferNewTab) {
      return this.getMainWorkspaceTabLeaf();
    }

    const workspaceAny = this.app.workspace as any;
    const activeLeaf = workspaceAny?.activeLeaf as WorkspaceLeaf | null | undefined;
    if (activeLeaf && this.isMainWorkspaceOpenTarget(activeLeaf)) {
      return activeLeaf;
    }

    const markdownLeaves = this.app.workspace
      .getLeavesOfType("markdown")
      .filter((leaf) => !this.isSidebarLeaf(leaf));
    if (markdownLeaves.length > 0) {
      return markdownLeaves[0];
    }

    const recentLeaf =
      typeof workspaceAny?.getMostRecentLeaf === "function"
        ? (workspaceAny.getMostRecentLeaf() as WorkspaceLeaf | null)
        : null;
    if (recentLeaf && this.isMainWorkspaceOpenTarget(recentLeaf)) {
      return recentLeaf;
    }

    const mainLeaf = this.getAnyMainWorkspaceLeaf();
    if (mainLeaf) {
      return mainLeaf;
    }

    return this.getMainWorkspaceTabLeaf();
  }

  private getMainWorkspaceTabLeaf(): WorkspaceLeaf | null {
    const workspaceAny = this.app.workspace as any;
    const activeLeaf = workspaceAny?.activeLeaf as WorkspaceLeaf | null | undefined;
    if (activeLeaf && !this.isSidebarLeaf(activeLeaf)) {
      return this.app.workspace.getLeaf("tab");
    }

    const anchorLeaf =
      this.app.workspace.getLeavesOfType("markdown").find((leaf) => !this.isSidebarLeaf(leaf))
      ?? this.getAnyMainWorkspaceLeaf();
    if (anchorLeaf) {
      this.app.workspace.setActiveLeaf(anchorLeaf, false, true);
      return this.app.workspace.getLeaf("tab");
    }

    return this.app.workspace.getLeaf("tab");
  }

  private getAnyMainWorkspaceLeaf(): WorkspaceLeaf | null {
    let target: WorkspaceLeaf | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (target) return;
      if (this.isSidebarLeaf(leaf)) return;
      if (this.isCalendarLeaf(leaf)) return;
      target = leaf;
    });
    return target;
  }

  private isMainWorkspaceOpenTarget(leaf: WorkspaceLeaf): boolean {
    return !this.isSidebarLeaf(leaf) && !this.isCalendarLeaf(leaf);
  }

  private isCalendarLeaf(leaf: WorkspaceLeaf): boolean {
    const viewType = leaf?.view?.getViewType?.();
    return viewType === CalendarViewType || viewType === "calendar-bases-view" || viewType === "calendar";
  }

  private isSidebarLeaf(leaf: WorkspaceLeaf | null | undefined): boolean {
    const containerEl = (leaf as any)?.containerEl as HTMLElement | undefined;
    return !!containerEl?.closest?.(".mod-left-split, .mod-right-split");
  }

  private async buildDailyNoteContent(date: Date, path: string): Promise<string> {
    const title = path.split("/").pop()?.replace(".md", "") || "";
    let content = `---\ntitle: ${title}\n---\n`;

    const dailyNotesPlugin = (this.app as any).internalPlugins?.getPluginById("daily-notes");
    if (dailyNotesPlugin && dailyNotesPlugin.enabled) {
      const templatePath = dailyNotesPlugin.instance?.options?.template;
      if (templatePath) {
        const normalizedPath = normalizePath(templatePath);
        const templateFile =
          (this.app.vault.getAbstractFileByPath(normalizedPath) ||
            (normalizedPath.toLowerCase().endsWith(".md")
              ? null
              : this.app.vault.getAbstractFileByPath(`${normalizedPath}.md`)));

        if (templateFile instanceof TFile) {
          try {
            content = await this.app.vault.read(templateFile);
            content = this.applyDailyNoteTemplateVariables(content, date, title);
          } catch (err) {
            logger.warn("Failed to read daily note template, using default:", err);
          }
        }
      }
    }

    return content;
  }

  private applyDailyNoteTemplateVariables(content: string, date: Date, title: string): string {
    const moment = (window as any).moment;
    const momentDate = moment(date);

    return content
      .replace(/\{\{date:([^}]+)\}\}/g, (_match, format) => momentDate.format(format))
      .replace(/\{\{time:([^}]+)\}\}/g, (_match, format) => momentDate.format(format))
      .replace(/\{\{date\}\}/g, momentDate.format("YYYY-MM-DD"))
      .replace(/\{\{time\}\}/g, momentDate.format("HH:mm"))
      .replace(/\{\{title\}\}/g, title);
  }

  private async ensureDailyNoteTitle(file: TFile): Promise<void> {
    const title = file.basename;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      const current = fm[this.plugin.settings.titleKey];
      if (this.isTemplatePlaceholderTitle(current) || !current) {
        fm[this.plugin.settings.titleKey] = title;
      }
    });
  }

  private isTemplatePlaceholderTitle(value: unknown): boolean {
    if (typeof value !== "string") return true;
    const normalized = value.trim();
    if (!normalized) return true;
    return (
      normalized.includes("<%") ||
      normalized.includes("tp.file") ||
      normalized.includes("{{title}}") ||
      normalized.toLowerCase() === "daily note template"
    );
  }


  private renderReactCalendar(): void {
    if (!this.root) {
      this.root = createRoot(this.containerEl);
    }
    const propsToRender = this.config ? (this.config.getOrder() || []) : [];

    this.root.render(
      <StrictMode>
        <AppContext.Provider value={this.app}>
          <CalendarReactView
            entries={[...this.entries]}
            weekStartDay={this.weekStartDay}
            viewMode={this.viewMode}
            properties={propsToRender}
            onEntryClick={async (calEntry, isModEvent) => {
              // Check if this is an external event
              if (calEntry.isExternal && calEntry.externalEvent) {
                // Show external event details modal
                const modal = new ExternalEventModal(
                  this.app,
                  calEntry.externalEvent,
                  async (event) => {
                    await this.handleCreateMeetingNote(event);
                  },
                  async (event) => {
                    await this.hideExternalEventForCurrentBase(event);
                  }
                );
                modal.open();
                return;
              }

              const file = calEntry.entry.file;
              if (!file) return;
              const leaf = this.getTargetLeafForOpen(isModEvent);
              if (!leaf) return;
              await leaf.openFile(file);
            }}
            onEntryContextMenu={(evt, entry) => {
              evt.preventDefault();
              this.showEntryContextMenu(evt.nativeEvent as MouseEvent, entry);
            }}
            onEventDrop={(entry, newStart, newEnd, allDay, scope, oldStart, oldEnd) =>
              this.handleEventDrop(entry, newStart, newEnd, allDay, scope, oldStart, oldEnd)
            }
            onEventResize={(entry, newStart, newEnd, allDay, scope, oldStart, oldEnd) =>
              this.handleEventResize(entry, newStart, newEnd, allDay, scope, oldStart, oldEnd)
            }
            onCreateSelection={(start, end) => this.handleCreateRange(start, end)}
            onExternalDrop={(filePath, start, allDay) => this.handleExternalDrop(filePath, start, allDay)}
            editable={this.isEditable()}

            condenseLevel={this.condenseLevel}
            onCondenseLevelChange={(level) => this.updateCondenseLevel(level)}
            showFullDay={this.showFullDay}
            navStep={this.navStep}
            slotRange={this.getSlotRange()}
            initialDate={this.computeInitialDate()}
            currentDate={this.currentDate ?? undefined}
            onDateChange={(date) => {
              this.currentDate = date;
              this.persistCurrentDate(date);
              // NOTE: do NOT call renderReactCalendar() here.
              // This callback fires from inside FullCalendar's datesSet event,
              // which is already inside React's event-handling loop. Calling
              // root.render() from there creates a cascade:
              //   datesSet → onDateChange → renderReactCalendar → currentDate
              //   prop change → useEffect → api.gotoDate() → datesSet again …
              // Each cycle briefly repositions events, causing "ghost" flickers.
              // The date is already managed internally by FullCalendar; we only
              // need to persist it here for cross-session / cross-device restore.
            }}
            onToggleFullDay={() => this.toggleFullDay()}
            allDayProperty={this.allDayProperty}
            showHiddenHoursToggle={this.showHiddenHoursToggle}
            defaultEventDuration={this.defaultEventDuration}
            onDateClick={(date) => this.handleDateClick(date)}
            onDateMouseEnter={(date, el, ev) => this.handleDateMouseEnter(date, el, ev)}
            // showHiddenEvents={this.showHiddenEvents}
            // onToggleHiddenEvents={() => this.toggleHiddenEvents()}
            showNavButtons={this.showNavButtons}
            navigationLocked={this.navigationLockedByAutoRange}
            entryBoundsStart={this.filterRangeAuto && this.filterRangeStart ? this.filterRangeStart : undefined}
            entryBoundsEnd={this.filterRangeAuto && this.filterRangeEnd ? this.filterRangeEnd : undefined}
            navigationBoundsStart={this.navigationBoundsStart ?? undefined}
            navigationBoundsEnd={this.navigationBoundsEnd ?? undefined}

            allDayEventHeight={this.plugin.settings.allDayEventHeight}
            allDayMaxRows={this.plugin.settings.allDayMaxRows}
            allDayStickyScroll={this.plugin.settings.allDayStickyScroll}
            dayHeaderFormatSetting={this.plugin.settings.dayHeaderFormat}
            dayHeaderShowDate={this.plugin.settings.dayHeaderShowDate}
            timeFormatSetting={this.plugin.settings.timeFormat}
            slotDurationMinutes={this.plugin.settings.slotDuration}
            minEventHeight={this.plugin.settings.minEventHeight}
            snapDurationMinutes={this.plugin.settings.snapDuration}
            defaultScrollTimeSetting={this.plugin.settings.defaultScrollTime}
            showNowIndicator={this.plugin.settings.showNowIndicator}
            pastEventOpacity={this.plugin.settings.pastEventOpacity}
            eventFontSize={this.plugin.settings.eventFontSize}
            activeEventHighlightColor={this.plugin.settings.activeEventHighlightColor}
            doneStatuses={this.buildDoneStatuses()}
            dailyNoteDateFormat={this.getDailyNoteDateFormat()}
          />
        </AppContext.Provider>
      </StrictMode>,
    );
  }

  /**
   * Returns the set of status values that should be treated as "done" and dimmed.
   * Uses `canceledStatusValue` from settings as the configurable "wont-do" equivalent,
   * falling back to the standard "wont-do" if not set.
   */
  private buildDoneStatuses(): string[] {
    const canceledStatus = (this.plugin.settings.canceledStatusValue || "").trim().toLowerCase();
    const statuses = ["complete"];
    const wontDo = canceledStatus || "wont-do";
    if (!statuses.includes(wontDo)) statuses.push(wontDo);
    if (wontDo !== "wont do") statuses.push("wont do"); // legacy alias
    return statuses;
  }

  private isEditable(): boolean {
    if (!this.startDateProp) return false;
    const startDateProperty = parsePropertyId(this.startDateProp);
    if (startDateProperty.type !== "note") return false;

    if (!this.endDateProp) return true;
    const endDateProperty = parsePropertyId(this.endDateProp);
    if (endDateProperty.type !== "note") return false;

    return true;
  }

  private showEntryContextMenu(evt: MouseEvent, entry: BasesEntry): void {
    const fcEvent = (evt as any).fullCalendarEvent;
    const eventStart = fcEvent?.start ?? null;
    const calEntry = this.entries.find(e =>
      e.entry.file.path === entry.file.path &&
      (!eventStart || Math.abs(e.startDate.getTime() - eventStart.getTime()) < 1000)
    );

    const task = (entry as any).__taskItem as ParsedTaskItem | undefined;
    if (task) {
      void this.showTaskItemContextMenu(evt, entry, task);
      return;
    }

    // Check if this is an external event
    if (calEntry?.isExternal && calEntry.externalEvent) {
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle("Create Meeting Note")
          .setIcon("calendar-plus")
          .onClick(async () => {
            try {
              await this.promptConvertToMeetingNote(calEntry.externalEvent!);
            } catch (error) {
              logger.error("[CalendarView] Error creating meeting note:", error);
              new Notice(`Failed to create meeting note: ${error instanceof Error ? error.message : String(error)}`);
            }
          })
      );

      menu.addItem((item) =>
        item
          .setTitle("Link to Existing Note")
          .setIcon("link")
          .onClick(async () => {
            new FileSelectionModal(this.app, async (file: TFile) => {
              await this.linkNoteToEvent(file, calEntry.externalEvent!);
            }).open();
          })
      );

      menu.addItem((item) =>
        item
          .setTitle("Archive")
          .setIcon("archive")
          .onClick(async () => {
            await this.hideExternalEventForCurrentBase(calEntry.externalEvent!);
          })
      );

      if (this.isExternalEventHiddenAnywhere(calEntry.externalEvent)) {
        menu.addItem((item) =>
          item
            .setTitle("Reveal on all bases")
            .setIcon("eye")
            .onClick(async () => {
              await this.revealExternalEventOnAllBases(calEntry.externalEvent!);
            })
        );
      }

      menu.showAtMouseEvent(evt);
      return;
    }

    const file = entry.file;

    // Create the menu
    const menu = Menu.forEvent(evt);

    menu.addItem((item) =>
      item
        .setTitle("Link to Existing Note")
        .setIcon("link")
        .onClick(async () => {
          new FileSelectionModal(this.app, async (parentFile: TFile) => {
            await this.linkExistingNoteToEvent(file, parentFile);
          }).open();
        })
    );

    // We rely on the global 'file-menu' event listener in TPS-Global-Context-Menu to add items.
    // Explicitly calling addToNativeMenu here causes duplication if the listener also runs.

    // Add standard Obsidian context menu items
    this.app.workspace.handleLinkContextMenu(menu, file.path, "");

    // Add delete option if not already present (handleLinkContextMenu adds it usually, but let's be safe or add custom)
    // Actually handleLinkContextMenu adds 'Delete file' which is good.

    // Show the menu at the precise mouse coordinates
    // We use showAtPosition to ensure it's exactly where the user clicked
    menu.showAtPosition({ x: evt.clientX, y: evt.clientY });
  }

  private parseTaskStateLabel(rawLine: string): string {
    const state = rawLine.match(/^[\t ]*-\s+\[([^\]]*)\]/)?.[1]?.trim() ?? "";
    if (/^[xX]$/.test(state)) return "complete";
    if (state === "-") return "canceled";
    if (state === "?") return "question";
    return "open";
  }

  private async revealTaskLine(file: TFile, lineNumber: number): Promise<void> {
    const leaf = this.getTargetLeafForOpen(false);
    if (!leaf) return;
    await leaf.openFile(file);
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const editor = view.editor;
    if (!editor) return;
    const safeLine = Math.max(0, lineNumber);
    editor.setCursor({ line: safeLine, ch: 0 });
    editor.scrollIntoView({ from: { line: safeLine, ch: 0 }, to: { line: safeLine + 1, ch: 0 } }, true);
  }

  private async showTaskItemContextMenu(evt: MouseEvent, entry: BasesEntry, task: ParsedTaskItem): Promise<void> {
    const abstractFile = this.app.vault.getAbstractFileByPath(task.filePath || entry.file.path);
    if (!(abstractFile instanceof TFile)) return;

    const content = await this.app.vault.cachedRead(abstractFile);
    const lines = content.split("\n");
    const rawLine = lines[task.lineNumber] || "";
    const stateLabel = this.parseTaskStateLabel(rawLine);
    const scheduledLabel = task.scheduledDate
      ? formatDateTimeForFrontmatter(task.scheduledDate)
      : task.startDate
        ? formatDateTimeForFrontmatter(task.startDate)
        : task.dueDate
          ? formatDateTimeForFrontmatter(task.dueDate)
          : "";

    const menu = new Menu();
    menu.addItem((item) => item.setTitle(task.text || "Task").setIcon("square").setDisabled(true));
    menu.addItem((item) => item.setTitle(`State: ${stateLabel}`).setDisabled(true));
    menu.addItem((item) => item.setTitle(`Line: ${task.lineNumber + 1}`).setDisabled(true));
    if (scheduledLabel) {
      menu.addItem((item) => item.setTitle(`Scheduled: ${scheduledLabel}`).setDisabled(true));
    }
    if (task.durationMinutes) {
      menu.addItem((item) => item.setTitle(`Duration: ${task.durationMinutes}m`).setDisabled(true));
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("Open task line")
        .setIcon("list")
        .onClick(async () => {
          await this.revealTaskLine(abstractFile, task.lineNumber);
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("Open parent note")
        .setIcon("file-text")
        .onClick(async () => {
          const leaf = this.getTargetLeafForOpen(false);
          if (leaf) await leaf.openFile(abstractFile);
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("Copy task text")
        .setIcon("copy")
        .onClick(async () => {
          await navigator.clipboard.writeText(task.text || rawLine.trim());
        }),
    );
    menu.showAtPosition({ x: evt.clientX, y: evt.clientY });
  }

  private async handleEventDrop(
    entry: BasesEntry,
    newStart: Date,
    newEnd?: Date,
    allDay?: boolean,
    scope: "all" | "single" = "all",
    oldStart?: Date,
    oldEnd?: Date,
  ): Promise<void> {
    if ((entry as any).__taskItem) {
      const normalizedTaskStart = new Date(newStart);
      const includeTime = !allDay;
      if (!includeTime) {
        normalizedTaskStart.setHours(0, 0, 0, 0);
      }
      const handled = await this.updateTaskItemDate(entry, normalizedTaskStart, includeTime, newEnd);
      if (handled) return;
    }

    if (entry.file instanceof TFile && this.isKanbanBoardFile(entry.file)) {
      new Notice("Drag the Kanban card task event, not the board note event.");
      return;
    }

    // Check if this is an external event
    const eventData = this.entries.find(e => e.entry.file.path === entry.file.path);
    if (eventData?.isExternal && eventData.externalEvent) {
      const confirmed = await this.promptConvertToMeetingNote(eventData.externalEvent);
      if (!confirmed) {
        throw new Error("User cancelled conversion to meeting note");
      }
      return;
    }

    // Normalize dates for all-day events
    let normalizedStart = newStart;
    let normalizedEnd = newEnd;

    if (allDay) {
      normalizedStart = new Date(newStart);
      normalizedStart.setHours(0, 0, 0, 0);
      if (newEnd) {
        normalizedEnd = new Date(newEnd);
        normalizedEnd.setHours(0, 0, 0, 0);
      }
    }

    await this.updateEntryDates(entry, normalizedStart, normalizedEnd, allDay, scope);
  }

  private async promptConvertToMeetingNote(event: ExternalCalendarEvent): Promise<boolean> {
    const confirmed = await new Promise<boolean>((resolve) => {
      const modal = new Modal(this.app);
      modal.contentEl.createEl('h3', { text: 'Convert to Meeting Note?' });
      modal.contentEl.createEl('p', {
        text: 'This is a read-only calendar event. To edit it, you need to convert it to a meeting note first.'
      });

      const buttonContainer = modal.contentEl.createDiv({ cls: 'modal-button-container' });
      buttonContainer.style.marginTop = '20px';
      buttonContainer.style.display = 'flex';
      buttonContainer.style.gap = '10px';
      buttonContainer.style.justifyContent = 'flex-end';

      const convertBtn = buttonContainer.createEl('button', { text: 'Convert to Note', cls: 'mod-cta' });
      convertBtn.addEventListener('click', () => {
        modal.close();
        resolve(true);
      });

      const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
      cancelBtn.addEventListener('click', () => {
        modal.close();
        resolve(false);
      });

      modal.open();
    });

    if (confirmed) {
      await this.handleCreateMeetingNote(event);
      return true;
    }
    return false;
  }

  private async handleEventResize(
    entry: BasesEntry,
    newStart: Date,
    newEnd?: Date,
    allDay?: boolean,
    scope: "all" | "single" = "all",
    oldStart?: Date,
    oldEnd?: Date,
  ): Promise<void> {
    if ((entry as any).__taskItem) {
      const normalizedTaskStart = new Date(newStart);
      const handled = await this.updateTaskItemDate(entry, normalizedTaskStart, true, newEnd);
      if (handled) return;
    }

    if (entry.file instanceof TFile && this.isKanbanBoardFile(entry.file)) {
      new Notice("Resize is disabled for Kanban board note events.");
      return;
    }

    // Check if this is an external event
    const eventData = this.entries.find(e => e.entry.file.path === entry.file.path);
    if (eventData?.isExternal && eventData.externalEvent) {
      await this.promptConvertToMeetingNote(eventData.externalEvent);
      return;
    }

    if (!newEnd) {
      logger.warn("Event resize requires an end date");
      return;
    }
    await this.updateEntryDates(entry, newStart, newEnd, allDay, scope);
  }

  private async updateEntryDates(
    entry: BasesEntry,
    newStart: Date,
    newEnd?: Date,
    allDay?: boolean,
    scope: "all" | "single" = "all",
  ): Promise<void> {
    if (!this.startDateProp) {
      logger.warn('[Calendar] No startDateProp configured');
      return;
    }

    const file = entry.file;

    // Set pending update IMMEDIATELY to prevent snap-back race condition
    this.pendingUpdates.set(file.path, {
      start: newStart,
      end: newEnd,
      timestamp: Date.now()
    });

    // Optimistic UI Update
    const entryIndex = this.entries.findIndex(e => e.entry.file.path === file.path);
    if (entryIndex !== -1) {
      this.entries[entryIndex].startDate = newStart;
      this.entries[entryIndex].endDate = newEnd;
      // If we have an external event wrapper, update that too so it doesn't look out of sync
      if (this.entries[entryIndex].externalEvent) {
        this.entries[entryIndex].externalEvent!.startDate = newStart;
        if (newEnd) this.entries[entryIndex].externalEvent!.endDate = newEnd;
      }
      this.renderReactCalendar();
    }

    const startField = this.getNoteField(this.startDateProp);
    const endField = this.getNoteField(this.endDateProp);
    const allDayField = this.getNoteField(this.allDayProperty);

    if (!startField) {
      logger.warn("[Calendar] Start date property could not be converted to note field");
      this.pendingUpdates.delete(file.path); // Cleanup if we abort
      return;
    }

    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        const formatDateTimeForFrontmatter = (date: Date): string => {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, "0");
          const day = String(date.getDate()).padStart(2, "0");
          const hours = String(date.getHours()).padStart(2, "0");
          const minutes = String(date.getMinutes()).padStart(2, "0");
          const seconds = String(date.getSeconds()).padStart(2, "0");
          return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
        };

        frontmatter[startField] = formatDateTimeForFrontmatter(newStart);

        if (newEnd) {
          if (this.useEndDuration) {
            // Calculate duration and write to the configured end field (typically timeEstimate)
            let durationMinutes = Math.round((newEnd.getTime() - newStart.getTime()) / (1000 * 60));

            // Use default duration for all-day drops/resizes if exactly 24h (likely an intentional snap)
            if (allDay && durationMinutes === 1440) {
              const defaultDuration = this.defaultEventDuration;
              if (defaultDuration > 0) {
                durationMinutes = defaultDuration;
              }
            }

            if (durationMinutes > 0 && endField) {
              frontmatter[endField] = durationMinutes;
            }
          } else if (this.endDateProp && endField) {
            frontmatter[endField] = formatDateTimeForFrontmatter(newEnd);
          }
        }

        // Update allDay property if configured
        if (allDayField && allDay !== undefined) {
          frontmatter[allDayField] = allDay;
        }
      });

      // The metadata change handler will trigger a refresh automatically via onDataUpdated
      // We don't need to manually schedule a refresh here as it can cause conflicts
    } catch (e) {
      logger.error("Failed to update frontmatter", e);
      this.pendingUpdates.delete(file.path); // Cleanup on error
      this.updateCalendar(); // Revert UI
    }
  }

  private async syncNoteToEvent(file: TFile, event: ExternalCalendarEvent): Promise<void> {
    const startField = this.getNoteField(this.startDateProp);
    const endField = this.getNoteField(this.endDateProp);
    const allDayField = this.getNoteField(this.allDayProperty);

    if (!startField) return;

    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        const formatDateTimeForFrontmatter = (date: Date): string => {
          const year = date.getFullYear();
          const month = String(date.getMonth() + 1).padStart(2, "0");
          const day = String(date.getDate()).padStart(2, "0");
          const hours = String(date.getHours()).padStart(2, "0");
          const minutes = String(date.getMinutes()).padStart(2, "0");
          const seconds = String(date.getSeconds()).padStart(2, "0");
          return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
        };

        frontmatter[startField] = formatDateTimeForFrontmatter(event.startDate);

        if (event.endDate) {
          if (this.useEndDuration) {
            const durationMinutes = Math.round((event.endDate.getTime() - event.startDate.getTime()) / (1000 * 60));
            if (durationMinutes > 0 && endField) {
              frontmatter[endField] = durationMinutes;
            }
          } else if (this.endDateProp && endField) {
            frontmatter[endField] = formatDateTimeForFrontmatter(event.endDate);
          }
        }

        if (allDayField) {
          frontmatter[allDayField] = event.isAllDay;
        }
      });
    } catch (e) {
      logger.error("[Calendar] Failed to sync note to event", e);
    }
  }

  private createExternalEntry(extEvent: ExternalCalendarEvent): BasesEntry {
    const sourceKey = extEvent.sourceUrl || "external";
    return {
      file: {
        path: `external:${sourceKey}:${extEvent.id}`,
        basename: extEvent.title,
        name: extEvent.title,
        extension: 'md',
        stat: { ctime: 0, mtime: 0, size: 0 },
        parent: null,
      } as any,
      getValue: (propId: BasesPropertyId | string) => {
        const parsed = typeof propId === "string" ? parsePropertyId(propId as BasesPropertyId) : parsePropertyId(propId);
        const name = (parsed.name || (parsed as any).property || String(propId)).toLowerCase();

        if (name === "title") return extEvent.title;
        // Return timestamps (numbers) for dates to avoid filter engine confusion
        if (name === "startdate" || name === "start") return extEvent.startDate.getTime();
        if (name === "enddate" || name === "end") return extEvent.endDate.getTime();
        if (name === "allday") return extEvent.isAllDay;
        if (name === "description") return extEvent.description;
        if (name === "location") return extEvent.location;
        if (name === "organizer") return extEvent.organizer;
        if (name === "url") return extEvent.url;

        return null;
      },
    } as unknown as BasesEntry;
  }

  private createTaskEntry(file: TFile): BasesEntry {
    return {
      file,
      getValue: (_propId: BasesPropertyId) => null,
    } as unknown as BasesEntry;
  }

  private createTaskEntryFromItem(file: TFile, task: ParsedTaskItem): BasesEntry {
    const entry = this.createTaskEntry(file) as any;
    entry.__taskItem = task;
    return entry as BasesEntry;
  }

  private formatYmd(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  private formatKanbanTime(date: Date): string {
    const hour24 = date.getHours();
    const minute = date.getMinutes();
    const meridiem = hour24 >= 12 ? "pm" : "am";
    const hour12 = ((hour24 + 11) % 12) + 1;
    return `${hour12}:${String(minute).padStart(2, "0")}${meridiem}`;
  }

  private updateTaskLineDate(line: string, date: Date, includeTime: boolean, newEnd?: Date): string {
    const ymd = this.formatYmd(date);
    let updated = line;
    if (/\[(scheduled|scheduleddate|scheduled-date)::\s*[^\]]+\]/i.test(line)) {
      const scheduledValue = includeTime
        ? `${ymd} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
        : ymd;
      updated = updated.replace(/\[(scheduled|scheduleddate|scheduled-date)::\s*[^\]]+\]/i, `[scheduled:: ${scheduledValue}]`);
    } else if (/@\{[^}]*\}/.test(line)) {
      updated = updated.replace(/@\{[^}]*\}/, `@{${ymd}}`);
    } else if (/⏳\s*\d{4}-\d{2}-\d{2}/.test(line)) {
      updated = updated.replace(/⏳\s*\d{4}-\d{2}-\d{2}/, `⏳ ${ymd}`);
    } else if (/📅\s*\d{4}-\d{2}-\d{2}/.test(line)) {
      updated = updated.replace(/📅\s*\d{4}-\d{2}-\d{2}/, `📅 ${ymd}`);
    } else {
      updated = includeTime
        ? `${updated} [scheduled:: ${ymd} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}]`
        : `${updated} [scheduled:: ${ymd}]`;
    }

    if (includeTime && !/\[(scheduled|scheduleddate|scheduled-date)::\s*[^\]]+\]/i.test(updated)) {
      const timeToken = this.formatKanbanTime(date);
      if (/@@\{[^}]*\}/.test(updated)) {
        updated = updated.replace(/@@\{[^}]*\}/, `@@{${timeToken}}`);
      } else {
        updated = `${updated} @@{${timeToken}}`;
      }
    } else if (!includeTime && /\[(scheduled|scheduleddate|scheduled-date)::\s*[^\]]+\]/i.test(updated)) {
      updated = updated.replace(
        /\[(scheduled|scheduleddate|scheduled-date)::\s*([^\]]+)\]/i,
        (_match, _key, rawValue) => {
          const trimmed = String(rawValue || "").trim();
          const dayOnly = trimmed.match(/\d{4}-\d{2}-\d{2}/)?.[0] || ymd;
          return `[scheduled:: ${dayOnly}]`;
        },
      );
    }

    const durationMinutes = newEnd
      ? Math.max(5, Math.round((newEnd.getTime() - date.getTime()) / (1000 * 60)))
      : null;
    if (durationMinutes !== null) {
      if (/\[(timeestimate|duration|durationminutes|time-estimate)::\s*[^\]]+\]/i.test(updated)) {
        updated = updated.replace(
          /\[(timeestimate|duration|durationminutes|time-estimate)::\s*[^\]]+\]/i,
          `[timeEstimate:: ${durationMinutes}]`,
        );
      } else if (includeTime) {
        updated = `${updated} [timeEstimate:: ${durationMinutes}]`;
      }
    }

    return updated;
  }

  private async updateTaskItemDate(entry: BasesEntry, newStart: Date, includeTime: boolean, newEnd?: Date): Promise<boolean> {
    const task = (entry as any).__taskItem as ParsedTaskItem | undefined;
    if (!task) return false;

    const abstractFile = this.app.vault.getAbstractFileByPath(task.filePath || entry.file.path);
    if (!(abstractFile instanceof TFile)) return false;

    const content = await this.app.vault.cachedRead(abstractFile);
    const lines = content.split("\n");
    const index = task.lineNumber;
    if (index < 0 || index >= lines.length) return false;

    const original = lines[index];
    const updated = this.updateTaskLineDate(original, newStart, includeTime, newEnd);
    if (updated === original) return false;

    lines[index] = updated;
    await this.app.vault.modify(abstractFile, lines.join("\n"));

    this.lastTaskItemsFetch = 0;
    await this.refreshTaskItems();
    return true;
  }

  private isKanbanBoardFile(file: TFile): boolean {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = (cache?.frontmatter || {}) as Record<string, unknown>;
    const value = String(frontmatter["kanban-plugin"] ?? frontmatter["kanbanPlugin"] ?? "").trim().toLowerCase();
    return value === "board";
  }

  private buildTaskItemEntries(): CalendarEntry[] {
    const settings = this.plugin.settings;
    const dateField = settings.taskDateField;
    const color = settings.taskItemColor || "#f59e0b";
    const entries: CalendarEntry[] = [];

    for (const task of this.cachedRawTaskItems) {
      if (!settings.showCompletedTaskItems && task.isCompleted) continue;

      let date: Date | null = null;
      let dateSource: "due" | "scheduled" | "start" | null = null;
      if (dateField === "due") {
        date = task.dueDate;
        dateSource = "due";
      } else if (dateField === "scheduled") {
        date = task.scheduledDate;
        dateSource = "scheduled";
      } else if (dateField === "start") {
        date = task.startDate;
        dateSource = "start";
      } else {
        if (task.dueDate) {
          date = task.dueDate;
          dateSource = "due";
        } else if (task.scheduledDate) {
          date = task.scheduledDate;
          dateSource = "scheduled";
        } else {
          date = task.startDate;
          dateSource = task.startDate ? "start" : null;
        }
      }

      if (!date) continue;

      const abstractFile = this.app.vault.getAbstractFileByPath(task.filePath);
      if (!abstractFile || !(abstractFile instanceof TFile)) continue;

      const taskTimed = dateSource === "scheduled" && task.hasScheduledTime;
      let startDate: Date;
      let endDate: Date;
      if (taskTimed) {
        startDate = new Date(date);
        const durationMinutes = Math.max(5, task.durationMinutes || this.defaultEventDuration || 30);
        endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
      } else {
        // All-day event: start at midnight, end at next-day midnight (FC exclusive end).
        startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
        endDate = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, 0, 0, 0, 0);
      }

      entries.push({
        entry: this.createTaskEntryFromItem(abstractFile, task),
        startDate,
        endDate,
        title: task.text || "Task",
        isTask: true,
        taskTimed,
        isExternal: false,
        externalEvent: task.externalEventId ? {
          id: task.externalEventId,
          uid: task.calendarUid || this.extractUidFromCompositeEventId(task.externalEventId) || task.externalEventId,
          title: task.text || "Task",
          description: "",
          startDate,
          endDate,
          isAllDay: !taskTimed,
          sourceUrl: task.calendarSourceUrl || "",
        } : undefined,
        cssClasses: ["bases-calendar-event", "is-task"],
        backgroundColor: color,
        borderColor: color,
      });
    }

    return entries;
  }

  private async refreshTaskItems(): Promise<void> {
    if (this.isFetchingTaskItems) return;
    this.isFetchingTaskItems = true;
    try {
      this.cachedRawTaskItems = await parseAllTaskItems(
        this.app,
        this.plugin.settings.taskItemFolderFilter || "",
        this.taskItemAllowedPaths,
      );
      this.lastTaskItemsFetch = Date.now();
      if (this.plugin.settings.showTaskItems) {
        this.debouncedRefresh();
      }
    } catch (err) {
      logger.error("[CalendarView] Failed to fetch task items:", err);
    } finally {
      this.isFetchingTaskItems = false;
    }
  }

  public setEphemeralState(state: unknown): void {
    // State management could be extended for React component
  }

  public getEphemeralState(): unknown {
    return {};
  }

  // Helper methods
  private getWeekStartDay(dayName: string): number {
    const dayNameToNumber: Record<string, number> = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    return dayNameToNumber[dayName] ?? 1;
  }

  // private toggleHiddenEvents(): void {
  //   this.showHiddenEvents = !this.showHiddenEvents;
  //   this.config.set("showHiddenEvents", this.showHiddenEvents);
  //   this.renderReactCalendar();
  // }

  private normalizeCondenseLevel(value: number): number {
    return Math.max(0, Math.min(MAX_CONDENSE_LEVEL, value));
  }

  private normalizeHour(value: string): string {
    if (!value) return "";

    const trimmed = value.trim();

    // If it's just a number (e.g., "4" or "20"), convert to HH:MM:SS format
    if (/^\d+$/.test(trimmed)) {
      const hour = parseInt(trimmed, 10);
      if (hour >= 0 && hour <= 24) {
        return `${String(hour).padStart(2, "0")}:00:00`;
      }
      return "";
    }

    // Validate HH:MM or HH:MM:SS format
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
    if (!timeRegex.test(trimmed)) {
      return "";
    }

    // Ensure seconds are present for FullCalendar
    if (trimmed.length === 5) {
      return `${trimmed}:00`;
    }
    return trimmed;
  }

  private normalizeConfiguredPropertyId(value: unknown): BasesPropertyId | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return (trimmed.includes(".") ? trimmed : `note.${trimmed}`) as BasesPropertyId;
  }

  private getStartDatePropsInPriorityOrder(): BasesPropertyId[] {
    const props: BasesPropertyId[] = [];
    const seen = new Set<string>();
    const push = (enabled: boolean, propId: BasesPropertyId | null) => {
      if (!enabled) return;
      if (!propId || typeof propId !== "string") return;
      const normalized = propId.trim();
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      props.push(normalized as BasesPropertyId);
    };

    push(this.includePrimaryDateSource, this.startDateProp);
    push(this.includeSecondaryDateSource, this.secondaryStartDateProp);
    push(this.includeTertiaryDateSource, this.tertiaryStartDateProp);
    return props;
  }

  private getStartDateNoteFields(): string[] {
    const fields: string[] = [];
    const seen = new Set<string>();
    for (const propId of this.getStartDatePropsInPriorityOrder()) {
      const field = this.getNoteField(propId);
      if (!field) continue;
      const normalized = field.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      fields.push(field);
    }
    return fields;
  }

  private resolveEntryStartDate(entry: BasesEntry): ResolvedEntryStartDate | null {
    const dailyFormat = this.getDailyNoteDateFormat();
    const sources: Array<{ slot: StartDateSourceSlot; propId: BasesPropertyId | null; enabled: boolean }> = [
      { slot: "primary", propId: this.startDateProp, enabled: this.includePrimaryDateSource },
      { slot: "secondary", propId: this.secondaryStartDateProp, enabled: this.includeSecondaryDateSource },
      { slot: "tertiary", propId: this.tertiaryStartDateProp, enabled: this.includeTertiaryDateSource },
    ];
    for (const source of sources) {
      if (!source.enabled || !source.propId) continue;
      const rawValue = this.tryGetEntryValue(entry, source.propId);
      const resolved = extractDate(entry, source.propId, dailyFormat);
      if (resolved) {
        return {
          date: resolved,
          slot: source.slot,
          isDateOnly: this.isDateOnlyValue(rawValue),
        };
      }
    }

    const entryFile = entry.file;
    const allDayFieldName = this.getNoteField(this.allDayProperty);
    if (entryFile instanceof TFile && allDayFieldName) {
      const cache = this.app.metadataCache.getFileCache(entryFile);
      const isAllDay = this.parseBooleanLike(
        this.getFrontmatterValueCaseInsensitive(cache?.frontmatter as Record<string, any> | undefined, allDayFieldName),
        false,
      );
      if (isAllDay) {
        const parsedFromName = this.dateFromIsoDateOnly(this.parseFilenameComponents(entryFile.basename).dateSuffix);
        if (parsedFromName) {
          return {
            date: parsedFromName,
            slot: "primary",
            isDateOnly: true,
          };
        }
      }
    }
    return null;
  }

  private getSourceDurationMinutes(slot: StartDateSourceSlot): number | null {
    if (slot === "primary") return this.primaryDurationMinutes;
    if (slot === "secondary") return this.secondaryDurationMinutes;
    return this.tertiaryDurationMinutes;
  }

  private tryGetEntryValue(entry: BasesEntry, propId: BasesPropertyId): Value | null {
    try {
      return entry.getValue(propId);
    } catch {
      return null;
    }
  }

  private isDateOnlyValue(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") {
      return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
    }
    if (typeof value === "object") {
      const anyValue = value as any;
      if (anyValue.date instanceof Date && anyValue.time === false) {
        return true;
      }
      if (Array.isArray(anyValue.data) && anyValue.data.length > 0) {
        return this.isDateOnlyValue(anyValue.data[0]);
      }
      if ("data" in anyValue) {
        return this.isDateOnlyValue(anyValue.data);
      }
    }
    return false;
  }

  private getNoteField(propId: BasesPropertyId | null): string | null {
    if (!propId) return null;

    if (typeof propId === 'string' && !propId.includes('.')) {
      return propId;
    }

    // Handle object directly
    if (typeof propId === 'object' && propId !== null && 'key' in propId) {
      return (propId as any).key;
    }

    const parsed = parsePropertyId(propId);
    const propertyName = parsed.name || (parsed as any).property;

    // Return the property name regardless of type (note or formula)
    // Formula properties are computed, but we write to the underlying note property
    if (parsed.type === "note" || parsed.type === "formula") {
      return propertyName || null;
    }

    return propertyName || null;
  }

  private getFieldFromPropertyId(propId: BasesPropertyId | null): string | null {
    if (!propId) return null;
    const parsed = parsePropertyId(propId);
    return parsed.name || (parsed as any).property || null;
  }

  private normalizeIdentityValue(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
  }

  private getFrontmatterValueCaseInsensitive(
    frontmatter: Record<string, any> | undefined | null,
    key: string | null | undefined,
  ): unknown {
    if (!frontmatter || !key) return undefined;
    const normalizedKey = String(key).trim().toLowerCase();
    if (!normalizedKey) return undefined;

    if (key in frontmatter) {
      return frontmatter[key];
    }
    const match = Object.keys(frontmatter).find(
      (candidate) => candidate.trim().toLowerCase() === normalizedKey,
    );
    return match ? frontmatter[match] : undefined;
  }

  private getFrontmatterStringCaseInsensitive(
    frontmatter: Record<string, any> | undefined | null,
    key: string | null | undefined,
  ): string | null {
    const value = this.getFrontmatterValueCaseInsensitive(frontmatter, key);
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text ? text : null;
  }

  private resolveFrontmatterEventColor(
    frontmatter: Record<string, any> | undefined | null,
  ): string | null {
    const keys = [
      this.plugin.settings.frontmatterColorField,
      "color",
      "iconColor",
    ].filter((value): value is string => Boolean(value));

    for (const key of keys) {
      const value = this.getFrontmatterStringCaseInsensitive(frontmatter, key);
      if (value) return value;
    }
    return null;
  }

  private resolveFrontmatterEventIcon(
    frontmatter: Record<string, any> | undefined | null,
  ): string | null {
    const keys = [
      this.plugin.settings.frontmatterIconField,
      "icon",
    ].filter((value): value is string => Boolean(value));

    for (const key of keys) {
      const value = this.getFrontmatterStringCaseInsensitive(frontmatter, key);
      if (!value) continue;
      const normalized = value.replace(/^lucide[:\-]/i, "").trim();
      if (normalized) return normalized;
    }
    return null;
  }

  private resolveFrontmatterEventIconColor(
    frontmatter: Record<string, any> | undefined | null,
    fallbackColor: string,
  ): string {
    return this.getFrontmatterStringCaseInsensitive(frontmatter, "iconColor")
      || this.resolveFrontmatterEventColor(frontmatter)
      || fallbackColor;
  }

  private parseFrontmatterDateValue(value: unknown): Date | null {
    // Handle Obsidian Bases { date: Date, time?: boolean } value objects.
    // When time === false the Date is UTC midnight from a date-only ISO string;
    // re-anchor to local midnight so the calendar shows the correct day.
    if (
      typeof value === "object" &&
      value !== null &&
      "date" in value &&
      (value as any)["date"] instanceof Date
    ) {
      const d = (value as any)["date"] as Date;
      if ((value as any)["time"] === false) {
        return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      }
      return new Date(d.getTime());
    }
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return new Date(value.getTime());
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const numericDate = new Date(value);
      return Number.isNaN(numericDate.getTime()) ? null : numericDate;
    }
    if (typeof value !== "string") return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    let normalized = trimmed;
    if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      normalized = `${normalized}T00:00:00`;
    } else if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(normalized)) {
      normalized = normalized.replace(/\s+/, "T");
    }

    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
    return null;
  }

  private extractUidFromCompositeEventId(eventId: string | null | undefined): string | null {
    const normalized = String(eventId || "").trim();
    if (!normalized) return null;

    // Matches recurring IDs like "<uid>-<timestamp>" and "<uid>-dup-<timestamp>".
    const match = normalized.match(/^(.*?)(?:-dup)?-\d{10,}$/);
    if (match?.[1]) {
      return match[1];
    }
    return normalized;
  }

  private extractRecurrenceDateFromEventId(eventId: string | null | undefined): Date | null {
    const normalized = String(eventId || "").trim();
    if (!normalized) return null;

    const match = normalized.match(/(?:-dup-|-)(\d{10,})$/);
    if (!match?.[1]) return null;

    const timestamp = Number.parseInt(match[1], 10);
    if (!Number.isFinite(timestamp)) return null;
    const parsed = new Date(timestamp);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private toRoundedMinuteTimestamp(date: Date | null | undefined): number | null {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
    const rounded = new Date(date.getTime());
    rounded.setSeconds(0, 0);
    return rounded.getTime();
  }

  private areDatesLikelySameSlot(left: Date | null | undefined, right: Date | null | undefined): boolean {
    const leftTs = this.toRoundedMinuteTimestamp(left);
    const rightTs = this.toRoundedMinuteTimestamp(right);
    if (leftTs === null || rightTs === null) return false;

    if (Math.abs(leftTs - rightTs) <= 65 * 60 * 1000) {
      return true;
    }

    const leftDate = new Date(leftTs);
    const rightDate = new Date(rightTs);
    return (
      leftDate.getUTCDate() === rightDate.getUTCDate() &&
      leftDate.getUTCHours() === rightDate.getUTCHours() &&
      leftDate.getUTCMinutes() === rightDate.getUTCMinutes()
    );
  }

  private recordSuppressedUidStart(
    target: Map<string, number[]>,
    uid: string | null | undefined,
    date: Date | null,
  ): void {
    const normalizedUid = this.normalizeIdentityValue(uid);
    const timestamp = this.toRoundedMinuteTimestamp(date);
    if (!normalizedUid || timestamp === null) return;

    const existing = target.get(normalizedUid);
    if (!existing) {
      target.set(normalizedUid, [timestamp]);
      return;
    }
    if (!existing.includes(timestamp)) {
      existing.push(timestamp);
    }
  }

  private isExternalEventSuppressedByUidStart(
    event: ExternalCalendarEvent,
    suppressedByUid: Map<string, number[]>,
  ): boolean {
    const uid = this.normalizeIdentityValue(event.uid || this.extractUidFromCompositeEventId(event.id));
    if (!uid) return false;

    const suppressedTimestamps = suppressedByUid.get(uid);
    if (!suppressedTimestamps?.length) return false;

    const eventTimestamp = this.toRoundedMinuteTimestamp(event.startDate);
    if (eventTimestamp === null) return false;

    for (const suppressedTimestamp of suppressedTimestamps) {
      if (Math.abs(suppressedTimestamp - eventTimestamp) <= 65 * 60 * 1000) {
        return true;
      }

      const suppressedDate = new Date(suppressedTimestamp);
      const eventDate = new Date(eventTimestamp);
      if (
        suppressedDate.getUTCDate() === eventDate.getUTCDate() &&
        suppressedDate.getUTCHours() === eventDate.getUTCHours() &&
        suppressedDate.getUTCMinutes() === eventDate.getUTCMinutes()
      ) {
        return true;
      }
    }

    return false;
  }

  private getSlotRange(): { min: string; max: string } | undefined {
    if (!this.minHour && !this.maxHour) {
      return undefined;
    }
    return {
      min: this.minHour || "00:00:00",
      max: this.maxHour || "24:00:00",
    };
  }

  private computeInitialDate(): Date {
    const baseDate = this.currentDate ?? new Date();
    const effectiveDayCount =
      this.viewMode === "day" ? 1 :
        this.viewMode === "3d" ? 3 :
          this.viewMode === "4d" ? 4 :
          this.viewMode === "5d" ? 5 :
            this.viewMode === "7d" ? 7 :
              this.viewMode === "week" ? 7 :
                30;
    if (effectiveDayCount >= 30 || this.viewMode === "week") {
      return baseDate;
    }
    const normalizedDays = Math.max(1, effectiveDayCount);
    const offset = Math.floor((normalizedDays - 1) / 2);
    const start = new Date(baseDate);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - offset);
    return start;
  }

  private parseNumberConfig(value: unknown, fallback: number): number {
    let parsedValue: number | null = null;
    if (typeof value === "number" && Number.isFinite(value)) {
      parsedValue = Math.round(value);
    } else if (typeof value === "string" && value.trim().length > 0) {
      const numeric = parseInt(value, 10);
      if (!Number.isNaN(numeric)) {
        parsedValue = numeric;
      }
    }
    if (parsedValue === null || !Number.isFinite(parsedValue)) {
      return fallback;
    }
    return Math.max(1, parsedValue);
  }

  private parseBooleanLike(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(normalized)) return true;
      if (["false", "no", "n", "0"].includes(normalized)) return false;
      const firstToken = normalized.split(/\s+/)[0];
      if (["true", "yes", "y", "1"].includes(firstToken)) return true;
      if (["false", "no", "n", "0"].includes(firstToken)) return false;
    }
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
    }
    return fallback;
  }

  private parseOptionalDurationMinutes(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === "string" && value.trim().length === 0) return null;
    const parsed = this.parseNumberConfig(value, 0);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  }

  private getMinimumEventDurationMinutes(): number {
    const snap = this.parseNumberConfig(this.plugin.settings.snapDuration, 5);
    return Math.max(1, snap);
  }

  private normalizeCalendarViewMode(
    value: unknown,
    fallback: CalendarViewMode | undefined,
  ): CalendarViewMode | undefined {
    const raw = String(value ?? "").trim().toLowerCase();
    const validModes: CalendarViewMode[] = [
      "day",
      "3d",
      "4d",
      "5d",
      "7d",
      "week",
      "month",
      "continuous",
      "filter-based",
    ];
    if (validModes.includes(raw as CalendarViewMode)) {
      return raw as CalendarViewMode;
    }
    return fallback;
  }

  private getGlobalDefaultViewMode(): CalendarViewMode {
    return this.normalizeCalendarViewMode(this.plugin.settings.viewMode, "week") || "week";
  }

  private resolveConfiguredViewMode(): CalendarViewMode {
    const fromViewConfig = this.resolveViewConfigMode();
    if (fromViewConfig) {
      return fromViewConfig;
    }
    return this.getGlobalDefaultViewMode();
  }

  private resolveViewConfigMode(): CalendarViewMode | undefined {
    return (
      this.normalizeCalendarViewMode(this.config.get("viewMode"), undefined)
      ?? this.normalizeCalendarViewMode(this.config.get("viewmode"), undefined)
    );
  }

  private resolveStoredViewMode(): CalendarViewMode | undefined {
    const viewMode =
      this.normalizeCalendarViewMode(this.config.get("viewMode"), undefined)
      ?? this.normalizeCalendarViewMode(this.config.get("viewmode"), undefined);
    const tpsViewMode = this.normalizeCalendarViewMode(this.config.get("tps_viewMode"), undefined);
    if (viewMode && viewMode !== "filter-based") {
      return viewMode;
    }
    if (tpsViewMode) {
      return tpsViewMode;
    }
    return viewMode;
  }

  private parseExternalCalendarUrls(raw: string): string[] {
    if (!raw) return [];
    return raw
      .split(/[\n,]/)
      .map((segment) => segment.trim())
      .filter(Boolean);
  }

  private parseFilterTerms(raw: string): string[] {
    if (!raw) return [];
    return raw
      .split(/[\n,]/)
      .map((segment) => segment.trim().toLowerCase())
      .filter(Boolean);
  }


  private getInitialDate(): Date {
    return this.currentDate ?? new Date();
  }

  /**
   * Debounced save of currentDate to per-view config for cross-device persistence.
   * Uses a 1-second debounce to avoid excessive writes during rapid navigation.
   */
  private persistCurrentDate(date: Date): void {
    if (this.saveDateTimeout) {
      clearTimeout(this.saveDateTimeout);
    }
    this.saveDateTimeout = setTimeout(() => {
      const iso = date.toISOString();
      this.config.set("tps_currentDate", iso);
      this.saveDateTimeout = null;
    }, 1000);
  }

  private updateCondenseLevel(level: number): void {
    const normalized = this.normalizeCondenseLevel(level);
    this.condenseLevel = normalized;
    this.config.set("condenseLevel", normalized);
    this.renderReactCalendar();
  }

  private passesNameFilters(names: Array<string | null | undefined>): boolean {
    try {
      const haystacks = names
        .filter((value): value is string => !!value)
        .map((value) => value.toLowerCase());

      if (haystacks.length === 0) {
        return true;
      }

      const filterSources = [
        // this.config.get("filters"), // Already handled by controller.getEntries()
        (this.config as any).viewFilters,
        (this.config as any).filtersAll,
      ];

      // If a name/path is present, require that all applicable name filters pass.
      for (const candidate of filterSources) {
        const { applied, result } = this.evaluateNameFilter(candidate, haystacks);
        if (applied && !result) {
          return false;
        }
      }
      return true;
    } catch (error) {
      logger.warn("[CalendarView] Error evaluating name filters:", error);
      return true;
    }
  }

  private evaluateNameFilter(
    filter: unknown,
    haystacks: string[],
  ): { applied: boolean; result: boolean } {
    const matchesValue = (haystack: string, needle: string | RegExp): boolean => {
      if (needle instanceof RegExp) {
        return needle.test(haystack);
      }
      return haystack.includes(needle.toLowerCase());
    };

    const evalNode = (node: any): { applied: boolean; result: boolean } => {
      if (!node) return { applied: false, result: true };

      if (typeof node === "object" && "data" in node) {
        return evalNode((node as any).data);
      }

      // Array = all must pass (AND)
      if (Array.isArray(node)) {
        let anyApplied = false;
        let allPass = true;
        for (const child of node) {
          const res = evalNode(child);
          if (res.applied) {
            anyApplied = true;
            allPass = allPass && res.result;
          }
        }
        return { applied: anyApplied, result: anyApplied ? allPass : true };
      }

      // Simple string/regex: include only if name matches
      if (typeof node === "string" || node instanceof RegExp) {
        const needle = node instanceof RegExp ? node : node.trim().toLowerCase();
        if (!needle) return { applied: false, result: true };
        const matched = haystacks.some((value) => matchesValue(value, needle));
        return { applied: true, result: matched };
      }

      if (typeof node !== "object") {
        return { applied: false, result: true };
      }

      // Group filters: look for logical operator
      if (Array.isArray((node as any).children)) {
        const mode = String((node as any).type || (node as any).operator || "").toLowerCase();
        const isOr = mode.includes("or");
        let anyApplied = false;
        let result = isOr ? false : true;
        for (const child of (node as any).children) {
          const res = evalNode(child);
          if (res.applied) {
            anyApplied = true;
            if (isOr) {
              result = result || res.result;
            } else {
              result = result && res.result;
            }
          }
        }
        return { applied: anyApplied, result: anyApplied ? result : true };
      }

      const propertyRaw = String((node as any).property || (node as any).field || "").toLowerCase();
      const property = propertyRaw.replace(/\s+/g, "");
      let value = (node as any).value ?? (node as any).pattern ?? (node as any).match;
      if (value && typeof value === "object" && "value" in value) {
        value = (value as any).value;
      }
      const operatorRaw = String((node as any).op || (node as any).operator || "").toLowerCase().replace(/\s+/g, "");

      const isNameProperty =
        property.includes("title") ||
        property.includes("name") ||
        property.includes("filename") ||
        property.includes("filepath") ||
        property === "file" ||
        property.includes("file.name") ||
        property.includes("path");

      if (!isNameProperty || value === undefined || value === null) {
        return { applied: false, result: true };
      }

      const valueStr = typeof value === "string" ? value.trim() : "";
      const valueRegex = value instanceof RegExp ? value : null;
      if (!valueStr && !valueRegex) {
        return { applied: false, result: true };
      }

      const op = operatorRaw || "contains";
      const matches = haystacks.some((haystack) =>
        matchesValue(haystack, valueRegex ?? valueStr),
      );

      if (op.includes("doesnot") || op.includes("not") || op.includes("!=") || op.includes("isnot")) {
        return { applied: true, result: !matches };
      }
      if (op.includes("equals") || op === "=") {
        const equalsMatch = haystacks.some((haystack) => haystack === valueStr.toLowerCase());
        return { applied: true, result: equalsMatch };
      }
      if (op.includes("starts")) {
        const startsMatch = haystacks.some((haystack) => haystack.startsWith(valueStr.toLowerCase()));
        return { applied: true, result: startsMatch };
      }
      if (op.includes("ends")) {
        const endsMatch = haystacks.some((haystack) => haystack.endsWith(valueStr.toLowerCase()));
        return { applied: true, result: endsMatch };
      }

      // Default: contains
      return { applied: true, result: matches };
    };

    return evalNode(filter);
  }

  /**
   * Returns the TFile for the workspace leaf that contains this view's container.
   * Checks the controller first, then falls back to iterating workspace leaves.
   * Used by both readBaseFileFilters() and findParentNotePath().
   */
  private resolveContainerLeafFile(): TFile | null {
    // Cheap: check if the controller exposes the file directly.
    const ctrl = this.controller as any;
    const ctrlFile = ctrl.file ?? ctrl.sourceFile ?? ctrl.baseFile ?? null;
    if (ctrlFile instanceof TFile) return ctrlFile;

    // Embedded bases may not expose ctrl.file; try resolving from the embed DOM wrapper.
    const embedHost = this.containerEl.closest(".internal-embed") as HTMLElement | null;
    if (embedHost) {
      const rawSrc =
        embedHost.getAttribute("src") ||
        embedHost.getAttribute("data-href") ||
        embedHost.getAttribute("href") ||
        "";
      const normalizedSrc = rawSrc
        .replace(/^!\[\[/, "")
        .replace(/\]\]$/, "")
        .split("|")[0]
        .split("#")[0]
        .trim();
      if (normalizedSrc) {
        const activePath = (this.app.workspace.getActiveFile() as TFile | null)?.path || "";
        const fromController = (ctrl.currentFile as TFile | null)?.path || "";
        const candidates = [activePath, fromController, ""];
        for (const sourcePath of candidates) {
          const resolved = this.app.metadataCache.getFirstLinkpathDest(normalizedSrc, sourcePath);
          if (resolved instanceof TFile) return resolved;
        }
        const direct = this.app.vault.getAbstractFileByPath(normalizedSrc);
        if (direct instanceof TFile) return direct;
      }
    }

    // Walk workspace leaves to find the one whose container wraps this view.
    const leafEl = this.containerEl.closest('.workspace-leaf');
    if (!leafEl) return null;

    let found: TFile | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (found) return;
      const leafContainer = (leaf as any).containerEl as HTMLElement | undefined;
      if (
        leafContainer &&
        (leafContainer === leafEl ||
          leafEl.contains(leafContainer) ||
          leafContainer.contains(leafEl as any))
      ) {
        const f = (leaf.view as any).file;
        if (f instanceof TFile) found = f;
      }
    });
    return found;
  }

  /**
   * Reads and returns the top-level `filters:` block from the .base file that
   * hosts this calendar view. Returns null if the file cannot be resolved.
   */
  private async readBaseFileFilters(): Promise<unknown> {
    try {
      const baseFile = this.resolveContainerLeafFile();
      if (!baseFile) return null;
      const content = await this.app.vault.cachedRead(baseFile);
      const parsed = parseYaml(content);
      return parsed?.filters ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Derives a creation folder path and frontmatter defaults from the base file's
   * top-level filters.  Callers that run in an async context should pass
   * `baseFilters` obtained via `readBaseFileFilters()` so the full base-level
   * filter tree is available.  When not provided (e.g. the sync loadConfig call)
   * only frontmatter defaults are derived; folder detection is skipped.
   */
  private getFilterCreationDefaults(baseFilters?: unknown): {
    folderPath: string | null;
    frontmatter: Record<string, any>;
  } {
    const filterSources = this.getCalendarFilterSources(baseFilters != null ? [baseFilters] : []);
    let folderPath: string | null = null;
    const frontmatter: Record<string, any> = {};

    for (const source of filterSources) {
      if (!folderPath) {
        folderPath = this.extractFolderFromTopLevelFilters(source);
      }
      Object.assign(frontmatter, this.extractFrontmatterDefaults(source));
    }

    logger.log("[CalendarView] Creation defaults resolved", {
      folderPath,
      sourceCount: filterSources.length,
      frontmatterKeys: Object.keys(frontmatter),
    });

    return { folderPath, frontmatter };
  }

  /**
   * Extracts a target creation folder from a filter tree.
   * When the top level is an "or", the first group that contains a positive
   * folder/path assertion wins (matching how the filter logically identifies
   * a primary bucket). Negated conditions are never used as folder hints.
   */
  private extractFolderFromTopLevelFilters(filters: unknown): string | null {
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) return null;
    const node = filters as Record<string, any>;

    // Top-level "or": first group with a positive folder assertion wins.
    if (Array.isArray(node.or)) {
      for (const group of node.or) {
        const folder = this.extractFolderFromPositiveConditions(group);
        if (folder) return folder;
      }
      return null;
    }

    // "and" or flat: search all positive conditions.
    return this.extractFolderFromPositiveConditions(filters);
  }

  /** Collect only positive conditions from a node and return the first derived folder. */
  private extractFolderFromPositiveConditions(node: unknown): string | null {
    const conditions = this.collectPositiveFilterConditions(node);
    for (const condition of conditions) {
      const folder = this.deriveFolderPathFromCondition(condition);
      if (folder) return folder;
    }
    return null;
  }

  /**
   * Collects only positive equality conditions from a filter tree.
   * Specifically:
   * - Inline string expressions starting with "!" are skipped.
   * - Object branches keyed on "not" are skipped entirely.
   * - Conditions whose operator is negative (!=, does not contain, …) are dropped.
   * This is intentionally more restrictive than collectFilterConditions(), which
   * is used for date-range analysis where negations are meaningful.
   */
  private collectPositiveFilterConditions(
    filters: unknown,
  ): Array<{ property: string; operator: string; value: unknown }> {
    const conditions: Array<{ property: string; operator: string; value: unknown }> = [];
    const visit = (n: any) => {
      if (!n) return;
      if (typeof n === "string") {
        if (n.trim().startsWith("!")) return; // skip negated inline expressions
        const parsed = this.parseInlineFilterCondition(n.trim());
        if (parsed && this.isPositiveEqualityOp(parsed.operator)) conditions.push(parsed);
        return;
      }
      if (typeof n === "object" && "data" in n) { visit(n.data); return; }
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (typeof n !== "object") return;
      if ("not" in n) return; // skip not-branches entirely
      for (const key of ["and", "or", "all", "any", "filters"]) {
        if (key in n) visit((n as any)[key]);
      }
      if (Array.isArray((n as any).children)) (n as any).children.forEach(visit);
      // Direct condition node
      const rawProp =
        (n as any).property ??
        (n as any).field ??
        (n as any).key ??
        (n as any).column ??
        (n as any).left ??
        (n as any).lhs ??
        (n as any).operand ??
        null;
      const property =
        typeof rawProp === "string" ? rawProp.trim()
        : rawProp && typeof rawProp === "object"
          ? String(
            (rawProp as any).property ??
            (rawProp as any).name ??
            (rawProp as any).key ??
            (rawProp as any).field ??
            (rawProp as any).id ??
            (rawProp as any).label ??
            (rawProp as any).column ??
            "",
          ).trim()
          : "";
      if (!property) return;
      const rawOp =
        (n as any).op ??
        (n as any).operator ??
        (n as any).comparison ??
        (n as any).type ??
        (n as any).condition;
      const operator =
        typeof rawOp === "string" ? rawOp.trim()
        : rawOp && typeof rawOp === "object"
          ? String(
            (rawOp as any).operator ??
            (rawOp as any).op ??
            (rawOp as any).name ??
            (rawOp as any).id ??
            (rawOp as any).label ??
            (rawOp as any).type ??
            "",
          ).trim()
          : "";
      if (!this.isPositiveEqualityOp(operator)) return;
      let value =
        (n as any).value ??
        (n as any).pattern ??
        (n as any).match ??
        (n as any).right ??
        (n as any).rhs ??
        (n as any).target ??
        (n as any).literal;
      if (value && typeof value === "object" && "value" in value) value = (value as any).value;
      conditions.push({ property, operator, value });
    };
    visit(filters);
    return conditions;
  }

  private deriveFolderPathFromCondition(condition: {
    property: string;
    operator: string;
    value: unknown;
  }): string | null {
    const property = condition.property.toLowerCase();
    const value = normalizeFilterValue(condition.value);
    if (!value) return null;

    // Direct folder equality is the highest-confidence signal.
    if (property.includes("folder") && this.isPositiveEqualityOp(condition.operator)) {
      const normalized = normalizePath(value).replace(/\/+$/, "");
      return normalized || null;
    }

    // Support file-path prefixes/equality as an implicit folder target.
    if (property.includes("path")) {
      const op = condition.operator.toLowerCase().replace(/\s+/g, "");
      const isPrefix = op.includes("starts");
      const isEquality = this.isPositiveEqualityOp(condition.operator);
      if (!isPrefix && !isEquality) {
        return null;
      }

      const normalized = normalizePath(value)
        .replace(/[*?].*$/, "")
        .replace(/\/+$/, "");
      if (!normalized) {
        return null;
      }

      if (normalized.toLowerCase().endsWith(".md")) {
        const slashIndex = normalized.lastIndexOf("/");
        if (slashIndex <= 0) {
          return null;
        }
        return normalized.slice(0, slashIndex);
      }

      return normalized;
    }

    return null;
  }

  private extractFrontmatterDefaults(filters: unknown): Record<string, any> {
    const defaults: Record<string, any> = {};
    const conditions = this.collectFilterConditions(filters);
    for (const condition of conditions) {
      const propertyRaw = condition.property.trim();
      if (!propertyRaw) continue;
      const property = propertyRaw.toLowerCase();

      if (
        property.includes("file.") ||
        property.includes("path") ||
        property.includes("folder") ||
        property.includes("name") ||
        property.includes("title")
      ) {
        continue;
      }

      if (!this.isPositiveEqualityOp(condition.operator)) continue;
      const value = normalizeFilterValue(condition.value);
      if (value === null) continue;

      const key = propertyRaw.startsWith("note.")
        ? propertyRaw.slice(5)
        : propertyRaw;
      if (!key.trim()) continue;
      defaults[key.trim()] = value;
    }
    return defaults;
  }

  private collectFilterConditions(filters: unknown): Array<{ property: string; operator: string; value: unknown }> {
    const conditions: Array<{ property: string; operator: string; value: unknown }> = [];
    const visited = new WeakSet<object>();
    const isPlainObject = (value: unknown): value is Record<string, unknown> => {
      if (!value || typeof value !== "object") return false;
      const proto = Object.getPrototypeOf(value);
      return proto === Object.prototype || proto === null;
    };
    const visit = (node: any) => {
      if (!node) return;
      if (typeof node === "string") {
        const parsed = this.parseInlineFilterCondition(node);
        if (parsed) {
          conditions.push(parsed);
        }
        return;
      }
      if (typeof node === "object" && "data" in node) {
        visit(node.data);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node !== "object") return;
      // Only recurse through plain JSON-like nodes to avoid traversing plugin/runtime objects.
      if (!isPlainObject(node)) return;
      if (visited.has(node)) return;
      visited.add(node);

      // Expression-style filters may be serialized as a single inline string
      // (for example under "expression"/"expr"/"query") without property/op/value keys.
      const inlineSources: unknown[] = [
        (node as any).expression,
        (node as any).expr,
        (node as any).query,
        (node as any).code,
        (node as any).source,
      ];
      const rawInlineValue =
        (node as any).value ??
        (node as any).text ??
        (node as any).raw ??
        null;
      if (typeof rawInlineValue === "string") {
        inlineSources.push(rawInlineValue);
      } else if (rawInlineValue && typeof rawInlineValue === "object") {
        inlineSources.push(
          (rawInlineValue as any).value,
          (rawInlineValue as any).text,
          (rawInlineValue as any).raw,
          (rawInlineValue as any).expression,
          (rawInlineValue as any).expr,
          (rawInlineValue as any).query,
          (rawInlineValue as any).code,
          (rawInlineValue as any).source,
        );
      }
      for (const inline of inlineSources) {
        if (typeof inline !== "string") continue;
        const parsed = this.parseInlineFilterCondition(inline);
        if (parsed) {
          conditions.push(parsed);
          break;
        }
      }

      // Logical tree containers used by .base files and Bases UI structures.
      const logicalKeys = ["and", "or", "not", "all", "any", "filters"];
      for (const key of logicalKeys) {
        if (key in node) {
          visit((node as any)[key]);
        }
      }

      if (Array.isArray((node as any).children)) {
        (node as any).children.forEach(visit);
      }

      // Fallback recursion for unknown schemas used by Bases internal filter trees.
      // Skip direct condition payload keys to avoid noisy duplicate visits.
      const skipKeys = new Set([
        "property", "field", "key", "column",
        "op", "operator", "comparison",
        "value", "pattern", "match",
        "expression", "expr", "query", "code", "source", "text", "raw",
      ]);
      try {
        for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
          if (skipKeys.has(key)) continue;
          if (!value) continue;
          if (Array.isArray(value)) {
            visit(value);
            continue;
          }
          if (typeof value === "string") {
            visit(value);
            continue;
          }
          if (isPlainObject(value)) {
            visit(value);
          }
        }
      } catch (error) {
        logger.warn("[CalendarView] Skipped unsafe filter node during traversal:", error);
      }

      const rawProperty =
        (node as any).property ??
        (node as any).field ??
        (node as any).key ??
        (node as any).column ??
        (node as any).left ??
        (node as any).lhs ??
        (node as any).operand ??
        null;
      const property =
        typeof rawProperty === "string"
          ? rawProperty.trim()
          : rawProperty && typeof rawProperty === "object"
            ? String(
              (rawProperty as any).property ??
              (rawProperty as any).name ??
              (rawProperty as any).key ??
              (rawProperty as any).field ??
              (rawProperty as any).id ??
              (rawProperty as any).label ??
              (rawProperty as any).column ??
              "",
            ).trim()
            : "";
      if (!property) return;
      let value =
        (node as any).value ??
        (node as any).pattern ??
        (node as any).match ??
        (node as any).right ??
        (node as any).rhs ??
        (node as any).target ??
        (node as any).literal;
      if (value && typeof value === "object" && "value" in value) {
        value = (value as any).value;
      }
      const rawOperator =
        (node as any).op ??
        (node as any).operator ??
        (node as any).comparison ??
        (node as any).type ??
        (node as any).condition;
      const operator =
        typeof rawOperator === "string"
          ? rawOperator.trim()
          : rawOperator && typeof rawOperator === "object"
            ? String(
              (rawOperator as any).operator ??
              (rawOperator as any).op ??
              (rawOperator as any).name ??
              (rawOperator as any).label ??
              (rawOperator as any).type ??
              (rawOperator as any).id ??
              "",
            ).trim()
            : "";
      conditions.push({ property, operator, value });
    };
    visit(filters);
    return conditions;
  }

  private parseInlineFilterCondition(
    expression: string,
  ): { property: string; operator: string; value: unknown } | null {
    const trimmed = String(expression || "").trim();
    if (!trimmed) return null;

    // Example: !file.path.contains("System")
    const negContainsMatch = trimmed.match(/^!\s*([\w.]+)\.contains\((.+)\)\s*$/i);
    if (negContainsMatch) {
      return {
        property: negContainsMatch[1],
        operator: "does not contain",
        value: stripOuterQuotes(negContainsMatch[2].trim()),
      };
    }

    // Example: file.path.contains("System")
    const containsMatch = trimmed.match(/^([\w.]+)\.contains\((.+)\)\s*$/i);
    if (containsMatch) {
      return {
        property: containsMatch[1],
        operator: "contains",
        value: stripOuterQuotes(containsMatch[2].trim()),
      };
    }

    // Example: scheduled > today() - duration("2 days")
    const comparisonMatch = trimmed.match(/^([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (comparisonMatch) {
      return {
        property: comparisonMatch[1],
        operator: comparisonMatch[2],
        value: stripOuterQuotes(comparisonMatch[3].trim()),
      };
    }

    // Example: folder is "Markdown/Action Items"
    const textualMatch = trimmed.match(/^([\w.]+)\s+(is|equals?)\s+(.+)$/i);
    if (textualMatch) {
      return {
        property: textualMatch[1],
        operator: textualMatch[2],
        value: stripOuterQuotes(textualMatch[3].trim()),
      };
    }

    // Example: folder is not "System"
    const textualNegativeMatch = trimmed.match(/^([\w.]+)\s+(is\s+not|does\s+not\s+equal|not\s+equals?)\s+(.+)$/i);
    if (textualNegativeMatch) {
      return {
        property: textualNegativeMatch[1],
        operator: textualNegativeMatch[2],
        value: stripOuterQuotes(textualNegativeMatch[3].trim()),
      };
    }

    return null;
  }

  private isPositiveEqualityOp(operator: string): boolean {
    const op = operator.toLowerCase().replace(/\s+/g, "");
    if (!op) return true;
    if (op.includes("not") || op.includes("!=") || op.includes("doesnot")) return false;
    return op.includes("is") || op.includes("equals") || op === "=" || op === "==";
  }

  private toggleFullDay(): void {
    this.showFullDay = !this.showFullDay;
    this.config.set("showFullDay", this.showFullDay);
    this.renderReactCalendar();
  }

  private hasEntryForFile(path: string): boolean {
    return this.entries.some((e) => e.entry.file.path === path);
  }

  private fastRefreshEntry(file: TFile, cache: CachedMetadata): boolean {
    try {
      const index = this.entries.findIndex(e => e.entry.file && e.entry.file.path === file.path);
      if (index === -1) return false;

      const entry = this.entries[index];

      // Skip time log entries - they have their own color handling
      if (entry.status === 'log') return true;

      // Re-read status and priority from fresh cache
      let statusValue: any = null;
      let priorityValue: any = null;

      if (this.statusField) {
        const fieldName = this.getNoteField(this.statusField);
        if (fieldName) {
          statusValue = cache.frontmatter?.[fieldName];
        } else {
          // Fallback: try to get from entry if it's not a direct note property (less reliable for fast refresh but okay)
          statusValue = this.tryGetValue(entry.entry, this.statusField);
        }
      }

      if (this.priorityField) {
        const fieldName = this.getNoteField(this.priorityField);
        if (fieldName) {
          priorityValue = cache.frontmatter?.[fieldName];
        } else {
          priorityValue = this.tryGetValue(entry.entry, this.priorityField);
        }
      }

      // Resolve styles (Logic duplicated from updateCalendar for speed)
      const statusStr = statusValue ? String(statusValue) : undefined;
      const priorityStr = priorityValue ? String(priorityValue) : undefined;

      const cssClasses = ["bases-calendar-event"];
      // Local notes are never external in this view

      if (statusStr) {
        cssClasses.push(`bases-calendar-event-status-${statusStr}`);
      }

      const colorSource = this.plugin.settings.noteEventColorSource || "frontmatter";
      const iconSource = this.plugin.settings.noteEventIconSource || "frontmatter";
      const colorTarget = this.plugin.settings.noteEventFrontmatterColorTarget || "both";
      const applyFrontmatterColor = colorSource === "frontmatter" && colorTarget !== "off";
      const applyFrontmatterColorToCard =
        applyFrontmatterColor && (colorTarget === "card" || colorTarget === "both");
      const applyFrontmatterColorToIcon =
        applyFrontmatterColor && (colorTarget === "icon" || colorTarget === "both");
      let backgroundColor = "";
      let borderColor = "";
      const frontmatterColor = this.resolveFrontmatterEventColor(cache?.frontmatter as Record<string, any> | undefined);
      if (colorSource !== "off" && applyFrontmatterColorToCard && frontmatterColor) {
        backgroundColor = frontmatterColor;
        borderColor = frontmatterColor;
      }

      // Update the entry in place
      entry.status = statusStr;
      entry.priority = priorityStr;
      entry.cssClasses = cssClasses;
      entry.backgroundColor = backgroundColor;
      entry.borderColor = borderColor;
      entry.iconName = iconSource === "frontmatter"
        ? (this.resolveFrontmatterEventIcon(cache?.frontmatter as Record<string, any> | undefined) || undefined)
        : undefined;
      entry.iconColor = iconSource === "frontmatter" && applyFrontmatterColorToIcon
        ? this.resolveFrontmatterEventIconColor(cache?.frontmatter as Record<string, any> | undefined, "")
        : undefined;

      // Force React update by creating a new array reference
      this.entries = [...this.entries];
      this.renderReactCalendar();

      return true;
    } catch (error) {
      logger.warn(`[CalendarView] Failed to fast refresh entry for ${file.path}:`, error);
      return false;
    }
  }

  private handleTrackedFileChange = (file: TFile, data: string, cache: CachedMetadata): void => {
    // We only care about TFiles
    if (!(file instanceof TFile)) return;

    if (this.isEditorFocused() && !this.isActiveLeaf()) {
      return;
    }

    const recentlyTyping = this.lastEditorChangeAt && Date.now() - this.lastEditorChangeAt < this.typingQuietWindowMs;
    if (recentlyTyping && !this.isActiveLeaf()) {
      return;
    }

    const nextFrontmatter = cache?.frontmatter ? JSON.stringify(cache.frontmatter) : "";
    const prevFrontmatter = this.lastFrontmatterByPath.get(file.path);
    if (prevFrontmatter === nextFrontmatter) {
      return;
    }
    this.lastFrontmatterByPath.set(file.path, nextFrontmatter);

    if (this.hasEntryForFile(file.path)) {
      // Try fast refresh first for immediate UI feedback
      const refreshed = this.fastRefreshEntry(file, cache);

      if (refreshed) {
        this.enqueueFastRefreshLog();
        // We still schedule a full refresh to handle date changes or other complex updates,
        // but the user sees the status change immediately.
        // Debounce the full refresh to avoid double-work if possible.
        this.scheduleRefresh(1000); // Longer delay for full refresh since we handled the visual part
      } else {
        this.scheduleRefresh();
      }
    }
  };

  private isActiveLeaf(): boolean {
    const activeLeaf = this.app.workspace.activeLeaf;
    const activeContainer = (activeLeaf?.view as any)?.containerEl as HTMLElement | undefined;
    if (!activeContainer) return false;
    return activeContainer.contains(this.containerEl);
  }

  private scheduleRefresh(delay = 120): void {
    if (!this.shouldProcessUpdates()) {
      return;
    }
    if (this.isEditorFocused() && !this.isActiveLeaf()) {
      return;
    }
    if (this.refreshTimeout !== null) {
      window.clearTimeout(this.refreshTimeout);
    }

    this.refreshTimeout = window.setTimeout(() => {
      const scrollPos = this.scrollEl.scrollTop;

      this.updateCalendar()
        .catch((error) => logger.error('[CalendarView] Error during scheduled refresh:', error))
        .finally(() => {
          this.scrollEl.scrollTop = scrollPos;
          this.refreshTimeout = null;
        });
    }, delay);
  }

  private enqueueFastRefreshLog(): void {
    this.pendingFastRefreshLogCount += 1;
    if (this.fastRefreshLogTimer !== null) {
      return;
    }

    this.fastRefreshLogTimer = window.setTimeout(() => {
      const count = this.pendingFastRefreshLogCount;
      this.pendingFastRefreshLogCount = 0;
      this.fastRefreshLogTimer = null;
      if (count === 1) {
        logger.log("[CalendarView] Fast refreshed 1 entry");
      } else {
        logger.log(`[CalendarView] Fast refreshed ${count} entries`);
      }
    }, 250);
  }

  private registerRefreshListeners(): void {
    // Use metadataCache for faster and more accurate updates on frontmatter changes
    this.registerEvent(
      this.app.metadataCache.on("changed", this.handleTrackedFileChange),
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", () => {
        this.lastEditorChangeAt = Date.now();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.isActiveLeaf()) {
          this.scheduleRefresh(0);
        }
      }),
    );
    // Keep rename to handle file moves
    this.registerEvent(
      this.app.vault.on("rename", (file) => {
        if (file instanceof TFile) this.scheduleRefresh();
      }),
    );

    // Delete handler
    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        if (file instanceof TFile) {
          this.updateCalendar();
        }
      })
    );

    // Listen for global plugin settings changes
    this.registerEvent(
      this.app.workspace.on("tps-calendar-settings-changed" as any, () => {
        this.refreshFromPluginSettings();
      }),
    );

    // Refresh when any plugin (GCM, Controller, Kanban, etc.) makes a bulk file edit
    // so status/icon/completedDate changes are reflected without waiting for next timer tick.
    this.registerEvent(
      this.app.workspace.on("tps-gcm-files-updated" as any, ((paths: string[] | undefined) => {
        if (!Array.isArray(paths) || paths.length === 0) return;
        this.scheduleRefresh(80);
      }) as any),
    );
  }

  public refreshFromPluginSettings(): void {
    this.loadConfig();
    this.externalCalendarFilterTerms = this.parseFilterTerms(
      this.plugin.getExternalCalendarFilter(),
    );
    this.updateExternalCalendarVisibility();
    // Invalidate task item cache so next updateCalendar() re-fetches.
    if (!this.plugin.settings.showTaskItems) {
      this.cachedRawTaskItems = [];
    }
    this.lastTaskItemsFetch = 0;
    this.updateCalendar();
  }

  private isEditorFocused(): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor as any;
    if (!editor) return false;
    try {
      return typeof editor.hasFocus === "function" ? editor.hasFocus() : false;
    } catch {
      return false;
    }
  }

  private getExternalCalendarViewKey(id: string): string {
    return `externalCalendar:${id}`;
  }

  private updateExternalCalendarVisibility(): void {
    this.externalCalendarUrls = this.plugin.getExternalCalendarUrls();
    const calendars = this.plugin.getEffectiveExternalCalendars();
    const visibilityByUrl = new Map<string, boolean>();

    for (const calendar of calendars) {
      if (!calendar?.url || !calendar.id) continue;
      // Safety check: this.config might be undefined during early load
      if (!this.config) {
        visibilityByUrl.set(calendar.url, true); // Default to true if config isn't ready
        continue;
      }
      const stored = this.config.get(this.getExternalCalendarViewKey(calendar.id));
      const isVisible = !(stored === "false" || stored === false);
      visibilityByUrl.set(calendar.url, isVisible);
    }

    this.visibleExternalCalendarUrls = this.externalCalendarUrls.filter((url) => {
      if (!visibilityByUrl.has(url)) return true;
      return visibilityByUrl.get(url) !== false;
    });
  }

  static getOptions(plugin?: CalendarPluginBridge): ViewOption[] {
    const externalCalendarItems = CalendarView.getExternalCalendarViewOptions(plugin);
    const externalCalendarsGroup: ViewOption | null = externalCalendarItems.length
      ? {
        displayName: "External calendars",
        type: "group",
        items: externalCalendarItems as any,
      }
      : null;

    const options: ViewOption[] = [
      {
        displayName: "Properties",
        type: "group",
        items: [
          {
            displayName: "Start date",
            type: "property",
            key: "startDate",
            placeholder: "note.scheduled",
          },
          {
            displayName: "Show primary date source",
            type: "dropdown",
            key: "includePrimaryDateSource",
            default: "true",
            options: {
              true: "Yes",
              false: "No",
            },
          },
          {
            displayName: "Primary duration (minutes, optional)",
            type: "text",
            key: "primaryDurationMinutes",
            placeholder: "Blank = minimum time",
          },
          {
            displayName: "Secondary date",
            type: "property",
            key: "secondaryStartDate",
            placeholder: "note.due",
          },
          {
            displayName: "Show secondary date source",
            type: "dropdown",
            key: "includeSecondaryDateSource",
            default: "false",
            options: {
              true: "Yes",
              false: "No",
            },
          },
          {
            displayName: "Secondary duration (minutes, optional)",
            type: "text",
            key: "secondaryDurationMinutes",
            placeholder: "Blank = minimum time",
          },
          {
            displayName: "Tertiary date",
            type: "property",
            key: "tertiaryStartDate",
            placeholder: "note.completed",
          },
          {
            displayName: "Show tertiary date source",
            type: "dropdown",
            key: "includeTertiaryDateSource",
            default: "false",
            options: {
              true: "Yes",
              false: "No",
            },
          },
          {
            displayName: "Tertiary duration (minutes, optional)",
            type: "text",
            key: "tertiaryDurationMinutes",
            placeholder: "Blank = minimum time",
          },
          {
            displayName: "Use duration for end date",
            type: "dropdown",
            key: "useEndDuration",
            default: "true",
            options: {
              false: "No (Use End DateTime)",
              true: "Yes (Use Duration)",
            },
          },
          {
            displayName: "End property",
            type: "property",
            key: "endDate",
            placeholder: "note.timeEstimate or note.due",
          },
          {
            displayName: "Title",
            type: "property",
            key: "titleProperty",
            placeholder: "note.title",
          },
          {
            displayName: "Priority field",
            type: "property",
            key: "priorityField",
            default: "priority",
            placeholder: "priority",
          },
          {
            displayName: "Status",
            type: "property",
            key: "statusField",
            placeholder: "note.status",
          },
          {
            displayName: "All-day",
            type: "property",
            key: "allDayProperty",
            placeholder: "note.allDay",
          },
        ],
      },
      {
        displayName: "Display",
        type: "group",
        items: [
          {
            displayName: "View mode",
            type: "dropdown",
            key: "tps_viewMode",
            default: plugin?.settings?.viewMode || "week",
            options: {
              day: "Day",
              "3d": "3 Day",
              "4d": "4 Day",
              "5d": "5 Day",
              "7d": "7 Day",
              week: "Week",
              month: "Month",
              continuous: "Continuous",
              "filter-based": "Filter-based (Auto)",
            },
          },
          {
            displayName: "Zoom Level",
            type: "slider",
            key: "condenseLevel",
            default: DEFAULT_CONDENSE_LEVEL,
            min: 0,
            max: 220,
            step: 10,
          },
          {
            displayName: "Show full day slot",
            type: "dropdown",
            key: "showFullDay",
            default: "true",
            options: {
              true: "Show",
              false: "Hide",
            },
          },
        ],
      },
    ];

    if (externalCalendarsGroup) {
      options.splice(3, 0, externalCalendarsGroup);
    }

    return options;
  }

  private static getExternalCalendarViewOptions(plugin?: CalendarPluginBridge): any[] {
    const calendars = plugin?.getEffectiveExternalCalendars() ?? [];
    const enabledCalendars = calendars.filter(
      (calendar: any) => calendar?.url && calendar.enabled !== false,
    );

    return enabledCalendars.map((calendar: any) => {
      const label = CalendarView.formatExternalCalendarLabel(calendar.url, calendar.id);
      return {
        displayName: label,
        type: "dropdown",
        key: `externalCalendar:${calendar.id}`,
        default: "true",
        options: {
          true: "Show",
          false: "Hide",
        },
      };
    });
  }

  private static formatExternalCalendarLabel(url: string, fallback: string): string {
    if (!url) return fallback || "External calendar";
    try {
      const parsed = new URL(url);
      return parsed.hostname ? `${parsed.hostname}${parsed.pathname || ""}` : url;
    } catch {
      return url;
    }
  }

  private async linkNoteToEvent(file: TFile, event: ExternalCalendarEvent): Promise<void> {
    try {
      const startField = this.getNoteField(this.startDateProp);
      const endField = this.getNoteField(this.endDateProp);
      const allDayField = this.getNoteField(this.allDayProperty);

      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm[this.plugin.settings.eventIdKey] = event.id;

        if (startField) {
          fm[startField] = formatDateTimeForFrontmatter(event.startDate);
        }

        if (event.endDate) {
          if (this.useEndDuration) {
            const durationMinutes = Math.round((event.endDate.getTime() - event.startDate.getTime()) / (1000 * 60));
            if (durationMinutes > 0 && endField) fm[endField] = durationMinutes;
          } else if (this.endDateProp && endField) {
            fm[endField] = formatDateTimeForFrontmatter(event.endDate);
          }
        }

        if (allDayField) {
          fm[allDayField] = event.isAllDay;
        }
      });
      new Notice(`Linked "${file.basename}" to event.`);
      this.updateCalendar();
    } catch (e) {
      logger.error("Failed to link note to event", e);
      new Notice("Failed to link note.");
    }
  }

  private async linkExistingNoteToEvent(eventFile: TFile, parentFile: TFile): Promise<void> {
    try {
      if (eventFile.path === parentFile.path) {
        new Notice("Cannot link a note to itself.");
        return;
      }

      const parentKey = (this.plugin.settings.parentLinkKey || "childOf").trim() || "childOf";
      const childKey = (this.plugin.settings.childLinkKey || "").trim();
      const doBidirectional = this.plugin.settings.parentLinkEnabled && !!childKey;

      if (doBidirectional) {
        await createBidirectionalLink(this.app, eventFile, parentFile, parentKey, childKey);
      } else {
        await applyParentLinkToChild(this.app, eventFile, parentFile, parentKey);
      }

      new Notice(`Linked "${eventFile.basename}" to "${parentFile.basename}".`);
      this.updateCalendar();
    } catch (error) {
      logger.error("Failed to link existing note to event", error);
      new Notice("Failed to link note.");
    }
  }

  private getCurrentBaseScopePath(): string | null {
    return this.resolveContainerLeafFile()?.path || null;
  }

  private getExternalEventHideKey(event: ExternalCalendarEvent): string {
    return `${normalizeCalendarUrl(event.sourceUrl || "")}::${event.id}`;
  }

  private getHiddenExternalEventKeySetForCurrentBase(): Set<string> {
    const basePath = this.getCurrentBaseScopePath();
    if (!basePath) return new Set<string>();
    return new Set(
      (this.plugin.settings.hiddenExternalEventsByBase?.[basePath] || []).map((entry: string) => String(entry)),
    );
  }

  private isExternalEventHiddenAnywhere(event: ExternalCalendarEvent): boolean {
    const eventKey = this.getExternalEventHideKey(event);
    return Object.values(this.plugin.settings.hiddenExternalEventsByBase || {}).some((entries: string[]) =>
      Array.isArray(entries) && entries.some((entry: string) => String(entry) === eventKey),
    );
  }

  private async hideExternalEventForCurrentBase(event: ExternalCalendarEvent): Promise<void> {
    const basePath = this.getCurrentBaseScopePath();
    if (!basePath) {
      new Notice("Unable to determine the current calendar base.");
      return;
    }
    const eventKey = this.getExternalEventHideKey(event);
    const nextEntries = new Set(
      (this.plugin.settings.hiddenExternalEventsByBase?.[basePath] || []).map((entry: string) => String(entry)),
    );
    if (nextEntries.has(eventKey)) return;
    nextEntries.add(eventKey);
    this.plugin.settings.hiddenExternalEventsByBase = {
      ...(this.plugin.settings.hiddenExternalEventsByBase || {}),
      [basePath]: Array.from(nextEntries),
    };
    await this.plugin.saveSettings();
    new Notice(`Archived "${event.title}" in this base.`);
    this.updateCalendar();
  }

  private async revealExternalEventOnAllBases(event: ExternalCalendarEvent): Promise<void> {
    const eventKey = this.getExternalEventHideKey(event);
    const nextMap: Record<string, string[]> = {};
    for (const [basePath, entries] of Object.entries(this.plugin.settings.hiddenExternalEventsByBase || {}) as Array<[string, string[]]>) {
      const filtered = Array.isArray(entries)
        ? entries.map((entry) => String(entry)).filter((entry) => entry !== eventKey)
        : [];
      if (filtered.length > 0) {
        nextMap[basePath] = filtered;
      }
    }
    this.plugin.settings.hiddenExternalEventsByBase = nextMap;
    await this.plugin.saveSettings();
    new Notice(`Revealed "${event.title}" on all bases.`);
    this.updateCalendar();
  }

}
