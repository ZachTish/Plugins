import {
  Plugin,
  Notice,
  setIcon,
  PluginSettingTab,
  normalizePath,
  WorkspaceLeaf,
  ItemView,
  Modal,
  parseYaml,
  stringifyYaml,
  TFile,
  TFolder,
  MarkdownView
} from "obsidian";
import { SmartExplorerView, VIEW_TYPE_SMART_EXPLORER } from "./smart-explorer-view";
import {
  createRuleCondition,
  getRuleFieldPlaceholder,
  getRuleValuePlaceholder,
  getRuleOperatorsForSource,
  getRuleSources,
} from "./rule-helpers";
import { DEFAULT_ICON_RULES } from "./default-icon-rules";
import { FilterService } from "./filter-service";
import * as logger from "./logger";
import { DeleteConfirmationModal, QuickAddNoteModal, NamePromptModal } from "./modals";
import { CacheManager } from "./cache-manager";
import { TPSExplorerSettingsTab } from "./settings-tab";
import { VisualBuilderModal } from "./visual-builder";
import { FilterEditModal } from "./filter-edit-modal";
import { BasesFilterEditModal } from "./bases-filter-edit-modal";
import { SmartFiltersModal } from "./smart-filters-modal";
import {
  STYLE_CATEGORIES,
  createBuilderId,
  normalizeSingleSortDef,
  normalizeBucketSortDef,
  normalizeBuilderRule,
  normalizeBuilderDefinition,
  normalizeBuilderMap,
  normalizeStyleProfileMap,
  normalizeStyleAssignmentEntry,
  normalizeStyleAssignmentMap,
  normalizeStyleAssignments,
  normalizeServiceConfig,
  SUPPORTED_BASE_FILTER_PATTERNS,
  parseBaseFilterNode,
  parseBaseSort,
} from "./normalizers";
import { TagService } from "./tag-service";
import { BaseService } from "./base-service";
import { StyleService } from "./style-service";
import { applyTemplateVars, buildTemplateVars } from "./template-variable-service";

const Ve = "application/x-tps-smart-note";

export default class ExplorerPlugin extends Plugin {
  settings: any;
  data: any;
  state: any;

  globallyShowHiddenItems: boolean = false;
  calendarConfig: any;
  iconicData: any;
  _refreshTimer: any;
  private pendingRefresh: boolean = false;
  filterService: FilterService;

  // Extracted services
  tagService: TagService;
  baseService: BaseService;
  styleService: StyleService;

  filterDefinitionsCache: any[] = [];
  filterDefinitionMap: Record<string, any> = {};
  filterDefinitionsSourceRef: any[] | null = null;
  filterDefinitionCacheDirty: boolean = true;
  basesFilterDefsCache: any[] = [];

  /**
   * Parse a .base file and return a filter definition object compatible with Smart Explorer filters.
   * The filter rules are derived from the Bases file's filter configuration.
   */
  async parseBasesFile(basePath: string): Promise<any | null> {
    try {
      const normalizedPath = normalizePath(basePath);
      const file = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (!file || !(file instanceof TFile)) {
        logger.log(`Bases file not found (possibly deleted): ${basePath}`);
        return null;
      }

      const content = await this.app.vault.read(file);
      if (!content) return null;

      // Parse YAML frontmatter (Bases files are YAML)
      let basesConfig: any;
      try {
        basesConfig = parseYaml(content);
      } catch (e) {
        logger.error(`Failed to parse Bases file YAML: ${basePath}`, e);
        return null;
      }

      if (!basesConfig) return null;

      // Build filter rules from Bases filter config
      // Bases files use "filters:" (plural), but also support "filter:" (singular)
      const filterConfig = basesConfig.filters || basesConfig.filter;
      const filterRules = filterConfig ? parseBaseFilterNode(filterConfig) : null;

      // Sort config can be at root level or inside views[0].sort
      let sortConfig = basesConfig.sort;
      if (!sortConfig && Array.isArray(basesConfig.views) && basesConfig.views.length > 0) {
        sortConfig = basesConfig.views[0].sort;
      }
      const sortRules = sortConfig ? parseBaseSort(sortConfig) : [];

      // Extract the base name for the filter name
      const baseName = file.basename.replace(/\.base$/i, "");

      return {
        filterRules,
        sortRules,
        baseName,
        basePath: normalizedPath,
      };
    } catch (e) {
      logger.error(`Error parsing Bases file: ${basePath}`, e);
      return null;
    }
  }

