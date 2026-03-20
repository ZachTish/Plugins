import { CalendarPluginSettings, ExternalCalendarConfig } from "../../types";
import {
    DEFAULT_CONDENSE_LEVEL,
    normalizeExternalCalendar
} from "./utils";
import { PRIORITY_KEYS, STATUS_KEYS } from "./style-rule-service";

export const DEFAULT_SETTINGS: CalendarPluginSettings = {
    enableExternalCalendars: true,
    syncIntervalMinutes: 15,
    sidebarBasePath: null,
    dailyDateLinkTarget: "daily-note",
    primaryControllerId: null,
    priorityValues: PRIORITY_KEYS,
    statusValues: STATUS_KEYS,
    defaultCondenseLevel: DEFAULT_CONDENSE_LEVEL,
    externalCalendars: [],
    externalCalendarFilter: "",
    enableLogging: false,
    syncOnEventDelete: "archive",
    archiveFolder: "",
    canceledStatusValue: "",
    inProgressStatusValue: "working",
    parentLinkEnabled: false,
    parentLinkKey: "childOf",
    childLinkKey: "meetings",
    eventIdKey: "externalEventId",
    uidKey: "tpsCalendarUid",
    titleKey: "title",
    statusKey: "status",
    previousStatusKey: "tpsCalendarPrevStatus",
    startProperty: "scheduled",
    secondaryStartProperty: "due",
    tertiaryStartProperty: "completed",
    endProperty: "timeEstimate",
    frontmatterColorField: "color",
    frontmatterIconField: "icon",
    enableUnscheduledView: true,
    autoFocusBacklinksOnMdOpen: false,
    viewMode: "week",
    filterRangeAuto: false,
    contextDateEnabled: false,
    dailyNoteDateFormat: "",
    weekStartDay: "monday",
    navStep: 1,
    showNavButtons: true,
    minHour: "",
    maxHour: "",
    showHiddenHoursToggle: true,

    // Calendar appearance
    noteEventColorSource: "frontmatter",
    noteEventIconSource: "frontmatter",
    noteEventFrontmatterColorTarget: "both",
    allDayEventHeight: 24,
    allDayMaxRows: 3,
    allDayStickyScroll: true,
    dayHeaderFormat: "short",
    dayHeaderShowDate: true,
    timeFormat: "12h",
    slotDuration: 30,
    minEventHeight: 20,
    snapDuration: 5,
    defaultScrollTime: "08:00",
    showNowIndicator: true,
    pastEventOpacity: 55,
    eventFontSize: "default",
    activeEventHighlightColor: "#3b82f6",

    // Task items
    showTaskItems: false,
    taskDateField: "any",
    showCompletedTaskItems: false,
    taskItemColor: "#f59e0b",
    taskItemFolderFilter: "",
};

