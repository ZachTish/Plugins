import { MarkdownView, TFile, WorkspaceLeaf, Platform, debounce, setIcon, Menu, normalizePath } from 'obsidian';
import type TPSGlobalContextMenuPlugin from './main';
import { MenuController, addSafeClickListener } from './menu-controller';
import { MenuInstances } from './types';
import * as logger from './logger';
// scroll-direction hide/reveal is handled inline — no gesture-handler import needed.

// Get the LIVE mode constant if available


/**
 * Manages persistent menus in reading and live preview modes
 */
export class PersistentMenuManager {
  plugin: TPSGlobalContextMenuPlugin;
  menus: Map<MarkdownView, MenuInstances> = new Map();
  private inlineSubitemsPanels: Map<MarkdownView, HTMLElement> = new Map();
  private titleIcons: Map<MarkdownView, HTMLElement> = new Map();
  private topParentNavs: Map<MarkdownView, HTMLElement> = new Map();
  private liveResizeObservers: Map<MarkdownView, ResizeObserver> = new Map();
  private geometryResizeObservers: Map<MarkdownView, ResizeObserver> = new Map();
  private liveHeights: Map<MarkdownView, number> = new Map();
  private attachRetryTimers: Map<MarkdownView, number> = new Map();
  private scrollListeners: Map<MarkdownView, { container: HTMLElement; listener: (evt: Event) => void; timer?: number }> = new Map();
  public collapsedStateByPath: Map<string, boolean> = new Map();

  private handleResize: (() => void) | null = null;
  private handleFocus: (() => void) | null = null;
  private handleWindowResize: (() => void) | null = null;
  private visualViewportResizeHandler: (() => void) | null = null;
  private visualViewportScrollHandler: (() => void) | null = null;
  private baseHeight: number = window.innerHeight;
  private isCurrentlyHidden: boolean = false;
  private keyboardVisible: boolean = false;
  private swipeCollapsed: boolean = false;
  private scrollHideListeners: Map<MarkdownView, { scroller: HTMLElement; listener: () => void; lastTop: number; accum: number }> = new Map();

  constructor(plugin: TPSGlobalContextMenuPlugin) {
    this.plugin = plugin;
    this.setupKeyboardDetection();
  }

  /**
   * Public setter to update collapse state from PanelBuilder or other components
   */
  public setSubitemsPanelCollapsed(path: string, collapsed: boolean): void {
    this.collapsedStateByPath.set(path, collapsed);
  }

  /**
   * Check if a file matches any ignore rules
   */
  private fileMatchesIgnoreRules(file: TFile, ignoreRules: any[]): boolean {
    if (!ignoreRules || ignoreRules.length === 0) return false;

    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter || {};

    for (const rule of ignoreRules) {
      if (!rule.conditions || rule.conditions.length === 0) continue;

      const matchMode = rule.match === 'any' ? 'some' : 'every';
      const conditionsMatch = (rule.conditions as any[])[matchMode]((condition: any) => {
        const type = condition.type || 'frontmatter';
        const operator = condition.operator || 'equals';

        if (type === 'path') {
          const path = file.path;
          if (operator === 'contains') return path.includes(condition.value || '');
          if (operator === 'equals') return path === condition.value;
          if (operator === 'starts-with') return path.startsWith(condition.value || '');
          if (operator === 'ends-with') return path.endsWith(condition.value || '');
          if (operator === 'not-contains') return !path.includes(condition.value || '');
          return false;
        }

        if (type === 'frontmatter') {
          const key = String(condition.key || '').toLowerCase();
          const fmKeys = Object.keys(fm);
          const fmKey = fmKeys.find((k) => k.toLowerCase() === key);
          const value = fmKey ? fm[fmKey] : null;

          if (operator === 'exists') return value != null && value !== '';
          if (operator === 'missing') return value == null || value === '';
          if (operator === 'equals') return String(value || '') === (condition.value || '');
          if (operator === 'not-equals') return String(value || '') !== (condition.value || '');
          if (operator === 'contains') return String(value || '').includes(condition.value || '');
          if (operator === 'not-contains') return !String(value || '').includes(condition.value || '');
          return false;
        }

        return false;
      });

      if (conditionsMatch) return true;
    }

    return false;
  }

  setupKeyboardDetection() {
    if (!Platform.isMobile) return;
    if (typeof window === 'undefined' || !window.visualViewport) return;

    const viewport = window.visualViewport;
    this.baseHeight = Math.max(window.innerHeight || 0, viewport.height || 0);

    const evaluateKeyboardState = () => {
      const vv = window.visualViewport;
      if (!vv) return;

      // Keep baseline resilient after orientation/UI chrome changes.
      if (vv.height > this.baseHeight) {
        this.baseHeight = vv.height;
      }

      const delta = this.baseHeight - vv.height;
      const ratio = this.baseHeight > 0 ? delta / this.baseHeight : 0;
      const visible = delta > 140 || ratio > 0.18;

      if (visible === this.keyboardVisible) return;
      this.keyboardVisible = visible;
      this.plugin.keyboardVisible = visible;
      this.handleKeyboardVisibilityChange(visible);
    };

    this.visualViewportResizeHandler = () => evaluateKeyboardState();
    this.visualViewportScrollHandler = () => evaluateKeyboardState();

    viewport.addEventListener('resize', this.visualViewportResizeHandler);
    viewport.addEventListener('scroll', this.visualViewportScrollHandler);

    evaluateKeyboardState();
  }

  teardownKeyboardDetection() {
    const viewport = typeof window !== 'undefined' ? window.visualViewport : null;
    if (viewport && this.visualViewportResizeHandler) {
      viewport.removeEventListener('resize', this.visualViewportResizeHandler);
    }
    if (viewport && this.visualViewportScrollHandler) {
      viewport.removeEventListener('scroll', this.visualViewportScrollHandler);
    }
    this.visualViewportResizeHandler = null;
    this.visualViewportScrollHandler = null;
  }

  private handleKeyboardVisibilityChange(visible: boolean): void {
    // Keep class for compatibility with existing selectors.
    document.body?.classList?.toggle('tps-context-hidden-for-keyboard', visible);

    for (const [view, instances] of this.menus.entries()) {
      if (instances.reading?.isConnected) {
        this.applyPersistentMenuGeometry(view, instances.reading);
        this.applyMenuVisibility(instances.reading);
      }
      if (instances.live?.isConnected) {
        this.applyPersistentMenuGeometry(view, instances.live);
        this.applyMenuVisibility(instances.live);
      }

      const panel = this.inlineSubitemsPanels.get(view);
      if (panel?.isConnected) {
        this.applyInlinePanelVisibility(panel);
      }
    }
  }

  /**
   * Ensure menus exist only for the active markdown view.
   * Rendering fixed menus for every markdown leaf causes off-screen overlays.
   */
  ensureMenus(): void {
    if (!this.plugin?.app?.workspace) return;

    if (!this.plugin.settings.enableInlinePersistentMenus) {
      for (const view of Array.from(this.menus.keys())) {
        this.cleanup(view);
      }
      for (const view of Array.from(this.inlineSubitemsPanels.keys())) {
        this.removeInlineSubitemsPanel(view);
      }
      for (const view of Array.from(this.titleIcons.keys())) {
        this.removeInlineTitleIcon(view);
      }
      for (const view of Array.from(this.topParentNavs.keys())) {
        this.removeTopParentNav(view);
      }
      return;
    }

    const activeViews = new Set<MarkdownView>();
    const targetView = this.resolvePrimaryMarkdownView();

    if (targetView && this.isCompatibleMarkdownView(targetView)) {
      activeViews.add(targetView);
      try {
        this.ensureReadingMenu(targetView);
      } catch (error) {
        logger.error('[TPS GCM] Failed to ensure reading menu:', error);
      }
      try {
        this.ensureLiveMenu(targetView);
      } catch (error) {
        logger.error('[TPS GCM] Failed to ensure live menu:', error);
      }
      try {
        this.ensureInlineSubitemsPanel(targetView);
      } catch (error) {
        logger.error('[TPS GCM] Failed to ensure inline subitems panel:', error);
      }
      try {
        this.ensureInlineTitleIcon(targetView);
      } catch (error) {
        logger.error('[TPS GCM] Failed to ensure inline title icon:', error);
      }
      try {
        this.ensureTopParentNav(targetView);
      } catch (error) {
        logger.error('[TPS GCM] Failed to ensure top parent nav:', error);
      }
    }

    if (targetView) {
      this.removeGlobalStraysOutsideTarget(targetView);
    }

    // Clean up menus for views that no longer exist
    for (const view of Array.from(this.menus.keys())) {
      if (!activeViews.has(view)) {
        this.cleanup(view);
      }
    }

    for (const view of Array.from(this.inlineSubitemsPanels.keys())) {
      if (!activeViews.has(view)) {
        this.removeInlineSubitemsPanel(view);
      }
    }

    for (const view of Array.from(this.titleIcons.keys())) {
      if (!activeViews.has(view)) {
        this.removeInlineTitleIcon(view);
      }
    }

    for (const view of Array.from(this.topParentNavs.keys())) {
      if (!activeViews.has(view)) {
        this.removeTopParentNav(view);
      }
    }
  }

