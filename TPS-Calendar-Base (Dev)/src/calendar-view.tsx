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
  QueryController,
  SuggestModal,
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
import { NewEventService } from "./new-event-service";
import { CalendarPluginBridge } from "./plugin-interface";
import {
  DEFAULT_CONDENSE_LEVEL,
  DEFAULT_PRIORITY_COLOR_MAP,
  MAX_CONDENSE_LEVEL,
  formatDateTimeForFrontmatter,
} from "./utils";
import { ExternalCalendarService } from "./external-calendar-service";
import { CalendarViewMode, ExternalCalendarEvent } from "./types";
import { ExternalEventModal, createMeetingNoteFromExternalEvent } from "./external-event-modal";
import { applyParentLinkToChild, createBidirectionalLink } from "./parent-child-link";
import * as logger from "./logger";

export const CalendarViewType = "calendar";



export class CalendarView extends BasesView {
  type = CalendarViewType;
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  root: Root | null = null;
  private plugin: CalendarPluginBridge;

  // Internal rendering data
  private entries: CalendarEntry[] = [];
  private pendingUpdates = new Map<string, { start: Date; end?: Date; timestamp: number }>();
  private startDateProp: BasesPropertyId | null = null;
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
  private viewMode: CalendarViewMode = "week";
  private allDayLimit: number = 3; // New property with default 3

  // Filter-based view mode auto-switching
  private filterRangeAuto: boolean = false; // Enable auto view mode based on entry date range
  private filterRangeStart: Date | null = null; // Computed min date from entries
  private filterRangeEnd: Date | null = null; // Computed max date from entries
  private filterRangeDays: number = 0; // Number of days in the filtered range
  private navigationLockedByAutoRange = false;

  // Context-aware date detection (for embedding in daily notes)
  private contextDateEnabled: boolean = false; // Enable date detection from parent note

  private contextDateDetected: Date | null = null; // The detected date from parent note

