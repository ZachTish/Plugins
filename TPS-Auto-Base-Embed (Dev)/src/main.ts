import {
  Plugin,
  MarkdownRenderer,
  TFile,
  normalizePath,
  WorkspaceLeaf,
  MarkdownView,
} from "obsidian";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { AutoBaseEmbedSettingTab } from "./settings-tab";
import * as logger from "./logger";
import {
  DEFAULT_SETTINGS,
  sanitizeAutoBaseEmbedSettings,
  type AutoBaseEmbedSettings,
  type BaseEmbedConditions,
  type BaseEmbedRule,
  type EmbedRuleKind,
  type RuleRenderPlacement,
} from './settings-model';

const EMBED_CLASS = "tps-auto-base-embed";
const STYLE_ID = "tps-auto-base-embed-style";
const INLINE_ANCHOR_CLASS = "tps-auto-base-embed-anchor";
const INLINE_SECTION_CLASS = "tps-auto-base-embed-inline-section";
const SOURCE_END_WIDGET_CLASS = 'tps-auto-base-embed-source-end-widget';
const SOURCE_END_HOST_CLASS = 'tps-auto-base-embed-source-end-host';
const COLLAPSED_ATTR = "data-tps-auto-base-embed-collapsed";
const RENDERING_ATTR = "data-tps-auto-base-embed-rendering";
const BUILD_STAMP = "2026-03-15T23:05:00Z";
const REFRESH_COOLDOWN_MS = 1500;

class SourceEndEmbedWidget extends WidgetType {
  constructor(private readonly filePath: string) {
    super();
  }

