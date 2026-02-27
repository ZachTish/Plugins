import { CalendarPluginSettings, ExternalCalendarConfig, CalendarStyleRule } from "./types";
import {
    DEFAULT_CONDENSE_LEVEL,
    normalizeExternalCalendar
} from "./utils";
import {
    normalizeStoredRule,
    buildLegacyColorRules,
    buildLegacyTextRules,
    ruleHasMeaning,
    PRIORITY_KEYS,
    STATUS_KEYS
} from "./style-rule-service";

export const DEFAULT_SETTINGS: CalendarPluginSettings = {
    syncIntervalMinutes: 15,
    sidebarBasePath: null,
    dailyDateLinkTarget: "daily-note",
    primaryControllerId: null,
    colorRules: [],
    textRules: [],
    calendarStyleRules: [],
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
    parentLinkKey: "parent",
    childLinkKey: "meetings",
    eventIdKey: "externalEventId",
    uidKey: "tpsCalendarUid",
    titleKey: "title",
    statusKey: "status",
    previousStatusKey: "tpsCalendarPrevStatus",
    startProperty: "scheduled",
    endProperty: "timeEstimate",
    viewMode: "week",
    filterRangeAuto: false,
    contextDateEnabled: false,
    weekStartDay: "monday",
    navStep: 7,
    showNavButtons: true,
    minHour: "",
    maxHour: "",
    showHiddenHoursToggle: true,

    // Calendar appearance
    allDayEventHeight: 24,
    allDayMaxRows: 3,
    allDayStickyScroll: true,
    dayHeaderFormat: "short",
    dayHeaderShowDate: true,
    timeFormat: "12h",
    slotDuration: 30,
    snapDuration: 5,
    defaultScrollTime: "08:00",
    showNowIndicator: true,
    pastEventOpacity: 55,
    eventFontSize: "default",
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
            colorRules: buildLegacyColorRules(),
            textRules: buildLegacyTextRules(),
        };
    }

    const storedRules: CalendarStyleRule[] = Array.isArray(stored?.calendarStyleRules)
        ? stored?.calendarStyleRules.map((rule: any) => normalizeStoredRule(rule))
        : [];

    const storedColorRules: CalendarStyleRule[] = Array.isArray(stored?.colorRules)
        ? stored.colorRules.map((rule: any) => normalizeStoredRule(rule))
        : [];

    const storedTextRules: CalendarStyleRule[] = Array.isArray(stored?.textRules)
        ? stored.textRules.map((rule: any) => normalizeStoredRule(rule))
        : [];

    const hasStoredRules = storedRules.some((rule) => ruleHasMeaning(rule));
    const calendarStyleRules = hasStoredRules
        ? storedRules
        : [...buildLegacyColorRules(stored), ...buildLegacyTextRules(stored)];

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
    const navStep = Number.isFinite(navStepRaw) && navStepRaw > 0 ? Math.round(navStepRaw) : 7;

    return {
        sidebarBasePath: stored?.sidebarBasePath ?? null,
        primaryControllerId: stored?.primaryControllerId ?? null,

        colorRules: storedColorRules.length
            ? storedColorRules
            : buildLegacyColorRules(stored),

        textRules: storedTextRules.length
            ? storedTextRules
            : buildLegacyTextRules(stored),

        calendarStyleRules,
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
        parentLinkKey: sanitizeKey(stored?.parentLinkKey, "parent"),
        childLinkKey: sanitizeKey(stored?.childLinkKey, "meetings"),
        eventIdKey,
        uidKey,
        titleKey: sanitizeNonIdentityKey(stored?.titleKey, "title"),
        statusKey: sanitizeNonIdentityKey(stored?.statusKey, "status"),
        previousStatusKey: sanitizeNonIdentityKey(stored?.previousStatusKey, "tpsCalendarPrevStatus"),
        startProperty: sanitizeNonIdentityKey(stored?.startProperty, "scheduled"),
        endProperty: sanitizeNonIdentityKey(stored?.endProperty, "timeEstimate"),
        dailyDateLinkTarget: stored?.dailyDateLinkTarget === "daily-canvas" ? "daily-canvas" : "daily-note",
        viewMode,
        filterRangeAuto: stored?.filterRangeAuto ?? false,
        contextDateEnabled: stored?.contextDateEnabled ?? false,
        weekStartDay,
        navStep,
        showNavButtons: stored?.showNavButtons ?? true,
        minHour: typeof stored?.minHour === "string" ? stored.minHour : "",
        maxHour: typeof stored?.maxHour === "string" ? stored.maxHour : "",
        showHiddenHoursToggle: stored?.showHiddenHoursToggle ?? true,

        // Calendar appearance
        allDayEventHeight: stored?.allDayEventHeight ?? 24,
        allDayMaxRows: stored?.allDayMaxRows ?? 3,
        allDayStickyScroll: stored?.allDayStickyScroll ?? true,
        dayHeaderFormat: ["short", "long", "narrow"].includes(stored?.dayHeaderFormat) ? stored.dayHeaderFormat : "short",
        dayHeaderShowDate: stored?.dayHeaderShowDate ?? true,
        timeFormat: stored?.timeFormat === "24h" ? "24h" : "12h",
        slotDuration: [15, 30, 60].includes(stored?.slotDuration) ? stored.slotDuration : 30,
        snapDuration: [1, 5, 10, 15].includes(stored?.snapDuration) ? stored.snapDuration : 5,
        defaultScrollTime: typeof stored?.defaultScrollTime === "string" ? stored.defaultScrollTime : "08:00",
        showNowIndicator: stored?.showNowIndicator ?? true,
        pastEventOpacity: typeof stored?.pastEventOpacity === "number" ? Math.max(0, Math.min(100, stored.pastEventOpacity)) : 55,
        eventFontSize: ["small", "default", "large"].includes(stored?.eventFontSize) ? stored.eventFontSize : "default",
    };
}
