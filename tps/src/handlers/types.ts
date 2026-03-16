import { TFile, MarkdownView } from 'obsidian';

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

  // Recurrence settings
  enableRecurrence: boolean;
  promptOnRecurrenceEdit: boolean;
  recurrencePromptTimeout: number; // Minutes
  recurrenceCompletionStatuses: string[];
  recurrenceDefaultStatus: string; // Default status for new recurrence instances
  recurringTemplateFolder: string; // Folder to store recurring event templates

  // File naming settings

  enableAutoRename: boolean;
  autoSyncTitleFromFilename: boolean;
  autoSaveFolderPath: boolean;
  seedNewSubitemVisualMetadata: boolean;
  applyCompanionRulesOnSubitemCreate: boolean;
  frontmatterAutoWriteExclusions: string;
  folderExclusions: string;
  checkOpenChecklistItems: boolean;
  checkParentLinkStatuses: boolean;
  parentLinkFrontmatterKey: string;
  childLinkFrontmatterKey: string;
  autoSelfLinkParentInParentKey: boolean;
  parentLinkFormat: ParentLinkFormat;
  parentTagOnChildLink: string;
  parentCompletionStatuses: string[];
  ignoredBacklinksFrontmatterKeys: string[];

  // View Mode Settings
  enableViewModeSwitching: boolean;
  enableInlineManualViewMode: boolean;
  viewModeFrontmatterKey: string;
  viewModeIgnoredFolders: string;
  viewModeRules: ViewModeRule[];

  // System commands
  systemCommands: string[];

  // Checkbox behavior
  enableTaskCheckboxCycle: boolean;
  enableChecklistCompletionProperty: boolean;
  checklistCompletionPropertyKey: string;
  checklistFinalPromptStatuses: string[];

  // Archive tag automation
  enableArchiveTagMove: boolean;
  archiveTag: string;
  archiveFolderPath: string;
  archiveUseDailyFolder: boolean;
  lastArchiveTagSweepDate?: string;

  // Workspace Ribbon Buttons
  // Pomodoro Timer Settings
  enablePomodoro: boolean;
  pomodoroWorkDuration: number;
  pomodoroBreakDuration: number;
  pomodoroLongBreakDuration: number;
  pomodoroLongBreakInterval: number;
  pomodoroEventFolder: string;
  pomodoroDefaultTags: string;


  workspaceRibbonButtons: boolean;
  workspaceRibbonIcons: Record<string, string>;

  // Canvas & Bases split-open behavior (desktop only)
  enableCanvasBaseSplit: boolean;

  // Daily Note Navigation
  enableDailyNoteNav: boolean;
  enableTopParentNav: boolean;
  ignoreEmbeddedChildrenInTopLinks: boolean;
  dailyNavShowToday: boolean;

  // Overlay ignore rules
  subitems_IgnoreRules: ViewModeRule[];
  inlineMenu_IgnoreRules: ViewModeRule[];
  enableSubitemsPanel: boolean;
  showChecklistInSubitemsPanel: boolean;
  showReferencesInSubitemsPanel: boolean;
  showMentionsInSubitemsPanel: boolean;
  showInlineNoteGraph: boolean;
  noteGraphDepth: number;
  noteGraphMaxIncoming: number;
  noteGraphMaxOutgoing: number;
  noteGraphMaxMentions: number;
  subitemsPanelPosition: 'above' | 'below';
  subitemsPanelAutoCollapse: boolean;

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