  private headerResizeObserver: ResizeObserver | null = null;
  private headerMutationObserver: MutationObserver | null = null;
  private observedHeaders = new WeakSet<HTMLElement>();
  private dayPickerAction: HTMLElement | null = null;
  private datePickerInput: HTMLInputElement | null = null;
  private headerPortalContainer: HTMLElement | null = null; // Portal target for React
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
    if (this.dayPickerAction) {
      this.dayPickerAction.remove();
      this.dayPickerAction = null;
    }
    this.headerResizeObserver?.disconnect();
    this.headerResizeObserver = null;
    this.headerMutationObserver?.disconnect();
    this.headerMutationObserver = null;
    this.entries = [];
    if (this.headerPortalContainer) {
      this.headerPortalContainer.remove();
      this.headerPortalContainer = null;
    }
  }

  public focus(): void {
    this.containerEl.focus({ preventScroll: true });
  }

  public onDataUpdated(): void {
    this.containerEl.removeClass("is-loading");
    this.loadConfig();
    this.debouncedRefresh();
    this.debouncedUpdateHeaderOffset();
    setTimeout(() => this.debouncedUpdateHeaderOffset(), 0);
  }


  private isEmbeddedCalendarContext(): boolean {
    return !!this.containerEl.closest(
      '.tps-auto-base-embed__panel, .tps-auto-base-embed__content, .block-language-bases, .cm-preview-code-block, .internal-embed, .markdown-embed, .cm-embed-block, .sync-embed, .sync-container',
    );
  }

  private updateBasesHeaderOffset(): void {
    // Critical: Stop if view is hidden or detached (prevents background loops)
    if (!this.containerEl.isShown() || !this.containerEl.isConnected) return;

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

    // 2. Inject Portal
    const targetParent = targetHeader.querySelector<HTMLElement>('.view-header-title-container') ||
      targetHeader.querySelector<HTMLElement>('.nav-buttons-container') ||
      targetHeader;

    const targetSibling = targetParent.firstChild;

    if (targetParent && !Platform.isMobile) {
      if (!this.headerPortalContainer || !this.headerPortalContainer.isConnected) {
        this.headerPortalContainer = document.createElement('div');
        this.headerPortalContainer.addClass('tps-calendar-nav-portal');
        this.headerPortalContainer.style.display = 'inline-flex';
        this.headerPortalContainer.style.alignItems = 'center';
        this.headerPortalContainer.style.marginLeft = '12px';
        this.headerPortalContainer.style.pointerEvents = 'all'; // Ensure interactive

        if (targetSibling) {
          targetParent.insertBefore(this.headerPortalContainer, targetSibling);
        } else {
          targetParent.appendChild(this.headerPortalContainer);
        }

        this.renderReactCalendar();
      }
    }

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
    const endProp =
      this.config.getAsPropertyId("endDate") ??
      this.config.getAsPropertyId("endProperty") ??
      this.config.getAsPropertyId("end");
    this.startDateProp = startProp ?? ("note.scheduled" as BasesPropertyId);
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

    const configuredViewMode = this.plugin.settings.viewMode || "week";
    this.filterRangeAuto = this.plugin.settings.filterRangeAuto === true;
    if (!this.filterRangeAuto) {
      this.viewMode = configuredViewMode;
    } else if (!this.filterRangeStart && !this.filterRangeEnd && !this.navigationLockedByAutoRange) {
      this.viewMode = configuredViewMode;
    }

    // Toggle Day Picker Action visibility
    if (this.dayPickerAction) {
      const allowedModes = ['3d', '4d', '5d', '7d', 'week'];
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

    // 0. Update Line Filter from View Config (Standard Filter Integration)
    // We look for filters that use our injected line properties


    const currentEntries: CalendarEntry[] = [];

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
    const allExternalEvents: ExternalCalendarEvent[] = this.cachedExternalEvents.filter(
      (event) => !event.sourceUrl || visibleCalendars.has(event.sourceUrl),
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
    const eventIdFieldName = this.plugin.settings.eventIdKey;
    const uidFieldName = this.plugin.settings.uidKey;
    const startFieldName = this.getNoteField(this.startDateProp);
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
      const startValue = startFieldName
        ? this.getFrontmatterValueCaseInsensitive(fm, startFieldName)
        : undefined;

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
      let startDate = this.extractDate(entry, this.startDateProp);
      if (startDate) {
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
          ? (this.valueToString(entry.getValue(this.titleProp)) as string | undefined)
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
            const str = this.valueToString(textVal);
            if (str) baseTitle = str;
          } else if (contentVal) {
            const str = this.valueToString(contentVal);
            if (str) baseTitle = str;
          } else if (nameVal) {
            const str = this.valueToString(nameVal);
            if (str) baseTitle = str;
          } else if (taskVal) {
            const str = this.valueToString(taskVal);
            if (str) baseTitle = str;
          }
        }

        const cache = entryFile ? this.app.metadataCache.getFileCache(entryFile) : null;
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

        if (this.endDateProp) {
          if (this.useEndDuration) {
            // Duration mode: compute end from start + duration (in minutes)
            const durationMinutes = this.extractDuration(entry, this.endDateProp);
            if (durationMinutes !== null && durationMinutes > 0) {
              endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
            }
          } else {
            // End datetime mode: extract end date directly
            endDate = this.extractDate(entry, this.endDateProp) ?? undefined;
          }
        }



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
        if (title && !/^\d{4}-\d{2}-\d{2}$/.test(title)) {
          title = title.replace(/ \d{4}-\d{2}-\d{2}$/, '');
        }

        // Resolve styles
        const statusStr = statusValue ? String(statusValue) : undefined;
        const priorityStr = priorityValue ? String(priorityValue) : undefined;

        const cssClasses = ["bases-calendar-event"];
        // Do NOT add is-external class to local notes, even if they match an external event.
        // We want them to look like local notes (gradient, priority color).

        if (priorityStr && ["high", "medium", "low"].includes(priorityStr)) {
          cssClasses.push(`bases-calendar-event-priority-${priorityStr}`);
        }

        if (statusStr) {
          cssClasses.push(`bases-calendar-event-status-${statusStr}`);
        }

        const priorityColor =
          (priorityStr && DEFAULT_PRIORITY_COLOR_MAP[priorityStr]) ??
          DEFAULT_PRIORITY_COLOR_MAP["normal"];
        let backgroundColor = priorityColor;
        let borderColor = priorityColor;
        const styleOverride = this.plugin.getCalendarStyleOverride({
          ...entry,
          status: statusStr,
          priority: priorityStr,
          file: entryFile,
          frontmatter: cache?.frontmatter
        });
        if (styleOverride?.color) {
          backgroundColor = styleOverride.color;
          borderColor = styleOverride.color;
        }
        if (styleOverride?.textStyle) {
          const overrides = styleOverride.textStyle
            .split(/[,|]/)
            .map((t) => t.trim().toLowerCase())
            .filter(Boolean);
          cssClasses.push(...overrides.map((style) => `bases-calendar-status-${style}`));
        }

        if (externalMatch) {
          handledExternalEventIds.add(externalMatch.id);
        }

        currentEntries.push({
          entry,
          startDate,
          endDate,
          title,
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
          borderColor
        });

        // Note: Time logs are now stored in daily notes, not source notes.
        // Source notes only contain daily note links like [[2025-12-10]].
        // Time log entries are read from daily notes in the separate scan below.
      }
    }


    // 3. Add remaining external events (those NOT matched to local notes)
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
    this.entries = finalEntries;

    // If auto view mode is enabled, derive range from filters first (if present),
    // then fall back to local visible entries.
    if (this.filterRangeAuto) {
      this.computeFilterDateRange(this.getEffectiveFilterRangeEntries(finalEntries));
    } else {
      this.navigationLockedByAutoRange = false;
    }

    this.renderReactCalendar();
    this.updateBasesHeaderOffset(); // Ensure layout is correct
  }

  /**
   * Returns local, non-virtual entries used as fallback when filter bounds are not explicit.
   */
  private getEffectiveFilterRangeEntries(entries: CalendarEntry[]): CalendarEntry[] {
    return entries.filter((entry) => !entry.isExternal && !entry.isGhost);
  }

  private getFilterRangeBoundsFromConfig(): { start: Date | null; end: Date | null } {
    const filterSources = [
      this.config.get?.("filters"),
      (this.config as any).filtersAll,
      (this.config as any).filters?.all,
      this.config.get?.("filtersAll"),
      (this.config as any).viewFilters,
      (this.config as any).filters,
    ].filter((value, index, arr) => value != null && arr.indexOf(value) === index);

    const propertyAliases = this.getStartDatePropertyAliases();
    let lowerBound: Date | null = null;
    let upperBound: Date | null = null;

    for (const source of filterSources) {
      const conditions = this.collectFilterConditions(source);
      for (const condition of conditions) {
        if (!this.matchesStartDateFilterProperty(condition.property, propertyAliases)) {
          continue;
        }

        const boundaryDate = this.resolveFilterDateExpression(condition.value);
        if (!boundaryDate) continue;

        if (this.isLowerBoundOperator(condition.operator)) {
          if (!lowerBound || boundaryDate.getTime() > lowerBound.getTime()) {
            lowerBound = boundaryDate;
          }
        } else if (this.isUpperBoundOperator(condition.operator)) {
          if (!upperBound || boundaryDate.getTime() < upperBound.getTime()) {
            upperBound = boundaryDate;
          }
        }
      }
    }

    return { start: lowerBound, end: upperBound };
  }

  private getStartDatePropertyAliases(): Set<string> {
    const aliases = new Set<string>();

    const addAlias = (value: string | null | undefined) => {
      if (!value) return;
      const normalized = value.trim().toLowerCase();
      if (!normalized) return;
      aliases.add(normalized);
    };

    const startField = this.getNoteField(this.startDateProp);
    addAlias(startField);
    if (startField) {
      addAlias(`note.${startField}`);
    }

    if (typeof this.startDateProp === "string") {
      addAlias(this.startDateProp);
      const parsed = parsePropertyId(this.startDateProp as BasesPropertyId);
      const parsedName = parsed.name || (parsed as any).property;
      addAlias(parsedName || null);
      if (parsedName) {
        addAlias(`note.${parsedName}`);
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

  private isLowerBoundOperator(operator: string): boolean {
    const op = String(operator || "").toLowerCase().replace(/\s+/g, "");
    return op.includes(">") || op.includes("after") || op.includes("greater");
  }

  private isUpperBoundOperator(operator: string): boolean {
    const op = String(operator || "").toLowerCase().replace(/\s+/g, "");
    return op.includes("<") || op.includes("before") || op.includes("less");
  }

  private resolveFilterDateExpression(value: unknown): Date | null {
    if (value instanceof Date) {
      return new Date(value.getTime());
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }

    const normalized = this.normalizeFilterValue(value);
    if (!normalized) return null;

    const expression = this.stripOuterQuotes(normalized.trim());
    if (!expression) return null;

    const direct = this.resolveFilterDateAtom(expression);
    if (direct) return direct;

    const arithmeticMatch = expression.match(/^(.+?)\s*([+-])\s*(.+)$/);
    if (!arithmeticMatch) return null;

    const [, leftExpr, op, rightExpr] = arithmeticMatch;
    const baseDate = this.resolveFilterDateExpression(leftExpr.trim());
    const durationMs = this.parseRelativeDurationMs(rightExpr.trim());
    if (!baseDate || durationMs === null) return null;

    const result = new Date(baseDate.getTime());
    result.setTime(result.getTime() + (op === "+" ? durationMs : -durationMs));
    return result;
  }

  private resolveFilterDateAtom(expression: string): Date | null {
    const lowered = expression.toLowerCase();
    if (lowered === "today()") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return today;
    }

    if (lowered === "now()") {
      return new Date();
    }

    const dateFnMatch = expression.match(/^date\((.+)\)$/i);
    if (dateFnMatch) {
      const inner = this.stripOuterQuotes(dateFnMatch[1].trim());
      if (!inner) return null;
      const relativeMs = this.parseRelativeDurationMs(inner);
      if (relativeMs !== null) {
        const base = new Date();
        base.setHours(0, 0, 0, 0);
        base.setTime(base.getTime() + relativeMs);
        return base;
      }
      const parsedDate = new Date(inner);
      return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
    }

    const absoluteDate = new Date(expression);
    if (!Number.isNaN(absoluteDate.getTime())) {
      return absoluteDate;
    }

    return null;
  }

  private parseRelativeDurationMs(expression: string): number | null {
    let normalized = expression.trim();
    if (!normalized) return null;

    const durationFnMatch = normalized.match(/^(duration|date)\((.+)\)$/i);
    if (durationFnMatch) {
      normalized = durationFnMatch[2].trim();
    }
    normalized = this.stripOuterQuotes(normalized);
    if (!normalized) return null;

    const match = normalized.match(/^(-?\d+(?:\.\d+)?)\s*(day|days|d|week|weeks|w|month|months|mo|hour|hours|hr|hrs|minute|minutes|min|mins)$/i);
    if (!match) return null;

    const amount = Number.parseFloat(match[1]);
    if (!Number.isFinite(amount)) return null;

    const unit = match[2].toLowerCase();
    const unitMs =
      unit === "day" || unit === "days" || unit === "d"
        ? 24 * 60 * 60 * 1000
        : unit === "week" || unit === "weeks" || unit === "w"
          ? 7 * 24 * 60 * 60 * 1000
          : unit === "month" || unit === "months" || unit === "mo"
            ? 30 * 24 * 60 * 60 * 1000
            : unit === "hour" || unit === "hours" || unit === "hr" || unit === "hrs"
              ? 60 * 60 * 1000
              : 60 * 1000;

    return amount * unitMs;
  }

  private stripOuterQuotes(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  }

  private getAutoRangeViewDayCount(diffDays: number): number {
    if (diffDays <= 1) return 1;
    if (diffDays <= 3) return 3;
    if (diffDays <= 4) return 4;
    if (diffDays <= 5) return 5;
    if (diffDays <= 7) return 7;
    return 30;
  }

  /**
   * Computes the date range from explicit date filters when available,
   * otherwise from visible local (non-external, non-virtual) entries.
   * If entries span 7 days or less → day-range views (1d/3d/4d/5d/7d)
   * If entries span more than 7 days → month view
   * Also sets currentDate to the start of the range so filtered events are visible.
   */
  private computeFilterDateRange(entries: CalendarEntry[]): void {
    let minDate: Date | null = null;
    let maxDate: Date | null = null;

    for (const entry of entries) {
      const startDate = entry.startDate;
      const endDate = entry.endDate || startDate;

      if (!minDate || startDate < minDate) {
        minDate = new Date(startDate);
      }
      if (!maxDate || endDate > maxDate) {
        maxDate = new Date(endDate);
      }
      // Also check start date for max (in case end date is not set)
      if (!maxDate || startDate > maxDate) {
        maxDate = new Date(startDate);
      }
    }

    const filterBounds = this.getFilterRangeBoundsFromConfig();
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

    if (minDate && maxDate && minDate.getTime() > maxDate.getTime()) {
      maxDate = new Date(minDate);
    }

    if (!minDate || !maxDate) {
      this.filterRangeStart = null;
      this.filterRangeEnd = null;
      this.filterRangeDays = 0;
      this.navigationLockedByAutoRange = false;
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

    logger.log(`[CalendarView] Filter range: ${diffDays} days (${minDate.toDateString()} to ${maxDate.toDateString()})`);

    // Auto-switch view mode based on day count
    const previousViewMode = this.viewMode;
    this.navigationLockedByAutoRange = true;

    if (diffDays <= 1) {
      this.viewMode = "day";
    } else if (diffDays <= 3) {
      this.viewMode = "3d";
    } else if (diffDays <= 4) {
      this.viewMode = "4d";
    } else if (diffDays <= 5) {
      this.viewMode = "5d";
    } else if (diffDays <= 7) {
      this.viewMode = "7d";
    } else {
      // More than 7 days: use month view
      this.viewMode = "month";
    }

    // Anchor currentDate so centered timeline views start at the lower filter bound.
    // Without this, multi-day views clip future days when range auto-mode is active.
    if (this.viewMode !== "month") {
      const targetDayCount = this.getAutoRangeViewDayCount(diffDays);
      const centerOffset = Math.max(0, Math.floor((targetDayCount - 1) / 2));
      this.currentDate = new Date(startOfMinDay);
      this.currentDate.setDate(this.currentDate.getDate() + centerOffset);
      this.currentDate.setHours(0, 0, 0, 0);
    } else {
      // For month view, set to the first of the month containing minDate
      this.currentDate = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    }

    if (previousViewMode !== this.viewMode) {
      logger.log(`[CalendarView] Auto-switched view mode: ${previousViewMode} → ${this.viewMode}`);
    }
    if (this.dayPickerAction) {
      const allowedModes = ['3d', '4d', '5d', '7d', 'week'];
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
      const detectedDate = this.extractDateFromPath(parentNote);
      if (detectedDate) {
        this.contextDateDetected = detectedDate;
        logger.log(`[CalendarView] Detected context date: ${detectedDate.toDateString()} from "${parentNote}"`);

        // Only update currentDate if we actually detected a context date
        // This preserves user navigation when in standalone mode
        detectedDate.setHours(0, 0, 0, 0);
        this.currentDate = detectedDate;
        logger.log(`[CalendarView] Context date set to: ${detectedDate.toDateString()}, keeping existing viewMode: ${this.viewMode}`);
      }
    }
  }

  /**
   * Finds the parent note's path when the calendar is embedded.
   * Traverses the DOM to find the parent markdown view or embed container.
   */
  private findParentNotePath(): string | null {
    try {
      // Method 1: Look for data-path on workspace leaf content (most reliable)
      const leafContent = this.containerEl.closest('.workspace-leaf-content');
      if (leafContent) {
        const dataPath = leafContent.getAttribute('data-path');
        if (dataPath) {
          logger.log(`[CalendarView] Found parent via data-path: ${dataPath}`);
          return dataPath;
        }
      }

      // Method 2: Find the workspace leaf and look up the view
      const leafEl = this.containerEl.closest('.workspace-leaf');
      if (leafEl) {
        // Iterate through all leaves to find the matching one
        let foundPath: string | null = null;
        this.app.workspace.iterateAllLeaves((leaf) => {
          const leafContainer = (leaf as any).containerEl as HTMLElement | undefined;
          if (leafContainer && (leafContainer === leafEl || leafEl.contains(leafContainer) || leafContainer.contains(leafEl as any))) {
            const view = leaf.view;
            if (view && 'file' in view && (view as any).file) {
              const file = (view as any).file;
              if (file.path) {
                foundPath = file.path;
              }
            }
          }
        });
        if (foundPath) {
          logger.log(`[CalendarView] Found parent via leaf iteration: ${foundPath}`);
          return foundPath;
        }
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
              if (dataPath) {
                logger.log(`[CalendarView] Found parent via embed ancestor: ${dataPath}`);
                return dataPath;
              }
            }
          }
          parent = parent.parentElement;
        }
      }

      // Method 4: For bases views, try to get the source file from controller
      if (this.controller) {
        const sourceFile = (this.controller as any).file || (this.controller as any).sourceFile;
        if (sourceFile?.path) {
          logger.log(`[CalendarView] Found parent via controller: ${sourceFile.path}`);
          return sourceFile.path;
        }
      }

      // Method 5: Check if we have a parent file path attribute anywhere in the hierarchy
      let el: HTMLElement | null = this.containerEl;
      while (el) {
        const filePath = el.getAttribute('data-path') ||
          el.getAttribute('data-file-path') ||
          el.getAttribute('data-source');
        if (filePath && filePath.endsWith('.md')) {
          logger.log(`[CalendarView] Found parent via DOM attribute: ${filePath}`);
          return filePath;
        }
        el = el.parentElement;
      }

      // Method 6: Last resort - check the hover-link for the containing note
      const hoverLink = this.containerEl.closest('[data-href]');
      if (hoverLink) {
        const href = hoverLink.getAttribute('data-href');
        if (href) {
          logger.log(`[CalendarView] Found parent via hover-link: ${href}`);
          return href;
        }
      }

      // Fallback: Don't use active file as it may be wrong for embeds
      // Instead, log that we couldn't find the parent and use today
      logger.log(`[CalendarView] Could not determine parent note, using today's date`);
      return null;
    } catch (error) {
      logger.warn("[CalendarView] Error finding parent note:", error);
      return null;
    }
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

    // Try YYYY-MM-DD format (most common for daily notes)
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

    // Try MM-DD-YYYY format
    const usMatch = filename.match(/(\d{2})[-_](\d{2})[-_](\d{4})/);
    if (usMatch) {
      const month = parseInt(usMatch[1], 10) - 1;
      const day = parseInt(usMatch[2], 10);
      const year = parseInt(usMatch[3], 10);
      const date = new Date(year, month, day);
      if (!isNaN(date.getTime())) {
        return date;
      }
    }

    // Try DD-MM-YYYY format (less common, so lower priority)
    const euMatch = filename.match(/(\d{2})[-_](\d{2})[-_](\d{4})/);
    if (euMatch) {
      const day = parseInt(euMatch[1], 10);
      const month = parseInt(euMatch[2], 10) - 1;
      const year = parseInt(euMatch[3], 10);
      // Only accept if day > 12 (otherwise ambiguous with US format)
      if (day > 12) {
        const date = new Date(year, month, day);
        if (!isNaN(date.getTime())) {
          return date;
        }
      }
    }

    return null;
  }

  private async refreshExternalEvents(start: Date, end: Date): Promise<void> {
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

    // Default: Create Event
    try {
      const creationDefaults = this.getFilterCreationDefaults();
      const file = await this.newEventService.createEvent(start, end, undefined, {
        useBaseDefaults: true,
        frontmatterDefaults: creationDefaults.frontmatter,
        typeFolderOverride: creationDefaults.folderPath,
      });
      if (file) {
        this.updateCalendar();
      }
    } catch (error) {
      logger.error('[CalendarView] Error in handleCreateRange:', error);
      new Notice(`Failed to create event: ${error instanceof Error ? error.message : String(error)}`);
    }
  }



  private async handleCreateMeetingNote(event: ExternalCalendarEvent): Promise<void> {
    try {
      const startField = this.getNoteField(this.startDateProp);
      const endField = this.getNoteField(this.endDateProp);



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
      const resolvedFolderPath = typeFolderPath || folderPath;

      // Prompt for Parent Link if enabled
      let parentFile: TFile | null = null;
      // Re-use the prompter from NewEventService for consistency
      if (this.plugin.settings.parentLinkEnabled && this.plugin.settings.parentLinkKey && this.plugin.settings.childLinkKey) {
        parentFile = await this.newEventService.promptForParentSelection(this.plugin.settings.parentLinkKey);
      }

      const file = await createMeetingNoteFromExternalEvent(
        this.app,
        event,
        null,
        resolvedFolderPath,
        startField,
        endField,
        this.useEndDuration,
        calendarTag || null,
        parentFile,
        this.plugin.settings.parentLinkKey,
        this.plugin.settings.childLinkKey,
        {
          eventIdKey: this.plugin.settings.eventIdKey,
          uidKey: this.plugin.settings.uidKey || undefined, // undefined will be skipped by createMeetingNoteFromExternalEvent if we modify it, or we need to handle it there.
          titleKey: this.plugin.settings.titleKey,
          statusKey: this.plugin.settings.statusKey,
        }
      );

      if (file) {
        new Notice(`Created meeting note: ${file.basename}`);
        // Open in a new leaf to keep calendar visible
        const leaf = this.app.workspace.getLeaf('split', 'vertical');
        await leaf.openFile(file);

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
        const created = await this.newEventService.createEvent(start, end, undefined, {
          useBaseDefaults: true,
          frontmatterDefaults: this.getFilterCreationDefaults().frontmatter,
          typeFolderOverride: this.getFilterCreationDefaults().folderPath,
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
        const leaf = this.app.workspace.getLeaf(false);
        if (leaf) {
          await leaf.openFile(file);
        }
      }
    } catch (e) {
      logger.error(`Failed to open ${useCanvas ? "daily canvas" : "daily note"}`, e);
      new Notice(`Failed to open ${useCanvas ? "daily canvas" : "daily note"}: ${e}`);
    }
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
                  }
                );
                modal.open();
                return;
              }

              const file = calEntry.entry.file;
              if (!file) return;

              await this.app.workspace.openLinkText(file.path, "", isModEvent);
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
              this.renderReactCalendar();
            }}
            onToggleFullDay={() => this.toggleFullDay()}
            allDayProperty={this.allDayProperty}
            showHiddenHoursToggle={this.showHiddenHoursToggle}
            defaultEventDuration={this.defaultEventDuration}
            onDateClick={(date) => this.handleDateClick(date)}
            onDateMouseEnter={(date, el, ev) => this.handleDateMouseEnter(date, el, ev)}
            // showHiddenEvents={this.showHiddenEvents}
            // onToggleHiddenEvents={() => this.toggleHiddenEvents()}
            headerPortalTarget={this.headerPortalContainer}
            showNavButtons={this.showNavButtons}
            navigationLocked={this.navigationLockedByAutoRange}

            allDayEventHeight={this.plugin.settings.allDayEventHeight}
            allDayMaxRows={this.plugin.settings.allDayMaxRows}
            allDayStickyScroll={this.plugin.settings.allDayStickyScroll}
            dayHeaderFormatSetting={this.plugin.settings.dayHeaderFormat}
            dayHeaderShowDate={this.plugin.settings.dayHeaderShowDate}
            timeFormatSetting={this.plugin.settings.timeFormat}
            slotDurationMinutes={this.plugin.settings.slotDuration}
            snapDurationMinutes={this.plugin.settings.snapDuration}
            defaultScrollTimeSetting={this.plugin.settings.defaultScrollTime}
            showNowIndicator={this.plugin.settings.showNowIndicator}
            pastEventOpacity={this.plugin.settings.pastEventOpacity}
            eventFontSize={this.plugin.settings.eventFontSize}
          />
        </AppContext.Provider>
      </StrictMode>,
    );
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

  private extractDate(entry: BasesEntry, propId: BasesPropertyId): Date | null {
    try {
      const value = entry.getValue(propId);
      if (!value) return null;

      const parsedDate = this.resolveDateValue(value);
      if (parsedDate) return parsedDate;

      return null;
    } catch (error) {
      logger.error(`Error extracting date for ${entry.file.name}:`, error);
      return null;
    }
  }

  private extractDuration(entry: BasesEntry, propId: BasesPropertyId): number | null {
    try {
      const value = entry.getValue(propId);
      if (!value) return null;

      // Handle numeric values directly
      if (typeof value === "number") {
        return value;
      }

      // Try to get numeric value from Value object
      const numValue = (value as any).toNumber?.();
      if (typeof numValue === "number" && !Number.isNaN(numValue)) {
        return numValue;
      }

      // Try to parse from string representation
      const strValue = this.valueToString(value);
      if (strValue) {
        // Handle "1h 30m", "1.5h", "90m" formats
        let minutes = 0;
        let matched = false;

        const hoursMatch = strValue.match(/(\d+(?:\.\d+)?)h/);
        if (hoursMatch) {
          minutes += parseFloat(hoursMatch[1]) * 60;
          matched = true;
        }

        const minsMatch = strValue.match(/(\d+(?:\.\d+)?)m/);
        if (minsMatch) {
          minutes += parseFloat(minsMatch[1]);
          matched = true;
        }

        if (matched) {
          return minutes;
        }

        // Fallback for plain numbers
        const parsed = parseFloat(strValue);
        if (!Number.isNaN(parsed)) {
          return parsed;
        }
      }

      return null;
    } catch (error) {
      logger.error(`Error extracting duration for ${entry.file.name}:`, error);
      return null;
    }
  }

  private resolveDateValue(value: Value | unknown, seen = new Set<unknown>()): Date | null {
    if (!value) return null;

    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return null;
      seen.add(value);

      const nestedDate = this.resolveFromPotentialDate(value as Record<string, unknown>, seen);
      if (nestedDate) return nestedDate;
    }

    if (value instanceof Date) {
      return value;
    }

    const asString = this.valueToString(value);
    if (!asString) {
      return null;
    }

    return this.tryParseDate(asString);
  }

  private valueToString(value: Value | unknown): string | null {
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (typeof value === "object" && value !== null) {
      try {
        return (value as { toString: () => string }).toString();
      } catch {
        return null;
      }
    }
    return null;
  }

  private tryParseDate(raw: string): Date | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) {
      const numericValue = Number(trimmed);
      if (!Number.isNaN(numericValue)) {
        const numericDate = new Date(numericValue);
        if (!Number.isNaN(numericDate.getTime())) {
          return numericDate;
        }
      }
    }

    // Important: `new Date("YYYY-MM-DD")` is parsed as UTC and can shift the local day.
    // Parse common frontmatter formats as local time to keep calendar + daily embeds aligned.
    const localMatch = trimmed.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
    );
    if (localMatch) {
      const year = Number(localMatch[1]);
      const month = Number(localMatch[2]);
      const day = Number(localMatch[3]);
      const hour = localMatch[4] ? Number(localMatch[4]) : 0;
      const minute = localMatch[5] ? Number(localMatch[5]) : 0;
      const second = localMatch[6] ? Number(localMatch[6]) : 0;
      const local = new Date(year, month - 1, day, hour, minute, second);
      if (!Number.isNaN(local.getTime())) {
        return local;
      }
    }

    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private resolveFromPotentialDate(
    value: Record<string, unknown>,
    seen: Set<unknown>,
  ): Date | null {
    const candidates = ["date", "value", "timestamp", "start", "end"];
    for (const key of candidates) {
      if (key in value) {
        const candidate = value[key];
        const resolved = this.resolveDateValue(candidate, seen);
        if (resolved) return resolved;
      }
    }

    const getter = (value as { get?: (key: string) => unknown }).get;
    if (typeof getter === "function") {
      for (const key of candidates) {
        try {
          const nested = getter.call(value, key);
          const resolved = this.resolveDateValue(nested, seen);
          if (resolved) return resolved;
        } catch {
          // ignore getter errors
        }
      }
    }

    return null;
  }

  private showEntryContextMenu(evt: MouseEvent, entry: BasesEntry): void {
    const fcEvent = (evt as any).fullCalendarEvent;
    const eventStart = fcEvent?.start ?? null;
    const calEntry = this.entries.find(e =>
      e.entry.file.path === entry.file.path &&
      (!eventStart || Math.abs(e.startDate.getTime() - eventStart.getTime()) < 1000)
    );

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

  private async handleEventDrop(
    entry: BasesEntry,
    newStart: Date,
    newEnd?: Date,
    allDay?: boolean,
    scope: "all" | "single" = "all",
    oldStart?: Date,
    oldEnd?: Date,
  ): Promise<void> {
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

  private parseFrontmatterDateValue(value: unknown): Date | null {
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

  private getFilterCreationDefaults(): {
    folderPath: string | null;
    frontmatter: Record<string, any>;
  } {
    const filtersAll =
      this.config.get?.("filters") ??
      (this.config as any).filtersAll ??
      (this.config as any).filters?.all ??
      this.config.get?.("filtersAll") ??
      null;
    const viewFilters =
      (this.config as any).viewFilters ??
      this.config.get?.("filters") ??
      (this.config as any).filters ??
      null;

    const folderFromAll = this.extractFolderFromFilters(filtersAll);
    const folderFromView = folderFromAll ? null : this.extractFolderFromFilters(viewFilters);
    const frontmatter = this.extractFrontmatterDefaults(filtersAll);

    return {
      folderPath: folderFromAll || folderFromView,
      frontmatter,
    };
  }

  private extractFolderFromFilters(filters: unknown): string | null {
    const conditions = this.collectFilterConditions(filters);
    for (const condition of conditions) {
      const derived = this.deriveFolderPathFromCondition(condition);
      if (derived) {
        return derived;
      }
    }
    return null;
  }

  private deriveFolderPathFromCondition(condition: {
    property: string;
    operator: string;
    value: unknown;
  }): string | null {
    const property = condition.property.toLowerCase();
    const value = this.normalizeFilterValue(condition.value);
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
      const value = this.normalizeFilterValue(condition.value);
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

      const rawProperty =
        (node as any).property ??
        (node as any).field ??
        (node as any).key ??
        (node as any).column ??
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
              "",
            ).trim()
            : "";
      if (!property) return;
      let value = (node as any).value ?? (node as any).pattern ?? (node as any).match;
      if (value && typeof value === "object" && "value" in value) {
        value = (value as any).value;
      }
      const rawOperator = (node as any).op ?? (node as any).operator ?? (node as any).comparison;
      const operator =
        typeof rawOperator === "string"
          ? rawOperator.trim()
          : rawOperator && typeof rawOperator === "object"
            ? String(
              (rawOperator as any).operator ??
              (rawOperator as any).op ??
              (rawOperator as any).name ??
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
        value: this.stripOuterQuotes(negContainsMatch[2].trim()),
      };
    }

    // Example: file.path.contains("System")
    const containsMatch = trimmed.match(/^([\w.]+)\.contains\((.+)\)\s*$/i);
    if (containsMatch) {
      return {
        property: containsMatch[1],
        operator: "contains",
        value: this.stripOuterQuotes(containsMatch[2].trim()),
      };
    }

    // Example: scheduled > today() - duration("2 days")
    const comparisonMatch = trimmed.match(/^([\w.]+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (comparisonMatch) {
      return {
        property: comparisonMatch[1],
        operator: comparisonMatch[2],
        value: comparisonMatch[3].trim(),
      };
    }

    return null;
  }

  private isPositiveEqualityOp(operator: string): boolean {
    const op = operator.toLowerCase().replace(/\s+/g, "");
    if (!op) return true;
    if (op.includes("not") || op.includes("!=") || op.includes("doesnot")) return false;
    return op.includes("is") || op.includes("equals") || op === "=";
  }

  private normalizeFilterValue(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const normalized = this.normalizeFilterValue(item);
        if (normalized !== null) return normalized;
      }
      return null;
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const candidateKeys = [
        "value",
        "text",
        "raw",
        "expression",
        "expr",
        "query",
        "code",
        "source",
        "literal",
      ];
      for (const key of candidateKeys) {
        if (!(key in record)) continue;
        const normalized = this.normalizeFilterValue(record[key]);
        if (normalized !== null) return normalized;
      }
    }
    return null;
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

      if (priorityStr && ["high", "medium", "low"].includes(priorityStr)) {
        cssClasses.push(`bases-calendar-event-priority-${priorityStr}`);
      }

      if (statusStr) {
        cssClasses.push(`bases-calendar-event-status-${statusStr}`);
      }

      const priorityColor =
        (priorityStr && DEFAULT_PRIORITY_COLOR_MAP[priorityStr]) ??
        DEFAULT_PRIORITY_COLOR_MAP["normal"];
      let backgroundColor = priorityColor;
      let borderColor = priorityColor;
      const styleOverride = this.plugin.getCalendarStyleOverride({
        ...entry,
        status: statusStr,
        priority: priorityStr,
        file: file,
        frontmatter: cache?.frontmatter
      });
      if (styleOverride?.color) {
        backgroundColor = styleOverride.color;
        borderColor = styleOverride.color;
      }
      if (styleOverride?.textStyle) {
        const overrides = styleOverride.textStyle
          .split(/[,|]/)
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
        cssClasses.push(...overrides.map((style) => `bases-calendar-status-${style}`));
      }

      // Update the entry in place
      entry.status = statusStr;
      entry.priority = priorityStr;
      entry.cssClasses = cssClasses;
      entry.backgroundColor = backgroundColor;
      entry.borderColor = borderColor;

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
        logger.log(`[CalendarView] Fast refreshed entry: ${file.path}`);
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
  }

  public refreshFromPluginSettings(): void {
    this.loadConfig();
    this.externalCalendarFilterTerms = this.parseFilterTerms(
      this.plugin.getExternalCalendarFilter(),
    );
    this.updateExternalCalendarVisibility();
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

      const parentKey = (this.plugin.settings.parentLinkKey || "parent").trim() || "parent";
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
}



// Helper to get all tags including frontmatter tags
function getAllTags(cache: any): string[] {
  if (!cache) return [];
  let tags = (cache.tags || []).map((t: any) => t.tag);
  if (cache.frontmatter?.tags) {
    const fmTags = Array.isArray(cache.frontmatter.tags)
      ? cache.frontmatter.tags
      : [cache.frontmatter.tags];
    tags = [...tags, ...fmTags.map((t: string) => t.startsWith('#') ? t : '#' + t)];
  }
  return tags;
}

interface HeaderInfo {
  text: string;
  level: number;
  line: number;
}

class HeaderSelectionModal extends SuggestModal<HeaderInfo | string> {
  headers: HeaderInfo[];
  onChoose: (result: HeaderInfo | string | null) => void;
  chosen: boolean = false;

  constructor(app: App, headers: HeaderInfo[], onChoose: (result: HeaderInfo | string | null) => void) {
    super(app);
    this.headers = headers;
    this.onChoose = onChoose;
    this.setPlaceholder("Select a header in current file to append under...");
  }

  getSuggestions(query: string): (HeaderInfo | string)[] {
    const suggestions: (HeaderInfo | string)[] = ["Append to bottom"];
    const lowerQuery = query.toLowerCase();

    // Filter headers
    const filteredHeaders = this.headers.filter(h =>
      h.text.toLowerCase().includes(lowerQuery)
    );

    return [...suggestions, ...filteredHeaders];
  }

  renderSuggestion(item: HeaderInfo | string, el: HTMLElement) {
    if (typeof item === 'string') {
      el.createDiv({ text: item, cls: "header-selection-special" });
      el.style.fontWeight = 'bold';
      el.style.borderBottom = '1px solid var(--background-modifier-border)';
      el.style.marginBottom = '5px';
      el.style.paddingBottom = '5px';
    } else {
      // Indent based on header level
      const indent = (item.level - 1) * 15;
      const div = el.createDiv();
      div.style.paddingLeft = `${indent}px`;
      div.innerText = item.text;
      div.style.color = 'var(--text-normal)';
    }
  }

  onChooseSuggestion(item: HeaderInfo | string, evt: MouseEvent | KeyboardEvent) {
    this.chosen = true;
    this.onChoose(item);
  }

  onClose() {
    if (!this.chosen) {
      this.onChoose(null);
    }
    this.contentEl.empty();
  }
}

class FileSelectionModal extends SuggestModal<TFile> {
  onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Select existing note to link...");
  }

  getSuggestions(query: string): TFile[] {
    const files = this.app.vault.getMarkdownFiles();
    return files.filter(f => f.path.toLowerCase().includes(query.toLowerCase()));
  }

  renderSuggestion(file: TFile, el: HTMLElement) {
    el.setText(file.path);
  }

  onChooseSuggestion(file: TFile) {
    this.onChoose(file);
  }
}
