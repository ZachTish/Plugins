import { TFile, MarkdownView } from 'obsidian';

export type RuleOperator = 'is' | '!is' | 'contains' | '!contains' | 'exists' | '!exists';
export type SmartRuleOperator =
  | RuleOperator
  | 'is-not-empty'
  | 'starts'
  | '!starts'
  | 'within-next-days'
  | '!within-next-days'
  | 'has-open-checkboxes'
  | '!has-open-checkboxes'
  | 'is-today'
  | '!is-today'
  | 'is-before-today'
  | '!is-before-today'
  | 'is-after-today'
  | '!is-after-today';
export type RuleMatchMode = 'all' | 'any';
export type RuleConditionSource =
  | 'frontmatter'
  | 'path'
  | 'extension'
  | 'name'
  | 'tag'
  | 'tag-note-name'
  | 'body'
  | 'backlink'
  | 'date-created'
  | 'date-modified'
  | 'parent-frontmatter'
  | 'parent-tag'
  | 'parent-name'
  | 'parent-path';

export interface RuleCondition {
  source: RuleConditionSource;
  field: string;
  operator: SmartRuleOperator;
  value: string;
}

export interface IconColorRule {
  id: string;
  name: string;
  enabled: boolean;
  property: string;
  operator: RuleOperator;
  value: string;
  pathPrefix: string;
  icon: string;
  color: string;
  match: RuleMatchMode;
  conditions: RuleCondition[];
}

export interface SortValueMapping {
  input: string;
  output: string;
}

export type SortFieldType = 'date' | 'status' | 'priority' | 'text' | 'number';

export interface SortCriteria {
  source: RuleConditionSource;
  field: string;
  type: SortFieldType;
  direction: 'asc' | 'desc';
  mappings: SortValueMapping[];
  missingValuePlacement: 'first' | 'last';
}

export interface ConditionGroup {
  id: string;
  match: RuleMatchMode;
  conditions: RuleCondition[];
}

export interface SortBucket {
  id: string;
  enabled: boolean;
  name: string;
  match: RuleMatchMode;
  conditions: RuleCondition[];
  conditionGroups?: ConditionGroup[];
  sortCriteria: SortCriteria[];
}

export interface SmartSortSettings {
  enabled: boolean;
  field: string;
  separator: string;
  appendBasename: boolean;
  relationshipGrouping: 'none' | 'children-under-parent';
  clearWhenNoMatch: boolean;
  buckets: SortBucket[];
}

export interface SortSegmentRule {
  id: string;
  enabled: boolean;
  source: RuleConditionSource;
  field: string;
  fallback: string;
  mappings: SortValueMapping[];
  match: RuleMatchMode;
  conditions: RuleCondition[];
}

export interface HideRule {
  id: string;
  name: string;
  enabled: boolean;
  match: RuleMatchMode;
  conditions: RuleCondition[];
  mode: 'add' | 'remove';
  tagName: string;
}

export interface RuleFileDescriptor {
  path: string;
  name: string;
  basename: string;
  extension: string;
}

export interface RelationshipLineageNode {
  file: RuleFileDescriptor;
  frontmatter: Record<string, unknown> | null;
  tags: string[];
}

export interface RuleEvaluationContext {
  file: RuleFileDescriptor;
  frontmatter: Record<string, unknown> | null;
  tags: string[];
  body?: string;
  backlinks?: string[];
  relationshipLineage?: RelationshipLineageNode[];
  parent?: {
    file: RuleFileDescriptor;
    frontmatter: Record<string, unknown> | null;
    tags: string[];
  };
}

/**
 * Plugin settings interface
 */
export interface CustomPropertyProfile {
  id: string;
  name: string;
  match?: ViewModeRuleMatch;
  conditions?: ViewModeRuleCondition[];
  hidden?: boolean;
  options?: string[]; // Override options for selector
  showInCollapsed?: boolean; // Per-profile override: show on inline menu
  showInContextMenu?: boolean; // Per-profile override: show in context menu
}

export interface CustomProperty {
  id: string;
  label: string;
  key: string;
  type: 'text' | 'number' | 'datetime' | 'selector' | 'list' | 'recurrence' | 'folder' | 'snooze';
  options?: string[]; // For selector
  profiles?: CustomPropertyProfile[];
  disabled?: boolean;
  hidden?: boolean;
  icon?: string;
  showInCollapsed?: boolean; // Whether to show this property in the collapsed inline header
  showInContextMenu?: boolean; // Whether to show this property in the right-click context menu
}