  eq(other: SourceEndEmbedWidget): boolean {
    return other.filePath === this.filePath;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = SOURCE_END_WIDGET_CLASS;
    wrapper.dataset.filePath = this.filePath;

    const host = document.createElement('div');
    host.className = SOURCE_END_HOST_CLASS;
    host.dataset.filePath = this.filePath;
    host.dataset.inlinePlacement = 'after-content';
    wrapper.appendChild(host);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ============ Plugin ============

export default class AutoBaseEmbedPlugin extends Plugin {
  settings: AutoBaseEmbedSettings;
  private editorExtension = this.createEditorExtension();
  private hostEntriesByLeaf = new WeakMap<WorkspaceLeaf, Map<RuleRenderPlacement, HTMLElement>>();
  private inlineAnchorsByLeaf = new WeakMap<WorkspaceLeaf, Map<Exclude<RuleRenderPlacement, "floating">, HTMLElement>>();
  private overlayObservers = new WeakMap<WorkspaceLeaf, ResizeObserver>();
  private headerObservers = new WeakMap<HTMLElement, MutationObserver>();
  private contentObservers = new WeakMap<WorkspaceLeaf, MutationObserver>();
  private renderTokens = new WeakMap<WorkspaceLeaf, number>();
  private renderSignatureByLeaf = new WeakMap<WorkspaceLeaf, string>();
  private lastRefreshMetaByLeaf = new WeakMap<WorkspaceLeaf, { signature: string; at: number }>();
  private expandedPanels = new WeakMap<WorkspaceLeaf, Set<string>>();
  private activeTabsByLeaf = new WeakMap<WorkspaceLeaf, Map<RuleRenderPlacement, string>>();
  private currentFileByLeaf = new WeakMap<WorkspaceLeaf, string>();
  private headerSyncTimers = new WeakMap<WorkspaceLeaf, number>();
  private titleReattachObservers = new WeakMap<WorkspaceLeaf, MutationObserver>();
  private typingRefreshTimers = new WeakMap<WorkspaceLeaf, number>();
  private leafRetryTimers = new WeakMap<WorkspaceLeaf, number>();
  private refreshInFlight = new WeakSet<WorkspaceLeaf>();
  private pendingRefreshByLeaf = new WeakMap<WorkspaceLeaf, { resetExpanded?: boolean }>();
  private lastTypingAt = new WeakMap<WorkspaceLeaf, number>();
  private styleEl: HTMLStyleElement | null = null;
  private keyboardResizeHandler: (() => void) | null = null;
  private keyboardFocusHandler: (() => void) | null = null;
  private keyboardWindowResizeHandler: (() => void) | null = null;
  private keyboardBaseHeight: number = window.innerHeight;
  private keyboardHidden: boolean = false;
  private modalObserver: MutationObserver | null = null;
  private panelEmbeds = new WeakMap<HTMLElement, any>();
  private dataviewTaskObservers = new WeakMap<HTMLElement, MutationObserver>();
  private lastEditorFocused: boolean = false;
  private queuedRefreshAllTimer: number | null = null;
  private queuedRefreshAllOptions: { resetExpanded?: boolean } | null = null;
  private swipeCollapsed = false;
  private scrollHideListeners = new Map<WorkspaceLeaf, { scroller: HTMLElement; listener: () => void; lastTop: number; accum: number }>();

  // ── Canvas node embed state ──────────────────────────────────────────────
  /** Per-canvas-leaf data: overlay map, expanded state, MutationObserver. */
  private canvasLeafData = new Map<WorkspaceLeaf, {
    observer: MutationObserver | null;
    nodeOverlays: Map<HTMLElement, HTMLElement>; // nodeEl → overlay container
    nodeExpanded: Map<HTMLElement, Set<string>>; // nodeEl → expanded basePaths
    nodeActiveTabs: Map<HTMLElement, string>;    // nodeEl → active rule key
    nodeSig: Map<HTMLElement, string>;           // nodeEl → last render signature
  }>();
  /** Guards against concurrent scans for the same node element. */
  private canvasNodeBuilding = new WeakSet<HTMLElement>();
  private canvasScanTimers = new Map<WorkspaceLeaf, number>();

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
    this.debugInfo("[TPS Auto Base Embed] [Scroll]", {
      stage,
      file: file?.path ?? null,
      renderMode: this.getEffectiveRenderMode(leaf),
      inlinePlacement: this.settings.inlinePlacement,
      snapshot,
      ...extra,
    });
  }

  private debugInfo(message: string, ...args: unknown[]): void {
    logger.info(message, ...args);
  }

  private debugWarn(message: string, ...args: unknown[]): void {
    logger.warn(message, ...args);
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.clearAllOverlaysFromDom();
    this.debugInfo(`[TPS Auto Base Embed] Loaded build ${BUILD_STAMP}`);

    this.addSettingTab(new AutoBaseEmbedSettingTab(this.app, this));
    this.registerEditorExtension(this.editorExtension);
    this.injectStyles();
    this.updateBottomObstructionOffset();
    this.setupKeyboardDetection();
    this.setupModalVisibilityWatcher();

    const debouncedRefresh = this.debounce((options?: { resetExpanded?: boolean }) => {
      this.runOrQueueRefreshAll({ resetExpanded: options?.resetExpanded ?? false });
    }, 100);

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf) {
          void this.refreshLeaf(leaf, { resetExpanded: false });
          this.scheduleLeafStabilizationRefreshes(leaf, { resetExpanded: false });
        }
        this.flushPendingRefreshAll({ resetExpanded: false });
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        // Skip if every supported leaf already has a freshly-rendered connected host.
        // Rendering an inline embed triggers layout-change on the reading view;
        // acting on it would start a render → layout-change → render loop.
        const leaves = this.getSupportedLeaves();
        const allFresh = leaves.length > 0 && leaves.every((leaf) => {
          const hosts = this.getAllHostsForLeaf(leaf).map(([, host]) => host).filter((host) => host?.isConnected);
          if (hosts.length === 0) return false;
          if (!hosts.some((host) => this.hasRenderableHost(host))) return false;
          const lastRender = this.lastRefreshMetaByLeaf.get(leaf);
          return !!lastRender && Date.now() - lastRender.at < REFRESH_COOLDOWN_MS;
        });
        if (!allFresh) debouncedRefresh();
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
          void this.refreshLeaf(leaf, { resetExpanded: false });
          this.scheduleLeafStabilizationRefreshes(leaf, { resetExpanded: false });
          this.flushPendingRefreshAll({ resetExpanded: false });
          return;
        }
        debouncedRefresh();
      })
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", (view) => {
        const leaf = (view as any)?.leaf as WorkspaceLeaf | undefined;
        if (!leaf) return;
        if (this.isEditorFocused() && !this.hasAfterContentRulesForLeaf(leaf)) return;
        this.scheduleTypingRefresh(leaf);
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
          // MarkdownRenderer.render(…, sourcePath) causes Obsidian to register a
          // virtual embed from the source file, which fires metadataCache.changed
          // for that same file. Guard against this render-triggered noise by
          // ignoring changes that arrive within the post-render cooldown window.
          const lastRender = this.lastRefreshMetaByLeaf.get(activeLeaf);
          if (lastRender && Date.now() - lastRender.at < REFRESH_COOLDOWN_MS) return;
          this.scheduleTypingRefresh(activeLeaf);
          this.scheduleLeafRefresh(activeLeaf, { resetExpanded: false }, 250);
          return;
        }
        if (file) {
          const impactedLeaves = this.getLeavesImpactedByFile(file.path);
          if (impactedLeaves.length > 0) {
            for (const leaf of impactedLeaves) {
              // Same guard: skip base-file metadata changes that arise from rendering.
              const lastRender = this.lastRefreshMetaByLeaf.get(leaf);
              if (lastRender && Date.now() - lastRender.at < REFRESH_COOLDOWN_MS) continue;
              this.scheduleLeafRefresh(leaf, { resetExpanded: false }, 250);
            }
            return;
          }
        }
        // Ignore unrelated vault churn. Broad refreshes here cause inline embeds to rerender constantly.
      })
    );

    this.registerDomEvent(document, "focusout", () => {
      window.setTimeout(() => this.flushPendingRefreshAll({ resetExpanded: false }), 120);
    }, true);

    this.registerDomEvent(document, "dragstart", (event: DragEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest(`.${EMBED_CLASS}`)) return;
      if (
        target.closest(".tps-kanban-card") ||
        target.closest(".tps-calendar-entry") ||
        target.closest(".fc-event") ||
        target.closest("[data-tps-task-context='true']")
      ) {
        return;
      }
      const filePath = this.extractEmbeddableFilePath(target);
      if (!filePath || !event.dataTransfer) return;
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("obsidian/file", filePath);
      event.dataTransfer.setData("text/plain", filePath);
      event.dataTransfer.setData("text/uri-list", `obsidian://open?file=${encodeURIComponent(filePath)}`);
    }, { capture: true });

    // Avoid focus-based flushes to reduce typing lag; rely on leaf/file changes.

    this.registerInterval(
      window.setInterval(() => {
        this.checkAndReattachOverlays();
        if (this.settings.enableCanvasNodeEmbeds) {
          for (const leaf of this.canvasLeafData.keys()) {
            this.scheduleCanvasScan(leaf);
          }
        }
      }, 2000)
    );

    // Force a clean first render on startup even if editor focus is active.
    this.refreshAllSupportedViews({ resetExpanded: true });

    // Start canvas-node embed watchers after layout is ready.
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.enableCanvasNodeEmbeds) {
        this.app.workspace.getLeavesOfType("canvas").forEach(leaf => this.startCanvasLeafWatcher(leaf));
      }
    });

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (!this.settings.enableCanvasNodeEmbeds) return;
        const currentCanvasLeaves = this.app.workspace.getLeavesOfType("canvas");
        // Start watchers for new canvas leaves
        currentCanvasLeaves.forEach(leaf => {
          if (!this.canvasLeafData.has(leaf)) this.startCanvasLeafWatcher(leaf);
        });
        // Stop watchers for canvas leaves that no longer exist
        for (const leaf of this.canvasLeafData.keys()) {
          if (!currentCanvasLeaves.includes(leaf)) this.stopCanvasLeafWatcher(leaf);
        }
      })
    );
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

  private extractEmbeddableFilePath(target: HTMLElement): string | null {
    const sourceEl = target.closest<HTMLElement>("[data-href], a.internal-link, .internal-link");
    if (!sourceEl) return null;

    const candidateValues = [
      sourceEl.getAttribute("data-href"),
      sourceEl.getAttribute("href"),
      sourceEl.getAttribute("aria-label"),
      sourceEl.textContent,
    ];

    for (const rawValue of candidateValues) {
      const raw = String(rawValue || "").trim();
      if (!raw) continue;
      const cleaned = raw
        .replace(/^obsidian:\/\/open\?file=/i, "")
        .replace(/^#/, "")
        .split("|")[0]
        .trim();
      if (!cleaned) continue;
      const decoded = decodeURIComponent(cleaned);
      const candidatePath = decoded.endsWith(".md") ? decoded : `${decoded}.md`;
      const abstract = this.app.vault.getAbstractFileByPath(candidatePath);
      if (abstract instanceof TFile && abstract.extension === "md") {
        return abstract.path;
      }
    }

    return null;
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
        if (this.refreshInFlight.has(leaf)) return;
        const existingHost = this.getAllHostsForLeaf(leaf)[0]?.[1];
        const currentFile = this.getLeafFile(leaf);
        const sameSource = existingHost?.getAttribute("data-source-path") === currentFile?.path;
        const hasPanel = !!existingHost?.querySelector(`.${EMBED_CLASS}__panel`);
        const hasRenderingPanel = !!existingHost?.querySelector(`.${EMBED_CLASS}__panel[${RENDERING_ATTR}="true"]`);
        if (
          Array.from(this.getAllHostsForLeaf(leaf)).some(([placement]) => placement !== 'floating')
          && existingHost?.isConnected
          && sameSource
          && (hasPanel || hasRenderingPanel)
        ) {
          return;
        }
        const activeLeaf = this.app.workspace.getMostRecentLeaf?.() || this.app.workspace.activeLeaf;
        if (activeLeaf !== leaf && !this.getAllHostsForLeaf(leaf).some(([, host]) => host?.isConnected)) return;
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

  private getActiveTabMap(leaf: WorkspaceLeaf): Map<RuleRenderPlacement, string> {
    let existing = this.activeTabsByLeaf.get(leaf);
    if (!existing) {
      existing = new Map<RuleRenderPlacement, string>();
      this.activeTabsByLeaf.set(leaf, existing);
    }
    return existing;
  }

  private getActiveTabForPlacement(leaf: WorkspaceLeaf, placement: RuleRenderPlacement): string | null {
    return this.activeTabsByLeaf.get(leaf)?.get(placement) ?? null;
  }

  private setActiveTabForPlacement(leaf: WorkspaceLeaf, placement: RuleRenderPlacement, ruleKey: string): void {
    this.getActiveTabMap(leaf).set(placement, ruleKey);
  }

  private checkAndReattachOverlays(): void {
    if (!this.settings.enabled) return;
    const leaves = this.getSupportedLeaves();
    for (const leaf of leaves) {
      let needsRefresh = false;
      for (const [placement, overlay] of this.getAllHostsForLeaf(leaf)) {
        if (!overlay?.isConnected) {
          this.deleteHostForPlacement(leaf, placement);
          needsRefresh = true;
          continue;
        }
        if (placement === 'floating') {
          const view = leaf.view as any;
          const viewContainer = view?.containerEl as HTMLElement | undefined;
          const leafContent = viewContainer?.closest?.(".workspace-leaf-content") as HTMLElement | null;
          const attachTarget = leafContent || viewContainer || null;
          if (!attachTarget || overlay.parentElement !== attachTarget) {
            needsRefresh = true;
          }
          continue;
        }
        const mountTarget = this.resolveInlineMountTarget(leaf, placement);
        if (!mountTarget || overlay.parentElement !== mountTarget.parent || overlay.nextSibling !== mountTarget.before) {
          needsRefresh = true;
        }
      }
      if (needsRefresh) {
        this.logScrollSnapshot("reattach-refresh", leaf, this.getLeafFile(leaf), { reason: "host-mismatch" });
        void this.refreshLeaf(leaf, { resetExpanded: false });
        continue;
      }
      const floatingOverlay = this.getHostForPlacement(leaf, 'floating');
      if (floatingOverlay?.isConnected) {
        const view = leaf.view as any;
        const viewContainer = view?.containerEl as HTMLElement | undefined;
        const leafContent = viewContainer?.closest?.(".workspace-leaf-content") as HTMLElement | null;
        const attachTarget = leafContent || viewContainer || null;
        if (!attachTarget || floatingOverlay.parentElement !== attachTarget) {
          this.logScrollSnapshot("reattach-refresh", leaf, this.getLeafFile(leaf), {
            reason: !attachTarget ? "missing-floating-target" : "floating-target-mismatch",
          });
          void this.refreshLeaf(leaf, { resetExpanded: false });
        }
      }
    }
  }

  private applyOverlayVisibility(leaf: WorkspaceLeaf): void {
    for (const [placement, overlay] of this.getAllHostsForLeaf(leaf)) {
      if (placement !== 'floating' || !overlay?.isConnected) continue;
      if (this.swipeCollapsed) {
        overlay.style.visibility = "hidden";
        overlay.style.opacity = "0";
        overlay.style.pointerEvents = "none";
      } else {
        overlay.style.removeProperty("visibility");
        overlay.style.removeProperty("opacity");
        overlay.style.removeProperty("pointer-events");
      }
    }
  }

  private applyAllOverlayVisibility(): void {
    for (const leaf of this.getSupportedLeaves()) {
      this.applyOverlayVisibility(leaf);
    }
  }

  private setSwipeCollapsed(collapsed: boolean): void {
    if (this.swipeCollapsed === collapsed) return;
    this.swipeCollapsed = collapsed;
    this.applyAllOverlayVisibility();
  }

  private ensureSwipeGestureTracking(leaf: WorkspaceLeaf): void {
    const scroller = this.resolveScrollContainer(leaf);
    const existing = this.scrollHideListeners.get(leaf);
    if (existing) {
      if (existing.scroller === scroller) return;
      existing.scroller.removeEventListener("scroll", existing.listener);
      this.scrollHideListeners.delete(leaf);
    }
    if (!scroller) return;

    const HIDE_THRESHOLD = 60;
    const SHOW_THRESHOLD = 30;
    const state = { scroller, lastTop: scroller.scrollTop, accum: 0, listener: () => {} };

    state.listener = () => {
      if (this.keyboardHidden) return;

      const top = scroller.scrollTop;
      const delta = top - state.lastTop;
      state.lastTop = top;

      if ((delta > 0 && state.accum < 0) || (delta < 0 && state.accum > 0)) {
        state.accum = 0;
      }
      state.accum += delta;

      if (!this.swipeCollapsed && state.accum > HIDE_THRESHOLD) {
        this.setSwipeCollapsed(true);
        state.accum = 0;
      } else if (this.swipeCollapsed && state.accum < -SHOW_THRESHOLD) {
        this.setSwipeCollapsed(false);
        state.accum = 0;
      }
    };

    scroller.addEventListener("scroll", state.listener, { passive: true });
    this.scrollHideListeners.set(leaf, state);
  }

  private releaseSwipeGestureTracking(leaf: WorkspaceLeaf): void {
    const state = this.scrollHideListeners.get(leaf);
    if (!state) return;
    state.scroller.removeEventListener("scroll", state.listener);
    this.scrollHideListeners.delete(leaf);
  }

  private resolveScrollContainer(leaf: WorkspaceLeaf): HTMLElement | null {
    const view = leaf.view as any;
    const contentEl = view?.contentEl as HTMLElement | undefined;
    if (!contentEl) return null;
    return (
      contentEl.querySelector<HTMLElement>(".markdown-preview-view") ||
      contentEl.querySelector<HTMLElement>(".cm-scroller")
    );
  }

  onunload(): void {
    this.clearAllOverlaysFromDom();
    for (const state of this.scrollHideListeners.values()) {
      state.scroller.removeEventListener("scroll", state.listener);
    }
    this.scrollHideListeners.clear();
    for (const leaf of this.getSupportedLeaves()) {
      this.detachContentObserver(leaf);
    }
    // Stop all canvas node watchers
    for (const leaf of this.canvasLeafData.keys()) {
      this.stopCanvasLeafWatcher(leaf);
    }
    for (const timer of this.canvasScanTimers.values()) {
      window.clearTimeout(timer);
    }
    this.canvasScanTimers.clear();
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
    const { settings, didChange } = sanitizeAutoBaseEmbedSettings(loaded, (rule) => this.isLegacyGeneratedRule(rule));
    this.settings = settings;
    logger.setLoggingEnabled(this.settings.debugLogging === true);
    if (didChange) {
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    logger.setLoggingEnabled(this.settings.debugLogging === true);
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

  private getLeafContentObserverRoot(leaf: WorkspaceLeaf): HTMLElement | null {
    const view = leaf.view as any;
    const viewContainer = view?.containerEl as HTMLElement | undefined;
    if (!viewContainer?.isConnected) return null;
    return (
      viewContainer.querySelector<HTMLElement>(".markdown-preview-view, .markdown-reading-view")
      || viewContainer.querySelector<HTMLElement>(".markdown-source-view")
      || null
    );
  }

  private isNodeInsideAutoBaseEmbed(node: Node | null | undefined): boolean {
    if (!node) return false;
    const element = node instanceof HTMLElement ? node : node.parentElement;
    return !!element?.closest?.(`.${EMBED_CLASS}`);
  }

  private mutationTouchesNoteBody(mutation: MutationRecord): boolean {
    if (mutation.type === "childList") {
      const nodes = [
        ...Array.from(mutation.addedNodes),
        ...Array.from(mutation.removedNodes),
      ];
      if (nodes.length === 0) return false;
      return nodes.some((node) => !this.isNodeInsideAutoBaseEmbed(node));
    }
    if (mutation.type === "characterData" || mutation.type === "attributes") {
      return !this.isNodeInsideAutoBaseEmbed(mutation.target);
    }
    return true;
  }

  private attachContentObserver(leaf: WorkspaceLeaf): void {
    const existing = this.contentObservers.get(leaf);
    if (existing) existing.disconnect();

    const root = this.getLeafContentObserverRoot(leaf);
    if (!root) return;

    const observer = new MutationObserver((mutations) => {
      if (!this.settings.enabled) return;
      if (!this.isSupportedLeaf(leaf)) return;
      if (this.refreshInFlight.has(leaf)) return;
      if (!mutations.some((mutation) => this.mutationTouchesNoteBody(mutation))) return;
      this.scheduleLeafRefresh(leaf, { resetExpanded: false }, 250);
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    this.contentObservers.set(leaf, observer);
  }

  private detachContentObserver(leaf: WorkspaceLeaf): void {
    const observer = this.contentObservers.get(leaf);
    if (!observer) return;
    observer.disconnect();
    this.contentObservers.delete(leaf);
  }

  private getLeafForEditorView(editorView: EditorView): WorkspaceLeaf | null {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const markdownView = leaf.view as MarkdownView & { editor?: { cm?: EditorView } };
      if (markdownView?.editor && (markdownView.editor as any).cm === editorView) {
        return leaf;
      }
    }
    return null;
  }

  private isLivePreviewMarkdownView(view: MarkdownView | null | undefined): boolean {
    if (!(view instanceof MarkdownView)) return false;
    const container = (view as any)?.containerEl as HTMLElement | undefined;
    return !!container?.querySelector?.('.markdown-source-view.is-live-preview');
  }

  private isPlainSourceModeLeaf(leaf: WorkspaceLeaf): boolean {
    const view = leaf.view instanceof MarkdownView ? leaf.view : null;
    const mode = String((view as any)?.getMode?.() || (view as any)?.mode || '').toLowerCase();
    return mode === 'source' && !this.isLivePreviewMarkdownView(view);
  }

  private createEditorExtension() {
    const plugin = this;
    return ViewPlugin.fromClass(class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.focusChanged || update.geometryChanged || update.selectionSet) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      private buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const leaf = plugin.getLeafForEditorView(view);
        const markdownView = leaf?.view instanceof MarkdownView ? leaf.view : null;
        const file = markdownView?.file instanceof TFile ? markdownView.file : null;
        const mode = String((markdownView as any)?.getMode?.() || (markdownView as any)?.mode || '').toLowerCase();
        if (file && mode === 'source' && plugin.isLivePreviewMarkdownView(markdownView)) {
          builder.add(
            view.state.doc.length,
            view.state.doc.length,
            Decoration.widget({
              widget: new SourceEndEmbedWidget(file.path),
              side: 1,
            }),
          );
        }
        return builder.finish();
      }
    }, {
      decorations: (value) => value.decorations,
    });
  }

  private getHostMap(leaf: WorkspaceLeaf): Map<RuleRenderPlacement, HTMLElement> {
    let map = this.hostEntriesByLeaf.get(leaf);
    if (!map) {
      map = new Map();
      this.hostEntriesByLeaf.set(leaf, map);
    }
    return map;
  }

  private getHostForPlacement(leaf: WorkspaceLeaf, placement: RuleRenderPlacement): HTMLElement | undefined {
    return this.hostEntriesByLeaf.get(leaf)?.get(placement);
  }

  private getAllHostsForLeaf(leaf: WorkspaceLeaf): Array<[RuleRenderPlacement, HTMLElement]> {
    return Array.from(this.hostEntriesByLeaf.get(leaf)?.entries() || []);
  }

  private setHostForPlacement(leaf: WorkspaceLeaf, placement: RuleRenderPlacement, host: HTMLElement): void {
    this.getHostMap(leaf).set(placement, host);
  }

  private deleteHostForPlacement(leaf: WorkspaceLeaf, placement: RuleRenderPlacement): void {
    const map = this.hostEntriesByLeaf.get(leaf);
    if (!map) return;
    map.delete(placement);
    if (map.size === 0) {
      this.hostEntriesByLeaf.delete(leaf);
    }
  }

  private getInlineAnchorMap(leaf: WorkspaceLeaf): Map<Exclude<RuleRenderPlacement, "floating">, HTMLElement> {
    let map = this.inlineAnchorsByLeaf.get(leaf);
    if (!map) {
      map = new Map();
      this.inlineAnchorsByLeaf.set(leaf, map);
    }
    return map;
  }

  private getInlineAnchor(leaf: WorkspaceLeaf, placement: Exclude<RuleRenderPlacement, "floating">): HTMLElement | undefined {
    return this.inlineAnchorsByLeaf.get(leaf)?.get(placement);
  }

  private setInlineAnchor(leaf: WorkspaceLeaf, placement: Exclude<RuleRenderPlacement, "floating">, anchor: HTMLElement): void {
    this.getInlineAnchorMap(leaf).set(placement, anchor);
  }

  private getEffectiveRulePlacement(rule: BaseEmbedRule, leaf: WorkspaceLeaf): RuleRenderPlacement {
    const explicit = rule.renderPlacement;
    if (explicit === 'floating' || explicit === 'after-title' || explicit === 'after-content') {
      if (explicit !== 'floating') {
        const type = String((leaf.view as any)?.getViewType?.() || '');
        if (type !== 'markdown') return 'floating';
      }
      return explicit;
    }
    const type = String((leaf.view as any)?.getViewType?.() || '');
    if (this.settings.renderMode === 'inline' && type === 'markdown') {
      return this.settings.inlinePlacement;
    }
    return 'floating';
  }

  private hasAfterContentRulesForLeaf(leaf: WorkspaceLeaf): boolean {
    const file = this.getLeafFile(leaf);
    if (!file) return false;
    return this.settings.rules.some((rule) =>
      this.shouldEmbedRule(rule, file) && this.getEffectiveRulePlacement(rule, leaf) === 'after-content'
    );
  }

  private findSourceEndWidgetHost(leaf: WorkspaceLeaf): HTMLElement | null {
    const view = leaf.view as any;
    const containerEl = view?.containerEl as HTMLElement | undefined;
    const file = this.getLeafFile(leaf);
    if (!containerEl || !file) return null;
    return containerEl.querySelector<HTMLElement>(`.${SOURCE_END_HOST_CLASS}[data-file-path="${CSS.escape(file.path)}"]`);
  }

  private groupRulesByPlacement(leaf: WorkspaceLeaf, rules: BaseEmbedRule[]): Map<RuleRenderPlacement, BaseEmbedRule[]> {
    const groups = new Map<RuleRenderPlacement, BaseEmbedRule[]>();
    for (const rule of rules) {
      const placement = this.getEffectiveRulePlacement(rule, leaf);
      const bucket = groups.get(placement) || [];
      bucket.push(rule);
      groups.set(placement, bucket);
    }
    return groups;
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

  private getLeavesImpactedByFile(filePath: string): WorkspaceLeaf[] {
    const normalizedFilePath = normalizePath(filePath);
    if (!normalizedFilePath) return [];
    // .base files are managed reactively by the Bases plugin itself. Responding
    // to their metadataCache.changed events would cause an infinite refresh loop
    // (Bases updates its cache entry → we re-render → Bases updates again → ...).
    if (normalizedFilePath.endsWith(".base")) return [];

    const impacted: WorkspaceLeaf[] = [];
    for (const leaf of this.getSupportedLeaves()) {
      const sourcePath = this.currentFileByLeaf.get(leaf);
      if (sourcePath && normalizePath(sourcePath) === normalizedFilePath) {
        impacted.push(leaf);
        continue;
      }

      const matchesBase = this.getAllHostsForLeaf(leaf).some(([, overlay]) => {
        const basePaths = overlay?.getAttribute("data-base-paths");
        if (!basePaths) return false;
        return basePaths.split(",").map((path) => normalizePath(path)).some((path) => path === normalizedFilePath);
      });
      if (matchesBase) {
        impacted.push(leaf);
      }
    }
    return impacted;
  }

  private getRuleKind(rule: BaseEmbedRule): EmbedRuleKind {
    return rule.kind === 'dataviewjs' ? 'dataviewjs' : 'base';
  }

  private getRuleStateKey(rule: BaseEmbedRule): string {
    if (this.getRuleKind(rule) === 'dataviewjs') {
      return `dataviewjs:${String(rule.id || '').trim()}`;
    }
    return normalizePath(String(rule.basePath || ''));
  }

  private getRuleDependencyPath(rule: BaseEmbedRule): string | null {
    if (this.getRuleKind(rule) !== 'base') return null;
    const normalized = normalizePath(String(rule.basePath || ''));
    return normalized || null;
  }

  private getRuleDisplayLabel(rule: BaseEmbedRule): string {
    if (this.getRuleKind(rule) === 'dataviewjs') {
      const firstMeaningfulLine = String(rule.dataviewjsCode || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      return firstMeaningfulLine ? `DataviewJS: ${firstMeaningfulLine}` : 'DataviewJS';
    }
    const basePath = String(rule.basePath || '');
    return basePath.replace(/.*\//, '').replace(/\.base$/i, '') || 'Base';
  }

  private getRuleSignatureKey(rule: BaseEmbedRule, leaf: WorkspaceLeaf): string {
    return JSON.stringify({
      id: rule.id,
      kind: this.getRuleKind(rule),
      basePath: normalizePath(String(rule.basePath || '')),
      dataviewjsCode: String(rule.dataviewjsCode || ''),
      initialState: rule.initialState || 'default',
      placement: this.getEffectiveRulePlacement(rule, leaf),
    });
  }

  private getRuleRenderMarkdown(rule: BaseEmbedRule): string {
    if (this.getRuleKind(rule) === 'dataviewjs') {
      const code = String(rule.dataviewjsCode || '').replace(/\r\n/g, '\n').trim();
      return `\`\`\`dataviewjs\n${code}\n\`\`\``;
    }
    return `![[${rule.basePath}]]`;
  }

  private getRenderableRulesForSource(rules: BaseEmbedRule[], sourcePath: string): BaseEmbedRule[] {
    return rules.filter((rule) => !(this.getRuleKind(rule) === 'base' && sourcePath === rule.basePath));
  }

  private resolveInitialActiveRuleKey(
    rules: BaseEmbedRule[],
    preferredKey: string | null | undefined,
    expandedSet?: Set<string>,
  ): string | null {
    const ruleKeys = rules.map((rule) => this.getRuleStateKey(rule));
    if (preferredKey && ruleKeys.includes(preferredKey)) {
      return preferredKey;
    }
    if (expandedSet) {
      const expandedKey = ruleKeys.find((ruleKey) => expandedSet.has(ruleKey));
      if (expandedKey) return expandedKey;
    }
    return ruleKeys[0] ?? null;
  }

  private async buildTabbedPanelsForPlacement(
    leaf: WorkspaceLeaf,
    placement: RuleRenderPlacement,
    rules: BaseEmbedRule[],
    sourcePath: string,
    view: any,
    renderToken: number,
    container: HTMLElement,
  ): Promise<number> {
    const activeRuleKey = this.resolveInitialActiveRuleKey(
      rules,
      this.getActiveTabForPlacement(leaf, placement),
      this.getExpandedSet(leaf),
    );
    const tabGroup = document.createElement('div');
    tabGroup.className = `${EMBED_CLASS}__tab-group`;

    const tabBar = document.createElement('div');
    tabBar.className = `${EMBED_CLASS}__tabs`;
    tabBar.setAttribute('role', 'tablist');
    tabGroup.appendChild(tabBar);

    const panelContainer = document.createElement('div');
    panelContainer.className = `${EMBED_CLASS}__tab-panels`;
    tabGroup.appendChild(panelContainer);
    container.appendChild(tabGroup);

    const renderedPanels = new Map<string, HTMLElement>();
    const tabButtons = new Map<string, HTMLButtonElement>();

    const setActive = (ruleKey: string) => {
      this.setActiveTabForPlacement(leaf, placement, ruleKey);
      for (const [key, panel] of renderedPanels) {
        panel.hidden = key !== ruleKey;
      }
      for (const [key, button] of tabButtons) {
        const isActive = key === ruleKey;
        button.classList.toggle(`${EMBED_CLASS}__tab--active`, isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        button.tabIndex = isActive ? 0 : -1;
      }
    };

    for (const rule of rules) {
      if (this.renderTokens.get(leaf) !== renderToken) return 0;
      const ruleKey = this.getRuleStateKey(rule);
      const tabButton = document.createElement('button');
      tabButton.type = 'button';
      tabButton.className = `${EMBED_CLASS}__tab`;
      tabButton.textContent = this.getRuleDisplayLabel(rule);
      tabButton.setAttribute('role', 'tab');
      tabButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setActive(ruleKey);
      });
      tabBar.appendChild(tabButton);
      tabButtons.set(ruleKey, tabButton);

      const panel = await this.buildPanel(leaf, rule, sourcePath, view, renderToken, panelContainer);
      if (!panel) return 0;
      renderedPanels.set(ruleKey, panel);
    }

    if (renderedPanels.size === 0) {
      tabGroup.remove();
      return 0;
    }

    setActive(activeRuleKey && renderedPanels.has(activeRuleKey) ? activeRuleKey : Array.from(renderedPanels.keys())[0]);
    return renderedPanels.size;
  }

  private async buildTabbedPanelsForCanvasNode(
    nodeEl: HTMLElement,
    overlay: HTMLElement,
    rules: BaseEmbedRule[],
    sourcePath: string,
    expandedSet: Set<string>,
    activeRuleKey: string | null | undefined,
    setActiveRuleKey: (ruleKey: string) => void,
  ): Promise<number> {
    const initialActiveRuleKey = this.resolveInitialActiveRuleKey(rules, activeRuleKey, expandedSet);
    const tabGroup = document.createElement('div');
    tabGroup.className = `${EMBED_CLASS}__tab-group`;

    const tabBar = document.createElement('div');
    tabBar.className = `${EMBED_CLASS}__tabs`;
    tabBar.setAttribute('role', 'tablist');
    tabGroup.appendChild(tabBar);

    const panelContainer = document.createElement('div');
    panelContainer.className = `${EMBED_CLASS}__tab-panels`;
    tabGroup.appendChild(panelContainer);
    overlay.appendChild(tabGroup);

    const renderedPanels = new Map<string, HTMLElement>();
    const tabButtons = new Map<string, HTMLButtonElement>();

    const setActive = (ruleKey: string) => {
      setActiveRuleKey(ruleKey);
      for (const [key, panel] of renderedPanels) {
        panel.hidden = key !== ruleKey;
      }
      for (const [key, button] of tabButtons) {
        const isActive = key === ruleKey;
        button.classList.toggle(`${EMBED_CLASS}__tab--active`, isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        button.tabIndex = isActive ? 0 : -1;
      }
    };

    for (const rule of rules) {
      const ruleKey = this.getRuleStateKey(rule);
      const tabButton = document.createElement('button');
      tabButton.type = 'button';
      tabButton.className = `${EMBED_CLASS}__tab`;
      tabButton.textContent = this.getRuleDisplayLabel(rule);
      tabButton.setAttribute('role', 'tab');
      this.fenceCanvasInteraction(tabButton);
      tabButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        setActive(ruleKey);
      });
      tabBar.appendChild(tabButton);
      tabButtons.set(ruleKey, tabButton);

      const panel = await this.buildCanvasNodePanel(nodeEl, panelContainer, rule, sourcePath, expandedSet);
      if (!panel) return 0;
      renderedPanels.set(ruleKey, panel);
    }

    if (renderedPanels.size === 0) {
      tabGroup.remove();
      return 0;
    }

    setActive(initialActiveRuleKey && renderedPanels.has(initialActiveRuleKey) ? initialActiveRuleKey : Array.from(renderedPanels.keys())[0]);
    return renderedPanels.size;
  }

  private async renderRuleIntoTarget(
    rule: BaseEmbedRule,
    renderTarget: HTMLElement,
    sourcePath: string,
    view: MarkdownView | null,
    panel: HTMLElement,
  ): Promise<void> {
    if (this.getRuleKind(rule) === 'dataviewjs') {
      await MarkdownRenderer.render(this.app, this.getRuleRenderMarkdown(rule), renderTarget, sourcePath, view as any);
      await this.enableDataviewTaskInteractions(renderTarget);
      return;
    }

    const baseFile = this.app.vault.getAbstractFileByPath(rule.basePath);
    if (!(baseFile instanceof TFile)) return;

    let usedEmbedRegistry = false;
    const embedRegistry = (this.app as any).embedRegistry;
    const embedCtor = embedRegistry?.embedByExtension?.get?.('base');
    if (embedCtor) {
      try {
        const ctx = { app: this.app, sourcePath };
        const embed = embedCtor(ctx, baseFile, '');
        if (embed?.containerEl) {
          renderTarget.appendChild(embed.containerEl);
          try {
            this.addChild(embed as any);
          } catch {
            try { if (typeof embed.load === 'function') embed.load(); } catch { /* ignore */ }
          }
          this.panelEmbeds.set(panel, embed);
          usedEmbedRegistry = true;
        }
      } catch (error) {
        this.debugWarn('[TPS Auto Base Embed] embedRegistry failed, falling back to MarkdownRenderer', error);
      }
    }
    if (!usedEmbedRegistry) {
      await MarkdownRenderer.render(this.app, this.getRuleRenderMarkdown(rule), renderTarget, sourcePath, view as any);
    }
  }

  private async enableDataviewTaskInteractions(renderTarget: HTMLElement): Promise<void> {
    if (this.isCanvasNodeRenderTarget(renderTarget)) {
      this.fenceCanvasInteractionDescendants(renderTarget);
    }
    await this.bindDataviewTaskRows(renderTarget);
    this.observeDataviewTaskRows(renderTarget);
  }

  private isCanvasNodeRenderTarget(renderTarget: HTMLElement): boolean {
    return !!renderTarget.closest(`.${EMBED_CLASS}--canvas-node`);
  }

  private fenceCanvasInteraction(element: HTMLElement | null): void {
    if (!(element instanceof HTMLElement) || element.dataset.tpsAutoBaseEmbedCanvasFence === 'true') {
      return;
    }

    const stopPropagation = (event: Event) => {
      event.stopPropagation();
    };

    for (const eventName of ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'click', 'dblclick']) {
      element.addEventListener(eventName, stopPropagation);
    }

    element.dataset.tpsAutoBaseEmbedCanvasFence = 'true';
  }

  private fenceCanvasInteractionDescendants(container: ParentNode): void {
    const interactiveElements = Array.from(
      container.querySelectorAll<HTMLElement>('button, a, input, textarea, select, label, [role="tab"]'),
    );

    for (const element of interactiveElements) {
      this.fenceCanvasInteraction(element);
    }
  }

  private getDataviewTaskRows(renderTarget: HTMLElement): HTMLElement[] {
    return Array.from(
      renderTarget.querySelectorAll<HTMLElement>('.task-list-item, .dataview-task-list-item'),
    );
  }

  private async bindDataviewTaskRows(renderTarget: HTMLElement): Promise<void> {
    for (const taskRow of this.getDataviewTaskRows(renderTarget)) {
      await this.bindDataviewTaskRow(taskRow);
    }
  }

  private observeDataviewTaskRows(renderTarget: HTMLElement): void {
    if (this.dataviewTaskObservers.has(renderTarget)) {
      return;
    }

    const observer = new MutationObserver(() => {
      if (!renderTarget.isConnected) {
        this.disconnectDataviewTaskObserver(renderTarget);
        return;
      }

      if (this.isCanvasNodeRenderTarget(renderTarget)) {
        this.fenceCanvasInteractionDescendants(renderTarget);
      }

      void this.bindDataviewTaskRows(renderTarget);
    });

    observer.observe(renderTarget, { childList: true, subtree: true });
    this.dataviewTaskObservers.set(renderTarget, observer);

    window.requestAnimationFrame(() => {
      if (!renderTarget.isConnected) {
        this.disconnectDataviewTaskObserver(renderTarget);
        return;
      }

      if (this.isCanvasNodeRenderTarget(renderTarget)) {
        this.fenceCanvasInteractionDescendants(renderTarget);
      }

      void this.bindDataviewTaskRows(renderTarget);
    });
  }

  private disconnectDataviewTaskObserver(renderTarget: HTMLElement): void {
    const observer = this.dataviewTaskObservers.get(renderTarget);
    if (!observer) {
      return;
    }

    observer.disconnect();
    this.dataviewTaskObservers.delete(renderTarget);
  }

  private disconnectDataviewTaskObserversWithin(container: HTMLElement): void {
    const renderTargets = Array.from(
      container.querySelectorAll<HTMLElement>('.markdown-preview-view.markdown-rendered'),
    );

    for (const renderTarget of renderTargets) {
      this.disconnectDataviewTaskObserver(renderTarget);
    }
  }

  private async bindDataviewTaskRow(taskRow: HTMLElement): Promise<void> {
    const checkbox = taskRow.querySelector<HTMLInputElement>('input.task-list-item-checkbox');
    if (!(checkbox instanceof HTMLInputElement) || checkbox.type !== 'checkbox' || !checkbox.disabled) {
      return;
    }

    const sourcePath = this.resolveRenderedTaskSourcePath(taskRow);
    if (!sourcePath) return;

    const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(sourceFile instanceof TFile) || sourceFile.extension !== 'md') {
      return;
    }

    const lineNumber = await this.findRenderedTaskSourceLine(sourceFile, taskRow);
    if (lineNumber < 0) {
      return;
    }

    taskRow.setAttribute('data-tps-task-context', 'true');
    checkbox.disabled = false;
    checkbox.dataset.tpsAutoBaseEmbedTaskPath = sourceFile.path;
    checkbox.dataset.tpsAutoBaseEmbedTaskLine = String(lineNumber);
    checkbox.dataset.tpsAutoBaseEmbedTaskChecked = checkbox.checked ? 'true' : 'false';

    if (checkbox.dataset.tpsAutoBaseEmbedTaskBound === 'true') {
      return;
    }

    checkbox.dataset.tpsAutoBaseEmbedTaskBound = 'true';
    checkbox.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.handleDataviewTaskCheckboxClick(checkbox);
    });
  }

  private async handleDataviewTaskCheckboxClick(checkbox: HTMLInputElement): Promise<void> {
    const filePath = String(checkbox.dataset.tpsAutoBaseEmbedTaskPath || '').trim();
    const rawLineNumber = Number.parseInt(String(checkbox.dataset.tpsAutoBaseEmbedTaskLine || ''), 10);
    if (!filePath || !Number.isFinite(rawLineNumber)) {
      return;
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(filePath);
    if (!(sourceFile instanceof TFile) || sourceFile.extension !== 'md') {
      return;
    }

    const nextChecked = checkbox.dataset.tpsAutoBaseEmbedTaskChecked !== 'true';
    checkbox.disabled = true;

    try {
      const updated = await this.updateTaskLineCheckboxState(sourceFile, rawLineNumber, nextChecked);
      if (!updated) {
        return;
      }

      checkbox.dataset.tpsAutoBaseEmbedTaskChecked = nextChecked ? 'true' : 'false';
      checkbox.checked = nextChecked;
    } finally {
      checkbox.disabled = false;
    }
  }

  private async updateTaskLineCheckboxState(file: TFile, lineNumber: number, checked: boolean): Promise<boolean> {
    const content = await this.app.vault.read(file);
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(/\r?\n/);
    if (lineNumber < 0 || lineNumber >= lines.length) {
      return false;
    }

    const originalLine = lines[lineNumber];
    const updatedLine = this.applyTaskCheckboxStateToLine(originalLine, checked);
    if (!updatedLine || updatedLine === originalLine) {
      return false;
    }

    lines[lineNumber] = updatedLine;
    await this.app.vault.modify(file, lines.join(newline));
    return true;
  }

  private applyTaskCheckboxStateToLine(line: string, checked: boolean): string | null {
    if (!this.isTaskCheckboxLine(line)) {
      return null;
    }

    return line.replace(
      /^(\s*(?:[-*+]|\d+\.)\s*)\[[^\]]\]/,
      `$1[${checked ? 'x' : ' '}]`,
    );
  }

  private isTaskCheckboxLine(line: string): boolean {
    return /^\s*(?:[-*+]|\d+\.)\s*\[[^\]]\]/.test(line);
  }

  private resolveRenderedTaskSourcePath(taskRow: HTMLElement): string | null {
    const noteLink = taskRow.querySelector<HTMLElement>('a.internal-link, [data-href], [href]');
    if (!noteLink) {
      return null;
    }

    const candidates = [
      noteLink.getAttribute('data-href'),
      noteLink.getAttribute('href'),
      noteLink.textContent,
    ];

    for (const rawValue of candidates) {
      const raw = String(rawValue || '').trim();
      if (!raw) continue;

      const cleaned = raw
        .replace(/^obsidian:\/\/open\?file=/i, '')
        .split('|')[0]
        .split('#')[0]
        .trim();
      if (!cleaned) continue;

      const decoded = decodeURIComponent(cleaned);
      const directPath = decoded.endsWith('.md') ? decoded : `${decoded}.md`;
      const directFile = this.app.vault.getAbstractFileByPath(directPath);
      if (directFile instanceof TFile && directFile.extension === 'md') {
        return directFile.path;
      }

      const resolved = this.app.metadataCache.getFirstLinkpathDest(decoded, '');
      if (resolved instanceof TFile && resolved.extension === 'md') {
        return resolved.path;
      }
    }

    return null;
  }

  private async findRenderedTaskSourceLine(sourceFile: TFile, taskRow: HTMLElement): Promise<number> {
    const renderedText = this.normalizeTaskTextForComparison(this.getRenderedTaskText(taskRow));
    if (!renderedText) {
      return -1;
    }

    const content = await this.app.vault.cachedRead(sourceFile);
    const lines = content.split(/\r?\n/);
    let fallbackLine = -1;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!this.isTaskCheckboxLine(line)) {
        continue;
      }

      const normalizedLine = this.normalizeTaskTextForComparison(line);
      if (!normalizedLine) {
        continue;
      }

      if (normalizedLine === renderedText) {
        return index;
      }

      if (fallbackLine < 0 && (normalizedLine.includes(renderedText) || renderedText.includes(normalizedLine))) {
        fallbackLine = index;
      }
    }

    return fallbackLine;
  }

  private getRenderedTaskText(taskRow: HTMLElement): string {
    const noteLink = taskRow.querySelector<HTMLElement>('a.internal-link');
    const linkText = noteLink?.textContent?.trim();
    if (linkText) {
      return linkText;
    }

    const clone = taskRow.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input, .task-list-item-checkbox').forEach((element) => element.remove());
    return clone.textContent?.trim() || '';
  }

  private normalizeTaskTextForComparison(text: string): string {
    return String(text || '')
      .replace(/^\s*(?:[-*+]|\d+\.)\s*\[[^\]]*\]\s*/, '')
      .replace(/^\s*(?:[-*+]|\d+\.)\s*/, '')
      .replace(/\[[^\]]+::[^\]]*\]/g, ' ')
      .replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2')
      .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
      .replace(/[#*_`>~]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
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
    const filePath = normalizePath(file.path);
    const fileBase = String(file.basename || "").trim().toLowerCase();

    // Folder inclusion
    if (conditions.folders && conditions.folders.length > 0) {
      const inFolder = conditions.folders.some((folder) => this.matchesPathPattern(filePath, fileBase, folder));
      if (!inFolder) return false;
    }

    // Folder exclusion
    if (conditions.excludeFolders && conditions.excludeFolders.length > 0) {
      const inExcludedFolder = conditions.excludeFolders.some((folder) => this.matchesPathPattern(filePath, fileBase, folder));
      if (inExcludedFolder) return false;
    }

    // Path inclusion
    if (conditions.paths && conditions.paths.length > 0) {
      const matched = conditions.paths.some((pattern) => this.matchesPathPattern(filePath, fileBase, pattern));
      if (!matched) return false;
    }

    // Path exclusion
    if (conditions.excludePaths && conditions.excludePaths.length > 0) {
      const denied = conditions.excludePaths.some((pattern) => this.matchesPathPattern(filePath, fileBase, pattern));
      if (denied) return false;
    }

    // Tag inclusion (any-match)
    if (conditions.tags && conditions.tags.length > 0) {
      const hasAny = conditions.tags.some((tagPattern) =>
        Array.from(noteTags.values()).some((tag) => this.matchesTagPattern(tag, tagPattern)),
      );
      if (!hasAny) return false;
    }

    // Tag exclusion (any-match)
    if (conditions.excludeTags && conditions.excludeTags.length > 0) {
      const hasDenied = conditions.excludeTags.some((tagPattern) =>
        Array.from(noteTags.values()).some((tag) => this.matchesTagPattern(tag, tagPattern)),
      );
      if (hasDenied) return false;
    }

    // Status inclusion/exclusion (uses frontmatter "status")
    const noteStatus = this.normalizeStatusValue(
      this.getFrontmatterValueCaseInsensitive(fm as Record<string, unknown>, "status"),
    );
    if (conditions.requiredStatuses && conditions.requiredStatuses.length > 0) {
      const required = conditions.requiredStatuses.map((status) => this.normalizeStatusValue(status)).filter(Boolean);
      if (required.length > 0 && (!noteStatus || !required.includes(noteStatus))) {
        return false;
      }
    }
    if (conditions.ignoreStatuses && conditions.ignoreStatuses.length > 0) {
      const ignored = conditions.ignoreStatuses.map((status) => this.normalizeStatusValue(status)).filter(Boolean);
      if (ignored.length > 0 && noteStatus && ignored.includes(noteStatus)) {
        return false;
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

  private normalizeStatusValue(raw: unknown): string {
    return String(raw ?? "").trim().toLowerCase();
  }

  private matchesTagPattern(tag: string, pattern: string): boolean {
    const normalizedTag = this.normalizeTag(tag);
    const normalizedPattern = String(pattern || "").trim();
    if (!normalizedTag || !normalizedPattern) return false;
    const lowerPattern = normalizedPattern.toLowerCase();
    if (lowerPattern.startsWith("re:")) {
      const raw = normalizedPattern.slice(3).trim();
      if (!raw) return false;
      try {
        return new RegExp(raw, "i").test(normalizedTag);
      } catch {
        return false;
      }
    }
    if (lowerPattern.includes("*")) {
      const regex = new RegExp(`^${this.escapeRegex(lowerPattern).replace(/\\\*/g, ".*")}$`, "i");
      return regex.test(normalizedTag);
    }
    const plain = this.normalizeTag(lowerPattern);
    if (!plain) return false;
    return normalizedTag === plain || normalizedTag.startsWith(`${plain}/`);
  }

  private matchesPathPattern(filePath: string, fileBasename: string, pattern: string): boolean {
    const raw = String(pattern || "").trim();
    if (!raw) return false;
    const normalizedPath = normalizePath(filePath).toLowerCase();
    const normalizedBase = String(fileBasename || "").trim().toLowerCase();
    const lower = raw.toLowerCase();

    if (lower.startsWith("re:")) {
      const regexSrc = raw.slice(3).trim();
      if (!regexSrc) return false;
      try {
        const rx = new RegExp(regexSrc, "i");
        return rx.test(normalizedPath) || rx.test(normalizedBase);
      } catch {
        return false;
      }
    }

    if (lower.startsWith("name:")) {
      const target = lower.slice(5).trim();
      if (!target) return false;
      if (target.includes("*")) {
        const rx = new RegExp(`^${this.escapeRegex(target).replace(/\\\*/g, ".*")}$`, "i");
        return rx.test(normalizedBase);
      }
      return normalizedBase === target;
    }

    const value = normalizePath(raw.replace(/^\/+|\/+$/g, "")).toLowerCase();
    if (!value) return false;

    if (value.includes("*")) {
      const rx = new RegExp(`^${this.escapeRegex(value).replace(/\\\*/g, ".*")}$`, "i");
      return rx.test(normalizedPath) || rx.test(normalizedBase);
    }

    if (raw.endsWith("/") || value.includes("/")) {
      return normalizedPath === value || normalizedPath.startsWith(`${value}/`);
    }

    return normalizedPath === value || normalizedPath.startsWith(`${value}/`) || normalizedBase === value;
  }

  private escapeRegex(value: string): string {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  private normalizeInlineBeforeNode(
    parent: HTMLElement,
    before: ChildNode | null,
  ): ChildNode | null {
    let cursor = before;
    while (cursor instanceof HTMLElement) {
      if (
        cursor.classList.contains(EMBED_CLASS) ||
        cursor.classList.contains(INLINE_ANCHOR_CLASS) ||
        cursor.classList.contains(INLINE_SECTION_CLASS) ||
        cursor.classList.contains("tps-daily-note-nav") ||
        cursor.classList.contains("metadata-container")
      ) {
        cursor = cursor.nextSibling;
      } else {
        break;
      }
    }
    if (cursor?.parentNode !== parent) {
      return null;
    }
    return cursor;
  }

  private resolveInlineMountTarget(
    leaf: WorkspaceLeaf,
    placement: Exclude<RuleRenderPlacement, "floating">,
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
    const sourceScroller =
      sourceView?.querySelector<HTMLElement>(".cm-scroller")
      || sourceEditor?.querySelector<HTMLElement>(".cm-scroller")
      || null;
    const sourceSizer =
      sourceScroller?.querySelector<HTMLElement>(".cm-sizer")
      || sourceEditor?.querySelector<HTMLElement>(".cm-sizer")
      || null;
    const sourceContentContainer =
      sourceSizer?.querySelector<HTMLElement>(":scope > .cm-contentContainer")
      || sourceSizer?.querySelector<HTMLElement>(".cm-contentContainer")
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
    const inlineTitle =
      previewRoot?.querySelector<HTMLElement>(":scope > .inline-title")
      || previewRoot?.querySelector<HTMLElement>(":scope > h1")
      || previewRoot?.querySelector<HTMLElement>(".markdown-preview-section .inline-title")
      || previewRoot?.querySelector<HTMLElement>(".markdown-preview-section h1")
      || previewRoot?.querySelector<HTMLElement>(".inline-title")
      || viewContainer.querySelector<HTMLElement>(".inline-title")
      || viewContainer.querySelector<HTMLElement>(".markdown-preview-view h1, .markdown-reading-view h1");
    const previewVisible = this.isElementActuallyVisible(previewRoot);

    const isLivePreview = this.isLivePreviewMarkdownView(view as MarkdownView);
    const shouldUseSource = sourceVisible && isLivePreview;
    const shouldUsePreview = previewVisible;

    if (shouldUseSource) {
      const sourceParent = sourceEditor?.parentElement || sourceView;
      if (!sourceParent || !sourceEditor) return null;

      if (placement === "after-title") {
        if (
          sourceInlineTitle?.isConnected
          && sourceInlineTitle.parentElement
          && sourceInlineTitle.parentElement !== sourceEditor
          && !sourceInlineTitle.closest(".cm-content")
        ) {
          return {
            parent: sourceInlineTitle.parentElement,
            before: this.normalizeInlineBeforeNode(
              sourceInlineTitle.parentElement,
              sourceInlineTitle.nextSibling,
            ),
          };
        }
        return {
          parent: sourceParent,
          before: this.normalizeInlineBeforeNode(sourceParent, sourceEditor),
        };
      }
      const sourceEndHost = this.findSourceEndWidgetHost(leaf);
      if (sourceEndHost?.isConnected) {
        return {
          parent: sourceEndHost,
          before: null,
        };
      }
      if (sourceContentContainer?.isConnected && sourceContentContainer.parentElement) {
        return {
          parent: sourceContentContainer.parentElement,
          before: this.normalizeInlineBeforeNode(sourceContentContainer.parentElement, sourceContentContainer.nextSibling),
        };
      }
      if (sourceSizer?.isConnected) {
        return {
          parent: sourceSizer,
          before: this.normalizeInlineBeforeNode(sourceSizer, null),
        };
      }
      return {
        parent: sourceParent,
        before: this.normalizeInlineBeforeNode(sourceParent, sourceEditor.nextSibling),
      };
    }

    if (!shouldUsePreview && !previewVisible && sourceVisible) {
      const sourceParent = sourceEditor?.parentElement || sourceView;
      if (!sourceParent || !sourceEditor) return null;

      if (placement === "after-title") {
        if (
          sourceInlineTitle?.isConnected
          && sourceInlineTitle.parentElement
          && sourceInlineTitle.parentElement !== sourceEditor
          && !sourceInlineTitle.closest(".cm-content")
        ) {
          return {
            parent: sourceInlineTitle.parentElement,
            before: this.normalizeInlineBeforeNode(
              sourceInlineTitle.parentElement,
              sourceInlineTitle.nextSibling,
            ),
          };
        }
        return {
          parent: sourceParent,
          before: this.normalizeInlineBeforeNode(sourceParent, sourceEditor),
        };
      }
      const sourceEndHost = this.findSourceEndWidgetHost(leaf);
      if (sourceEndHost?.isConnected) {
        return {
          parent: sourceEndHost,
          before: null,
        };
      }
      if (sourceContentContainer?.isConnected && sourceContentContainer.parentElement) {
        return {
          parent: sourceContentContainer.parentElement,
          before: this.normalizeInlineBeforeNode(sourceContentContainer.parentElement, sourceContentContainer.nextSibling),
        };
      }
      if (sourceSizer?.isConnected) {
        return {
          parent: sourceSizer,
          before: this.normalizeInlineBeforeNode(sourceSizer, null),
        };
      }
      return {
        parent: sourceParent,
        before: this.normalizeInlineBeforeNode(sourceParent, sourceEditor.nextSibling),
      };
    }

    const previewChildren = previewRoot ? Array.from(previewRoot.children) as HTMLElement[] : [];
    const previewSections = previewChildren.filter((child) => child.classList.contains("markdown-preview-section"));
    const firstSection = previewSections[0] || null;
    const lastSection = previewSections.length > 0 ? previewSections[previewSections.length - 1] : null;
    const dailyNav = previewRoot?.querySelector<HTMLElement>(".tps-daily-note-nav--under-title");
    const previewContentStart =
      previewChildren.find((child) =>
        child.classList.contains("markdown-preview-section")
        || child.classList.contains("markdown-preview-pusher")
        || child.classList.contains("markdown-preview-sizer"),
      ) || null;
    const previewFooter = previewChildren.find((child) =>
      child.classList.contains("metadata-container")
      || child.classList.contains("metadata-properties")
      || child.classList.contains("embedded-backlinks")
      || child.classList.contains("mod-footer"),
    ) || null;

    if (placement === "after-title") {
      if (
        dailyNav?.isConnected
        && dailyNav.parentElement
      ) {
        return {
          parent: this.ensureInlineAnchorAfterNode(leaf, dailyNav, placement),
          before: null,
        };
      }
      if (
        inlineTitle?.isConnected
      ) {
        return {
          parent: this.ensureInlineAnchorAfterNode(leaf, inlineTitle, placement),
          before: null,
        };
      }
      const inlineTitleSection = inlineTitle?.closest<HTMLElement>(".markdown-preview-section");
      if (
        inlineTitleSection?.isConnected
        && inlineTitleSection.children.length <= 1
      ) {
        return {
          parent: this.ensureInlineAnchorAfterNode(leaf, inlineTitleSection, placement),
          before: null,
        };
      }
      if (previewRoot?.isConnected) {
        return {
          parent: this.ensureReadingModeInlineAnchor(
            leaf,
            previewRoot,
            placement,
            dailyNav?.parentElement === previewRoot
              ? dailyNav.nextSibling
              : inlineTitle?.parentElement === previewRoot
                ? inlineTitle.nextSibling
                : previewContentStart || firstSection,
          ),
          before: null,
        };
      }
      return null;
    }

    if (previewVisible) {
      if (placement === "after-content" && lastSection) {
        return {
          parent: this.ensureReadingModeInlineAnchor(
            leaf,
            previewRoot,
            placement,
            previewFooter || lastSection.nextSibling,
          ),
          before: null,
        };
      }
      if (lastSection) {
        return {
          parent: this.ensureReadingModeInlineAnchor(
            leaf,
            previewRoot,
            placement,
            previewFooter || lastSection.nextSibling,
          ),
          before: null,
        };
      }
      return {
        parent: this.ensureReadingModeInlineAnchor(
          leaf,
          previewRoot,
          placement,
          previewFooter,
        ),
        before: null,
      };
    }
    return null;
  }

  private ensureReadingModeInlineAnchor(
    leaf: WorkspaceLeaf,
    previewRoot: HTMLElement,
    placement: "after-title" | "after-content",
    before: ChildNode | null,
  ): HTMLElement {
    let anchor = this.getInlineAnchor(leaf, placement);
    if (!anchor) {
      anchor = document.createElement("div");
      anchor.className = INLINE_ANCHOR_CLASS;
      this.setInlineAnchor(leaf, placement, anchor);
    }
    anchor.setAttribute("data-inline-placement", placement);

    let section = anchor.parentElement;
    if (!section || !section.classList.contains(INLINE_SECTION_CLASS)) {
      section = document.createElement("div");
      section.className = `markdown-preview-section ${INLINE_SECTION_CLASS}`;
      section.setAttribute("data-inline-placement", placement);
      section.appendChild(anchor);
    } else {
      section.setAttribute("data-inline-placement", placement);
      if (anchor.parentElement !== section) {
        section.empty();
        section.appendChild(anchor);
      }
    }

    const normalizedBefore = this.normalizeInlineBeforeNode(previewRoot, before);
    if (section.parentElement !== previewRoot || section.nextSibling !== normalizedBefore) {
      previewRoot.insertBefore(section, normalizedBefore);
    }
    return anchor;
  }

  private ensureInlineAnchorAfterNode(
    leaf: WorkspaceLeaf,
    afterNode: HTMLElement,
    placement: "after-title" | "after-content",
  ): HTMLElement {
    let anchor = this.getInlineAnchor(leaf, placement);
    if (!anchor) {
      anchor = document.createElement("div");
      anchor.className = INLINE_ANCHOR_CLASS;
      this.setInlineAnchor(leaf, placement, anchor);
    }
    anchor.setAttribute("data-inline-placement", placement);
    if (anchor.parentElement !== afterNode.parentElement || anchor.previousSibling !== afterNode) {
      afterNode.insertAdjacentElement("afterend", anchor);
    }
    return anchor;
  }

  private cleanupDuplicateHostsForLeaf(leaf: WorkspaceLeaf, currentHost: HTMLElement): void {
    const view = leaf.view as any;
    const viewContainer = view?.containerEl as HTMLElement | undefined;
    const leafContent = viewContainer?.closest?.(".workspace-leaf-content") as HTMLElement | null;
    if (!leafContent?.isConnected) return;
    const trackedHosts = new Set(this.getAllHostsForLeaf(leaf).map(([, host]) => host));
    const hosts = Array.from(leafContent.querySelectorAll<HTMLElement>(`.${EMBED_CLASS}`));
    for (const host of hosts) {
      if (host === currentHost) continue;
      if (trackedHosts.has(host)) continue;
      if (currentHost.contains(host) || host.contains(currentHost)) continue;
      host.remove();
    }
  }

  private ensureHost(leaf: WorkspaceLeaf, placement: RuleRenderPlacement): HTMLElement | null {
    let host = this.getHostForPlacement(leaf, placement);
    if (host?.isConnected) {
      const currentMode = host.getAttribute("data-render-mode");
      const desiredMode = placement === 'floating' ? 'floating' : 'inline';
      if (currentMode !== desiredMode) {
        host.remove();
        this.deleteHostForPlacement(leaf, placement);
        host = undefined;
      }
    }

    if (placement !== "floating") {
      const mountTarget = this.resolveInlineMountTarget(leaf, placement);
      if (!mountTarget) return null;
      if (!host) {
        host = document.createElement("div");
        host.className = EMBED_CLASS;
        this.setHostForPlacement(leaf, placement, host);
      }
      host.setAttribute("data-render-mode", "inline");
      host.setAttribute("data-inline-placement", placement);
      const isCodeMirrorInline = mountTarget.parent.classList.contains("cm-content");
      host.classList.toggle("cm-line", isCodeMirrorInline);
      host.classList.toggle(`${EMBED_CLASS}--cm-inline`, isCodeMirrorInline);
      if (host.parentElement !== mountTarget.parent || host.nextSibling !== mountTarget.before) {
        this.debugInfo("[TPS Auto Base Embed] [Mount]", {
          file: this.getLeafFile(leaf)?.path ?? null,
          renderMode: 'inline',
          inlinePlacement: placement,
          parentClass: mountTarget.parent.className,
          beforeNode:
            mountTarget.before instanceof HTMLElement
              ? mountTarget.before.className || mountTarget.before.tagName
              : mountTarget.before?.nodeName ?? null,
        });
        mountTarget.parent.insertBefore(host, mountTarget.before);
      }
      if (placement === "after-title") {
        this.setupTitleReattachObserver(leaf, host, mountTarget);
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

  private setupTitleReattachObserver(
    leaf: WorkspaceLeaf,
    host: HTMLElement,
    mountTarget: { parent: HTMLElement; before: ChildNode | null },
  ): void {
    const existing = this.titleReattachObservers.get(leaf);
    if (existing) existing.disconnect();

    const plugin = this;
    let reattachScheduled = false;
    const doReattach = () => {
      reattachScheduled = false;
      if (!host.isConnected && plugin.getHostForPlacement(leaf, "after-title") === host) {
        const freshTarget = plugin.resolveInlineMountTarget(leaf, "after-title");
        if (freshTarget) {
          freshTarget.parent.insertBefore(host, freshTarget.before);
          if (freshTarget.parent !== mountTarget.parent) {
            observer.disconnect();
            observer.observe(freshTarget.parent, { childList: true });
          }
        }
      }
    };
    const observer = new MutationObserver(() => {
      if (!host.isConnected && !reattachScheduled) {
        reattachScheduled = true;
        requestAnimationFrame(doReattach);
      }
    });

    observer.observe(mountTarget.parent, { childList: true });
    this.titleReattachObservers.set(leaf, observer);
  }

  private buildRenderSignature(
    leaf: WorkspaceLeaf,
    file: TFile,
    rules: BaseEmbedRule[],
  ): string {
    const ruleKey = rules
      .map((rule) => this.getRuleSignatureKey(rule, leaf))
      .join("|");
    return `${file.path}::${ruleKey}`;
  }

  private hasRenderableHost(container: HTMLElement | null | undefined): boolean {
    if (!container?.isConnected) return false;
    return !!container.querySelector(
      `.${EMBED_CLASS}__panel, .${EMBED_CLASS}__panel[${RENDERING_ATTR}="true"]`
    );
  }

  private canReuseExistingRender(
    leaf: WorkspaceLeaf,
    placement: RuleRenderPlacement,
    container: HTMLElement,
    signature: string,
    shouldResetExpanded: boolean,
  ): boolean {
    if (shouldResetExpanded) {
      this.debugInfo("[TPS Auto Base Embed] [Reuse] failed: shouldResetExpanded=true");
      return false;
    }
    if (!container.isConnected) {
      this.debugInfo("[TPS Auto Base Embed] [Reuse] failed: !container.isConnected");
      return false;
    }
    if (!container.querySelector(`.${EMBED_CLASS}__panel`)) {
      this.debugInfo("[TPS Auto Base Embed] [Reuse] failed: no panel found");
      return false;
    }
    if (!this.hostMatchesPlacementTarget(leaf, placement, container)) {
      this.debugInfo(`[TPS Auto Base Embed] [Reuse] failed: host target mismatch for ${placement}`);
      return false;
    }
    const currentSig = this.renderSignatureByLeaf.get(leaf);
    if (currentSig !== signature) {
      this.debugInfo(`[TPS Auto Base Embed] [Reuse] failed: signature mismatch. Current: ${currentSig}, Target: ${signature}`);
      return false;
    }
    return true;
  }

  private hostMatchesPlacementTarget(
    leaf: WorkspaceLeaf,
    placement: RuleRenderPlacement,
    host: HTMLElement | null | undefined,
  ): boolean {
    if (!host?.isConnected) return false;
    if (placement === 'floating') {
      const view = leaf.view as any;
      const viewContainer = view?.containerEl as HTMLElement | undefined;
      const leafContent = viewContainer?.closest?.('.workspace-leaf-content') as HTMLElement | null;
      const attachTarget = leafContent || viewContainer || null;
      return !!attachTarget && host.parentElement === attachTarget;
    }
    const mountTarget = this.resolveInlineMountTarget(leaf, placement);
    return !!mountTarget && host.parentElement === mountTarget.parent && host.nextSibling === mountTarget.before;
  }

  private mergeRefreshOptions(
    current: { resetExpanded?: boolean } | undefined,
    incoming: { resetExpanded?: boolean } | undefined,
  ): { resetExpanded?: boolean } | undefined {
    if (!current) return incoming;
    if (!incoming) return current;
    return {
      resetExpanded: (current.resetExpanded ?? false) || (incoming.resetExpanded ?? false),
    };
  }

  private async refreshLeaf(leaf: WorkspaceLeaf, options?: { resetExpanded?: boolean }): Promise<void> {
    if (this.refreshInFlight.has(leaf)) {
      const currentFilePath = this.currentFileByLeaf.get(leaf);
      const latestFilePath = this.getLeafFile(leaf)?.path;
      const hosts = this.getAllHostsForLeaf(leaf);
      const modeChanged = hosts.some(([placement, host]) => host?.getAttribute("data-render-mode") !== (placement === 'floating' ? 'floating' : 'inline'));
      const fileChanged = !!currentFilePath && !!latestFilePath && currentFilePath !== latestFilePath;
      if (!fileChanged && !modeChanged) {
        return;
      }
      this.pendingRefreshByLeaf.set(
        leaf,
        this.mergeRefreshOptions(this.pendingRefreshByLeaf.get(leaf), options),
      );
      return;
    }

    this.refreshInFlight.add(leaf);
    try {
      await this.performRefreshLeaf(leaf, options);
    } finally {
      this.refreshInFlight.delete(leaf);
      const pendingOptions = this.pendingRefreshByLeaf.get(leaf);
      if (pendingOptions) {
        this.pendingRefreshByLeaf.delete(leaf);
        window.setTimeout(() => {
          void this.refreshLeaf(leaf, pendingOptions);
        }, 0);
      }
    }
  }

  private async performRefreshLeaf(leaf: WorkspaceLeaf, options?: { resetExpanded?: boolean }): Promise<void> {
    const view = leaf.view;
    const initialFile = this.getLeafFile(leaf);
    this.logScrollSnapshot("refresh-start", leaf, initialFile, {
      resetExpanded: options?.resetExpanded ?? true,
    });
    if (!this.isSupportedLeaf(leaf)) {
      this.releaseSwipeGestureTracking(leaf);
      this.detachContentObserver(leaf);
      this.removeOverlay(leaf);
      return;
    }
    const file = this.getLeafFile(leaf);
    if (!file || (file.extension !== "md" && file.extension !== "canvas")) {
      this.releaseSwipeGestureTracking(leaf);
      this.detachContentObserver(leaf);
      this.currentFileByLeaf.delete(leaf);
      this.renderSignatureByLeaf.delete(leaf);
      this.removeOverlay(leaf);
      return;
    }
    if (!this.settings.enabled) {
      this.releaseSwipeGestureTracking(leaf);
      this.detachContentObserver(leaf);
      this.removeOverlay(leaf);
      return;
    }

    if (this.isPlainSourceModeLeaf(leaf)) {
      this.releaseSwipeGestureTracking(leaf);
      this.detachContentObserver(leaf);
      this.renderSignatureByLeaf.delete(leaf);
      this.removeOverlay(leaf);
      return;
    }

    const shouldResetExpanded = options?.resetExpanded ?? true;
    const prevFilePath = this.currentFileByLeaf.get(leaf);
    const fileChanged = !!prevFilePath && prevFilePath !== file.path;
    if (shouldResetExpanded || fileChanged) {
      this.expandedPanels.delete(leaf);
    }
    this.currentFileByLeaf.set(leaf, file.path);

    // Get matching rules for this file
    const matchingRules = this.settings.rules.filter((rule) => this.shouldEmbedRule(rule, file));
    const matchingRuleGroups = this.groupRulesByPlacement(leaf, matchingRules);

    if (matchingRules.length === 0) {
      const existingContainer = this.getAllHostsForLeaf(leaf).find(([, host]) => host && this.hasRenderableHost(host))?.[1];
      if (
        existingContainer &&
        this.hasRenderableHost(existingContainer) &&
        existingContainer.getAttribute("data-source-path") === file.path
      ) {
        // Tolerate transient cache drops without instantly unmounting everything
        return;
      }
      this.renderSignatureByLeaf.delete(leaf);
      this.releaseSwipeGestureTracking(leaf);
      this.detachContentObserver(leaf);
      this.removeOverlay(leaf);
      return;
    }

    // Initialize expanded set if it doesn't exist (new leaf or reset)
    if (!this.expandedPanels.has(leaf)) {
      const initialSet = new Set<string>();
      for (const rule of matchingRules) {
        const manualState = this.getManualExpansionState(this.getRuleStateKey(rule));
        let shouldExpand = this.settings.defaultExpanded;
        if (rule.initialState === "expanded") shouldExpand = true;
        if (rule.initialState === "collapsed") shouldExpand = false;
        if (manualState !== null) shouldExpand = manualState;

        if (shouldExpand) {
          initialSet.add(this.getRuleStateKey(rule));
        }
      }
      this.expandedPanels.set(leaf, initialSet);
    }

    // Exclude files check (global)
    const excludedFiles = this.parseList(this.settings.excludeFiles);
    if (excludedFiles.some((p) => normalizePath(p) === file.path)) {
      this.detachContentObserver(leaf);
      this.removeOverlay(leaf);
      return;
    }

    const renderSignature = this.buildRenderSignature(leaf, file, matchingRules);
    const lastRefreshMeta = this.lastRefreshMetaByLeaf.get(leaf);
    if (
      lastRefreshMeta?.signature === renderSignature
      && Date.now() - lastRefreshMeta.at < REFRESH_COOLDOWN_MS
      && this.getAllHostsForLeaf(leaf).some(([, host]) => this.hasRenderableHost(host))
      && Array.from(matchingRuleGroups.entries()).every(([placement]) =>
        this.hostMatchesPlacementTarget(leaf, placement, this.getHostForPlacement(leaf, placement))
      )
    ) {
      for (const [placement, rules] of matchingRuleGroups) {
        const container = this.getHostForPlacement(leaf, placement);
        container?.setAttribute("data-base-paths", rules.map((r) => this.getRuleDependencyPath(r)).filter(Boolean).join(","));
        container?.setAttribute("data-source-path", file.path);
      }
      return;
    }
    if (
      this.getAllHostsForLeaf(leaf).length > 0 &&
      this.getAllHostsForLeaf(leaf).every(([placement, container]) =>
        this.canReuseExistingRender(leaf, placement, container, renderSignature, shouldResetExpanded)
      )
    ) {
      for (const [placement, rules] of matchingRuleGroups) {
        const container = this.getHostForPlacement(leaf, placement);
        container?.setAttribute("data-base-paths", rules.map((r) => this.getRuleDependencyPath(r)).filter(Boolean).join(","));
        container?.setAttribute("data-source-path", file.path);
      }
      return;
    }
    
    const nextToken = (this.renderTokens.get(leaf) ?? 0) + 1;
    this.renderTokens.set(leaf, nextToken);

    const ruleStateKeys = matchingRules.map((rule) => this.getRuleStateKey(rule));
    const expanded = this.getExpandedSet(leaf);
    for (const path of Array.from(expanded)) {
      if (!ruleStateKeys.includes(path)) expanded.delete(path);
    }

    // Seed the cooldown timestamp BEFORE rendering so the metadataCache.changed
    // guard is active if MarkdownRenderer.render (fallback path) is used.
    this.lastRefreshMetaByLeaf.set(leaf, { signature: renderSignature, at: Date.now() });

    const desiredPlacements = new Set<RuleRenderPlacement>(matchingRuleGroups.keys());
    for (const [placement, host] of this.getAllHostsForLeaf(leaf)) {
      if (!desiredPlacements.has(placement)) {
        this.clearPanels(host);
        host.remove();
        this.deleteHostForPlacement(leaf, placement);
      }
    }

    let renderedPanelCount = 0;
    for (const [placement, rules] of matchingRuleGroups) {
      const container = this.ensureHost(leaf, placement);
      if (!container) {
        this.scheduleLeafRefresh(leaf, { resetExpanded: false }, 250);
        return;
      }
      this.clearPanels(container);
      const renderableRules = this.getRenderableRulesForSource(rules, file.path);
      container.setAttribute("data-base-paths", renderableRules.map((r) => this.getRuleDependencyPath(r)).filter(Boolean).join(","));
      container.setAttribute("data-source-path", file.path);

      if (renderableRules.length === 0) {
        continue;
      }

      if (renderableRules.length === 1) {
        const panel = await this.buildPanel(leaf, renderableRules[0], file.path, view as any, nextToken, container);
        if (panel && this.renderTokens.get(leaf) === nextToken) {
          renderedPanelCount += 1;
        }
        continue;
      }

      renderedPanelCount += await this.buildTabbedPanelsForPlacement(
        leaf,
        placement,
        renderableRules,
        file.path,
        view as any,
        nextToken,
        container,
      );
    }

    if (renderedPanelCount === 0) {
      this.renderSignatureByLeaf.delete(leaf);
      this.releaseSwipeGestureTracking(leaf);
      this.detachContentObserver(leaf);
      this.removeOverlay(leaf);
      this.logScrollSnapshot("refresh-empty", leaf, file, { token: nextToken });
      return;
    }

    this.renderSignatureByLeaf.set(leaf, renderSignature);
    // Refresh the timestamp now that all panels have finished rendering, so the
    // cooldown window extends from render-end rather than only from render-start.
    this.lastRefreshMetaByLeaf.set(leaf, { signature: renderSignature, at: Date.now() });
    this.ensureSwipeGestureTracking(leaf);
    this.attachContentObserver(leaf);
    if (options) {
      this.setSwipeCollapsed(false);
    } else {
      this.applyOverlayVisibility(leaf);
    }
      this.logScrollSnapshot("refresh-end", leaf, file, {
      token: nextToken,
      panels: renderedPanelCount,
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
    let overlay = this.getHostForPlacement(leaf, 'floating');
    const view = leaf.view;
    const viewContainer = (view as any).containerEl as HTMLElement | undefined;
    if (!viewContainer) return document.createElement("div");

    const leafContent = viewContainer.closest(".workspace-leaf-content") as HTMLElement | null;
    const attachTarget = leafContent || viewContainer;

    if (overlay && overlay.isConnected) {
      if (overlay.parentElement !== attachTarget) {
        attachTarget.appendChild(overlay);
        if (leafContent) {
          this.attachOverlayObserver(leaf, overlay, leafContent);
        }
      }
      overlay.setAttribute("data-render-mode", "floating");
      overlay.removeAttribute("data-inline-placement");
      overlay.style.removeProperty("visibility");
      overlay.style.removeProperty("opacity");
      overlay.style.removeProperty("pointer-events");
      this.applyOverlayVisibility(leaf);
      return overlay;
    }

    if (leafContent && getComputedStyle(leafContent).position === "static") {
      leafContent.style.position = "relative";
    }

    overlay = document.createElement("div");
    overlay.className = EMBED_CLASS;
    overlay.setAttribute("data-render-mode", "floating");
    overlay.innerHTML = "";
    attachTarget.appendChild(overlay);
    if (leafContent) {
      this.attachOverlayObserver(leaf, overlay, leafContent);
    }

    this.setHostForPlacement(leaf, 'floating', overlay);
    this.applyOverlayVisibility(leaf);
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
      this.syncGlobalFloatingEmbedHeight();
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

  private syncGlobalFloatingEmbedHeight(): void {
    const overlays = Array.from(
      document.querySelectorAll<HTMLElement>(`.${EMBED_CLASS}[data-render-mode="floating"]`),
    ).filter((overlay) => overlay.isConnected);

    const maxHeight = overlays.reduce((largest, overlay) => {
      const rect = overlay.getBoundingClientRect();
      const height = Number.isFinite(rect.height) ? Math.ceil(rect.height) : 0;
      return Math.max(largest, height);
    }, 0);

    const heightValue = `${maxHeight}px`;
    document.body?.style.setProperty("--tps-auto-base-embed-height", heightValue);
    document.documentElement?.style.setProperty("--tps-auto-base-embed-height", heightValue);
  }

  private scheduleTypingRefresh(leaf: WorkspaceLeaf): void {
    this.lastTypingAt.set(leaf, Date.now());
    const existing = this.typingRefreshTimers.get(leaf);
    if (existing != null) {
      window.clearTimeout(existing);
    }
    const timer = window.setTimeout(() => {
      this.typingRefreshTimers.delete(leaf);
      void this.refreshLeaf(leaf, { resetExpanded: false });
    }, this.hasAfterContentRulesForLeaf(leaf) ? 80 : 180);
    this.typingRefreshTimers.set(leaf, timer);
  }

  private hasExpandedPanel(leaf: WorkspaceLeaf): boolean {
    return this.getAllHostsForLeaf(leaf).some(([, overlay]) => {
      if (!overlay?.isConnected) return false;
      const panels = Array.from(overlay.querySelectorAll<HTMLElement>(`.${EMBED_CLASS}__panel`));
      return panels.some((panel) => panel.getAttribute(COLLAPSED_ATTR) === "false");
    });
  }

  private unloadPanel(panel: HTMLElement): void {
    const headerObserver = this.headerObservers.get(panel);
    if (headerObserver) {
      headerObserver.disconnect();
      this.headerObservers.delete(panel);
    }
    this.disconnectDataviewTaskObserversWithin(panel);
    const embed = this.panelEmbeds.get(panel);
    if (embed) {
      try {
        // removeChild triggers embed.unload() and removes it from the component tree.
        this.removeChild(embed);
      } catch {
        try { embed.unload?.(); } catch { /* ignore */ }
      }
      this.panelEmbeds.delete(panel);
    }
    panel.remove();
  }

  private clearPanels(container: HTMLElement): void {
    const panels = Array.from(container.querySelectorAll<HTMLElement>(`.${EMBED_CLASS}__panel`));
    for (const panel of panels) {
      this.unloadPanel(panel);
    }
    container.innerHTML = "";
  }

  private async buildPanel(
    leaf: WorkspaceLeaf,
    rule: BaseEmbedRule,
    sourcePath: string,
    view: any,
    renderToken: number,
    container?: HTMLElement
  ): Promise<HTMLElement | null> {
    if (this.renderTokens.get(leaf) !== renderToken) return null;
    const panel = document.createElement("div");
    panel.className = `${EMBED_CLASS}__panel`;
    const ruleKey = this.getRuleStateKey(rule);
    const displayLabel = this.getRuleDisplayLabel(rule);
    const alwaysExpanded = this.settings.alwaysExpanded;
    const isExpanded = alwaysExpanded || this.getExpandedSet(leaf).has(ruleKey);
    panel.setAttribute(COLLAPSED_ATTR, "false");
    panel.setAttribute(RENDERING_ATTR, "true");
    panel.setAttribute("data-base-path", ruleKey);

    if (!alwaysExpanded) {
      panel.innerHTML = `
        <div class="${EMBED_CLASS}__bar">
          <div class="${EMBED_CLASS}__bar-left">
            <span class="${EMBED_CLASS}__bar-label">${displayLabel}</span>
          </div>
          <div class="${EMBED_CLASS}__bar-right">
            <button class="${EMBED_CLASS}__toggle" aria-label="Expand embedded panel">▸</button>
          </div>
        </div>
        <div class="${EMBED_CLASS}__content"></div>
      `;

      const toggle = panel.querySelector<HTMLButtonElement>(`.${EMBED_CLASS}__toggle`);
      const bar = panel.querySelector<HTMLElement>(`.${EMBED_CLASS}__bar`);
      const contentEl = panel.querySelector<HTMLElement>(`.${EMBED_CLASS}__content`);
      const togglePanel = () => {
        const collapsed = panel.getAttribute(COLLAPSED_ATTR) === "true";

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
          expandedSet.add(ruleKey);
          this.setManualExpansionState(ruleKey, true);
        } else {
          expandedSet.delete(ruleKey);
          this.setManualExpansionState(ruleKey, false);
        }
        if (contentEl) {
          if (!collapsed) {
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
    } else {
      panel.innerHTML = `<div class="${EMBED_CLASS}__content"></div>`;
    }

    const contentEl = panel.querySelector<HTMLElement>(`.${EMBED_CLASS}__content`);
    if (!contentEl) return panel;
    contentEl.empty();
    const renderTarget = document.createElement("div");
    renderTarget.className = "markdown-preview-view markdown-rendered";
    renderTarget.setAttribute("data-mode", "preview");
    renderTarget.setAttribute("data-type", "markdown");
    contentEl.appendChild(renderTarget);

    if (container) {
      container.appendChild(panel);
    }

    // Prefer app.embedRegistry over MarkdownRenderer.render.
    //
    // MarkdownRenderer.render(app, "![[base.base]]", el, sourcePath, view)
    // causes Obsidian to register sourcePath as embedding base.base in the
    // metadataCache. This fires metadataCache.changed for the NOTE repeatedly
    // as the Bases plugin updates its query results — creating an infinite
    // refresh loop in inline mode.
    //
    // app.embedRegistry instantiates the Bases embed component directly,
    // bypassing markdown parsing and metadata registration entirely while
    // still passing the correct sourcePath for query/filter resolution.
    await this.renderRuleIntoTarget(rule, renderTarget, sourcePath, view as MarkdownView | null, panel);
    if (this.renderTokens.get(leaf) !== renderToken) return null;
    this.syncEmbeddedPanelMode(contentEl, panel);
    this.attachHeaderObserver(leaf, contentEl, panel);
    if (panel.getAttribute(COLLAPSED_ATTR) === "false") {
      panel.setAttribute(RENDERING_ATTR, "false");
    }

    // Guard: if this panel wasn't explicitly expanded by the user, keep it collapsed after initial render.
    if (!alwaysExpanded && !this.getExpandedSet(leaf).has(ruleKey)) {
      panel.setAttribute(COLLAPSED_ATTR, "true");
      const toggleBtn = panel.querySelector<HTMLButtonElement>(`.${EMBED_CLASS}__toggle`);
      if (toggleBtn) toggleBtn.textContent = "▸";
    }

    return panel;
  }

  private attachHeaderObserver(leaf: WorkspaceLeaf, contentEl: HTMLElement, panel: HTMLElement): void {
    // No longer needed — we don't touch the Bases DOM at all.
    // The bar label is set from the file name at panel-build time.
    panel.setAttribute(RENDERING_ATTR, "false");
  }

  private syncEmbeddedPanelMode(contentEl: HTMLElement, panel: HTMLElement): void {
    const calendarSelector = ".bases-calendar-wrapper, .calendar-embed-view, .fc";
    const kanbanSelector = ".tps-kanban-container, .tps-kanban-board, .tps-kanban-root";
    const isCalendarPanel = !!contentEl.querySelector<HTMLElement>(calendarSelector);
    const isKanbanPanel = !!contentEl.querySelector<HTMLElement>(kanbanSelector);
    panel.classList.toggle(`${EMBED_CLASS}__panel--calendar`, isCalendarPanel);
    panel.classList.toggle(`${EMBED_CLASS}__panel--kanban`, isKanbanPanel);
  }

  private syncBaseHeader(_contentEl: HTMLElement, _panel: HTMLElement): void {
    // No-op: we no longer touch the Bases DOM. The bar label is a static text
    // node set from the base filename when the panel is built.
  }

  private removeOverlay(leaf: WorkspaceLeaf): void {
    this.releaseSwipeGestureTracking(leaf);
    this.detachContentObserver(leaf);
    const retryTimer = this.leafRetryTimers.get(leaf);
    if (retryTimer != null) {
      window.clearTimeout(retryTimer);
      this.leafRetryTimers.delete(leaf);
    }
    this.renderSignatureByLeaf.delete(leaf);
    this.lastRefreshMetaByLeaf.delete(leaf);
    const reattachObserver = this.titleReattachObservers.get(leaf);
    if (reattachObserver) {
      reattachObserver.disconnect();
      this.titleReattachObservers.delete(leaf);
    }
    const observer = this.overlayObservers.get(leaf);
    if (observer) {
      observer.disconnect();
      this.overlayObservers.delete(leaf);
    }
    const view = leaf.view as any;
    const viewContainer = (view as any).containerEl as HTMLElement | undefined;
    const leafContent = viewContainer?.closest?.(".workspace-leaf-content") as HTMLElement | null;
    leafContent?.style.removeProperty("--tps-auto-base-embed-height");
    for (const [placement, overlay] of this.getAllHostsForLeaf(leaf)) {
      if (overlay?.isConnected) {
        this.clearPanels(overlay);
        overlay.remove();
      }
      this.deleteHostForPlacement(leaf, placement);
    }
    this.syncGlobalFloatingEmbedHeight();
    const anchorMap = this.inlineAnchorsByLeaf.get(leaf);
    if (anchorMap) {
      for (const anchor of anchorMap.values()) {
        const section = anchor.parentElement;
        if (section?.classList.contains(INLINE_SECTION_CLASS) && section.isConnected) {
          section.remove();
          continue;
        }
        if (anchor?.isConnected) {
          anchor.remove();
        }
      }
    }
    this.inlineAnchorsByLeaf.delete(leaf);
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
        display: block;
        flex: 0 0 100%;
        align-self: stretch;
        left: auto;
        transform: none;
        bottom: auto;
        z-index: 0;
        clear: both;
        margin: 14px 0 0;
        padding-top: 12px;
      }
      .${EMBED_CLASS}[data-render-mode="inline"][data-inline-placement="after-content"] {
        border-top: 1px solid var(--background-modifier-border);
      }
      .${EMBED_CLASS}[data-render-mode="inline"][data-inline-placement="after-title"] {
        border-bottom: 1px solid var(--background-modifier-border);
        padding-top: 0;
        padding-bottom: 12px;
        margin-top: 10px;
      }
      .${INLINE_ANCHOR_CLASS}[data-inline-placement="after-title"],
      .${INLINE_ANCHOR_CLASS}[data-inline-placement="after-content"] {
        display: block;
        width: 100%;
        clear: both;
        flex: 0 0 100%;
        align-self: stretch;
      }
      .${INLINE_SECTION_CLASS}[data-inline-placement="after-title"],
      .${INLINE_SECTION_CLASS}[data-inline-placement="after-content"] {
        display: block;
        width: 100%;
        max-width: 100%;
        clear: both;
      }
      .${SOURCE_END_WIDGET_CLASS} {
        display: block;
        width: 100%;
        margin: 0;
        padding: 0;
        line-height: 0;
        font-size: 0;
        pointer-events: none;
      }
      .${SOURCE_END_HOST_CLASS} {
        display: block;
        width: 100%;
        margin: 0;
        padding: 0;
        line-height: normal;
        font-size: var(--font-text-size);
        pointer-events: auto;
      }
      .${EMBED_CLASS}[data-render-mode="inline"][data-inline-placement="after-content"] {
        margin-top: 18px;
        margin-bottom: 0;
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
      .${EMBED_CLASS}__panel[hidden] {
        display: none !important;
      }
      .${EMBED_CLASS}__tab-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .${EMBED_CLASS}__tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .${EMBED_CLASS}__tab {
        appearance: none;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-secondary);
        color: var(--text-muted);
        border-radius: 999px;
        padding: 0.28em 0.7em;
        line-height: 1.2;
        cursor: pointer;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .${EMBED_CLASS}__tab--active {
        background: var(--interactive-accent);
        color: var(--text-on-accent, var(--text-normal));
        border-color: var(--interactive-accent);
      }
      .${EMBED_CLASS}__tab-panels {
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
      .${EMBED_CLASS}__panel--calendar .${EMBED_CLASS}__content,
      .${EMBED_CLASS}__panel--kanban .${EMBED_CLASS}__content {
        max-height: none;
      }
      .${EMBED_CLASS}__panel--calendar .${EMBED_CLASS}__content {
        overflow: hidden;
      }
      .${EMBED_CLASS}__panel--kanban .${EMBED_CLASS}__content {
        overflow: visible;
      }
      .${EMBED_CLASS}__panel--kanban .workspace-leaf-content,
      .${EMBED_CLASS}__panel--kanban .view-content,
      .${EMBED_CLASS}__panel--kanban .markdown-preview-view,
      .${EMBED_CLASS}__panel--kanban .markdown-rendered,
      .${EMBED_CLASS}__panel--kanban .tps-kanban-scroll,
      .${EMBED_CLASS}__panel--kanban .tps-kanban-container,
      .${EMBED_CLASS}__panel--kanban .tps-kanban-board,
      .${EMBED_CLASS}__panel--kanban .tps-kanban-lane,
      .${EMBED_CLASS}__panel--kanban .tps-kanban-cards {
        height: auto !important;
        max-height: none !important;
        min-height: 0 !important;
      }
      .${EMBED_CLASS}__panel--kanban .workspace-leaf-content,
      .${EMBED_CLASS}__panel--kanban .view-content,
      .${EMBED_CLASS}__panel--kanban .tps-kanban-scroll,
      .${EMBED_CLASS}__panel--kanban .tps-kanban-container,
      .${EMBED_CLASS}__panel--kanban .tps-kanban-board,
      .${EMBED_CLASS}__panel--kanban .tps-kanban-lane,
      .${EMBED_CLASS}__panel--kanban .tps-kanban-cards {
        overflow: visible !important;
        flex: 0 0 auto !important;
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
      .${EMBED_CLASS}__bar-label {
        font-size: 0.95em;
        font-weight: 600;
        color: var(--text-normal);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .${EMBED_CLASS}__hidden-header {
        display: none !important;
      }
      /* ── Embedded content cleanup ────────────────────────────────────── */
      /* Strip the "[[filename]]" link Obsidian renders above MarkdownRenderer embeds */
      .${EMBED_CLASS}__content .markdown-embed-link {
        display: none !important;
      }
      /* Strip the floating "edit block" affordance in reading-view previews */
      .${EMBED_CLASS}__content .edit-block-button {
        display: none !important;
      }
      /* Remove markdown-embed wrapper chrome when using MarkdownRenderer fallback */
      .${EMBED_CLASS}__content .markdown-embed {
        border: none !important;
        margin: 0 !important;
        padding: 0 !important;
        box-shadow: none !important;
        background: transparent !important;
      }
      .${EMBED_CLASS}__content .markdown-embed-content {
        margin: 0 !important;
        padding: 0 !important;
      }
      /* ── Feed-bases: hide leaf chrome ────────────────────────────────── */
      /* view.containerEl wraps the full workspace leaf including the header bar.
         Strip everything except the actual editor content. */
      .${EMBED_CLASS}__content .bases-feed-entry-content .view-header,
      .${EMBED_CLASS}__content .bases-feed-entry-content .view-header-container,
      .${EMBED_CLASS}__content .bases-feed-entry-content .view-actions,
      .${EMBED_CLASS}__content .bases-feed-entry-content .view-header-nav-buttons,
      .${EMBED_CLASS}__content .bases-feed-entry-content .workspace-leaf-resize-handle,
      .${EMBED_CLASS}__content .bases-feed-entry-content .inline-title,
      .${EMBED_CLASS}__content .bases-feed-entry-content .edit-block-button,
      .${EMBED_CLASS}__content .bases-feed-entry-content .metadata-container {
        display: none !important;
      }
      /* Remove leaf padding/margins and make the editor fill the card naturally */
      .${EMBED_CLASS}__content .bases-feed-entry-content .workspace-leaf-content {
        padding: 0 !important;
      }
      .${EMBED_CLASS}__content .bases-feed-entry-content .cm-editor {
        padding: 0 !important;
      }
      .${EMBED_CLASS}__content .bases-feed-entry-content .cm-content {
        padding: 4px 0 8px !important;
      }
      .${EMBED_CLASS}__content .bases-feed-entry-content .cm-scroller {
        overflow: visible !important;
      }
      /* ── Feed-bases: layout ──────────────────────────────────────────── */
      .${EMBED_CLASS}__content .bases-feed-container {
        max-height: 100%;
        overflow: auto;
        position: relative;
        width: 100%;
      }
      .${EMBED_CLASS}__content .bases-feed,
      .${EMBED_CLASS}__content .bases-feed-single-column,
      .${EMBED_CLASS}__content .bases-feed-masonry {
        max-width: 100% !important;
        width: 100%;
      }
      /* ── Kill Tanstack virtual positioning — revert to normal flow ──── */
      /* The virtualizer sets height on the wrapper and position:absolute +
         translateY(Npx) on each item via inline styles.  Inside our embed panel
         those absolute offsets create large blank gaps.  Force document flow. */
      .${EMBED_CLASS}__content .bases-feed-virtualizer {
        height: auto !important;   /* override inline height: NNNpx from React */
        position: static !important;
        width: 100%;
      }
      .${EMBED_CLASS}__content .bases-feed-virtual-item {
        position: relative !important;  /* override position: absolute from Obsidian CSS */
        transform: none !important;     /* override inline translateY(Npx) from React */
        width: 100%;
      }
      /* Let the workspace-leaf embedded in each entry render at natural height */
      .${EMBED_CLASS}__content .bases-feed-entry-content > *,
      .${EMBED_CLASS}__content .bases-feed-entry-content .view-content,
      .${EMBED_CLASS}__content .bases-feed-entry-content .markdown-source-view {
        height: auto !important;
        min-height: 0 !important;
        flex: unset !important;
      }
      /* ── Feed entry card — reset to native-note appearance ───────────── */
      /* Strip the card box: no border, no background, no shadow, no radius */
      .${EMBED_CLASS}__content .bases-feed-entry {
        background: transparent !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        padding: 0 0 16px 0 !important;
        margin: 0 !important;
      }
      .${EMBED_CLASS}__content .bases-feed-entry:last-child {
        padding-bottom: 0 !important;
      }
      /* Thin separator line between entries instead of the card border */
      .${EMBED_CLASS}__content .bases-feed-virtual-item + .bases-feed-virtual-item .bases-feed-entry,
      .${EMBED_CLASS}__content .bases-feed-entry + .bases-feed-entry {
        border-top: 1px solid var(--background-modifier-border) !important;
        padding-top: 14px !important;
      }
      /* ── Feed entry header / title ───────────────────────────────────── */
      .${EMBED_CLASS}__content .bases-feed-entry-header {
        margin: 0 0 4px 0;
        padding: 0;
      }
      /* Make the title look like a plain heading, not a hyperlink */
      .${EMBED_CLASS}__content .bases-feed-entry-title {
        display: block;
        font-size: 1em;
        font-weight: 600;
        color: var(--text-normal) !important;
        text-decoration: none !important;
        cursor: default;
        pointer-events: none;
      }
      /* Re-enable pointer events just for hover preview so Ctrl+hover still works */
      .${EMBED_CLASS}__content .bases-feed-entry-title:hover {
        color: var(--text-normal) !important;
        text-decoration: none !important;
      }
      /* \u2500\u2500 Canvas-node embed overlay \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
      /* Override position: the overlay sits at the bottom inside the canvas node */
      .${EMBED_CLASS}--canvas-node {
        position: absolute;
        bottom: 8px;
        left: 50%;
        transform: translateX(-50%);
        width: min(calc(100% - 14px), 560px);
        z-index: 10;
        pointer-events: auto;
      }
      /* Collapse the expanded-panel max-height for canvas since nodes can be small */
      .${EMBED_CLASS}--canvas-node .${EMBED_CLASS}__panel[${COLLAPSED_ATTR}="false"] .${EMBED_CLASS}__content {
        max-height: 50vh;
      }
      /* Make the bar slightly more compact inside canvas nodes */
      .${EMBED_CLASS}--canvas-node .${EMBED_CLASS}__bar {
        padding: 3px 7px;
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
        this.updateBottomObstructionOffset();
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement?.closest(`.${EMBED_CLASS}`)) {
        if (this.keyboardHidden) {
          document.body.classList.remove("tps-auto-base-embed-hidden-for-keyboard");
          this.keyboardHidden = false;
        }
        this.updateBottomObstructionOffset();
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
      this.updateBottomObstructionOffset();
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

  private updateBottomObstructionOffset(): void {
    if (typeof document === "undefined") return;

    const isMobile =
      window.innerWidth < 768 ||
      document.body.classList.contains("is-mobile") ||
      document.body.classList.contains("is-phone");

    if (!isMobile) {
      document.documentElement.style.setProperty("--tps-auto-base-embed-bottom", "16px");
      return;
    }

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    let maxObstruction = 0;
    const candidates = Array.from(document.body?.querySelectorAll<HTMLElement>("*") || []);

    for (const el of candidates) {
      if (!el.isConnected) continue;
      if (
        el.closest(`.${EMBED_CLASS}`) ||
        el.closest(".tps-global-context-menu") ||
        el.closest(".menu") ||
        el.closest(".modal")
      ) {
        continue;
      }

      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") continue;
      if (style.position !== "fixed" && style.position !== "sticky") continue;

      const rect = el.getBoundingClientRect();
      if (!Number.isFinite(rect.height) || rect.height <= 0) continue;
      if (viewportHeight > 0 && rect.bottom < viewportHeight - 4) continue;
      if (rect.top > viewportHeight - Math.max(160, viewportHeight * 0.4)) {
        maxObstruction = Math.max(maxObstruction, Math.ceil(rect.height));
      }
    }

    const offset = maxObstruction > 0 ? maxObstruction + 12 : 16;
    document.documentElement.style.setProperty("--tps-auto-base-embed-bottom", `${offset}px`);
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  Canvas-node embed system
  // ═══════════════════════════════════════════════════════════════════════════

  private startCanvasLeafWatcher(leaf: WorkspaceLeaf): void {
    if (this.canvasLeafData.has(leaf)) return;

    const data = {
      observer: null as MutationObserver | null,
      nodeOverlays: new Map<HTMLElement, HTMLElement>(),
      nodeExpanded: new Map<HTMLElement, Set<string>>(),
      nodeActiveTabs: new Map<HTMLElement, string>(),
      nodeSig: new Map<HTMLElement, string>(),
    };
    this.canvasLeafData.set(leaf, data);

    const containerEl = (leaf.view as any)?.containerEl as HTMLElement | undefined;
    if (containerEl) {
      data.observer = new MutationObserver(() => this.scheduleCanvasScan(leaf));
      data.observer.observe(containerEl, { childList: true, subtree: true });
    }

    this.scheduleCanvasScan(leaf);
  }

  private stopCanvasLeafWatcher(leaf: WorkspaceLeaf): void {
    const data = this.canvasLeafData.get(leaf);
    if (!data) return;

    data.observer?.disconnect();

    for (const [, overlay] of data.nodeOverlays) {
      this.clearPanels(overlay);
      overlay.remove();
    }
    data.nodeOverlays.clear();
    data.nodeExpanded.clear();
    data.nodeSig.clear();

    const timer = this.canvasScanTimers.get(leaf);
    if (timer != null) {
      window.clearTimeout(timer);
      this.canvasScanTimers.delete(leaf);
    }

    this.canvasLeafData.delete(leaf);
  }

  private scheduleCanvasScan(leaf: WorkspaceLeaf): void {
    const existing = this.canvasScanTimers.get(leaf);
    if (existing != null) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.canvasScanTimers.delete(leaf);
      void this.scanCanvasNodes(leaf);
    }, 400);
    this.canvasScanTimers.set(leaf, timer);
  }

  private async scanCanvasNodes(leaf: WorkspaceLeaf): Promise<void> {
    if (!this.settings.enableCanvasNodeEmbeds || !this.settings.enabled) return;
    const data = this.canvasLeafData.get(leaf);
    if (!data) return;

    const canvas = (leaf.view as any)?.canvas as any;
    if (!canvas?.nodes) return;

    const activeNodeEls = new Set<HTMLElement>();

    for (const [, node] of canvas.nodes as Map<string, any>) {
      const file = node.file as TFile | undefined;
      const nodeEl = node.nodeEl as HTMLElement | undefined;
      if (!nodeEl || !(file instanceof TFile)) continue;

      activeNodeEls.add(nodeEl);

      const matchingRules = this.settings.rules.filter(r => this.shouldEmbedRule(r, file));
      const renderableRules = this.getRenderableRulesForSource(matchingRules, file.path);

      if (renderableRules.length === 0) {
        const overlay = data.nodeOverlays.get(nodeEl);
        if (overlay) {
          this.clearPanels(overlay);
          overlay.remove();
          data.nodeOverlays.delete(nodeEl);
          data.nodeActiveTabs.delete(nodeEl);
          data.nodeSig.delete(nodeEl);
        }
        continue;
      }

      const newSig = `canvas::${file.path}::${renderableRules.map((rule) => this.getRuleSignatureKey(rule, leaf)).join('|')}`;
      const existingSig = data.nodeSig.get(nodeEl);
      const existingOverlay = data.nodeOverlays.get(nodeEl);

      // Skip rebuild if signature and DOM match
      if (
        existingSig === newSig &&
        existingOverlay?.isConnected &&
        existingOverlay.querySelector(`.${EMBED_CLASS}__panel`)
      ) {
        continue;
      }

      // Prevent concurrent builds for the same node
      if (this.canvasNodeBuilding.has(nodeEl)) continue;
      this.canvasNodeBuilding.add(nodeEl);

      try {
        // Get or create overlay container inside the canvas node
        let overlay = data.nodeOverlays.get(nodeEl);
        if (!overlay || !overlay.isConnected) {
          overlay = this.createCanvasNodeOverlayContainer(nodeEl);
          if (!overlay) {
            this.canvasNodeBuilding.delete(nodeEl);
            continue;
          }
          data.nodeOverlays.set(nodeEl, overlay);
        }

        // Get or initialise expanded set for this node
        if (!data.nodeExpanded.has(nodeEl)) {
          const initial = new Set<string>();
          for (const rule of renderableRules) {
            const manualState = this.getManualExpansionState(this.getRuleStateKey(rule));
            let expand = this.settings.defaultExpanded;
            if (rule.initialState === "expanded") expand = true;
            if (rule.initialState === "collapsed") expand = false;
            if (manualState !== null) expand = manualState;
            if (expand) initial.add(this.getRuleStateKey(rule));
          }
          data.nodeExpanded.set(nodeEl, initial);
        }
        const expandedSet = data.nodeExpanded.get(nodeEl)!;

        // Remove old panels
        const oldPanels = Array.from(overlay.querySelectorAll<HTMLElement>(`.${EMBED_CLASS}__panel`));
        for (const p of oldPanels) this.unloadPanel(p);

        // Build new panels
        const excludedFiles = this.parseList(this.settings.excludeFiles);
        if (!excludedFiles.some(p => normalizePath(p) === file.path)) {
          if (renderableRules.length === 1) {
            await this.buildCanvasNodePanel(nodeEl, overlay, renderableRules[0], file.path, expandedSet);
          } else {
            await this.buildTabbedPanelsForCanvasNode(
              nodeEl,
              overlay,
              renderableRules,
              file.path,
              expandedSet,
              data.nodeActiveTabs.get(nodeEl),
              (ruleKey) => data.nodeActiveTabs.set(nodeEl, ruleKey),
            );
          }
        }

        data.nodeSig.set(nodeEl, newSig);

        // If no panels were built, remove the overlay container
        if (!overlay.querySelector(`.${EMBED_CLASS}__panel`)) {
          overlay.remove();
          data.nodeOverlays.delete(nodeEl);
          data.nodeActiveTabs.delete(nodeEl);
          data.nodeSig.delete(nodeEl);
        }
      } finally {
        this.canvasNodeBuilding.delete(nodeEl);
      }
    }

    // Remove overlays for canvas nodes that no longer exist
    for (const [nodeEl, overlay] of data.nodeOverlays) {
      if (!activeNodeEls.has(nodeEl)) {
        this.clearPanels(overlay);
        overlay.remove();
        data.nodeOverlays.delete(nodeEl);
        data.nodeActiveTabs.delete(nodeEl);
        data.nodeSig.delete(nodeEl);
      }
    }
  }

  /**
   * Creates an overlay container div and attaches it to the canvas node's
   * display element. Returns null if no suitable insertion point is found.
   */
  private createCanvasNodeOverlayContainer(nodeEl: HTMLElement): HTMLElement | null {
    const display = nodeEl.querySelector<HTMLElement>(".canvas-node-display") ?? nodeEl;
    // Ensure the parent has relative positioning so our absolute overlay works
    if (getComputedStyle(display).position === "static") {
      (display as HTMLElement).style.position = "relative";
    }
    const container = document.createElement("div");
    container.className = `${EMBED_CLASS} ${EMBED_CLASS}--canvas-node`;
    container.setAttribute("data-render-mode", "canvas-node");
    display.appendChild(container);
    return container;
  }

  /**
   * Builds a single embed panel for a canvas node. Mirrors buildPanel() but
   * takes node-local state instead of a WorkspaceLeaf.
   */
  private async buildCanvasNodePanel(
    nodeEl: HTMLElement,
    container: HTMLElement,
    rule: BaseEmbedRule,
    sourcePath: string,
    expandedSet: Set<string>,
  ): Promise<HTMLElement | null> {
    const panel = document.createElement("div");
    panel.className = `${EMBED_CLASS}__panel`;
    const ruleKey = this.getRuleStateKey(rule);
    const displayLabel = this.getRuleDisplayLabel(rule);
    const alwaysExpanded = this.settings.alwaysExpanded;
    const isExpanded = alwaysExpanded || expandedSet.has(ruleKey);
    panel.setAttribute(COLLAPSED_ATTR, "false");
    panel.setAttribute(RENDERING_ATTR, "true");
    panel.setAttribute("data-base-path", ruleKey);

    if (!alwaysExpanded) {
      panel.innerHTML = `
        <div class="${EMBED_CLASS}__bar">
          <div class="${EMBED_CLASS}__bar-left">
            <span class="${EMBED_CLASS}__bar-label">${displayLabel}</span>
          </div>
          <div class="${EMBED_CLASS}__bar-right">
            <button class="${EMBED_CLASS}__toggle" aria-label="Expand embedded panel">▸</button>
          </div>
        </div>
        <div class="${EMBED_CLASS}__content"></div>
      `;

      const toggle = panel.querySelector<HTMLButtonElement>(`.${EMBED_CLASS}__toggle`);
      const bar = panel.querySelector<HTMLElement>(`.${EMBED_CLASS}__bar`);

      if (toggle) {
        toggle.textContent = isExpanded ? "▾" : "▸";
        this.fenceCanvasInteraction(toggle);
        toggle.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const collapsed = panel.getAttribute(COLLAPSED_ATTR) === "true";
          panel.setAttribute(COLLAPSED_ATTR, collapsed ? "false" : "true");
          if (toggle) toggle.textContent = collapsed ? "▾" : "▸";
          if (collapsed) {
            expandedSet.add(ruleKey);
            this.setManualExpansionState(ruleKey, true);
          } else {
            expandedSet.delete(ruleKey);
            this.setManualExpansionState(ruleKey, false);
          }
        });
      }
      if (bar) {
        this.fenceCanvasInteraction(bar);
        bar.addEventListener("click", (event) => {
          const target = event.target as HTMLElement | null;
          if (target?.closest(`.${EMBED_CLASS}__toggle`)) return;
          if (target?.closest("button, a, input, textarea, select, [contenteditable='true']")) return;
          event.preventDefault();
          event.stopPropagation();
          const collapsed = panel.getAttribute(COLLAPSED_ATTR) === "true";
          panel.setAttribute(COLLAPSED_ATTR, collapsed ? "false" : "true");
          const toggleBtn = panel.querySelector<HTMLButtonElement>(`.${EMBED_CLASS}__toggle`);
          if (toggleBtn) toggleBtn.textContent = collapsed ? "▾" : "▸";
          if (collapsed) {
            expandedSet.add(ruleKey);
            this.setManualExpansionState(ruleKey, true);
          } else {
            expandedSet.delete(ruleKey);
            this.setManualExpansionState(ruleKey, false);
          }
        });
      }
    } else {
      panel.innerHTML = `<div class="${EMBED_CLASS}__content"></div>`;
    }

    const contentEl = panel.querySelector<HTMLElement>(`.${EMBED_CLASS}__content`);
    if (!contentEl) return panel;
    contentEl.empty();

    const renderTarget = document.createElement("div");
    renderTarget.className = "markdown-preview-view markdown-rendered";
    renderTarget.setAttribute("data-mode", "preview");
    contentEl.appendChild(renderTarget);

    container.appendChild(panel);

    await this.renderRuleIntoTarget(rule, renderTarget, sourcePath, null, panel);

    this.syncEmbeddedPanelMode(contentEl, panel);
    panel.setAttribute(RENDERING_ATTR, "false");

    if (!alwaysExpanded && !expandedSet.has(ruleKey)) {
      panel.setAttribute(COLLAPSED_ATTR, "true");
      const toggleBtn = panel.querySelector<HTMLButtonElement>(`.${EMBED_CLASS}__toggle`);
      if (toggleBtn) toggleBtn.textContent = "▸";
    }

    return panel;
  }
}
