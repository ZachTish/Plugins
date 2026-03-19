import { Plugin, TFile, WorkspaceLeaf, Menu, debounce, Notice, normalizePath, Platform } from 'obsidian';
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
import { WorkspaceRibbonService } from './services/workspace-ribbon-service';
import { PomodoroService } from './services/pomodoro-service';
import { registerGcmEvents } from './events/register-events';
import { registerGcmCommands } from './commands/register-commands';
import { setupPluginApi } from './plugin-api';


export default class TPSGlobalContextMenuPlugin extends Plugin {
  private static readonly BUILD_STAMP = '2026-03-11 18:12';
  private readonly startupTimestamp = Date.now();
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
  pomodoroService: PomodoroService;
  styleEl: HTMLStyleElement | null = null;
  ignoreNextContext = false;
  keyboardVisible = false;
  private archiveSweepTimerId: number | null = null;
  private restoreMenuPatch: (() => void) | null = null;
  private restoreCanvasOpenGuard: (() => void) | null = null;
  private viewModeSuppressedPaths: Set<string> = new Set();
  private canvasPointerSession:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        moved: boolean;
      }
    | null = null;
  private canvasMouseSession:
    | {
        startX: number;
        startY: number;
        moved: boolean;
      }
    | null = null;
  private recentCanvasDragUntil = 0;
  taskCheckboxHandler: TaskCheckboxHandler;
  private fileExclusionService: AutoFrontmatterExclusionService;

  // Create a debounced save function
  private debouncedSave = debounce(async () => {
    await this.saveData(this.settings);
  }, 1000, false);

  private isCanvasOrBasesInteractionTarget(target: EventTarget | null): target is HTMLElement {
    if (!(target instanceof HTMLElement)) return false;
    return !!target.closest(
      [
        '.canvas-wrapper',
        '.canvas-node',
        '.canvas-node-content',
        '.bases-feed-entry',
        '.bases-calendar-event-content',
        '.tps-calendar-entry',
      ].join(', '),
    );
  }

  private suppressCanvasActivationEvent(evt: MouseEvent): boolean {
    if (!this.shouldSuppressOpenForRecentCanvasDrag()) return false;
    if (!this.isCanvasOrBasesInteractionTarget(evt.target)) return false;

    evt.preventDefault();
    evt.stopImmediatePropagation();
    evt.stopPropagation();

    logger.log('[TPS GCM] Suppressed click activation after recent canvas drag', {
      eventType: evt.type,
      target: evt.target instanceof HTMLElement ? evt.target.className : null,
    });
    return true;
  }

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
    this.pomodoroService = new PomodoroService(this);

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
    this.restoreCanvasOpenGuard = this.installCanvasOpenGuard();

    this.injectStyles();

    this.keyboardVisible = false;

    this.addSettingTab(new TPSGlobalContextMenuSettingTab(this.app, this));

    logger.log('[TPS GCM] Runtime build loaded', {
      build: TPSGlobalContextMenuPlugin.BUILD_STAMP,
      dir: this.manifest.dir,
    });

    // Register all workspace/vault events (includes initial ensureMenus call)
    registerGcmEvents(this);
    this.startArchiveTagAutomation();

    // Expose inter-plugin API
    setupPluginApi(this);

    // Check for missing recurrences on startup; build workspace ribbon buttons
    this.app.workspace.onLayoutReady(async () => {
      for (const leaf of this.app.workspace.getLeavesOfType('tps-gcm-backlinks')) {
        leaf.detach();
      }
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

    this.registerDomEvent(document, 'mousedown', (evt: MouseEvent) => {
      if (evt.button !== 0) return;
      if (!this.isCanvasOrBasesInteractionTarget(evt.target)) {
        this.canvasMouseSession = null;
        return;
      }
      this.canvasMouseSession = {
        startX: evt.clientX,
        startY: evt.clientY,
        moved: false,
      };
    }, { capture: true });

    this.registerDomEvent(document, 'pointerdown', (evt: PointerEvent) => {
      if (evt.button !== 0) return;
      if (!this.isCanvasOrBasesInteractionTarget(evt.target)) {
        this.canvasPointerSession = null;
        return;
      }
      this.canvasPointerSession = {
        pointerId: evt.pointerId,
        startX: evt.clientX,
        startY: evt.clientY,
        moved: false,
      };
    }, { capture: true });

    this.registerDomEvent(document, 'pointermove', (evt: PointerEvent) => {
      const session = this.canvasPointerSession;
      if (!session || session.pointerId !== evt.pointerId) return;
      const dx = evt.clientX - session.startX;
      const dy = evt.clientY - session.startY;
      if (!session.moved && Math.hypot(dx, dy) >= 6) {
        session.moved = true;
        this.markRecentCanvasDrag(1500);
      }
    }, { capture: true, passive: true });

    this.registerDomEvent(document, 'mousemove', (evt: MouseEvent) => {
      const session = this.canvasMouseSession;
      if (!session || (evt.buttons & 1) === 0) return;
      const dx = evt.clientX - session.startX;
      const dy = evt.clientY - session.startY;
      if (!session.moved && Math.hypot(dx, dy) >= 6) {
        session.moved = true;
        this.markRecentCanvasDrag(1500);
      }
    }, { capture: true, passive: true });

    const finishCanvasPointerSession = (evt: PointerEvent) => {
      const session = this.canvasPointerSession;
      if (!session || session.pointerId !== evt.pointerId) return;
      if (session.moved) {
        this.markRecentCanvasDrag(1200);
      }
      this.canvasPointerSession = null;
    };

    const finishCanvasMouseSession = () => {
      const session = this.canvasMouseSession;
      if (!session) return;
      if (session.moved) {
        this.markRecentCanvasDrag(1200);
      }
      this.canvasMouseSession = null;
    };

    this.registerDomEvent(document, 'pointerup', finishCanvasPointerSession, { capture: true, passive: true });
    this.registerDomEvent(document, 'pointercancel', finishCanvasPointerSession, { capture: true, passive: true });
    this.registerDomEvent(document, 'mouseup', finishCanvasMouseSession, { capture: true, passive: true });
    this.registerDomEvent(document, 'dragstart', (evt: DragEvent) => {
      if (this.isCanvasOrBasesInteractionTarget(evt.target)) {
        this.markRecentCanvasDrag(1800);
      }
    }, { capture: true });
    this.registerDomEvent(document, 'dragend', (evt: DragEvent) => {
      if (this.isCanvasOrBasesInteractionTarget(evt.target)) {
        this.markRecentCanvasDrag(1400);
      }
      this.canvasMouseSession = null;
      this.canvasPointerSession = null;
    }, { capture: true });

    // Manual context interception for markdown-like link/embed targets only.
    this.registerDomEvent(document, 'contextmenu', (evt: MouseEvent) => {
      void this.taskCheckboxHandler.handleContextMenu(evt);
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
      if (this.suppressCanvasActivationEvent(evt)) return;
      void this.taskCheckboxHandler.handleClick(evt);
    }, { capture: true });

    // Long-press on touch devices opens a checkbox state selector.
    this.registerDomEvent(document, 'touchstart', (evt: TouchEvent) => {
      this.taskCheckboxHandler.handleTouchStart(evt);
    }, { capture: true, passive: true });
    this.registerDomEvent(document, 'touchmove', () => {
      this.taskCheckboxHandler.handleTouchMove();
    }, { capture: true, passive: true });
    this.registerDomEvent(document, 'touchend', () => {
      this.taskCheckboxHandler.handleTouchEnd();
    }, { capture: true, passive: true });
    this.registerDomEvent(document, 'touchcancel', () => {
      this.taskCheckboxHandler.handleTouchCancel();
    }, { capture: true, passive: true });

    registerGcmCommands(this);
  }

  onunload(): void {
    this.workspaceRibbonService?.teardown();
    delete (this as any).api;
    if (this.restoreCanvasOpenGuard) {
      this.restoreCanvasOpenGuard();
      this.restoreCanvasOpenGuard = null;
    }
    if (this.restoreMenuPatch) {
      this.restoreMenuPatch();
      this.restoreMenuPatch = null;
    }
    this.menuController?.detach();
    this.removeStyles();
    this.persistentMenuManager?.detach();
    this.recurrenceService?.cleanup();
    this.taskCheckboxHandler?.dispose();
    this.stopArchiveTagAutomation();
    document.body?.classList?.remove('tps-context-hidden-for-keyboard');
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<TPSGlobalContextMenuSettings> & {
      enableShiftClickCancel?: boolean;
      archiveFolder?: string;
    } | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded ?? {});
    if (!this.settings.workspaceRibbonIcons || typeof this.settings.workspaceRibbonIcons !== 'object') {
      this.settings.workspaceRibbonIcons = {};
    }
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
    if (
      this.settings.checklistPromotionBehavior !== 'remove' &&
      this.settings.checklistPromotionBehavior !== 'complete-and-link' &&
      this.settings.checklistPromotionBehavior !== 'link-only'
    ) {
      this.settings.checklistPromotionBehavior = DEFAULT_SETTINGS.checklistPromotionBehavior;
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
    this.startArchiveTagAutomation();
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

  isInMobileStartupGracePeriod(): boolean {
    return Platform.isMobile && Date.now() - this.startupTimestamp < 45_000;
  }

  private markRecentCanvasDrag(durationMs: number): void {
    const until = Date.now() + durationMs;
    if (until > this.recentCanvasDragUntil) {
      this.recentCanvasDragUntil = until;
    }
  }

  private shouldSuppressOpenForRecentCanvasDrag(): boolean {
    return Date.now() < this.recentCanvasDragUntil;
  }

  private installCanvasOpenGuard(): () => void {
    const workspace = this.app.workspace as any;
    const originalOpenLinkText = workspace.openLinkText?.bind(workspace);
    const originalGetLeaf = workspace.getLeaf?.bind(workspace);
    const originalGetUnpinnedLeaf = workspace.getUnpinnedLeaf?.bind(workspace);
    const originalGetRightLeaf = workspace.getRightLeaf?.bind(workspace);
    const originalGetLeftLeaf = workspace.getLeftLeaf?.bind(workspace);
    const originalCreateLeafBySplit = workspace.createLeafBySplit?.bind(workspace);
    const originalCreateLeafInParent = workspace.createLeafInParent?.bind(workspace);
    const originalSplitActiveLeaf = workspace.splitActiveLeaf?.bind(workspace);
    const originalDuplicateLeaf = workspace.duplicateLeaf?.bind(workspace);
    const originalOpenPopoutLeaf = workspace.openPopoutLeaf?.bind(workspace);
    const originalSetActiveLeaf = workspace.setActiveLeaf?.bind(workspace);
    const originalRevealLeaf = workspace.revealLeaf?.bind(workspace);
    const originalLeafOpenFile = WorkspaceLeaf.prototype.openFile;
    const originalLeafOpen = WorkspaceLeaf.prototype.open;
    const originalLeafSetViewState = WorkspaceLeaf.prototype.setViewState;
    const plugin = this;

    const logSuppressedOpen = (
      source:
        | 'openLinkText'
        | 'leaf.openFile'
        | 'leaf.open'
        | 'leaf.setViewState'
        | 'workspace.getLeaf'
        | 'workspace.getUnpinnedLeaf'
        | 'workspace.getRightLeaf'
        | 'workspace.getLeftLeaf'
        | 'workspace.createLeafBySplit'
        | 'workspace.createLeafInParent'
        | 'workspace.splitActiveLeaf'
        | 'workspace.duplicateLeaf'
        | 'workspace.openPopoutLeaf'
        | 'workspace.setActiveLeaf'
        | 'workspace.revealLeaf',
      target?: string,
    ) => {
      logger.log('[TPS GCM] Suppressed file open during recent canvas drag', {
        source,
        target,
      });
    };

    const fallbackLeaf = (): WorkspaceLeaf | null => {
      try {
        const leaf = (typeof originalGetUnpinnedLeaf === 'function' ? originalGetUnpinnedLeaf() : undefined)
          ?? (typeof workspace.getLeaf === 'function' ? workspace.getLeaf('tab') : undefined)
          ?? workspace.activeLeaf;
        return leaf ?? null;
      } catch {
        return workspace.activeLeaf ?? (workspace.getLeaf ? workspace.getLeaf('tab') : null) ?? null;
      }
    };

    const leafLooksEmpty = (leaf: WorkspaceLeaf): boolean => {
      try {
        const viewState = typeof leaf.getViewState === 'function' ? leaf.getViewState() as any : null;
        const state = viewState?.state;
        const path = typeof state?.file === 'string'
          ? state.file
          : typeof state?.path === 'string'
            ? state.path
            : typeof (leaf as any)?.view?.file?.path === 'string'
              ? (leaf as any).view.file.path
              : '';
        return !path;
      } catch {
        return !((leaf as any)?.view?.file?.path);
      }
    };

    const cleanupSuppressedLeaf = (leaf: WorkspaceLeaf): void => {
      if (!leaf || leaf === workspace.activeLeaf) return;
      if (!leafLooksEmpty(leaf)) return;
      window.setTimeout(() => {
        try {
          if (leaf !== workspace.activeLeaf && leafLooksEmpty(leaf)) {
            leaf.detach();
            logger.log('[TPS GCM] Detached suppressed blank leaf after recent canvas drag');
          }
        } catch (error) {
          logger.warn('[TPS GCM] Failed to detach suppressed leaf', error);
        }
      }, 0);
    };

    if (typeof originalGetLeaf === 'function') {
      workspace.getLeaf = function (...args: any[]) {
        const target = args[0];
        if (
          plugin.shouldSuppressOpenForRecentCanvasDrag()
          && (target === true || target === 'tab' || target === 'split' || target === 'window')
        ) {
          logSuppressedOpen('workspace.getLeaf', String(target));
          return fallbackLeaf();
        }
        return originalGetLeaf(...args);
      };
    }

    if (typeof originalGetUnpinnedLeaf === 'function') {
      workspace.getUnpinnedLeaf = function (...args: any[]) {
        if (plugin.shouldSuppressOpenForRecentCanvasDrag()) {
          logSuppressedOpen('workspace.getUnpinnedLeaf', 'tab');
          try {
            const fb = fallbackLeaf();
            if (fb) return fb;
          } catch (_e) {
            // ignore and return safe active leaf below
          }
          return workspace.activeLeaf ?? (typeof originalGetLeaf === 'function' ? originalGetLeaf('tab') : null);
        }
        return originalGetUnpinnedLeaf(...args);
      };
    }

    if (typeof originalGetRightLeaf === 'function') {
      workspace.getRightLeaf = function (...args: any[]) {
        if (plugin.shouldSuppressOpenForRecentCanvasDrag() && args[0] === true) {
          logSuppressedOpen('workspace.getRightLeaf', 'split');
          return fallbackLeaf();
        }
        return originalGetRightLeaf(...args);
      };
    }

    if (typeof originalGetLeftLeaf === 'function') {
      workspace.getLeftLeaf = function (...args: any[]) {
        if (plugin.shouldSuppressOpenForRecentCanvasDrag() && args[0] === true) {
          logSuppressedOpen('workspace.getLeftLeaf', 'split');
          return fallbackLeaf();
        }
        return originalGetLeftLeaf(...args);
      };
    }

    if (typeof originalCreateLeafBySplit === 'function') {
      workspace.createLeafBySplit = function (...args: any[]) {
        if (plugin.shouldSuppressOpenForRecentCanvasDrag()) {
          logSuppressedOpen('workspace.createLeafBySplit', String(args[1] ?? 'split'));
          return fallbackLeaf();
        }
        return originalCreateLeafBySplit(...args);
      };
    }

    if (typeof originalCreateLeafInParent === 'function') {
      workspace.createLeafInParent = function (...args: any[]) {
        if (plugin.shouldSuppressOpenForRecentCanvasDrag()) {
          logSuppressedOpen('workspace.createLeafInParent', 'parent');
          return fallbackLeaf();
        }
        return originalCreateLeafInParent(...args);
      };
    }

    if (typeof originalSplitActiveLeaf === 'function') {
      workspace.splitActiveLeaf = function (...args: any[]) {
        if (plugin.shouldSuppressOpenForRecentCanvasDrag()) {
          logSuppressedOpen('workspace.splitActiveLeaf', String(args[0] ?? 'split'));
          return fallbackLeaf();
        }
        return originalSplitActiveLeaf(...args);
      };
    }

    if (typeof originalDuplicateLeaf === 'function') {
      workspace.duplicateLeaf = function (...args: any[]) {
        if (plugin.shouldSuppressOpenForRecentCanvasDrag()) {
          logSuppressedOpen('workspace.duplicateLeaf', String(args[1] ?? 'duplicate'));
          return Promise.resolve(fallbackLeaf());
        }
        return originalDuplicateLeaf(...args);
      };
    }

    if (typeof originalOpenPopoutLeaf === 'function') {
      workspace.openPopoutLeaf = function (...args: any[]) {
        if (plugin.shouldSuppressOpenForRecentCanvasDrag()) {
          logSuppressedOpen('workspace.openPopoutLeaf', 'window');
          return fallbackLeaf();
        }
        return originalOpenPopoutLeaf(...args);
      };
    }

    WorkspaceLeaf.prototype.openFile = function (...args: any[]) {
      const target = args[0] instanceof TFile ? args[0].path : undefined;
      if (plugin.shouldSuppressOpenForRecentCanvasDrag()) {
        logSuppressedOpen('leaf.openFile', target);
        cleanupSuppressedLeaf(this);
        return Promise.resolve(undefined as any);
      }
      return originalLeafOpenFile.apply(this, args as any);
    } as typeof WorkspaceLeaf.prototype.openFile;

    WorkspaceLeaf.prototype.open = function (...args: any[]) {
      if (plugin.shouldSuppressOpenForRecentCanvasDrag()) {
        logSuppressedOpen('leaf.open', (args[0] as any)?.getViewType?.() ?? 'view');
        cleanupSuppressedLeaf(this);
        return Promise.resolve(this.view);
      }
      return originalLeafOpen.apply(this, args as any);
    } as typeof WorkspaceLeaf.prototype.open;

    WorkspaceLeaf.prototype.setViewState = function (...args: any[]) {
      const viewState = args[0] as any;
      const target = typeof viewState?.state?.file === 'string'
        ? viewState.state.file
        : typeof viewState?.state?.path === 'string'
          ? viewState.state.path
          : typeof viewState?.type === 'string'
            ? viewState.type
            : undefined;
      if (plugin.shouldSuppressOpenForRecentCanvasDrag()) {
        logSuppressedOpen('leaf.setViewState', target);
        cleanupSuppressedLeaf(this);
        return Promise.resolve(undefined as any);
      }
      return originalLeafSetViewState.apply(this, args as any);
    } as typeof WorkspaceLeaf.prototype.setViewState;

    if (typeof originalOpenLinkText === 'function') {
      workspace.openLinkText = function (...args: any[]) {
        const target = typeof args[0] === 'string' ? args[0] : undefined;
        if (plugin.shouldSuppressOpenForRecentCanvasDrag()) {
          logSuppressedOpen('openLinkText', target);
          return Promise.resolve(undefined);
        }
        return originalOpenLinkText(...args);
      };
    }

    if (typeof originalSetActiveLeaf === 'function') {
      workspace.setActiveLeaf = function (...args: any[]) {
        const targetLeaf = args[0] as WorkspaceLeaf | null | undefined;
        if (
          plugin.shouldSuppressOpenForRecentCanvasDrag()
          && targetLeaf
          && targetLeaf !== workspace.activeLeaf
        ) {
          logSuppressedOpen(
            'workspace.setActiveLeaf',
            (targetLeaf as any)?.view?.getViewType?.() ?? 'unknown',
          );
          return undefined;
        }
        return originalSetActiveLeaf(...args);
      };
    }

    if (typeof originalRevealLeaf === 'function') {
      workspace.revealLeaf = function (...args: any[]) {
        const targetLeaf = args[0] as WorkspaceLeaf | null | undefined;
        if (
          plugin.shouldSuppressOpenForRecentCanvasDrag()
          && targetLeaf
          && targetLeaf !== workspace.activeLeaf
        ) {
          logSuppressedOpen(
            'workspace.revealLeaf',
            (targetLeaf as any)?.view?.getViewType?.() ?? 'unknown',
          );
          return Promise.resolve(undefined);
        }
        return originalRevealLeaf(...args);
      };
    }

    return () => {
      WorkspaceLeaf.prototype.openFile = originalLeafOpenFile;
      WorkspaceLeaf.prototype.open = originalLeafOpen;
      WorkspaceLeaf.prototype.setViewState = originalLeafSetViewState;
      if (typeof originalGetLeaf === 'function') {
        workspace.getLeaf = originalGetLeaf;
      }
      if (typeof originalGetUnpinnedLeaf === 'function') {
        workspace.getUnpinnedLeaf = originalGetUnpinnedLeaf;
      }
      if (typeof originalGetRightLeaf === 'function') {
        workspace.getRightLeaf = originalGetRightLeaf;
      }
      if (typeof originalGetLeftLeaf === 'function') {
        workspace.getLeftLeaf = originalGetLeftLeaf;
      }
      if (typeof originalCreateLeafBySplit === 'function') {
        workspace.createLeafBySplit = originalCreateLeafBySplit;
      }
      if (typeof originalCreateLeafInParent === 'function') {
        workspace.createLeafInParent = originalCreateLeafInParent;
      }
      if (typeof originalSplitActiveLeaf === 'function') {
        workspace.splitActiveLeaf = originalSplitActiveLeaf;
      }
      if (typeof originalDuplicateLeaf === 'function') {
        workspace.duplicateLeaf = originalDuplicateLeaf;
      }
      if (typeof originalOpenPopoutLeaf === 'function') {
        workspace.openPopoutLeaf = originalOpenPopoutLeaf;
      }
      if (typeof originalOpenLinkText === 'function') {
        workspace.openLinkText = originalOpenLinkText;
      }
      if (typeof originalSetActiveLeaf === 'function') {
        workspace.setActiveLeaf = originalSetActiveLeaf;
      }
      if (typeof originalRevealLeaf === 'function') {
        workspace.revealLeaf = originalRevealLeaf;
      }
    };
  }

  private stopArchiveTagAutomation(): void {
    if (this.archiveSweepTimerId !== null) {
      window.clearTimeout(this.archiveSweepTimerId);
      this.archiveSweepTimerId = null;
    }
  }

  private startArchiveTagAutomation(): void {
    this.stopArchiveTagAutomation();
    if (!this.settings.enableArchiveTagMove) {
      return;
    }
    void this.runArchiveTagSweepIfDue('startup-catchup');
    this.scheduleNextArchiveTagSweep();
  }

  private getArchiveSweepTodayKey(): string {
    return window.moment().format('YYYY-MM-DD');
  }

  private isPastArchiveSweepTime(): boolean {
    const now = window.moment();
    const sweepTime = now.clone().startOf('day').hour(0).minute(5).second(0).millisecond(0);
    return !now.isBefore(sweepTime);
  }

  private scheduleNextArchiveTagSweep(): void {
    if (!this.settings.enableArchiveTagMove) {
      return;
    }
    const now = window.moment();
    const nextSweep = now.clone().startOf('day').hour(0).minute(5).second(0).millisecond(0);
    if (!nextSweep.isAfter(now)) {
      nextSweep.add(1, 'day');
    }
    const delayMs = Math.max(1000, nextSweep.diff(now));
    this.archiveSweepTimerId = window.setTimeout(() => {
      this.archiveSweepTimerId = null;
      void this.runArchiveTagSweepIfDue('scheduled').finally(() => {
        this.scheduleNextArchiveTagSweep();
      });
    }, delayMs);
  }

  private async runArchiveTagSweepIfDue(reason: 'startup-catchup' | 'scheduled'): Promise<void> {
    if (!this.settings.enableArchiveTagMove) {
      return;
    }
    const todayKey = this.getArchiveSweepTodayKey();
    if (this.settings.lastArchiveTagSweepDate === todayKey) {
      return;
    }
    if (!this.isPastArchiveSweepTime()) {
      return;
    }

    const result = await this.noteOperationService.sweepArchiveTaggedFiles(reason);
    this.settings.lastArchiveTagSweepDate = todayKey;
    await this.saveData(this.settings);
    logger.log(`[TPS GCM] Archive tag sweep complete (${reason})`, result);
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
    options?: { revealLeaf?: boolean; active?: boolean; ignoreCanvasDragGuard?: boolean },
  ): Promise<boolean> {
    if (!options?.ignoreCanvasDragGuard && this.shouldSuppressOpenForRecentCanvasDrag()) {
      logger.log('[TPS GCM] Suppressed openFileInLeaf before context creation', {
        file: file.path,
        context,
      });
      return false;
    }

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

}