export type GcmLiveMenuPosition = 'left' | 'center' | 'right';
export type ParentLinkFormat = 'wikilink' | 'markdown-title';
export type ChecklistPromotionBehavior = 'remove' | 'complete-and-link' | 'link-only';
export type LinkedSubitemCheckboxStyle = 'native' | 'soft-link' | 'accent';
export interface LinkedSubitemCheckboxMapping {
  checkboxState: string;
  statuses: string[];
  toggleTargetStatus?: string;
  icon?: string;
  label?: string;
}
export type AppearanceSyncMode = 'synced' | 'local';
export type AppearanceSettingKey =
  | 'menuTextScale'
  | 'buttonScale'
  | 'controlScale'
  | 'menuDensity'
  | 'menuRadiusScale'
  | 'liveMenuPosition'
  | 'liveMenuOffsetX'
  | 'liveMenuOffsetY'
  | 'modalWidth'
  | 'modalMaxHeightVh'
  | 'subitemsMarginBottom'
  | 'dailyNavScale'
  | 'dailyNavRestOpacity';

export type ArchiveFolderMode = 'none' | 'daily' | 'weekly' | 'monthly';

export type ViewModeRuleMatch = 'all' | 'any';
export type ViewModeConditionType = 'frontmatter' | 'path' | 'scheduled' | 'daily-note';
export type ViewModeConditionOperator =
  | 'equals'
  | 'contains'
  | 'starts-with'
  | 'ends-with'
  | 'not-equals'
  | 'not-contains'
  | 'exists'
  | 'missing'
  | 'is-empty'
  | 'past'
  | 'future'
  | 'today'
  | 'not-today';

export interface ViewModeRuleCondition {
  type: ViewModeConditionType;
  key?: string;
  operator?: ViewModeConditionOperator;
  value?: string;
}

export interface ViewModeRule {
  mode: string;
  match?: ViewModeRuleMatch;
  conditions?: ViewModeRuleCondition[];
  // Legacy rule format compatibility
  key?: string;
  value?: string;
}

export interface TPSGlobalContextMenuSettings {
  enableLogging: boolean;
  enableInlinePersistentMenus: boolean;
  enableInLivePreview: boolean;
  enableInPreview: boolean;
  enableInSidePanels: boolean;
  inlineMenuOnly: boolean;
  nativeMenuPlacement: 'tps-first' | 'tps-last';
  enableLineItems: boolean; // LINE-ITEMS: Feature flag
  suppressMobileKeyboard: boolean;
  properties: CustomProperty[];
  showCustomPropertiesInInlineUi: boolean;
  showCustomPropertiesInContextMenu: boolean;
  inheritNotebookNavigatorTagColors: boolean;
  notebookNavigatorIconField: string;
  notebookNavigatorColorField: string;
  notebookNavigatorWriteBasesIconFields: boolean;
  notebookNavigatorBasesIconMarkdownField: string;
  notebookNavigatorBasesIconUriField: string;
  notebookNavigatorNoteCheckboxIconColor: string;
  notebookNavigatorClearIconWhenNoMatch: boolean;
  notebookNavigatorClearColorWhenNoMatch: boolean;
  notebookNavigatorAutoRemoveHiddenWhenNoMatch: boolean;
  notebookNavigatorFrontmatterWriteExclusions: string;
  notebookNavigatorRules: IconColorRule[];
  notebookNavigatorSmartSort: SmartSortSettings;
  notebookNavigatorHideRules: HideRule[];

  // Recurrence settings
  enableRecurrence: boolean;
  promptOnRecurrenceEdit: boolean;
  recurrencePromptTimeout: number; // Minutes
  recurrenceCompletionStatuses: string[];
  recurrenceDefaultStatus: string; // Default status for new recurrence instances
  recurringTemplateFolder: string; // Folder to store recurring event templates

  // File naming settings

  enableAutoRename: boolean;
  dateSuffixFormat: string; // Moment.js format for the date appended to filenames (empty = use daily note format)
  autoSyncTitleFromFilename: boolean;
  autoSaveFolderPath: boolean;
  seedNewSubitemVisualMetadata: boolean;
  applyCompanionRulesOnSubitemCreate: boolean;
  frontmatterAutoWriteExclusions: string;
  folderExclusions: string;
  checkOpenChecklistItems: boolean;
  checkParentLinkStatuses: boolean;
  parentLinkFrontmatterKey: string;
  /** @deprecated Parent-side reverse links are no longer canonical. */
  childLinkFrontmatterKey?: string;
  autoSelfLinkParentInParentKey: boolean;
  parentLinkFormat: ParentLinkFormat;
  parentTagOnChildLink: string;
  parentCompletionStatuses: string[];
  ignoredBacklinksFrontmatterKeys: string[];
  ignoredSubitemTags: string[];

  // View Mode Settings
  enableViewModeSwitching: boolean;
  enableInlineManualViewMode: boolean;
  viewModeFrontmatterKey: string;
  viewModeIgnoredFolders: string;
  viewModeRules: ViewModeRule[];

