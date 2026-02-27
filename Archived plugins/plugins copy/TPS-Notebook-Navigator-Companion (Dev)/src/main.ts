import { FileView, Notice, normalizePath, Plugin, TAbstractFile, TFile } from "obsidian";
import { NotebookNavigatorCompanionSettingTab } from "./settings-tab";
import {
  createDefaultRule,
  createDefaultSortSegment,
  createDefaultSortBucket,
  DEFAULT_SETTINGS,
  HideRule,
  IconColorRule,
  NotebookNavigatorCompanionSettings,
  RuleEvaluationContext,
  SortSegmentRule,
  SortBucket
} from "./types";
import { Logger } from "./services/logger";
import { RuleEngine } from "./services/rule-engine";
import { MetadataManager } from "./services/metadata-manager";
import { SettingsManager } from "./services/settings-manager";
import { VaultWalker, VaultWalkerProgress } from "./services/vault-walker";

export default class NotebookNavigatorCompanionPlugin extends Plugin {
  settings: NotebookNavigatorCompanionSettings = DEFAULT_SETTINGS;
  private static readonly RUNTIME_STYLE_ID = "tps-nn-companion-runtime-style";

  private logger: Logger;
  private ruleEngine: RuleEngine;
  private metadataManager: MetadataManager;
  private settingsManager: SettingsManager;
  private vaultWalker: VaultWalker;
  private statusBarEl: HTMLElement | null = null;
  private runtimeStyleEl: HTMLStyleElement | null = null;
  private startupTimer: number | null = null;
  private warnedAboutSharedFields = false;

  constructor(...args: ConstructorParameters<typeof Plugin>) {
    super(...args);

    this.logger = new Logger({
      prefix: "TPS Notebook Navigator Companion",
      debugEnabled: () => this.settings.debugLogging
    });
    this.ruleEngine = new RuleEngine(this.app);
    this.metadataManager = new MetadataManager(this.app, this.logger, {
      batchSize: 5,
      queueYieldMs: 10,
      selfWriteIgnoreMs: 600
    });
    this.settingsManager = new SettingsManager(this, this.logger);
    this.vaultWalker = new VaultWalker(this.logger, {
      chunkSize: 100,
      chunkDelayMs: 10
    });
  }

  async onload(): Promise<void> {
    this.settings = await this.settingsManager.loadSettings();
    this.applyNavigatorSystemIconColorOverride();

    this.addSettingTab(new NotebookNavigatorCompanionSettingTab(this.app, this));

    this.addCommand({
      id: "apply-rules-active-file",
      name: "Apply icon/color/sort rules to active file",
      callback: async () => {
        await this.applyRulesToActiveFile(true);
      }
    });

    this.addCommand({
      id: "apply-rules-all-files",
      name: "Apply icon/color/sort rules to all markdown files",
      callback: async () => {
        await this.applyRulesToAllFiles(true);
      }
    });

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file || !this.settings.enabled || !this.settings.autoApplyOnFileOpen) {
          return;
        }

        if (!this.isMarkdownFile(file)) {
          return;
        }

        if (this.metadataManager.shouldIgnoreFileEvent(file.path)) {
          return;
        }

        if (this.shouldIgnoreFrontmatterWrite(file)) {
          return;
        }

