/**
 * TPS Unified Plugin - Shared Type Definitions
 * Merged from all 7 TPS plugins
 */

import { TFile } from "obsidian";

export type Frontmatter = Record<string, unknown>;
export type PanelEntry = { file: TFile; frontmatter: Frontmatter };

// ============================================================================
// View-mode types (used by view-mode-service and settings UI)
// ============================================================================

export type ViewModeConditionType = "frontmatter" | "path" | "tag" | "scheduled" | "daily-note" | string;
export type ViewModeConditionOperator = "equals" | "contains" | "starts-with" | "ends-with" | "exists" | "!exists" | "not-equals" | "not-contains" | "is-empty" | "missing" | "past" | "future" | "today" | "not-today" | string;
export type ViewModeRuleMatch = "all" | "any";

export interface ViewModeRuleCondition {
    type: ViewModeConditionType;
    key?: string;
    operator: ViewModeConditionOperator;
    value?: string;
}

// Extended ViewModeRule that supports both legacy single-condition and multi-condition formats.
export interface ViewModeRuleExtended {
    id: string;
    name: string;
    mode: "source" | "preview" | "reading";
    enabled: boolean;
    /** Legacy single-condition string */
    condition?: string;
    /** Multi-condition array (newer format) */
    conditions?: ViewModeRuleCondition[];
    match?: ViewModeRuleMatch;
    /** Legacy key/value pair format */
    key?: string;
    value?: string;
}

// ============================================================================
// Context-menu / GCM types
// ============================================================================

/** Used by view-mode-service; keeps compatibility with code importing TPSGlobalContextMenuSettings */
export interface TPSGlobalContextMenuSettings {
    viewModeFrontmatterKey?: string;
    viewModeRules?: ViewModeRuleExtended[];
    [key: string]: any;
}

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
    // Backwards-compatible top-level rule/navigation settings (some plugins expect these at root)
    rules?: IconColorRule[];
    hideRules?: HideRule[];
    smartSort?: SmartSortSettings;
    autoRemoveHiddenWhenNoMatch?: boolean;
    autoApplyOnFileOpen?: boolean;
    autoApplyOnMetadataChange?: boolean;
    [key: string]: any;
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
    name?: string;
    label?: string;
    active?: boolean;
    enabled?: boolean;
    condition?: string;
    conditions?: CalendarStyleCondition[];
    match?: CalendarStyleMatch;
    color?: string;
    backgroundColor?: string;
    borderColor?: string;
    textColor?: string;
    textStyle?: string;
    icon?: string;
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
    // Backwards-compatible recurrence and companion flags
    recurrenceCompletionStatuses: [],
    // Backwards-compatible defaults for rule/navigation UI
    rules: [],
    hideRules: [],
    smartSort: { enabled: false, field: "", separator: "|", appendBasename: false, clearWhenNoMatch: true, buckets: [] },
    autoRemoveHiddenWhenNoMatch: false,
    autoApplyOnFileOpen: false,
    autoApplyOnMetadataChange: false,
};

// ---------------------------------------------------------------------------
// Rules subsystem compatibility exports (aliases and helpers)
// These types mirror the structures used by the Notebook Navigator Companion
// and related settings/services. Keep minimal but explicit to aid refactors.
// ---------------------------------------------------------------------------

export type RuleMatchMode = "any" | "all";
export type RuleOperator = "is" | "!is" | "contains" | "!contains" | "exists" | "!exists";
export type SmartRuleOperator = RuleOperator | "is-not-empty" | "starts" | "!starts" | "within-next-days" | "!within-next-days" | "has-open-checkboxes" | "!has-open-checkboxes" | "is-today" | "!is-today" | "is-before-today" | "!is-before-today" | "is-after-today" | "!is-after-today";

export type RuleConditionSource =
    | "frontmatter"
    | "path"
    | "extension"
    | "name"
    | "tag"
    | "tag-note-name"
    | "body"
    | "backlink"
    | "date-created"
    | "date-modified"
    | "parent-frontmatter"
    | "parent-tag"
    | "parent-name"
    | "parent-path";

export interface RuleCondition {
    source: RuleConditionSource;
    field?: string;
    operator: SmartRuleOperator;
    value?: string;
}

export interface IconColorRule {
    id: string;
    name?: string;
    enabled: boolean;
    property: string;
    operator: RuleOperator;
    value: string;
    pathPrefix?: string;
    icon?: string;
    color?: string;
    match: RuleMatchMode;
    conditions: RuleCondition[];
}

export interface HideRule {
    id: string;
    name?: string;
    enabled: boolean;
    match: RuleMatchMode;
    conditions: RuleCondition[];
    mode: "add" | "remove";
    tagName?: string;
}

export type SortFieldType = "date" | "status" | "priority" | "text" | "number";

export interface SortValueMapping { input: string; output: string }

export interface SortCriteria {
    source: RuleConditionSource;
    field: string;
    type: SortFieldType;
    direction: "asc" | "desc";
    mappings?: SortValueMapping[];
    missingValuePlacement?: "first" | "last";
}

export interface SortSegmentRule {
    id: string;
    enabled: boolean;
    source: RuleConditionSource;
    field: string;
    fallback?: string;
    mappings?: SortValueMapping[];
    match: RuleMatchMode;
    conditions: RuleCondition[];
}

export interface SortBucket {
    id: string;
    enabled: boolean;
    name: string;
    match: RuleMatchMode;
    conditions: RuleCondition[];
    // Optional nested groups for complex bucket logic (legacy support)
    conditionGroups?: ConditionGroup[];
    sortCriteria: SortCriteria[];
}

