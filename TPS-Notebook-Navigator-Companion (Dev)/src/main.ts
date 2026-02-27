import { FileView, Notice, normalizePath, Plugin, TAbstractFile, TFile } from "obsidian";
import { NotebookNavigatorCompanionSettingTab } from "./settings-tab";
import {
  createDefaultRule,
  createDefaultSortSegment,
  createDefaultSortBucket,
  DEFAULT_SETTINGS,
  HideRule,
  IconColorRule,
  RuleCondition,
  RuleConditionSource,
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
  private static readonly PROTECTED_FRONTMATTER_KEYS = new Set([
    "externaleventid",
    "tpscalendaruid"
  ]);

  private logger: Logger;
  private ruleEngine: RuleEngine;
  private metadataManager: MetadataManager;
  private settingsManager: SettingsManager;
  private vaultWalker: VaultWalker;
  private statusBarEl: HTMLElement | null = null;
  private runtimeStyleEl: HTMLStyleElement | null = null;
  // startupTimer removed — startup scan is handled by TPS-Controller.
  private warnedAboutSharedFields = false;
  private deviceRoleManager: any = null; // Connected from Controller API

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

    // Get device role from Controller plugin if available
    // This allows us to skip processing on Controller (which handles vault-wide scans)
    try {
      const controllerPlugin = (this.app as any).plugins?.getPlugin?.("tps-controller");
      if (controllerPlugin?.api) {
        this.deviceRoleManager = {
          isController: () => controllerPlugin.api.getRole() === "controller"
        };
        this.logger.debug("Connected to Controller for device role detection");
      }
    } catch (error) {
      this.logger.debug("Could not connect to Controller (not critical)", error);
    }

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

          // Process ALL metadata changes on User devices to support bulk edits (GCM, NN drag-drop).
          // Safety: MetadataManager's selfWrites tracking prevents infinite loops (600ms)
          // Safety: Debouncing coalesces rapid changes (350ms default)
          // Safety: Sync detection skips writes during active Obsidian Sync
          const isController = this.deviceRoleManager?.isController?.() ?? false;
          if (isController) {
            // Controller doesn't process individual file changes - only vault-wide scans
            return;
          }

          // User devices only process the active file and files directly linked to it.
          if (!this.shouldProcessRealtimeFile(latest)) {
            return;
          }

          await this.applyRulesToFile(latest, { reason: "metadata-change" });

          // upstream updates removed — handled by TPS-Controller.

          // New: Handle title -> filename sync
          if (this.settings.syncFilenameFromTitle) {
            await this.handleTitleSync(latest);
          }

          // Update inline styles for the active view (only if this is the active file)
          const isActive = latest === this.app.workspace.getActiveFile();
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
        if (this.shouldIgnoreFrontmatterWrite(file)) {
          return;
        }

        // New: Handle filename -> title sync
        // If the filename changes, update the 'title' frontmatter (stripping date suffix)
        if (this.settings.syncTitleFromFilename) {
          void this.handleFilenameUpdate(file);
        }
      })
    );

    // Listen for bulk edits from Global Context Menu
    // This provides immediate styling updates for all bulk-edited files
    this.registerEvent(
      (this.app.workspace as any).on('tps-gcm-files-updated', async (paths: string[]) => {
        if (!this.settings.enabled || !Array.isArray(paths) || paths.length === 0) {
          return;
        }

        this.logger.info(`Processing ${paths.length} files from GCM bulk edit`, {
          reason: "gcm-bulk-edit"
        });

        // Process each file from the bulk edit
        for (const path of paths) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile) || !this.isMarkdownFile(file)) {
            continue;
          }

          if (this.shouldIgnoreFrontmatterWrite(file)) {
            continue;
          }
          if (!this.shouldProcessRealtimeFile(file)) {
            continue;
          }

          // Apply styling rules immediately
          // Note: MetadataManager will dedupe if metadata-change event also fired
          await this.applyRulesToFile(file, {
            reason: "gcm-bulk-edit",
            force: false  // Still respect debounce and sync detection
          });
        }

        this.logger.debug(`Completed GCM bulk edit processing: ${paths.length} files`);
      })
    );

    // Startup scan removed — handled by TPS-Controller.

    // Expose API for Controller
    (this as any).api = {
      applyRulesToAllFiles: (silent?: boolean) => this.applyRulesToAllFiles(!silent),
      applyRulesToFile: (file: TFile) => this.applyRulesToFile(file, { reason: "controller" }),
    };
  }

  onunload(): void {
    // startupTimer removed.
    delete (this as any).api;

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

    // Removed Obsidian Sync check as it caused unresponsiveness during direct edits

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

    // Build only the context parts that current enabled rules actually use.
    const contextRequirements = this.getRuleContextRequirements();
    const contextWithBody = await this.buildRuleContextWithBody(file, undefined, contextRequirements);

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

    if (this.isProtectedFrontmatterKey(key)) {
      this.logger.warn("Skipping mutation on protected calendar identity key", { key });
      return false;
    }

    // Validate value before writing to prevent corruption
    if (desiredValue !== null && !this.metadataManager.validateFrontmatterValue(key, desiredValue)) {
      this.logger.warn("Skipping frontmatter mutation due to validation failure", {
        key,
        value: desiredValue
      });
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
    frontmatterOverride: Record<string, unknown> | null | undefined,
    includeBacklinks = true
  ): RuleEvaluationContext {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = frontmatterOverride ?? this.toFrontmatterRecord(cache?.frontmatter);

    let backlinks: string[] | undefined;
    if (includeBacklinks) {
      backlinks = [];
      const resolvedLinks = this.app.metadataCache.resolvedLinks;
      if (resolvedLinks) {
        for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
          if (Object.prototype.hasOwnProperty.call(links, file.path)) {
            backlinks.push(sourcePath);
          }
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
    frontmatterOverride: Record<string, unknown> | null | undefined,
    options?: {
      includeBody?: boolean;
      includeBacklinks?: boolean;
    }
  ): Promise<RuleEvaluationContext> {
    const includeBody = options?.includeBody ?? true;
    const includeBacklinks = options?.includeBacklinks ?? true;
    const context = this.buildRuleContext(file, frontmatterOverride, includeBacklinks);

    // Only read body content when rules need it.
    if (includeBody && file.extension.toLowerCase() === "md") {
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

  private getRuleContextRequirements(): { includeBody: boolean; includeBacklinks: boolean } {
    return {
      includeBody: this.settingsUseConditionSource("body"),
      includeBacklinks: this.settingsUseConditionSource("backlink")
    };
  }

  private settingsUseConditionSource(source: RuleConditionSource): boolean {
    for (const rule of this.settings.rules) {
      if (rule.enabled && this.conditionsUseSource(rule.conditions, source)) {
        return true;
      }
    }

    for (const hideRule of this.settings.hideRules) {
      if (hideRule.enabled && this.conditionsUseSource(hideRule.conditions, source)) {
        return true;
      }
    }

    if (this.settings.smartSort.enabled) {
      for (const bucket of this.settings.smartSort.buckets) {
        if (!bucket.enabled) {
          continue;
        }

        if (this.conditionsUseSource(bucket.conditions, source)) {
          return true;
        }

        if (Array.isArray(bucket.conditionGroups)) {
          for (const group of bucket.conditionGroups) {
            if (this.conditionsUseSource(group.conditions, source)) {
              return true;
            }
          }
        }

        if (bucket.sortCriteria.some(criteria => criteria.source === source)) {
          return true;
        }
      }
    }

    return false;
  }

  private conditionsUseSource(conditions: RuleCondition[] | undefined, source: RuleConditionSource): boolean {
    if (!Array.isArray(conditions) || conditions.length === 0) {
      return false;
    }
    return conditions.some(condition => condition.source === source);
  }

  // isController() removed — role managed by TPS-Controller.

  private isMarkdownFile(file: TAbstractFile): file is TFile {
    return file instanceof TFile && file.extension === "md";
  }

  private hasDirectResolvedLink(sourcePath: string, targetPath: string): boolean {
    const resolvedLinks = this.app.metadataCache.resolvedLinks as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!resolvedLinks) {
      return false;
    }
    const sourceLinks = resolvedLinks[sourcePath];
    if (!sourceLinks || typeof sourceLinks !== "object") {
      return false;
    }
    return Object.prototype.hasOwnProperty.call(sourceLinks, targetPath);
  }

  private shouldProcessRealtimeFile(file: TFile): boolean {
    const active = this.app.workspace.getActiveFile();
    if (!active || !this.isMarkdownFile(active)) {
      return false;
    }
    if (file.path === active.path) {
      return true;
    }

    // Treat direct link relationships (subitems/parent/attachments when represented as links)
    // as in-scope for immediate processing.
    return (
      this.hasDirectResolvedLink(active.path, file.path) ||
      this.hasDirectResolvedLink(file.path, active.path)
    );
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

    // Grace period for newly created files to allow other plugins (TPS-Controller, Templater) to finish initialization
    const age = Date.now() - file.stat.ctime;
    if (age < 2000) return true; // Ignore if too young

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
    return value.trim()
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

  private isProtectedFrontmatterKey(key: string): boolean {
    const normalized = String(key || "").trim().toLowerCase();
    return NotebookNavigatorCompanionPlugin.PROTECTED_FRONTMATTER_KEYS.has(normalized);
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

  // triggerUpstreamUpdates() removed — handled by TPS-Controller.

  /*
   * Filename -> Title Sync
   * Extract "clean" title from filename (remove date suffix) and update frontmatter.
   */
  private async handleFilenameUpdate(file: TFile): Promise<void> {
    if (!this.settings.syncTitleFromFilename) {
      return;
    }
    if (this.shouldIgnoreFrontmatterWrite(file)) {
      return;
    }

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
    if (!this.settings.syncFilenameFromTitle) {
      return;
    }
    if (this.shouldIgnoreFrontmatterWrite(file)) {
      return;
    }

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
    const datePattern = /\s*(\d{4}[-/]\d{2}[-/]\d{2}|\d{8})(?:\s+\d+)?$/;
    const match = basename.match(datePattern);

    if (match) {
      const dateSuffix = match[1];
      const cleanTitle = basename.substring(0, match.index).trim();
      return { cleanTitle, dateSuffix };
    }

    return { cleanTitle: basename, dateSuffix: null };
  }
}
