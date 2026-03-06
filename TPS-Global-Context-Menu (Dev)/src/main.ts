import { Plugin, TFile, WorkspaceLeaf, Menu, debounce, Notice, normalizePath } from 'obsidian';
import { TPSGlobalContextMenuSettings, BuildPanelOptions } from './types';
import { DEFAULT_SETTINGS } from './constants';
import { PLUGIN_STYLES } from './plugin-styles';
import { MenuController } from './menu/menu-controller';
import { PersistentMenuManager } from './menu/persistent-menu-manager';
import { setupMenuPatch } from './menu/menu-patcher';
import { TPSGlobalContextMenuSettingTab } from './settings-tab';
import { BulkEditService } from './services/bulk-edit-service';
import { RecurrenceService } from './services/recurrence-service';
import { FileNamingService } from './services/file-naming-service';
import { AutoFrontmatterExclusionService } from './services/file-exclusion-service';
import { ViewModeManager } from './handlers/view-mode-manager';
import { DailyNoteNavManager } from './handlers/daily-note-nav-manager';
import { TaskCheckboxHandler } from './handlers/task-checkbox-handler';
import { ContextTargetService } from './services/context-target-service';
import { NoteOperationService } from './services/note-operation-service';
import { FieldInitializationService } from './services/field-initialization-service';
import { installDateContainsPolyfill } from './compat';
import * as logger from './logger';
import { CommandQueueService, getErrorMessage, getPluginById } from './core';
import { VaultQueryService } from './services/vault-query-service';
import { TaskIdentityService } from './services/task-identity-service';
import { BacklinksView, BACKLINKS_VIEW_TYPE } from './views/backlinks-view';
import { WorkspaceRibbonService } from './services/workspace-ribbon-service';
import { registerGcmEvents } from './events/register-events';
import { registerGcmCommands } from './commands/register-commands';
import { setupPluginApi } from './plugin-api';


export default class TPSGlobalContextMenuPlugin extends Plugin {
  settings: TPSGlobalContextMenuSettings;
  menuController: MenuController;
  persistentMenuManager: PersistentMenuManager;
  bulkEditService: BulkEditService;
  recurrenceService: RecurrenceService;
  fileNamingService: FileNamingService;
  viewModeManager: ViewModeManager;
  dailyNoteNavManager: DailyNoteNavManager;
  contextTargetService: ContextTargetService;
  noteOperationService: NoteOperationService;
  fieldInitializationService: FieldInitializationService;
  commandQueueService: CommandQueueService;
  vaultQueryService: VaultQueryService;
  taskIdentityService: TaskIdentityService;
  workspaceRibbonService: WorkspaceRibbonService;
  styleEl: HTMLStyleElement | null = null;
  ignoreNextContext = false;
  keyboardVisible = false;
  private restoreMenuPatch: (() => void) | null = null;
  private viewModeSuppressedPaths: Set<string> = new Set();
  taskCheckboxHandler: TaskCheckboxHandler;
  private fileExclusionService: AutoFrontmatterExclusionService;

  // Create a debounced save function
  private debouncedSave = debounce(async () => {
    await this.saveData(this.settings);
  }, 1000, false);

