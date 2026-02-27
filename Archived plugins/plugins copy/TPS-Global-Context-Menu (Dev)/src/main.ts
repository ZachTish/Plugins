import { Plugin, TFile, TFolder, WorkspaceLeaf, Menu, Platform, debounce, normalizePath, MarkdownView } from 'obsidian';
import {
  TPSGlobalContextMenuSettings,
  AppearanceSettingKey,
  AppearanceSyncMode,
  BuildPanelOptions,
} from './types';
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
import { installDateContainsPolyfill } from './compat';
import * as logger from "./logger";
import { normalizeTagValue, parseTagInput } from './tag-utils';
import { DailyNoteNavManager } from './daily-note-nav-manager';

const APPEARANCE_SETTING_KEYS: AppearanceSettingKey[] = [
  'menuTextScale',
  'buttonScale',
  'controlScale',
  'menuDensity',
  'menuRadiusScale',
  'liveMenuPosition',
  'liveMenuOffsetX',
  'liveMenuOffsetY',
  'modalWidth',
  'modalMaxHeightVh',
  'subitemsMarginBottom',
  'dailyNavScale',
  'dailyNavRestOpacity',
];
const APPEARANCE_LOCAL_STORAGE_PREFIX = 'tps-gcm.appearance.local.';

export default class TPSGlobalContextMenuPlugin extends Plugin {
  settings: TPSGlobalContextMenuSettings;
  menuController: MenuController;
  private lastEditorChangeAt: number = 0;
  private readonly typingQuietWindowMs: number = 4000;
  persistentMenuManager: PersistentMenuManager;
  bulkEditService: BulkEditService;
  recurrenceService: RecurrenceService;
  fileNamingService: FileNamingService;
  viewModeManager: ViewModeManager;
  contextTargetService: ContextTargetService;
  noteOperationService: NoteOperationService;
  dailyNoteNavManager: DailyNoteNavManager; // Add property
  styleEl: HTMLStyleElement | null = null;
  ignoreNextContext = false;
  keyboardVisible = false;
  private restoreMenuPatch: (() => void) | null = null;
  private archiveTimerId: number | null = null;
  private modalObserver: MutationObserver | null = null;
  private lastEditorFocused: boolean = false;
  private ensureMenusFn: (() => void) | null = null;
  private skipViewModeSwitchUntil: number = 0;
  private manualViewModeOverridePath: string | null = null;
  private pendingEnsureMenus: boolean = false;
  private ensureMenusQueueTimer: number | null = null;
  private ensureMenusQueueAttempts: number = 0;
  private structuralMenuRefreshTimer: number | null = null;
  private namingSyncTimers: Map<string, number> = new Map();
  private namingSignatureByPath: Map<string, string> = new Map();
  private pendingTitleSyncTimers: Map<string, number[]> = new Map();
  private syncedAppearanceValues: Partial<Record<AppearanceSettingKey, TPSGlobalContextMenuSettings[AppearanceSettingKey]>> = {};