        void this.applyRulesToFile(file, { reason: "file-open" });
        this.updateActiveViewStyle(file);
      })
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (!this.settings.enabled || !this.settings.autoApplyOnMetadataChange) {
          return;
        }

        if (!this.isMarkdownFile(file)) {
          return;
        }

        if (this.metadataManager.shouldIgnoreFileEvent(file.path)) {
          return;
        }

        if (this.shouldIgnoreFrontmatterWrite(file)) {
          return;
        }

        this.metadataManager.scheduleDebounced(file.path, this.settings.metadataDebounceMs, async () => {
          const latest = this.app.vault.getAbstractFileByPath(file.path);
          if (!(latest instanceof TFile)) {
            return;
          }

          if (!this.isMarkdownFile(latest)) {
            return;
          }

          if (this.metadataManager.shouldIgnoreFileEvent(latest.path)) {
            return;
          }

          if (this.shouldIgnoreFrontmatterWrite(latest)) {
            return;
          }

          const isController = this.isController();
          const isActive = latest === this.app.workspace.getActiveFile();

          // If Replica, only process the ACTIVE file (immediate feedback).
          // Ignore background sync churn.
          if (!isController && !isActive) {
            return;
          }


          await this.applyRulesToFile(latest, { reason: "metadata-change" });

          // Also trigger update for upstream notes (parents/projects) if they exist
          // Only Controller triggers upstream updates to avoid cascade on Replicas
          if (isController) {
            await this.triggerUpstreamUpdates(latest);
          }

          // New: Handle title -> filename sync
          await this.handleTitleSync(latest);

          // Update inline styles for the active view
          if (isActive) {
            this.updateActiveViewStyle(latest);
          }
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!this.settings.enabled || !this.isMarkdownFile(file)) {
          return;
        }

        // New: Handle filename -> title sync
        // If the filename changes, update the 'title' frontmatter (stripping date suffix)
        void this.handleFilenameUpdate(file);
      })
    );

    if (this.settings.enabled && this.settings.applyOnStartup) {
      this.startupTimer = window.setTimeout(() => {
        this.startupTimer = null;
        if (!this.settings.enabled) {
          return;
        }

        if (!this.isController()) {
          this.logger.info("Device is Replica - Skipping startup scan.");
          return;
        }

        void this.applyRulesToAllFiles(false, "startup");
      }, this.settings.startupDelayMs);
    }
  }

  onunload(): void {
    if (this.startupTimer != null) {
      window.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }

    this.metadataManager.dispose();

    if (this.statusBarEl) {
      this.statusBarEl.detach();
      this.statusBarEl = null;
    }

    if (this.runtimeStyleEl) {
      this.runtimeStyleEl.remove();
      this.runtimeStyleEl = null;
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = await this.settingsManager.loadSettings();
  }

  async saveSettings(): Promise<void> {
    this.settings = await this.settingsManager.saveSettings(this.settings);
    this.applyNavigatorSystemIconColorOverride();
  }

  createDefaultRule(): IconColorRule {
    return createDefaultRule();
  }

  createDefaultSortSegment(): SortSegmentRule {
    return createDefaultSortSegment();
  }

  createDefaultSortBucket(): SortBucket {
    return createDefaultSortBucket();
  }

  createDefaultHideRule(): HideRule {
    return {
      id: `hide-rule-${Date.now()}`,
      name: "New Hide Rule",
      enabled: true,
      match: "all",
      conditions: [],
      mode: "add",
      tagName: "hide"
    };
  }

  getRuleMatchForActiveFile(rule: IconColorRule): boolean | null {
    const active = this.app.workspace.getActiveFile();
    if (!active || !this.isMarkdownFile(active)) {
      return null;
    }

    const context = this.buildRuleContext(active, undefined);
    return this.ruleEngine.matchesRule(rule, context);
  }

  getSmartSortPreviewForActiveFile(): string | null {
    if (!this.settings.smartSort.enabled) {
      return null;
    }

    const active = this.app.workspace.getActiveFile();
    if (!active || !this.isMarkdownFile(active)) {
      return null;
    }

    const context = this.buildRuleContext(active, undefined);
    const value = this.ruleEngine.composeSortKey(this.settings.smartSort, context);
    return value || null;
  }

  async applyRulesToActiveFile(showNotice: boolean): Promise<boolean> {
    const active = this.app.workspace.getActiveFile();
    if (!active) {
      if (showNotice) {
        new Notice("No active markdown file to update.");
      }
      return false;
    }

    if (!this.isMarkdownFile(active)) {
      if (showNotice) {
        new Notice("Active file is not a markdown note.");
      }
      return false;
    }

    if (this.shouldIgnoreFrontmatterWrite(active)) {
      if (showNotice) {
        new Notice("Active file is excluded from companion frontmatter writes.");
      }
      return false;
    }

    const changed = await this.applyRulesToFile(active, { reason: "manual-active", force: true });
    if (showNotice) {
      new Notice(changed ? "Applied icon/color/sort rules to active file." : "Active file already matches current rule outputs.");
    }

    return changed;
  }

  async applyRulesToAllFiles(showNotice: boolean, reason = "manual-all"): Promise<number> {
    const files = this.app.vault.getMarkdownFiles();
    if (files.length === 0) {
      if (showNotice) {
        new Notice("No markdown files found.");
      }
      return 0;
    }

    const targetFiles = files.filter((file) => !this.shouldIgnoreFrontmatterWrite(file));
    if (targetFiles.length === 0) {
      if (showNotice) {
        new Notice("No eligible markdown files found after exclusions.");
      }
      return 0;
    }

    if (showNotice) {
      new Notice(`Applying rules to ${targetFiles.length}/${files.length} markdown files...`);
    }

    const statusEl = this.ensureStatusBar();

    const result = await this.vaultWalker.walk(
      targetFiles,
      async (file) => this.applyRulesToFile(file, { reason, force: true }),
      (progress) => this.renderProgress(statusEl, progress)
    );

    statusEl.setText("TPS NN: Idle");

    if (showNotice) {
      new Notice(`Applied rules to ${result.changed} file${result.changed === 1 ? "" : "s"}.`);
    }

    return result.changed;
  }

  private async applyRulesToFile(
    file: TFile,
    options: {
      reason: string;
      force?: boolean;
    }
  ): Promise<boolean> {
    if (!this.settings.enabled) {
      return false;
    }

    if (!this.isMarkdownFile(file)) {
      return false;
    }

    if (this.shouldIgnoreFrontmatterWrite(file)) {
      return false;
    }

    // New: Pause updates if Obsidian Sync is active to prevent conflicts
    if (!options.force && this.isObsidianSyncActive()) {
      this.logger.debug("Skipping frontmatter update during active sync");
      return false;
    }

    if (!options.force && this.metadataManager.shouldIgnoreFileEvent(file.path)) {
      return false;
    }

    const iconField = this.settings.frontmatterIconField;
    const colorField = this.settings.frontmatterColorField;

    if (iconField.toLowerCase() === colorField.toLowerCase() && !this.warnedAboutSharedFields) {
      this.warnedAboutSharedFields = true;
      this.logger.warn("Icon and color fields are identical; icon output will take precedence", {
        iconField,
        colorField
      });
    }

    // Build context with body content BEFORE the frontmatter mutation
    // This allows us to use body-based conditions in bucket matching
    const contextWithBody = await this.buildRuleContextWithBody(file, undefined);

    return this.metadataManager.queueFrontmatterUpdate(file, options.reason, (mutableFrontmatter) => {
      // Update context with the mutable frontmatter (but keep the body we already read)
      const context = {
        ...contextWithBody,
        frontmatter: mutableFrontmatter,
        tags: this.collectTagsFromCache(file, mutableFrontmatter)
      };

      const visualOutputs = this.ruleEngine.resolveVisualOutputs(this.settings.rules, context);
      const desiredIcon = visualOutputs.icon.matched
        ? visualOutputs.icon.value
        : this.settings.clearIconWhenNoMatch
          ? null
          : undefined;
      const ruleDrivenColor = visualOutputs.color.matched
        ? visualOutputs.color.value
        : this.settings.clearColorWhenNoMatch
          ? null
          : undefined;
      const desiredColor = ruleDrivenColor;
      const hasIconColorField = Object.keys(mutableFrontmatter).some(
        (existingKey) => existingKey.toLowerCase() === "iconcolor"
      );
      // Keep optional iconColor override in sync with companion rule output.
      const desiredIconColor = hasIconColorField ? desiredColor : undefined;

      const desiredSortKey = this.computeDesiredSortValue(context);
      const hideChanges = this.computeHideChanges(context);

      let changed = false;

      if (iconField.toLowerCase() === colorField.toLowerCase()) {
        const mergedVisual = desiredIcon !== undefined ? desiredIcon : desiredColor;
        changed = this.applyFrontmatterMutation(mutableFrontmatter, iconField, mergedVisual) || changed;
      } else {
        changed = this.applyFrontmatterMutation(mutableFrontmatter, iconField, desiredIcon) || changed;
        changed = this.applyFrontmatterMutation(mutableFrontmatter, colorField, desiredColor) || changed;
      }
      if (colorField.toLowerCase() !== "iconcolor") {
        changed = this.applyFrontmatterMutation(mutableFrontmatter, "iconColor", desiredIconColor) || changed;
      }

      if (desiredSortKey !== undefined) {
        changed = this.applyFrontmatterMutation(mutableFrontmatter, this.settings.smartSort.field, desiredSortKey) || changed;
      }

      if (this.applyTagMutations(mutableFrontmatter, hideChanges)) {
        changed = true;
      }

      if (changed) {
        this.logger.debug("Applied rules to file", {
          file: file.path,
          reason: options.reason,
          iconRule: visualOutputs.icon.ruleId,
          colorRule: visualOutputs.color.ruleId,
          sortField: this.settings.smartSort.enabled ? this.settings.smartSort.field : "",
          hideAdded: hideChanges.add,
          hideRemoved: hideChanges.remove
        });
      }

      return changed;
    });
  }

  private computeDesiredSortValue(context: RuleEvaluationContext): string | null | undefined {
    if (!this.settings.smartSort.enabled) {
      return undefined;
    }

    const sortKey = this.ruleEngine.composeSortKey(this.settings.smartSort, context);
    if (sortKey) {
      return sortKey;
    }

    return this.settings.smartSort.clearWhenNoMatch ? null : undefined;
  }

  private applyFrontmatterMutation(
    mutableFrontmatter: Record<string, unknown>,
    key: string,
    desiredValue: string | null | undefined
  ): boolean {
    if (desiredValue === undefined) {
      return false;
    }

    const normalizedTarget = key.toLowerCase();
    let actualKey = key;

    for (const existingKey of Object.keys(mutableFrontmatter)) {
      if (existingKey.toLowerCase() === normalizedTarget) {
        actualKey = existingKey;
        break;
      }
    }

    if (desiredValue === null) {
      if (!Object.prototype.hasOwnProperty.call(mutableFrontmatter, actualKey)) {
        return false;
      }
      delete mutableFrontmatter[actualKey];
      return true;
    }

    const currentValue = String(mutableFrontmatter[actualKey] ?? "");
    if (currentValue === desiredValue) {
      return false;
    }

    mutableFrontmatter[actualKey] = desiredValue;
    return true;
  }

  private collectTagsFromCache(file: TFile, frontmatter: Record<string, unknown> | null): string[] {
    const tags = new Set<string>();

    const cacheTags = this.app.metadataCache.getFileCache(file)?.tags ?? [];
    for (const cacheTag of cacheTags) {
      const normalized = this.normalizeTag(cacheTag.tag);
      if (normalized) {
        tags.add(normalized);
      }
    }

    if (frontmatter) {
      const fmTags = this.getFrontmatterValue(frontmatter, "tags");
      if (Array.isArray(fmTags)) {
        for (const rawTag of fmTags) {
          const normalized = this.normalizeTag(rawTag);
          if (normalized) {
            tags.add(normalized);
          }
        }
      } else if (typeof fmTags === "string") {
        for (const rawTag of fmTags.split(/[\s,]+/)) {
          const normalized = this.normalizeTag(rawTag);
          if (normalized) {
            tags.add(normalized);
          }
        }
      }
    }

    return Array.from(tags);
  }

  private normalizeTag(rawTag: unknown): string {
    const normalized = String(rawTag ?? "").trim().replace(/^#+/, "").toLowerCase();
    return normalized;
  }

  private toFrontmatterRecord(frontmatter: unknown): Record<string, unknown> | null {
    if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
      return null;
    }
    return frontmatter as Record<string, unknown>;
  }

  private getFrontmatterValue(frontmatter: Record<string, unknown>, key: string): unknown {
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      return frontmatter[key];
    }

    const normalizedTarget = key.toLowerCase();
    for (const [existingKey, value] of Object.entries(frontmatter)) {
      if (existingKey.toLowerCase() === normalizedTarget) {
        return value;
      }
    }

    return undefined;
  }


  private buildRuleContext(
    file: TFile,
    frontmatterOverride: Record<string, unknown> | null | undefined
  ): RuleEvaluationContext {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = frontmatterOverride ?? this.toFrontmatterRecord(cache?.frontmatter);

    const backlinks: string[] = [];
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    if (resolvedLinks) {
      for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
        if (Object.prototype.hasOwnProperty.call(links, file.path)) {
          backlinks.push(sourcePath);
        }
      }
    }

    return {
      file: {
        path: file.path,
        name: file.name,
        basename: file.basename,
        extension: file.extension
      },
      frontmatter,
      tags: this.collectTagsFromCache(file, frontmatter),
      backlinks
    };
  }

  private async buildRuleContextWithBody(
    file: TFile,
    frontmatterOverride: Record<string, unknown> | null | undefined
  ): Promise<RuleEvaluationContext> {
    const context = this.buildRuleContext(file, frontmatterOverride);

    // Only read body content for markdown files
    if (file.extension.toLowerCase() === "md") {
      try {
        const content = await this.app.vault.cachedRead(file);
        // Extract body (everything after frontmatter)
        const frontmatterEndMatch = content.match(/^---\n[\s\S]*?\n---\n/);
        if (frontmatterEndMatch) {
          context.body = content.slice(frontmatterEndMatch[0].length);
        } else {
          context.body = content;
        }
      } catch (error) {
        this.logger.error("Failed to read file body for rule evaluation", error, { file: file.path });
      }
    }

    return context;
  }

  /*
   * Centralized Controller Check
   * Queries 'tps-controller' plugin. Defaults to TRUE (Controller) if plugin is missing.
   */
  private isController(): boolean {
    const controllerPlugin = (this.app as any).plugins.getPlugin("tps-controller");
    if (controllerPlugin && controllerPlugin.api && typeof controllerPlugin.api.isController === "function") {
      return controllerPlugin.api.isController();
    }
    // Default to Controller if plugin is missing
    return true;
  }

  private isMarkdownFile(file: TAbstractFile): file is TFile {
    return file instanceof TFile && file.extension === "md";
  }

  private ensureStatusBar(): HTMLElement {
    if (!this.statusBarEl) {
      this.statusBarEl = this.addStatusBarItem();
    }
    return this.statusBarEl;
  }

  private renderProgress(statusEl: HTMLElement, progress: VaultWalkerProgress): void {
    statusEl.setText(`TPS NN: ${progress.processed}/${progress.total} (${progress.changed} changed)`);
  }

  log(message: string, data?: Record<string, unknown>): void {
    this.logger.debug(message, data);
  }

  private shouldIgnoreFrontmatterWrite(file: TFile): boolean {
    if (!(file instanceof TFile)) {
      return false;
    }

    const patterns = this.getFrontmatterWriteExclusionPatterns();
    if (!patterns.length) {
      return false;
    }

    const normalizedPath = this.normalizeComparablePath(file.path);
    const normalizedBasename = String(file.basename || "").trim().toLowerCase();

    for (const pattern of patterns) {
      if (this.matchesFrontmatterWriteExclusionPattern(normalizedPath, normalizedBasename, pattern)) {
        this.logger.debug("Skipping companion frontmatter write due to exclusion", {
          file: file.path,
          pattern
        });
        return true;
      }
    }

    return false;
  }

  private getFrontmatterWriteExclusionPatterns(): string[] {
    const raw = String(this.settings.frontmatterWriteExclusions || "");
    if (!raw.trim()) {
      return [];
    }

    return raw
      .split(/\r?\n|,/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  private matchesFrontmatterWriteExclusionPattern(
    normalizedPath: string,
    normalizedBasename: string,
    rawPattern: string
  ): boolean {
    const pattern = String(rawPattern || "").trim();
    if (!pattern) {
      return false;
    }

    const asLower = pattern.toLowerCase();

    if (asLower.startsWith("re:")) {
      const source = pattern.slice(3).trim();
      if (!source) {
        return false;
      }
      try {
        const regex = new RegExp(source, "i");
        return regex.test(normalizedPath) || regex.test(normalizedBasename);
      } catch {
        return false;
      }
    }

    if (asLower.startsWith("name:")) {
      const target = String(pattern.slice(5) || "").trim().toLowerCase();
      if (!target) {
        return false;
      }
      return this.matchesWildcard(target, normalizedBasename);
    }

    const pathTarget = asLower.startsWith("path:") ? pattern.slice(5).trim() : pattern;
    const hasTrailingSlash = /[\/\\]$/.test(pathTarget);
    const normalizedTarget = this.normalizeComparablePath(pathTarget);
    if (!normalizedTarget) {
      return false;
    }

    if (normalizedTarget.includes("*")) {
      return (
        this.matchesWildcard(normalizedTarget, normalizedPath) ||
        this.matchesWildcard(normalizedTarget, normalizedBasename)
      );
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
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
    return regex.test(value);
  }

  private normalizeComparablePath(value: string): string {
    if (!value || typeof value !== "string") {
      return "";
    }
    return normalizePath(value.trim())
      .replace(/^\/+/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  }

  private applyNavigatorSystemIconColorOverride(): void {
    const color = this.normalizeCssColorValue(this.settings.noteCheckboxIconColor);
    if (!color) {
      if (this.runtimeStyleEl) {
        this.runtimeStyleEl.remove();
        this.runtimeStyleEl = null;
      }
      return;
    }

    if (!this.runtimeStyleEl) {
      this.runtimeStyleEl = document.createElement("style");
      this.runtimeStyleEl.id = NotebookNavigatorCompanionPlugin.RUNTIME_STYLE_ID;
      document.head.appendChild(this.runtimeStyleEl);
    }

    this.runtimeStyleEl.textContent = `
      body {
        --nn-theme-file-task-icon-color: ${color};
      }
      /* Apply the dynamic color to various icon containers in the inline title area */
      .inline-title-icon,
      .view-header-icon,
      .obsidian-icon-folder-icon {
        color: var(--nn-active-file-color, inherit) !important;
      }
    `;
  }

  private updateActiveViewStyle(file: TFile): void {
    const activeLeaf = this.app.workspace.getLeaf(false);
    if (!activeLeaf || !(activeLeaf.view instanceof FileView) || activeLeaf.view.file !== file) {
      return;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;

    // Resolve color: iconColor > color > null
    let color = this.getFrontmatterValue(frontmatter || {}, "iconColor");
    if (!color) {
      color = this.getFrontmatterValue(frontmatter || {}, this.settings.frontmatterColorField);
    }

    const container = activeLeaf.view.containerEl;
    if (color && typeof color === "string") {
      const safeColor = this.normalizeCssColorValue(color);
      container.style.setProperty("--nn-active-file-color", safeColor);
    } else {
      container.style.removeProperty("--nn-active-file-color");
    }
  }

  private normalizeCssColorValue(value: string): string {
    return String(value ?? "")
      .replace(/[;\n\r{}<>]/g, "")
      .trim();
  }

  private computeHideChanges(context: RuleEvaluationContext): { add: string[]; remove: string[] } {
    const toAdd = new Set<string>();
    const toRemove = new Set<string>();

    for (const rule of this.settings.hideRules) {
      if (!rule.enabled) continue;
      if (this.ruleEngine.matchesRule(rule, context)) {
        const tag = this.normalizeTag(rule.tagName);
        if (!tag) continue;

        if (rule.mode === "add") {
          toAdd.add(tag);
          toRemove.delete(tag);
        } else {
          toRemove.add(tag);
          toAdd.delete(tag);
        }
      }
    }
    return { add: Array.from(toAdd), remove: Array.from(toRemove) };
  }

  private applyTagMutations(mutableFrontmatter: Record<string, unknown>, changes: { add: string[]; remove: string[] }): boolean {
    const rawTags = this.getFrontmatterValue(mutableFrontmatter, "tags");
    let currentTags: string[] = [];

    // Parse current tags from mutable frontmatter
    if (Array.isArray(rawTags)) {
      currentTags = rawTags.map(t => this.normalizeTag(t)).filter(Boolean);
    } else if (typeof rawTags === "string") {
      currentTags = rawTags.split(/[\s,]+/).map(t => this.normalizeTag(t)).filter(Boolean);
    }

    const initialSet = new Set(currentTags);
    let changed = false;

    for (const tag of changes.remove) {
      if (initialSet.delete(tag)) {
        changed = true;
      }
    }
    for (const tag of changes.add) {
      if (!initialSet.has(tag)) {
        initialSet.add(tag);
        changed = true;
      }
    }

    if (changed) {
      mutableFrontmatter["tags"] = Array.from(initialSet);
      return true;
    }

    return false;
  }

  private isObsidianSyncActive(): boolean {
    try {
      // @ts-ignore: Internal API
      const syncPlugin = this.app.internalPlugins?.getPluginById("sync");
      if (!syncPlugin || !syncPlugin.enabled) {
        return false;
      }

      // @ts-ignore: Internal API
      const instance = syncPlugin.instance;
      if (!instance) {
        return false;
      }

      // Check status if available
      if (typeof instance.getStatus === "function") {
        const status = instance.getStatus();
        // 'ready' means synced. 'paused' means paused.
        // 'syncing', 'scanning', 'connecting' imply activity.
        return status === "syncing" || status === "scanning" || status === "connecting";
      }

      return false;
    } catch (e) {
      return false;
    }
  }

  private async triggerUpstreamUpdates(file: TFile): Promise<void> {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache || !cache.frontmatter) {
      return;
    }

    const targetPaths = new Set<string>();
    const upstreamKeys = new Set(
      [...(this.settings.upstreamLinkKeys || ["parent"]), "parent"]
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean)
    );

    // 1. Check frontmatterLinks (wikilinks: key: [[Link]])
    if (cache.frontmatterLinks) {
      for (const link of cache.frontmatterLinks) {
        if (link.key && upstreamKeys.has(link.key.toLowerCase())) {
          targetPaths.add(link.link);
        }
      }
    }

    // 2. Check raw frontmatter (key: "Path/To/File" or bare string)
    // Only check keys that weren't already found as links, or check all relevant keys
    for (const key of Object.keys(cache.frontmatter)) {
      if (upstreamKeys.has(key.toLowerCase())) {
        const value = cache.frontmatter[key];
        if (typeof value === "string" && !value.includes("[[")) {
          targetPaths.add(value);
        }
      }
    }

    if (targetPaths.size === 0) {
      return;
    }

    for (const path of targetPaths) {
      const targetFile = this.app.metadataCache.getFirstLinkpathDest(path, file.path);
      if (targetFile instanceof TFile && this.isMarkdownFile(targetFile)) {
        // Schedule parent/upstream update using the same debounce mechanism
        this.metadataManager.scheduleDebounced(targetFile.path, this.settings.metadataDebounceMs, async () => {
          const current = this.app.vault.getAbstractFileByPath(targetFile.path);
          if (current instanceof TFile) {
            await this.applyRulesToFile(current, { reason: "upstream-update" });
          }
        });
      }
    }
  }

  /*
   * Filename -> Title Sync
   * Extract "clean" title from filename (remove date suffix) and update frontmatter.
   */
  private async handleFilenameUpdate(file: TFile): Promise<void> {
    const { cleanTitle } = this.parseFilenameComponents(file.basename);

    await this.metadataManager.queueFrontmatterUpdate(file, "filename-sync", (frontmatter) => {
      const currentTitle = String(frontmatter.title || "").trim();
      if (currentTitle === cleanTitle) {
        return false;
      }
      frontmatter.title = cleanTitle;
      return true;
    });
  }

  /*
   * Title -> Filename Sync
   * If frontmatter title changes, rename the file (preserving date suffix).
   */
  private async handleTitleSync(file: TFile): Promise<void> {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache || !cache.frontmatter) return;

    const desiredTitle = String(cache.frontmatter.title || "").trim();
    if (!desiredTitle) return;

    const { cleanTitle: currentClean, dateSuffix } = this.parseFilenameComponents(file.basename);

    // If title matches current filename (ignoring suffix), do nothing
    if (desiredTitle === currentClean) {
      return;
    }

    // Construct new filename: DesiredTitle + DateSuffix
    let newBasename = desiredTitle;
    if (dateSuffix) {
      newBasename = `${newBasename} ${dateSuffix}`;
    }

    // Sanitize filename
    // @ts-ignore: Internal API
    const sanitized = (this.app.vault.adapter as any).fs?.sanitize?.(newBasename) || newBasename.replace(/[\\/:]/g, "");

    // Construct full path
    const newPath = `${file.parent.path}/${sanitized}.${file.extension}`;

    // Check if changed and not existing
    if (newPath === file.path) return;
    if (await this.app.vault.adapter.exists(newPath)) {
      this.logger.warn("Skipping title sync rename: Target file already exists", { from: file.path, to: newPath });
      return;
    }

    try {
      await this.app.fileManager.renameFile(file, newPath);
      this.logger.info("Synced filename to match title", { old: file.path, new: newPath });
    } catch (error) {
      this.logger.error("Failed to rename file for title sync", error, { from: file.path, to: newPath });
    }
  }

  private parseFilenameComponents(basename: string): { cleanTitle: string; dateSuffix: string | null } {
    // Regex for date suffix: YYYY-MM-DD or YYYYMMDD at the end, optionally preceded by space
    // We assume the date is the *last* defined part.
    // Examples: "My Meeting 2023-10-27", "Notes 20231027"
    const datePattern = /\s*(\d{4}[-/]\d{2}[-/]\d{2}|\d{8})$/;
    const match = basename.match(datePattern);

    if (match) {
      const dateSuffix = match[1];
      const cleanTitle = basename.substring(0, match.index).trim();
      return { cleanTitle, dateSuffix };
    }

    return { cleanTitle: basename, dateSuffix: null };
  }
}
