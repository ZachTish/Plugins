import { MarkdownView, Notice, Platform, Plugin, TFile } from "obsidian";
import { NotebookNavigatorCompanionSettingTab } from "./settings-tab";
import {
  DEFAULT_SETTINGS,
  HideRule,
  IconColorRule,
  NotebookNavigatorCompanionSettings,
  RuleEvaluationContext,
  SortBucket,
  createDefaultRule,
  createDefaultSortBucket,
  createDefaultSortSegment,
} from "./types";
import { Logger } from "./services/logger";
import { SettingsManager } from "./services/settings-manager";
import { RuleEngine } from "./services/rule-engine";
import { MetadataManager } from "./services/metadata-manager";
import { FrontmatterWriteExclusionService } from "./services/frontmatter-write-exclusion-service";
import { RuleApplicationService } from "./services/rule-application-service";
import { TitleSyncService } from "./services/title-sync-service";
import { StyleService } from "./services/style-service";
import { VaultWalker } from "./services/vault-walker";

const ROOT_TAG_PAGE = "__nn_tags_root__";

type CompanionApi = {
  applyRulesToAllFiles: (silent?: boolean) => Promise<number>;
  applyRulesToFile: (file: TFile) => Promise<void>;
  applyRulesToActiveFile: (showNotice?: boolean) => Promise<boolean>;
  getSmartSortPreviewForActiveFile: () => string | null;
  getRuleMatchForActiveFile: (rule: IconColorRule | HideRule) => boolean | null;
};

type AutoApplyTiming = {
  quietMs: number;
  minAgeMs: number;
  maxWaitMs: number;
  pollMs: number;
};

export default class NotebookNavigatorCompanionPlugin extends Plugin {
  settings: NotebookNavigatorCompanionSettings = DEFAULT_SETTINGS;
  private readonly startupTimestamp = Date.now();
  private static readonly AUTO_APPLY_TIMINGS: Record<string, AutoApplyTiming> = {
    "startup-auto": { quietMs: 1200, minAgeMs: 1600, maxWaitMs: 8000, pollMs: 250 },
    "file-open": { quietMs: 1000, minAgeMs: 1400, maxWaitMs: 7000, pollMs: 250 },
    "metadata-change": { quietMs: 900, minAgeMs: 0, maxWaitMs: 5000, pollMs: 200 },
    "modify-save": { quietMs: 700, minAgeMs: 0, maxWaitMs: 5000, pollMs: 200 },
    "create": { quietMs: 1400, minAgeMs: 2200, maxWaitMs: 9000, pollMs: 250 },
    "rename": { quietMs: 800, minAgeMs: 0, maxWaitMs: 5000, pollMs: 200 },
  };

  logger!: Logger;
  settingsManager!: SettingsManager;
  ruleEngine!: RuleEngine;
  metadataManager!: MetadataManager;
  exclusionService!: FrontmatterWriteExclusionService;
  ruleApplicationService!: RuleApplicationService;
  titleSyncService!: TitleSyncService;
  styleService!: StyleService;
  vaultWalker!: VaultWalker;

  async onload(): Promise<void> {
    this.logger = new Logger({
      prefix: "TPS-NN",
      debugEnabled: () => this.settings.debugLogging,
    });
    this.settingsManager = new SettingsManager(this, this.logger);
    this.settings = await this.settingsManager.loadSettings();

    this.ruleEngine = new RuleEngine(this.app);
    this.metadataManager = new MetadataManager(this.app, this.logger);
    this.exclusionService = new FrontmatterWriteExclusionService(
      this.logger,
      () => this.settings,
    );
    this.ruleApplicationService = new RuleApplicationService(
      this.app,
      this.ruleEngine,
      this.metadataManager,
      this.logger,
      () => this.settings,
      this.exclusionService,
      (key) => this.isProtectedFrontmatterKey(key),
    );
    this.titleSyncService = new TitleSyncService(
      this.app,
      this.metadataManager,
      this.logger,
      () => this.settings,
      this.exclusionService,
    );
    this.styleService = new StyleService(this.app, () => this.settings);
    this.vaultWalker = new VaultWalker(this.logger);

    this.styleService.applyNavigatorSystemIconColorOverride();
    this.addSettingTab(new NotebookNavigatorCompanionSettingTab(this.app, this));
    this.registerEvents();
    this.setupPluginApi();

    if (this.settings.applyOnStartup) {
      if (this.isInMobileStartupGracePeriod()) {
        this.logger.info("Skipping startup vault scan during mobile startup grace period");
      } else {
        // Wait for the workspace (and therefore metadataCache) to be fully
        // populated before running the startup scan. Calling it directly in
        // onload() means getFileCache() returns null for most files, so rule
        // context is built with empty frontmatter/backlinks and wrong values
        // (or null clears) get written to icon/color/sort frontmatter.
        // The optional startupDelayMs is kept as an additional grace period on
        // top of onLayoutReady (e.g. for Templater to finish its own writes).
        this.app.workspace.onLayoutReady(() => {
          const delay = Math.max(0, this.settings.startupDelayMs || 0);
          if (delay > 0) {
            window.setTimeout(() => {
              void this.applyRulesToAllFiles(true, "startup-auto");
            }, delay);
          } else {
            void this.applyRulesToAllFiles(true, "startup-auto");
          }
        });
      }
    }

    this.logger.info("Notebook Navigator Companion loaded");
  }

