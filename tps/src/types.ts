/**
 * TPS Unified Plugin - Shared Type Definitions
 * Merged from all 7 TPS plugins
 */

import { TFile } from "obsidian";

// ============================================================================
// Core Plugin Types
// ============================================================================

export type DeviceRole = "controller" | "user" | "standalone";

export interface TPSSettings {
    version: number;
    features: {
        controller: ControllerSettings;
        contextMenu: ContextMenuSettings;
        calendar: CalendarSettings;
        navigator: NavigatorSettings;
        notifier: NotifierSettings;
        kanban: KanbanSettings;
        autoEmbed: AutoEmbedSettings;
    };
    debug: {
        enableLogging: boolean;
        logLevel: "error" | "warn" | "info" | "debug";
    };
    _migratedFromPlugins: boolean;
}

// ============================================================================
// Controller Types
// ============================================================================

export interface ControllerSettings {
    // Device Role
    deviceRole: DeviceRole;
    deviceId: string;

    // Calendar Sync
    syncIntervalMinutes: number;
    noLossSyncMode: boolean;
    syncOnEventDelete: "delete" | "archive" | "nothing";
    archiveFolder: string;
    canceledStatusValue: string;
    externalCalendarFilter: string;
    externalCalendars: ExternalCalendarConfig[];

    // Frontmatter Keys
    eventIdKey: string;
    uidKey: string;
    titleKey: string;
    statusKey: string;
    previousStatusKey: string;
    startProperty: string;
    endProperty: string;

    // Reminders
    pollMinutes: number;
    enableReminders: boolean;
    reminders: PropertyReminder[];
    alertState: AlertState;
    batchNotifications: boolean;
    globalIgnorePaths: string[];
    globalIgnoreTags: string[];
    globalIgnoreStatuses: string[];
    snoozeProperty: string;
    snoozeOptions: { label: string; minutes: number }[];
    defaultAllDayBaseTime: string;
    kanbanTaskReminders: KanbanTaskReminderSettings;

    // Companion Automation
    companionStartupScanEnabled: boolean;
    companionStartupDelayMs: number;
    companionUpstreamPropagation: boolean;
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
    sourceType?: "file" | "kanban-task";
    taskLineNumber?: number;
    taskText?: string;
    title?: string;
    body?: string;
    snoozedUntil?: number;
}

// ============================================================================
// Context Menu Types
// ============================================================================

export interface ContextMenuSettings {
    enabled: boolean;
    menuItems: MenuItemConfig[];
    inlinePanels: InlinePanelConfig[];
    propertyEditing: PropertyEditingConfig;
    subitems: SubitemsConfig;
    viewMode: ViewModeConfig;
    recurrence: RecurrenceConfig;
    gestures: GestureConfig;
    advanced: AdvancedConfig;
}

export interface MenuItemConfig {
    id: string;
    label: string;
    action: string;
    enabled: boolean;
    icon?: string;
    shortcut?: string;
}

export interface InlinePanelConfig {
    id: string;
    type: "properties" | "subitems" | "backlinks" | "calendar";
    enabled: boolean;
    position: "top" | "bottom";
    collapseByDefault: boolean;
}

export interface PropertyEditingConfig {
    enabled: boolean;
    properties: PropertyFieldConfig[];
    profiles: PropertyProfile[];
}

export interface PropertyFieldConfig {
    property: string;
    type: "text" | "number" | "date" | "select" | "multiselect" | "toggle";
    label?: string;
    options?: string[];
    defaultValue?: any;
}

export interface PropertyProfile {
    id: string;
    name: string;
    properties: Record<string, any>;
}

export interface SubitemsConfig {
    enabled: boolean;
    parentProperty: string;
    autoCreate: boolean;
    showInPanel: boolean;
}

export interface ViewModeConfig {
    enabled: boolean;
    rules: ViewModeRule[];
    defaultMode: "source" | "preview" | "reading";
}

export interface ViewModeRule {
    id: string;
    name: string;
    condition: string;
    mode: "source" | "preview" | "reading";
    enabled: boolean;
}

export interface RecurrenceConfig {
    enabled: boolean;
    property: string;
    defaultInterval: string;
}

export interface GestureConfig {
    enabled: boolean;
    swipeToSnooze: boolean;
    longPressToMenu: boolean;
}

export interface AdvancedConfig {
    fileExclusionPaths: string[];
    maxRecentItems: number;
    cacheTimeout: number;
}

// ============================================================================
// Calendar Types
// ============================================================================

export interface CalendarSettings {
    enabled: boolean;
    view: "timeGridWeek" | "dayGridMonth" | "listWeek";
    startHour: number;
    endHour: number;
    eventDisplay: "block" | "list" | "compact";
    showWeekends: boolean;
    showAllDayEvents: boolean;
    externalCalendars: ExternalCalendarConfig[];
    styleRules: CalendarStyleRule[];
}

export interface CalendarStyleRule {
    id: string;
    name: string;
    condition: string;
    color: string;
    backgroundColor?: string;
    borderColor?: string;
}

// ============================================================================
// Notebook Navigator Companion Types
// ============================================================================

export interface NavigatorSettings {
    enabled: boolean;
    rules: NavigatorRule[];
    startupScanEnabled: boolean;
    startupDelayMs: number;
}

export interface NavigatorRule {
    id: string;
    name: string;
    condition: string;
    icon?: string;
    color?: string;
    sortOrder?: "asc" | "desc";
}

// ============================================================================
// Notifier Types
// ============================================================================

