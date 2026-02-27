import { Plugin, TFile, WorkspaceLeaf, Menu, Platform, debounce, Notice, MarkdownView, normalizePath } from 'obsidian';
import { TPSGlobalContextMenuSettings, BuildPanelOptions } from './types';
import { DEFAULT_SETTINGS, PLUGIN_STYLES } from './constants';
import { MenuController } from './menu-controller';
import { PersistentMenuManager } from './persistent-menu-manager';
import { TPSGlobalContextMenuSettingTab } from './settings-tab';
import { BulkEditService } from './bulk-edit-service';
import { RecurrenceService } from './recurrence-service';
import { FileNamingService } from './file-naming-service';
import { ViewModeManager } from './view-mode-manager';
import { ContextTargetService } from './context-target-service';
import { NoteOperationService } from './note-operation-service';
import { FieldInitializationService } from './field-initialization-service';
import { installConsoleErrorFilter, installDateContainsPolyfill } from './compat';
import * as logger from "./logger";
import { CommandQueueService, getErrorMessage } from "./core";


export default class TPSGlobalContextMenuPlugin extends Plugin {
  settings: TPSGlobalContextMenuSettings;
  menuController: MenuController;
  persistentMenuManager: PersistentMenuManager;
  bulkEditService: BulkEditService;
  recurrenceService: RecurrenceService;
  fileNamingService: FileNamingService;
  viewModeManager: ViewModeManager;
  contextTargetService: ContextTargetService;
  noteOperationService: NoteOperationService;
  fieldInitializationService: FieldInitializationService;
  commandQueueService: CommandQueueService;
  styleEl: HTMLStyleElement | null = null;
  ignoreNextContext = false;
  keyboardVisible = false;
  private restoreConsoleError: (() => void) | null = null;
  private restoreMenuPatch: (() => void) | null = null;
  private viewModeSuppressedPaths: Set<string> = new Set();
  private recentTaskCycleClicks: Map<string, number> = new Map();
  private bypassNextTaskCycleClick = false;
  private pendingChecklistReorderTimers: Map<string, number> = new Map();

  // Create a debounced save function
  private debouncedSave = debounce(async () => {
    await this.saveData(this.settings);
  }, 1000, false);