  ensureFilterDefinitionsCache() {
    const filters = Array.isArray(this.settings?.filters)
      ? this.settings.filters
      : [];
    const basesFilters = Array.isArray(this.settings?.basesFilters)
      ? this.settings.basesFilters
      : [];

    if (
      !this.filterDefinitionCacheDirty &&
      this.filterDefinitionsSourceRef === filters
    ) {
      return;
    }
    const definitions = [] as any[];
    const map: Record<string, any> = {};

    // Process regular Smart Filters
    filters.forEach((entry: any, index: number) => {
      if (!entry || typeof entry !== "object") return;
      const id = String(entry.id || entry.name || `filter-${index}`);
      const name = String(entry.name || id);
      const icon = entry.icon || "search";
      const def = { id, name, icon, definition: entry };
      definitions.push(def);
      map[id] = def;
    });

    // Process Bases Filters (these will have their rules loaded dynamically)
    basesFilters.forEach((entry: any, index: number) => {
      if (!entry || typeof entry !== "object") return;
      const id = String(entry.id || `bases-filter-${index}`);
      const name = String(entry.name || entry.basePath || id);
      const icon = entry.icon || "database";

      // Set up defaultFrontmatter for note creation if template is configured
      const definition: any = { ...entry };
      if (entry.templatePath) {
        definition.defaultFrontmatter = {
          _templatePath: entry.templatePath,
          _targetFolder: entry.targetFolder || "",
        };
      }

      // Mark as bases filter for special handling
      const def = {
        id,
        name,
        icon,
        definition,
        isBasesFilter: true,
        basePath: entry.basePath,
      };
      definitions.push(def);
      map[id] = def;
    });

    this.filterDefinitionsCache = definitions;
    this.filterDefinitionMap = map;
    this.filterDefinitionsSourceRef = filters;
    this.filterDefinitionCacheDirty = false;
  }

  getFilterDefinitions() {
    this.ensureFilterDefinitionsCache();
    return this.filterDefinitionsCache || [];
  }

  findFilterDefinition(filterId: string) {
    if (!filterId) return null;
    this.ensureFilterDefinitionsCache();

    // Direct ID Match
    if (this.filterDefinitionMap[filterId]) {
      return this.filterDefinitionMap[filterId];
    }

    // Name Match (Case-insensitive)
    const lowerId = filterId.toLowerCase();
    return this.filterDefinitionsCache.find(d =>
      (d.name && d.name.toLowerCase() === lowerId) ||
      (d.id && d.id.toLowerCase() === lowerId)
    ) || null;
  }

  markFilterDefinitionsDirty() {
    this.filterDefinitionCacheDirty = true;
    this.filterDefinitionsSourceRef = null;
    this.basesFilterRulesLoaded = false;
  }

  basesFilterRulesLoaded: boolean = false;

  openFilterModal(initialFilter: any, onSave: (filter: any) => void) {
    new FilterEditModal(this.app, this, initialFilter, onSave).open();
  }

  /**
   * Loads the filter rules from .base files for all bases filters.
   * Must be called after ensureFilterDefinitionsCache().
   */
  async loadBasesFilterRules() {
    if (this.basesFilterRulesLoaded) return;

    this.ensureFilterDefinitionsCache();

    const definitions = this.filterDefinitionsCache || [];
    for (const def of definitions) {
      if (!def.isBasesFilter || !def.basePath) continue;

      try {
        const parsedBases = await this.parseBasesFile(def.basePath);
        if (parsedBases && parsedBases.filterRules) {
          // Inject the parsed rules into the definition
          // The definition object's "rules" property is what evaluateFilterDefinition uses
          def.definition.rules = parsedBases.filterRules.rules || [];
          def.definition.match = parsedBases.filterRules.match || "all";

          // Also store sort rules if available
          if (parsedBases.sortRules && parsedBases.sortRules.length > 0) {
            def.definition.sortRules = parsedBases.sortRules;
          }

          logger.log(`Loaded bases filter rules for ${def.name}: ${def.definition.rules?.length || 0} rules`);
        } else {
          logger.log(`No filter rules found in bases file: ${def.basePath}`);
          def.definition.rules = [];
        }
      } catch (e) {
        logger.error(`Failed to load bases filter rules for ${def.basePath}`, e);
        def.definition.rules = [];
      }
    }

    this.basesFilterRulesLoaded = true;
  }