export function migrateSettings(stored: any): CalendarPluginSettings {
    const sanitizeKey = (value: unknown, fallback: string): string => {
        const raw = String(value ?? "").trim();
        if (!raw) return fallback;
        return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : fallback;
    };

    if (!stored) {
        return {
            ...DEFAULT_SETTINGS,
        };
    }

    const storedCalendars: ExternalCalendarConfig[] = Array.isArray(stored?.externalCalendars)
        ? stored.externalCalendars.map((calendar: any) => normalizeExternalCalendar(calendar))
        : [];

    const externalCalendars = storedCalendars;

    const eventIdKey = sanitizeKey(stored?.eventIdKey, "externalEventId");
    const uidKey = sanitizeKey(stored?.uidKey, "tpsCalendarUid");
    const identity = new Set([eventIdKey.toLowerCase(), uidKey.toLowerCase()]);
    const sanitizeNonIdentityKey = (value: unknown, fallback: string): string => {
        const key = sanitizeKey(value, fallback);
        return identity.has(key.toLowerCase()) ? fallback : key;
    };

    const viewMode = ["day", "3d", "4d", "5d", "7d", "week", "month", "continuous"].includes(stored?.viewMode)
        ? stored.viewMode
        : "week";
    const weekStartDay = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].includes(stored?.weekStartDay)
        ? stored.weekStartDay
        : "monday";
    const navStepRaw = Number(stored?.navStep);
    const navStep = Number.isFinite(navStepRaw) && navStepRaw > 0 ? Math.round(navStepRaw) : 1;
    const storedMinEventHeight = stored?.minEventHeight;
    const minEventHeight =
        typeof storedMinEventHeight === "number" && Number.isFinite(storedMinEventHeight)
            ? Math.max(0, Math.min(120, storedMinEventHeight))
            : 20;

    return {
        enableExternalCalendars: stored?.enableExternalCalendars ?? true,
        sidebarBasePath: stored?.sidebarBasePath ?? null,
        primaryControllerId: stored?.primaryControllerId ?? null,

        priorityValues: stored?.priorityValues ?? PRIORITY_KEYS,
        statusValues: stored?.statusValues ?? STATUS_KEYS,
        defaultCondenseLevel: stored?.defaultCondenseLevel ?? DEFAULT_CONDENSE_LEVEL,
        externalCalendars,
        externalCalendarFilter: stored?.externalCalendarFilter ?? "",
        enableLogging: stored?.enableLogging ?? false,
        syncIntervalMinutes: stored?.syncIntervalMinutes ?? 15,
        syncOnEventDelete: stored?.syncOnEventDelete ?? "archive",
        archiveFolder: stored?.archiveFolder ?? "",
        canceledStatusValue: stored?.canceledStatusValue ?? "",
        inProgressStatusValue: stored?.inProgressStatusValue ?? "working",
        parentLinkEnabled: stored?.parentLinkEnabled ?? false,
        parentLinkKey: sanitizeKey(stored?.parentLinkKey, "childOf"),
        childLinkKey: sanitizeKey(stored?.childLinkKey, "meetings"),
        eventIdKey,
        uidKey,
        titleKey: sanitizeNonIdentityKey(stored?.titleKey, "title"),
        statusKey: sanitizeNonIdentityKey(stored?.statusKey, "status"),
        previousStatusKey: sanitizeNonIdentityKey(stored?.previousStatusKey, "tpsCalendarPrevStatus"),
        startProperty: sanitizeNonIdentityKey(stored?.startProperty, "scheduled"),
        secondaryStartProperty: sanitizeNonIdentityKey(stored?.secondaryStartProperty, "due"),
        tertiaryStartProperty: sanitizeNonIdentityKey(stored?.tertiaryStartProperty, "completed"),
        endProperty: sanitizeNonIdentityKey(stored?.endProperty, "timeEstimate"),
        frontmatterColorField: sanitizeNonIdentityKey(stored?.frontmatterColorField, "color"),
        frontmatterIconField: sanitizeNonIdentityKey(stored?.frontmatterIconField, "icon"),
        dailyDateLinkTarget: stored?.dailyDateLinkTarget === "daily-canvas" ? "daily-canvas" : "daily-note",
        viewMode,
        filterRangeAuto: stored?.filterRangeAuto ?? false,
        contextDateEnabled: stored?.contextDateEnabled ?? false,
        dailyNoteDateFormat: typeof stored?.dailyNoteDateFormat === "string" ? stored.dailyNoteDateFormat : "",
        weekStartDay,
        navStep,
        showNavButtons: stored?.showNavButtons ?? true,
        minHour: typeof stored?.minHour === "string" ? stored.minHour : "",
        maxHour: typeof stored?.maxHour === "string" ? stored.maxHour : "",
        showHiddenHoursToggle: stored?.showHiddenHoursToggle ?? true,

        // Calendar appearance
        noteEventColorSource: [
            "frontmatter",
            "off",
        ].includes(stored?.noteEventColorSource)
            ? stored.noteEventColorSource
            : "frontmatter",
        noteEventIconSource: ["frontmatter", "off"].includes(stored?.noteEventIconSource)
            ? stored.noteEventIconSource
            : "frontmatter",
        noteEventFrontmatterColorTarget: ["card", "icon", "both", "off"].includes(stored?.noteEventFrontmatterColorTarget)
            ? stored.noteEventFrontmatterColorTarget
            : "both",
        allDayEventHeight: stored?.allDayEventHeight ?? 24,
        allDayMaxRows: stored?.allDayMaxRows ?? 3,
        allDayStickyScroll: stored?.allDayStickyScroll ?? true,
        dayHeaderFormat: ["short", "long", "narrow"].includes(stored?.dayHeaderFormat) ? stored.dayHeaderFormat : "short",
        dayHeaderShowDate: stored?.dayHeaderShowDate ?? true,
        timeFormat: stored?.timeFormat === "24h" ? "24h" : "12h",
        slotDuration: [15, 30, 60].includes(stored?.slotDuration) ? stored.slotDuration : 30,
        minEventHeight,
        snapDuration: [1, 5, 10, 15].includes(stored?.snapDuration) ? stored.snapDuration : 5,
        defaultScrollTime: typeof stored?.defaultScrollTime === "string" ? stored.defaultScrollTime : "08:00",
        showNowIndicator: stored?.showNowIndicator ?? true,
        pastEventOpacity: typeof stored?.pastEventOpacity === "number" ? Math.max(0, Math.min(100, stored.pastEventOpacity)) : 55,
        eventFontSize: ["small", "default", "large"].includes(stored?.eventFontSize) ? stored.eventFontSize : "default",
        activeEventHighlightColor:
            typeof stored?.activeEventHighlightColor === "string" && stored.activeEventHighlightColor.trim()
                ? stored.activeEventHighlightColor.trim()
                : "#3b82f6",

        // Task items
        showTaskItems: stored?.showTaskItems ?? false,
        taskDateField: ["any", "due", "scheduled", "start"].includes(stored?.taskDateField) ? stored.taskDateField : "any",
        showCompletedTaskItems: stored?.showCompletedTaskItems ?? false,
        taskItemColor: typeof stored?.taskItemColor === "string" && stored.taskItemColor ? stored.taskItemColor : "#f59e0b",
        taskItemFolderFilter: typeof stored?.taskItemFolderFilter === "string" ? stored.taskItemFolderFilter : "",

        // Unscheduled view
        enableUnscheduledView: stored?.enableUnscheduledView ?? true,
        autoFocusBacklinksOnMdOpen: stored?.autoFocusBacklinksOnMdOpen ?? false,
    };
}