  onunload(): void {
    this.metadataManager?.dispose();
    this.styleService?.dispose();
    delete (this as any).api;
  }

  async saveSettings(): Promise<void> {
    this.settings = await this.settingsManager.saveSettings(this.settings);
    this.styleService.applyNavigatorSystemIconColorOverride();
    const activeFile = this.getActiveMarkdownFile();
    if (activeFile) {
      this.styleService.updateActiveViewStyle(activeFile);
    }
  }

  async applyRulesToActiveFile(showNotice = false): Promise<boolean> {
    const file = this.getActiveMarkdownFile();
    if (!file) {
      if (showNotice) {
        new Notice("No active markdown file.");
      }
      return false;
    }

    const changed = await this.applyRulesToFileInternal(file, "manual-active", true);
    if (showNotice) {
      new Notice(changed ? "Companion rules applied." : "No companion rule changes.");
    }
    return changed;
  }

  async applyRulesToAllFiles(silent = false, reason = "manual-all"): Promise<number> {
    if (!this.settings.enabled) {
      if (!silent) {
        new Notice("Notebook Navigator Companion automation is disabled.");
      }
      return 0;
    }

    const files = this.app.vault.getMarkdownFiles();
    const result = await this.vaultWalker.walk(
      files,
      async (file) => this.applyRulesToFileInternal(file, reason, true),
    );

    if (!silent) {
      new Notice(`Companion processed ${result.total} files, updated ${result.changed}.`);
    }
    return result.changed;
  }

  async applyRulesToFile(file: TFile): Promise<void> {
    await this.applyRulesToFileInternal(file, "direct-file", true);
  }

  getSmartSortPreviewForActiveFile(): string | null {
    const file = this.getActiveMarkdownFile();
    if (!file) return null;
    const context = this.buildContextForFile(file, true);
    if (!context || !this.settings.smartSort.enabled) return null;
    return this.ruleEngine.composeSortKey(this.settings.smartSort, context);
  }

  createDefaultSortBucket(): SortBucket {
    return createDefaultSortBucket();
  }

  createDefaultSortSegment() {
    return createDefaultSortSegment();
  }

  createDefaultRule(): IconColorRule {
    return createDefaultRule();
  }

  createDefaultHideRule(): HideRule {
    return {
      id: `hide-rule-${Date.now()}`,
      name: "New Hide Rule",
      enabled: true,
      match: "all",
      conditions: [],
      mode: "add",
      tagName: "hide",
    };
  }

  getRuleMatchForActiveFile(rule: IconColorRule | HideRule): boolean | null {
    const file = this.getActiveMarkdownFile();
    if (!file) return null;
    const context = this.buildContextForFile(file, true);
    if (!context) return null;
    return this.ruleEngine.matchesRule(rule, context);
  }