export interface ConditionGroup {
    id: string;
    match: RuleMatchMode;
    conditions: RuleCondition[];
}

export interface RuleEvaluationContext {
    file: {
        path: string;
        name: string;
        basename: string;
        extension: string;
    };
    frontmatter: Record<string, unknown> | null;
    tags: string[];
    body?: string;
    backlinks?: string[];
    parent?: {
        file: { path: string; name: string; basename: string; extension: string };
        frontmatter: Record<string, unknown> | null;
        tags: string[];
    };
}

export interface SmartSortSettings {
    enabled: boolean;
    field: string;
    separator: string;
    appendBasename: boolean;
    clearWhenNoMatch: boolean;
    buckets: SortBucket[];
}

export interface NotebookNavigatorCompanionSettings {
    enabled: boolean;
    autoApplyOnFileOpen: boolean;
    autoApplyOnMetadataChange: boolean;
    applyOnStartup: boolean;
    startupDelayMs: number;
    metadataDebounceMs: number;
    syncTitleFromFilename: boolean;
    syncFilenameFromTitle: boolean;
    frontmatterIconField: string;
    frontmatterColorField: string;
    writeBasesIconFields: boolean;
    basesIconMarkdownField: string;
    basesIconUriField: string;
    upstreamLinkKeys: string[];
    frontmatterWriteExclusions: string;
    noteCheckboxIconColor?: string;
    clearIconWhenNoMatch: boolean;
    clearColorWhenNoMatch: boolean;
    autoRemoveHiddenWhenNoMatch: boolean;
    debugLogging: boolean;
    rules: IconColorRule[];
    smartSort: SmartSortSettings;
    hideRules: HideRule[];
}

// Backwards-compatible export names and helpers expected by rules code
export const DEFAULT_SETTINGS: NotebookNavigatorCompanionSettings = {
    enabled: false,
    autoApplyOnFileOpen: false,
    autoApplyOnMetadataChange: false,
    applyOnStartup: false,
    startupDelayMs: 800,
    metadataDebounceMs: 900,
    syncTitleFromFilename: false,
    syncFilenameFromTitle: false,
    frontmatterIconField: "icon",
    frontmatterColorField: "color",
    writeBasesIconFields: false,
    basesIconMarkdownField: "basesIconMarkdown",
    basesIconUriField: "basesIconUri",
    upstreamLinkKeys: [],
    frontmatterWriteExclusions: "",
    clearIconWhenNoMatch: true,
    clearColorWhenNoMatch: true,
    autoRemoveHiddenWhenNoMatch: false,
    debugLogging: false,
    rules: [],
    smartSort: { enabled: false, field: "", separator: "|", appendBasename: false, clearWhenNoMatch: true, buckets: [] },
    hideRules: []
};

export function createRuleId(): string { return `rule-${Date.now()}-${Math.floor(Math.random()*1000)}`; }
export function createSortSegmentId(): string { return `segment-${Date.now()}-${Math.floor(Math.random()*1000)}`; }
export function createSortBucketId(): string { return `bucket-${Date.now()}-${Math.floor(Math.random()*1000)}`; }

export function createDefaultSortSegment(): SortSegmentRule {
    return {
        id: createSortSegmentId(), enabled: true, source: "frontmatter", field: "status", fallback: "", mappings: [], match: "all", conditions: []
    };
}

export function createDefaultSortCriteria(): SortCriteria {
    return { source: "frontmatter", field: "", type: "text", direction: "asc", mappings: [], missingValuePlacement: "last" };
}

export function createDefaultRule(): IconColorRule {
    return { id: createRuleId(), name: "", enabled: true, property: "", operator: "is", value: "", pathPrefix: "", icon: "", color: "", match: "all", conditions: [] };
}

export function createDefaultSortBucket(): SortBucket {
    return { id: createSortBucketId(), enabled: true, name: "New Bucket", match: "all", conditions: [], conditionGroups: [], sortCriteria: [] };
}

// ============================================================================
// Calendar style rule types (used by style-rule-service and visual-builder)
// ============================================================================

export type CalendarField = "status" | "priority" | "tag" | "folder" | "frontmatter" | string;
export type CalendarOperator = "equals" | "contains" | "starts-with" | "exists" | "!exists" | string;
export type CalendarStyleMatch = "all" | "any";

export interface CalendarStyleCondition {
    field: CalendarField;
    operator: CalendarOperator;
    value?: string;
}

// ============================================================================
// Property / Profile types (used by modals and resolve-profiles service)
// ============================================================================

export interface CustomPropertyProfile {
    id: string;
    name: string;
    hidden?: boolean;
    options?: string[];
    showInCollapsed?: boolean;
    showInContextMenu?: boolean;
    [key: string]: any;
}

export interface CustomProperty {
    key: string;
    type?: string;
    id?: string;
    label?: string;
    options?: string[];
    profiles?: CustomPropertyProfile[];
    showInCollapsed?: boolean;
    showInContextMenu?: boolean;
    disabled?: boolean;
    hidden?: boolean;
    [key: string]: any;
}

// ============================================================================
// Calendar plugin settings (used by settings-migration and calendar services)
// ============================================================================

export interface CalendarPluginSettings {
    enableExternalCalendars: boolean;
    syncIntervalMinutes: number;
    sidebarBasePath: string | null;
    dailyDateLinkTarget: string;
    primaryControllerId: string | null;
    priorityValues: readonly string[];
    statusValues: readonly string[];
    defaultCondenseLevel: number;
    externalCalendars: ExternalCalendarConfig[];
    externalCalendarFilter: string;
    enableLogging: boolean;
    syncOnEventDelete: "archive" | "delete" | "nothing";
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
    [key: string]: any;
}

