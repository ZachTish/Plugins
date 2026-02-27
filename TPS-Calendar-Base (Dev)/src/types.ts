export type CalendarStyleMatch = "all" | "any";
export type CalendarField = "status" | "priority" | string;
export type CalendarViewMode =
    | "day"
    | "3d"
    | "4d"
    | "5d"
    | "7d"
    | "week"
    | "month"
    | "continuous";
export type WeekStartDay =
    | "sunday"
    | "monday"
    | "tuesday"
    | "wednesday"
    | "thursday"
    | "friday"
    | "saturday";
export type CalendarOperator =
    | "is"
    | "!is"
    | "contains"
    | "!contains"
    | "starts"
    | "!starts"
    | "ends"
    | "!ends"
    | "exists"
    | "!exists";

export interface CalendarStyleCondition {
    field: CalendarField;
    operator: CalendarOperator;
    value: string;
}

export interface CalendarStyleRule {
    id: string;
    label: string;
    active?: boolean;
    match?: CalendarStyleMatch;
    conditions: CalendarStyleCondition[];
    color?: string;
    textStyle?: string;
}

export interface ExternalCalendarEvent {
    id: string;
    uid: string;
    title: string;
    description: string;
    startDate: Date;
    endDate: Date;
    sourceUrl?: string;
    location?: string;
    organizer?: string;
    attendees?: string[];
    isAllDay: boolean;
    url?: string;
    isCancelled?: boolean;
}

export interface ExternalCalendarConfig {
    id: string;
    url: string;
    color?: string;
    enabled?: boolean;
    autoCreateEnabled?: boolean;
    autoCreateTypeFolder?: string;
    autoCreateFolder?: string;
    autoCreateTag?: string;
    autoCreateTemplate?: string;
}

export interface CalendarPluginSettings {
    syncIntervalMinutes: number;
    sidebarBasePath: string | null;
    dailyDateLinkTarget: "daily-note" | "daily-canvas";

    primaryControllerId: string | null; // Synced setting to identify the controller device

    colorRules: CalendarStyleRule[];
    textRules: CalendarStyleRule[];
    calendarStyleRules: CalendarStyleRule[];
    priorityValues: string[];
    statusValues: string[];
    defaultCondenseLevel: number;
    externalCalendars: ExternalCalendarConfig[];
    externalCalendarFilter: string;
    enableLogging: boolean;
    syncOnEventDelete: string;
    archiveFolder: string;
    canceledStatusValue: string;
    inProgressStatusValue: string;
    parentLinkEnabled: boolean;
    parentLinkKey: string;
    childLinkKey: string;
    eventIdKey: string;
    uidKey: string;
    titleKey: string;
    statusKey: string;
    previousStatusKey: string;
    startProperty: string;
    endProperty: string;
    viewMode: CalendarViewMode;
    filterRangeAuto: boolean;
    contextDateEnabled: boolean;
    weekStartDay: WeekStartDay;
    navStep: number;
    showNavButtons: boolean;
    minHour: string;
    maxHour: string;
    showHiddenHoursToggle: boolean;

    // Calendar appearance
    allDayEventHeight: number;
    allDayMaxRows: number;
    allDayStickyScroll: boolean;
    dayHeaderFormat: "short" | "long" | "narrow";
    dayHeaderShowDate: boolean;
    timeFormat: "12h" | "24h";
    slotDuration: number;
    snapDuration: number;
    defaultScrollTime: string;
    showNowIndicator: boolean;
    pastEventOpacity: number;
    eventFontSize: "small" | "default" | "large";
}