export interface NotifierSettings {
    enabled: boolean;
    ntfy: {
        serverUrl: string;
        topic: string;
        username?: string;
        password?: string;
    };
    delivery: {
        batchSize: number;
        batchIntervalSeconds: number;
        retryAttempts: number;
    };
}

// ============================================================================
// Kanban Types
// ============================================================================

export interface KanbanSettings {
    enabled: boolean;
    lanes: KanbanLane[];
    cardDisplay: {
        showProperties: string[];
        showPreview: boolean;
        maxPreviewLength: number;
    };
}

export interface KanbanLane {
    id: string;
    name: string;
    condition: string;
    color?: string;
    limit?: number;
}

// ============================================================================
// Auto Embed Types
// ============================================================================

export interface AutoEmbedSettings {
    enabled: boolean;
    baseFile: string;
    embedPosition: "top" | "bottom";
    excludePaths: string[];
}

// ============================================================================
// Common Utility Types
// ============================================================================

export interface ParentChildLink {
    parent: string;
    child: string;
    linkType: "field" | "link" | "tag";
}

export interface DateRange {
    start: Date;
    end: Date;
    isAllDay: boolean;
}

export interface RecurrenceRule {
    frequency: "daily" | "weekly" | "monthly" | "yearly";
    interval: number;
    until?: Date;
    count?: number;
    byDay?: string[];
    byMonth?: number[];
}

export interface TemplateVariable {
    name: string;
    value: any;
    type: "string" | "number" | "date" | "boolean" | "array";
}

export interface TemplateContext {
    file?: TFile;
    properties?: Record<string, any>;
    variables?: TemplateVariable[];
}

// ============================================================================
// API Types
// ============================================================================

export interface TPSAPI {
    version: string;
    controller: ControllerAPI;
    calendar: CalendarAPI;
    reminders: RemindersAPI;
    contextMenu: ContextMenuAPI;
}

export interface ControllerAPI {
    getRole(): DeviceRole;
    getSettings(): Readonly<ControllerSettings>;
    syncCalendars(): Promise<void>;
}

export interface CalendarAPI {
    getEventsInRange(range: DateRange): ExternalCalendarEvent[];
    refresh(): Promise<void>;
}

export interface RemindersAPI {
    getOverdue(): OverdueItem[];
    snooze(item: OverdueItem, minutes: number): Promise<void>;
    dismiss(item: OverdueItem): Promise<void>;
}

export interface ContextMenuAPI {
    showMenu(file: TFile): void;
    updateInlinePanels(file: TFile): void;
}

// ============================================================================
// Default Settings
// ============================================================================

export const DEFAULT_TPS_SETTINGS: TPSSettings = {
    version: 1,
    _migratedFromPlugins: false,
    debug: {
        enableLogging: false,
        logLevel: "info",
    },
    features: {
        controller: {
            deviceRole: "standalone",
            deviceId: "",
            syncIntervalMinutes: 5,
            noLossSyncMode: true,
            syncOnEventDelete: "nothing",
            archiveFolder: "",
            canceledStatusValue: "cancelled",
            externalCalendarFilter: "",
            externalCalendars: [],
            eventIdKey: "externalEventId",
            uidKey: "tpsCalendarUid",
            titleKey: "title",
            statusKey: "status",
            previousStatusKey: "tpsCalendarPrevStatus",
            startProperty: "scheduled",
            endProperty: "timeEnd",
            pollMinutes: 2.0, // Fixed from 0.5
            enableReminders: true,
            reminders: [],
            alertState: {},
            batchNotifications: true,
            globalIgnorePaths: ["System/"],
            globalIgnoreTags: ["archive", "template"],
            globalIgnoreStatuses: ["complete", "wont-do"],
            snoozeProperty: "reminderSnooze",
            snoozeOptions: [
                { label: '15 Minutes', minutes: 15 },
                { label: '1 Hour', minutes: 60 },
                { label: '4 Hours', minutes: 240 },
                { label: '1 Day', minutes: 1440 },
            ],
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
            companionStartupScanEnabled: false,
            companionStartupDelayMs: 800,
            companionUpstreamPropagation: true,
        },
        contextMenu: {
            enabled: false,
            menuItems: [],
            inlinePanels: [],
            propertyEditing: { enabled: false, properties: [], profiles: [] },
            subitems: { enabled: false, parentProperty: "parent", autoCreate: false, showInPanel: true },
            viewMode: { enabled: false, rules: [], defaultMode: "source" },
            recurrence: { enabled: false, property: "recurrence", defaultInterval: "1 week" },
            gestures: { enabled: false, swipeToSnooze: true, longPressToMenu: true },
            advanced: { fileExclusionPaths: [], maxRecentItems: 50, cacheTimeout: 300000 },
        },
        calendar: {
            enabled: false,
            view: "timeGridWeek",
            startHour: 0,
            endHour: 24,
            eventDisplay: "block",
            showWeekends: true,
            showAllDayEvents: true,
            externalCalendars: [],
            styleRules: [],
        },
        navigator: {
            enabled: false,
            rules: [],
            startupScanEnabled: false,
            startupDelayMs: 800,
        },
        notifier: {
            enabled: false,
            ntfy: { serverUrl: "", topic: "obsidian", username: "", password: "" },
            delivery: { batchSize: 10, batchIntervalSeconds: 5, retryAttempts: 3 },
        },
        kanban: {
            enabled: false,
            lanes: [],
            cardDisplay: { showProperties: [], showPreview: true, maxPreviewLength: 200 },
        },
        autoEmbed: {
            enabled: false,
            baseFile: "",
            embedPosition: "bottom",
            excludePaths: [],
        },
    },
};