  async onload(): Promise<void> {
    this.ignoreNextContext = false;

    await this.loadSettings();
    logger.setLoggingEnabled(this.settings.enableLogging);

    installDateContainsPolyfill();
    this.restoreConsoleError = installConsoleErrorFilter();

    this.contextTargetService = new ContextTargetService(this);
    this.bulkEditService = new BulkEditService(this);
    this.recurrenceService = new RecurrenceService(this);
    this.fileNamingService = new FileNamingService(this);
    this.noteOperationService = new NoteOperationService(this);
    this.fieldInitializationService = new FieldInitializationService(this);
    this.commandQueueService = new CommandQueueService();

    this.menuController = new MenuController(this);
    this.persistentMenuManager = new PersistentMenuManager(this);
    this.viewModeManager = new ViewModeManager(this);
    this.addChild(this.viewModeManager);

    // Initialize recurrence listener
    this.recurrenceService.setup();

    this.patchMenuMethods();

    this.injectStyles();

    this.keyboardVisible = false;

    // Register events
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (this.settings.inlineMenuOnly) return;
        if (file instanceof TFile) {
          this.menuController.addToNativeMenu(menu, [file]);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on('files-menu', (menu, files) => {
        if (this.settings.inlineMenuOnly) return;
        // Relaxed check to handle potential non-instance objects from other plugins
        const fileList = files.filter((f: any) => f && f.path && typeof f.path === 'string') as TFile[];
        if (fileList.length > 0) {
          this.menuController.addToNativeMenu(menu, fileList);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, info) => {
        if (this.settings.inlineMenuOnly) return;
        if (info && info.file instanceof TFile) {
          this.menuController.addToNativeMenu(menu, [info.file]);
        }
      })
    );

    this.addSettingTab(new TPSGlobalContextMenuSettingTab(this.app, this));

    const ensureMenus = this.persistentMenuManager.ensureMenus.bind(
      this.persistentMenuManager
    );

    // Debounced version for high-frequency events (mobile typing, bulk vault ops)
    // Using false (not immediate) to prevent jitter during typing
    const throttledEnsureMenus = debounce(ensureMenus, 500, false);

    this.registerEvent(this.app.workspace.on('layout-change', throttledEnsureMenus));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      throttledEnsureMenus();
      const activePath = this.app.workspace.getActiveFile()?.path || null;
      for (const path of Array.from(this.viewModeSuppressedPaths)) {
        if (path !== activePath) {
          this.viewModeSuppressedPaths.delete(path);
        }
      }
    }));
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      // Immediate menu creation attempt
      ensureMenus();

      // On mobile, metadata cache may not have updated yet on rapid file switching.
      // Schedule a delayed refresh to ensure frontmatter values are current.
      if (file && Platform.isMobile) {
        setTimeout(() => {
          this.persistentMenuManager.refreshMenusForFile(file);
        }, 500); // Increased delay
      }

      if (file && this.fileNamingService.shouldProcess(file)) {
        // Longer delay to ensure frontmatter is fully indexed after creation/modification
        setTimeout(() => {
          this.fileNamingService.processFileOnOpen(file);
        }, 500);
      }
    }));
    // Don't listen to vault modify - this fires too often during typing
    // The metadataCache.on('changed') handler already handles this with better debouncing

    // Refresh inline menus when frontmatter changes (fixes stale menus)
    // Heavily debounced to prevent lag during typing
    // IMPORTANT: Third param (immediate) is false - we fire at END of delay, not start
    const debouncedMenuRefresh = debounce((file: TFile) => {
      if (file && file.extension === 'md') {
        this.persistentMenuManager.refreshMenusForFile(file);
      }
    }, 2000, false); // 2 second debounce, fires at END to avoid refresh during typing

    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        debouncedMenuRefresh(file);
      })
    );

    // Refresh menus on rename to keep title in sync
    this.registerEvent(
      // Note: Obsidian provides (file, oldPath); keep args flexible across versions.
      this.app.vault.on('rename', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.persistentMenuManager.refreshMenusForFile(file);

          // Ensure core renames propagate into frontmatter title (and apply normalization rules).
          // Run slightly delayed to allow metadata cache to settle after the rename.
          setTimeout(() => {
            this.fileNamingService.syncTitleFromFilename(file);
          }, 150);
        }
      })
    );

    this.register(() => this.persistentMenuManager.detach());
    this.register(() => this.menuController.detach());


    this.registerEvent(
      this.app.vault.on('delete', () => {
        logger.log('[TPS GCM] vault delete detected; blurring and closing menu');
        try {
          if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
          }
        } catch (err) {
          logger.warn('TPS GCM: blur after delete failed', err);
        }
        try {
          this.menuController?.hideMenu?.();
        } catch (err) {
          logger.warn('TPS GCM: hideMenu after delete failed', err);
        }
        try {
          this.app.workspace.trigger('tps-gcm-delete-complete');
        } catch (err) {
          logger.warn('TPS GCM: trigger delete-complete failed', err);
        }
      })
    );

    // Initial menu setup
    ensureMenus();

    // Mobile keyboard handling delegated to PersistentMenuManager

    // Check for missing recurrences on startup
    this.app.workspace.onLayoutReady(async () => {
      // Give a short delay to allow other plugins/cache to settle
      setTimeout(async () => {
        logger.log('[TPS GCM] Checking for missing recurrences on startup...');
        await this.bulkEditService.checkMissingRecurrences();
      }, 2000);
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
      void this.handleTaskCheckboxCycleClick(evt);
    }, { capture: true });

    // Sidebar Open Commands
    this.addCommand({
      id: 'open-in-right-sidebar',
      name: 'Open active file in Right Sidebar',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          if (!checking) {
            void this.openFileInLeaf(file, 'split', () => this.app.workspace.getRightLeaf(true), { revealLeaf: true });
          }
          return true;
        }
        return false;
      }
    });

    this.addCommand({
      id: 'open-in-left-sidebar',
      name: 'Open active file in Left Sidebar',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          if (!checking) {
            void this.openFileInLeaf(file, 'split', () => this.app.workspace.getLeftLeaf(true), { revealLeaf: true });
          }
          return true;
        }
        return false;
      }
    });

    this.addCommand({
      id: 'repair-template-derived-titles',
      name: 'Repair template-derived titles from filenames',
      callback: async () => {
        new Notice('TPS GCM: Repairing template-derived titles...');
        try {
          const result = await this.fileNamingService.repairTemplateDerivedTitlesAcrossVault();
          new Notice(
            `TPS GCM: Title repair complete. Updated ${result.updated} of ${result.scanned} scanned notes${result.failed > 0 ? ` (${result.failed} failed)` : ''}.`,
          );
        } catch (error) {
          logger.error('[TPS GCM] Failed to repair template-derived titles', error);
          new Notice('TPS GCM: Title repair failed. Check console logs.');
        }
      },
    });

    this.addCommand({
      id: 'toggle-inline-ui',
      name: 'Toggle inline context menu UI',
      callback: async () => {
        this.settings.enableInlinePersistentMenus = !this.settings.enableInlinePersistentMenus;
        await this.saveSettings();
        new Notice(
          this.settings.enableInlinePersistentMenus
            ? 'TPS GCM inline UI enabled'
            : 'TPS GCM inline UI hidden',
        );
      },
    });
  }

  patchMenuMethods() {
    // Monkey patch Menu to enforce ordering right before display
    const originalShowAtPosition = Menu.prototype.showAtPosition;
    const originalShowAtMouseEvent = Menu.prototype.showAtMouseEvent;
    const plugin = this;

    const maybeInjectNotebookNavigatorItems = (menu: Menu, eventTarget?: EventTarget | null) => {
      if (plugin.settings.inlineMenuOnly) return;
      if ((menu as any)._tpsHandled) return;

      const targetEl =
        eventTarget instanceof HTMLElement
          ? eventTarget
          : plugin.contextTargetService.consumeRecentContextTarget(1200);

      if (!plugin.contextTargetService.isNotebookNavigatorContextTarget(targetEl)) return;
      if (!plugin.contextTargetService.isNotebookNavigatorFileContextTarget(targetEl)) return;

      const syntheticMouseEvent = { target: targetEl } as unknown as MouseEvent;
      const targets = plugin.contextTargetService.resolveTargets([], syntheticMouseEvent, { allowActiveFileFallback: false });
      if (targets.length === 0) return;

      plugin.menuController.addToNativeMenu(menu, targets);
    };

    const reorderItems = (menu: Menu) => {
      if (!(menu as any)._tpsHandled) return;
      const items = (menu as any).items as any[] | undefined;
      if (!Array.isArray(items) || items.length === 0) return;

      const normalizeTitle = (value: string): string =>
        value
          .toLowerCase()
          .replace(/[.…]+/g, "...")
          .replace(/\s+/g, " ")
          .trim();

      const getItemTitle = (item: any): string => {
        const direct = typeof item?.title === "string" ? item.title : "";
        if (direct) return direct;

        const fromDom = typeof item?.dom?.textContent === "string" ? item.dom.textContent : "";
        if (fromDom) return fromDom;

        const fromTitleEl = typeof item?.titleEl?.textContent === "string" ? item.titleEl.textContent : "";
        if (fromTitleEl) return fromTitleEl;

        return "";
      };

      const toSemanticKey = (title: string): string | null => {
        if (!title) return null;

        // Normalize count suffixes so "Delete (23 items)" and "Delete 23 notes" map together.
        let normalized = normalizeTitle(title)
          .replace(/\(\s*\d+\s+(items?|notes?|files?)\s*\)/g, "")
          .replace(/\b\d+\s+(items?|notes?|files?)\b/g, "")
          .replace(/\s+/g, " ")
          .trim();

        if (!normalized) return null;

        if (/^delete\b/.test(normalized)) return "action:delete";
        if (/^duplicate\b/.test(normalized)) return "action:duplicate";
        if (/^move\b.*\bto\b/.test(normalized)) return "action:move";
        if (/^open\b.*\bnew tabs?\b/.test(normalized) || /^open in new tab\b/.test(normalized)) return "action:open-new-tab";
        if (/^open\b.*\bto the right\b/.test(normalized)) return "action:open-right";
        if (/^open\b.*\bnew windows?\b/.test(normalized) || /^open in new window\b/.test(normalized)) return "action:open-new-window";
        if (/^open\b.*\bsame tab\b/.test(normalized) || /^open in same tab\b/.test(normalized)) return "action:open-same-tab";

        return null;
      };

      const getDedupeKeys = (item: any): string[] => {
        const title = getItemTitle(item);
        if (!title) return [];
        const normalized = normalizeTitle(title);
        const keys = [`title:${normalized}`];
        const semantic = toSemanticKey(title);
        if (semantic) keys.push(semantic);
        return keys;
      };

      const tpsItems: any[] = [];
      const otherItems: any[] = [];
      for (const item of items) {
        if ((item as any)._isTpsItem) {
          tpsItems.push(item);
        } else {
          otherItems.push(item);
        }
      }

      if (tpsItems.length === 0) return;

      const preferredKeys = new Set<string>();
      for (const item of tpsItems) {
        for (const key of getDedupeKeys(item)) {
          preferredKeys.add(key);
        }
      }

      const filteredOthers = otherItems.filter((item) => {
        const keys = getDedupeKeys(item);
        if (keys.length === 0) return true;
        const collides = keys.some((key) => preferredKeys.has(key));
        return !collides;
      });

      (menu as any).items = [...tpsItems, ...filteredOthers];
    };

    // We modify the prototype's method to intercept the call
    Menu.prototype.showAtPosition = function (pos) {
      maybeInjectNotebookNavigatorItems(this);
      reorderItems(this);
      try {
        return originalShowAtPosition.call(this, pos);
      } finally {
        plugin.contextTargetService.clearRecentContextTarget();
      }
    };

    Menu.prototype.showAtMouseEvent = function (evt) {
      maybeInjectNotebookNavigatorItems(this, evt?.target ?? null);
      reorderItems(this);
      try {
        return originalShowAtMouseEvent.call(this, evt);
      } finally {
        plugin.contextTargetService.clearRecentContextTarget();
      }
    };

    this.restoreMenuPatch = () => {
      Menu.prototype.showAtPosition = originalShowAtPosition;
      Menu.prototype.showAtMouseEvent = originalShowAtMouseEvent;
    };
  }

  onunload(): void {
    if (this.restoreMenuPatch) {
      this.restoreMenuPatch();
      this.restoreMenuPatch = null;
    }
    this.restoreConsoleError?.();
    this.restoreConsoleError = null;
    this.menuController?.detach();
    this.removeStyles();
    this.persistentMenuManager?.detach();
    this.recurrenceService?.cleanup();
    for (const timerId of this.pendingChecklistReorderTimers.values()) {
      window.clearTimeout(timerId);
    }
    this.pendingChecklistReorderTimers.clear();
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
    const plugin = (this.app as any)?.plugins?.getPlugin?.('tps-controller');
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
    if (!(file instanceof TFile)) return false;
    const patterns = this.getAutoFrontmatterWriteExclusionPatterns();
    if (!patterns.length) return false;
    const normalizedPath = this.normalizeComparablePath(file.path);
    const normalizedBasename = this.normalizeComparablePath(file.basename);
    return patterns.some((pattern) =>
      this.matchesAutoFrontmatterExclusionPattern(normalizedPath, normalizedBasename, pattern),
    );
  }

  matchesAutoFrontmatterExclusionPattern(
    normalizedPath: string,
    normalizedBasename: string,
    rawPattern: string,
  ): boolean {
    const pattern = String(rawPattern || '').trim();
    if (!pattern) return false;
    const asLower = pattern.toLowerCase();

    if (asLower.startsWith('re:')) {
      const source = pattern.slice(3).trim();
      if (!source) return false;
      try {
        const regex = new RegExp(source, 'i');
        return regex.test(normalizedPath) || regex.test(normalizedBasename);
      } catch {
        return false;
      }
    }

    if (asLower.startsWith('name:')) {
      const target = this.normalizeComparablePath(pattern.slice(5));
      if (!target) return false;
      return this.matchesWildcard(target, normalizedBasename);
    }

    const pathTarget = asLower.startsWith('path:') ? pattern.slice(5).trim() : pattern;
    const hasTrailingSlash = /[\/\\]$/.test(pathTarget);
    const normalizedTarget = this.normalizeComparablePath(pathTarget);
    if (!normalizedTarget) return false;

    if (normalizedTarget.includes('*')) {
      return (
        this.matchesWildcard(normalizedTarget, normalizedPath) ||
        this.matchesWildcard(normalizedTarget, normalizedBasename)
      );
    }

    if (hasTrailingSlash) {
      return normalizedPath === normalizedTarget || normalizedPath.startsWith(`${normalizedTarget}/`);
    }

    return (
      normalizedPath === normalizedTarget ||
      normalizedPath.startsWith(`${normalizedTarget}/`) ||
      normalizedBasename === normalizedTarget
    );
  }

  private getAutoFrontmatterWriteExclusionPatterns(): string[] {
    const raw = String(this.settings.frontmatterAutoWriteExclusions || '');
    if (!raw.trim()) return [];
    return raw
      .split(/\r?\n|,/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private normalizeComparablePath(value: string): string {
    return String(value || '')
      .trim()
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  }

  private matchesWildcard(pattern: string, value: string): boolean {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i');
    return regex.test(value);
  }

  private async handleTaskCheckboxCycleClick(evt: MouseEvent): Promise<void> {
    if (!this.settings.enableTaskCheckboxCycle) return;
    if (this.bypassNextTaskCycleClick) return;
    if (evt.button !== 0) return;

    const targetEl = evt.target instanceof HTMLElement ? evt.target : null;
    if (!targetEl) return;

    const checkboxEl = this.resolveTaskCheckboxTarget(targetEl);
    if (!checkboxEl) return;

    const view = this.resolveMarkdownViewForElement(checkboxEl);
    const file = view?.file;
    if (!view || !file) return;

    const isReadingView = !!checkboxEl.closest('.markdown-reading-view, .markdown-preview-view');
    const lineNumber = this.findTaskLineNumber(checkboxEl, view, isReadingView);
    if (lineNumber < 0) return;

    if (this.isRecentTaskCycleClick(file.path, lineNumber)) return;
    this.setRecentTaskCycleClick(file.path, lineNumber);

    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();

    try {
      const shouldUseVaultWrite = isReadingView;
      const updated = await this.cycleTaskState(file, view, lineNumber, shouldUseVaultWrite, isReadingView);
      if (!updated) {
        this.recentTaskCycleClicks.delete(`${file.path}:${lineNumber}`);
        this.triggerNativeCheckboxClick(checkboxEl);
      }
    } catch (error) {
      this.recentTaskCycleClicks.delete(`${file.path}:${lineNumber}`);
      logger.warn('[TPS GCM] Checkbox cycle failed', { file: file.path, lineNumber, error });
      this.triggerNativeCheckboxClick(checkboxEl);
    }
  }

  private resolveTaskCheckboxTarget(targetEl: HTMLElement): HTMLElement | null {
    const candidate = targetEl.closest('input.task-list-item-checkbox, .task-list-item-checkbox, .cm-formatting-task');
    if (!(candidate instanceof HTMLElement)) return null;

    if (candidate instanceof HTMLInputElement) {
      if (candidate.type !== 'checkbox') return null;
      if (!candidate.classList.contains('task-list-item-checkbox')) return null;
      return candidate;
    }

    if (candidate.classList.contains('task-list-item-checkbox') || candidate.classList.contains('cm-formatting-task')) {
      return candidate;
    }

    return null;
  }

  private resolveMarkdownViewForElement(targetEl: HTMLElement): MarkdownView | null {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;

      const containerEl = (view as any).containerEl as HTMLElement | undefined;
      const contentEl = view.contentEl as HTMLElement | undefined;
      const previewContainer = (view as any).previewMode?.containerEl as HTMLElement | undefined;

      if (containerEl?.contains(targetEl) || contentEl?.contains(targetEl) || previewContainer?.contains(targetEl)) {
        return view;
      }
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView) return null;
    const activeContainer = (activeView as any).containerEl as HTMLElement | undefined;
    const activeContent = activeView.contentEl as HTMLElement | undefined;
    if (activeContainer?.contains(targetEl) || activeContent?.contains(targetEl)) {
      return activeView;
    }
    return null;
  }

  private findTaskLineNumber(targetEl: HTMLElement, view: MarkdownView, preferReadingViewMap = false): number {
    if (preferReadingViewMap) {
      const mappedLine = this.mapReadingCheckboxToTaskLine(targetEl, view);
      if (mappedLine >= 0) {
        return mappedLine;
      }
    }

    const dataLineEl = targetEl.closest('[data-line]') as HTMLElement | null;
    const rawDataLine = dataLineEl?.getAttribute('data-line') ?? '';
    const dataLine = Number.parseInt(rawDataLine, 10);
    if (Number.isFinite(dataLine)) {
      return dataLine;
    }

    const editorAny = view.editor as any;
    const cm = editorAny?.cm;
    if (!cm || typeof cm.posAtDOM !== 'function') return -1;

    const lineHost = targetEl.closest('.cm-line') as HTMLElement | null;
    const domTarget = lineHost ?? targetEl;

    try {
      let offset: number | null = null;
      try {
        offset = cm.posAtDOM(domTarget);
      } catch {
        offset = cm.posAtDOM(domTarget, 0);
      }
      if (typeof offset !== 'number' || !Number.isFinite(offset)) return -1;
      const line = cm.state?.doc?.lineAt?.(offset)?.number;
      if (typeof line !== 'number' || !Number.isFinite(line)) return -1;
      return Math.max(0, line - 1);
    } catch {
      return -1;
    }
  }

  private getViewSourceText(view: MarkdownView): string {
    const editor = view.editor as any;
    if (editor && typeof editor.getValue === 'function') {
      const value = editor.getValue();
      if (typeof value === 'string') {
        return value;
      }
    }

    const rawData = (view as any)?.data;
    if (typeof rawData === 'string') {
      return rawData;
    }

    return '';
  }

  private mapReadingCheckboxToTaskLine(targetEl: HTMLElement, view: MarkdownView): number {
    const readingRoot = targetEl.closest('.markdown-reading-view, .markdown-preview-view');
    if (!(readingRoot instanceof HTMLElement)) return -1;

    let inputEl: HTMLInputElement | null = null;
    if (targetEl instanceof HTMLInputElement && targetEl.type === 'checkbox') {
      inputEl = targetEl;
    } else {
      inputEl = targetEl.closest('.task-list-item')?.querySelector('input.task-list-item-checkbox') ?? null;
    }
    if (!inputEl) return -1;

    const checkboxes = Array.from(readingRoot.querySelectorAll('input.task-list-item-checkbox'));
    const checkboxIndex = checkboxes.indexOf(inputEl);
    if (checkboxIndex < 0) return -1;

    const source = this.getViewSourceText(view);
    if (!source) return -1;

    const lines = source.split('\n');
    const taskLineNumbers: number[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (this.applyNextTaskStateToLine(lines[i])) {
        taskLineNumbers.push(i);
      }
    }

    if (checkboxIndex >= taskLineNumbers.length) return -1;
    return taskLineNumbers[checkboxIndex];
  }

  private isRecentTaskCycleClick(filePath: string, lineNumber: number): boolean {
    const key = `${filePath}:${lineNumber}`;
    const now = Date.now();
    this.clearExpiredTaskCycleClickMarks(now);
    const previous = this.recentTaskCycleClicks.get(key);
    return typeof previous === 'number' && (now - previous) < 200;
  }

  private setRecentTaskCycleClick(filePath: string, lineNumber: number): void {
    const key = `${filePath}:${lineNumber}`;
    this.recentTaskCycleClicks.set(key, Date.now());
  }

  private clearExpiredTaskCycleClickMarks(now: number): void {
    if (this.recentTaskCycleClicks.size < 100) return;
    for (const [key, ts] of this.recentTaskCycleClicks.entries()) {
      if ((now - ts) > 5000) {
        this.recentTaskCycleClicks.delete(key);
      }
    }
  }

  private triggerNativeCheckboxClick(checkboxEl: HTMLElement): void {
    let inputEl: HTMLInputElement | null = null;
    if (checkboxEl instanceof HTMLInputElement && checkboxEl.type === 'checkbox') {
      inputEl = checkboxEl;
    } else {
      inputEl = checkboxEl.closest('.task-list-item')?.querySelector('input.task-list-item-checkbox') ?? null;
    }
    if (!inputEl) return;

    this.bypassNextTaskCycleClick = true;
    try {
      inputEl.click();
    } catch (error) {
      logger.warn('[TPS GCM] Native checkbox fallback click failed', error);
    } finally {
      window.setTimeout(() => {
        this.bypassNextTaskCycleClick = false;
      }, 0);
    }
  }

  private async cycleTaskState(
    file: TFile,
    view: MarkdownView,
    lineNumber: number,
    preferVaultWrite = false,
    strictLine = false,
  ): Promise<boolean> {
    const liveViewContent = !preferVaultWrite ? this.getViewSourceText(view) : '';
    const content = liveViewContent || await this.app.vault.read(file);
    const lines = content.split('\n');
    let candidateLine = -1;
    if (lineNumber >= 0 && lineNumber < lines.length && this.applyNextTaskStateToLine(lines[lineNumber])) {
      candidateLine = lineNumber;
    } else if (!strictLine) {
      candidateLine = this.resolveCandidateTaskLine(lines, lineNumber);
    }
    if (candidateLine < 0) return false;

    const next = this.applyNextTaskStateToLine(lines[candidateLine]);
    if (!next) return false;

    lines[candidateLine] = next.nextLine;
    const updatedContent = lines.join('\n');
    if (updatedContent === content) return false;

    await this.app.vault.modify(file, updatedContent);
    this.scheduleChecklistReorder(file);
    return true;
  }

  private resolveCandidateTaskLine(lines: string[], preferredLine: number): number {
    if (preferredLine >= 0 && preferredLine < lines.length) {
      if (this.applyNextTaskStateToLine(lines[preferredLine])) {
        return preferredLine;
      }
    }

    for (let offset = 1; offset <= 3; offset += 1) {
      const above = preferredLine - offset;
      if (above >= 0 && above < lines.length && this.applyNextTaskStateToLine(lines[above])) {
        return above;
      }

      const below = preferredLine + offset;
      if (below >= 0 && below < lines.length && this.applyNextTaskStateToLine(lines[below])) {
        return below;
      }
    }

    return -1;
  }

  private applyNextTaskStateToLine(line: string): { nextLine: string; nextState: ' ' | 'x' | '?' | '-' } | null {
    const match = line.match(/^(\s*(?:[-*+]|\d+\.)\s*)\[( |x|X|\?|-)\](.*)$/);
    if (!match) return null;

    const prefix = match[1];
    const currentState = match[2];
    const suffix = match[3];
    const nextState = this.getNextTaskState(currentState);
    if (!nextState) return null;

    return {
      nextLine: `${prefix}[${nextState}]${suffix}`,
      nextState,
    };
  }

  private getTaskLineState(line: string): ' ' | 'x' | 'X' | '?' | '-' | null {
    const match = line.match(/^\s*(?:[-*+]|\d+\.)\s*\[( |x|X|\?|-)\]/);
    return match ? (match[1] as ' ' | 'x' | 'X' | '?' | '-') : null;
  }

  private getTaskLineIndent(line: string): string | null {
    const match = line.match(/^(\s*)(?:[-*+]|\d+\.)\s*\[(?: |x|X|\?|-)\]/);
    return match ? match[1] : null;
  }

  private getTaskSortRank(state: ' ' | 'x' | 'X' | '?' | '-'): number {
    if (state === '?') return 0;
    if (state === ' ') return 1;
    if (state === '-') return 2;
    if (state === 'x' || state === 'X') return 3;
    return 4;
  }

  private reorderChecklistBlock(lines: string[], anchorLine: number): void {
    if (anchorLine < 0 || anchorLine >= lines.length) return;

    const anchorState = this.getTaskLineState(lines[anchorLine]);
    const anchorIndent = this.getTaskLineIndent(lines[anchorLine]);
    if (!anchorState || anchorIndent === null) return;

    let start = anchorLine;
    while (start - 1 >= 0) {
      const state = this.getTaskLineState(lines[start - 1]);
      const indent = this.getTaskLineIndent(lines[start - 1]);
      if (!state || indent !== anchorIndent) break;
      start -= 1;
    }

    let end = anchorLine;
    while (end + 1 < lines.length) {
      const state = this.getTaskLineState(lines[end + 1]);
      const indent = this.getTaskLineIndent(lines[end + 1]);
      if (!state || indent !== anchorIndent) break;
      end += 1;
    }

    if (end <= start) return;
    this.reorderChecklistRange(lines, start, end);
  }

  private reorderChecklistRange(lines: string[], start: number, end: number): boolean {
    if (start < 0 || end >= lines.length || end <= start) return false;

    const block = lines.slice(start, end + 1);
    const ranked = block.map((line, index) => {
      const state = this.getTaskLineState(line);
      const rank = state ? this.getTaskSortRank(state) : 999;
      return { line, index, rank };
    });

    ranked.sort((a, b) => (a.rank - b.rank) || (a.index - b.index));
    const sortedBlock = ranked.map((entry) => entry.line);

    let changed = false;
    for (let i = 0; i < block.length; i += 1) {
      if (block[i] !== sortedBlock[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;

    for (let i = 0; i < sortedBlock.length; i += 1) {
      lines[start + i] = sortedBlock[i];
    }
    return true;
  }

  private reorderAllChecklistBlocks(lines: string[]): boolean {
    let changed = false;
    for (let i = 0; i < lines.length; i += 1) {
      const state = this.getTaskLineState(lines[i]);
      const indent = this.getTaskLineIndent(lines[i]);
      if (!state || indent === null) continue;

      let end = i;
      while (end + 1 < lines.length) {
        const nextState = this.getTaskLineState(lines[end + 1]);
        const nextIndent = this.getTaskLineIndent(lines[end + 1]);
        if (!nextState || nextIndent !== indent) break;
        end += 1;
      }

      if (this.reorderChecklistRange(lines, i, end)) {
        changed = true;
      }
      i = end;
    }
    return changed;
  }

  private scheduleChecklistReorder(file: TFile): void {
    const key = file.path;
    const existingTimer = this.pendingChecklistReorderTimers.get(key);
    if (typeof existingTimer === 'number') {
      window.clearTimeout(existingTimer);
    }

    const timerId = window.setTimeout(() => {
      this.pendingChecklistReorderTimers.delete(key);
      void this.runDelayedChecklistReorder(key);
    }, 5000);
    this.pendingChecklistReorderTimers.set(key, timerId);
  }

  private async runDelayedChecklistReorder(filePath: string): Promise<void> {
    try {
      const af = this.app.vault.getAbstractFileByPath(filePath);
      if (!(af instanceof TFile) || af.extension !== 'md') return;

      const content = await this.app.vault.read(af);
      const lines = content.split('\n');
      const changed = this.reorderAllChecklistBlocks(lines);
      if (!changed) return;

      const updatedContent = lines.join('\n');
      if (updatedContent === content) return;
      await this.app.vault.modify(af, updatedContent);
    } catch (error) {
      logger.warn('[TPS GCM] Delayed checklist reorder failed', { filePath, error });
    }
  }

  private getNextTaskState(currentState: string): ' ' | 'x' | '?' | '-' | null {
    if (currentState === ' ') return 'x';
    if (currentState === 'x' || currentState === 'X') return '?';
    if (currentState === '?') return '-';
    if (currentState === '-') return ' ';
    return null;
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

}
