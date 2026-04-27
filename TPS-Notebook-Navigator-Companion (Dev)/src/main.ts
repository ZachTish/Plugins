import { MarkdownView, Menu, Notice, Platform, Plugin, TFile, WorkspaceLeaf, setIcon } from "obsidian";
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
import { RuleEngine, VisualRuleResult } from "./services/rule-engine";
import { MetadataManager } from "./services/metadata-manager";
import { FrontmatterWriteExclusionService } from "./services/frontmatter-write-exclusion-service";
import { RuleApplicationService } from "./services/rule-application-service";
import { TitleSyncService } from "./services/title-sync-service";
import { TagPageManager } from "./services/tag-page-manager";
import { PageFileTypeModal } from "./modals/page-file-type-modal";
import { PropertyPageManager } from "./services/property-page-manager";
import { StyleService } from "./services/style-service";
import { VaultWalker } from "./services/vault-walker";

const ROOT_TAG_PAGE = "__nn_tags_root__";
const UNTAGGED_TAG_PAGE = "__untagged__";

type CompanionApi = {
  applyRulesToAllFiles: (silent?: boolean) => Promise<number>;
  applyRulesToFile: (file: TFile) => Promise<void>;
  applyRulesToActiveFile: (showNotice?: boolean) => Promise<boolean>;
  resolveVisualOutputsForContext: (context: RuleEvaluationContext) => VisualRuleResult;
  getSmartSortPreviewForActiveFile: () => string | null;
  getRuleMatchForActiveFile: (rule: IconColorRule | HideRule) => boolean | null;
  tagPages: {
    openForTag: (tag: string) => Promise<void>;
    hasTagPage: (tag: string) => boolean;
    createForTag: (tag: string) => Promise<void>;
    syncForTag: (tag: string) => Promise<void>;
    getTagsInVault: () => string[];
    getTagPagePath: (tag: string) => string;
    rootTagPage: string;
  };
  propertyPages: {
    openForProperty: (propertyKey: string) => Promise<void>;
    hasPropertyPage: (propertyKey: string) => boolean;
    createForProperty: (propertyKey: string) => Promise<void>;
    syncForProperty: (propertyKey: string) => Promise<void>;
    getKnownProperties: () => string[];
    getPropertyPagePath: (propertyKey: string) => string;
  };
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
  private pendingNotebookNavigatorStatusIconContextMenu: { filePath: string; expiresAt: number } | null = null;
  private notebookNavigatorTagObserver: MutationObserver | null = null;
  private pendingTagPageMenuObserver: MutationObserver | null = null;
  private menuActionStyleEl: HTMLStyleElement | null = null;
  private refreshNotebookNavigatorTagAffordancesDebounced = () => {};
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
  tagPageManager!: TagPageManager;
  propertyPageManager!: PropertyPageManager;
  styleService!: StyleService;
  vaultWalker!: VaultWalker;

  private getGcmPlugin(): any {
    return (this.app as any)?.plugins?.getPlugin?.('tps-global-context-menu')
      ?? (this.app as any)?.plugins?.plugins?.['tps-global-context-menu']
      ?? null;
  }

  private getControllerPlugin(): any {
    return (this.app as any)?.plugins?.getPlugin?.('tps-controller')
      ?? (this.app as any)?.plugins?.plugins?.['tps-controller']
      ?? null;
  }

  private isUserInitiatedRuleReason(reason: string): boolean {
    return reason === 'manual-active'
      || reason === 'direct-file'
      || reason === 'manual-status-refresh';
  }

  private isAutomationWriteSettled(): boolean {
    const gcm = this.getGcmPlugin();
    if (typeof gcm?.isInitialSyncSettled === 'function') {
      try {
        return !!gcm.isInitialSyncSettled();
      } catch {
        // Fall through to controller API.
      }
    }

    const controllerApi = this.getControllerPlugin()?.api;
    if (typeof controllerApi?.isSyncSettled === 'function') {
      try {
        return !!controllerApi.isSyncSettled();
      } catch {
        return true;
      }
    }

    return true;
  }

  private getEffectiveSettings(): NotebookNavigatorCompanionSettings {
    const gcm = this.getGcmPlugin();
    const gcmSettings = gcm?.settings;
    if (!gcmSettings) return this.settings;
    return {
      ...this.settings,
      frontmatterIconField: String(gcmSettings.notebookNavigatorIconField || this.settings.frontmatterIconField || 'icon'),
      frontmatterColorField: String(gcmSettings.notebookNavigatorColorField || this.settings.frontmatterColorField || 'color'),
      writeBasesIconFields: gcmSettings.notebookNavigatorWriteBasesIconFields === true,
      basesIconMarkdownField: String(gcmSettings.notebookNavigatorBasesIconMarkdownField || this.settings.basesIconMarkdownField || 'iconDisplay'),
      basesIconUriField: String(gcmSettings.notebookNavigatorBasesIconUriField || this.settings.basesIconUriField || 'iconDisplayUri'),
      noteCheckboxIconColor: String(gcmSettings.notebookNavigatorNoteCheckboxIconColor || this.settings.noteCheckboxIconColor || ''),
      clearIconWhenNoMatch: gcmSettings.notebookNavigatorClearIconWhenNoMatch === true,
      clearColorWhenNoMatch: gcmSettings.notebookNavigatorClearColorWhenNoMatch === true,
      autoRemoveHiddenWhenNoMatch: gcmSettings.notebookNavigatorAutoRemoveHiddenWhenNoMatch !== false,
      frontmatterWriteExclusions: String(gcmSettings.notebookNavigatorFrontmatterWriteExclusions || this.settings.frontmatterWriteExclusions || ''),
      rules: Array.isArray(gcmSettings.notebookNavigatorRules) ? gcmSettings.notebookNavigatorRules : this.settings.rules,
      smartSort: gcmSettings.notebookNavigatorSmartSort || this.settings.smartSort,
      hideRules: Array.isArray(gcmSettings.notebookNavigatorHideRules) ? gcmSettings.notebookNavigatorHideRules : this.settings.hideRules,
    };
  }

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
      () => this.getEffectiveSettings(),
    );
    this.ruleApplicationService = new RuleApplicationService(
      this.app,
      this.ruleEngine,
      this.metadataManager,
      this.logger,
      () => this.getEffectiveSettings(),
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
    this.tagPageManager = new TagPageManager(this.app, () => this.settings);
    this.propertyPageManager = new PropertyPageManager(this.app, () => this.settings);
    this.styleService = new StyleService(this.app, () => this.getEffectiveSettings());
    this.vaultWalker = new VaultWalker(this.logger);
    this.refreshNotebookNavigatorTagAffordancesDebounced = this.debounce(() => this.refreshNotebookNavigatorTagAffordances(), 80);

    this.styleService.applyNavigatorStatusIconHoverGlow();
    this.styleService.applyNavigatorSystemIconColorOverride();
    this.ensureMenuActionStyles();
    this.addSettingTab(new NotebookNavigatorCompanionSettingTab(this.app, this));
    this.registerEvents();
    this.setupPluginApi();
    this.startNotebookNavigatorTagAffordanceObserver();

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
    this.pendingNotebookNavigatorStatusIconContextMenu = null;
    this.notebookNavigatorTagObserver?.disconnect();
    this.notebookNavigatorTagObserver = null;
    this.pendingTagPageMenuObserver?.disconnect();
    this.pendingTagPageMenuObserver = null;
    this.menuActionStyleEl?.remove();
    this.menuActionStyleEl = null;
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
    const settings = this.getEffectiveSettings();
    if (!context || !settings.smartSort.enabled) return null;
    return this.ruleEngine.composeSortKey(settings.smartSort, context);
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

  resolveVisualOutputsForContext(context: RuleEvaluationContext): VisualRuleResult {
    const settings = this.getEffectiveSettings();
    return this.ruleEngine.resolveVisualOutputs(settings.rules || [], context);
  }

  private registerEvents(): void {
    this.registerDomEvent(document, "mousedown", (event: MouseEvent) => {
      const isRightClick = event.button === 2 || (Platform.isMacOS && event.button === 0 && event.ctrlKey);
      if (!isRightClick) return;

      const target = event.target as HTMLElement | null;
      if (!target) return;

      const notebookNavigatorRoot = target.closest(".view-content.notebook-navigator, .notebook-navigator") as HTMLElement | null;
      if (!notebookNavigatorRoot) return;
      if (!this.isNotebookNavigatorStatusIconClickTarget(target, event)) return;

      const file = this.resolveNotebookNavigatorFileFromTarget(target);
      if (!(file instanceof TFile) || file.extension !== "md") return;

      this.markNotebookNavigatorStatusIconContextMenu(file.path);
    }, { capture: true });

    this.registerDomEvent(document, "click", (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const notebookNavigatorRoot = target.closest(".view-content.notebook-navigator, .notebook-navigator") as HTMLElement | null;
      if (!notebookNavigatorRoot) return;

      const isPrimaryClick = event.button === 0;
      if (!isPrimaryClick || event.defaultPrevented) return;
      if (target.closest(".tree-item-icon-collapse, .collapse-icon, .nn-navitem-chevron, [aria-label*='Collapse'], [aria-label*='Expand']")) {
        return;
      }
      if (!this.isNotebookNavigatorStatusIconClickTarget(target, event)) return;

      const file = this.resolveNotebookNavigatorFileFromTarget(target);
      if (!(file instanceof TFile) || file.extension !== "md") return;

      event.preventDefault();
      event.stopPropagation();
      void this.cycleNotebookNavigatorFileStatus(file);
    }, { capture: true });

    this.registerDomEvent(document, "contextmenu", (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const notebookNavigatorRoot = target.closest(".view-content.notebook-navigator, .notebook-navigator") as HTMLElement | null;
      if (!notebookNavigatorRoot) return;

      if (event.defaultPrevented) return;
      if (target.closest(".tree-item-icon-collapse, .collapse-icon, .nn-navitem-chevron, [aria-label*='Collapse'], [aria-label*='Expand']")) {
        return;
      }
      if (!this.isNotebookNavigatorStatusIconClickTarget(target, event)) return;

      const file = this.resolveNotebookNavigatorFileFromTarget(target);
      if (!(file instanceof TFile) || file.extension !== "md") return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.markNotebookNavigatorStatusIconContextMenu(file.path);
      this.showNotebookNavigatorStatusMenu(file, event);
    }, { capture: true });

    this.registerDomEvent(document, "click", (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const notebookNavigatorRoot = target.closest(".view-content.notebook-navigator, .notebook-navigator") as HTMLElement | null;
      if (!notebookNavigatorRoot) return;

      const isPrimaryClick = event.button === 0;
      if (!isPrimaryClick || event.defaultPrevented) return;

      // Only treat explicit tag-label/icon clicks as "open tag page".
      // Leave the rest of the row alone so Notebook Navigator's own expand/collapse
      // affordances keep working the same way folders do.
      const tagActionTarget = target.closest(
        [
          ".nn-file-tag[data-tps-tag-page='open']",
          ".nn-navitem-name[data-tps-tag-page='open']",
          ".tps-tag-page-icon",
        ].join(", "),
      ) as HTMLElement | null;
      if (!tagActionTarget) return;
      const resolvedTag = this.resolveNotebookNavigatorTagFromTarget(target);
      if (!resolvedTag) return;
      if (!this.tagPageManager.hasTagPage(resolvedTag)) return;

      event.preventDefault();
      event.stopPropagation();
      void this.openTagPageForTag(resolvedTag, { allowCreate: false });
    }, { capture: true });

    this.registerDomEvent(document, "click", (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const notebookNavigatorRoot = target.closest(".view-content.notebook-navigator, .notebook-navigator") as HTMLElement | null;
      if (!notebookNavigatorRoot) return;
      const isPrimaryClick = event.button === 0;
      if (!isPrimaryClick || event.defaultPrevented) return;
      const propertyActionTarget = target.closest([
        ".nn-navitem-name[data-tps-property-page='open']",
        ".tps-property-page-icon",
      ].join(", ")) as HTMLElement | null;
      if (!propertyActionTarget) return;
      const resolvedProperty = this.resolveNotebookNavigatorPropertyFromTarget(target);
      if (!resolvedProperty) return;
      if (!this.propertyPageManager.hasPropertyPage(resolvedProperty)) return;
      event.preventDefault();
      event.stopPropagation();
      void this.openPropertyPageForProperty(resolvedProperty, { allowCreate: false });
    }, { capture: true });

    this.registerDomEvent(document, "contextmenu", (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || event.defaultPrevented) return;

      const notebookNavigatorRoot = target.closest(".view-content.notebook-navigator, .notebook-navigator") as HTMLElement | null;
      if (!notebookNavigatorRoot) return;

      const resolvedTag = this.resolveNotebookNavigatorTagFromTarget(target);
      if (!resolvedTag) return;
      this.queueTagPageMenuAugment(resolvedTag);
    }, { capture: true });

    this.registerDomEvent(document, "contextmenu", (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || event.defaultPrevented) return;
      const notebookNavigatorRoot = target.closest(".view-content.notebook-navigator, .notebook-navigator") as HTMLElement | null;
      if (!notebookNavigatorRoot) return;
      const property = this.resolveNotebookNavigatorPropertyFromTarget(target);
      if (!property) return;
      this.queuePropertyPageMenuAugment(property);
    }, { capture: true });

    this.registerDomEvent(document, "click", (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const graphLeaf = this.resolveGraphLeaf(target);
      if (!graphLeaf) return;

      const isPrimaryClick = event.button === 0;
      if (!isPrimaryClick || event.defaultPrevented) return;

      const tag = this.extractTagFromTarget(target, graphLeaf.view.containerEl);
      if (!tag) return;
      if (!this.tagPageManager.hasTagPage(tag)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void this.openTagPageForTag(tag, { allowCreate: false });
    }, { capture: true });

    this.registerDomEvent(document, "contextmenu", (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || event.defaultPrevented) return;

      const graphLeaf = this.resolveGraphLeaf(target);
      if (!graphLeaf) return;

      const tag = this.extractTagFromTarget(target, graphLeaf.view.containerEl);
      if (!tag) return;
      this.queueTagPageMenuAugment(tag);
    }, { capture: true });

    this.registerDomEvent(document, "pointerdown", (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      const actionEl = target?.closest?.("[data-tps-tag-page-action]") as HTMLElement | null;
      if (!actionEl) return;
      const cleanTag = String(actionEl.getAttribute("data-tps-tag-page-action") || "").trim().toLowerCase();
      if (!cleanTag) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      actionEl.closest('.menu')?.remove();
      if (this.tagPageManager.hasTagPage(cleanTag)) {
        void this.openTagPageForTag(cleanTag, { allowCreate: false });
      } else {
        void this.createTagPageForTag(cleanTag);
      }
    }, { capture: true });

    this.registerDomEvent(document, "pointerdown", (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      const actionEl = target?.closest?.("[data-tps-property-page-action]") as HTMLElement | null;
      if (!actionEl) return;
      const cleanProperty = String(actionEl.getAttribute("data-tps-property-page-action") || "").trim();
      if (!cleanProperty) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      actionEl.closest('.menu')?.remove();
      if (this.propertyPageManager.hasPropertyPage(cleanProperty)) {
        void this.openPropertyPageForProperty(cleanProperty, { allowCreate: false });
      } else {
        void this.createPropertyPageForProperty(cleanProperty);
      }
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
          if (this.settings.autoApplyOnMetadataChange) {
            await this.applyRulesToFileInternal(file, "metadata-change", false);
          }
          const activeFile = this.getActiveMarkdownFile();
          if (this.settings.syncFilenameFromTitle && activeFile && activeFile.path === file.path) {
            await this.titleSyncService.handleTitleSync(file);
          }
        });
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;

        this.metadataManager.scheduleDebounced(`${file.path}::modify-save`, 250, async () => {
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

  private async openTagPageForTag(tag: string, options?: { allowCreate?: boolean }): Promise<void> {
    const cleanTag = String(tag || "").replace(/^#/, "").trim().toLowerCase();
    if (!cleanTag) return;

    const isRootTagsItem = cleanTag === ROOT_TAG_PAGE;
    const navigateNotebookNavigatorToTag = async () => {
      if (isRootTagsItem) return;
      const pluginManager = (this.app as any)?.plugins;
      const notebookNavigator =
        pluginManager?.getPlugin?.("notebook-navigator") ??
        pluginManager?.plugins?.["notebook-navigator"];
      const navigateToTag = notebookNavigator?.api?.navigation?.navigateToTag;
      if (typeof navigateToTag === "function") {
        await Promise.resolve(navigateToTag.call(notebookNavigator.api.navigation, cleanTag));
      }
    };

    try {
      const tagPageFile = options?.allowCreate === false
        ? this.tagPageManager.getTagPageFile(cleanTag)
        : await this.tagPageManager.ensureTagPage(cleanTag);
      if (tagPageFile) {
        const leaf = this.resolvePreferredContentLeaf();
        if (leaf) {
          await leaf.openFile(tagPageFile, { active: true });
          await navigateNotebookNavigatorToTag();
          return;
        }
      }

      if (options?.allowCreate === false) {
        return;
      }

      const pluginManager = (this.app as any)?.plugins;
      const notebookNavigator =
        pluginManager?.getPlugin?.("notebook-navigator") ??
        pluginManager?.plugins?.["notebook-navigator"];
      const navigateToTag = notebookNavigator?.api?.navigation?.navigateToTag;
      if (typeof navigateToTag === "function") {
        await Promise.resolve(navigateToTag.call(notebookNavigator.api.navigation, cleanTag));
        return;
      }

      new Notice("Tag pages and Notebook Navigator tag navigation are unavailable.");
    } catch (error) {
      this.logger.error("Failed to open tag page for tag", { tag: cleanTag, error });
    }
  }

  private async createTagPageForTag(tag: string): Promise<void> {
    const cleanTag = String(tag || "").replace(/^#/, "").trim().toLowerCase();
    if (!cleanTag) return;
    try {
      const selectedType = await new PageFileTypeModal(this.app, this.settings.tagPageFileType, `tag page for ${this.getTagPageDisplayLabel(cleanTag)}`).openAndWait();
      if (!selectedType) return;
      const tagPageFile = await this.tagPageManager.createTagPage(cleanTag, selectedType);
      if (!tagPageFile) return;
      this.refreshNotebookNavigatorTagAffordancesDebounced();
      const leaf = this.resolvePreferredContentLeaf();
      if (leaf) {
        await leaf.openFile(tagPageFile, { active: true });
      }
    } catch (error) {
      this.logger.error("Failed to create tag page for tag", { tag: cleanTag, error });
      new Notice(`Failed to create tag page for #${cleanTag}`);
    }
  }

  private async openPropertyPageForProperty(propertyKey: string, options?: { allowCreate?: boolean }): Promise<void> {
    const cleanProperty = String(propertyKey || "").trim();
    if (!cleanProperty) return;
    try {
      const propertyPageFile = options?.allowCreate === false
        ? this.propertyPageManager.getPropertyPageFile(cleanProperty)
        : await this.propertyPageManager.ensurePropertyPage(cleanProperty);
      if (!propertyPageFile) return;
      const leaf = this.resolvePreferredContentLeaf();
      if (leaf) {
        await leaf.openFile(propertyPageFile, { active: true });
      }
    } catch (error) {
      this.logger.error("Failed to open property page", { property: cleanProperty, error });
    }
  }

  private async createPropertyPageForProperty(propertyKey: string): Promise<void> {
    const cleanProperty = String(propertyKey || "").trim();
    if (!cleanProperty) return;
    try {
      const selectedType = await new PageFileTypeModal(this.app, this.settings.propertyPageFileType, `property page for ${cleanProperty}`).openAndWait();
      if (!selectedType) return;
      const propertyPageFile = await this.propertyPageManager.createPropertyPage(cleanProperty, selectedType);
      if (!propertyPageFile) return;
      this.refreshNotebookNavigatorTagAffordancesDebounced();
      const leaf = this.resolvePreferredContentLeaf();
      if (leaf) {
        await leaf.openFile(propertyPageFile, { active: true });
      }
    } catch (error) {
      this.logger.error("Failed to create property page", { property: cleanProperty, error });
      new Notice(`Failed to create property page for ${cleanProperty}`);
    }
  }

  private queueTagPageMenuAugment(tag: string): void {
    const cleanTag = String(tag || "").replace(/^#/, "").trim().toLowerCase();
    if (!cleanTag) return;
    this.pendingTagPageMenuObserver?.disconnect();
    this.pendingTagPageMenuObserver = new MutationObserver(() => {
      this.augmentOpenContextMenuWithTagPageAction(cleanTag);
    });
    this.pendingTagPageMenuObserver.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(() => {
      this.pendingTagPageMenuObserver?.disconnect();
      this.pendingTagPageMenuObserver = null;
    }, 1000);
    window.setTimeout(() => this.augmentOpenContextMenuWithTagPageAction(cleanTag), 0);
    window.setTimeout(() => this.augmentOpenContextMenuWithTagPageAction(cleanTag), 50);
    window.setTimeout(() => this.augmentOpenContextMenuWithTagPageAction(cleanTag), 150);
  }

  private queuePropertyPageMenuAugment(propertyKey: string): void {
    const cleanProperty = String(propertyKey || "").trim();
    if (!cleanProperty) return;
    this.pendingTagPageMenuObserver?.disconnect();
    this.pendingTagPageMenuObserver = new MutationObserver(() => {
      this.augmentOpenContextMenuWithPropertyPageAction(cleanProperty);
    });
    this.pendingTagPageMenuObserver.observe(document.body, { childList: true, subtree: true });
    window.setTimeout(() => {
      this.pendingTagPageMenuObserver?.disconnect();
      this.pendingTagPageMenuObserver = null;
    }, 1000);
    window.setTimeout(() => this.augmentOpenContextMenuWithPropertyPageAction(cleanProperty), 0);
    window.setTimeout(() => this.augmentOpenContextMenuWithPropertyPageAction(cleanProperty), 50);
    window.setTimeout(() => this.augmentOpenContextMenuWithPropertyPageAction(cleanProperty), 150);
  }


  private augmentOpenContextMenuWithTagPageAction(cleanTag: string): void {
    const menus = Array.from(document.body.querySelectorAll('.menu')) as HTMLElement[];
    const openMenu = menus.filter((menu) => menu.isConnected).at(-1);
    if (!openMenu) return;
    if (openMenu.querySelector(`[data-tps-tag-page-action="${cleanTag}"]`)) return;

    const hasPage = this.tagPageManager.hasTagPage(cleanTag);
    const label = this.getTagPageDisplayLabel(cleanTag);
    this.appendAugmentedMenuItem(openMenu, {
      actionAttr: 'data-tps-tag-page-action',
      actionValue: cleanTag,
      title: hasPage ? `Open tag page for ${label}` : `Create tag page for ${label}`,
      icon: hasPage ? 'link' : 'plus',
      preferredAfterTitles: ['Navigate to tag', 'Filter tags by selection'],
    });
    this.pendingTagPageMenuObserver?.disconnect();
    this.pendingTagPageMenuObserver = null;
  }

  private augmentOpenContextMenuWithPropertyPageAction(cleanProperty: string): void {
    const menus = Array.from(document.body.querySelectorAll('.menu')) as HTMLElement[];
    const openMenu = menus.filter((menu) => menu.isConnected).at(-1);
    if (!openMenu) return;
    if (openMenu.querySelector(`[data-tps-property-page-action="${cleanProperty}"]`)) return;

    const hasPage = this.propertyPageManager.hasPropertyPage(cleanProperty);
    this.appendAugmentedMenuItem(openMenu, {
      actionAttr: 'data-tps-property-page-action',
      actionValue: cleanProperty,
      title: hasPage ? `Open property page for ${cleanProperty}` : `Create property page for ${cleanProperty}`,
      icon: hasPage ? 'link' : 'plus',
      preferredAfterTitles: ['Rename property'],
    });
    this.pendingTagPageMenuObserver?.disconnect();
    this.pendingTagPageMenuObserver = null;
  }

  private appendAugmentedMenuItem(
    openMenu: HTMLElement,
    options: { actionAttr: string; actionValue: string; title: string; icon: string; preferredAfterTitles?: string[] },
  ): void {
    const item = this.createAugmentedMenuItem(openMenu, options);
    item.setAttr(options.actionAttr, options.actionValue);

    const preferredAnchor = this.findMenuItemByTitle(openMenu, options.preferredAfterTitles || []);
    if (preferredAnchor?.parentElement === openMenu) {
      preferredAnchor.insertAdjacentElement('afterend', item);
      return;
    }

    const lastElement = openMenu.lastElementChild as HTMLElement | null;
    if (lastElement && !lastElement.classList.contains('menu-separator')) {
      openMenu.createDiv({ cls: 'menu-separator' });
    }
    openMenu.appendChild(item);
  }

  private createAugmentedMenuItem(
    openMenu: HTMLElement,
    options: { title: string; icon: string },
  ): HTMLElement {
    const template = openMenu.querySelector('.menu-item') as HTMLElement | null;
    const item = (template?.cloneNode(true) as HTMLElement | null) ?? createDiv({ cls: 'menu-item' });
    item.classList.add('tps-nn-menu-action');
    item.removeClass('is-disabled');
    item.removeClass('is-label');
    item.removeAttribute('data-section');
    item.setAttr('role', 'menuitem');
    item.tabIndex = 0;

    const iconEl = item.querySelector('.menu-item-icon') as HTMLElement | null ?? item.createDiv({ cls: 'menu-item-icon' });
    iconEl.empty();
    setIcon(iconEl, options.icon);

    const titleEl = item.querySelector('.menu-item-title') as HTMLElement | null ?? item.createDiv({ cls: 'menu-item-title' });
    titleEl.setText(options.title);
    titleEl.style.pointerEvents = 'none';
    iconEl.style.pointerEvents = 'none';

    const subtitleEl = item.querySelector('.menu-item-subtitle') as HTMLElement | null;
    subtitleEl?.remove();

    const commandEl = item.querySelector('.menu-item-command') as HTMLElement | null;
    if (commandEl) {
      commandEl.empty();
      commandEl.style.pointerEvents = 'none';
    }

    item.querySelectorAll('.menu-item-checkmark, .menu-item-icon svg').forEach((node) => {
      if (node instanceof HTMLElement && node !== iconEl && !iconEl.contains(node)) {
        node.remove();
      }
    });

    return item;
  }

  private findMenuItemByTitle(openMenu: HTMLElement, candidates: string[]): HTMLElement | null {
    for (const candidate of candidates) {
      const normalizedCandidate = candidate.trim().toLowerCase();
      const items = Array.from(openMenu.querySelectorAll('.menu-item')) as HTMLElement[];
      for (const item of items) {
        const title = item.querySelector('.menu-item-title')?.textContent?.trim().toLowerCase() || '';
        if (title === normalizedCandidate) {
          return item;
        }
      }
    }
    return null;
  }

  private ensureMenuActionStyles(): void {
    if (this.menuActionStyleEl) return;
    this.menuActionStyleEl = document.createElement('style');
    this.menuActionStyleEl.id = 'tps-nn-menu-action-style';
    this.menuActionStyleEl.textContent = `
      .menu .menu-item.tps-nn-menu-action {
        cursor: pointer;
        pointer-events: auto;
      }
      .menu .menu-item.tps-nn-menu-action.tps-nn-menu-action-hover,
      .menu .menu-item.tps-nn-menu-action:hover,
      .menu .menu-item.tps-nn-menu-action:focus {
        background-color: var(--background-modifier-hover);
      }
    `;
    document.head.appendChild(this.menuActionStyleEl);
  }

  private showTagPageMenu(tag: string, event: MouseEvent): void {
    const cleanTag = String(tag || "").replace(/^#/, "").trim().toLowerCase();
    if (!cleanTag) return;
    const hasPage = this.tagPageManager.hasTagPage(cleanTag);
    const label = this.getTagPageDisplayLabel(cleanTag);
    const menu = new Menu();
    if (hasPage) {
      menu.addItem((item) =>
        item.setTitle(`Open tag page for ${label}`).setIcon("link").onClick(() => {
          void this.openTagPageForTag(cleanTag, { allowCreate: false });
        }),
      );
    } else {
      menu.addItem((item) =>
        item.setTitle(`Create tag page for ${label}`).setIcon("plus").onClick(() => {
          void this.createTagPageForTag(cleanTag);
        }),
      );
    }
    menu.showAtPosition({ x: event.pageX, y: event.pageY });
  }

  private resolveNotebookNavigatorTagFromTarget(target: HTMLElement): string | null {
    if (target.closest(".tree-item-icon-collapse, .collapse-icon, .nn-navitem-chevron, [aria-label*='Collapse'], [aria-label*='Expand']")) {
      return null;
    }

    const tagEl = target.closest(".nn-file-tag, .nn-navitem[data-nav-item-type='tag'], .nn-navitem[data-drop-zone='tag'][data-tag], [data-drop-zone='tag'][data-tag], [data-drop-zone='tag-root']") as HTMLElement | null;
    if (!tagEl) return null;

    const rawTagAttr = tagEl.getAttribute("data-tag")
      || tagEl.closest("[data-tag]")?.getAttribute("data-tag")
      || "";
    const isTagRootDropZone = tagEl.getAttribute("data-drop-zone") === "tag-root";
    const rawTag =
      rawTagAttr
      || tagEl.querySelector(".nn-file-tag")?.textContent
      || tagEl.querySelector(".nn-navitem-name")?.textContent
      || tagEl.closest(".nn-navitem")?.querySelector(".nn-navitem-name")?.textContent
      || tagEl.textContent
      || "";
    const normalizedTag = String(rawTag || "")
      .replace(/^#/, "")
      .replace(/\s+\d+$/, "")
      .trim()
      .toLowerCase();
    const isRootTagsItem = isTagRootDropZone || (!rawTagAttr && normalizedTag === "tags");
    if (!normalizedTag && !isRootTagsItem) return null;
    if (normalizedTag === "untagged" || normalizedTag === UNTAGGED_TAG_PAGE) {
      return UNTAGGED_TAG_PAGE;
    }
    return isRootTagsItem ? ROOT_TAG_PAGE : normalizedTag;
  }

  private getTagPageDisplayLabel(tag: string): string {
    const cleanTag = String(tag || "").replace(/^#/, "").trim().toLowerCase();
    if (cleanTag === ROOT_TAG_PAGE) return "Tags";
    if (cleanTag === UNTAGGED_TAG_PAGE) return "Untagged";
    return `#${cleanTag}`;
  }

  private resolveNotebookNavigatorPropertyFromTarget(target: HTMLElement): string | null {
    const row = target.closest(".nn-navitem[data-nav-item-type='property'], .nn-navitem[data-drop-zone='property']") as HTMLElement | null;
    if (!row) return null;
    const raw = row.getAttribute("data-node-id")
      || row.getAttribute("data-property")
      || row.dataset.nodeId
      || row.dataset.property
      || row.querySelector(".nn-navitem-name")?.textContent
      || row.textContent
      || "";
    const normalized = String(raw || "").replace(/\s+\d+$/, "").trim();
    return normalized || null;
  }

  private isSidebarLeaf(leaf: WorkspaceLeaf | null | undefined): boolean {
    const container = (leaf as any)?.containerEl as HTMLElement | undefined;
    if (!container) return false;
    return !!container.closest('.workspace-sidedock, .workspace-split.mod-left-split, .workspace-split.mod-right-split');
  }

  private startNotebookNavigatorTagAffordanceObserver(): void {
    const kick = () => this.refreshNotebookNavigatorTagAffordancesDebounced();
    this.app.workspace.onLayoutReady(() => kick());
    window.setTimeout(kick, 250);
    window.setTimeout(kick, 1200);
    this.notebookNavigatorTagObserver = new MutationObserver(() => kick());
    this.notebookNavigatorTagObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
    this.register(() => {
      this.notebookNavigatorTagObserver?.disconnect();
      this.notebookNavigatorTagObserver = null;
    });
  }

  private refreshNotebookNavigatorTagAffordances(): void {
    const tagRows = Array.from(document.querySelectorAll(
      ".notebook-navigator .nn-navitem[data-nav-item-type='tag'], .notebook-navigator .nn-navitem[data-drop-zone='tag'][data-tag], .notebook-navigator [data-drop-zone='tag-root'], .view-content.notebook-navigator .nn-navitem[data-nav-item-type='tag'], .view-content.notebook-navigator .nn-navitem[data-drop-zone='tag'][data-tag], .view-content.notebook-navigator [data-drop-zone='tag-root']"
    )) as HTMLElement[];
    const tagLabels = Array.from(document.querySelectorAll(
      ".notebook-navigator .nn-file-tag, .view-content.notebook-navigator .nn-file-tag"
    )) as HTMLElement[];

    const elements = new Set<HTMLElement>([...tagRows, ...tagLabels]);
    for (const el of elements) {
      const tag = this.resolveNotebookNavigatorTagFromTarget(el);
      if (!tag) continue;
      const tagPageState = this.tagPageManager.hasTagPage(tag) ? "open" : "false";
      const isClickable = tagPageState === "open";
      el.setAttr("data-tps-tag-page", tagPageState);
      const row = el.closest(".nn-navitem[data-nav-item-type='tag'], .nn-navitem[data-drop-zone='tag'][data-tag], [data-drop-zone='tag-root']") as HTMLElement | null;
      row?.setAttr("data-tps-tag-page", tagPageState);
      el.classList.toggle("nn-file-property-link", isClickable);
      const nameEl = row?.querySelector('.nn-navitem-name') as HTMLElement | null;
      nameEl?.classList.toggle('nn-clickable-tag', isClickable);
      nameEl?.setAttr('data-tps-tag-page', tagPageState);
      if (isClickable) {
        el.style.removeProperty("cursor");
        el.style.removeProperty("text-decoration");
        row?.style.removeProperty("cursor");
        row?.style.removeProperty("text-decoration");
        nameEl?.style.removeProperty('cursor');
        nameEl?.style.removeProperty('text-decoration');
      } else {
        el.style.cursor = "default";
        el.style.textDecoration = "none";
        row?.style.setProperty("cursor", "default", "important");
        row?.style.setProperty("text-decoration", "none", "important");
        nameEl?.style.setProperty('cursor', 'default', 'important');
        nameEl?.style.setProperty('text-decoration', 'none', 'important');
      }
      if (!isClickable && el.classList.contains("nn-file-tag")) {
        el.style.setProperty("cursor", "default", "important");
        el.style.setProperty("text-decoration", "none", "important");
      }
    }

    const propertyRows = Array.from(document.querySelectorAll(
      ".notebook-navigator .nn-navitem[data-nav-item-type='property'], .notebook-navigator .nn-navitem[data-drop-zone='property'], .view-content.notebook-navigator .nn-navitem[data-nav-item-type='property'], .view-content.notebook-navigator .nn-navitem[data-drop-zone='property']"
    )) as HTMLElement[];
    for (const row of propertyRows) {
      const property = this.resolveNotebookNavigatorPropertyFromTarget(row);
      if (!property) continue;
      const propertyPageState = this.propertyPageManager.hasPropertyPage(property) ? "open" : "false";
      const isClickable = propertyPageState === "open";
      row.setAttr("data-tps-property-page", propertyPageState);
      const nameEl = row.querySelector('.nn-navitem-name') as HTMLElement | null;
      nameEl?.classList.toggle('nn-clickable-property', isClickable);
      nameEl?.setAttr('data-tps-property-page', propertyPageState);
    }
  }

  private debounce(fn: () => void, waitMs: number): () => void {
    let timer: number | null = null;
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        timer = null;
        fn();
      }, waitMs);
    };
  }

  private resolvePreferredContentLeaf() {
    const activeLeaf = this.app.workspace.activeLeaf;
    const activeType = activeLeaf?.view?.getViewType?.();
    const disallowedTypes = new Set(["notebook-navigator", "graph", "localgraph"]);

    if (activeLeaf && !disallowedTypes.has(String(activeType || "")) && !this.isSidebarLeaf(activeLeaf)) {
      return activeLeaf;
    }

    const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");
    const contentMarkdownLeaf = markdownLeaves.find((leaf) => !this.isSidebarLeaf(leaf));
    if (contentMarkdownLeaf) return contentMarkdownLeaf;

    const canvasLeaves = this.app.workspace.getLeavesOfType("canvas");
    const contentCanvasLeaf = canvasLeaves.find((leaf) => !this.isSidebarLeaf(leaf));
    if (contentCanvasLeaf) return contentCanvasLeaf;

    const mostRecentLeaf = (this.app.workspace as any)?.getMostRecentLeaf?.();
    const mostRecentType = mostRecentLeaf?.view?.getViewType?.();
    if (mostRecentLeaf && !disallowedTypes.has(String(mostRecentType || "")) && !this.isSidebarLeaf(mostRecentLeaf)) {
      return mostRecentLeaf;
    }

    return this.app.workspace.getLeaf("tab");
  }

  private resolveGraphLeaf(target: Element): WorkspaceLeaf | null {
    for (const type of ["graph", "localgraph"] as const) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const workspaceLeaf = leaf as WorkspaceLeaf;
        const container = workspaceLeaf.view?.containerEl;
        if (container instanceof HTMLElement && container.contains(target)) {
          return workspaceLeaf;
        }
      }
    }

    return null;
  }

  private extractTagFromTarget(target: Element, boundary: HTMLElement): string | null {
    let current: Element | null = target;
    while (current && current !== boundary) {
      const tag = this.extractTagText(current) ?? this.extractTagFromNodeGroup(current);
      if (tag) return tag;
      current = current.parentElement;
    }

    return this.extractTagText(boundary) ?? this.extractTagFromNodeGroup(boundary);
  }

  private extractTagText(node: Element): string | null {
    return this.matchTag(node.textContent);
  }

  private extractTagFromNodeGroup(node: Element): string | null {
    const graphNode =
      node.closest("g.node, g[class*='node'], .graph-node, .node, [class*='graph-node']");
    if (!graphNode) return null;

    const directText = this.matchTag(graphNode.textContent);
    if (directText) return directText;

    const labelEl = graphNode.querySelector("text, title, [aria-label], [data-path], [data-id]");
    if (!labelEl) return null;

    const attrText =
      labelEl.getAttribute("aria-label")
      ?? labelEl.getAttribute("data-path")
      ?? labelEl.getAttribute("data-id")
      ?? labelEl.textContent;
    return this.matchTag(attrText);
  }

  private matchTag(raw: string | null | undefined): string | null {
    const text = String(raw ?? "").trim();
    if (!text || text.length > 256) return null;

    const exact = text.match(/^#([^\s#][^\s]*)$/);
    if (exact) return exact[1];

    const embedded = text.match(/(?:^|\s)#([A-Za-z0-9/_-]+)(?:$|\s)/);
    if (embedded) return embedded[1];

    return null;
  }

  private setupPluginApi(): void {
    const tagPages = {
      openForTag: (tag: string) => this.openTagPageForTag(tag),
      hasTagPage: (tag: string) => this.tagPageManager.hasTagPage(tag),
      createForTag: (tag: string) => this.createTagPageForTag(tag),
      syncForTag: async (tag: string) => {
        await this.tagPageManager.ensureTagPage(tag);
      },
      getTagsInVault: () => this.tagPageManager.getAllTags(),
      getTagPagePath: (tag: string) => this.tagPageManager.getExistingTagPagePath(tag),
      rootTagPage: ROOT_TAG_PAGE,
    };

    const propertyPages = {
      openForProperty: (propertyKey: string) => this.openPropertyPageForProperty(propertyKey),
      hasPropertyPage: (propertyKey: string) => this.propertyPageManager.hasPropertyPage(propertyKey),
      createForProperty: (propertyKey: string) => this.createPropertyPageForProperty(propertyKey),
      syncForProperty: async (propertyKey: string) => {
        await this.propertyPageManager.ensurePropertyPage(propertyKey);
      },
      getKnownProperties: () => this.propertyPageManager.getKnownProperties(),
      getPropertyPagePath: (propertyKey: string) => this.propertyPageManager.getExistingPropertyPagePath(propertyKey),
    };

    const api: CompanionApi = {
      applyRulesToAllFiles: (silent?: boolean) => this.applyRulesToAllFiles(!!silent),
      applyRulesToFile: (file: TFile) => this.applyRulesToFile(file),
      applyRulesToActiveFile: (showNotice?: boolean) => this.applyRulesToActiveFile(!!showNotice),
      resolveVisualOutputsForContext: (context: RuleEvaluationContext) => this.resolveVisualOutputsForContext(context),
      getSmartSortPreviewForActiveFile: () => this.getSmartSortPreviewForActiveFile(),
      getRuleMatchForActiveFile: (rule: IconColorRule | HideRule) => this.getRuleMatchForActiveFile(rule),
      tagPages,
      propertyPages,
    };

    (this as any).api = api;
  }

  private markNotebookNavigatorStatusIconContextMenu(filePath: string, ttlMs = 1200): void {
    const normalizedPath = String(filePath || "").trim();
    if (!normalizedPath) return;

    this.pendingNotebookNavigatorStatusIconContextMenu = {
      filePath: normalizedPath,
      expiresAt: Date.now() + Math.max(250, ttlMs),
    };
  }

  shouldSuppressNotebookNavigatorStatusIconContextMenu(filePath?: string): boolean {
    const pending = this.pendingNotebookNavigatorStatusIconContextMenu;
    if (!pending) return false;

    if (Date.now() > pending.expiresAt) {
      this.pendingNotebookNavigatorStatusIconContextMenu = null;
      return false;
    }

    if (filePath) {
      return pending.filePath === String(filePath || "").trim();
    }

    return true;
  }

  private async applyRulesToFileInternal(
    file: TFile,
    reason: string,
    force: boolean,
  ): Promise<boolean> {
    if (!(file instanceof TFile) || file.extension !== "md") return false;
    if (!this.isUserInitiatedRuleReason(reason) && !this.isAutomationWriteSettled()) {
      this.logger.debug("Skipping companion auto-write until vault sync settles", { file: file.path, reason });
      return false;
    }

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

  private isNotebookNavigatorStatusIconClickTarget(target: HTMLElement, event?: MouseEvent): boolean {
    const row = target.closest(
      ".nn-file[data-path], .nn-navitem[data-path][data-nav-item-type='note'], .nn-navitem[data-path][data-nav-item-type='file']",
    ) as HTMLElement | null;
    if (!row) return false;

    if (target.closest(".nn-file-tag, .nn-clickable-tag, .nn-navitem-name, input, button, a")) {
      return false;
    }

    const iconSlot = row.querySelector(".nn-file-icon-slot") as HTMLElement | null;
    if (event && iconSlot) {
      const rect = iconSlot.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        return true;
      }
    }

    return !!target.closest(
      [
        ".nn-file-icon",
        ".nn-file-icon-slot",
        ".nn-navitem-icon",
        ".nn-item-icon",
        ".nn-file-leading",
        ".nn-navitem-leading",
        ".nn-file svg",
        ".nn-navitem svg",
        ".nn-file .svg-icon",
        ".nn-navitem .svg-icon",
      ].join(", "),
    );
  }

  private resolveNotebookNavigatorFileFromTarget(target: HTMLElement): TFile | null {
    const row = target.closest(
      ".nn-file[data-path], .nn-navitem[data-path][data-nav-item-type='note'], .nn-navitem[data-path][data-nav-item-type='file']",
    ) as HTMLElement | null;
    if (!row) return null;

    const rawPath = row.getAttribute("data-path")
      || row.dataset.path
      || row.dataset.filePath
      || row.dataset.filepath
      || "";
    const path = String(rawPath || "").trim();
    if (!path) return null;

    const direct = this.app.vault.getAbstractFileByPath(path);
    if (direct instanceof TFile) return direct;

    const resolved = this.app.metadataCache.getFirstLinkpathDest(path, "");
    return resolved instanceof TFile ? resolved : null;
  }

  private getStatusFieldKey(): string {
    const pluginsRegistry = (this.app as any)?.plugins;
    const controller =
      pluginsRegistry?.getPlugin?.("tps-controller") ||
      pluginsRegistry?.plugins?.["tps-controller"];
    const controllerKey = String((controller as any)?.settings?.statusKey || "").trim();
    return controllerKey || "status";
  }

  private getStatusCycleOptions(): string[] {
    const fallback = ["open", "working", "blocked", "wont-do", "complete"];
    const pluginsRegistry = (this.app as any)?.plugins;
    const gcm =
      pluginsRegistry?.getPlugin?.("tps-global-context-menu") ||
      pluginsRegistry?.plugins?.["tps-global-context-menu"];
    const properties = Array.isArray((gcm as any)?.settings?.properties)
      ? (gcm as any).settings.properties
      : [];
    const statusProperty = properties.find((property: any) => {
      const id = String(property?.id || "").trim().toLowerCase();
      const key = String(property?.key || "").trim().toLowerCase();
      return id === "status" || key === "status" || key === this.getStatusFieldKey().toLowerCase();
    });
    const options = Array.isArray(statusProperty?.options)
      ? statusProperty.options.map((value: unknown) => String(value || "").trim()).filter(Boolean)
      : [];
    return options.length > 0 ? options : fallback;
  }

  private getConfiguredStatusClickFlow(): string[] {
    const rawFlow = Array.isArray(this.settings.statusClickFlow)
      ? this.settings.statusClickFlow
      : [];

    const flow: string[] = [];
    const seen = new Set<string>();
    for (const value of rawFlow) {
      const trimmed = String(value || "").trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      flow.push(trimmed);
    }
    return flow;
  }

  private getNotebookNavigatorStatusMenuOptions(): string[] {
    const configuredFlow = this.getConfiguredStatusClickFlow();
    return configuredFlow.length > 0 ? configuredFlow : this.getStatusCycleOptions();
  }

  private showNotebookNavigatorStatusMenu(file: TFile, event: MouseEvent): void {
    const statusKey = this.getStatusFieldKey();
    const cache = this.app.metadataCache.getFileCache(file);
    const currentRaw = this.getFrontmatterValueCaseInsensitive((cache?.frontmatter || {}) as Record<string, unknown>, statusKey);
    const current = String(currentRaw || "").trim();
    const currentLower = current.toLowerCase();
    const options = this.getNotebookNavigatorStatusMenuOptions();
    if (options.length === 0) return;

    const menu = new Menu();
    for (const option of options) {
      const normalizedOption = option.toLowerCase();
      menu.addItem((item) => {
        item
          .setTitle(option)
          .setChecked(normalizedOption === currentLower)
          .onClick(async () => {
            const changed = await this.metadataManager.queueFrontmatterUpdate(file, "nn-icon-status-menu", (frontmatter) => {
              return this.setFrontmatterValueCaseInsensitive(frontmatter, statusKey, option);
            });
            if (!changed) return;

            await this.applyRulesToFileInternal(file, "manual-status-refresh", true);
            this.styleService.updateActiveViewStyle(file);
          });
      });
    }

    menu.showAtMouseEvent(event);
  }

  private getFrontmatterValueCaseInsensitive(frontmatter: Record<string, unknown> | null | undefined, key: string): unknown {
    if (!frontmatter || typeof frontmatter !== "object") return undefined;
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      return frontmatter[key];
    }
    const normalizedTarget = String(key || "").trim().toLowerCase();
    for (const [existingKey, value] of Object.entries(frontmatter)) {
      if (existingKey.toLowerCase() === normalizedTarget) {
        return value;
      }
    }
    return undefined;
  }

  private setFrontmatterValueCaseInsensitive(frontmatter: Record<string, unknown>, key: string, value: string): boolean {
    const normalizedTarget = String(key || "").trim().toLowerCase();
    if (!normalizedTarget) return false;

    const matchingKeys = Object.keys(frontmatter).filter(
      (existingKey) => existingKey.toLowerCase() === normalizedTarget,
    );

    let changed = false;
    // Remove ALL case-variant duplicates first to prevent duplicate keys
    for (const existingKey of matchingKeys) {
      delete frontmatter[existingKey];
      changed = true;
    }

    // Set the canonical key
    frontmatter[key] = value;
    return changed || matchingKeys.length === 0;
  }

  private async cycleNotebookNavigatorFileStatus(file: TFile): Promise<void> {
    const statusKey = this.getStatusFieldKey();
    const cache = this.app.metadataCache.getFileCache(file);
    const currentRaw = this.getFrontmatterValueCaseInsensitive((cache?.frontmatter || {}) as Record<string, unknown>, statusKey);
    const current = String(currentRaw || "").trim();
    const currentLower = current.toLowerCase();

    const configuredFlow = this.getConfiguredStatusClickFlow();
    const cycle = configuredFlow.length > 0 ? configuredFlow : this.getStatusCycleOptions();
    if (cycle.length === 0) return;

    let nextStatus: string | null = null;
    if (configuredFlow.length > 0) {
      const normalizedFlow = configuredFlow.map((value) => value.toLowerCase());
      const currentIndex = normalizedFlow.indexOf(currentLower);
      if (currentIndex >= 0) {
        nextStatus = configuredFlow[(currentIndex + 1) % configuredFlow.length] ?? null;
      } else if (!current) {
        nextStatus = configuredFlow[0] ?? null;
      } else {
        return;
      }
    } else {
      const normalizedCycle = cycle.map((value) => value.toLowerCase());
      const currentIndex = normalizedCycle.indexOf(currentLower);
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % cycle.length : 0;
      nextStatus = cycle[nextIndex] ?? null;
    }

    if (!nextStatus || nextStatus.trim().toLowerCase() === currentLower) {
      return;
    }

    const resolvedNextStatus = nextStatus;
    const changed = await this.metadataManager.queueFrontmatterUpdate(file, "nn-icon-status-cycle", (frontmatter) => {
      return this.setFrontmatterValueCaseInsensitive(frontmatter, statusKey, resolvedNextStatus);
    });
    if (!changed) return;

    await this.applyRulesToFileInternal(file, "manual-status-refresh", true);
    this.styleService.updateActiveViewStyle(file);
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