  async onload() {
    let { app: e } = this;

    // Initialize services first
    this.filterService = new FilterService(this.app, this);
    this.tagService = new TagService(this);
    this.baseService = new BaseService(this);
    this.styleService = new StyleService(this);

    // Then load settings and initialize builders
    ((this.data = await this.loadData()),
      (!this.data || typeof this.data != "object") && (this.data = {}),
      (this.settings = {
        tagTemplatePath:
          this.data.tagTemplatePath || "System/Templates/Root template.md",
        newNoteTemplatePath: this.data.newNoteTemplatePath || "",
        projectFolderPath: this.data.projectFolderPath || "",
        filters: Array.isArray(this.data.filters) ? this.data.filters : [],
        basesFilters: Array.isArray(this.data.basesFilters) ? this.data.basesFilters : [],
        hideCompleted:
          this.data.hideCompleted !== undefined ? this.data.hideCompleted : true,
        folderExclusions: this.data.folderExclusions || "",
        enableDebugLogging: this.data.enableDebugLogging || false,
        serviceConfig: normalizeServiceConfig(this.data.serviceConfig),
        migratedFEPPRules: this.data.migratedFEPPRules || false,
        appliedDefaultSort: this.data.appliedDefaultSort || false,
        hideInlineTagCrossedOut:
          this.data.hideInlineTagCrossedOut !== undefined ? this.data.hideInlineTagCrossedOut : true,
        hideInlineTagChecked:
          this.data.hideInlineTagChecked !== undefined ? this.data.hideInlineTagChecked : true,
        archiveTag: this.data.archiveTag || "",
        tagNormalizationPending:
          this.data.tagNormalizationPending !== undefined ? this.data.tagNormalizationPending : true,
      }),
      logger.setLoggingEnabled(this.settings.enableDebugLogging),
      this.ensureServiceBuilders(),
      (this.state = { collapsed: {} }),
      (this.calendarConfig = null),
      await this.loadCalendarConfig(),
      (this.iconicData = DEFAULT_ICON_RULES));
    if (
      Object.prototype.hasOwnProperty.call(this.data, "tagBasePath") ||
      Object.prototype.hasOwnProperty.call(this.data, "tagNoteFolderPath") ||
      Object.prototype.hasOwnProperty.call(this.data, "tagNoteArchiveFolderPath") ||
      Object.prototype.hasOwnProperty.call(this.data, "tagNoteTemplatePath") ||
      Object.prototype.hasOwnProperty.call(this.data, "typesBasePath")
    ) {
      delete this.data.tagBasePath;
      delete this.data.tagNoteFolderPath;
      delete this.data.tagNoteArchiveFolderPath;
      delete this.data.tagNoteTemplatePath;
      delete this.data.typesBasePath;
      await this.saveData(this.data);
    }
    try {
      await this.loadIconicData();
    } catch { }

    // Load bases filter rules
    try {
      await this.loadBasesFilterRules();
    } catch { }

    this.registerView(VIEW_TYPE_SMART_EXPLORER, (t) => new SmartExplorerView(t, this));
    try {
      if (PluginSettingTab) this.addSettingTab(new TPSExplorerSettingsTab(this.app, this));
    } catch { }
    (this.addCommand({
      id: "open-explorer-2-left",
      name: "Open Explorer 2 (Left Sidebar)",
      callback: () => this.openInSidebar("left"),
    }),
      this.addCommand({
        id: "open-explorer-2-right",
        name: "Open Explorer 2 (Right Sidebar)",
        callback: () => this.openInSidebar("right"),
      }),
      this.addCommand({
        id: "reveal-active-file-in-explorer-2",
        name: "Reveal active file in Explorer 2",
        callback: () => this.revealActiveFile(),
      }),
      this.addCommand({
        id: "inline-rename-file",
        name: "Rename file (inline)",
        callback: () => {
          const activeFile = this.app.workspace.getActiveFile();
          if (activeFile && activeFile.path) {
            const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART_EXPLORER);
            if (leaves.length > 0) {
              const view = leaves[0].view as any;
              if (view && typeof view.queueInlineRename === 'function') {
                view.queueInlineRename(activeFile.path, { clear: false });
              }
            }
          }
        },
      }),
      this.addCommand({
        id: "toggle-hidden-items",
        name: "Toggle Hidden Items",
        callback: () => {
          this.globallyShowHiddenItems = !this.globallyShowHiddenItems;
          this.refreshAllExplorers();
          new Notice(this.globallyShowHiddenItems ? "Hidden items visible" : "Hidden items hidden");
        },
      }),


      this.addCommand({
        id: "standardize-vault",
        name: "Standardize Vault Filenames & Titles",
        callback: () => {
          this.scanAndStandardizeVault();
        },
      }),
      this.addCommand({
        id: "normalize-tags-vault",
        name: "Normalize Tags Across Vault",
        callback: () => {
          this.normalizeTagsAcrossVault();
        },
      }),


      this.addCommand({
        id: "explorer2-focus",
        name: "Focus on Explorer 2",
        callback: () => {
          this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART_EXPLORER).forEach((leaf) => {
            this.app.workspace.revealLeaf(leaf);
          });
        },
      }));

    this.addRibbonIcon("folder", "Explorer 2", () => {
      this.activateView();
    });
    try {
      this.registerEvent(
        e.vault.on("modify", (t) => {
          if (t && t.path === ".obsidian/plugins/iconic/data.json") {
            this.loadIconicData()
              .then(() => {
                this.refreshAllExplorer2();
              })
              .catch(() => { });
          }
        }),
      );

      this.app.workspace.onLayoutReady(() => {
        this.refreshAllExplorer2(true);
        this.scanAllFilesForScheduledRename();
        this.tagService.primeFileTagCache();
        void this.maybeNormalizeTagsOnStartup();
      });

      this.registerEvent(
        this.app.metadataCache.on("changed", (file) => {
          this.handleScheduledRename(file);
          if (file?.path) {
            this.filterService?.invalidateFileCache(file.path);
            void this.tagService.handleTagCanvasFileChange(file);
          }
          this.refreshAllExplorer2();
        })
      );

      this.registerEvent(
        this.app.metadataCache.on("resolved", () => {
          this.refreshAllExplorer2();
        })
      );

      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          if (file instanceof TFile && file.extension === "md") {
            this.tagService.updateFileTagCacheOnRename(oldPath, file.path);
            void this.handleFolderTemplateOnMove(file, oldPath);
          }
        })
      );

      this.registerEvent(
        this.app.workspace.on("active-leaf-change", () => {
          this.refreshAllExplorer2(true);
        })
      );

      // Pre-cache folder filter matches after layout is ready
      this.app.workspace.onLayoutReady(async () => {
        await this.preCacheFolderFilters();
        this.scanAllFilesForScheduledRename();
      });

    } catch { }


  }

  isEditorFocused(): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor;
    if (!editor) return false;
    try {
      return typeof editor.hasFocus === "function" ? editor.hasFocus() : false;
    } catch {
      return false;
    }
  }

  async scanAllFilesForScheduledRename() {
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      await this.handleScheduledRename(file);
    }
  }

  private async handleFolderTemplateOnMove(file: TFile, oldPath: string): Promise<void> {
    try {
      if (file.extension !== "md") return;
      const oldFolder = this.getFolderPath(oldPath);
      const newFolder = this.getFolderPath(file.path);
      if (oldFolder === newFolder) return;

      const newMatch = this.findFolderTemplateMatch(newFolder);
      if (!newMatch) return;
      const oldMatch = this.findFolderTemplateMatch(oldFolder);
      if (oldMatch && oldMatch.templatePath === newMatch.templatePath && oldMatch.targetFolder === newMatch.targetFolder) {
        return;
      }

      await this.applyTemplateToExistingFile(file, newMatch.templatePath);
    } catch (err) {
      logger.warn("[Smart Explorer] Failed to apply folder template on move", err);
    }
  }

  private findFolderTemplateMatch(folderPath: string): { templatePath: string; targetFolder: string } | null {
    const normalizedFolder = normalizePath(folderPath || "");
    const candidates: { templatePath: string; targetFolder: string }[] = [];

    const filters = Array.isArray(this.settings?.filters) ? this.settings.filters : [];
    for (const filter of filters) {
      const fm = filter?.defaultFrontmatter;
      const targetFolder = typeof fm?._targetFolder === "string" ? fm._targetFolder.trim() : "";
      const templatePath = typeof fm?._templatePath === "string" ? fm._templatePath.trim() : "";
      if (!targetFolder || !templatePath) continue;
      candidates.push({ templatePath, targetFolder: normalizePath(targetFolder.replace(/\/$/, "")) });
    }

    const basesFilters = Array.isArray(this.settings?.basesFilters) ? this.settings.basesFilters : [];
    for (const bf of basesFilters) {
      const targetFolder = typeof bf?.targetFolder === "string" ? bf.targetFolder.trim() : "";
      const templatePath = typeof bf?.templatePath === "string" ? bf.templatePath.trim() : "";
      if (!targetFolder || !templatePath) continue;
      candidates.push({ templatePath, targetFolder: normalizePath(targetFolder.replace(/\/$/, "")) });
    }

    let best: { templatePath: string; targetFolder: string } | null = null;
    for (const candidate of candidates) {
      const target = candidate.targetFolder;
      if (!target) continue;
      if (normalizedFolder === target || normalizedFolder.startsWith(`${target}/`)) {
        if (!best || target.length > best.targetFolder.length) {
          best = candidate;
        }
      }
    }
    return best;
  }

  private getFolderPath(path: string): string {
    const normalized = normalizePath(path || "");
    const idx = normalized.lastIndexOf("/");
    if (idx === -1) return "";
    return normalized.slice(0, idx);
  }

  private splitFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
    if (content.startsWith("---")) {
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
      if (match) {
        const raw = match[1] || "";
        let fm: Record<string, any> = {};
        if (raw.trim()) {
          try {
            fm = (parseYaml(raw) as Record<string, any>) || {};
          } catch {
            fm = {};
          }
        }
        const body = content.slice(match[0].length);
        return { frontmatter: fm, body };
      }
    }
    return { frontmatter: {}, body: content };
  }

  private async applyTemplateToExistingFile(file: TFile, templatePath: string): Promise<void> {
    const templateFile = await this.resolveTemplateFile(templatePath);
    if (!templateFile) {
      logger.warn("[Smart Explorer] Template file not found for folder template", templatePath);
      return;
    }

    let templateContent: string | null = await this.processTemplate(templateFile, file);
    if (templateContent == null) {
      try {
        templateContent = await this.app.vault.read(templateFile);
      } catch (err) {
        logger.warn("[Smart Explorer] Failed to read template file", err);
        return;
      }
    }

    const existingContent = await this.app.vault.read(file);
    const existing = this.splitFrontmatter(existingContent);
    const templated = this.splitFrontmatter(templateContent);

    const mergedFrontmatter = { ...templated.frontmatter, ...existing.frontmatter };
    const templateBody = (templated.body || "").trim();
    let body = existing.body || "";

    if (templateBody) {
      const bodyTrim = body.trim();
      if (!bodyTrim.includes(templateBody)) {
        if (bodyTrim) {
          body = `${bodyTrim}\n\n${templateBody}\n`;
        } else {
          body = `${templateBody}\n`;
        }
      } else {
        body = existing.body;
      }
    }

    const fmKeys = Object.keys(mergedFrontmatter || {});
    let fmBlock = "";
    if (fmKeys.length) {
      fmBlock = `---\n${stringifyYaml(mergedFrontmatter).trimEnd()}\n---\n`;
    }
    const nextContent = `${fmBlock}${(body || "").replace(/^\r?\n+/, "")}`;
    if (nextContent !== existingContent) {
      await this.app.vault.modify(file, nextContent);
    }
  }

  async handleScheduledRename(file: any) {
    const { TFile } = require("obsidian");
    if (!(file instanceof TFile) || !file.path.endsWith(".md")) return;

    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;
    if (!frontmatter || !frontmatter.scheduled) return;

    const name = file.basename;
    let currentNameDate = "";
    let namePrefix = "";
    let nameSuffix = "";
    let patternType = "none";

    // Check for "YYYY-MM-DD Title"
    const matchStart = name.match(/^(\d{4}-\d{2}-\d{2})\s+(.*)$/);
    // Check for "Title YYYY-MM-DD"
    const matchEnd = name.match(/^(.*?)\s+(\d{4}-\d{2}-\d{2})$/);

    if (matchStart) {
      currentNameDate = matchStart[1];
      nameSuffix = matchStart[2];
      patternType = "start";
    } else if (matchEnd) {
      namePrefix = matchEnd[1];
      currentNameDate = matchEnd[2];
      patternType = "end";
    } else {
      return; // No date pattern found
    }

    const scheduledVal = frontmatter.scheduled;
    let targetDate = "";

    if (typeof scheduledVal === "string") {
      // Handle ISO format (T) and space-separated time
      targetDate = scheduledVal.split("T")[0].split(" ")[0];
    } else if (scheduledVal instanceof Date) {
      targetDate = scheduledVal.toISOString().split("T")[0];
    } else {
      // Try simple string conversion if it looks like a date
      try {
        const d = new Date(scheduledVal);
        if (!isNaN(d.getTime())) {
          targetDate = d.toISOString().split("T")[0];
        }
      } catch { }
    }

    if (!targetDate) return;

    if (currentNameDate !== targetDate) {
      // Logic for title sync
      let cleanTitle = patternType === "start" ? nameSuffix : namePrefix;
      // Sanitize clean title
      cleanTitle = cleanTitle.replace(/[\\/:*?"<>|]/g, "").trim();

      if (frontmatter.title !== cleanTitle) {
        try {
          this.app.fileManager.processFrontMatter(file, (fm) => {
            fm.title = cleanTitle;
          });
        } catch (err) {
          logger.error("Failed to update frontmatter title", err);
        }
      }

      let newName = "";
      if (patternType === "start") {
        newName = `${targetDate} ${nameSuffix}.${file.extension}`;
      } else {
        newName = `${namePrefix} ${targetDate}.${file.extension}`;
      }

      // Sanitize filename: remove invalid chars \ / : * ? " < > |
      newName = newName.replace(/[\\/:*?"<>|]/g, "");

      const newPath = `${file.parent.path}/${newName}`;

      // Prevent overwrite if file exists
      if (await this.app.vault.adapter.exists(newPath)) {
        return;
      }

      try {
        await this.app.fileManager.renameFile(file, newPath);
        new (require("obsidian").Notice)(`Renamed to ${newName}`);
      } catch (err) {
        logger.error("TPS-Smart-Explorer: Failed to rename scheduled note", err);
      }
    }
  }

  async scanAndStandardizeVault() {
    const exclusions = (this.settings.folderExclusions || "")
      .split("\n")
      .map((x: string) => x.trim())
      .filter((x: string) => x);

    const files = this.app.vault.getMarkdownFiles();
    let processedCount = 0;

    new (require("obsidian").Notice)(`Starting vault standardization on ${files.length} files...`);

    for (const file of files) {
      if (exclusions.some((e: string) => file.path.startsWith(e))) continue;

      // Skip Daily Notes (YYYY-MM-DD.md)
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(file.name)) continue;

      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache?.frontmatter || {};

      // Case 1: Has Scheduled Date
      if (frontmatter.scheduled) {
        let scheduledDate = "";
        const scheduledVal = frontmatter.scheduled;

        if (typeof scheduledVal === "string") {
          scheduledDate = scheduledVal.split("T")[0].split(" ")[0];
        } else if (scheduledVal instanceof Date) {
          scheduledDate = scheduledVal.toISOString().split("T")[0];
        } else {
          try {
            const d = new Date(scheduledVal);
            if (!isNaN(d.getTime())) scheduledDate = d.toISOString().split("T")[0];
          } catch { }
        }

        if (scheduledDate) {
          // Determine clean title from current filename
          let currentName = file.basename;
          let cleanTitle = currentName;

          // Check for "YYYY-MM-DD Title"
          const matchStart = currentName.match(/^(\d{4}-\d{2}-\d{2})\s+(.*)$/);
          // Check for "Title YYYY-MM-DD"
          const matchEnd = currentName.match(/^(.*?)\s+(\d{4}-\d{2}-\d{2})$/);

          if (matchStart) {
            cleanTitle = matchStart[2];
          } else if (matchEnd) {
            cleanTitle = matchEnd[1];
          }

          // Sanitize title
          cleanTitle = cleanTitle.replace(/[\\/:*?"<>|]/g, "").trim();

          // 1. Enforce Frontmatter Title = Clean Title
          if (frontmatter.title !== cleanTitle) {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
              fm.title = cleanTitle;
            });
          }

          // 2. Enforce Filename = Title YYYY-MM-DD
          let targetName = `${cleanTitle} ${scheduledDate}.${file.extension}`;

          // Only rename if different
          if (file.name !== targetName) {
            const newPath = `${file.parent.path}/${targetName}`;
            if (!(await this.app.vault.adapter.exists(newPath))) {
              await this.app.fileManager.renameFile(file, newPath);
              processedCount++;
            }
          }
        }
      }

      // Case 2: No Scheduled Date -> Just clean frontmatter title if it has a date
      else if (frontmatter.title) {
        const titleStr = String(frontmatter.title);
        // If title has a date like "Title 2025-01-01" or "2025-01-01 Title", strip it
        const datePattern = /\d{4}-\d{2}-\d{2}/;
        if (datePattern.test(titleStr)) {
          // Strip date
          let cleanTitle = titleStr.replace(datePattern, "").replace(/\s+/g, " ").trim();
          if (cleanTitle !== titleStr) {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
              fm.title = cleanTitle;
            });
            processedCount++;
          }
        }
      }
    }

    new (require("obsidian").Notice)(`Standardization complete. Updated/Renamed ${processedCount} files.`);
  }

  private async maybeNormalizeTagsOnStartup(): Promise<void> {
    if (!this.settings?.tagNormalizationPending) return;
    this.settings.tagNormalizationPending = false;
    await this.saveSettings();
    await this.normalizeTagsAcrossVault();
  }

  async loadCalendarConfig() {
    try {
      let t = normalizePath(".obsidian/plugins/Depreciated plugins/TPS-Calendar/data.json");
      if (!(await this.app.vault.adapter.exists(t))) {
        this.calendarConfig = null;
        return;
      }
      let r = await this.app.vault.adapter.read(t);
      try {
        this.calendarConfig = JSON.parse(r);
      } catch {
        this.calendarConfig = null;
      }
    } catch {
      this.calendarConfig = null;
    }
  }


  onunload() {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
    this.tagService?.destroy();
    this.baseService?.destroy();
    this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART_EXPLORER).forEach((t) => t.detach());
  }

  async preCacheFolderFilters() {
    try {
      const filters = this.settings.filters || [];
      if (!filters.length) return;

      const view = this.getFirstExplorer2View() as any;
      if (!view || !view.folderMatchesFilter) return;

      // Get all folders in the vault
      const { TFolder } = require("obsidian");
      const folders = this.app.vault.getAllLoadedFiles()
        .filter((f: any) => f instanceof TFolder) as TFolder[];

      // For each filter, pre-cache which folders contain matching files
      for (const filter of filters) {
        if (!filter || !filter.id) continue;
        for (const folder of folders) {
          // This populates folderFilterMatchCache
          if (this.filterService) {
            this.filterService.folderMatchesFilter(folder, filter.definition, filter.id);
          }
        }
      }

      this.debugLog("Pre-cached folder filter matches", {
        filters: filters.length,
        folders: folders.length
      });
    } catch (err) {
      logger.error("Failed to pre-cache folder filters", err);
    }
  }

  async openInSidebar(e) {
    let { app: t } = this,
      n = t.workspace,
      r = e === "left" ? n.getLeftLeaf(!0) : n.getRightLeaf(!0);
    r && (await r.setViewState({ type: VIEW_TYPE_SMART_EXPLORER, active: !0 }), n.revealLeaf(r));
  }

  private getTemplaterRoot(): string | null {
    const folder = (this.data as any)?.templatesRoot;
    if (typeof folder === "string" && folder.trim()) {
      return normalizePath(folder.trim());
    }
    return "System/Templates";
  }

  resolveTemplateFile(path: string | null): Promise<TFile | null> {
    if (!path) return Promise.resolve(null);
    const normalized = normalizePath(path);
    const direct = this.app.vault.getAbstractFileByPath(normalized);
    if (direct instanceof TFile) return Promise.resolve(direct);
    if (!normalized.toLowerCase().endsWith(".md") && !normalized.toLowerCase().endsWith(".canvas")) {
      const mdFallback = this.app.vault.getAbstractFileByPath(`${normalized}.md`);
      if (mdFallback instanceof TFile) return Promise.resolve(mdFallback);
      const canvasFallback = this.app.vault.getAbstractFileByPath(`${normalized}.canvas`);
      if (canvasFallback instanceof TFile) return Promise.resolve(canvasFallback);
    }
    const templaterRoot = this.getTemplaterRoot();
    if (templaterRoot) {
      const joined = this.app.vault.getAbstractFileByPath(`${templaterRoot}/${normalized}`);
      if (joined instanceof TFile) return Promise.resolve(joined);
      if (!normalized.toLowerCase().endsWith(".md") && !normalized.toLowerCase().endsWith(".canvas")) {
        const joinedFallback = this.app.vault.getAbstractFileByPath(`${templaterRoot}/${normalized}.md`);
        if (joinedFallback instanceof TFile) return Promise.resolve(joinedFallback);
        const joinedCanvasFallback = this.app.vault.getAbstractFileByPath(`${templaterRoot}/${normalized}.canvas`);
        if (joinedCanvasFallback instanceof TFile) return Promise.resolve(joinedCanvasFallback);
      }
      const basename = normalized.split("/").pop();
      if (basename) {
        const candidates = (this.app.vault.getFiles?.() || []) as TFile[];
        const matches = candidates.filter(
          (f) =>
            f.path.startsWith(templaterRoot + "/") &&
            (f.basename === basename || f.name === basename || f.name === `${basename}.md` || f.name === `${basename}.canvas`)
        );
        if (matches.length === 1) return Promise.resolve(matches[0] as TFile);
      }
    }
    return Promise.resolve(null);
  }

  async processTemplate(templateFile: TFile, targetFile: TFile): Promise<string | null> {
    try {
      const raw = await this.app.vault.read(templateFile);
      return applyTemplateVars(raw, buildTemplateVars(targetFile));
    } catch (e) {
      logger.warn("[Smart Explorer] Template processing failed", e);
      return null;
    }
  }

  async savePluginState() {
    logger.setLoggingEnabled(this.settings.enableDebugLogging);
    ((this.data = this.data || {}),
      (this.data.tagTemplatePath = this.settings.tagTemplatePath),
      (this.data.newNoteTemplatePath = this.settings.newNoteTemplatePath),
      (this.data.filters = this.settings.filters || []),
      (this.data.basesFilters = this.settings.basesFilters || []),
      (this.data.projectFolderPath = this.settings.projectFolderPath),
      (this.data.hideCompleted = this.settings.hideCompleted),
      (this.data.folderExclusions = this.settings.folderExclusions),
      (this.data.enableDebugLogging = this.settings.enableDebugLogging),
      (this.data.serviceConfig = this.settings.serviceConfig),
      (this.data.appliedDefaultSort = this.settings.appliedDefaultSort),
      (this.data.archiveTag = this.settings.archiveTag),
      (this.data.tagNormalizationPending = this.settings.tagNormalizationPending),
      (this.data.hideInlineTagChecked = this.settings.hideInlineTagChecked),
      delete this.data.tagBasePath,
      delete this.data.tagNoteFolderPath,
      delete this.data.tagNoteArchiveFolderPath,
      delete this.data.tagNoteTemplatePath,
      delete this.data.typesBasePath,
      await this.saveData(this.data));
  }

  async saveSettings() {
    await this.savePluginState();
  }

  // ── TagService delegation ──────────────────────────────────────

  normalizeTag(tag: string): string {
    return this.tagService.normalizeTag(tag);
  }

  buildTagNotePath(basePath: string, tag: string): { path: string; relative: string } {
    return this.tagService.buildTagNotePath(basePath, tag);
  }

  isNoteArchived(file: TFile): boolean {
    return this.tagService.isNoteArchived(file);
  }

  getActiveTagsOnly(): Set<string> {
    return this.tagService.getActiveTagsOnly();
  }

  getFilesWithTag(tag: string): TFile[] {
    return this.tagService.getFilesWithTag(tag);
  }

  openTagCanvasForTag(tag: string): Promise<boolean> {
    void tag;
    return Promise.resolve(false);
  }

  normalizeTagsAcrossVault(): Promise<void> {
    return this.tagService.normalizeTagsAcrossVault();
  }

  moveTagNotesToFolder(oldPath: string, newPath: string): Promise<void> {
    return this.tagService.moveTagNotesToFolder(oldPath, newPath);
  }

  scheduleTagNoteSync(): void {
    // Tag-note canvas sync disabled by design.
  }

  primeFileTagCache(): void {
    this.tagService.primeFileTagCache();
  }

  parseCanvasData(raw: string): any | null {
    return this.tagService.parseCanvasData(raw);
  }

  serializeCanvasData(data: any): string {
    return this.tagService.serializeCanvasData(data);
  }

  // ── BaseService delegation ─────────────────────────────────────

  openTagBaseViewForTag(tag: string): Promise<boolean> {
    void tag;
    return Promise.resolve(false);
  }

  openTypesBaseViewForFolder(folderPath: string): Promise<boolean> {
    void folderPath;
    return Promise.resolve(false);
  }

  shouldUseTagBaseViews(): boolean {
    return false;
  }

  shouldUseTypesBaseViews(): boolean {
    return false;
  }

  shouldUsePerTagBaseFiles(): boolean {
    return this.baseService.shouldUsePerTagBaseFiles();
  }

  normalizeVaultPath(rawPath: string): string {
    return this.baseService.normalizeVaultPath(rawPath);
  }

  filtersContainTagRule(filters: any, tagRule: string): boolean {
    return this.baseService.filtersContainTagRule(filters, tagRule);
  }

  buildTagBaseFilePath(tag: string): string | null {
    return this.baseService.buildTagBaseFilePath(tag);
  }

  buildFolderBaseFilePath(folderPath: string): string | null {
    return this.baseService.buildFolderBaseFilePath(folderPath);
  }

  // ── StyleService delegation ────────────────────────────────────

  ensureServiceBuilders(): void {
    this.styleService.ensureServiceBuilders();
  }

  ensureStyleProfiles(): void {
    this.styleService.ensureStyleProfiles();
  }

  migrateLegacyStyleOverrides(): void {
    this.styleService.migrateLegacyStyleOverrides();
  }

  getStyleProfiles(type: string): Record<string, any> {
    return this.styleService.getStyleProfiles(type);
  }

  getStyleProfile(type: string, profileId: string): any {
    return this.styleService.getStyleProfile(type, profileId);
  }

  upsertStyleProfile(type: string, profile: any): any {
    return this.styleService.upsertStyleProfile(type, profile);
  }

  deleteStyleProfile(type: string, profileId: string): void {
    this.styleService.deleteStyleProfile(type, profileId);
  }

  setStyleAssignment(scope: string, key: string, type: string, profileId: string | null): void {
    this.styleService.setStyleAssignment(scope, key, type, profileId);
  }

  getAssignedProfileId(type: string, context: any = {}): string | null {
    return this.styleService.getAssignedProfileId(type, context);
  }

  getProfileBuilderForContext(type: string, context: any = {}): any {
    return this.styleService.getProfileBuilderForContext(type, context);
  }

  getVisualBuilder(type: string, scope = "default"): any {
    return this.styleService.getVisualBuilder(type, scope);
  }

  setVisualBuilder(type: string, builder: any, scope = "default"): void {
    this.styleService.setVisualBuilder(type, builder, scope);
  }

  getBuilderDefinition(type: string, context: any = {}): any {
    return this.styleService.getBuilderDefinition(type, context);
  }

  getBuilderOverride(type: string, scope: string, key: string): any {
    return this.styleService.getBuilderOverride(type, scope, key);
  }

  setBuilderOverride(type: string, scope: string, key: string, builder: any): void {
    this.styleService.setBuilderOverride(type, scope, key, builder);
  }

  // ── Remaining methods (not in services) ────────────────────────

  async loadIconicData() {
    try {
      let { normalizePath: e } = require("obsidian"),
        t = e(".obsidian/plugins/iconic/data.json");
      if (!(await this.app.vault.adapter.exists(t))) {
        this.iconicData = DEFAULT_ICON_RULES;
        return;
      }
      let r = await this.app.vault.adapter.read(t);
      try {
        this.iconicData = JSON.parse(r);
      } catch {
        this.iconicData = DEFAULT_ICON_RULES;
      }
    } catch {
      this.iconicData = DEFAULT_ICON_RULES;
    }
  }

  refreshAllExplorer2(force: boolean = false) {
    try {
      if (!force && this.isEditorFocused()) {
        return;
      }
      (this._refreshTimer && clearTimeout(this._refreshTimer),
        (this._refreshTimer = setTimeout(async () => {
          try {
            this.pendingRefresh = false;
            this.markFilterDefinitionsDirty();
            // Reload bases filter rules before rendering
            await this.loadBasesFilterRules();
            this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART_EXPLORER).forEach((t) => {
              let n = t.view as any;
              if (!n || !n.renderTree) return;
              try {
                typeof n.invalidateFilterMatches === "function" &&
                  n.invalidateFilterMatches();
                n.renderTree("");
              } catch { }
            });
          } catch { }
        }, 120)));
    } catch { }
  }

  revealActiveFile() {
    let { app: e } = this,
      t = e.workspace.getActiveFile();
    if (!t) {
      new (require("obsidian").Notice)("No active file to reveal");
      return;
    }
    let n = this.getFirstExplorer2View();
    if (!n) {
      new (require("obsidian").Notice)("Explorer 2 is not open");
      return;
    }
    (n as any).revealPath(t.path);
  }

  refreshAllExplorers() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART_EXPLORER).forEach((leaf) => {
      const view = leaf.view as any;
      if (view && typeof view.invalidateFilterMatches === "function") {
        view.invalidateFilterMatches();
        view.renderTree(view.filterQuery || "");

        // Update action icon if present
        const actionBtn = leaf.view.containerEl.querySelector('.view-action[aria-label="Toggle Hidden Items"], .view-action[aria-label="Show Hidden Items"], .view-action[aria-label="Hide Hidden Items"]');
        if (actionBtn) {
          (require("obsidian").setIcon)(actionBtn, this.globallyShowHiddenItems ? "eye" : "eye-off");
          actionBtn.setAttribute("aria-label", this.globallyShowHiddenItems ? "Hide Hidden Items" : "Show Hidden Items");
        }
      }
    });
  }

  getFirstExplorer2View() {
    let { app: e } = this,
      t = e.workspace.getLeavesOfType(VIEW_TYPE_SMART_EXPLORER);
    if (t.length === 0) return;
    let n = t[0].view;
    if (n && n.getViewType && n.getViewType() === VIEW_TYPE_SMART_EXPLORER) return n;
  }

  shouldLog() {
    return this.settings.debugMode;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_SMART_EXPLORER);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getLeftLeaf(false);
      await leaf.setViewState({
        type: VIEW_TYPE_SMART_EXPLORER,
        active: true,
      });
    }
    workspace.revealLeaf(leaf);
  }

  debugLog(...args: any[]) {
    if (this.shouldLog()) {
      logger.log(...args);
    }
  }
}