  private isCompatibleMarkdownView(view: unknown): view is MarkdownView {
    if (!view || typeof view !== 'object') return false;
    const candidate = view as MarkdownView;
    const viewType =
      typeof (candidate as any).getViewType === 'function'
        ? (candidate as any).getViewType()
        : (candidate as any).viewType;
    return (
      viewType === 'markdown' &&
      !!(candidate as any).contentEl &&
      typeof (candidate as any).contentEl.querySelector === 'function'
    );
  }

  private getViewMode(view: MarkdownView): 'preview' | 'source' | null {
    const anyView = view as any;

    try {
      if (typeof anyView.getMode === 'function') {
        const mode = anyView.getMode();
        if (mode === 'preview' || mode === 'source') return mode;
      }
    } catch {
      // ignore and continue with structural detection
    }

    if (typeof anyView.mode === 'string') {
      if (anyView.mode === 'preview' || anyView.mode === 'source') return anyView.mode;
    }

    if (typeof anyView.currentMode === 'string') {
      if (anyView.currentMode === 'preview' || anyView.currentMode === 'source') return anyView.currentMode;
    }

    const root = anyView.contentEl as HTMLElement | undefined;
    if (root?.querySelector('.markdown-source-view')) return 'source';
    if (root?.querySelector('.markdown-preview-view')) return 'preview';
    return null;
  }

  private getCompatibleMarkdownViewFromLeaf(leaf: WorkspaceLeaf | null | undefined): MarkdownView | null {
    if (!leaf) return null;
    const view = (leaf as any).view;
    if (!this.isCompatibleMarkdownView(view)) return null;
    return view;
  }

  private resolvePrimaryMarkdownView(): MarkdownView | null {
    const activeMarkdownView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (this.isCompatibleMarkdownView(activeMarkdownView) && activeMarkdownView.file) {
      return activeMarkdownView;
    }

    const allLeaves = this.plugin.app.workspace.getLeavesOfType('markdown');
    const leaves = allLeaves.filter((leaf) => !!this.getCompatibleMarkdownViewFromLeaf(leaf));
    if (!leaves.length) return null;

    const activeLeaf = this.plugin.app.workspace.activeLeaf;
    const activeView = this.getCompatibleMarkdownViewFromLeaf(activeLeaf);
    if (activeView && activeView.file && this.isLeafVisible(activeLeaf as WorkspaceLeaf)) {
      return activeView;
    }

    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (activeFile) {
      const matchingLeaves = leaves.filter((leaf) => {
        const view = this.getCompatibleMarkdownViewFromLeaf(leaf);
        if (!view) return false;
        return !!view?.file && view.file.path === activeFile.path;
      });
      const preferred = this.pickBestMarkdownLeaf(matchingLeaves, activeLeaf) ?? this.pickBestMarkdownLeaf(leaves, activeLeaf);
      const preferredView = this.getCompatibleMarkdownViewFromLeaf(preferred);
      if (preferredView) return preferredView;
    }

    const fallback = this.pickBestMarkdownLeaf(leaves, activeLeaf);
    return this.getCompatibleMarkdownViewFromLeaf(fallback);
  }

