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
        parentLinkKey: stored?.parentLinkKey ?? "parent",
        childLinkKey: stored?.childLinkKey ?? "meetings",
        eventIdKey: stored?.eventIdKey ?? "externalEventId",
        uidKey: stored?.uidKey ?? "tpsCalendarUid",
        titleKey: stored?.titleKey ?? "title",
        statusKey: stored?.statusKey ?? "status",
        previousStatusKey: stored?.previousStatusKey ?? "tpsCalendarPrevStatus",
        startProperty: stored?.startProperty ?? "scheduled",
        endProperty: stored?.endProperty ?? "timeEstimate",
        dailyDateLinkTarget: stored?.dailyDateLinkTarget === "daily-canvas" ? "daily-canvas" : "daily-note",

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
