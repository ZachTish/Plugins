import {
  Plugin,
  MarkdownRenderer,
  TFile,
  normalizePath,
  WorkspaceLeaf,
  MarkdownView,
} from "obsidian";
import { AutoBaseEmbedSettingTab } from "./settings-tab";

// ============ Types ============

export interface BaseEmbedConditions {
  folders?: string[];           // Only embed if note is IN these folders
  excludeFolders?: string[];    // Don't embed if note is in these folders
  tags?: string[];              // Only embed if note has one of these tags
  excludeTags?: string[];       // Don't embed if note has one of these tags
  requireTagMatchingNoteName?: boolean; // Require tag that exactly matches note basename (case-insensitive)
  excludeTagMatchingNoteName?: boolean; // Exclude when note has a tag matching note basename (case-insensitive)
  requireProperty?: string;     // Property must exist (e.g., "scheduled")
  requirePropertyEmpty?: string; // Property must be empty or missing (e.g., "scheduled")
  propertyEquals?: Array<{ key: string; value: string }>;   // Property must equal value
  propertyNotEquals?: Array<{ key: string; value: string }>; // Property must NOT equal value
}

export interface BaseEmbedRule {
  id: string;
  basePath: string;
  enabled: boolean;
  conditions: BaseEmbedConditions;
  initialState?: "collapsed" | "expanded" | "default";
}

export interface AutoBaseEmbedSettings {
  enabled: boolean;
  enableCanvasEmbeds: boolean;
  renderMode: "floating" | "inline";
  inlinePlacement: "after-title" | "after-content";
  rules: BaseEmbedRule[];
  excludeFiles: string;
  defaultExpanded: boolean;
  accordionMode: boolean;
  manualExpansionState?: Record<string, boolean>;
  // Legacy fields kept for cleanup only
  basePath?: string;
  basePaths?: string;
  excludeFolders?: string;
}

const DEFAULT_SETTINGS: AutoBaseEmbedSettings = {
  enabled: true,
  enableCanvasEmbeds: false,
  renderMode: "floating",
  inlinePlacement: "after-content",
  rules: [],
  excludeFiles: "",
  defaultExpanded: false,
  accordionMode: false,
  manualExpansionState: {},
};

const EMBED_CLASS = "tps-auto-base-embed";
const STYLE_ID = "tps-auto-base-embed-style";
const COLLAPSED_ATTR = "data-tps-auto-base-embed-collapsed";
const RENDERING_ATTR = "data-tps-auto-base-embed-rendering";
const BUILD_STAMP = "2026-03-15T21:05:00Z";

// ============ Plugin ============

export default class AutoBaseEmbedPlugin extends Plugin {
  settings: AutoBaseEmbedSettings;
  private overlayByLeaf = new WeakMap<WorkspaceLeaf, HTMLElement>();
  private overlayObservers = new WeakMap<WorkspaceLeaf, ResizeObserver>();
  private headerObservers = new WeakMap<HTMLElement, MutationObserver>();
  private renderTokens = new WeakMap<WorkspaceLeaf, number>();
  private renderSignatureByLeaf = new WeakMap<WorkspaceLeaf, string>();
  private expandedPanels = new WeakMap<WorkspaceLeaf, Set<string>>();
  private currentFileByLeaf = new WeakMap<WorkspaceLeaf, string>();
  private headerSyncTimers = new WeakMap<WorkspaceLeaf, number>();
  private typingRefreshTimers = new WeakMap<WorkspaceLeaf, number>();
  private leafRetryTimers = new WeakMap<WorkspaceLeaf, number>();
  private lastTypingAt = new WeakMap<WorkspaceLeaf, number>();
  private styleEl: HTMLStyleElement | null = null;
  private keyboardResizeHandler: (() => void) | null = null;
  private keyboardFocusHandler: (() => void) | null = null;
  private keyboardWindowResizeHandler: (() => void) | null = null;
  private keyboardBaseHeight: number = window.innerHeight;
  private keyboardHidden: boolean = false;
  private modalObserver: MutationObserver | null = null;
  private lastEditorFocused: boolean = false;
  private queuedRefreshAllTimer: number | null = null;
  private queuedRefreshAllOptions: { resetExpanded?: boolean } | null = null;

  private getLeafScrollSnapshot(leaf: WorkspaceLeaf): Record<string, number> {
    const view = leaf.view as any;
    const viewContainer = view?.containerEl as HTMLElement | undefined;
    if (!viewContainer?.isConnected) return {};

    const targets: Array<[string, HTMLElement | null | undefined]> = [
      ["leaf-content", viewContainer.closest(".workspace-leaf-content") as HTMLElement | null],
      ["view-content", viewContainer.querySelector<HTMLElement>(".view-content")],
      ["source-view", viewContainer.querySelector<HTMLElement>(".markdown-source-view")],
      ["cm-scroller", viewContainer.querySelector<HTMLElement>(".markdown-source-view .cm-scroller")],
      ["preview-view", viewContainer.querySelector<HTMLElement>(".markdown-preview-view, .markdown-reading-view")],
      ["preview-sizer", viewContainer.querySelector<HTMLElement>(".markdown-preview-sizer")],
    ];

    const snapshot: Record<string, number> = {};
    for (const [label, el] of targets) {
      if (!el?.isConnected) continue;
      snapshot[label] = Math.round(el.scrollTop);
    }
    return snapshot;
  }

