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
    { id: 'status', label: 'Status', key: 'status', type: 'selector', options: ['todo', 'working', 'holding', 'wont-do', 'complete'], icon: 'circle-check', showInCollapsed: true },
    { id: 'priority', label: 'Priority', key: 'priority', type: 'selector', options: ['high', 'medium', 'normal', 'low'], icon: 'flag', showInCollapsed: true },
    { id: 'tags', label: 'Tags', key: 'tags', type: 'list', icon: 'tag', showInCollapsed: true },
    { id: 'recurrence', label: 'Recurrence', key: 'recurrence', type: 'recurrence', icon: 'repeat', showInCollapsed: true },
    { id: 'scheduled', label: 'Scheduled', key: 'scheduled', type: 'datetime', icon: 'calendar', showInCollapsed: true },
    { id: 'timeEstimate', label: 'Duration', key: 'timeEstimate', type: 'number', icon: 'clock', showInCollapsed: true },
    { id: 'type', label: 'Type', key: 'folderPath', type: 'folder', icon: 'folder', showInCollapsed: false },
  ],
  showCustomPropertiesInInlineUi: true,
  showCustomPropertiesInContextMenu: true,
  inheritNotebookNavigatorTagColors: true,
  notebookNavigatorIconField: 'icon',
  notebookNavigatorColorField: 'color',
  notebookNavigatorWriteBasesIconFields: false,
  notebookNavigatorBasesIconMarkdownField: 'iconDisplay',
  notebookNavigatorBasesIconUriField: 'iconDisplayUri',
  notebookNavigatorNoteCheckboxIconColor: '',
  notebookNavigatorClearIconWhenNoMatch: false,
  notebookNavigatorClearColorWhenNoMatch: false,
  notebookNavigatorAutoRemoveHiddenWhenNoMatch: true,
  notebookNavigatorFrontmatterWriteExclusions: '',
  notebookNavigatorRules: [],
  notebookNavigatorSmartSort: {
    enabled: false,
    field: 'navigator_sort',
    separator: '_',
    appendBasename: true,
    relationshipGrouping: 'none',
    clearWhenNoMatch: false,
    buckets: [],
  },
  notebookNavigatorHideRules: [],

  // Recurrence settings
  enableRecurrence: true,
  promptOnRecurrenceEdit: true,
  recurrencePromptTimeout: 30, // 30 minutes (syncs across devices)
  recurrenceCompletionStatuses: ['complete', 'wont-do'],
  recurrenceDefaultStatus: 'todo', // Default status for new recurrence instances
  recurringTemplateFolder: 'Recurring Templates', // Folder to store recurring event templates

  // File naming settings
  enableAutoRename: true,
  dateSuffixFormat: "",
  autoSyncTitleFromFilename: false,
  autoSaveFolderPath: false,
  seedNewSubitemVisualMetadata: false,
  applyCompanionRulesOnSubitemCreate: false,
  frontmatterAutoWriteExclusions: "",
  folderExclusions: "",
  checkOpenChecklistItems: true,
  checkParentLinkStatuses: false,
  parentLinkFrontmatterKey: 'childOf',
  childLinkFrontmatterKey: 'parentOf',
  autoSelfLinkParentInParentKey: false,
  parentLinkFormat: 'wikilink',
  parentTagOnChildLink: 'project',
  parentCompletionStatuses: ['complete', 'wont-do'],
  enableViewModeSwitching: false,
  enableInlineManualViewMode: true,
  viewModeFrontmatterKey: 'viewmode',
  viewModeIgnoredFolders: '',
  viewModeRules: [],
  checklistFinalPromptStatuses: ['complete', 'wont-do'],
  enableLinkedSubitemCheckboxes: true,
  linkedSubitemCheckboxStyle: 'soft-link',
  linkedSubitemCheckboxMappings: [
    { checkboxState: '[ ]', statuses: ['todo'], toggleTargetStatus: 'complete', icon: 'square', label: 'Todo' },
    { checkboxState: '[x]', statuses: ['complete'], toggleTargetStatus: 'todo', icon: 'check', label: 'Complete' },
    { checkboxState: '[/]', statuses: ['working'], toggleTargetStatus: 'complete', icon: 'loader', label: 'Working' },
    { checkboxState: '[?]', statuses: ['holding'], toggleTargetStatus: 'todo', icon: 'help-circle', label: 'Holding' },
    { checkboxState: '[-]', statuses: ['wont-do'], toggleTargetStatus: 'todo', icon: 'minus', label: 'Won\u2019t Do' },
  ],
  linkedSubitemDefaultOpenState: '[ ]',
  linkedSubitemUncheckedStatuses: ['todo'],
  linkedSubitemCheckedStatuses: ['complete'],
  linkedSubitemCanceledStatuses: ['wont-do'],
  linkedSubitemToggleCheckedStatus: 'complete',
  linkedSubitemToggleUncheckedStatus: 'todo',
  enableArchiveTagMove: false,
  archiveTag: 'archive',
  archiveFolderPath: 'System/Archive',
  archiveFolderMode: 'none',
  archiveUseDailyFolder: false,
  lastArchiveTagSweepDate: '',

  workspaceRibbonButtons: false,
  workspaceRibbonIcons: {},
  enableCanvasBaseSplit: false,
  enableDailyNoteNav: true,
  enableTopParentNav: true,
  ignoreEmbeddedChildrenInTopLinks: true,
  dailyNavShowToday: true,
  enableScheduledLinkGuard: false,
  enableAutoPopulateDailyNotes: false,
  enableDailyNoteScheduledNormalization: true,

  // Overlay ignore rules
  ignoredBacklinksFrontmatterKeys: ['dateModified'],
  ignoredSubitemTags: ['hide', 'dailynote', 'project'],
  subitems_IgnoreRules: [],
  inlineMenu_IgnoreRules: [],

  // Auto-embed ignore settings
  autoEmbedIgnoreFolders: ['Archive'],
  autoEmbedIgnoreTags: ['archive'],

  // Auto-insert blank line on note open
  enableAutoInsertBlankLineOnOpen: true,

  // Default paths for new items
  defaultAttachmentsPath: '',
  defaultSubitemsPath: '',
  defaultNewSubitemStatus: '',
  defaultNewSubitemPriority: '',
  checklistPromotionBehavior: 'complete-and-link',

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

export const STATUSES = ['todo', 'working', 'holding', 'wont-do', 'complete'] as const;

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