  async onload(): Promise<void> {
    this.ignoreNextContext = false;

    await this.loadSettings();
    logger.setLoggingEnabled(this.settings.enableLogging);

    installDateContainsPolyfill();

    this.contextTargetService = new ContextTargetService(this);
    this.bulkEditService = new BulkEditService(this);
    this.recurrenceService = new RecurrenceService(this);
    this.fileNamingService = new FileNamingService(this);
    this.noteOperationService = new NoteOperationService(this);
    this.fieldInitializationService = new FieldInitializationService(this);
    this.commandQueueService = new CommandQueueService();
    this.vaultQueryService = new VaultQueryService(this.app);
    this.taskIdentityService = new TaskIdentityService();
    this.workspaceRibbonService = new WorkspaceRibbonService(this);

    this.menuController = new MenuController(this);
    this.persistentMenuManager = new PersistentMenuManager(this);
    this.viewModeManager = new ViewModeManager(this);
    this.addChild(this.viewModeManager);
    this.dailyNoteNavManager = new DailyNoteNavManager(this);
    this.addChild(this.dailyNoteNavManager);

    this.taskCheckboxHandler = new TaskCheckboxHandler(this);
    this.fileExclusionService = new AutoFrontmatterExclusionService(
      () => this.settings.frontmatterAutoWriteExclusions,
    );

    // Initialize recurrence listener
    this.recurrenceService.setup();

    this.restoreMenuPatch = setupMenuPatch(this);

    this.injectStyles();

    // Register the Backlinks sidebar view
    this.registerView(BACKLINKS_VIEW_TYPE, (leaf) => new BacklinksView(leaf, this));

    // Ribbon icon to toggle the Backlinks panel
    this.addRibbonIcon('links-coming-in', 'Toggle Backlinks panel', () => {
      void this.toggleBacklinksPanel();
    });

    this.keyboardVisible = false;

    this.addSettingTab(new TPSGlobalContextMenuSettingTab(this.app, this));

    // Register all workspace/vault events (includes initial ensureMenus call)
    registerGcmEvents(this);

    // Expose inter-plugin API
    setupPluginApi(this);

    // Check for missing recurrences on startup; build workspace ribbon buttons
    this.app.workspace.onLayoutReady(async () => {
      this.workspaceRibbonService.setup();
      // Wait for metadataCache to finish initial indexing before scanning for
      // missing recurrences. 'resolved' fires once indexing completes; the
      // 6-second fallback handles edge cases where the event fires before we
      // register (already-resolved vaults).
      let startupCheckDone = false;
      const runStartupCheck = async () => {
        if (startupCheckDone) return;
        startupCheckDone = true;
        logger.log('[TPS GCM] Checking for missing recurrences on startup...');
        await this.bulkEditService.checkMissingRecurrences();
      };
      this.registerEvent(
        this.app.metadataCache.on('resolved', () => void runStartupCheck())
      );
      setTimeout(() => void runStartupCheck(), 6000);
    });

    // Capture right-click targets early so file-menu/files-menu can expand accurately.
    this.registerDomEvent(document, 'mousedown', (evt: MouseEvent) => {
      if (evt.button !== 2) return;
      this.contextTargetService.recordContextTarget(evt.target);
    }, { capture: true });

    // Manual context interception for markdown-like link/embed targets only.
    this.registerDomEvent(document, 'contextmenu', (evt: MouseEvent) => {
      if (this.settings.inlineMenuOnly) return;
      const targetEl = evt.target instanceof HTMLElement ? evt.target : null;
      this.contextTargetService.recordContextTarget(targetEl);

      if (!this.contextTargetService.isManualContextInterceptTarget(targetEl)) return;

      const targets = this.contextTargetService.resolveTargets([], evt);
      if (targets.length === 0) return;

      evt.preventDefault();
      evt.stopPropagation();

      const menu = new Menu();
      this.menuController.addToNativeMenu(menu, targets);
      menu.showAtPosition({ x: evt.pageX, y: evt.pageY });
    }, { capture: true });

    // Task checkbox state cycle: [ ] -> [x] -> [?] -> [-] -> [ ]
    this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
      void this.taskCheckboxHandler.handleClick(evt);
    }, { capture: true });

    registerGcmCommands(this);
  }

  onunload(): void {
    this.workspaceRibbonService?.teardown();
    delete (this as any).api;
    if (this.restoreMenuPatch) {
      this.restoreMenuPatch();
      this.restoreMenuPatch = null;
    }
    this.menuController?.detach();
    this.removeStyles();
    this.persistentMenuManager?.detach();
    this.recurrenceService?.cleanup();
    this.taskCheckboxHandler?.dispose();
    document.body?.classList?.remove('tps-context-hidden-for-keyboard');
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<TPSGlobalContextMenuSettings> & {
      enableShiftClickCancel?: boolean;
      archiveFolder?: string;
    } | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
    const legacyArchiveFolder = typeof loaded?.archiveFolder === 'string' ? loaded.archiveFolder.trim() : '';
    if (!this.settings.archiveFolderPath && legacyArchiveFolder) {
      this.settings.archiveFolderPath = legacyArchiveFolder;
    }
    if (
      typeof (loaded as any)?.enableTaskCheckboxCycle !== 'boolean'
      && typeof loaded?.enableShiftClickCancel === 'boolean'
    ) {
      // Backward compatibility for legacy setting key.
      this.settings.enableTaskCheckboxCycle = loaded.enableShiftClickCancel;
    }
    logger.setLoggingEnabled(this.settings.enableLogging);
  }

  private getControllerArchiveFolderPath(): string {
    const plugin = getPluginById(this.app, 'tps-controller') as any;
    const raw = typeof plugin?.settings?.archiveFolder === 'string' ? plugin.settings.archiveFolder : '';
    return raw.trim();
  }

  getArchiveFolderPath(): string {
    const configured = typeof this.settings.archiveFolderPath === 'string'
      ? this.settings.archiveFolderPath.trim()
      : '';
    const legacy = typeof (this.settings as any)?.archiveFolder === 'string'
      ? String((this.settings as any).archiveFolder).trim()
      : '';
    const controller = this.getControllerArchiveFolderPath();
    const resolved = configured || legacy || controller;
    return resolved ? normalizePath(resolved) : '';
  }

  async saveSettings(): Promise<void> {
    logger.setLoggingEnabled(this.settings.enableLogging);
    this.workspaceRibbonService?.refresh();
    this.debouncedSave();
    this.persistentMenuManager?.ensureMenus?.();
    const seen = new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const file = (leaf.view as any)?.file;
      if (!(file instanceof TFile) || seen.has(file.path)) continue;
      seen.add(file.path);
      this.persistentMenuManager?.refreshMenusForFile(file, true, { rebuildInlineSubitems: true });
    }
  }

  injectStyles(): void {
    if (this.styleEl) return;
    const style = document.createElement('style');
    style.id = 'tps-global-context-style';
    style.textContent = PLUGIN_STYLES;
    document.head.appendChild(style);
    this.styleEl = style;
  }

  removeStyles(): void {
    if (this.styleEl) {
      this.styleEl.remove();
      this.styleEl = null;
    }
  }

  createMenuHeader(file: TFile): HTMLElement {
    const div = document.createElement('div');
    div.className = 'tps-global-context-header';
    div.textContent = file.basename;
    return div;
  }

  createMultiMenuHeader(files: TFile[]): HTMLElement {
    const div = document.createElement('div');
    div.className = 'tps-global-context-header';
    div.textContent = `${files.length} files selected`;
    return div;
  }

  buildSpecialPanel(file: TFile | TFile[], options: BuildPanelOptions = {}): HTMLElement | null {
    const files = Array.isArray(file) ? file : [file];
    return this.menuController.buildSpecialPanel(files, options);
  }

  suppressViewModeSwitchForPathUntilFocusChange(path: string): void {
    if (!path) return;
    this.viewModeSuppressedPaths.add(path);
  }

  shouldSkipViewModeSwitch(): boolean {
    const activePath = this.app.workspace.getActiveFile()?.path;
    if (!activePath) return false;
    return this.viewModeSuppressedPaths.has(activePath);
  }

  shouldIgnoreAutoFrontmatterWrite(file: TFile): boolean {
    return this.fileExclusionService.shouldIgnore(file);
  }

  matchesAutoFrontmatterExclusionPattern(
    normalizedPath: string,
    normalizedBasename: string,
    rawPattern: string,
  ): boolean {
    return this.fileExclusionService.matchesPattern(normalizedPath, normalizedBasename, rawPattern);
  }

  async openFileInLeaf(
    file: TFile,
    context: 'tab' | 'split' | 'window' | false,
    getLeaf: () => WorkspaceLeaf | null,
    options?: { revealLeaf?: boolean; active?: boolean },
  ): Promise<boolean> {
    const openActive = options?.active ?? true;
    const revealLeaf = options?.revealLeaf !== false;

    const openFile = async () => {
      const leaf = getLeaf();
      if (!leaf) {
        throw new Error('No workspace leaf available');
      }
      await leaf.openFile(file, { active: openActive } as any);
      if (revealLeaf) {
        this.app.workspace.revealLeaf(leaf);
      }
    };

    const result = context === false
      ? await this.commandQueueService.executeOpenActiveFile(file, openFile)
      : await this.commandQueueService.executeOpenInNewContext(file, context, openFile);

    if (!result.success) {
      const message = getErrorMessage(result.error, 'Could not open file');
      logger.error('[TPS GCM] File open failed', { file: file.path, context, message, error: result.error });
      new Notice(message);
      return false;
    }

    return true;
  }

  async runQueuedMove(files: TFile[], performMove: () => Promise<void>): Promise<boolean> {
    const result = await this.commandQueueService.executeMoveFiles(files, performMove);
    if (!result.success) {
      const message = getErrorMessage(result.error, 'Move failed');
      logger.error('[TPS GCM] Move operation failed', { files: files.map((file) => file.path), message, error: result.error });
      new Notice(message);
      return false;
    }
    return true;
  }

  async runQueuedDelete(files: TFile[], performDelete: () => Promise<void>): Promise<boolean> {
    const result = await this.commandQueueService.executeDeleteFiles(files, performDelete);
    if (!result.success) {
      const message = getErrorMessage(result.error, 'Delete failed');
      logger.error('[TPS GCM] Delete operation failed', { files: files.map((file) => file.path), message, error: result.error });
      new Notice(message);
      return false;
    }
    return true;
  }

  // Mobile keyboard watcher moved to PersistentMenuManager

  async toggleBacklinksPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(BACKLINKS_VIEW_TYPE);
    if (existing.length > 0) {
      // If already open, close it
      existing.forEach((leaf) => leaf.detach());
      return;
    }

    // Open in the right sidebar
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: BACKLINKS_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

}