  private registerEvents(): void {
    this.registerDomEvent(document, "click", (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const notebookNavigatorRoot = target.closest(".view-content.notebook-navigator, .notebook-navigator") as HTMLElement | null;
      if (!notebookNavigatorRoot) return;

      const isPrimaryClick = event.button === 0;
      if (!isPrimaryClick || event.defaultPrevented) return;

      const tagEl = target.closest(".nn-file-tag.nn-clickable-tag, .nn-navitem[data-nav-item-type='tag'], .nn-navitem[data-drop-zone='tag'][data-tag], [data-drop-zone='tag'][data-tag], [data-drop-zone='tag-root']") as HTMLElement | null;
      if (!tagEl) return;

      const rawTagAttr = tagEl.getAttribute("data-tag") || "";
      // The Tags section header uses data-drop-zone="tag-root" with no data-tag — detect it directly.
      const isTagRootDropZone = tagEl.getAttribute("data-drop-zone") === "tag-root";
      const rawTag =
        rawTagAttr
        || tagEl.querySelector(".nn-file-tag")?.textContent
        || tagEl.querySelector(".nn-navitem-name")?.textContent
        || tagEl.textContent
        || "";
      const normalizedTag = String(rawTag || "").replace(/^#/, "").trim().toLowerCase();
      const isRootTagsItem = isTagRootDropZone || (!rawTagAttr && normalizedTag === "tags");
      if ((!normalizedTag || normalizedTag === "__untagged__") && !isRootTagsItem) return;

      event.preventDefault();
      event.stopPropagation();
      void this.openTagCanvasForTag(isRootTagsItem ? ROOT_TAG_PAGE : normalizedTag);
    }, { capture: true });

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.styleService.updateActiveViewStyle(file);
        if (this.settings.autoApplyOnFileOpen) {
          void this.applyRulesToFileInternal(file, "file-open", false);
        }
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const activeFile = this.getActiveMarkdownFile();
        if (activeFile) {
          this.styleService.updateActiveViewStyle(activeFile);
        }
      }),
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.styleService.updateActiveViewStyle(file);

        const delay = Math.max(0, this.settings.metadataDebounceMs || 0);
        this.metadataManager.scheduleDebounced(file.path, delay, async () => {
          const activeFile = this.getActiveMarkdownFile();
          if (!activeFile || activeFile.path !== file.path) return;
          if (this.settings.autoApplyOnMetadataChange) {
            await this.applyRulesToFileInternal(file, "metadata-change", false);
          }
          if (this.settings.syncFilenameFromTitle) {
            await this.titleSyncService.handleTitleSync(file);
          }
        });
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;

        const activeFile = this.getActiveMarkdownFile();
        if (!activeFile || activeFile.path !== file.path) return;

