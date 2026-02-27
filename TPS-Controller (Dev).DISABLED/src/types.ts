import { TFile } from "obsidian";

// ============================================================================
// Device Role (Existing)
// ============================================================================

export type DeviceRole = "controller" | "user";

// ============================================================================
// Calendar Sync Types (Moved from Calendar-Base)
// ============================================================================

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



// ============================================================================
// Notification Types (Moved from Notifier)
// ============================================================================

export interface PropertyReminder {
    id: string;
    label?: string;
    property: string;
    enabled: boolean;
    offsetMinutes: number;
    mode?: "task" | "timeblock";
    repeatUntilComplete: boolean;
    repeatIntervalMinutes: number;
    maxRepeats: number;
    stopConditions: string[];
    title: string;
    body: string;
    ignorePaths?: string[];
    ignoreTags?: string[];
    ignoreStatuses?: string[];
    useSmartOffset?: boolean;
    smartOffsetProperty?: string;
    smartOffsetOperator?: "add" | "subtract";
    requiredStatuses?: string[];
    requiredPaths?: string[];
    allDayFilter?: "any" | "true" | "false";
    allDayBaseTime?: string;
    triggerAtEnd?: boolean;
}

export interface AlertState {
    [filePath: string]: {
        [reminderId: string]: {
            triggered: boolean;
            repeatCount: number;
            lastSent?: number;
        };
    };
}

// ============================================================================
// Controller Settings
// ============================================================================

export interface TPSControllerSettings {
    // Calendar Sync
    syncIntervalMinutes: number;
    noLossSyncMode: boolean;
    syncOnEventDelete: "delete" | "archive" | "nothing";
    archiveFolder: string;
    canceledStatusValue: string;
    externalCalendarFilter: string;
    externalCalendars: ExternalCalendarConfig[];


    // Frontmatter Key Names (shared with Calendar for sync)
    eventIdKey: string;
    uidKey: string;
    titleKey: string;
    statusKey: string;
    previousStatusKey: string;
    startProperty: string;
    endProperty: string;

    // Notification Rules
    pollMinutes: number;
    reminders: PropertyReminder[];
    alertState: AlertState;
    batchNotifications: boolean;
    globalIgnorePaths: string[];
    globalIgnoreTags: string[];
    globalIgnoreStatuses: string[];
    snoozeProperty: string;

    // Companion Automation
    companionStartupScanEnabled: boolean;
    companionStartupDelayMs: number;
    companionUpstreamPropagation: boolean;

    // Debug
    enableLogging: boolean;

    // Migration flag
    _migratedFromPlugins: boolean;
}

export const DEFAULT_CONTROLLER_SETTINGS: TPSControllerSettings = {
    // Calendar Sync
    syncIntervalMinutes: 5,
    noLossSyncMode: true,
    syncOnEventDelete: "nothing",
    archiveFolder: "",
    canceledStatusValue: "cancelled",
    externalCalendarFilter: "",
    externalCalendars: [],


    // Frontmatter Keys
    eventIdKey: "externalEventId",
    uidKey: "tpsCalendarUid",
    titleKey: "title",
    statusKey: "status",
    previousStatusKey: "tpsCalendarPrevStatus",
    startProperty: "scheduled",
    endProperty: "timeEstimate",

    // Notification Rules
    pollMinutes: 0.5,
    reminders: [],
    alertState: {},
    batchNotifications: true,
    globalIgnorePaths: ["System/"],
    globalIgnoreTags: ["archive", "template"],
    globalIgnoreStatuses: ["complete", "wont-do"],
    snoozeProperty: "reminderSnooze",

    // Companion Automation (DISABLED - companion plugin auto-applies on each device to prevent sync race conditions)
    companionStartupScanEnabled: false,
    companionStartupDelayMs: 800,
    companionUpstreamPropagation: true,

    // Debug
    enableLogging: false,

    // Migration
    _migratedFromPlugins: false,
};
