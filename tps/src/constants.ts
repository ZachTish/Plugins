/**
 * TPS Constants
 */

export const SYSTEM_COMMANDS = {
    openFile: 'app:open-file',
    revealInSidebar: 'app:reveal-in-sidebar',
} as const;

export const PLUGIN_NAME = "TPS";
export const PLUGIN_VERSION = "2.0.0";
export const API_VERSION = "2.0.0";

export const MIN_OBSIDIAN_VERSION = "1.8.7";

// Default property names
export const DEFAULT_PROPERTY_NAMES = {
    eventId: "externalEventId",
    uid: "tpsCalendarUid",
    title: "title",
    status: "status",
    previousStatus: "tpsCalendarPrevStatus",
    scheduled: "scheduled",
    due: "due",
    start: "start",
    end: "timeEnd",
    timeEstimate: "timeEstimate",
    reminderSnooze: "reminderSnooze",
    parent: "parent",
    childOf: "childOf",
    recurrence: "recurrence",
} as const;

// Default folder paths
export const DEFAULT_FOLDER_PATHS = {
    archive: "Archive",
    system: "System",
    templates: "System/Templates",
    attachments: "_attachments",
} as const;

// Default status values
export const DEFAULT_STATUS_VALUES = {
    complete: "complete",
    wontDo: "wont-do",
    blocked: "blocked",
    working: "working",
    cancelled: "cancelled",
} as const;

// Default tag names
export const DEFAULT_TAG_NAMES = {
    archive: "archive",
    template: "template",
    task: "task",
    project: "project",
} as const;

// Time constants
export const TIME_CONSTANTS = {
    MINUTE_MS: 60 * 1000,
    HOUR_MS: 60 * 60 * 1000,
    DAY_MS: 24 * 60 * 60 * 1000,
    WEEK_MS: 7 * 24 * 60 * 60 * 1000,
} as const;

// UI Constants
export const UI_CONSTANTS = {
    MAX_RECENT_ITEMS: 50,
    DEBOUNCE_MS: 300,
    THROTTLE_MS: 100,
    CACHE_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
} as const;

// Migration flags
export const MIGRATION_FLAGS = {
    CONTROLLER: "tps-controller",
    CONTEXT_MENU: "tps-global-context-menu",
    CALENDAR: "tps-calendar-base",
    NAVIGATOR: "tps-notebook-navigator-companion",
    NOTIFIER: "tps-notifier",
    KANBAN: "tps-kanban",
    AUTO_EMBED: "tps-auto-base-embed",
} as const;

// Recurrence options for UI dropdowns
export const RECURRENCE_OPTIONS = [
    { value: "FREQ=DAILY", label: "Daily" },
    { value: "FREQ=WEEKLY", label: "Weekly" },
    { value: "FREQ=MONTHLY", label: "Monthly" },
    { value: "FREQ=YEARLY", label: "Yearly" },
] as const;