        this.metadataManager.scheduleDebounced(`${file.path}::modify-save`, 250, async () => {
          const liveActive = this.getActiveMarkdownFile();
          if (!liveActive || liveActive.path !== file.path) return;
          await this.applyRulesToFileInternal(file, "modify-save", false);
        });
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.metadataManager.scheduleDebounced(file.path, 150, async () => {
          if (this.settings.syncTitleFromFilename) {
            await this.titleSyncService.handleFilenameUpdate(file);
          }
          await this.applyRulesToFileInternal(file, "rename", true);
        });
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        this.metadataManager.scheduleDebounced(file.path, 2200, async () => {
          await this.applyRulesToFileInternal(file, "create", true);
        });
      }),
    );
  }

  private async openTagCanvasForTag(tag: string): Promise<void> {
    const cleanTag = String(tag || "").replace(/^#/, "").trim().toLowerCase();
    if (!cleanTag) return;

    try {
      if (await this.openTagCanvasInCurrentLeaf(cleanTag)) {
        return;
      }

      const pluginManager = (this.app as any)?.plugins;
      const tagCanvas =
        pluginManager?.getPlugin?.("tps-tag-canvas") ??
        pluginManager?.plugins?.["tps-tag-canvas"];
      const tagCanvasOpenForTag = tagCanvas?.api?.openForTag;
      if (typeof tagCanvasOpenForTag === "function") {
        await Promise.resolve(tagCanvasOpenForTag.call(tagCanvas.api, cleanTag));
        return;
      }

      const notebookNavigator =
        pluginManager?.getPlugin?.("notebook-navigator") ??
        pluginManager?.plugins?.["notebook-navigator"];
      const navigateToTag = notebookNavigator?.api?.navigation?.navigateToTag;
      if (typeof navigateToTag === "function") {
        await Promise.resolve(navigateToTag.call(notebookNavigator.api.navigation, cleanTag));
        return;
      }

      new Notice("Tag Canvas and Notebook Navigator tag navigation are unavailable.");
    } catch (error) {
      this.logger.error("Failed to open tag canvas for tag", { tag: cleanTag, error });
    }
  }

  private async openTagCanvasInCurrentLeaf(tag: string): Promise<boolean> {
    try {
      const anyWindow = window as any;
      const globalApi = anyWindow?._tps_tagCanvas;
      const globalOpenForTag = globalApi?.openForTag;

      // Prefer calling the Tag Canvas public API to centralize focus/behavior.
      if (typeof globalOpenForTag === "function") {
        await Promise.resolve(globalOpenForTag.call(globalApi, tag));
        return true;
      }

      const pluginManager = (this.app as any)?.plugins;
      const tagCanvas =
        pluginManager?.getPlugin?.("tps-tag-canvas") ??
        pluginManager?.plugins?.["tps-tag-canvas"];
      const tagCanvasOpenForTag = tagCanvas?.api?.openForTag;

      if (typeof tagCanvasOpenForTag === "function") {
        await Promise.resolve(tagCanvasOpenForTag.call(tagCanvas.api, tag));
        return true;
      }

      // Fallback: if no openForTag API is available, fall back to sync->open path.
      const globalSyncForTag = globalApi?.syncForTag;
      const globalGetCanvasPath = globalApi?.getCanvasPath;
      if (typeof globalSyncForTag === "function" && typeof globalGetCanvasPath === "function") {
        await Promise.resolve(globalSyncForTag(tag));
        const canvasPath = String(globalGetCanvasPath(tag) || "").trim();
        if (!canvasPath) return false;
        const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
        if (canvasFile instanceof TFile) {
          const leaf = this.resolvePreferredContentLeaf();
          if (!leaf) return false;
          await leaf.openFile(canvasFile);
          return true;
        }
      }

      const tagCanvasSyncForTag = tagCanvas?.api?.syncForTag;
      const tagCanvasGetCanvasPath = tagCanvas?.api?.getCanvasPath;
      if (typeof tagCanvasSyncForTag === "function" && typeof tagCanvasGetCanvasPath === "function") {
        await Promise.resolve(tagCanvasSyncForTag.call(tagCanvas.api, tag));
        const canvasPath = String(tagCanvasGetCanvasPath.call(tagCanvas.api, tag) || "").trim();
        if (!canvasPath) return false;
        const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
        if (canvasFile instanceof TFile) {
          const leaf = this.resolvePreferredContentLeaf();
          if (!leaf) return false;
          await leaf.openFile(canvasFile);
          return true;
        }
      }
    } catch (error) {
      this.logger.warn("Failed opening tag canvas in current leaf", { tag, error });
    }

    return false;
  }

  private resolvePreferredContentLeaf() {
    const activeLeaf = this.app.workspace.activeLeaf;
    const activeType = activeLeaf?.view?.getViewType?.();

    if (activeLeaf && activeType !== "notebook-navigator") {
      return activeLeaf;
    }

    const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");
    if (markdownLeaves.length > 0) return markdownLeaves[0];

    const canvasLeaves = this.app.workspace.getLeavesOfType("canvas");
    if (canvasLeaves.length > 0) return canvasLeaves[0];

    const mostRecentLeaf = (this.app.workspace as any)?.getMostRecentLeaf?.();
    const mostRecentType = mostRecentLeaf?.view?.getViewType?.();
    if (mostRecentLeaf && mostRecentType !== "notebook-navigator") {
      return mostRecentLeaf;
    }

    return this.app.workspace.getLeaf("tab");
  }

  private setupPluginApi(): void {
    const api: CompanionApi = {
      applyRulesToAllFiles: (silent?: boolean) => this.applyRulesToAllFiles(!!silent),
      applyRulesToFile: (file: TFile) => this.applyRulesToFile(file),
      applyRulesToActiveFile: (showNotice?: boolean) => this.applyRulesToActiveFile(!!showNotice),
      getSmartSortPreviewForActiveFile: () => this.getSmartSortPreviewForActiveFile(),
      getRuleMatchForActiveFile: (rule: IconColorRule | HideRule) => this.getRuleMatchForActiveFile(rule),
    };

    (this as any).api = api;
  }

  private async applyRulesToFileInternal(
    file: TFile,
    reason: string,
    force: boolean,
  ): Promise<boolean> {
    if (!(file instanceof TFile) || file.extension !== "md") return false;

    const targetFile = await this.resolveStableTargetFile(file, reason);
    if (!targetFile) {
      return false;
    }

    const bypassCreationGrace =
      reason === "file-open" ||
      reason === "metadata-change" ||
      reason === "modify-save" ||
      reason === "rename" ||
      reason === "create" ||
      reason === "manual-active" ||
      reason === "direct-file";
    const changed = await this.ruleApplicationService.applyRulesToFile(targetFile, {
      reason,
      force,
      bypassCreationGrace,
    });
    this.styleService.updateActiveViewStyle(targetFile);
    return changed;
  }

  private async resolveStableTargetFile(file: TFile, reason: string): Promise<TFile | null> {
    const timing = NotebookNavigatorCompanionPlugin.AUTO_APPLY_TIMINGS[reason];
    if (!timing) {
      return this.getLiveMarkdownFile(file.path);
    }

    return this.waitForStableFile(file.path, reason, timing);
  }

  private async waitForStableFile(
    path: string,
    reason: string,
    timing: AutoApplyTiming,
  ): Promise<TFile | null> {
    let liveFile = this.getLiveMarkdownFile(path);
    if (!liveFile) return null;

    let lastSignature = this.getFileSignature(liveFile);
    let lastObservedChangeAt = Date.now() - Math.max(0, Date.now() - liveFile.stat.mtime);
    const startTime = Date.now();

    while (Date.now() - startTime <= timing.maxWaitMs) {
      liveFile = this.getLiveMarkdownFile(path);
      if (!liveFile) return null;

      const nextSignature = this.getFileSignature(liveFile);
      if (nextSignature !== lastSignature) {
        lastSignature = nextSignature;
        lastObservedChangeAt = Date.now();
      }

      const ageMs = Math.min(
        Date.now() - liveFile.stat.mtime,
        Date.now() - liveFile.stat.ctime,
      );
      const quietForMs = Date.now() - lastObservedChangeAt;

      if (ageMs >= timing.minAgeMs && quietForMs >= timing.quietMs) {
        return liveFile;
      }

      await this.sleep(timing.pollMs);
    }

    this.logger.debug("Skipped automatic rule application because the file did not settle in time", {
      file: path,
      reason,
      quietMs: timing.quietMs,
      minAgeMs: timing.minAgeMs,
      maxWaitMs: timing.maxWaitMs,
    });
    return null;
  }

  private getLiveMarkdownFile(path: string): TFile | null {
    const live = this.app.vault.getAbstractFileByPath(path);
    return live instanceof TFile && live.extension === "md" ? live : null;
  }

  private getFileSignature(file: TFile): string {
    return `${file.stat.mtime}:${file.stat.ctime}:${file.stat.size}`;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  }

  private buildContextForFile(
    file: TFile,
    includeBacklinks: boolean,
  ): RuleEvaluationContext | null {
    if (!(file instanceof TFile) || file.extension !== "md") return null;
    return this.ruleApplicationService.buildRuleContext(file, undefined, includeBacklinks);
  }

  private getActiveMarkdownFile(): TFile | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file instanceof TFile ? view.file : null;
  }

  private isProtectedFrontmatterKey(key: string): boolean {
    const normalized = String(key || "").trim().toLowerCase();
    if (!normalized) return false;

    const protectedKeys = new Set<string>([
      "externaleventid",
      "tpscalendaruid",
    ]);

    const pluginsRegistry = (this.app as any)?.plugins;
    const controller =
      pluginsRegistry?.getPlugin?.("tps-controller") ||
      pluginsRegistry?.plugins?.["tps-controller"];
    const controllerSettings = (controller as any)?.settings;
    const controllerManagedKeys = [
      controllerSettings?.eventIdKey,
      controllerSettings?.uidKey,
      controllerSettings?.titleKey,
      controllerSettings?.statusKey,
      controllerSettings?.previousStatusKey,
      controllerSettings?.startProperty,
      controllerSettings?.endProperty,
    ];

    for (const managedKey of controllerManagedKeys) {
      const candidate = String(managedKey || "").trim().toLowerCase();
      if (candidate) {
        protectedKeys.add(candidate);
      }
    }

    return protectedKeys.has(normalized);
  }

  private isInMobileStartupGracePeriod(): boolean {
    if (!Platform.isMobile) return false;
    return Date.now() - this.startupTimestamp < 45_000;
  }
}