  private logScrollSnapshot(
    stage: string,
    leaf: WorkspaceLeaf,
    file: TFile | null,
    extra?: Record<string, unknown>,
  ): void {
    const snapshot = this.getLeafScrollSnapshot(leaf);
    console.info("[TPS Auto Base Embed] [Scroll]", {
      stage,
      file: file?.path ?? null,
      renderMode: this.getEffectiveRenderMode(leaf),
      inlinePlacement: this.settings.inlinePlacement,
      snapshot,
      ...extra,
    });
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.clearAllOverlaysFromDom();
    console.info(`[TPS Auto Base Embed] Loaded build ${BUILD_STAMP}`);

    this.addSettingTab(new AutoBaseEmbedSettingTab(this.app, this));
    this.injectStyles();
    this.setupKeyboardDetection();
    this.setupModalVisibilityWatcher();

    const debouncedRefresh = this.debounce(() => {
      this.runOrQueueRefreshAll({ resetExpanded: true });
    }, 100);

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf) {
          void this.refreshLeaf(leaf, { resetExpanded: true });
          this.scheduleLeafStabilizationRefreshes(leaf, { resetExpanded: true });
        }
        this.flushPendingRefreshAll({ resetExpanded: true });
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        debouncedRefresh();
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        const leaf = this.app.workspace.activeLeaf;
        if (leaf) {
          const pending = this.typingRefreshTimers.get(leaf);
          if (pending != null) {
            window.clearTimeout(pending);
            this.typingRefreshTimers.delete(leaf);
          }
          this.lastTypingAt.delete(leaf);
          void this.refreshLeaf(leaf, { resetExpanded: true });
          this.scheduleLeafStabilizationRefreshes(leaf, { resetExpanded: true });
          this.flushPendingRefreshAll({ resetExpanded: true });
          return;
        }
        debouncedRefresh();
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", (view) => {
        if (this.isEditorFocused()) return;
        const leaf = (view as any)?.leaf as WorkspaceLeaf | undefined;
        if (leaf) this.scheduleTypingRefresh(leaf);
      })
    );
    this.registerEvent(
      (this.app.workspace as any).on("view-registered", () => {
        debouncedRefresh();
      })
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.isEditorFocused()) return;
        const activeLeaf = this.app.workspace.getMostRecentLeaf?.() || this.app.workspace.activeLeaf;
        const activeFile = activeLeaf ? this.getLeafFile(activeLeaf) : null;
        if (file && activeFile && file.path === activeFile.path && activeLeaf) {
          this.scheduleTypingRefresh(activeLeaf);
          this.scheduleLeafRefresh(activeLeaf, { resetExpanded: false }, 250);
          return;
        }
        debouncedRefresh();
      })
    );

    this.registerDomEvent(document, "focusout", () => {
      window.setTimeout(() => this.flushPendingRefreshAll({ resetExpanded: false }), 120);
    }, true);

    // Avoid focus-based flushes to reduce typing lag; rely on leaf/file changes.

    this.registerInterval(
      window.setInterval(() => {
        this.checkAndReattachOverlays();
      }, 2000)
    );

    // Force a clean first render on startup even if editor focus is active.
    this.refreshAllSupportedViews({ resetExpanded: true });
  }

  private isEditorFocused(): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor as any;
    if (!editor) return false;
    try {
      return typeof editor.hasFocus === "function" ? editor.hasFocus() : false;
    } catch {
      return false;
    }
  }

  private runOrQueueRefreshAll(options?: { resetExpanded?: boolean }): void {
    if (this.isEditorFocused()) {
      this.queuedRefreshAllOptions = {
        resetExpanded:
          (this.queuedRefreshAllOptions?.resetExpanded ?? false)
          || (options?.resetExpanded ?? false),
      };
      if (this.queuedRefreshAllTimer == null) {
        this.queuedRefreshAllTimer = window.setTimeout(() => {
          this.queuedRefreshAllTimer = null;
          const pendingOptions = this.queuedRefreshAllOptions || undefined;
          this.queuedRefreshAllOptions = null;
          this.flushPendingRefreshAll(pendingOptions);
        }, 350);
      }
      return;
    }
    this.refreshAllSupportedViews(options);
  }

  private flushPendingRefreshAll(options?: { resetExpanded?: boolean }): void {
    const mergedOptions =
      options || this.queuedRefreshAllOptions || undefined;
    this.queuedRefreshAllOptions = null;
    if (this.queuedRefreshAllTimer != null) {
      window.clearTimeout(this.queuedRefreshAllTimer);
      this.queuedRefreshAllTimer = null;
    }
    if (this.isEditorFocused()) {
      this.runOrQueueRefreshAll(mergedOptions);
      return;
    }
    this.refreshAllSupportedViews(mergedOptions);
  }

  private debounce<T extends (...args: any[]) => void>(fn: T, wait: number): T {
    let timeout: number | null = null;
    return ((...args: any[]) => {
      if (timeout !== null) {
        window.clearTimeout(timeout);
      }
      timeout = window.setTimeout(() => {
        timeout = null;
        fn(...args);
      }, wait);
    }) as T;
  }

  private scheduleLeafRefresh(
    leaf: WorkspaceLeaf,
    options?: { resetExpanded?: boolean },
    delay = 250,
  ): void {
    const existing = this.leafRetryTimers.get(leaf);
    if (existing != null) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      this.leafRetryTimers.delete(leaf);
      void this.refreshLeaf(leaf, options);
    }, delay);
    this.leafRetryTimers.set(leaf, timer);
  }

  private scheduleLeafStabilizationRefreshes(
    leaf: WorkspaceLeaf,
    options?: { resetExpanded?: boolean },
  ): void {
    const delays = [120, 450, 1100];
    for (const delay of delays) {
      window.setTimeout(() => {
        if (!this.isSupportedLeaf(leaf)) return;
        const existingHost = this.overlayByLeaf.get(leaf);
        if (
          this.getEffectiveRenderMode(leaf) === "inline"
          && existingHost?.isConnected
          && existingHost.querySelector(`.${EMBED_CLASS}__panel`)
        ) {
          return;
        }
        const activeLeaf = this.app.workspace.getMostRecentLeaf?.() || this.app.workspace.activeLeaf;
        if (activeLeaf !== leaf && !this.overlayByLeaf.get(leaf)?.isConnected) return;
        void this.refreshLeaf(leaf, { resetExpanded: delay === delays[0] ? options?.resetExpanded : false });
      }, delay);
    }
  }

  private getExpandedSet(leaf: WorkspaceLeaf): Set<string> {
    let existing = this.expandedPanels.get(leaf);
    if (!existing) {
      existing = new Set<string>();
      this.expandedPanels.set(leaf, existing);
    }
    return existing;
  }

  private checkAndReattachOverlays(): void {
    if (!this.settings.enabled) return;
    const leaves = this.getSupportedLeaves();
    for (const leaf of leaves) {
      const overlay = this.overlayByLeaf.get(leaf);
      const desiredMode = this.getEffectiveRenderMode(leaf);
      const currentMode = overlay?.getAttribute("data-render-mode");
      if (overlay && (!overlay.isConnected || currentMode !== desiredMode)) {
        this.overlayByLeaf.delete(leaf);
        void this.refreshLeaf(leaf, { resetExpanded: false });
        continue;
      }
      if (desiredMode === "inline" && overlay?.isConnected) {
        const mountTarget = this.resolveInlineMountTarget(leaf);
        if (
          !mountTarget
          || overlay.parentElement !== mountTarget.parent
          || overlay.nextSibling !== mountTarget.before
        ) {
          this.logScrollSnapshot("reattach-refresh", leaf, this.getLeafFile(leaf), {
            reason: !mountTarget ? "missing-mount-target" : "mount-target-mismatch",
          });
          void this.refreshLeaf(leaf, { resetExpanded: false });
        }
      }
    }
  }

  onunload(): void {
    this.clearAllOverlaysFromDom();
    this.teardownKeyboardDetection();
    this.modalObserver?.disconnect();
    this.modalObserver = null;
    this.styleEl?.remove();
    this.styleEl = null;
  }

  private clearAllOverlaysFromDom(): void {
    const overlays = Array.from(document.querySelectorAll<HTMLElement>(`.${EMBED_CLASS}`));
    for (const overlay of overlays) {
      overlay.remove();
    }
    const leafContents = Array.from(document.querySelectorAll<HTMLElement>(".workspace-leaf-content"));
    for (const leafContent of leafContents) {
      leafContent.style.removeProperty("--tps-auto-base-embed-height");
    }
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    if (!this.settings.manualExpansionState || typeof this.settings.manualExpansionState !== "object") {
      this.settings.manualExpansionState = {};
    }

    // Legacy cleanup only: do not auto-create rules from old settings.
    const cleanedRules = this.settings.rules.filter((rule) => !this.isLegacyGeneratedRule(rule));
    const removedLegacyRules = cleanedRules.length !== this.settings.rules.length;
    if (removedLegacyRules) {
      this.settings.rules = cleanedRules;
    }
    const hadLegacyFields =
      typeof this.settings.basePaths === "string" ||
      typeof this.settings.basePath === "string" ||
      typeof this.settings.excludeFolders === "string";
    if (hadLegacyFields) {
      delete this.settings.basePaths;
      delete this.settings.basePath;
      delete this.settings.excludeFolders;
    }

    if (removedLegacyRules || hadLegacyFields) {
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshAllSupportedViews({ resetExpanded: true });
  }

  private isLegacyGeneratedRule(rule: BaseEmbedRule): boolean {
    const id = String(rule.id || "").trim();
    if (id.startsWith("migrated-")) return true;

    const path = normalizePath(String(rule.basePath || "")).toLowerCase();
    if (!path) return false;
    const exactLegacy = new Set([
      normalizePath("System/Embeds/Default Embedded Base.base").toLowerCase(),
      normalizePath("System/Dashboards/Tags.base").toLowerCase(),
      normalizePath("System/Dashboards/Types.base").toLowerCase(),
      normalizePath("System/Bases/Tags.base").toLowerCase(),
      normalizePath("System/Bases/Types.base").toLowerCase(),
    ]);
    if (exactLegacy.has(path)) return true;

    // Legacy generators also created rules in tag/type subfolders.
    if (path.startsWith(normalizePath("System/Tags").toLowerCase() + "/")) return true;
    if (path.startsWith(normalizePath("System/Types").toLowerCase() + "/")) return true;
    return false;
  }

  private getSupportedLeaves(): WorkspaceLeaf[] {
    const leaves = [...this.app.workspace.getLeavesOfType("markdown")];
    if (this.settings.enableCanvasEmbeds) {
      leaves.push(...this.app.workspace.getLeavesOfType("canvas"));
    }
    return Array.from(new Set(leaves));
  }

  private isSupportedLeaf(leaf: WorkspaceLeaf): boolean {
    const type = String((leaf.view as any)?.getViewType?.() || "");
    if (type === "markdown") return true;
    return this.settings.enableCanvasEmbeds && type === "canvas";
  }

  private getLeafFile(leaf: WorkspaceLeaf): TFile | null {
    const file = (leaf.view as any)?.file;
    return file instanceof TFile ? file : null;
  }

  private refreshAllSupportedViews(options?: { resetExpanded?: boolean }): void {
    const leaves = this.getSupportedLeaves();
    for (const leaf of leaves) {
      void this.refreshLeaf(leaf, options);
    }
  }

  private getManualExpansionState(basePath: string): boolean | null {
    const normalized = normalizePath(String(basePath || ""));
    if (!normalized) return null;
    const state = this.settings.manualExpansionState || {};
    if (Object.prototype.hasOwnProperty.call(state, normalized)) {
      return !!state[normalized];
    }
    return null;
  }

  private setManualExpansionState(basePath: string, expanded: boolean): void {
    const normalized = normalizePath(String(basePath || ""));
    if (!normalized) return;
    if (!this.settings.manualExpansionState || typeof this.settings.manualExpansionState !== "object") {
      this.settings.manualExpansionState = {};
    }
    this.settings.manualExpansionState[normalized] = expanded;
    void this.saveData(this.settings);
  }

  /**
   * Evaluate if a rule should embed for a given file
   */
  private shouldEmbedRule(rule: BaseEmbedRule, file: TFile): boolean {
    if (!rule.enabled) return false;

    const conditions = rule.conditions;
    if (!conditions || Object.keys(conditions).length === 0) {
      return true; // No conditions = always match
    }

    const fileCache = this.app.metadataCache.getFileCache(file);
    const fm = fileCache?.frontmatter || {};
    const noteTags = this.collectFileTags(file, fm);

    // Folder inclusion
    if (conditions.folders && conditions.folders.length > 0) {
      const inFolder = conditions.folders.some((folder) => {
        const normalizedFolder = normalizePath(folder.endsWith("/") ? folder : folder + "/");
        return file.path.startsWith(normalizedFolder) || file.parent?.path === normalizePath(folder);
      });
      if (!inFolder) return false;
    }

    // Folder exclusion
    if (conditions.excludeFolders && conditions.excludeFolders.length > 0) {
      const inExcludedFolder = conditions.excludeFolders.some((folder) => {
        const normalizedFolder = normalizePath(folder.endsWith("/") ? folder : folder + "/");
        return file.path.startsWith(normalizedFolder) || file.parent?.path === normalizePath(folder);
      });
      if (inExcludedFolder) return false;
    }

    // Tag inclusion (any-match)
    if (conditions.tags && conditions.tags.length > 0) {
      const required = conditions.tags.map((tag) => this.normalizeTag(tag)).filter(Boolean);
      if (required.length > 0) {
        const hasAny = required.some((tag) => noteTags.has(tag));
        if (!hasAny) return false;
      }
    }

    // Tag exclusion (any-match)
    if (conditions.excludeTags && conditions.excludeTags.length > 0) {
      const denied = conditions.excludeTags.map((tag) => this.normalizeTag(tag)).filter(Boolean);
      if (denied.length > 0) {
        const hasDenied = denied.some((tag) => noteTags.has(tag));
        if (hasDenied) return false;
      }
    }

    // Require exact tag match to note basename (case-insensitive).
    if (conditions.requireTagMatchingNoteName) {
      const noteNameTag = this.normalizeTag(file.basename);
      if (!noteNameTag || !noteTags.has(noteNameTag)) {
        return false;
      }
    }

    // Exclude when a tag exactly matches note basename (case-insensitive).
    if (conditions.excludeTagMatchingNoteName) {
      const noteNameTag = this.normalizeTag(file.basename);
      if (noteNameTag && noteTags.has(noteNameTag)) {
        return false;
      }
    }

    // Require property exists
    if (conditions.requireProperty) {
      const propValue = this.getFrontmatterValueCaseInsensitive(
        fm as Record<string, unknown>,
        conditions.requireProperty,
      );
      if (propValue === undefined || propValue === null || propValue === "") {
        return false;
      }
    }

    // Require property empty or missing
    if (conditions.requirePropertyEmpty) {
      const propValue = this.getFrontmatterValueCaseInsensitive(
        fm as Record<string, unknown>,
        conditions.requirePropertyEmpty,
      );
      if (!this.isEmptyPropertyValue(propValue)) {
        return false;
      }
    }

    // Property equals
    if (conditions.propertyEquals && conditions.propertyEquals.length > 0) {
      for (const { key, value } of conditions.propertyEquals) {
        const propValue = this.getFrontmatterValueCaseInsensitive(fm as Record<string, unknown>, key);
        if (String(propValue) !== value) {
          return false;
        }
      }
    }

    // Property not equals
    if (conditions.propertyNotEquals && conditions.propertyNotEquals.length > 0) {
      for (const { key, value } of conditions.propertyNotEquals) {
        const propValue = this.getFrontmatterValueCaseInsensitive(fm as Record<string, unknown>, key);
        if (String(propValue) === value) {
          return false;
        }
      }
    }

    return true;
  }

  private collectFileTags(file: TFile, frontmatter: Record<string, unknown>): Set<string> {
    const tags = new Set<string>();
    const cacheTags = this.app.metadataCache.getFileCache(file)?.tags || [];
    for (const cacheTag of cacheTags) {
      const normalized = this.normalizeTag((cacheTag as any)?.tag);
      if (normalized) tags.add(normalized);
    }

    const fmTags = (frontmatter as any)?.tags;
    if (Array.isArray(fmTags)) {
      for (const tag of fmTags) {
        const normalized = this.normalizeTag(tag);
        if (normalized) tags.add(normalized);
      }
    } else if (typeof fmTags === "string") {
      for (const rawTag of fmTags.split(/[\s,]+/)) {
        const normalized = this.normalizeTag(rawTag);
        if (normalized) tags.add(normalized);
      }
    }

    return tags;
  }

  private normalizeTag(raw: unknown): string {
    const value = String(raw ?? "").trim().replace(/^#+/, "").toLowerCase();
    return value || "";
  }

  private getFrontmatterValueCaseInsensitive(
    frontmatter: Record<string, unknown>,
    key: string,
  ): unknown {
    const normalized = String(key || "").trim().toLowerCase();
    if (!normalized) return undefined;
    const matchedKey = Object.keys(frontmatter || {}).find((candidate) => candidate.toLowerCase() === normalized);
    return matchedKey ? frontmatter[matchedKey] : undefined;
  }

  private isEmptyPropertyValue(value: unknown): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === "string") return value.trim().length === 0;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
    return false;
  }

  private getEffectiveRenderMode(leaf: WorkspaceLeaf): "floating" | "inline" {
    const type = String((leaf.view as any)?.getViewType?.() || "");
    if (this.settings.renderMode === "inline" && type === "markdown") {
      return "inline";
    }
    return "floating";
  }

  private isElementActuallyVisible(el: HTMLElement | null | undefined): el is HTMLElement {
    if (!el?.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (el.closest(".is-hidden")) return false;
    return el.getClientRects().length > 0;
  }

  private isInlinePanel(panel: HTMLElement): boolean {
    return panel.closest(`.${EMBED_CLASS}[data-render-mode="inline"]`) instanceof HTMLElement;
  }

  private resolveInlineMountTarget(
    leaf: WorkspaceLeaf,
  ): { parent: HTMLElement; before: ChildNode | null } | null {
    const view = leaf.view as any;
    const viewContainer = view?.containerEl as HTMLElement | undefined;
    if (!viewContainer?.isConnected) return null;

    const mode = String(view?.getMode?.() || view?.mode || "").toLowerCase();

    const sourceView = viewContainer.querySelector<HTMLElement>(".markdown-source-view");
    const sourceEditor =
      sourceView?.querySelector<HTMLElement>(".cm-editor")
      || sourceView?.querySelector<HTMLElement>(".cm-scroller")?.closest(".cm-editor")
      || null;
    const sourceInlineTitle =
      sourceView?.querySelector<HTMLElement>(".inline-title")
      || sourceView?.querySelector<HTMLElement>(".cm-line.HyperMD-header")
      || null;
    const sourceVisible = this.isElementActuallyVisible(sourceView) && this.isElementActuallyVisible(sourceEditor);

    const previewRoot =
      viewContainer.querySelector<HTMLElement>(".markdown-reading-view .markdown-preview-sizer")
      || viewContainer.querySelector<HTMLElement>(".markdown-preview-view .markdown-preview-sizer")
      || viewContainer.querySelector<HTMLElement>(".markdown-reading-view")
      || viewContainer.querySelector<HTMLElement>(".markdown-preview-view")
      || null;
    const inlineTitle = previewRoot?.querySelector<HTMLElement>(".inline-title")
      || viewContainer.querySelector<HTMLElement>(".inline-title");
    const previewVisible = this.isElementActuallyVisible(previewRoot);

    const shouldUseSource = mode === "source" ? sourceVisible : sourceVisible && !previewVisible;
    const shouldUsePreview = mode === "preview" ? previewVisible : previewVisible && !sourceVisible;

    if (shouldUseSource) {
      const sourceParent = sourceEditor?.parentElement || sourceView;
      if (!sourceParent || !sourceEditor) return null;

      if (this.settings.inlinePlacement === "after-title") {
        if (
          sourceInlineTitle?.isConnected
          && sourceInlineTitle.parentElement
          && sourceInlineTitle.parentElement !== sourceEditor
          && !sourceInlineTitle.closest(".cm-content")
        ) {
          return { parent: sourceInlineTitle.parentElement, before: sourceInlineTitle.nextSibling };
        }
        return { parent: sourceParent, before: sourceEditor };
      }
      return {
        parent: sourceParent,
        before: sourceEditor.nextSibling,
      };
    }

    if (!shouldUsePreview && !previewVisible && sourceVisible) {
      const sourceParent = sourceEditor?.parentElement || sourceView;
      if (!sourceParent || !sourceEditor) return null;

      if (this.settings.inlinePlacement === "after-title") {
        if (
          sourceInlineTitle?.isConnected
          && sourceInlineTitle.parentElement
          && sourceInlineTitle.parentElement !== sourceEditor
          && !sourceInlineTitle.closest(".cm-content")
        ) {
          return { parent: sourceInlineTitle.parentElement, before: sourceInlineTitle.nextSibling };
        }
        return { parent: sourceParent, before: sourceEditor };
      }
      return {
        parent: sourceParent,
        before: sourceEditor.nextSibling,
      };
    }

    const previewChildren = previewRoot ? Array.from(previewRoot.children) as HTMLElement[] : [];
    const previewSections = previewChildren.filter((child) => child.classList.contains("markdown-preview-section"));
    const firstSection = previewSections[0] || null;
    const lastSection = previewSections.length > 0 ? previewSections[previewSections.length - 1] : null;
    const previewFooter = previewChildren.find((child) =>
      child.classList.contains("metadata-container")
      || child.classList.contains("metadata-properties")
      || child.classList.contains("embedded-backlinks")
      || child.classList.contains("mod-footer"),
    ) || null;

    if (this.settings.inlinePlacement === "after-title") {
      if (inlineTitle?.parentElement?.isConnected) {
        return { parent: inlineTitle.parentElement, before: inlineTitle.nextSibling };
      }
      if (previewRoot?.isConnected) {
        return { parent: previewRoot, before: firstSection };
      }
      return null;
    }

    if (previewVisible) {
      if (this.settings.inlinePlacement === "after-content" && lastSection) {
        return { parent: lastSection, before: null };
      }
      if (lastSection) {
        return { parent: previewRoot, before: previewFooter || lastSection.nextSibling };
      }
      return { parent: previewRoot, before: previewFooter };
    }
    return null;
  }

  private cleanupDuplicateHostsForLeaf(leaf: WorkspaceLeaf, currentHost: HTMLElement): void {
    const view = leaf.view as any;
    const viewContainer = view?.containerEl as HTMLElement | undefined;
    const leafContent = viewContainer?.closest?.(".workspace-leaf-content") as HTMLElement | null;
    if (!leafContent?.isConnected) return;
    const hosts = Array.from(leafContent.querySelectorAll<HTMLElement>(`.${EMBED_CLASS}`));
    for (const host of hosts) {
      if (host === currentHost) continue;
      if (currentHost.contains(host) || host.contains(currentHost)) continue;
      host.remove();
    }
  }

  private ensureHost(leaf: WorkspaceLeaf): HTMLElement | null {
    const desiredMode = this.getEffectiveRenderMode(leaf);
    let host = this.overlayByLeaf.get(leaf);
    if (host?.isConnected) {
      const currentMode = host.getAttribute("data-render-mode");
      if (currentMode !== desiredMode) {
        this.removeOverlay(leaf);
        host = undefined;
      }
    }

    if (desiredMode === "inline") {
      const mountTarget = this.resolveInlineMountTarget(leaf);
      if (!mountTarget) return null;
      if (!host || !host.isConnected) {
        host = document.createElement("div");
        host.className = EMBED_CLASS;
        this.overlayByLeaf.set(leaf, host);
      }
      host.setAttribute("data-render-mode", "inline");
      host.setAttribute("data-inline-placement", this.settings.inlinePlacement);
      const isCodeMirrorInline = mountTarget.parent.classList.contains("cm-content");
      host.classList.toggle("cm-line", isCodeMirrorInline);
      host.classList.toggle(`${EMBED_CLASS}--cm-inline`, isCodeMirrorInline);
      if (host.parentElement !== mountTarget.parent || host.nextSibling !== mountTarget.before) {
        console.info("[TPS Auto Base Embed] [Mount]", {
          file: this.getLeafFile(leaf)?.path ?? null,
          renderMode: desiredMode,
          inlinePlacement: this.settings.inlinePlacement,
          parentClass: mountTarget.parent.className,
          beforeNode:
            mountTarget.before instanceof HTMLElement
              ? mountTarget.before.className || mountTarget.before.tagName
              : mountTarget.before?.nodeName ?? null,
        });
        mountTarget.parent.insertBefore(host, mountTarget.before);
      }
      this.cleanupDuplicateHostsForLeaf(leaf, host);
      const observer = this.overlayObservers.get(leaf);
      if (observer) {
        observer.disconnect();
        this.overlayObservers.delete(leaf);
      }
      const view = leaf.view as any;
      const viewContainer = view?.containerEl as HTMLElement | undefined;
      const leafContent = viewContainer?.closest?.(".workspace-leaf-content") as HTMLElement | null;
      leafContent?.style.removeProperty("--tps-auto-base-embed-height");
      return host;
    }

    return this.ensureFloatingOverlay(leaf);
  }

  private buildRenderSignature(
    leaf: WorkspaceLeaf,
    file: TFile,
    rules: BaseEmbedRule[],
  ): string {
    const mode = this.getEffectiveRenderMode(leaf);
    const placement = mode === "inline" ? this.settings.inlinePlacement : "floating";
    const ruleKey = rules
      .map((rule) => `${rule.id}:${normalizePath(rule.basePath)}:${rule.initialState || "default"}`)
      .join("|");
    return `${mode}::${placement}::${file.path}::${ruleKey}`;
  }

  private canReuseExistingRender(
    leaf: WorkspaceLeaf,
    container: HTMLElement,
    signature: string,
    shouldResetExpanded: boolean,
  ): boolean {
    if (shouldResetExpanded) return false;
    if (!container.isConnected) return false;
    if (!container.querySelector(`.${EMBED_CLASS}__panel`)) return false;
    return this.renderSignatureByLeaf.get(leaf) === signature;
  }

  private async refreshLeaf(leaf: WorkspaceLeaf, options?: { resetExpanded?: boolean }): Promise<void> {
    const nextToken = (this.renderTokens.get(leaf) ?? 0) + 1;
    this.renderTokens.set(leaf, nextToken);
    const view = leaf.view;
    const initialFile = this.getLeafFile(leaf);
    this.logScrollSnapshot("refresh-start", leaf, initialFile, {
      token: nextToken,
      resetExpanded: options?.resetExpanded ?? true,
    });
    if (!this.isSupportedLeaf(leaf)) {
      this.removeOverlay(leaf);
      return;
    }
    const file = this.getLeafFile(leaf);
    if (!file || (file.extension !== "md" && file.extension !== "canvas")) {
      const activeLeaf = this.app.workspace.getMostRecentLeaf?.() || this.app.workspace.activeLeaf;
      if (activeLeaf === leaf) {
        this.scheduleLeafRefresh(leaf, { resetExpanded: false }, 250);
      }
      this.removeOverlay(leaf);
      return;
    }
    if (!this.settings.enabled) {
      this.removeOverlay(leaf);
      return;
    }

    const shouldResetExpanded = options?.resetExpanded ?? true;
    const prevFilePath = this.currentFileByLeaf.get(leaf);
    if (shouldResetExpanded || (prevFilePath && prevFilePath !== file.path)) {
      this.expandedPanels.delete(leaf);
    }
    this.currentFileByLeaf.set(leaf, file.path);

    // Get matching rules for this file
    const matchingRules = this.settings.rules.filter((rule) => this.shouldEmbedRule(rule, file));

    if (matchingRules.length === 0) {
      this.renderSignatureByLeaf.delete(leaf);
      this.removeOverlay(leaf);
      return;
    }

    // Initialize expanded set if it doesn't exist (new leaf or reset)
    if (!this.expandedPanels.has(leaf)) {
      const initialSet = new Set<string>();
      for (const rule of matchingRules) {
        const manualState = this.getManualExpansionState(rule.basePath);
        let shouldExpand = this.settings.defaultExpanded;
        if (rule.initialState === "expanded") shouldExpand = true;
        if (rule.initialState === "collapsed") shouldExpand = false;
        if (manualState !== null) shouldExpand = manualState;

        if (shouldExpand) {
          initialSet.add(rule.basePath);
        }
      }
      this.expandedPanels.set(leaf, initialSet);
    }

    // Exclude files check (global)
    const excludedFiles = this.parseList(this.settings.excludeFiles);
    if (excludedFiles.some((p) => normalizePath(p) === file.path)) {
      this.removeOverlay(leaf);
      return;
    }

    const container = this.ensureHost(leaf);
    if (!container) {
      this.scheduleLeafRefresh(leaf, { resetExpanded: false }, 250);
      return;
    }
    const renderSignature = this.buildRenderSignature(leaf, file, matchingRules);
    if (this.canReuseExistingRender(leaf, container, renderSignature, shouldResetExpanded)) {
      container.setAttribute("data-base-paths", matchingRules.map((r) => r.basePath).join(","));
      container.setAttribute("data-source-path", file.path);
      return;
    }
    const basePaths = matchingRules.map((r) => r.basePath);
    container.setAttribute("data-base-paths", basePaths.join(","));
    container.setAttribute("data-source-path", file.path);
    this.clearPanels(container);
    const expanded = this.getExpandedSet(leaf);
    for (const path of Array.from(expanded)) {
      if (!basePaths.includes(path)) expanded.delete(path);
    }

    for (const rule of matchingRules) {
      if (this.renderTokens.get(leaf) !== nextToken) return;
      if (file.path === rule.basePath) continue;
      const baseFile = this.app.vault.getAbstractFileByPath(rule.basePath);
      if (!(baseFile instanceof TFile)) continue;
      const panel = await this.buildPanel(leaf, baseFile, rule.basePath, file.path, view as any, nextToken);
      if (panel && this.renderTokens.get(leaf) === nextToken) {
        container.appendChild(panel);
      }
    }
    if (container.children.length === 0) {
      this.renderSignatureByLeaf.delete(leaf);
      this.removeOverlay(leaf);
      this.logScrollSnapshot("refresh-empty", leaf, file, { token: nextToken });
      return;
    }
    this.renderSignatureByLeaf.set(leaf, renderSignature);
    this.logScrollSnapshot("refresh-end", leaf, file, {
      token: nextToken,
      panels: container.children.length,
      signature: renderSignature,
    });
    window.setTimeout(() => {
      if (this.renderTokens.get(leaf) !== nextToken) return;
      this.logScrollSnapshot("refresh-settled-50ms", leaf, this.getLeafFile(leaf), {
        token: nextToken,
      });
    }, 50);
    window.setTimeout(() => {
      if (this.renderTokens.get(leaf) !== nextToken) return;
      this.logScrollSnapshot("refresh-settled-250ms", leaf, this.getLeafFile(leaf), {
        token: nextToken,
      });
    }, 250);
  }

  private ensureFloatingOverlay(leaf: WorkspaceLeaf): HTMLElement {
    let overlay = this.overlayByLeaf.get(leaf);
    if (overlay && overlay.isConnected) {
      overlay.setAttribute("data-render-mode", "floating");
      overlay.removeAttribute("data-inline-placement");
      return overlay;
    }

    const view = leaf.view;
    const viewContainer = (view as any).containerEl as HTMLElement | undefined;
    if (!viewContainer) return document.createElement("div");

    const leafContent = viewContainer.closest(".workspace-leaf-content") as HTMLElement | null;
    if (leafContent && getComputedStyle(leafContent).position === "static") {
      leafContent.style.position = "relative";
    }

    overlay = document.createElement("div");
    overlay.className = EMBED_CLASS;
    overlay.setAttribute("data-render-mode", "floating");
    overlay.innerHTML = "";
    const attachTarget = leafContent || viewContainer;
    attachTarget.appendChild(overlay);
    if (leafContent) {
      this.attachOverlayObserver(leaf, overlay, leafContent);
    }

    this.overlayByLeaf.set(leaf, overlay);
    return overlay;
  }

  private attachOverlayObserver(leaf: WorkspaceLeaf, overlay: HTMLElement, leafContent: HTMLElement): void {
    const existing = this.overlayObservers.get(leaf);
    if (existing) {
      existing.disconnect();
      this.overlayObservers.delete(leaf);
    }
    if (typeof ResizeObserver !== "function") return;
    let rafId: number | null = null;
    let lastHeight = 0;
    const update = () => {
      const rect = overlay.getBoundingClientRect();
      if (!rect.height || !Number.isFinite(rect.height)) return;
      const nextHeight = Math.ceil(rect.height);
      if (nextHeight === lastHeight) return;
      lastHeight = nextHeight;
      leafContent.style.setProperty("--tps-auto-base-embed-height", `${nextHeight}px`);
    };
    const observer = new ResizeObserver(() => {
      if (rafId != null) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        update();
      });
    });
    observer.observe(overlay);
    this.overlayObservers.set(leaf, observer);
    update();
  }

  private scheduleHeaderSync(leaf: WorkspaceLeaf): void {
    const lastTyping = this.lastTypingAt.get(leaf);
    if (lastTyping && Date.now() - lastTyping < 5000) return;
    if (!this.hasExpandedPanel(leaf)) return;
    const existing = this.headerSyncTimers.get(leaf);
    if (existing != null) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.headerSyncTimers.delete(leaf);
      this.syncLeafHeaders(leaf);
    }, 250);
    this.headerSyncTimers.set(leaf, timer);
  }

  private scheduleTypingRefresh(leaf: WorkspaceLeaf): void {
    this.lastTypingAt.set(leaf, Date.now());
  }

  private syncLeafHeaders(leaf: WorkspaceLeaf): void {
    const overlay = this.overlayByLeaf.get(leaf);
    if (!overlay?.isConnected) return;
    const panels = Array.from(overlay.querySelectorAll<HTMLElement>(`.${EMBED_CLASS}__panel`));
    for (const panel of panels) {
      if (panel.getAttribute(COLLAPSED_ATTR) === "true") continue;
      const contentEl = panel.querySelector<HTMLElement>(`.${EMBED_CLASS}__content`);
      if (contentEl) this.syncBaseHeader(contentEl, panel);
    }
  }

  private hasExpandedPanel(leaf: WorkspaceLeaf): boolean {
    const overlay = this.overlayByLeaf.get(leaf);
    if (!overlay?.isConnected) return false;
    const panels = Array.from(overlay.querySelectorAll<HTMLElement>(`.${EMBED_CLASS}__panel`));
    return panels.some((panel) => panel.getAttribute(COLLAPSED_ATTR) === "false");
  }

  private clearPanels(container: HTMLElement): void {
    const panels = Array.from(container.querySelectorAll<HTMLElement>(`.${EMBED_CLASS}__panel`));
    for (const panel of panels) {
      const headerObserver = this.headerObservers.get(panel);
      if (headerObserver) {
        headerObserver.disconnect();
        this.headerObservers.delete(panel);
      }
      panel.remove();
    }
    container.innerHTML = "";
  }

  private async buildPanel(
    leaf: WorkspaceLeaf,
    baseFile: TFile,
    basePath: string,
    sourcePath: string,
    view: any,
    renderToken: number
  ): Promise<HTMLElement | null> {
    if (this.renderTokens.get(leaf) !== renderToken) return null;
    const panel = document.createElement("div");
    panel.className = `${EMBED_CLASS}__panel`;
    const isExpanded = this.getExpandedSet(leaf).has(basePath);
    panel.setAttribute(COLLAPSED_ATTR, isExpanded ? "false" : "true");
    panel.setAttribute(RENDERING_ATTR, "true");
    panel.setAttribute("data-base-path", basePath);
    panel.innerHTML = `
      <div class="${EMBED_CLASS}__bar">
        <div class="${EMBED_CLASS}__bar-left">
          <div class="${EMBED_CLASS}__title">Related</div>
          <span class="${EMBED_CLASS}__count"></span>
        </div>
        <div class="${EMBED_CLASS}__bar-right">
          <button class="${EMBED_CLASS}__toggle" aria-label="Expand embedded base">▸</button>
        </div>
      </div>
      <div class="${EMBED_CLASS}__content"></div>
    `;

    const titleEl = panel.querySelector<HTMLElement>(`.${EMBED_CLASS}__title`);
    if (titleEl) {
      const headerTitle = await this.getBaseHeaderTitle(baseFile);
      titleEl.textContent = headerTitle;
    }

    const toggle = panel.querySelector<HTMLButtonElement>(`.${EMBED_CLASS}__toggle`);
    const bar = panel.querySelector<HTMLElement>(`.${EMBED_CLASS}__bar`);
    const contentEl = panel.querySelector<HTMLElement>(`.${EMBED_CLASS}__content`);
    const togglePanel = () => {
      const collapsed = panel.getAttribute(COLLAPSED_ATTR) === "true";

      // Accordion Mode: Collapse others if expanding
      if (collapsed && this.settings.accordionMode) {
        const container = panel.parentElement;
        if (container) {
          const neighbors = Array.from(container.querySelectorAll<HTMLElement>(`.${EMBED_CLASS}__panel`));
          const expandedSet = this.getExpandedSet(leaf);
          for (const neighbor of neighbors) {
            if (neighbor !== panel && neighbor.getAttribute(COLLAPSED_ATTR) === "false") {
              neighbor.setAttribute(COLLAPSED_ATTR, "true");
              const t = neighbor.querySelector(`.${EMBED_CLASS}__toggle`);
              if (t) t.textContent = "▸";

              const path = neighbor.getAttribute("data-base-path");
              if (path) expandedSet.delete(path);

              // Clean up observer
              const obs = this.headerObservers.get(neighbor);
              if (obs) {
                obs.disconnect();
                this.headerObservers.delete(neighbor);
              }
            }
          }
        }
      }

      panel.setAttribute(COLLAPSED_ATTR, collapsed ? "false" : "true");
      if (toggle) toggle.textContent = collapsed ? "▾" : "▸";
      const expandedSet = this.getExpandedSet(leaf);
      if (collapsed) {
        expandedSet.add(basePath);
        this.setManualExpansionState(basePath, true);
      } else {
        expandedSet.delete(basePath);
        this.setManualExpansionState(basePath, false);
      }
      if (contentEl) {
        if (collapsed) {
          this.attachHeaderObserver(leaf, contentEl, panel);
        } else {
          const existing = this.headerObservers.get(panel);
          if (existing) {
            existing.disconnect();
            this.headerObservers.delete(panel);
          }
        }
      }
    };
    if (toggle) {
      toggle.textContent = isExpanded ? "▾" : "▸";
      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        togglePanel();
      });
    }
    if (bar) {
      bar.addEventListener("click", (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest(`.${EMBED_CLASS}__toggle`)) return;
        if (target?.closest("button, a, input, textarea, select, [contenteditable='true']")) return;
        event.preventDefault();
        event.stopPropagation();
        togglePanel();
      });
    }
    if (!contentEl) return panel;
    contentEl.empty();
    const renderTarget = document.createElement("div");
    renderTarget.className = "markdown-preview-view markdown-rendered";
    renderTarget.setAttribute("data-mode", "preview");
    renderTarget.setAttribute("data-type", "markdown");
    contentEl.appendChild(renderTarget);

    await MarkdownRenderer.render(this.app, `![[${basePath}]]`, renderTarget, sourcePath, view);
    if (this.renderTokens.get(leaf) !== renderToken) return null;
    this.syncEmbeddedPanelMode(contentEl, panel);
    // Always capture the latest count once after render (even if collapsed)
    this.syncBaseCount(contentEl, panel);
    window.setTimeout(() => {
      if (this.renderTokens.get(leaf) !== renderToken) return;
      this.syncEmbeddedPanelMode(contentEl, panel);
      this.syncBaseCount(contentEl, panel);
    }, 250);
    window.setTimeout(() => {
      if (this.renderTokens.get(leaf) !== renderToken) return;
      this.syncEmbeddedPanelMode(contentEl, panel);
      this.syncBaseCount(contentEl, panel);
    }, 1000);
    this.pollForCount(leaf, contentEl, panel, renderToken);
    this.attachHeaderObserver(leaf, contentEl, panel);
    if (panel.getAttribute(COLLAPSED_ATTR) === "false") {
      // Extra sync passes to catch late results count updates
      window.setTimeout(() => {
        if (this.renderTokens.get(leaf) !== renderToken) return;
        this.syncBaseHeader(contentEl, panel);
        this.syncBaseCount(contentEl, panel);
      }, 250);
      window.setTimeout(() => {
        if (this.renderTokens.get(leaf) !== renderToken) return;
        this.syncBaseHeader(contentEl, panel);
        this.syncBaseCount(contentEl, panel);
      }, 1000);
    }

    // Keep rendering state until we capture a count (or polling exhausts) so Bases can fully mount.
    if (panel.getAttribute(COLLAPSED_ATTR) === "false") {
      panel.setAttribute(RENDERING_ATTR, "false");
    }

    // Guard: if this panel wasn't explicitly expanded by the user, keep it collapsed after initial render.
    if (!this.getExpandedSet(leaf).has(basePath)) {
      panel.setAttribute(COLLAPSED_ATTR, "true");
      if (toggle) toggle.textContent = "▸";
    }

    return panel;
  }

  private attachHeaderObserver(leaf: WorkspaceLeaf, contentEl: HTMLElement, panel: HTMLElement): void {
    const existing = this.headerObservers.get(panel);
    if (existing) {
      existing.disconnect();
      this.headerObservers.delete(panel);
    }
    const sync = () => {
      this.syncEmbeddedPanelMode(contentEl, panel);
      this.syncBaseHeader(contentEl, panel);
      this.syncBaseCount(contentEl, panel);
      if (panel.getAttribute(COLLAPSED_ATTR) === "true") {
        const cached = panel.getAttribute("data-last-count") || "";
        const parsedCached = this.extractCountValue(cached);
        if (cached && parsedCached !== 0) {
          const observer = this.headerObservers.get(panel);
          if (observer) {
            observer.disconnect();
            this.headerObservers.delete(panel);
          }
        }
      }
    };
    sync();
    if (typeof MutationObserver !== "function") return;
    const debouncedSync = this.debounce(() => sync(), 100);
    const observer = new MutationObserver(() => debouncedSync());
    observer.observe(contentEl, { childList: true, subtree: true, characterData: true, attributes: true });
    this.headerObservers.set(panel, observer);
  }

  private syncEmbeddedPanelMode(contentEl: HTMLElement, panel: HTMLElement): void {
    const calendarSelector = ".bases-calendar-wrapper, .calendar-embed-view, .fc";
    const isCalendarPanel = !!contentEl.querySelector<HTMLElement>(calendarSelector);
    panel.classList.toggle(`${EMBED_CLASS}__panel--calendar`, isCalendarPanel);
  }

  private syncBaseHeader(contentEl: HTMLElement, panel: HTMLElement): void {
    if (panel.getAttribute(COLLAPSED_ATTR) === "true") {
      this.syncBaseCount(contentEl, panel);
      return;
    }
    if (this.isInlinePanel(panel)) {
      this.syncBaseCount(contentEl, panel);
      return;
    }
    const barLeft = panel.querySelector<HTMLElement>(`.${EMBED_CLASS}__bar-left`);
    if (!barLeft) return;
    const baseHeader =
      contentEl.querySelector<HTMLElement>(".bases-view-header") ??
      contentEl.querySelector<HTMLElement>(".base-view-header") ??
      contentEl.querySelector<HTMLElement>(".bases-header") ??
      contentEl.querySelector<HTMLElement>(".view-header");
    if (!baseHeader) return;
    if (baseHeader.parentElement !== barLeft) {
      baseHeader.classList.add(`${EMBED_CLASS}__base-header`);
      barLeft.empty();
      barLeft.appendChild(baseHeader);
    }
    const duplicates = contentEl.querySelectorAll<HTMLElement>(
      ".bases-view-header, .base-view-header, .bases-header, .view-header"
    );
    duplicates.forEach((el) => {
      if (el !== baseHeader) {
        el.classList.add(`${EMBED_CLASS}__hidden-header`);
      }
    });
    this.syncBaseCount(contentEl, panel);
  }

  private syncBaseCount(contentEl: HTMLElement, panel: HTMLElement): void {
    const barLeft = panel.querySelector<HTMLElement>(`.${EMBED_CLASS}__bar-left`);
    if (!barLeft) return;
    const cached = panel.getAttribute("data-last-count") || "";
    const baseHeader =
      contentEl.querySelector<HTMLElement>(".bases-view-header") ??
      contentEl.querySelector<HTMLElement>(".base-view-header") ??
      contentEl.querySelector<HTMLElement>(".bases-header") ??
      contentEl.querySelector<HTMLElement>(".view-header");
    if (!baseHeader && !cached) return;
    const countText = this.resolveBestCountText(contentEl, baseHeader, cached);
    if (!countText) return;
    panel.setAttribute("data-last-count", countText);
    let badge = barLeft.querySelector<HTMLElement>(`.${EMBED_CLASS}__count`);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = `${EMBED_CLASS}__count`;
      barLeft.appendChild(badge);
    }
    if (badge.textContent !== countText) {
      badge.textContent = countText;
    }
    if (panel.getAttribute(RENDERING_ATTR) === "true") {
      panel.setAttribute(RENDERING_ATTR, "false");
    }
  }

  private resolveBestCountText(
    contentEl: HTMLElement,
    baseHeader: HTMLElement | null,
    cached: string,
  ): string {
    const selectors = [
      ".view-header-count",
      ".bases-view-results-count",
      ".bases-results-count",
      ".bases-view-result-count",
      ".bases-result-count",
      "[class*=\"results-count\"]",
      "[class*=\"result-count\"]",
      ".bases-view-results",
      ".bases-results",
      "[class*=\"results\"]",
      "[class*=\"result\"]",
    ];

    const seen = new Set<string>();
    const candidates: string[] = [];
    const pushCandidate = (raw: string | null | undefined) => {
      const value = String(raw || "").trim();
      if (!value || seen.has(value)) return;
      seen.add(value);
      candidates.push(value);
    };

    if (baseHeader) {
      for (const selector of selectors) {
        const nodes = Array.from(baseHeader.querySelectorAll<HTMLElement>(selector));
        for (const node of nodes) {
          pushCandidate(node.textContent);
        }
      }
      pushCandidate(baseHeader.textContent);
    }

    const embeddedHeaders = Array.from(
      contentEl.querySelectorAll<HTMLElement>(".bases-view-header, .base-view-header, .bases-header, .view-header"),
    );
    for (const header of embeddedHeaders) {
      for (const selector of selectors) {
        const nodes = Array.from(header.querySelectorAll<HTMLElement>(selector));
        for (const node of nodes) {
          pushCandidate(node.textContent);
        }
      }
      pushCandidate(header.textContent);
    }

    if (candidates.length === 0) {
      return cached;
    }

    // Prefer explicit "N results/items" candidates that are non-zero.
    const ranked = candidates
      .map((candidate) => ({
        raw: candidate,
        parsed: this.extractCountValue(candidate),
        hasLabel: /\b(results?|items?)\b/i.test(candidate),
      }))
      .filter((candidate) => candidate.parsed !== null);

    const nonZeroLabeled = ranked.find((candidate) => (candidate.parsed ?? 0) > 0 && candidate.hasLabel);
    if (nonZeroLabeled) return nonZeroLabeled.raw;

    const nonZeroAny = ranked.find((candidate) => (candidate.parsed ?? 0) > 0);
    if (nonZeroAny) return nonZeroAny.raw;

    const firstLabeled = ranked.find((candidate) => candidate.hasLabel);
    if (firstLabeled) {
      const cachedValue = this.extractCountValue(cached);
      const renderedFallback = this.resolveRenderedResultCount(contentEl);
      if ((firstLabeled.parsed ?? 0) === 0 && renderedFallback > 0) {
        return `${renderedFallback} results`;
      }
      if ((firstLabeled.parsed ?? 0) === 0 && (cachedValue ?? 0) > 0) {
        return cached;
      }
      return firstLabeled.raw;
    }

    const renderedFallback = this.resolveRenderedResultCount(contentEl);
    if (renderedFallback > 0) {
      return `${renderedFallback} results`;
    }
    return cached || candidates[0];
  }

  private resolveRenderedResultCount(contentEl: HTMLElement): number {
    // Kanban: lane count badges are the most reliable built-in counters in this view.
    const laneCounts = Array.from(contentEl.querySelectorAll<HTMLElement>(".bases-kanban-column-count"));
    if (laneCounts.length > 0) {
      const total = laneCounts.reduce((sum, el) => {
        const parsed = this.extractCountValue(el.textContent || "");
        return sum + (parsed ?? 0);
      }, 0);
      if (total > 0) return total;
    }

    // Calendar fallback: count rendered events.
    const calendarEvents = contentEl.querySelectorAll(
      ".fc-event:not(.fc-event-mirror):not(.bases-calendar-external-drop-preview)",
    );
    if (calendarEvents.length > 0) {
      return calendarEvents.length;
    }

    return 0;
  }

  private extractCountValue(raw: string | null | undefined): number | null {
    const value = String(raw || "").trim();
    if (!value) return null;
    const match = value.match(/\b(\d+)\b/);
    if (!match) return null;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private pollForCount(
    leaf: WorkspaceLeaf,
    contentEl: HTMLElement,
    panel: HTMLElement,
    renderToken: number,
    attempts = 0
  ): void {
    if (this.renderTokens.get(leaf) !== renderToken) return;
    const cached = panel.getAttribute("data-last-count") || "";
    const parsedCached = this.extractCountValue(cached);
    if (cached && parsedCached !== 0) {
      if (panel.getAttribute(RENDERING_ATTR) === "true") {
        panel.setAttribute(RENDERING_ATTR, "false");
      }
      return;
    }
    if (attempts >= 10) {
      if (panel.getAttribute(RENDERING_ATTR) === "true") {
        panel.setAttribute(RENDERING_ATTR, "false");
      }
      return;
    }
    window.setTimeout(() => {
      if (this.renderTokens.get(leaf) !== renderToken) return;
      this.syncBaseCount(contentEl, panel);
      this.pollForCount(leaf, contentEl, panel, renderToken, attempts + 1);
    }, 400);
  }

  private removeOverlay(leaf: WorkspaceLeaf): void {
    const retryTimer = this.leafRetryTimers.get(leaf);
    if (retryTimer != null) {
      window.clearTimeout(retryTimer);
      this.leafRetryTimers.delete(leaf);
    }
    this.renderSignatureByLeaf.delete(leaf);
    const observer = this.overlayObservers.get(leaf);
    if (observer) {
      observer.disconnect();
      this.overlayObservers.delete(leaf);
    }
    const overlay = this.overlayByLeaf.get(leaf);
    if (overlay?.isConnected) {
      this.clearPanels(overlay);
      const view = leaf.view as any;
      const viewContainer = (view as any).containerEl as HTMLElement | undefined;
      const leafContent = viewContainer?.closest?.(".workspace-leaf-content") as HTMLElement | null;
      leafContent?.style.removeProperty("--tps-auto-base-embed-height");
      overlay.remove();
    }
    this.overlayByLeaf.delete(leaf);
  }

  private async getBaseHeaderTitle(baseFile: TFile): Promise<string> {
    const cache = this.app.metadataCache.getFileCache(baseFile);
    const heading = cache?.headings?.[0]?.heading;
    if (heading && heading.trim().length > 0) {
      return heading.trim();
    }
    try {
      const text = await this.app.vault.cachedRead(baseFile);
      const markdownHeading = text.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/m);
      if (markdownHeading?.[1]) {
        return markdownHeading[1].trim();
      }
      const baseTitle = this.extractBaseTitle(text);
      if (baseTitle) return baseTitle;
    } catch {
      // ignore read errors, fallback to basename
    }
    return baseFile.basename;
  }

  private extractBaseTitle(text: string): string | null {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line || /^\s/.test(line)) continue;
      const match = line.match(/^(title|name):\s*(.+)$/i);
      if (match?.[2]) return match[2].trim();
      if (line.trim() === "views:") break;
    }

    let inViews = false;
    let inView = false;
    for (const line of lines) {
      if (!inViews) {
        if (line.trim() === "views:") {
          inViews = true;
        }
        continue;
      }
      if (!line) continue;
      if (/^\S/.test(line) && line.trim() !== "-") {
        break;
      }
      if (/^\s*-\s+type:/.test(line)) {
        inView = true;
        continue;
      }
      if (inView) {
        const match = line.match(/^\s+name:\s*(.+)$/);
        if (match?.[1]) return match[1].trim();
      }
    }
    return null;
  }

  private injectStyles(): void {
    if (this.styleEl) return;
    const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
      .${EMBED_CLASS} {
        width: 100%;
        max-width: 100%;
        pointer-events: auto;
        --tps-auto-base-embed-gap: 12px;
        font-size: calc(var(--font-text-size) * 0.72);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .${EMBED_CLASS}[data-render-mode="floating"] {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        bottom: calc(var(--tps-auto-base-embed-bottom, 16px) + env(safe-area-inset-bottom, 0px));
        z-index: 5;
      }
      .${EMBED_CLASS}[data-render-mode="inline"] {
        position: relative;
        left: auto;
        transform: none;
        bottom: auto;
        z-index: 0;
        margin: 14px 0 0;
        padding-top: 12px;
        border-top: 1px solid var(--background-modifier-border);
      }
      .${EMBED_CLASS}[data-render-mode="inline"][data-inline-placement="after-title"] {
        margin-top: 10px;
        padding-top: 10px;
      }
      .${EMBED_CLASS}[data-render-mode="inline"][data-inline-placement="after-content"] {
        margin-top: 18px;
        margin-bottom: 10px;
      }
      .${EMBED_CLASS}[data-render-mode="inline"].${EMBED_CLASS}--cm-inline {
        display: block;
        width: 100%;
        max-width: 100%;
        white-space: normal;
        padding: 0;
      }
      .markdown-view.is-readable-line-width .${EMBED_CLASS},
      .markdown-source-view.is-readable-line-width .${EMBED_CLASS},
      .markdown-preview-view.is-readable-line-width .${EMBED_CLASS},
      body.tps-readable-line-width .${EMBED_CLASS},
      body.is-readable-line-width .${EMBED_CLASS} {
        width: min(100%, var(--file-line-width));
        max-width: var(--file-line-width);
      }
      body.is-mobile .${EMBED_CLASS},
      body.is-phone .${EMBED_CLASS} {
        --tps-auto-base-embed-gap: 6px;
        font-size: calc(var(--font-text-size) * 0.62);
        gap: 6px;
      }
      body.is-mobile .${EMBED_CLASS}[data-render-mode="floating"],
      body.is-phone .${EMBED_CLASS}[data-render-mode="floating"] {
        --tps-auto-base-embed-bottom: 50px;
      }
      .tps-auto-base-embed-hidden-for-keyboard .${EMBED_CLASS}[data-render-mode="floating"],
      .tps-context-hidden-for-keyboard .${EMBED_CLASS}[data-render-mode="floating"] {
        visibility: hidden;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease, visibility 0.15s ease;
      }
      .tps-context-hidden-for-modal .${EMBED_CLASS}[data-render-mode="floating"] {
        visibility: hidden;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease, visibility 0.15s ease;
      }
      .${EMBED_CLASS} {
        transition: opacity 0.15s ease, visibility 0.15s ease;
      }
      .${EMBED_CLASS}__panel {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .${EMBED_CLASS}__bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 4px 8px;
        border-radius: 10px;
        background: rgba(15, 20, 26, 0.26);
        border: 1px solid var(--background-modifier-border);
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
      }
      body.is-mobile .${EMBED_CLASS}__bar,
      body.is-phone .${EMBED_CLASS}__bar {
        padding: 3px 6px;
        border-radius: 7px;
      }
      .${EMBED_CLASS}__bar-left {
        display: flex;
        align-items: center;
        flex: 1 1 auto;
        min-width: 0;
      }
      .${EMBED_CLASS}__bar-right {
        flex: 0 0 auto;
      }
      .${EMBED_CLASS}__title {
        font-size: 0.78em;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--text-muted);
      }
      .${EMBED_CLASS}__count {
        margin-left: 8px;
        font-size: 0.72em;
        color: var(--text-muted);
        white-space: nowrap;
      }
      body.is-mobile .${EMBED_CLASS}__title,
      body.is-phone .${EMBED_CLASS}__title {
        font-size: 0.7em;
      }
      .${EMBED_CLASS}__toggle {
        background: var(--interactive-normal);
        border: 1px solid var(--background-modifier-border);
        color: var(--text-normal);
        border-radius: 8px;
        padding: 0.15em 0.5em;
        line-height: 1.1;
        cursor: pointer;
      }
      body.is-mobile .${EMBED_CLASS}__toggle,
      body.is-phone .${EMBED_CLASS}__toggle {
        border-radius: 5px;
        padding: 0.12em 0.45em;
      }
      .${EMBED_CLASS}__content {
        background: var(--background-secondary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.35);
        padding: 8px 10px 10px;
        max-height: 36vh;
        overflow: auto;
      }
      body.is-mobile .${EMBED_CLASS}__content,
      body.is-phone .${EMBED_CLASS}__content {
        padding: 6px 8px 8px;
        border-radius: 7px;
        max-height: 24vh;
      }
      .${EMBED_CLASS}[data-render-mode="inline"] .${EMBED_CLASS}__bar {
        background: transparent;
        border: none;
        border-radius: 0;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        box-shadow: none;
        padding: 0 0 6px 0;
      }
      .${EMBED_CLASS}[data-render-mode="inline"] .${EMBED_CLASS}__content {
        background: transparent;
        border: none;
        border-radius: 0;
        max-height: none;
        overflow: visible;
        box-shadow: none;
        padding: 0;
      }
      body.is-mobile .${EMBED_CLASS}[data-render-mode="inline"] .${EMBED_CLASS}__content,
      body.is-phone .${EMBED_CLASS}[data-render-mode="inline"] .${EMBED_CLASS}__content {
        max-height: none;
      }
      .${EMBED_CLASS}__panel[${COLLAPSED_ATTR}="true"] .${EMBED_CLASS}__content {
        max-height: 0;
        opacity: 0;
        overflow: hidden;
        padding: 0;
        margin: 0;
        pointer-events: none;
        transition: max-height 0.2s ease, opacity 0.2s ease;
      }
      .${EMBED_CLASS}__panel[${COLLAPSED_ATTR}="false"] .${EMBED_CLASS}__content {
        max-height: 60vh;
        opacity: 1;
        transition: max-height 0.25s ease, opacity 0.2s ease;
      }
      .${EMBED_CLASS}__panel--calendar .${EMBED_CLASS}__content {
        max-height: none;
        overflow: hidden;
      }
      .${EMBED_CLASS}__panel[${RENDERING_ATTR}="true"] .${EMBED_CLASS}__content {
        display: block;
        position: absolute;
        left: -9999px;
        top: -9999px;
        width: 60vw;
        max-height: none;
        overflow: hidden;
        visibility: hidden;
      }
      .${EMBED_CLASS}__panel[${COLLAPSED_ATTR}="true"] .${EMBED_CLASS}__bar {
        margin-bottom: 0;
      }
      .${EMBED_CLASS}__content .markdown-preview-view,
      .${EMBED_CLASS}__content .markdown-source-view {
        padding: 0;
        margin: 0;
      }
      .${EMBED_CLASS}__base-header {
        width: 100%;
        margin: 0;
        padding: 0;
        border: none;
        background: transparent;
        box-shadow: none;
      }
      .${EMBED_CLASS}__base-header .view-header-title-container {
        padding: 0;
      }
      .${EMBED_CLASS}__base-header .bases-view-results-count,
      .${EMBED_CLASS}__base-header .bases-results-count,
      .${EMBED_CLASS}__base-header .bases-view-result-count,
      .${EMBED_CLASS}__base-header .bases-result-count,
      .${EMBED_CLASS}__base-header .bases-view-results,
      .${EMBED_CLASS}__base-header .bases-results,
      .${EMBED_CLASS}__base-header .view-header-count,
      .${EMBED_CLASS}__base-header [class*="results-count"],
      .${EMBED_CLASS}__base-header [class*="result-count"],
      .${EMBED_CLASS}__base-header [class*="results"],
      .${EMBED_CLASS}__base-header [class*="result"] {
        display: none !important;
      }
      .${EMBED_CLASS}__hidden-header {
        display: none !important;
      }
      /* Settings styles */
      .tps-auto-base-embed-rules {
        margin: 16px 0;
      }
      .tps-auto-base-embed-rule {
        border: 1px solid var(--background-modifier-border);
        border-radius: 8px;
        margin-bottom: 12px;
        background: var(--background-secondary);
      }
      .tps-auto-base-embed-rule-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        cursor: pointer;
      }
      .tps-auto-base-embed-rule-header:hover {
        background: var(--background-modifier-hover);
      }
      .tps-auto-base-embed-rule-toggle {
        flex-shrink: 0;
      }
      .tps-auto-base-embed-rule-path {
        flex: 1;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .tps-auto-base-embed-rule-summary {
        font-size: 0.85em;
        color: var(--text-muted);
      }
      .tps-auto-base-embed-rule-actions {
        display: flex;
        gap: 4px;
      }
      .tps-auto-base-embed-rule-body {
        padding: 12px;
        border-top: 1px solid var(--background-modifier-border);
      }
      .tps-auto-base-embed-rule-body.hidden {
        display: none;
      }
      .tps-auto-base-embed-condition-group {
        margin-bottom: 12px;
      }
      .tps-auto-base-embed-condition-group h4 {
        margin: 0 0 6px 0;
        font-size: 0.9em;
        color: var(--text-muted);
      }
      .tps-auto-base-embed-condition-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .tps-auto-base-embed-tag {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        background: var(--background-primary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 12px;
        font-size: 0.85em;
      }
      .tps-auto-base-embed-tag button {
        background: none;
        border: none;
        padding: 0;
        cursor: pointer;
        color: var(--text-muted);
      }
      .tps-auto-base-embed-add-btn {
        font-size: 0.85em;
        padding: 2px 8px;
      }
    `;
    document.head.appendChild(style);
    this.styleEl = style;
  }

  private setupKeyboardDetection(): void {
    this.keyboardBaseHeight = window.visualViewport?.height || window.innerHeight;

    const handleResize = this.debounce(() => {
      const viewportHeight = window.visualViewport?.height || window.innerHeight;

      if (viewportHeight > this.keyboardBaseHeight) {
        this.keyboardBaseHeight = viewportHeight;
      }

      const isMobile =
        window.innerWidth < 768 ||
        document.body.classList.contains("is-mobile") ||
        document.body.classList.contains("is-phone");

      if (!isMobile) {
        if (this.keyboardHidden) {
          document.body.classList.remove("tps-auto-base-embed-hidden-for-keyboard");
          this.keyboardHidden = false;
        }
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement?.closest(`.${EMBED_CLASS}`)) {
        if (this.keyboardHidden) {
          document.body.classList.remove("tps-auto-base-embed-hidden-for-keyboard");
          this.keyboardHidden = false;
        }
        return;
      }

      const isFocusInEditor = !!activeElement && (
        activeElement.classList.contains("cm-content") ||
        activeElement.tagName === "TEXTAREA" ||
        activeElement.tagName === "INPUT" ||
        (activeElement as HTMLElement).isContentEditable ||
        !!activeElement.closest(".markdown-source-view") ||
        !!activeElement.closest(".cm-editor")
      );

      const keyboardVisible = this.keyboardBaseHeight - viewportHeight > 120;
      const shouldHide = keyboardVisible || (isMobile && isFocusInEditor);

      if (shouldHide !== this.keyboardHidden) {
        this.keyboardHidden = shouldHide;
        document.body.classList.toggle("tps-auto-base-embed-hidden-for-keyboard", shouldHide);
      }
    }, 300);

    this.keyboardResizeHandler = handleResize;
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", handleResize);
    }

    this.keyboardFocusHandler = () => {
      if (this.keyboardResizeHandler) this.keyboardResizeHandler();
    };
    document.addEventListener("focusin", this.keyboardFocusHandler, true);
    document.addEventListener("focusout", this.keyboardFocusHandler, true);

    this.keyboardWindowResizeHandler = () => {
      if (this.keyboardResizeHandler) this.keyboardResizeHandler();
    };
    window.addEventListener("resize", this.keyboardWindowResizeHandler);

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        setTimeout(() => this.keyboardResizeHandler?.(), 200);
      })
    );

    // Initial state check
    setTimeout(() => this.keyboardResizeHandler?.(), 200);
  }

  private teardownKeyboardDetection(): void {
    if (this.keyboardResizeHandler && window.visualViewport) {
      window.visualViewport.removeEventListener("resize", this.keyboardResizeHandler);
    }
    if (this.keyboardFocusHandler) {
      document.removeEventListener("focusin", this.keyboardFocusHandler, true);
      document.removeEventListener("focusout", this.keyboardFocusHandler, true);
    }
    if (this.keyboardWindowResizeHandler) {
      window.removeEventListener("resize", this.keyboardWindowResizeHandler);
    }
    this.keyboardResizeHandler = null;
    this.keyboardFocusHandler = null;
    this.keyboardWindowResizeHandler = null;
    this.keyboardHidden = false;
    document.body.classList.remove("tps-auto-base-embed-hidden-for-keyboard");
  }

  private setupModalVisibilityWatcher(): void {
    const updateModalState = () => {
      const isVisibleElement = (el: Element): boolean => {
        if (!(el instanceof HTMLElement)) return false;
        if (el.closest(`.${EMBED_CLASS}`)) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (style.opacity === "0") return false;
        return el.getClientRects().length > 0;
      };

      const modalSelectors = [
        ".modal-container",
        ".modal",
        ".datepicker",
        ".date-picker",
        ".calendar-modal",
        ".datepicker-container",
      ];
      const popoverSelectors = [".popover", ".popover-content", ".popover-bg", ".suggestion-container"];

      const hasModal = modalSelectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some((el) => isVisibleElement(el))
      );
      if (hasModal) {
        document.body.classList.toggle("tps-context-hidden-for-modal", true);
        return;
      }

      const hasPopover = popoverSelectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some((el) => isVisibleElement(el))
      );
      document.body.classList.toggle("tps-context-hidden-for-modal", hasPopover);
    };

    updateModalState();
    this.modalObserver = new MutationObserver(() => updateModalState());
    this.modalObserver.observe(document.body, { childList: true, subtree: true });
  }

  private parseList(raw: string): string[] {
    return raw
      .split(/[,\n]/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
}