  checklistFinalPromptStatuses: string[];
  enableLinkedSubitemCheckboxes: boolean;
  linkedSubitemCheckboxStyle: LinkedSubitemCheckboxStyle;
  linkedSubitemCheckboxMappings: LinkedSubitemCheckboxMapping[];
  linkedSubitemDefaultOpenState: string;
  /** @deprecated migrated into linkedSubitemCheckboxMappings */
  linkedSubitemUncheckedStatuses?: string[];
  /** @deprecated migrated into linkedSubitemCheckboxMappings */
  linkedSubitemCheckedStatuses?: string[];
  /** @deprecated migrated into linkedSubitemCheckboxMappings */
  linkedSubitemCanceledStatuses?: string[];
  /** @deprecated migrated into linkedSubitemCheckboxMappings */
  linkedSubitemToggleCheckedStatus?: string;
  /** @deprecated migrated into linkedSubitemCheckboxMappings */
  linkedSubitemToggleUncheckedStatus?: string;

  // Archive tag automation
  enableArchiveTagMove: boolean;
  archiveTag: string;
  archiveFolderPath: string;
  archiveFolderMode: ArchiveFolderMode;
  /** @deprecated Legacy boolean retained for settings migration. */
  archiveUseDailyFolder: boolean;
  lastArchiveTagSweepDate?: string;

  // Workspace Ribbon Buttons
  workspaceRibbonButtons: boolean;
  workspaceRibbonIcons: Record<string, string>;

  // Canvas & Bases split-open behavior (desktop only)
  enableCanvasBaseSplit: boolean;

  // Daily Note Navigation
  enableDailyNoteNav: boolean;
  enableTopParentNav: boolean;
  ignoreEmbeddedChildrenInTopLinks: boolean;
  dailyNavShowToday: boolean;
  enableScheduledLinkGuard: boolean;
  enableAutoPopulateDailyNotes: boolean;
  enableDailyNoteScheduledNormalization: boolean;

  // Overlay ignore rules
  subitems_IgnoreRules: ViewModeRule[];
  inlineMenu_IgnoreRules: ViewModeRule[];

  // Auto-embed ignore settings
  autoEmbedIgnoreFolders: string[];
  autoEmbedIgnoreTags: string[];

  // Auto-insert blank line on note open
  enableAutoInsertBlankLineOnOpen: boolean;

  // Default paths for new items
  defaultAttachmentsPath: string;
  defaultSubitemsPath: string;
  defaultNewSubitemStatus: string;
  defaultNewSubitemPriority: string;
  checklistPromotionBehavior: ChecklistPromotionBehavior;

  // Appearance (Navigator-style controls)
  menuTextScale: number;
  buttonScale: number;
  controlScale: number;
  menuDensity: number;
  menuRadiusScale: number;
  inlinePanelMaxWidth: number;
  liveMenuPosition: GcmLiveMenuPosition;
  liveMenuOffsetX: number;
  liveMenuOffsetY: number;
  modalWidth: number;
  modalMaxHeightVh: number;
  subitemsMarginBottom: number;
  dailyNavScale: number;
  dailyNavRestOpacity: number;
  appearanceSyncModes: Partial<Record<AppearanceSettingKey, AppearanceSyncMode>>;
}

/**
 * Frontmatter data structure for TPS notes
 */
export interface FrontmatterData {
  status?: string;
  priority?: string;
  prio?: string;
  title?: string;
  scheduled?: string;
  sheduledEnd?: string;
  timeEstimate?: number;
  tags?: string | string[];
  recurrenceRule?: string;
  recurrence?: string;
  [key: string]: any;
}

/**
 * File entry with associated frontmatter
 */
export interface FileEntry {
  file: TFile;
  frontmatter: FrontmatterData;
}

/**
 * Context event data for reopening native menus
 */
export interface ContextEventData {
  target: HTMLElement;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  button: number;
}

/**
 * Options for showing menu
 */
export interface ShowMenuOptions {
  files: TFile[];
  event: MouseEvent;
  sourceEl: HTMLElement;
}

/**
 * Options for building special panel
 */
export interface BuildPanelOptions {
  recurrenceRoot?: HTMLElement | null;
  closeAfterRecurrence?: boolean;
}

/**
 * Recurrence rule button option
 */
export interface RecurrenceOption {
  label: string;
  value: string;
}

/**
 * Parsed recurrence rule structure
 */
export interface ParsedRecurrence {
  freq: string | null;
  interval: number;
  byDay: string[];
}

/**
 * Menu instances for a markdown view
 */
export interface MenuInstances {
  reading?: HTMLElement | null;
  live?: HTMLElement | null;
  filePath?: string;
}

/**
 * Date row creation result
 */
export interface DateRowResult {
  row: HTMLElement;
  input: HTMLInputElement;
}

/**
 * End row creation result
 */
export interface EndRowResult {
  row: HTMLElement;
  input: HTMLInputElement;
  refresh: () => void;
}