  isEditorFocused(): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor as any;
    if (!editor) return false;
    try {
      return typeof editor.hasFocus === "function" ? editor.hasFocus() : false;
    } catch {
      return false;
    }
  }

  private isTypingGuardActive(): boolean {
    return this.isEditorFocused();
  }

  private isActivelyTyping(): boolean {
    if (!this.isEditorFocused()) return false;
    if (!this.lastEditorChangeAt) return false;
    return Date.now() - this.lastEditorChangeAt < 350;
  }

  private queueEnsureMenusFlush(): void {
    if (this.ensureMenusQueueTimer !== null) return;

    const tick = () => {
      this.ensureMenusQueueTimer = null;
      if (!this.pendingEnsureMenus) {
        this.ensureMenusQueueAttempts = 0;
        return;
      }

      const ensureMenus = this.ensureMenusFn;
      if (!ensureMenus) {
        this.pendingEnsureMenus = false;
        this.ensureMenusQueueAttempts = 0;
        return;
      }

      if (this.isActivelyTyping()) {
        this.ensureMenusQueueAttempts += 1;
        const nextDelay = this.ensureMenusQueueAttempts > 30 ? 500 : 120;
        this.ensureMenusQueueTimer = window.setTimeout(tick, nextDelay);
        return;
      }

      this.pendingEnsureMenus = false;
      this.ensureMenusQueueAttempts = 0;
      ensureMenus();
    };

    this.ensureMenusQueueTimer = window.setTimeout(tick, 80);
  }

  private runOrQueueEnsureMenus(fn: () => void): void {
    if (this.isActivelyTyping()) {
      this.pendingEnsureMenus = true;
      this.queueEnsureMenusFlush();
      return;
    }
    this.pendingEnsureMenus = false;
    this.ensureMenusQueueAttempts = 0;
    if (this.ensureMenusQueueTimer !== null) {
      window.clearTimeout(this.ensureMenusQueueTimer);
      this.ensureMenusQueueTimer = null;
    }
    fn();
  }

  private runOrQueueMenuRefresh(file: TFile, force: boolean = false): void {
    if (this.isTypingGuardActive()) return;
    this.persistentMenuManager.refreshMenusForFile(file, force);
  }

  private scheduleStructuralMenuRefresh(delayMs: number = 120): void {
    if (this.structuralMenuRefreshTimer !== null) {
      window.clearTimeout(this.structuralMenuRefreshTimer);
    }

    this.structuralMenuRefreshTimer = window.setTimeout(() => {
      this.structuralMenuRefreshTimer = null;
      const ensureMenus = this.ensureMenusFn;
      if (ensureMenus) {
        this.runOrQueueEnsureMenus(ensureMenus);
      }

      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile instanceof TFile) {
        this.persistentMenuManager.refreshMenusForFile(activeFile, true, { rebuildInlineSubitems: true });
      }
    }, Math.max(0, delayMs));
  }


  private clearPendingNamingSync(path: string): void {
    const timerId = this.namingSyncTimers.get(path);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      this.namingSyncTimers.delete(path);
    }
    this.namingSignatureByPath.delete(path);
  }

  private clearPendingTitleSync(path: string): void {
    const timers = this.pendingTitleSyncTimers.get(path);
    if (!timers || !timers.length) return;
    timers.forEach((timerId) => window.clearTimeout(timerId));
    this.pendingTitleSyncTimers.delete(path);
  }

  shouldIgnoreAutoFrontmatterWrite(file: TFile): boolean {
    if (!(file instanceof TFile)) return false;

    const patterns = this.getFrontmatterAutoWriteExclusionPatterns();
    if (!patterns.length) return false;

    const normalizedPath = this.normalizeComparablePath(file.path);
    const normalizedBasename = String(file.basename || '').trim().toLowerCase();

    for (const pattern of patterns) {
      if (this.matchesAutoFrontmatterExclusionPattern(normalizedPath, normalizedBasename, pattern)) {
        // logger.log(`[TPS GCM] Skipping auto frontmatter writes for ${file.path} due to exclusion: ${pattern}`);
        return true;
      }
    }

    return false;
  }

  private getFrontmatterAutoWriteExclusionPatterns(): string[] {
    const raw = String(this.settings.frontmatterAutoWriteExclusions || '');
    if (!raw.trim()) return [];

    return raw
      .split(/\r?\n|,/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private matchesAutoFrontmatterExclusionPattern(
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
      const target = String(pattern.slice(5) || '').trim().toLowerCase();
      if (!target) return false;
      return this.matchesWildcard(target, normalizedBasename);
    }

    const pathTarget = asLower.startsWith('path:')
      ? pattern.slice(5).trim()
      : pattern;
    const hasTrailingSlash = /[\/\\]$/.test(pathTarget);
    const normalizedTarget = this.normalizeComparablePath(pathTarget);
    if (!normalizedTarget) return false;

    if (normalizedTarget.includes('*')) {
      return this.matchesWildcard(normalizedTarget, normalizedPath) || this.matchesWildcard(normalizedTarget, normalizedBasename);
    }

    if (hasTrailingSlash) {
      return normalizedPath === normalizedTarget || normalizedPath.startsWith(`${normalizedTarget}/`);
    }

    if (normalizedPath === normalizedTarget || normalizedPath.startsWith(`${normalizedTarget}/`)) {
      return true;
    }

    return normalizedBasename === normalizedTarget;
  }

  private matchesWildcard(pattern: string, value: string): boolean {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`, 'i');
    return regex.test(value);
  }

  private normalizeComparablePath(value: string): string {
    if (!value || typeof value !== 'string') return '';
    return normalizePath(value.trim())
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  }

  private scheduleNamingSync(file: TFile, delayMs: number): void {
    if (!this.settings.enableAutoRename) return;
    if (!this.fileNamingService?.shouldProcess(file)) return;

    const existing = this.namingSyncTimers.get(file.path);
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }

    const timerId = window.setTimeout(() => {
      this.namingSyncTimers.delete(file.path);
      const latest = this.app.vault.getAbstractFileByPath(file.path);
      if (!(latest instanceof TFile)) return;
      if (!this.fileNamingService.shouldProcess(latest)) return;
      void this.fileNamingService.updateFilenameIfNeeded(latest).catch((error) => {
        logger.warn('[TPS GCM] Deferred filename sync failed', error);
      });
    }, Math.max(50, delayMs));

    this.namingSyncTimers.set(file.path, timerId);
  }

  private scheduleTitleSync(file: TFile, delays: number[] = [0, 350]): void {
    if (!this.fileNamingService) return;
    if (!this.fileNamingService.shouldProcess(file)) return;
    const schedule = delays.length ? delays : [0];

    this.clearPendingTitleSync(file.path);
    const timerIds: number[] = [];

    schedule.forEach((delay) => {
      const timerId = window.setTimeout(() => {
        const latest = this.app.vault.getAbstractFileByPath(file.path);
        if (!(latest instanceof TFile)) {
          this.clearPendingTitleSync(file.path);
          return;
        }
        if (!this.fileNamingService.shouldProcess(latest)) return;
        void this.fileNamingService.syncTitleFromFilename(latest).finally(() => {
          const pending = this.pendingTitleSyncTimers.get(latest.path) || [];
          const next = pending.filter((id) => id !== timerId);
          if (next.length > 0) {
            this.pendingTitleSyncTimers.set(latest.path, next);
          } else {
            this.pendingTitleSyncTimers.delete(latest.path);
          }
        });
      }, Math.max(0, delay));
      timerIds.push(timerId);
    });

    this.pendingTitleSyncTimers.set(file.path, timerIds);
  }


  // Create a debounced save function
  private debouncedSave = debounce(async () => {
    await this.saveData(this.buildPersistableSettings());
  }, 1000, true);

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
    this.dailyNoteNavManager = new DailyNoteNavManager(this); // Initialize
    this.dailyNoteNavManager = new DailyNoteNavManager(this); // Initialize
    this.addChild(this.dailyNoteNavManager); // Register as child component

    this.menuController = new MenuController(this);
    this.persistentMenuManager = new PersistentMenuManager(this);
    this.viewModeManager = new ViewModeManager(this);
    this.addChild(this.viewModeManager);

    // Initialize recurrence listener and load persistent session data
    await this.recurrenceService.initialize();
    this.recurrenceService.setup();

    this.patchMenuMethods();

    this.injectStyles();
    this.applyAppearanceSettings();
    document.body?.classList?.remove('tps-context-hidden-for-keyboard');
    document.body?.classList?.remove('tps-context-hidden-for-modal');
    document.body?.classList?.remove('tps-auto-base-embed-hidden-for-keyboard');
    this.setupModalVisibilityWatcher();

    this.keyboardVisible = false;

    // Register events
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile) {
          this.menuController.addToNativeMenu(menu, [file]);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on('files-menu', (menu, files) => {
        // Relaxed check to handle potential non-instance objects from other plugins
        const fileList = files.filter((f: any) => f && f.path && typeof f.path === 'string') as TFile[];
        if (fileList.length > 0) {
          this.menuController.addToNativeMenu(menu, fileList);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor, info) => {
        if (info && info.file instanceof TFile) {
          this.menuController.addToNativeMenu(menu, [info.file]);
        }
      })
    );

    this.addSettingTab(new TPSGlobalContextMenuSettingTab(this.app, this));

    const ensureMenus = this.persistentMenuManager.ensureMenus.bind(
      this.persistentMenuManager
    );
    this.ensureMenusFn = ensureMenus;

    // Debounced version for high-frequency events (mobile typing, bulk vault ops)
    // Using false (not immediate) to prevent jitter during typing
    const throttledEnsureMenus = debounce(() => this.runOrQueueEnsureMenus(ensureMenus), 500, false);

    if (!Platform.isMobile) {
      this.registerEvent(this.app.workspace.on('layout-change', throttledEnsureMenus));
    }
    this.registerEvent(this.app.workspace.on('active-leaf-change', throttledEnsureMenus));
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      const view = leaf?.view as MarkdownView | undefined;
      const file = view?.file || this.app.workspace.getActiveFile();
      if (file && this.manualViewModeOverridePath && file.path !== this.manualViewModeOverridePath) {
        this.manualViewModeOverridePath = null;
      }
      if (file) {
        this.runOrQueueMenuRefresh(file, true);
      }
    }));
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (file && this.manualViewModeOverridePath && file.path !== this.manualViewModeOverridePath) {
        this.manualViewModeOverridePath = null;
      }
      if (file instanceof TFile) {
        window.setTimeout(() => {
          void this.cleanupInjectedInlineSubitemsText(file);
        }, 220);
      }
      // Immediate menu creation attempt
      this.runOrQueueEnsureMenus(ensureMenus);
      if (file) {
        this.runOrQueueMenuRefresh(file, true);
      }

      // On mobile, metadata cache may not have updated yet on rapid file switching.
      // Schedule a delayed refresh to ensure frontmatter values are current.
      if (file && Platform.isMobile) {
        setTimeout(() => {
          this.runOrQueueMenuRefresh(file);
        }, 500); // Increased delay
      }

      if (file && this.fileNamingService.shouldProcess(file)) {
        // Run immediately for responsiveness, then retry after cache settles.
        void this.fileNamingService.processFileOnOpen(file);
        setTimeout(() => {
          void this.fileNamingService.processFileOnOpen(file);
        }, 500);
      }
    }));



    this.registerEvent(
      this.app.vault.on('create', (file) => {
        if (file instanceof TFolder) {
          return;
        }
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        this.namingSignatureByPath.delete(file.path);
        this.scheduleStructuralMenuRefresh(80);
      })
    );

    // Don't listen to vault modify - this fires too often during typing
    // The metadataCache.on('changed') handler already handles this with better debouncing

    // Refresh inline menus when frontmatter changes (fixes stale menus)
    // Heavily debounced to prevent lag during typing
    // IMPORTANT: Third param (immediate) is false - we fire at END of delay, not start
    const debouncedMenuRefresh = debounce((file: TFile) => {
      if (!file || file.extension !== 'md') return;
      this.runOrQueueMenuRefresh(file);
    }, 2500, false); // Longer debounce to avoid typing lag

    const MAX_FM_CACHE_SIZE = 2000;
    const lastFrontmatterByPath = new Map<string, string>();
    const isBadgeRelevantKey = (key: string) => {
      const normalized = String(key || '').toLowerCase();
      const parentKey = String(this.settings.parentLinkFrontmatterKey || 'parent').toLowerCase();
      if (normalized === 'status' || normalized === 'priority' || normalized === 'scheduled' || normalized === 'due' || normalized === parentKey) return true;
      if (normalized === 'tags' || normalized === 'tag') return true;
      if (normalized === 'icon' || normalized === 'iconcolor') return true;
      return normalized.startsWith('tps') || normalized.startsWith('gcm');
    };

    // Clean up frontmatter cache when files are deleted or renamed
    this.registerEvent(this.app.vault.on('delete', (file) => {
      lastFrontmatterByPath.delete(file.path);
      this.clearPendingNamingSync(file.path);
      this.clearPendingTitleSync(file.path);
      this.scheduleStructuralMenuRefresh(80);
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      const prev = lastFrontmatterByPath.get(oldPath);
      lastFrontmatterByPath.delete(oldPath);
      if (prev !== undefined) lastFrontmatterByPath.set(file.path, prev);
      const namingPrev = this.namingSignatureByPath.get(oldPath);
      this.clearPendingNamingSync(oldPath);
      this.clearPendingTitleSync(oldPath);
      if (namingPrev !== undefined) {
        this.namingSignatureByPath.set(file.path, namingPrev);
      }
      this.scheduleStructuralMenuRefresh(80);
    }));

    this.registerEvent(
      this.app.metadataCache.on('changed', (file) => {
        if (!file || file.extension !== 'md') return;
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter || {};
        const rawTitle = typeof fm.title === 'string' ? fm.title.trim() : '';
        const rawScheduled = fm.scheduled != null ? String(fm.scheduled).trim() : '';
        const namingSignature = `${rawTitle.toLowerCase()}|${rawScheduled}`;
        const previousNamingSignature = this.namingSignatureByPath.get(file.path);
        if (namingSignature !== previousNamingSignature) {
          this.namingSignatureByPath.set(file.path, namingSignature);
          const namingDelay = this.isEditorFocused() ? 700 : 100;
          this.scheduleNamingSync(file, namingDelay);
        }

        if (this.isEditorFocused()) return;
        const recentlyTyping = this.lastEditorChangeAt && Date.now() - this.lastEditorChangeAt < this.typingQuietWindowMs;
        if (recentlyTyping) {
          return;
        }
        const keys = Object.keys(fm);
        // Deterministic signature: sort keys for consistent JSON output
        const fmSignature = keys.length ? JSON.stringify(fm, keys.sort()) : "";
        const prev = lastFrontmatterByPath.get(file.path);
        if (prev === fmSignature) return;
        lastFrontmatterByPath.set(file.path, fmSignature);
        // Evict oldest entries if cache grows too large
        if (lastFrontmatterByPath.size > MAX_FM_CACHE_SIZE) {
          const iter = lastFrontmatterByPath.keys();
          for (let i = 0; i < Math.floor(MAX_FM_CACHE_SIZE * 0.2); i++) {
            const oldest = iter.next().value;
            if (oldest) lastFrontmatterByPath.delete(oldest);
          }
        }
        if (!keys.some(isBadgeRelevantKey)) return;
        debouncedMenuRefresh(file);

        // Also refresh inline title icon or parent nav if relevant fields changed
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView?.file?.path === file.path) {
          const parentKey = String(this.settings.parentLinkFrontmatterKey || 'parent').toLowerCase();
          const hasIconRelevantKey = keys.some((key) => {
            const normalized = String(key || '').toLowerCase();
            return normalized === 'icon' || normalized === 'iconcolor';
          });
          const hasParentRelevantKey = keys.some((key) => {
            const normalized = String(key || '').toLowerCase();
            return normalized === parentKey;
          });

          if (hasIconRelevantKey) {
            this.persistentMenuManager.refreshInlineTitleIcon(activeView);
          }
          if (hasParentRelevantKey) {
            this.persistentMenuManager.ensureTopParentNav(activeView);
          }
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on('editor-change', () => {
        this.lastEditorChangeAt = Date.now();
      })
    );

    // Avoid focus-based flushes to prevent typing lag; rely on leaf/file changes instead.

    // Refresh menus on rename to keep title in sync
    this.registerEvent(
      // Note: Obsidian provides (file, oldPath); keep args flexible across versions.
      this.app.vault.on('rename', (file, oldPath) => {
        // Be resilient to non-instance rename payloads from plugin wrappers/sync churn.
        const renamedPath = (file as any)?.path;
        const resolved = file instanceof TFile
          ? file
          : (typeof renamedPath === 'string' ? this.app.vault.getAbstractFileByPath(renamedPath) : null);

        if (resolved instanceof TFolder) return;
        if (!(resolved instanceof TFile) || resolved.extension !== 'md') return;

        this.persistentMenuManager.refreshMenusForFile(resolved);

        // Force update of folderPath immediately (for moves)
        void this.fileNamingService.syncFolderPath(resolved);

        // Ensure renames propagate into frontmatter title.
        // Use multiple retries because sync/metadata ordering can differ across devices.
        this.scheduleTitleSync(resolved, [0, 350, 1200]);

        const oldParent = String(oldPath || '').split('/').slice(0, -1).join('/');
        const newParent = resolved.parent?.path || '';
        if (oldParent !== newParent) {
          // Type profile apply removed
        }
      })
    );

    // Schedule daily archive tag sweep
    this.scheduleArchiveSweep();

    this.register(() => this.persistentMenuManager.detach());
    this.register(() => this.menuController.detach());


    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        this.clearPendingTitleSync(file.path);
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
        this.scheduleStructuralMenuRefresh(0);
      })
    );

    // Initial menu setup
    this.runOrQueueEnsureMenus(ensureMenus);
    this.applyAppearanceSettings();

    // Mobile can miss the first render; re-check after layout is ready.
    this.app.workspace.onLayoutReady(() => {
      this.runOrQueueEnsureMenus(ensureMenus);
      setTimeout(() => this.runOrQueueEnsureMenus(ensureMenus), 600);
      setTimeout(() => this.runOrQueueEnsureMenus(ensureMenus), 1500);
    });

    // Keep visual settings synced when layout changes.
    this.registerEvent(this.app.workspace.on('layout-change', () => this.applyAppearanceSettings()));

    // Mobile keyboard handling delegated to PersistentMenuManager

    // Check for missing recurrences on startup
    this.app.workspace.onLayoutReady(async () => {
      if (Platform.isMobile) {
        logger.log('[TPS GCM] Skipping recurrence scan on mobile startup.');
        return;
      }

      // Give a short delay to allow other plugins/cache to settle
      setTimeout(async () => {
        logger.log('[TPS GCM] Checking for missing recurrences on startup...');
        await this.bulkEditService.checkMissingRecurrences();
      }, 2000);
    });

    // Manual Context Menu for Sync Embeds (Reading Mode)
    // Global Context Menu Interceptor (Strict Mode & Sync Embeds)
    this.registerDomEvent(document, 'contextmenu', (evt: MouseEvent) => {
      const rawTarget = evt.target;
      const targetEl = rawTarget instanceof HTMLElement
        ? rawTarget
        : rawTarget instanceof Node
          ? rawTarget.parentElement
          : null;
      if (!targetEl) return;

      const isSyncEmbed = !!this.contextTargetService.resolveEmbedTarget(targetEl);
      const linkMatch = targetEl.closest('a.internal-link, .cm-link, [data-href], [data-path], [data-linkpath], [data-file]');
      const linkTargetPath = linkMatch ? this.contextTargetService.resolveExplorerPath(targetEl) : null;
      const linkTargetAbstract = linkTargetPath ? this.app.vault.getAbstractFileByPath(linkTargetPath) : null;
      const hasResolvedFileLink = linkTargetAbstract instanceof TFile;

      // Scope-aware link detection so view toggles in settings are honored.
      const isLivePreviewLink = !!(linkMatch && targetEl.closest('.markdown-source-view'));
      const isReadingLink = !!(linkMatch && targetEl.closest('.markdown-reading-view, .markdown-preview-view, .markdown-embed, .popover'));
      const isCanvasLink = !!(linkMatch && targetEl.closest('.canvas-node-content, .canvas-wrapper'));
      const isNotebookNavigatorLink = !!(
        linkMatch &&
        targetEl.closest('.view-content.notebook-navigator, .notebook-navigator, .nn-split-container, .nn-navigation-pane, .nn-list-pane, .nn-file, .nn-navitem')
      );
      const isSidePanelLink = !!(
        linkMatch &&
        targetEl.closest('.workspace-sidedock, .workspace-split.mod-left-split, .workspace-split.mod-right-split, .workspace-tabs.mod-left-split, .workspace-tabs.mod-right-split')
      );

      const isLinkTarget = hasResolvedFileLink && (
        (isLivePreviewLink && this.settings.enableInLivePreview) ||
        ((isReadingLink || isCanvasLink) && this.settings.enableInPreview) ||
        ((isNotebookNavigatorLink || isSidePanelLink) && this.settings.enableInSidePanels)
      );

      // In strict mode, do not replace native menus for non-file links/folders.
      if (this.settings.enableStrictMode && linkMatch && !hasResolvedFileLink && !isSyncEmbed) {
        return;
      }

      // 1. Resolve Targets
      // We pass the event so the service can check specific click targets (embeds, etc.)
      const targets = this.contextTargetService.resolveTargets([], evt);
      if (targets.length === 0) return;

      const file = targets[0];

      // 2. Decide if we should intercept
      // Intercept if:
      // a) Strict Mode is ENABLED
      // b) It is a Sync Embed (Reading mode embeds don't trigger native file-menu usually, so we always handle them)
      // c) It is a resolved file link target (internal links across plugins)
      if (this.settings.enableStrictMode || isSyncEmbed || isLinkTarget) {
        // Suppress Native Menu
        evt.preventDefault();
        evt.stopPropagation();

        const menu = new Menu();

        // 3. Populate Menu
        if (this.settings.enableStrictMode) {
          // Strict mode: only our menu items
          this.menuController.addToNativeMenu(menu, targets);
        } else {
          // Non-strict interception path: preserve native/core/plugin file-menu population.
          // Our file-menu listener will inject TPS items once (guarded by _tpsHandled).
          this.app.workspace.trigger('file-menu', menu, file, 'tps-gcm-intercept', this.app.workspace.activeLeaf);
        }

        // 4. Show Menu
        menu.showAtPosition({ x: evt.pageX, y: evt.pageY });
      }
    }, { capture: true });

    // Sidebar Open Commands
    this.addCommand({
      id: 'open-in-right-sidebar',
      name: 'Open active file in Right Sidebar',
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (file) {
          if (!checking) {
            const leaf = this.app.workspace.getRightLeaf(true);
            if (leaf) {
              leaf.openFile(file);
              this.app.workspace.revealLeaf(leaf);
            }
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
            const leaf = this.app.workspace.getLeftLeaf(true);
            if (leaf) {
              leaf.openFile(file);
              this.app.workspace.revealLeaf(leaf);
            }
          }
          return true;
        }
        return false;
      }
    });

    // Shift+Click Checkbox Handler (Desktop Only)
    if (!Platform.isMobile) {
      this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
        if (!this.settings.enableShiftClickCancel) return;
        if (!evt.shiftKey) return;

        const target = evt.target as HTMLElement;

        if (!(target instanceof HTMLElement)) return;

        const isCheckbox = (target.matches && target.matches('input[type="checkbox"]')) ||
          (target.classList && target.classList.contains('task-list-item-checkbox')) ||
          (target.classList && target.classList.contains('cm-formatting-task'));

        if (!isCheckbox) return;

        logger.log('[TPS GCM] Shift+click on checkbox detected');

        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();

        this.handleCheckboxClick(target);
      }, { capture: true });
    }

    // Long-press Checkbox Handler (Mobile Only)
    if (Platform.isMobile) {
      let longPressTimer: number | null = null;
      let longPressTriggered = false;
      let startTarget: EventTarget | null = null;

      const showCheckboxMenu = (target: HTMLElement, clientX: number, clientY: number) => {
        logger.log('[TPS GCM] Long-press on checkbox detected');
        this.handleCheckboxLongPress(target, clientX, clientY);
      };

      this.registerDomEvent(document, 'touchstart', (evt: TouchEvent) => {
        longPressTriggered = false;
        startTarget = null;
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

        if (!this.settings.enableShiftClickCancel) return;

        const target = evt.target as HTMLElement;
        if (!(target instanceof HTMLElement)) return;

        const isCheckbox = (target.matches && target.matches('input[type="checkbox"]')) ||
          (target.classList && target.classList.contains('task-list-item-checkbox')) ||
          (target.classList && target.classList.contains('cm-formatting-task'));

        if (!isCheckbox) return;

        startTarget = target;
        const touch = evt.touches[0];
        const clientX = touch.clientX;
        const clientY = touch.clientY;

        longPressTimer = window.setTimeout(() => {
          longPressTriggered = true;
          longPressTimer = null;
          showCheckboxMenu(target, clientX, clientY);
        }, 500);
      }, { capture: true, passive: true });

      this.registerDomEvent(document, 'touchend', (evt: TouchEvent) => {
        if (!longPressTimer && !longPressTriggered) return;

        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }

        if (longPressTriggered) {
          if (evt.cancelable) {
            evt.preventDefault();
            evt.stopPropagation();
          }
          longPressTriggered = false;
        }
        startTarget = null;
      }, { capture: true });

      this.registerDomEvent(document, 'touchmove', () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
          longPressTriggered = false;
          startTarget = null;
        }
      }, { capture: true, passive: true });
    }
  }

  suppressViewModeSwitch(ms: number = 1200): void {
    this.skipViewModeSwitchUntil = Math.max(this.skipViewModeSwitchUntil, Date.now() + ms);
  }

  suppressViewModeSwitchForPathUntilFocusChange(path: string): void {
    this.manualViewModeOverridePath = path || null;
  }

  shouldSkipViewModeSwitch(): boolean {
    if (Date.now() < this.skipViewModeSwitchUntil) return true;
    const activePath = this.app.workspace.getActiveFile()?.path ?? null;
    if (!this.manualViewModeOverridePath) return false;
    return activePath === this.manualViewModeOverridePath;
  }

  scheduleArchiveSweep(): void {
    if (this.archiveTimerId) {
      window.clearTimeout(this.archiveTimerId);
      this.archiveTimerId = null;
    }
    if (!this.settings.enableArchiveTagMove) return;
    const now = new Date();
    const next = new Date(now);
    next.setDate(now.getDate() + 1);
    next.setHours(0, 5, 0, 0);
    const delay = Math.max(1000, next.getTime() - now.getTime());
    this.archiveTimerId = window.setTimeout(() => {
      this.archiveTimerId = null;
      void this.runArchiveTagSweep();
      this.scheduleArchiveSweep();
    }, delay);
  }

  private async runArchiveTagSweep(): Promise<void> {
    if (!this.settings.enableArchiveTagMove) return;
    const archiveTag = normalizeTagValue(this.settings.archiveTag || 'archive');
    if (!archiveTag) return;
    const archiveFolderPath = (this.settings.archiveFolderPath || 'System/Archive').trim();
    const archiveFolder = normalizePath(archiveFolderPath);
    const existingFolder = this.app.vault.getAbstractFileByPath(archiveFolder);
    if (!existingFolder) {
      await this.app.vault.createFolder(archiveFolder);
    }

    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      if (file.path.startsWith(`${archiveFolder}/`)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const fmTags = cache?.frontmatter?.tags;
      const tagsFromFrontmatter = parseTagInput(fmTags);
      const tagsFromCache = (cache?.tags || []).map((t: any) =>
        typeof t?.tag === 'string' ? t.tag : String(t?.tag ?? t)
      );
      const allTags = [...tagsFromFrontmatter, ...tagsFromCache]
        .map((t) => normalizeTagValue(t))
        .filter(Boolean);
      if (!allTags.includes(archiveTag)) continue;

      const targetBase = normalizePath(`${archiveFolder}/${file.name}`);
      let targetPath = targetBase;
      let counter = 1;
      while (this.app.vault.getAbstractFileByPath(targetPath)) {
        const baseName = file.basename;
        targetPath = normalizePath(`${archiveFolder}/${baseName} ${counter}.${file.extension}`);
        counter += 1;
      }
      try {
        await this.app.fileManager.renameFile(file, targetPath);
      } catch (err) {
        logger.error(`[TPS GCM] Failed to archive ${file.path}`, err);
      }
    }
  }

  // Helper methods
  private handleCheckboxClick(target: HTMLElement) {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (!activeLeaf) return;
    const view = activeLeaf.view as any;
    if (!view) return;
    const lineNumber = this.findCheckboxLineNumber(target, view);
    if (lineNumber >= 0 && view.file) this.modifyCheckboxLine(view.file, lineNumber, '[-]');
  }

  private handleCheckboxLongPress(target: HTMLElement, clientX: number, clientY: number) {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (!activeLeaf) return;
    const view = activeLeaf.view as any;
    if (!view) return;
    const lineNumber = this.findCheckboxLineNumber(target, view);
    if (lineNumber < 0 || !view.file) return;

    const file = view.file;
    const menu = new Menu();
    menu.addItem((item) => { item.setTitle('✓ Complete').setIcon('check').onClick(() => this.modifyCheckboxLine(file, lineNumber, '[x]')); });
    menu.addItem((item) => { item.setTitle('— Cancel').setIcon('minus').onClick(() => this.modifyCheckboxLine(file, lineNumber, '[-]')); });
    menu.addItem((item) => { item.setTitle('○ Unchecked').setIcon('circle').onClick(() => this.modifyCheckboxLine(file, lineNumber, '[ ]')); });
    menu.showAtPosition({ x: clientX, y: clientY });
  }

  private findCheckboxLineNumber(target: HTMLElement, view: any): number {
    let lineNumber = -1;
    const lineEl = target.closest('[data-line]');
    if (lineEl) {
      const dataLine = lineEl.getAttribute('data-line');
      if (dataLine) lineNumber = parseInt(dataLine, 10);
    }
    if (lineNumber < 0 && view.editor) {
      const editor = view.editor;
      try {
        const cm = (editor as any).cm;
        if (cm && cm.posAtDOM) {
          const cmLine = target.closest('.cm-line') || target;
          const pos = cm.posAtDOM(cmLine);
          if (pos !== undefined && pos !== null) {
            const line = cm.state.doc.lineAt(pos);
            lineNumber = line.number - 1;
          }
        }
      } catch (e) { }
    }
    return lineNumber;
  }

  private modifyCheckboxLine(file: any, lineNumber: number, newState: string) {
    this.app.vault.read(file).then((content: string) => {
      const lines = content.split('\n');
      if (lineNumber < 0 || lineNumber >= lines.length) return;
      const lineContent = lines[lineNumber];
      let newContent = lineContent;
      if (/\[[ x\-]\]/i.test(lineContent)) {
        newContent = lineContent.replace(/\[[ x\-]\]/i, newState);
      } else {
        return;
      }
      lines[lineNumber] = newContent;
      this.app.vault.modify(file, lines.join('\n'));
    });
  }


  patchMenuMethods() {
    // Monkey patch Menu to enforce ordering right before display
    const originalShowAtPosition = Menu.prototype.showAtPosition;
    const originalShowAtMouseEvent = Menu.prototype.showAtMouseEvent;

    const reorderItems = (menu: Menu) => {
      // Check for items existence and if we likely tampered with it
      if ((menu as any).items) {
        const items = (menu as any).items as any[];
        const tpsItems: any[] = [];
        const otherItems: any[] = [];

        for (const item of items) {
          // Identify TPS items by our custom flag
          if ((item as any)._isTpsItem) {
            tpsItems.push(item);
          } else {
            otherItems.push(item);
          }
        }

        const getTitle = (item: any) => {
          let t = item.title;
          if (!t && item.dom) {
            const titleEl = item.dom.querySelector('.menu-item-title');
            if (titleEl) t = titleEl.innerText;
            else t = item.dom.innerText;
          }
          // Normalize: trim, lowercase, remove ellipsis, replace NBSP
          return t ? t.toLowerCase().replace(/\.\.\.$/, '').replace(/\u00A0/g, ' ').trim() : '';
        };
        // Dedupe TPS items only (keep native/core/plugin items untouched).
        const uniqueTpsItems: any[] = [];
        const seenTps = new Set<string>();
        for (const item of tpsItems) {
          const section = String((item as any).section ?? '');
          const title = getTitle(item);
          const key = `${section}::${title}`;
          if (title && seenTps.has(key)) continue;
          if (title) seenTps.add(key);
          uniqueTpsItems.push(item);
        }

        // Only reorder if we actually found TPS items
        if (uniqueTpsItems.length > 0) {
          const placement = this.settings.nativeMenuPlacement || 'tps-last';
          (menu as any).items = placement === 'tps-first'
            ? [...uniqueTpsItems, ...otherItems]
            : [...otherItems, ...uniqueTpsItems];
        }
      }
    };

    // We modify the prototype's method to intercept the call
    Menu.prototype.showAtPosition = function (pos) {
      reorderItems(this);
      return originalShowAtPosition.call(this, pos);
    };

    Menu.prototype.showAtMouseEvent = function (evt) {
      reorderItems(this);
      return originalShowAtMouseEvent.call(this, evt);
    };

    this.restoreMenuPatch = () => {
      Menu.prototype.showAtPosition = originalShowAtPosition;
      Menu.prototype.showAtMouseEvent = originalShowAtMouseEvent;
    };
  }

  onunload(): void {
    this.modalObserver?.disconnect();
    this.modalObserver = null;
    if (this.restoreMenuPatch) {
      this.restoreMenuPatch();
      this.restoreMenuPatch = null;
    }
    this.menuController?.detach();
    this.removeStyles();
    this.persistentMenuManager?.detach();
    this.recurrenceService?.cleanup();
    document.body?.classList?.remove('tps-context-hidden-for-keyboard');
    document.body?.classList?.remove('tps-context-hidden-for-modal');
    if (this.archiveTimerId) {
      window.clearTimeout(this.archiveTimerId);
      this.archiveTimerId = null;
    }
    if (this.ensureMenusQueueTimer !== null) {
      window.clearTimeout(this.ensureMenusQueueTimer);
      this.ensureMenusQueueTimer = null;
    }
    if (this.structuralMenuRefreshTimer !== null) {
      window.clearTimeout(this.structuralMenuRefreshTimer);
      this.structuralMenuRefreshTimer = null;
    }
    this.pendingEnsureMenus = false;
    Array.from(this.namingSyncTimers.values()).forEach((timerId) => window.clearTimeout(timerId));
    this.namingSyncTimers.clear();
    this.namingSignatureByPath.clear();
    this.clearAppearanceSettings();
  }

  private normalizeBoundedNumber(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    precision: number = 2,
  ): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = Math.min(max, Math.max(min, parsed));
    const factor = Math.pow(10, Math.max(0, precision));
    return Math.round(clamped * factor) / factor;
  }

  private async cleanupInjectedInlineSubitemsText(file: TFile): Promise<void> {
    try {
      if (file.extension?.toLowerCase() !== 'md') return;

      const content = await this.app.vault.read(file);
      const notesHeaderIndex = content.indexOf('\n## Notes');
      if (notesHeaderIndex <= 0) return;

      const beforeNotes = content.slice(0, notesHeaderIndex);
      const artifactPattern = /(?:^|\n)Subitems\nChildren \+ attachments\n\nLoading subitems\.\.\.\n?/g;
      const matches = beforeNotes.match(artifactPattern);
      if (!matches || matches.length === 0) return;

      const cleanedBeforeNotes = beforeNotes.replace(artifactPattern, '\n').replace(/\n{3,}/g, '\n\n');
      const nextContent = `${cleanedBeforeNotes}${content.slice(notesHeaderIndex)}`;
      if (nextContent === content) return;

      await this.app.vault.modify(file, nextContent);
      logger.warn(`[TPS GCM] Removed injected inline subitems text artifacts from ${file.path}`);
    } catch (error) {
      logger.error(`[TPS GCM] Failed cleaning injected subitems text in ${file.path}:`, error);
    }
  }

  private getAppearanceStorageKey(key: AppearanceSettingKey): string {
    return `${APPEARANCE_LOCAL_STORAGE_PREFIX}${key}`;
  }

  private readLocalAppearanceValue(key: AppearanceSettingKey): TPSGlobalContextMenuSettings[AppearanceSettingKey] | null {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    try {
      const raw = window.localStorage.getItem(this.getAppearanceStorageKey(key));
      if (raw == null) return null;
      return JSON.parse(raw) as TPSGlobalContextMenuSettings[AppearanceSettingKey];
    } catch {
      return null;
    }
  }

  private writeLocalAppearanceValue(
    key: AppearanceSettingKey,
    value: TPSGlobalContextMenuSettings[AppearanceSettingKey],
  ): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.setItem(this.getAppearanceStorageKey(key), JSON.stringify(value));
    } catch {
      // Ignore localStorage errors (private mode, quota, etc.)
    }
  }

  private removeLocalAppearanceValue(key: AppearanceSettingKey): void {
    if (typeof window === 'undefined' || !window.localStorage) return;
    try {
      window.localStorage.removeItem(this.getAppearanceStorageKey(key));
    } catch {
      // Ignore localStorage errors.
    }
  }

  private normalizeAppearanceSyncModes(): boolean {
    const current = (this.settings.appearanceSyncModes && typeof this.settings.appearanceSyncModes === 'object')
      ? this.settings.appearanceSyncModes
      : {};
    const normalized: Partial<Record<AppearanceSettingKey, AppearanceSyncMode>> = {};

    for (const key of APPEARANCE_SETTING_KEYS) {
      if (current[key] === 'local') {
        normalized[key] = 'local';
      }
    }

    const before = JSON.stringify(current);
    const after = JSON.stringify(normalized);
    this.settings.appearanceSyncModes = normalized;
    return before !== after;
  }

  getAppearanceSyncMode(key: AppearanceSettingKey): AppearanceSyncMode {
    return this.settings.appearanceSyncModes?.[key] === 'local' ? 'local' : 'synced';
  }

  isAppearanceSettingSynced(key: AppearanceSettingKey): boolean {
    return this.getAppearanceSyncMode(key) === 'synced';
  }

  setAppearanceSettingSyncMode(key: AppearanceSettingKey, mode: AppearanceSyncMode): void {
    const nextModes: Partial<Record<AppearanceSettingKey, AppearanceSyncMode>> = {
      ...(this.settings.appearanceSyncModes || {}),
    };

    if (mode === 'local') {
      nextModes[key] = 'local';
      const localValue = this.readLocalAppearanceValue(key);
      if (localValue !== null) {
        (this.settings as any)[key] = localValue;
      } else {
        this.writeLocalAppearanceValue(key, this.settings[key] as any);
      }
    } else {
      delete nextModes[key];
      this.syncedAppearanceValues[key] = this.settings[key];
      this.removeLocalAppearanceValue(key);
    }

    this.settings.appearanceSyncModes = nextModes;
    this.normalizeAppearanceSettings();
    this.applyAppearanceSettings();
  }

  toggleAppearanceSettingSyncMode(key: AppearanceSettingKey): void {
    const nextMode: AppearanceSyncMode = this.isAppearanceSettingSynced(key) ? 'local' : 'synced';
    this.setAppearanceSettingSyncMode(key, nextMode);
  }

  setAppearanceSettingValue<K extends AppearanceSettingKey>(
    key: K,
    value: TPSGlobalContextMenuSettings[K],
  ): void {
    (this.settings as any)[key] = value;
    if (this.isAppearanceSettingSynced(key)) {
      this.syncedAppearanceValues[key] = value as TPSGlobalContextMenuSettings[AppearanceSettingKey];
    } else {
      this.writeLocalAppearanceValue(key, value as TPSGlobalContextMenuSettings[AppearanceSettingKey]);
    }
  }

  private captureSyncedAppearanceValuesFromLoadedData(loadedData: unknown): void {
    const loaded = loadedData && typeof loadedData === 'object'
      ? (loadedData as Record<string, unknown>)
      : {};
    const snapshot: Partial<Record<AppearanceSettingKey, TPSGlobalContextMenuSettings[AppearanceSettingKey]>> = {};

    for (const key of APPEARANCE_SETTING_KEYS) {
      if (Object.prototype.hasOwnProperty.call(loaded, key)) {
        snapshot[key] = loaded[key] as TPSGlobalContextMenuSettings[AppearanceSettingKey];
      } else {
        snapshot[key] = DEFAULT_SETTINGS[key];
      }
    }

    this.syncedAppearanceValues = snapshot;
  }

  private applyLocalAppearanceOverrides(): void {
    for (const key of APPEARANCE_SETTING_KEYS) {
      if (this.getAppearanceSyncMode(key) !== 'local') continue;
      const localValue = this.readLocalAppearanceValue(key);
      if (localValue === null) {
        this.writeLocalAppearanceValue(key, this.settings[key]);
        continue;
      }
      (this.settings as any)[key] = localValue;
    }
  }

  private syncLocalAppearanceStorageFromSettings(): void {
    for (const key of APPEARANCE_SETTING_KEYS) {
      if (this.getAppearanceSyncMode(key) === 'local') {
        this.writeLocalAppearanceValue(key, this.settings[key]);
      }
    }
  }

  private refreshSyncedAppearanceValuesFromCurrentSettings(): void {
    for (const key of APPEARANCE_SETTING_KEYS) {
      if (this.getAppearanceSyncMode(key) === 'synced') {
        this.syncedAppearanceValues[key] = this.settings[key];
      }
    }
  }

  private buildPersistableSettings(): TPSGlobalContextMenuSettings {
    const persistable = { ...this.settings };
    for (const key of APPEARANCE_SETTING_KEYS) {
      if (this.getAppearanceSyncMode(key) !== 'local') continue;
      const fallback = DEFAULT_SETTINGS[key];
      (persistable as any)[key] = (this.syncedAppearanceValues[key] ?? fallback) as any;
    }
    return persistable;
  }

  private normalizeAppearanceSettings(): boolean {
    let changed = false;

    const setIfChanged = <K extends keyof TPSGlobalContextMenuSettings>(
      key: K,
      value: TPSGlobalContextMenuSettings[K],
    ) => {
      if (this.settings[key] !== value) {
        this.settings[key] = value;
        changed = true;
      }
    };

    setIfChanged('menuTextScale', this.normalizeBoundedNumber(this.settings.menuTextScale, DEFAULT_SETTINGS.menuTextScale, 0.7, 1.8, 2));
    setIfChanged('buttonScale', this.normalizeBoundedNumber(this.settings.buttonScale, DEFAULT_SETTINGS.buttonScale, 0.7, 1.8, 2));
    setIfChanged('controlScale', this.normalizeBoundedNumber(this.settings.controlScale, DEFAULT_SETTINGS.controlScale, 0.7, 1.8, 2));
    setIfChanged('menuDensity', this.normalizeBoundedNumber(this.settings.menuDensity, DEFAULT_SETTINGS.menuDensity, 0.75, 1.35, 2));
    setIfChanged('menuRadiusScale', this.normalizeBoundedNumber(this.settings.menuRadiusScale, DEFAULT_SETTINGS.menuRadiusScale, 0.6, 1.8, 2));
    setIfChanged('inlinePanelMaxWidth', this.normalizeBoundedNumber(this.settings.inlinePanelMaxWidth, DEFAULT_SETTINGS.inlinePanelMaxWidth, 320, 1800, 0));
    setIfChanged('liveMenuOffsetX', this.normalizeBoundedNumber(this.settings.liveMenuOffsetX, DEFAULT_SETTINGS.liveMenuOffsetX, -500, 500, 0));
    setIfChanged('liveMenuOffsetY', this.normalizeBoundedNumber(this.settings.liveMenuOffsetY, DEFAULT_SETTINGS.liveMenuOffsetY, -500, 500, 0));
    setIfChanged('modalWidth', this.normalizeBoundedNumber(this.settings.modalWidth, DEFAULT_SETTINGS.modalWidth, 300, 1200, 0));
    setIfChanged('modalMaxHeightVh', this.normalizeBoundedNumber(this.settings.modalMaxHeightVh, DEFAULT_SETTINGS.modalMaxHeightVh, 45, 95, 0));
    setIfChanged('subitemsMarginBottom', this.normalizeBoundedNumber(this.settings.subitemsMarginBottom, DEFAULT_SETTINGS.subitemsMarginBottom, -500, 500, 0));

    const liveMenuPosition = this.settings.liveMenuPosition;
    if (liveMenuPosition !== 'left' && liveMenuPosition !== 'center' && liveMenuPosition !== 'right') {
      setIfChanged('liveMenuPosition', DEFAULT_SETTINGS.liveMenuPosition);
    }

    return changed;
  }

  applyAppearanceSettings(): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (!root) return;

    const textScale = this.normalizeBoundedNumber(this.settings.menuTextScale, 1, 0.7, 2.2, 3);
    const buttonScale = this.normalizeBoundedNumber(this.settings.buttonScale, 1, 0.7, 2.2, 3);
    const controlScale = this.normalizeBoundedNumber(this.settings.controlScale, 1, 0.7, 2.2, 3);
    const density = this.normalizeBoundedNumber(this.settings.menuDensity, 1, 0.75, 1.35, 3);
    const radiusScale = this.normalizeBoundedNumber(this.settings.menuRadiusScale, 1, 0.6, 1.8, 3);

    root.style.setProperty('--tps-gcm-text-scale', String(textScale));
    root.style.setProperty('--tps-gcm-button-scale', String(buttonScale));
    root.style.setProperty('--tps-gcm-control-scale', String(controlScale));
    root.style.setProperty('--tps-gcm-density', String(density));
    root.style.setProperty('--tps-gcm-radius-scale', String(radiusScale));
    root.style.setProperty('--tps-gcm-modal-width', `${Math.round(this.settings.modalWidth)}px`);
    root.style.setProperty('--tps-gcm-modal-max-height', `${Math.round(this.settings.modalMaxHeightVh)}vh`);
    root.style.setProperty('--tps-gcm-subitems-margin-bottom', `${Math.round(this.settings.subitemsMarginBottom)}px`);

    const navScale = this.normalizeBoundedNumber(this.settings.dailyNavScale, 1, 0.5, 2.5, 3);
    root.style.setProperty('--tps-gcm-daily-nav-scale', String(navScale));
    const navRestOpacity = this.normalizeBoundedNumber(this.settings.dailyNavRestOpacity, 0, 0, 100, 0);
    root.style.setProperty('--tps-gcm-daily-nav-rest-opacity', String(navRestOpacity / 100));

    const offsetX = Math.round(this.settings.liveMenuOffsetX);
    const offsetY = Math.round(this.settings.liveMenuOffsetY);
    if (this.settings.liveMenuPosition === 'left') {
      root.style.setProperty('--tps-gcm-live-left', '0px');
      root.style.setProperty('--tps-gcm-live-right', 'auto');
      root.style.setProperty('--tps-gcm-live-transform', `translate(${offsetX}px, ${offsetY}px)`);
      return;
    }

    if (this.settings.liveMenuPosition === 'right') {
      root.style.setProperty('--tps-gcm-live-left', 'auto');
      root.style.setProperty('--tps-gcm-live-right', '0px');
      root.style.setProperty('--tps-gcm-live-transform', `translate(${offsetX}px, ${offsetY}px)`);
      return;
    }

    root.style.setProperty('--tps-gcm-live-left', '50%');
    root.style.setProperty('--tps-gcm-live-right', 'auto');
    root.style.setProperty('--tps-gcm-live-transform', `translate(calc(-50% + ${offsetX}px), ${offsetY}px)`);
  }

  private clearAppearanceSettings(): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (!root) return;
    [
      '--tps-gcm-text-scale',
      '--tps-gcm-button-scale',
      '--tps-gcm-control-scale',
      '--tps-gcm-density',
      '--tps-gcm-radius-scale',
      '--tps-gcm-live-left',
      '--tps-gcm-live-right',
      '--tps-gcm-live-transform',
      '--tps-gcm-modal-width',
      '--tps-gcm-modal-max-height',
      '--tps-gcm-daily-nav-scale',
      '--tps-gcm-daily-nav-rest-opacity',
    ].forEach((variable) => root.style.removeProperty(variable));
  }

  private setupModalVisibilityWatcher(): void {
    const isActuallyVisible = (el: Element): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const updateModalState = () => {
      const nodes = Array.from(
        document.querySelectorAll(
          '.modal-container, .modal.mod-open, .modal-container .modal, .datepicker, .date-picker, .calendar-modal, .datepicker-container, .suggestion-container.mod-open, .suggestion-container.is-visible'
        )
      );
      const hasModal = nodes.some((node) => isActuallyVisible(node));
      document.body.classList.toggle('tps-context-hidden-for-modal', hasModal);
    };

    updateModalState();
    this.modalObserver = new MutationObserver(debounce(() => updateModalState(), 50, true));
    this.modalObserver.observe(document.body, { childList: true, subtree: true });
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    this.captureSyncedAppearanceValuesFromLoadedData(loaded);
    const normalizedSyncModes = this.normalizeAppearanceSyncModes();
    this.applyLocalAppearanceOverrides();
    const properties = Array.isArray(this.settings.properties) ? this.settings.properties : [];
    let migratedFolderKey = false;
    this.settings.properties = properties.map((prop: any) => {
      if (!prop || typeof prop !== 'object') return prop;
      if (prop.type !== 'folder') return prop;
      const key = String(prop.key ?? '').trim();
      if (key.toLowerCase() === 'folderpath') return prop;
      migratedFolderKey = true;
      return { ...prop, key: 'folderPath' };
    });
    const normalizedAppearance = this.normalizeAppearanceSettings();
    this.syncLocalAppearanceStorageFromSettings();
    this.refreshSyncedAppearanceValuesFromCurrentSettings();
    if (migratedFolderKey || normalizedAppearance || normalizedSyncModes) {
      await this.saveData(this.buildPersistableSettings());
      if (migratedFolderKey) {
        logger.log('[TPS GCM] Migrated folder property key to folderPath');
      }
    }
    logger.setLoggingEnabled(this.settings.enableLogging);
  }

  async saveSettings(): Promise<void> {
    logger.setLoggingEnabled(this.settings.enableLogging);
    this.normalizeAppearanceSyncModes();
    this.normalizeAppearanceSettings();
    this.syncLocalAppearanceStorageFromSettings();
    this.refreshSyncedAppearanceValuesFromCurrentSettings();
    this.applyAppearanceSettings();
    // Recompute persistent menu geometry immediately after appearance changes
    // so offsets/sliders are reflected without waiting for a layout event.
    try {
      this.persistentMenuManager?.ensureMenus();
    } catch (error) {
      logger.warn('[TPS GCM] Failed to refresh persistent menus after settings update', error);
    }
    this.debouncedSave();
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

  buildSpecialPanel(file: TFile | TFile[], options: BuildPanelOptions = {}): HTMLElement | null {
    const files = Array.isArray(file) ? file : [file];
    return this.menuController.buildSpecialPanel(files, options);
  }


  // Mobile keyboard watcher moved to PersistentMenuManager

}
