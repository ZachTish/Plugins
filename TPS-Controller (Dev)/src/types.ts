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
    autoCreateMode?: "note" | "task-list";
    autoCreateTypeFolder?: string;
    autoCreateFolder?: string;
    autoCreateTag?: string;
    autoCreateTemplate?: string;
    autoCreateTaskListPath?: string;
    autoCreateTaskListHeading?: string;
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
    includeUnmatchedExternalEvents?: boolean;
}

export interface KanbanTaskReminderSettings {
    enabled: boolean;
    includeBoardFileTarget: boolean;
    parseInlineProperties: boolean;
    parseKanbanDateTokens: boolean;
    parseTasksEmojiDates: boolean;
    statusProperty: string;
    completeStatusValue: string;
    wontDoStatusValue: string;
    scheduledPropertyAliases: string[];
    duePropertyAliases: string[];
    startPropertyAliases: string[];
}

export interface AlertState {
    [filePath: string]: {
        [reminderId: string]: {
            triggered: boolean;
            repeatCount: number;
            lastSent?: number;
            lastTriggerKey?: string;
        };
    };
}

export interface OverdueItem {
    file: TFile;
    reminder: PropertyReminder;
    propertyTime: number;
    diff: string;
    id: string;
    sourceKey?: string;
    sourceType?: "file" | "kanban-task" | "task-item" | "external-event";
    taskLineNumber?: number;
    taskText?: string;
    checkboxState?: string;
    title?: string;
    body?: string;
    snoozedUntil?: number;
    isAllDay?: boolean;
    status?: string;
    icon?: string;
    color?: string;
    nextTriggerTime?: number;
    nextRuleLabel?: string;
    isRepeating?: boolean;
    nextReminderIntervalMinutes?: number;
}

// ============================================================================
// Controller Settings
// ============================================================================

export interface TPSControllerSettings {
    // Calendar Sync
    syncIntervalMinutes: number;
    archiveFolder: string;
    archiveNotePath: string;
    canceledStatusValue: string;
    orphanArchiveGraceCycles: number;
    externalCalendarFilter: string;
    externalCalendars: ExternalCalendarConfig[];
    syncBackfillDays: number;


    // Frontmatter Key Names (shared with Calendar for sync)
    eventIdKey: string;
    uidKey: string;
    titleKey: string;
    statusKey: string;
    previousStatusKey: string;
    scheduledDateProperty: string;
    scheduledStartProperty: string;
    scheduledEndProperty: string;
    startProperty: string;
    endProperty: string;

    // Notification Rules
    pollMinutes: number;
    enableReminders: boolean;
    notificationPresentationMode: "sidebar" | "modal";
    reminders: PropertyReminder[];
    alertState: AlertState;
    batchNotifications: boolean;
    editorDropLinkEnabled: boolean;
    editorDropLinkHeadingLevel: number;
    editorDropLinkTemplate: string;
    globalIgnorePaths: string[];
    globalIgnoreTags: string[];
    globalIgnoreStatuses: string[];
    snoozeProperty: string;
    snoozeOptions: { label: string; minutes: number }[];
    /** Fallback base time (HH:MM) used for all-day events when no per-reminder allDayBaseTime is set. */
    defaultAllDayBaseTime: string;
    kanbanTaskReminders: KanbanTaskReminderSettings;

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
    archiveFolder: "Archive",
    archiveNotePath: "Archive/Archive.md",
    canceledStatusValue: "cancelled",
    orphanArchiveGraceCycles: 5,
    externalCalendarFilter: "",
    externalCalendars: [],
    syncBackfillDays: 0,


    // Frontmatter Keys
    eventIdKey: "externalEventId",
    uidKey: "tpsCalendarUid",
    titleKey: "title",
    statusKey: "status",
    previousStatusKey: "tpsCalendarPrevStatus",
    scheduledDateProperty: "",
    scheduledStartProperty: "",
    scheduledEndProperty: "",
    startProperty: "scheduled",
    endProperty: "timeEstimate",

    // Notification Rules
    pollMinutes: 0.5,
    enableReminders: true,
    notificationPresentationMode: "sidebar",
    reminders: [],
    alertState: {},
    batchNotifications: true,
    editorDropLinkEnabled: true,
    editorDropLinkHeadingLevel: 2,
    editorDropLinkTemplate: "{{heading}} {{wikilink}}",
    globalIgnorePaths: ["System/"],
    globalIgnoreTags: ["archive", "template"],
    globalIgnoreStatuses: ["complete", "wont-do"],
    snoozeProperty: "reminderSnooze",
    defaultAllDayBaseTime: "09:00",
    kanbanTaskReminders: {
        enabled: true,
        includeBoardFileTarget: true,
        parseInlineProperties: true,
        parseKanbanDateTokens: true,
        parseTasksEmojiDates: true,
        statusProperty: "status",
        completeStatusValue: "complete",
        wontDoStatusValue: "wont-do",
        scheduledPropertyAliases: ["scheduled", "start"],
        duePropertyAliases: ["due", "duedate", "due-date"],
        startPropertyAliases: ["start", "startdate", "start-date"],
    },
    snoozeOptions: [
        { label: '15 Minutes', minutes: 15 },
        { label: '1 Hour', minutes: 60 },
        { label: '4 Hours', minutes: 240 },
        { label: '1 Day', minutes: 1440 },
    ],

    // Companion Automation (DISABLED - companion plugin auto-applies on each device to prevent sync race conditions)
    companionStartupScanEnabled: false,
    companionStartupDelayMs: 800,
    companionUpstreamPropagation: true,

    // Debug
    enableLogging: false,

    // Migration
    _migratedFromPlugins: false,
};
