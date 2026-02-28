import { TPSGlobalContextMenuSettings } from './types';

export const DEFAULT_SETTINGS: TPSGlobalContextMenuSettings = {
  enableLogging: false,
  enableInlinePersistentMenus: true,
  enableInLivePreview: true,
  enableInPreview: true,
  enableInSidePanels: true,
  inlineMenuOnly: false,
  nativeMenuPlacement: 'tps-last',
  enableLineItems: false, // LINE-ITEMS: Feature flag
  suppressMobileKeyboard: true,
  properties: [
    { id: 'status', label: 'Status', key: 'status', type: 'selector', options: ['open', 'working', 'blocked', 'wont-do', 'complete'], icon: 'circle-check', showInCollapsed: true },
    { id: 'priority', label: 'Priority', key: 'priority', type: 'selector', options: ['high', 'medium', 'normal', 'low'], icon: 'flag', showInCollapsed: true },
    { id: 'tags', label: 'Tags', key: 'tags', type: 'list', icon: 'tag', showInCollapsed: true },
    { id: 'recurrence', label: 'Recurrence', key: 'recurrence', type: 'recurrence', icon: 'repeat', showInCollapsed: true },
    { id: 'scheduled', label: 'Scheduled', key: 'scheduled', type: 'datetime', icon: 'calendar', showInCollapsed: true },
    { id: 'type', label: 'Type', key: 'folderPath', type: 'folder', icon: 'folder', showInCollapsed: false },
  ],

  // Recurrence settings
  enableRecurrence: true,
  promptOnRecurrenceEdit: true,
  recurrencePromptTimeout: 30, // 30 minutes (syncs across devices)
  recurrenceCompletionStatuses: ['complete', 'wont-do'],
  recurrenceDefaultStatus: 'open', // Default status for new recurrence instances

  // File naming settings
  enableAutoRename: true,
  autoSyncTitleFromFilename: false,
  autoSaveFolderPath: false,
  seedNewSubitemVisualMetadata: false,
  applyCompanionRulesOnSubitemCreate: false,
  frontmatterAutoWriteExclusions: "",
  folderExclusions: "",
  checkOpenChecklistItems: true,
  checkParentLinkStatuses: false,
  parentLinkFrontmatterKey: 'parent',
  parentLinkFormat: 'wikilink',
  parentTagOnChildLink: 'project',
  parentCompletionStatuses: ['complete', 'wont-do'],
  enableViewModeSwitching: true,
  enableInlineManualViewMode: true,
  viewModeFrontmatterKey: 'viewmode',
  viewModeIgnoredFolders: '',
  viewModeRules: [],
  systemCommands: ['open-in-new-tab', 'duplicate', 'get-relative-path'],
  enableTaskCheckboxCycle: true,
  enableArchiveTagMove: false,
  archiveTag: 'archive',
  archiveFolderPath: 'System/Archive',
  archiveUseDailyFolder: false,
  enableDailyNoteNav: true,
  enableTopParentNav: true,
  dailyNavShowToday: true,

  // Overlay ignore rules
  subitems_IgnoreRules: [],
  inlineMenu_IgnoreRules: [],
  enableSubitemsPanel: true,
  showChecklistInSubitemsPanel: true,
  showReferencesInSubitemsPanel: true,
  showMentionsInSubitemsPanel: true,

  // Default paths for new items
  defaultAttachmentsPath: '',
  defaultSubitemsPath: '',

  menuTextScale: 1,
  buttonScale: 1,
  controlScale: 1,
  menuDensity: 1,
  menuRadiusScale: 1,
  inlinePanelMaxWidth: 700,
  liveMenuPosition: 'center',
  liveMenuOffsetX: 0,
  liveMenuOffsetY: 0,
  modalWidth: 520,
  modalMaxHeightVh: 80,
  subitemsMarginBottom: 0,
  dailyNavScale: 1,
  dailyNavRestOpacity: 0,
  appearanceSyncModes: {},
};

export const SYSTEM_COMMANDS = [
  { id: 'open-in-new-tab', label: 'Open in New Tab', icon: 'plus-square' },
  { id: 'open-in-same-tab', label: 'Open in Same Tab', icon: 'file' },
  { id: 'duplicate', label: 'Duplicate File', icon: 'copy' },
  { id: 'get-relative-path', label: 'Copy Relative Path', icon: 'link' },
] as const;

export const STATUSES = ['open', 'working', 'blocked', 'wont-do', 'complete'] as const;

/**
 * Available priority levels
 */
export const PRIORITIES = ['high', 'medium', 'normal', 'low'] as const;

/**
 * Recurrence rule quick options
 */
export const RECURRENCE_OPTIONS = [
  { label: 'Daily', value: 'RRULE:FREQ=DAILY' },
  { label: 'Weekdays', value: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
  { label: 'Weekly', value: 'RRULE:FREQ=WEEKLY' },
  { label: 'Monthly', value: 'RRULE:FREQ=MONTHLY' },
] as const;