  private pickBestMarkdownLeaf(
    candidates: WorkspaceLeaf[],
    activeLeaf: WorkspaceLeaf | null
  ): WorkspaceLeaf | null {
    if (!candidates.length) return null;

    const scored = candidates.map((leaf, index) => ({
      leaf,
      index,
      score: this.scoreMarkdownLeaf(leaf, activeLeaf),
    }));

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.index - b.index;
    });

    return scored[0]?.leaf ?? null;
  }

  private scoreMarkdownLeaf(leaf: WorkspaceLeaf, activeLeaf: WorkspaceLeaf | null): number {
    let score = 0;

    if (leaf === activeLeaf) score += 1000;
    if (this.isLeafActiveInDom(leaf)) score += 500;
    if (!this.isSideDockLeaf(leaf)) score += 250;
    if (this.isLeafVisible(leaf)) score += 150;

    const view = this.getCompatibleMarkdownViewFromLeaf(leaf);
    if (!view) return -1;
    if (view?.file) score += 25;
    if (this.getViewMode(view) === 'preview') score += 10;

    return score;
  }

  private isLeafActiveInDom(leaf: WorkspaceLeaf): boolean {
    const container = (leaf as any)?.containerEl as HTMLElement | undefined;
    if (!container || !container.isConnected) return false;

    if (container.classList.contains('mod-active')) return true;

    const workspaceLeaf = container.closest<HTMLElement>('.workspace-leaf');
    if (workspaceLeaf?.classList.contains('mod-active')) return true;

    const activeElement = document.activeElement as HTMLElement | null;
    return !!activeElement && container.contains(activeElement);
  }

  private isLeafVisible(leaf: WorkspaceLeaf): boolean {
    const container = (leaf as any)?.containerEl as HTMLElement | undefined;
    if (!container || !container.isConnected) return false;

    const rect = container.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return false;

    const style = window.getComputedStyle(container);
    if (style.display === 'none' || style.visibility === 'hidden') return false;

    return true;
  }

  private isSideDockLeaf(leaf: WorkspaceLeaf): boolean {
    const container = (leaf as any)?.containerEl as HTMLElement | undefined;
    if (!container) return false;
    return !!container.closest('.workspace-sidedock, .workspace-split.mod-left-split, .workspace-split.mod-right-split');
  }

  private removeGlobalStraysOutsideTarget(targetView: MarkdownView | null): void {
    const targetRoot = targetView?.contentEl || null;
    const targetContainer = ((targetView as any)?.containerEl as HTMLElement | undefined) || null;
    // Live preview panels live in document.body — keep the one owned by the target view
    const ownedBodyPanel = targetView ? (this.inlineSubitemsPanels.get(targetView) ?? null) : null;

    const removeIfOutsideTarget = (selector: string) => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
      for (const node of nodes) {
        if (node === ownedBodyPanel) continue; // keep live preview panel in body
        if (targetRoot && targetRoot.contains(node)) continue;
        if (targetContainer && targetContainer.contains(node)) continue;
        node.remove();
      }
    };

    removeIfOutsideTarget('.tps-global-context-menu--persistent');
    removeIfOutsideTarget('.tps-gcm-subitems-panel--title-inline');
    removeIfOutsideTarget('.tps-gcm-note-title-icon');
  }

  private scheduleAttachRetry(view: MarkdownView, delayMs: number = 120): void {
    if (this.attachRetryTimers.has(view)) return;

    const timerId = window.setTimeout(() => {
      this.attachRetryTimers.delete(view);

      const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');
      const stillPresent = leaves.some((leaf) => leaf.view === view);
      if (!stillPresent) {
        this.cleanup(view);
        return;
      }
      this.ensureMenus();
    }, Math.max(40, delayMs));

    this.attachRetryTimers.set(view, timerId);
  }

  private clearAttachRetry(view: MarkdownView): void {
    const timerId = this.attachRetryTimers.get(view);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      this.attachRetryTimers.delete(view);
    }
  }

  /**
   * Ensure reading mode menu exists
   */
  ensureReadingMenu(view: MarkdownView): void {
    if (!this.isCompatibleMarkdownView(view)) return;

    const file = view.file;
    if (file instanceof TFile && this.fileMatchesIgnoreRules(file, this.plugin.settings.inlineMenu_IgnoreRules)) {
      this.removeReadingMenu(view);
      return;
    }

    const mode = this.getViewMode(view);
    // Strict mode check: Only show in Preview mode
    if (mode !== 'preview') {
      this.removeReadingMenu(view);
      return;
    }

    // Robustly find the preview view container
    const previewView = view.contentEl?.querySelector('.markdown-preview-view');

    if (!previewView) {
      this.scheduleAttachRetry(view, 120);
      return;
    }

    const instances = this.menus.get(view) || {};
    const attachContainer = previewView as HTMLElement;

    // Defensive cleanup: remove any stray persistent menus in this container
    this.removeStrayMenus(attachContainer, 'reading', instances.reading ?? null);

    // Check if file path matches - if not, remove old menu
    if (instances.reading && instances.filePath !== view.file?.path) {
      this.removeReadingMenu(view);
    } else if (instances.reading && attachContainer.contains(instances.reading)) {
      // Valid menu already exists and is attached
      this.applyPersistentMenuGeometry(view, instances.reading);
      this.applyMenuVisibility(instances.reading);
      this.ensureSwipeGestureTracking(view);
      this.attachGeometryObserver(view);
      return;
    }

    this.removeReadingMenu(view);

    const menu = this.createPersistentMenu(view, 'reading');
    if (menu) {
      attachContainer.appendChild(menu);
      this.applyPersistentMenuGeometry(view, menu);
      this.applyMenuVisibility(menu);
      instances.reading = menu;
      instances.filePath = view.file.path; // Track which file this menu belongs to
      this.menus.set(view, instances);
      this.ensureSwipeGestureTracking(view);
      this.attachGeometryObserver(view);
    }
  }

  /**
   * Ensure live preview menu exists
   */
  ensureLiveMenu(view: MarkdownView): void {
    if (!this.isCompatibleMarkdownView(view)) return;

    const file = view.file;
    if (file instanceof TFile && this.fileMatchesIgnoreRules(file, this.plugin.settings.inlineMenu_IgnoreRules)) {
      this.removeLiveMenu(view);
      return;
    }

    const mode = this.getViewMode(view);
    // Strict mode check: Only show in Source mode (Live Preview is a type of Source mode)
    if (mode !== 'source') {
      this.removeLiveMenu(view);
      return;
    }

    // Robustly find the source view container
    const sourceContainer = view.contentEl?.querySelector('.markdown-source-view');

    // Check if we are in Live Preview mode
    if (!sourceContainer) {
      this.scheduleAttachRetry(view, 120);
      return;
    }

    const instances = this.menus.get(view) || {};
    const attachContainer = sourceContainer;

    // Defensive cleanup: remove any stray persistent menus in this container
    this.removeStrayMenus(attachContainer, 'live', instances.live ?? null);

    // Check if file path matches - if not, remove old menu
    if (instances.live && instances.filePath !== view.file?.path) {
      this.removeLiveMenu(view);
    } else if (instances.live && attachContainer.contains(instances.live)) {
      // Valid menu already exists and is attached
      this.applyPersistentMenuGeometry(view, instances.live);
      this.applyMenuVisibility(instances.live);
      this.ensureSwipeGestureTracking(view);
      this.attachGeometryObserver(view);
      if (!this.liveResizeObservers.has(view)) {
        this.attachLiveHeightObserver(view, instances.live, null);
      }
      return;
    }

    this.removeLiveMenu(view);

    const menu = this.createPersistentMenu(view, 'live');
    if (menu) {
      attachContainer.appendChild(menu);
      this.applyPersistentMenuGeometry(view, menu);
      this.applyMenuVisibility(menu);
      instances.live = menu;
      instances.filePath = view.file.path; // Track which file this menu belongs to
      this.menus.set(view, instances);
      this.ensureSwipeGestureTracking(view);
      this.attachGeometryObserver(view);
      this.attachLiveHeightObserver(view, menu, null);
    }
  }

  private attachGeometryObserver(view: MarkdownView): void {
    if (this.geometryResizeObservers.has(view)) return;
    if (typeof ResizeObserver !== 'function') return;

    const contentEl = view.contentEl as HTMLElement | undefined;
    const containerEl = (view as any).containerEl as HTMLElement | undefined;
    if (!contentEl && !containerEl) return;

    const applyGeometry = () => {
      const instances = this.menus.get(view);
      if (!instances) return;
      if (instances.reading?.isConnected) {
        this.applyPersistentMenuGeometry(view, instances.reading);
      }
      if (instances.live?.isConnected) {
        this.applyPersistentMenuGeometry(view, instances.live);
      }
    };

    const observer = new ResizeObserver(() => applyGeometry());
    if (contentEl) observer.observe(contentEl);
    if (containerEl && containerEl !== contentEl) observer.observe(containerEl);
    this.geometryResizeObservers.set(view, observer);
    applyGeometry();
  }

  private detachGeometryObserver(view: MarkdownView): void {
    const observer = this.geometryResizeObservers.get(view);
    if (!observer) return;
    observer.disconnect();
    this.geometryResizeObservers.delete(view);
  }

  private removeStrayMenus(
    container: ParentNode,
    mode: 'reading' | 'live',
    tracked: HTMLElement | null
  ): void {
    const selector = `.tps-global-context-menu--persistent.tps-global-context-menu--${mode}`;
    const menus = Array.from(container.querySelectorAll<HTMLElement>(selector));
    for (const menu of menus) {
      if (tracked && menu === tracked) continue;
      menu.remove();
    }
  }

  private shouldShowInlineSubitems(view: MarkdownView): boolean {
    if (!this.plugin.settings.enableSubitemsPanel) return false;
    const file = view.file;
    if (!(file instanceof TFile)) return false;
    if (file.extension?.toLowerCase() !== 'md') return false;

    // Check ignore rules for subitems
    if (this.fileMatchesIgnoreRules(file, this.plugin.settings.subitems_IgnoreRules)) {
      return false;
    }

    const mode = this.getViewMode(view);
    // Show in both preview and source (live preview) modes
    return mode === 'preview' || mode === 'source';
  }

  private resolveInlineSubitemsAnchor(view: MarkdownView): { parent: HTMLElement; reference: Element | null; titleEl?: Element | null } | null {
    const contentRoot = view.contentEl;
    if (!contentRoot) return null;

    const mode = this.getViewMode(view);
    if (!mode) return null;

    if (mode === 'preview') {
      const previewView = contentRoot.querySelector<HTMLElement>('.markdown-preview-view');
      if (!previewView) return null;
      const previewSizer = previewView.querySelector<HTMLElement>('.markdown-preview-sizer');
      if (!previewSizer) return null;

      // In reading mode the panel is in-document-flow, directly after the title.
      // Walk direct children of previewSizer to find the title/heading element.
      const directChildren = Array.from(previewSizer.children) as HTMLElement[];

      // Prefer inline-title as the anchor (Obsidian's inline-title feature)
      const inlineTitleEl = directChildren.find(
        (el) => el.classList.contains('inline-title') || el.dataset.type === 'inline-title'
      );
      if (inlineTitleEl) {
        const idx = directChildren.indexOf(inlineTitleEl);
        const nextSibling = directChildren[idx + 1] || null;
        // Skip over any existing panel that might already be there
        const refEl = (nextSibling && nextSibling.classList.contains('tps-gcm-subitems-panel'))
          ? (directChildren[directChildren.indexOf(nextSibling) + 1] || null)
          : nextSibling;
        return { parent: previewSizer, reference: refEl, titleEl: inlineTitleEl };
      }

      // Fallback: after first h1 or h2
      const firstHeading = directChildren.find(
        (el) => el.tagName === 'H1' || el.tagName === 'H2'
      );
      if (firstHeading) {
        const idx = directChildren.indexOf(firstHeading);
        const nextSibling = directChildren[idx + 1] || null;
        const refEl = (nextSibling && nextSibling.classList.contains('tps-gcm-subitems-panel'))
          ? (directChildren[directChildren.indexOf(nextSibling) + 1] || null)
          : nextSibling;
        return { parent: previewSizer, reference: refEl, titleEl: firstHeading };
      }

      // Last fallback: prepend at top of preview sizer (no title found yet, retry later)
      return {
        parent: previewSizer,
        reference: directChildren[0] || null,
        titleEl: null,
      };
    }

    if (mode === 'source') {
      const sourceView = contentRoot.querySelector<HTMLElement>('.markdown-source-view');
      if (!sourceView) return null;

      const sizer = sourceView.querySelector<HTMLElement>('.cm-sizer') ||
        sourceView.querySelector<HTMLElement>('.cm-content');

      if (!sizer) return null;

      // Search for the Inline Title within the CodeMirror sizer/content
      const inlineTitleEl =
        sizer.querySelector<HTMLElement>('.inline-title') ||
        sizer.querySelector<HTMLElement>('.cm-line.inline-title');

      if (inlineTitleEl) {
        // If we found the title, we want to insert AFTER it.
        // Note for CodeMirror: We are inserting into the DOM managed by CM.
        // This is visually correct but might be fragile. 
        // We anchor to the parent container (.cm-sizer usually)
        return {
          parent: inlineTitleEl.parentElement as HTMLElement,
          reference: inlineTitleEl.nextElementSibling, // Insert before the next sibling (line 1)
          titleEl: inlineTitleEl
        };
      }

      // Fallback: no inline title found? Prepend to top of sizer
      return {
        parent: sizer,
        reference: sizer.firstElementChild,
        titleEl: null
      };
    }

    return null;
  }

  private resolveMenuHostRect(view: MarkdownView, menuEl: HTMLElement): DOMRect | null {
    const root = view.contentEl;
    if (!root) return null;

    let hostEl: HTMLElement | null = null;
    if (menuEl.classList.contains('tps-global-context-menu--reading')) {
      hostEl =
        root.querySelector<HTMLElement>('.markdown-preview-view') ||
        root.querySelector<HTMLElement>('.markdown-preview-sizer');
    } else {
      hostEl =
        root.querySelector<HTMLElement>('.markdown-source-view.is-live-preview') ||
        root.querySelector<HTMLElement>('.markdown-source-view');
    }

    const el = hostEl || root;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    // If readable line width is active, clamp the rect to the content width.
    const isReadable =
      root.classList.contains('is-readable-line-width') ||
      root.querySelector('.is-readable-line-width') !== null;

    if (isReadable) {
      const computed = getComputedStyle(root);
      const fileLineWidth = computed.getPropertyValue('--file-line-width')?.trim();
      const lineWidthVar = computed.getPropertyValue('--line-width')?.trim();
      const rawValue = fileLineWidth || lineWidthVar;

      if (rawValue) {
        const parsed = parseFloat(rawValue);
        if (parsed > 0 && parsed < rect.width) {
          const centerX = rect.left + rect.width / 2;
          return new DOMRect(centerX - parsed / 2, rect.top, parsed, rect.height);
        }
      }
    }

    return rect;
  }

  private applyPersistentMenuGeometry(view: MarkdownView, menuEl: HTMLElement): void {
    const hostRect = this.resolveMenuHostRect(view, menuEl);
    if (!hostRect || hostRect.width <= 0) return;

    const horizontalPadding = 12;
    const availableWidth = Math.max(120, Math.floor(hostRect.width - horizontalPadding * 2));
    const maxWidth = availableWidth;
    menuEl.style.setProperty('--tps-gcm-pane-width', `${maxWidth}px`);
    menuEl.style.setProperty('--tps-inline-bar-width', `${maxWidth}px`);

    const isReadingMenu = menuEl.classList.contains('tps-global-context-menu--reading');
    const offsetX = isReadingMenu ? 0 : Math.round(this.plugin.settings?.liveMenuOffsetX ?? 0);
    // Apply vertical offset to both reading + live persistent bars.
    let offsetY = Math.round(this.plugin.settings?.liveMenuOffsetY ?? 0);

    // Note: the subitems panel sits BELOW the context menu bar via flexbox order — no offsetY adjustment needed here.
    const position = isReadingMenu ? 'center' : (this.plugin.settings?.liveMenuPosition || 'center');

    // Only set visibility if not gesture-collapsed (don't override gesture state)
    if (!this.swipeCollapsed) {
      menuEl.style.visibility = 'visible';
      menuEl.style.opacity = '1';
      menuEl.style.pointerEvents = 'auto';
    }

    const leftEdge = Math.max(0, Math.round(hostRect.left + horizontalPadding));
    const rightEdge = Math.max(leftEdge, Math.round(hostRect.right - horizontalPadding));
    const centerX = Math.round(hostRect.left + hostRect.width / 2);

    // Always span the active note pane width; this keeps the bar visible in split layouts.
    const effectiveWidth = maxWidth;
    menuEl.style.width = `${effectiveWidth}px`;
    menuEl.style.maxWidth = `${effectiveWidth}px`;
    menuEl.style.minWidth = `${Math.min(220, effectiveWidth)}px`;

    let desiredLeft: number;
    if (position === 'left') {
      desiredLeft = leftEdge + offsetX;
    } else if (position === 'right') {
      desiredLeft = rightEdge - effectiveWidth + offsetX;
    } else {
      desiredLeft = centerX - effectiveWidth / 2 + offsetX;
    }

    const minLeft = leftEdge;
    const maxLeft = Math.max(leftEdge, rightEdge - effectiveWidth);
    const clampedLeft = Math.min(Math.max(desiredLeft, minLeft), maxLeft);

    const targetViewportLeft = Math.round(clampedLeft);
    menuEl.style.left = `${targetViewportLeft}px`;
    menuEl.style.right = 'auto';
    if (this.keyboardVisible && Platform.isMobile) {
      // Keyboard visible: anchor to viewport top for unobstructed interaction.
      const vv = window.visualViewport;
      const topAnchor = Math.round((vv?.offsetTop ?? 0) + 8);
      menuEl.style.top = `${Math.max(0, topAnchor)}px`;
      menuEl.style.bottom = 'auto';
      menuEl.style.transform = 'translate(0px, 0px)';
    } else {
      menuEl.style.top = 'auto';
      menuEl.style.bottom = 'calc(var(--tps-gcm-live-bottom, 16px) + env(safe-area-inset-bottom, 0px) + var(--tps-auto-base-embed-height, 0px) - var(--tps-auto-base-embed-gap, 12px))';
      menuEl.style.transform = `translate(0px, ${offsetY}px)`;
    }

    // Obsidian pane/layout transforms can change the coordinate space for fixed elements.
    // Calibrate once so the final rendered left edge matches the intended viewport position.
    const renderedRect = menuEl.getBoundingClientRect();
    if (renderedRect.width > 0) {
      const delta = targetViewportLeft - renderedRect.left;
      if (Math.abs(delta) > 1) {
        menuEl.style.left = `${Math.round(targetViewportLeft + delta)}px`;
      }
    }
  }

  private resolveInlineTitleElement(view: MarkdownView): HTMLElement | null {
    const contentRoot = view.contentEl;
    if (!contentRoot) return null;

    const mode = this.getViewMode(view);
    if (!mode) return null;
    if (mode === 'preview') {
      const previewView = contentRoot.querySelector<HTMLElement>('.markdown-preview-view');
      if (!previewView) return null;
      const previewSizer =
        previewView.querySelector<HTMLElement>('.markdown-preview-sizer') ||
        previewView;
      const inlineTitle =
        previewSizer.querySelector<HTMLElement>(':scope > .inline-title') ||
        previewSizer.querySelector<HTMLElement>('.inline-title');
      if (inlineTitle) return inlineTitle;

      // Fallback when inline title is disabled: use the first heading as visual title.
      return (
        previewSizer.querySelector<HTMLElement>(':scope > h1') ||
        previewSizer.querySelector<HTMLElement>('h1')
      );
    }

    if (mode === 'source') {
      const sourceView = contentRoot.querySelector<HTMLElement>('.markdown-source-view');
      if (!sourceView) return null;

      const inlineTitleInSourceView =
        sourceView.querySelector<HTMLElement>('.inline-title') ||
        sourceView.querySelector<HTMLElement>('.cm-line.inline-title');
      if (inlineTitleInSourceView) return inlineTitleInSourceView;

      const sourceSizer =
        sourceView.querySelector<HTMLElement>('.cm-content') ||
        sourceView.querySelector<HTMLElement>('.cm-sizer') ||
        sourceView;

      const inlineTitle =
        sourceSizer.querySelector<HTMLElement>(':scope > .cm-line.inline-title') ||
        sourceSizer.querySelector<HTMLElement>('.cm-line.inline-title') ||
        sourceSizer.querySelector<HTMLElement>('.inline-title');
      if (inlineTitle) return inlineTitle;

      const headingToken = sourceSizer.querySelector<HTMLElement>('.cm-line.HyperMD-header-1, .cm-line .cm-header-1');
      const headingLine = headingToken?.classList.contains('cm-line')
        ? headingToken
        : headingToken?.closest<HTMLElement>('.cm-line');
      if (headingLine) return headingLine;

      const containerEl = (view as any)?.containerEl as HTMLElement | undefined;
      const fallbackInlineTitle =
        containerEl?.querySelector<HTMLElement>('.inline-title') ||
        contentRoot.querySelector<HTMLElement>('.inline-title');
      return fallbackInlineTitle || null;
    }

    return null;
  }

  private getFrontmatterValueCaseInsensitive(frontmatter: Record<string, any>, key: string): any {
    const normalized = String(key || '').trim().toLowerCase();
    if (!normalized) return undefined;
    const match = Object.keys(frontmatter || {}).find((candidate) => candidate.toLowerCase() === normalized);
    return match ? frontmatter[match] : undefined;
  }

  private resolveTitleIconColor(frontmatter: Record<string, any>, file?: TFile): string {
    // First, check Notebook Navigator rule color if file is provided
    if (file) {
      const companionColor = this.resolveCompanionRuleColor(file, frontmatter);
      if (companionColor) {
        return companionColor;
      }
    }

    const colorKeys = ['iconColor', 'color', 'accentColor', 'accent'];
    for (const key of colorKeys) {
      const raw = this.getFrontmatterValueCaseInsensitive(frontmatter, key);
      if (typeof raw !== 'string') continue;
      const value = raw.trim();
      if (!value) continue;
      if (value.startsWith('var(')) return value;
      if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', value)) {
        return value;
      }
    }
    return '';
  }

  private resolveCompanionRuleColor(file: TFile, frontmatter: Record<string, any>): string {
    const pluginsApi: any = (this.plugin.app as any)?.plugins;
    const companion: any = pluginsApi?.plugins?.['tps-notebook-navigator-companion'];
    const ruleEngine: any = companion?.ruleEngine;
    if (companion?.settings?.enabled && ruleEngine?.resolveVisualOutputs) {
      try {
        const cache = this.plugin.app.metadataCache.getFileCache(file) as any;
        const cacheTags = Array.isArray(cache?.tags)
          ? cache.tags.map((entry: any) => String(entry?.tag || '').replace(/^#+/, '').trim().toLowerCase()).filter(Boolean)
          : [];
        const visual = ruleEngine.resolveVisualOutputs(companion.settings.rules || [], {
          file: {
            path: file.path,
            name: file.name,
            basename: file.basename,
            extension: file.extension,
          },
          frontmatter,
          tags: Array.from(new Set(cacheTags)),
        });
        const colorValue = String(visual?.color?.value || '').trim();
        if (colorValue) {
          if (colorValue.startsWith('var(')) return colorValue;
          if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', colorValue)) {
            return colorValue;
          }
        }
      } catch (error) {
        logger.warn('[TPS GCM] Failed resolving companion color for inline title:', file.path, error);
      }
    }
    return '';
  }

  private resolveInlineTitleIconValue(file: TFile, frontmatter: Record<string, any>): string {
    const pickString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

    // First, check the icon field
    const fromIconField = pickString(frontmatter?.icon);
    if (fromIconField) return fromIconField;

    // Then, check Notebook Navigator configured icon field and rules
    const pluginsApi: any = (this.plugin.app as any)?.plugins;
    const companion: any = pluginsApi?.plugins?.['tps-notebook-navigator-companion'];
    const configuredIconField = pickString(companion?.settings?.frontmatterIconField);
    if (configuredIconField) {
      const configuredValue = pickString(this.getFrontmatterValueCaseInsensitive(frontmatter, configuredIconField));
      if (configuredValue) return configuredValue;
    }

    // Finally, check Notebook Navigator rules if enabled
    const ruleEngine: any = companion?.ruleEngine;
    if (companion?.settings?.enabled && ruleEngine?.resolveVisualOutputs) {
      try {
        const cache = this.plugin.app.metadataCache.getFileCache(file) as any;
        const cacheTags = Array.isArray(cache?.tags)
          ? cache.tags.map((entry: any) => String(entry?.tag || '').replace(/^#+/, '').trim().toLowerCase()).filter(Boolean)
          : [];
        const visual = ruleEngine.resolveVisualOutputs(companion.settings.rules || [], {
          file: {
            path: file.path,
            name: file.name,
            basename: file.basename,
            extension: file.extension,
          },
          frontmatter,
          tags: Array.from(new Set(cacheTags)),
        });
        const ruleIcon = pickString(visual?.icon?.value);
        if (ruleIcon) return ruleIcon;
      } catch (error) {
        logger.warn('[TPS GCM] Failed resolving companion icon for inline title:', file.path, error);
      }
    }

    return '';
  }

  private renderInlineTitleIcon(iconEl: HTMLElement, iconValue: string, file: TFile): void {
    iconEl.classList.remove('tps-gcm-note-title-icon--emoji');
    iconEl.textContent = '';

    const normalized = String(iconValue || '').trim();
    if (normalized && /[\u2600-\u27BF\u{1F300}-\u{1FAFF}]/u.test(normalized)) {
      iconEl.textContent = normalized;
      iconEl.classList.add('tps-gcm-note-title-icon--emoji');
      return;
    }

    const normalizedIconName = normalized.replace(/^(lucide|icon):/i, '').trim();

    try {
      setIcon(iconEl, normalizedIconName || 'file-text');
      if (!iconEl.querySelector('svg')) {
        setIcon(iconEl, 'file-text');
      }
    } catch {
      setIcon(iconEl, file.extension?.toLowerCase() === 'md' ? 'file-text' : 'paperclip');
    }
  }

  refreshInlineTitleIcon(view: MarkdownView): void {
    this.ensureInlineTitleIcon(view);
  }

  private ensureInlineTitleIcon(view: MarkdownView): void {
    const file = view.file;
    if (!(file instanceof TFile) || file.extension?.toLowerCase() !== 'md') {
      this.removeInlineTitleIcon(view);
      return;
    }

    const titleEl = this.resolveInlineTitleElement(view);
    if (!titleEl) {
      this.removeInlineTitleIcon(view);
      return;
    }

    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const frontmatter = (cache?.frontmatter || {}) as Record<string, any>;
    const resolvedIconValue = this.resolveInlineTitleIconValue(file, frontmatter);
    const resolvedIcon = resolvedIconValue || 'file-text';
    const resolvedColor = this.resolveTitleIconColor(frontmatter, file);

    const existing = this.titleIcons.get(view) || null;
    if (
      existing &&
      existing.isConnected &&
      existing.parentElement === titleEl &&
      existing.dataset.filePath === file.path &&
      existing.dataset.iconValue === resolvedIcon &&
      (existing.dataset.iconColor || '') === resolvedColor
    ) {
      if (titleEl.firstElementChild !== existing) {
        titleEl.prepend(existing);
      }
      return;
    }

    this.removeInlineTitleIcon(view);

    const iconEl = document.createElement('span');
    iconEl.className = 'tps-gcm-note-title-icon';
    iconEl.dataset.filePath = file.path;
    iconEl.dataset.iconValue = resolvedIcon;
    iconEl.dataset.iconColor = resolvedColor;
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.setAttribute('contenteditable', 'false');
    iconEl.setAttribute('draggable', 'false');
    if (resolvedColor) {
      iconEl.style.color = resolvedColor;
    } else {
      iconEl.style.removeProperty('color');
    }
    this.renderInlineTitleIcon(iconEl, resolvedIcon, file);
    titleEl.prepend(iconEl);
    this.titleIcons.set(view, iconEl);
  }

  private removeInlineTitleIcon(view: MarkdownView): void {
    const iconEl = this.titleIcons.get(view);
    if (iconEl) {
      iconEl.remove();
      this.titleIcons.delete(view);
    }

    const titleEl = this.resolveInlineTitleElement(view);
    titleEl?.querySelectorAll('.tps-gcm-note-title-icon').forEach((node) => node.remove());
    view.contentEl?.querySelectorAll('.tps-gcm-note-title-icon').forEach((node) => node.remove());
  }

  public ensureTopParentNav(view: MarkdownView): void {
    if (!this.plugin.settings.enableTopParentNav) {
      this.removeTopParentNav(view);
      return;
    }

    const file = view.file;
    if (!(file instanceof TFile) || file.extension?.toLowerCase() !== 'md') {
      this.removeTopParentNav(view);
      return;
    }

    const titleEl = this.resolveInlineTitleElement(view);
    if (!titleEl) {
      this.removeTopParentNav(view);
      return;
    }

    const parentFiles = this.resolveParentFiles(file);
    if (parentFiles.length === 0) {
      this.removeTopParentNav(view);
      return;
    }

    const existing = this.topParentNavs.get(view) || null;
    if (existing && existing.isConnected && existing.dataset.filePath === file.path) {
      // Ensure it's correctly placed: above the title
      if (titleEl.previousElementSibling !== existing) {
        titleEl.parentElement?.insertBefore(existing, titleEl);
      }
      return;
    }

    this.removeTopParentNav(view);

    const container = document.createElement('div');
    container.className = 'tps-gcm-top-parent-nav';
    container.dataset.filePath = file.path;

    const navButton = document.createElement('button');
    navButton.type = 'button';
    navButton.className = 'tps-gcm-parent-nav-button tps-gcm-parent-nav-button--top';
    navButton.title = parentFiles.length === 1 ? 'Go to parent' : 'Select parent';
    setIcon(navButton, 'arrow-up');

    const label = document.createElement('span');
    label.className = 'tps-gcm-parent-nav-label';
    label.textContent = parentFiles.length === 1 ? 'Parent' : `Parents (${parentFiles.length})`;
    navButton.appendChild(label);

    addSafeClickListener(navButton, () => {
      if (parentFiles.length === 1) {
        void this.plugin.openFileInLeaf(parentFiles[0], false, () => this.plugin.app.workspace.getLeaf(false), { revealLeaf: true });
      } else {
        const menu = new Menu();
        for (const parentFile of parentFiles) {
          menu.addItem((item) => {
            item
              .setTitle(parentFile.basename)
              .setIcon('file-text')
              .onClick(() => {
                void this.plugin.openFileInLeaf(parentFile, false, () => this.plugin.app.workspace.getLeaf(false), { revealLeaf: true });
              });
          });
        }
        const rect = navButton.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom });
      }
    });

    container.appendChild(navButton);
    titleEl.parentElement?.insertBefore(container, titleEl);
    this.topParentNavs.set(view, container);
  }

  private removeTopParentNav(view: MarkdownView): void {
    const navEl = this.topParentNavs.get(view);
    if (navEl) {
      navEl.remove();
      this.topParentNavs.delete(view);
    }
    // Clean up any remaining ones just in case
    const titleEl = this.resolveInlineTitleElement(view);
    titleEl?.parentElement?.querySelectorAll('.tps-gcm-top-parent-nav').forEach(node => node.remove());
  }

  private resolveParentFiles(file: TFile): TFile[] {
    const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'parent').trim() || 'parent';
    const parentFiles: TFile[] = [];

    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter || {};
    if (!(parentKey in fm)) return [];

    const raw = fm[parentKey];
    const values = Array.isArray(raw) ? raw : [raw];

    for (const val of values) {
      const parentFile = this.resolveParentValueToFile(val, file.path);
      if (parentFile) {
        parentFiles.push(parentFile);
      }
    }
    return parentFiles;
  }

  private resolveParentValueToFile(value: any, sourcePath: string): TFile | null {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    let cleaned = raw;
    if (cleaned.startsWith('[[') && cleaned.endsWith(']]')) {
      cleaned = cleaned.slice(2, -2);
    }
    if (cleaned.includes('|')) {
      cleaned = cleaned.split('|')[0];
    }
    if (cleaned.includes('#')) {
      cleaned = cleaned.split('#')[0];
    }
    cleaned = cleaned.trim();
    if (!cleaned) return null;

    const dest = this.plugin.app.metadataCache.getFirstLinkpathDest(cleaned, sourcePath);
    if (dest instanceof TFile) return dest;

    const normalizedPath = normalizePath(cleaned);
    const file = this.plugin.app.vault.getAbstractFileByPath(normalizedPath);
    if (file instanceof TFile) return file;

    const withMd = normalizedPath.endsWith('.md') ? normalizedPath : `${normalizedPath}.md`;
    const fileWithMd = this.plugin.app.vault.getAbstractFileByPath(withMd);
    if (fileWithMd instanceof TFile) return fileWithMd;

    return null;
  }

  private ensureInlineSubitemsPanel(view: MarkdownView): void {
    if (!this.shouldShowInlineSubitems(view)) {
      this.removeInlineSubitemsPanel(view);
      this.removeStrayInlineSubitemsPanels(view, null);
      return;
    }

    const file = view.file;
    if (!(file instanceof TFile)) {
      this.removeInlineSubitemsPanel(view);
      this.removeStrayInlineSubitemsPanels(view, null);
      return;
    }

    const tracked = this.inlineSubitemsPanels.get(view) || null;
    this.removeStrayInlineSubitemsPanels(view, tracked);

    // Check if the panel already exists and is attached properly
    const instances = this.menus.get(view);
    const activeMenu = instances?.live || instances?.reading;

    if (tracked && tracked.isConnected && tracked.dataset.filePath === file.path) {
      if (activeMenu && tracked.parentElement === activeMenu) {
        this.applyInlinePanelVisibility(tracked);
        this.ensureSwipeGestureTracking(view);
        return;
      }
      if (!activeMenu && tracked.parentElement === document.body) {
        this.applyInlinePanelVisibility(tracked);
        this.ensureSwipeGestureTracking(view);
        return;
      }
    }

    // Check for existing collapsed state using our persistent map
    const path = file.path;
    const wasCollapsed = this.collapsedStateByPath.get(path) ?? false;

    this.removeInlineSubitemsPanel(view);

    try {
      const panel = this.plugin.menuController.createSubitemsPanel(file);
      // We use the --live class ONLY if standard body attachment is needed (fallback)
      // If attaching to menu container, we omit it to let flexbox handle flow
      panel.addClass('tps-gcm-subitems-panel--title-inline');
      if (wasCollapsed) panel.addClass('tps-gcm-subitems-panel--collapsed');

      if (!activeMenu) panel.addClass('tps-gcm-subitems-panel--live');

      panel.dataset.filePath = file.path;
      panel.dataset.tpsGcmGestureSurface = 'subitems';
      panel.setAttribute('contenteditable', 'false');
      panel.setAttribute('spellcheck', 'false');
      panel.setAttribute('draggable', 'false');

      // Add to menu container or body hidden initially
      panel.style.opacity = '0';
      panel.style.visibility = 'hidden';

      if (activeMenu) {
        activeMenu.appendChild(panel);
        // Force order: make sure panel is visually last (below the menu)
        panel.style.order = '1';
        panel.style.marginTop = 'var(--tps-gcm-subitems-margin-bottom)';
      } else {
        document.body.appendChild(panel);
      }

      this.inlineSubitemsPanels.set(view, panel);
      this.applyInlinePanelVisibility(panel);
      this.ensureSwipeGestureTracking(view);

      // Attach scroll listener to active view to hide/show this fixed panel
      // Attach scroll listener to active view to hide/show this fixed panel
      // We attach to contentEl with capture: true to catch any scrolling within the pane
      if (view.contentEl) {
        this.attachPanelScrollListener(view, panel, view.contentEl);
      }

      // Initial positioning
      window.requestAnimationFrame(() => {
        if (panel.isConnected) this.applyInlinePanelGeometry(view, panel);
      });

    } catch (error) {
      logger.error('[TPS GCM] Failed to attach subitems panel:', error);
    }
  }

  private getScrollerForView(view: MarkdownView): HTMLElement {
    const mode = this.getViewMode(view);
    if (mode === 'preview') {
      // In Reading Mode, the .markdown-preview-view is often the scroll container
      // Try finding it within contentEl if previewMode container isn't reliable
      // In Reading Mode, ensure we get the scrollable preview view
      const strictPreview = view.contentEl?.querySelector('.markdown-preview-view') as HTMLElement;
      if (strictPreview) return strictPreview;
      return view.previewMode?.containerEl?.querySelector('.markdown-preview-view') as HTMLElement || view.contentEl;
    } else {
      // Source/Live Preview
      return view.contentEl?.querySelector('.cm-scroller') as HTMLElement ||
        view.contentEl?.querySelector('.markdown-source-view') as HTMLElement ||
        view.contentEl;
    }
  }

  /**
   * Position the inline subitems panel just above the live context menu bar (position:fixed).
   */
  private applyInlinePanelGeometry(view: MarkdownView, panel: HTMLElement): void {
    const instances = this.menus.get(view);
    const activeMenu = instances?.live || instances?.reading;

    // Flexbox Layout (Panel inside Menu Container)
    if (activeMenu && panel.parentElement === activeMenu) {
      // Panel should span the full width of the menu container (which spans the note)
      panel.style.width = '100%';

      let maxWidth = '100%';
      if (view && view.contentEl) {
        // Only apply RLL if the class is present on the view or editor
        const isReadable =
          view.contentEl.classList.contains('is-readable-line-width') ||
          view.contentEl.querySelector('.is-readable-line-width') !== null;

        if (isReadable) {
          const computed = getComputedStyle(view.contentEl);
          const fileLineWidth = computed.getPropertyValue('--file-line-width')?.trim();
          const lineWidth = computed.getPropertyValue('--line-width')?.trim();

          if (fileLineWidth && fileLineWidth !== 'initial' && fileLineWidth !== 'none') {
            maxWidth = fileLineWidth;
          } else if (lineWidth && lineWidth !== 'initial' && lineWidth !== 'none') {
            maxWidth = lineWidth;
          }
        }
      }
      panel.style.maxWidth = maxWidth;
      panel.style.minWidth = 'unset';

      // Ensure panel doesn't try to position itself
      panel.style.position = 'static';
      panel.style.left = 'auto';
      panel.style.top = 'auto';
      panel.style.bottom = 'auto';
      panel.style.right = 'auto';
      panel.style.transform = 'none';
      panel.style.marginTop = '1px';

      if (!this.swipeCollapsed) {
        panel.style.removeProperty('opacity');
        panel.style.removeProperty('visibility');
      }
      return;
    }

    // Legacy/Fallback Logic (Body Attached)
    if (!activeMenu || !activeMenu.isConnected || !view.contentEl) return;

    if (!activeMenu.style.left) {
      this.applyPersistentMenuGeometry(view, activeMenu);
    }

    // Use layout based on the pane metrics for horizontal stability
    const menuRect = activeMenu.getBoundingClientRect();
    const paneRect = view.contentEl.getBoundingClientRect();

    if (menuRect.top > 0 && paneRect.width > 0) {
      const isMobile = window.innerWidth < 500;
      const horizontalPadding = isMobile ? 16 : 24;

      // Calculate width based on PANE width + constraints
      const idealWidth = isMobile ? (paneRect.width - 32) : 450;
      const maxPanelWidth = Math.min(600, paneRect.width - (horizontalPadding * 2));

      let panelWidth = Math.min(idealWidth, maxPanelWidth);
      panelWidth = Math.max(panelWidth, 300);

      // Explicitly prevent overflow of pane
      if (panelWidth > paneRect.width - 32) {
        panelWidth = Math.max(300, paneRect.width - 32);
      }

      panel.style.width = `${panelWidth}px`;
      panel.style.maxWidth = `${panelWidth}px`;
      panel.style.minWidth = 'unset';

      const position = this.plugin.settings?.liveMenuPosition || 'center';

      let leftParams: number;
      if (position === 'left') {
        leftParams = paneRect.left + horizontalPadding;
      } else if (position === 'right') {
        leftParams = paneRect.right - panelWidth - horizontalPadding;
      } else {
        // Center in pane
        const paneCenter = paneRect.left + (paneRect.width / 2);
        leftParams = paneCenter - (panelWidth / 2);
      }

      // Clamp to stay within viewport
      const minLeft = 16;
      const maxLeft = window.innerWidth - panelWidth - 16;
      leftParams = Math.max(minLeft, Math.min(leftParams, maxLeft));

      panel.style.left = `${leftParams}px`;

      // Vertical Layout: Smart positioning based on menu location
      const gap = isMobile ? 24 : 12;

      const isTopMenu = menuRect.top < (window.innerHeight / 2);

      if (isTopMenu) {
        // Menu is at TOP -> Panel goes BELOW
        panel.style.top = `${menuRect.bottom + gap}px`;
        panel.style.bottom = 'auto';
        panel.style.transformOrigin = 'center top';
      } else {
        // Menu is at BOTTOM -> Panel goes ABOVE (default)
        const bottomOffset = window.innerHeight - menuRect.top;

        let safeBottom = bottomOffset + gap;
        if (bottomOffset <= 0 || bottomOffset > window.innerHeight) {
          safeBottom = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tps-gcm-live-bottom') || '16') + 60);
        }

        panel.style.bottom = `${safeBottom}px`;
        panel.style.top = 'auto';
        panel.style.transformOrigin = 'center bottom';
      }

      panel.style.right = 'auto';
      panel.style.transform = 'none';
    } else {
      // Fallback if no rects available
      const liveBottom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tps-gcm-live-bottom') || '16');
      panel.style.bottom = `${liveBottom + 60}px`;
      panel.style.left = '50%';
      panel.style.transform = 'translateX(-50%)';
    }

    panel.style.removeProperty('opacity');
    panel.style.removeProperty('visibility');
  }

  private applyMenuVisibility(menuEl: HTMLElement): void {
    menuEl.classList.toggle('tps-gcm-gesture-collapsed', this.swipeCollapsed);
    
    // Also set inline styles for collapsed state to ensure consistency
    if (this.swipeCollapsed) {
      menuEl.style.visibility = 'hidden';
      menuEl.style.opacity = '0';
      menuEl.style.pointerEvents = 'none';
    } else {
      menuEl.style.visibility = 'visible';
      menuEl.style.opacity = '1';
      menuEl.style.pointerEvents = 'auto';
    }
  }

  private applyInlinePanelVisibility(panelEl: HTMLElement): void {
    // When keyboard appears, force-hide panel so it does not cover the viewport.
    const keyboardHidden = this.keyboardVisible && Platform.isMobile;
    panelEl.classList.toggle('tps-gcm-subitems-panel--keyboard-hidden', keyboardHidden);
    panelEl.classList.toggle('tps-gcm-gesture-collapsed', this.swipeCollapsed);
    
    // Also set inline styles for collapsed state to ensure consistency
    if (this.swipeCollapsed || keyboardHidden) {
      panelEl.style.visibility = 'hidden';
      panelEl.style.opacity = '0';
      panelEl.style.pointerEvents = 'none';
    } else {
      panelEl.style.visibility = 'visible';
      panelEl.style.opacity = '1';
      panelEl.style.pointerEvents = 'auto';
    }
  }

  private setSwipeCollapsed(collapsed: boolean): void {
    if (this.swipeCollapsed === collapsed) return;
    this.swipeCollapsed = collapsed;

    for (const instances of this.menus.values()) {
      if (instances.reading?.isConnected) this.applyMenuVisibility(instances.reading);
      if (instances.live?.isConnected) this.applyMenuVisibility(instances.live);
    }

    for (const panel of this.inlineSubitemsPanels.values()) {
      if (panel.isConnected) this.applyInlinePanelVisibility(panel);
    }
  }

  private ensureSwipeGestureTracking(view: MarkdownView): void {
    if (this.scrollHideListeners.has(view)) return;

    const scroller = this.resolveScrollContainer(view);
    if (!scroller) return;

    const HIDE_THRESHOLD = 60;
    const SHOW_THRESHOLD = 30;

    const state = { scroller, lastTop: scroller.scrollTop, accum: 0, listener: () => {} };

    state.listener = () => {
      const top = scroller.scrollTop;
      const delta = top - state.lastTop;
      state.lastTop = top;

      // Direction changed — reset accumulator.
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

    scroller.addEventListener('scroll', state.listener, { passive: true });
    this.scrollHideListeners.set(view, state);
  }

  private releaseSwipeGestureTracking(view: MarkdownView): void {
    const instances = this.menus.get(view);
    if (instances?.reading || instances?.live) return;
    const state = this.scrollHideListeners.get(view);
    if (!state) return;
    state.scroller.removeEventListener('scroll', state.listener);
    this.scrollHideListeners.delete(view);
  }

  private resolveScrollContainer(view: MarkdownView): HTMLElement | null {
    const mode = this.getViewMode(view);
    if (mode === 'preview') {
      return view.contentEl?.querySelector<HTMLElement>('.markdown-preview-view') ?? null;
    }
    return view.contentEl?.querySelector<HTMLElement>('.cm-scroller') ??
      view.contentEl?.querySelector<HTMLElement>('.markdown-source-view') ??
      null;
  }

  private removeInlineSubitemsPanel(view: MarkdownView): void {
    const panel = this.inlineSubitemsPanels.get(view);
    if (panel) {
      panel.remove();
      this.inlineSubitemsPanels.delete(view);
    }
    this.detachPanelScrollListener(view);
  }

  private removeStrayInlineSubitemsPanels(view: MarkdownView, keep?: HTMLElement | null): void {
    // Search within the view's contentEl
    const root = view.contentEl;
    if (root) {
      for (const panel of Array.from(root.querySelectorAll<HTMLElement>('.tps-gcm-subitems-panel--title-inline'))) {
        if (keep && panel === keep) continue;
        panel.remove();
      }
    }
    // Also remove body-hosted (live preview) stray panels belonging to this view's file
    for (const panel of Array.from(document.body.children)) {
      if (!(panel instanceof HTMLElement)) continue;
      if (!panel.classList.contains('tps-gcm-subitems-panel--title-inline')) continue;
      if (keep && panel === keep) continue;
      const fp = panel.dataset?.filePath;
      if (!fp || fp === view.file?.path) panel.remove();
    }
  }

  // ... (live height observer methods unchanged) ...

  // Helper inside createPersistentMenu or others can remain ...

  // Updated attachPanelScrollListener to be simpler since it's always fixed now
  private attachPanelScrollListener(view: MarkdownView, panel: HTMLElement, container: HTMLElement): void {
    this.detachPanelScrollListener(view);

    const hidePanel = () => {
      panel.classList.add('tps-gcm-subitems-panel--hidden');
      // Re-apply geometry to the main menu if needed (so it doesn't jump).
      // If the panel affects the menu geometry (e.g. by padding), we might need to recalc.
      // But typically for fixed overlay, we just hide the overlay.
    };

    const showPanel = () => {
      if (!panel.isConnected) return;
      if (this.swipeCollapsed) return;
      panel.classList.remove('tps-gcm-subitems-panel--hidden');
      window.requestAnimationFrame(() => {
        if (panel.isConnected) this.applyInlinePanelGeometry(view, panel);
      });
    };

    const listener = (evt: Event) => {
      // Check if scroll target is within the menu or panel
      const target = evt.target instanceof Node ? evt.target as HTMLElement : null;
      if (target) {
        // If scrolling the panel itself or elements within it
        if (target === panel || panel.contains(target)) return;

        // If scrolling the menu container (activeMenu) or its children
        const menu = panel.closest('.tps-global-context-menu');
        if (menu && (target === menu || menu.contains(target))) return;
      }

      const existing = this.scrollListeners.get(view);
      if (existing?.timer) window.clearTimeout(existing.timer);

      hidePanel();

      const timer = window.setTimeout(() => {
        if (this.scrollListeners.get(view)) showPanel();
      }, 400);

      const data = this.scrollListeners.get(view);
      if (data) data.timer = timer;
    };

    // Use capture phase to ensure we catch scroll events from children (like preview view)
    // even if they don't bubble (scroll events usually don't bubble, but capture works)
    container.addEventListener('scroll', listener, { passive: true, capture: true });
    this.scrollListeners.set(view, { container, listener, timer: undefined });
  }

  /**
   * Detach scroll listener from panel
   */
  private detachPanelScrollListener(view: MarkdownView): void {
    const data = this.scrollListeners.get(view);
    if (!data) return;

    data.container.removeEventListener('scroll', data.listener, { passive: true, capture: true } as any);
    if (data.timer) {
      window.clearTimeout(data.timer);
    }
    this.scrollListeners.delete(view);
  }

  private updateLiveHeightVar(): void {
    if (this.liveHeights.size === 0) {
      document.documentElement.style.removeProperty('--tps-gcm-live-height');
      return;
    }
    const maxHeight = Math.max(...this.liveHeights.values());
    document.documentElement.style.setProperty('--tps-gcm-live-height', `${Math.ceil(maxHeight)}px`);
  }

  private attachLiveHeightObserver(
    view: MarkdownView,
    menuEl: HTMLElement,
    headerEl?: HTMLElement | null
  ): void {
    this.detachLiveHeightObserver(view);
    if (typeof ResizeObserver !== 'function') return;

    const updateHeight = () => {
      const measuredHeight = menuEl.getBoundingClientRect().height;
      if (!measuredHeight || !Number.isFinite(measuredHeight)) return;
      // Cap the published height so stacked bars conserve space.
      const cappedHeight = measuredHeight; // Platform.isMobile check removed
      this.liveHeights.set(view, cappedHeight);
      this.updateLiveHeightVar();

      const header = headerEl ?? menuEl.querySelector<HTMLElement>('.tps-gcm-header');
      if (header) {
        const headerHeight = header.getBoundingClientRect().height;
        if (headerHeight && Number.isFinite(headerHeight)) {
          document.documentElement.style.setProperty(
            '--tps-gcm-live-header-height',
            `${Math.ceil(headerHeight)}px`
          );
        }
      }
    };

    const observer = new ResizeObserver(() => updateHeight());
    observer.observe(menuEl);
    if (headerEl) {
      observer.observe(headerEl);
    }
    this.liveResizeObservers.set(view, observer);
    updateHeight();
  }

  private detachLiveHeightObserver(view: MarkdownView): void {
    const observer = this.liveResizeObservers.get(view);
    if (observer) {
      observer.disconnect();
      this.liveResizeObservers.delete(view);
    }
    if (this.liveHeights.delete(view)) {
      this.updateLiveHeightVar();
    }
  }

  /**
   * Create a persistent menu element (just the chip strip, no header)
   */
  createPersistentMenu(
    view: MarkdownView,
    mode: 'reading' | 'live'
  ): HTMLElement | null {
    const file = view.file;
    if (!file) return null;

    const menuEl = document.createElement('div');
    menuEl.className = `tps-global-context-menu tps-global-context-menu--persistent tps-global-context-menu--${mode}`;
    menuEl.setAttribute('role', 'presentation');

    // Build the panel directly (no header, no collapse logic)
    try {
      const panel = this.plugin.buildSpecialPanel(file, {
        recurrenceRoot: menuEl,
        closeAfterRecurrence: false,
      });
      if (panel) {
        menuEl.appendChild(panel);
      }
    } catch (error) {
      logger.error('[TPS GCM] Failed to build persistent panel:', error);
    }

    return menuEl;
  }

  /**
   * Remove reading menu from view
   */
  removeReadingMenu(view: MarkdownView): void {
    const instances = this.menus.get(view);
    if (!instances?.reading) return;

    instances.reading.remove();
    instances.reading = null;

    if (!instances.live) {
      this.menus.delete(view);
      this.releaseSwipeGestureTracking(view);
      return;
    }

    this.menus.set(view, instances);
  }

  /**
   * Remove live menu from view
   */
  removeLiveMenu(view: MarkdownView): void {
    const instances = this.menus.get(view);
    if (!instances?.live) return;

    this.detachLiveHeightObserver(view);
    instances.live.remove();
    instances.live = null;

    if (!instances.reading) {
      this.menus.delete(view);
      this.releaseSwipeGestureTracking(view);
      return;
    }

    this.menus.set(view, instances);
  }

  /**
   * Clean up all menus for a view
   */
  cleanup(view: MarkdownView): void {
    this.clearAttachRetry(view);
    this.detachGeometryObserver(view);
    this.removeInlineSubitemsPanel(view);
    this.removeStrayInlineSubitemsPanels(view, null);
    this.removeInlineTitleIcon(view);
    const instances = this.menus.get(view);
    if (!instances) return;

    if (instances.reading) {
      instances.reading.remove();
    }
    if (instances.live) {
      this.detachLiveHeightObserver(view);
      instances.live.remove();
    }
    this.menus.delete(view);
    this.releaseSwipeGestureTracking(view);
  }

  /**
   * Refresh menus for views showing a specific file.
   * Called when frontmatter changes to update stale inline menus.
   * Updates just the header badges in-place to avoid visual jitter.
   */
  refreshMenusForFile(
    file: TFile,
    force: boolean = false,
    options: { rebuildInlineSubitems?: boolean } = {}
  ): void {
    const lastEdit = (this.plugin as any)?.lastEditorChangeAt as number | undefined;
    const quietMs = (this.plugin as any)?.typingQuietWindowMs as number | undefined;
    if (lastEdit && quietMs && Date.now() - lastEdit < quietMs) {
      return;
    }
    if (!force && typeof (this.plugin as any)?.isEditorFocused === "function") {
      if ((this.plugin as any).isEditorFocused()) {
        return;
      }
    }
    const shouldRebuildInlineSubitems = options.rebuildInlineSubitems === true;

    for (const [view, instances] of this.menus.entries()) {
      if (view.file?.path === file.path) {
        // Update header badges in-place instead of recreating the entire menu
        // This prevents visual jitter/movement

        if (instances.live) {
          this.applyPersistentMenuGeometry(view, instances.live);
          this.applyMenuVisibility(instances.live);
          this.ensureSwipeGestureTracking(view);
          const headerRight = instances.live.querySelector('.tps-gcm-header-right');
          if (headerRight) {
            // Get updated badges from the controller
            const newBadges = this.plugin.menuController.createHeaderBadges(file, view.leaf);
            headerRight.innerHTML = '';
            headerRight.appendChild(newBadges);
          }
        }

        if (instances.reading) {
          this.applyPersistentMenuGeometry(view, instances.reading);
          this.applyMenuVisibility(instances.reading);
          this.ensureSwipeGestureTracking(view);
          const headerRight = instances.reading.querySelector('.tps-gcm-header-right');
          if (headerRight) {
            // Get updated badges from the controller
            const newBadges = this.plugin.menuController.createHeaderBadges(file, view.leaf);
            headerRight.innerHTML = '';
            headerRight.appendChild(newBadges);
          }
        }

        if (shouldRebuildInlineSubitems) {
          this.removeInlineSubitemsPanel(view);
          this.removeStrayInlineSubitemsPanels(view, null);
        }
        this.ensureInlineSubitemsPanel(view);
        this.ensureInlineTitleIcon(view);
        this.ensureTopParentNav(view);
      }
    }
  }

  /**
   * Detach all menus
   */
  detach(): void {
    this.teardownKeyboardDetection();
    for (const timerId of this.attachRetryTimers.values()) {
      window.clearTimeout(timerId);
    }
    this.attachRetryTimers.clear();
    for (const view of Array.from(this.scrollListeners.keys())) {
      this.detachPanelScrollListener(view);
    }
    for (const view of Array.from(this.liveResizeObservers.keys())) {
      this.detachLiveHeightObserver(view);
    }
    for (const view of Array.from(this.geometryResizeObservers.keys())) {
      this.detachGeometryObserver(view);
    }
    for (const view of Array.from(this.inlineSubitemsPanels.keys())) {
      this.removeInlineSubitemsPanel(view);
    }
    for (const view of Array.from(this.titleIcons.keys())) {
      this.removeInlineTitleIcon(view);
    }
    for (const view of Array.from(this.topParentNavs.keys())) {
      this.removeTopParentNav(view);
    }
    for (const view of Array.from(this.menus.keys())) {
      this.cleanup(view);
    }
    for (const [view, state] of this.scrollHideListeners.entries()) {
      state.scroller.removeEventListener('scroll', state.listener);
      this.scrollHideListeners.delete(view);
    }
  }
}
