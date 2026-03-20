import { MarkdownView, TFile, WorkspaceLeaf, Platform, debounce, setIcon, Menu, normalizePath, getAllTags } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import {
  isCompatibleMarkdownView,
  getViewMode,
  getCompatibleMarkdownViewFromLeaf,
  resolvePrimaryMarkdownView,
  pickBestMarkdownLeaf,
  scoreMarkdownLeaf,
  isLeafActiveInDom,
  isLeafVisible,
  isSideDockLeaf,
} from '../services/leaf-resolver';
import { MenuController, addSafeClickListener } from './menu-controller';
import { MenuInstances } from '../types';
import * as logger from '../logger';
import { normalizeTagValue, parseTagInput } from '../../utils/tag-utils';
// scroll-direction hide/reveal is handled inline â€” no gesture-handler import needed.

// Get the LIVE mode constant if available


/**
 * Manages persistent menus in reading and live preview modes
 */
export class PersistentMenuManager {
  plugin: TPSGlobalContextMenuPlugin;
  menus: Map<MarkdownView, MenuInstances> = new Map();
  private inlineSubitemsPanels: Map<MarkdownView, HTMLElement> = new Map();
  private noteReferencesPanels: Map<MarkdownView, HTMLElement> = new Map();
  private noteGraphPanels: Map<MarkdownView, HTMLElement> = new Map();
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
  private topLinkPreviewArmedPath: string | null = null;
  private topLinkPreviewArmedUntil = 0;
  private topLinkPreviewEl: HTMLElement | null = null;
  private topLinkPreviewTextCache: Map<string, string> = new Map();
  private topLinkPreviewHideTimer: number | null = null;
  private topLinksPopoverEl: HTMLElement | null = null;
  private topLinksPopoverOutsideHandler: ((evt: MouseEvent) => void) | null = null;

  constructor(plugin: TPSGlobalContextMenuPlugin) {
    this.plugin = plugin;
    this.setupKeyboardDetection();
  }

  /**
   * Public setter to update collapse state from PanelBuilder or other components
   */
  public setSubitemsPanelCollapsed(path: string, collapsed: boolean): void {
    this.collapsedStateByPath.set(path, collapsed);
    // Keep top nav buttons in sync with collapse state changes in real time.
    for (const view of this.menus.keys()) {
      if (view.file?.path === path) {
        this.ensureTopParentNav(view);
      }
    }
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
          let match = false;
          if (operator === 'contains') match = path.includes(condition.value || '');
          if (operator === 'equals') match = path === condition.value;
          if (operator === 'starts-with') match = path.startsWith(condition.value || '');
          if (operator === 'ends-with') match = path.endsWith(condition.value || '');
          if (operator === 'not-contains') match = !path.includes(condition.value || '');

          console.log(`[fileMatchesIgnoreRules] path eval: ${path} vs ${condition.value} with ${operator} -> ${match}`);
          return match;
        }

        if (type === 'frontmatter') {
          const key = String(condition.key || '').toLowerCase();
          const fmKeys = Object.keys(fm);
          const fmKey = fmKeys.find((k) => k.toLowerCase() === key);
          const value = fmKey ? fm[fmKey] : null;

          let match = false;
          if (operator === 'exists') match = value != null && value !== '';
          if (operator === 'missing') match = value == null || value === '';
          if (operator === 'equals') match = String(value || '') === (condition.value || '');
          if (operator === 'not-equals') match = String(value || '') !== (condition.value || '');
          if (operator === 'contains') match = String(value || '').includes(condition.value || '');
          if (operator === 'not-contains') match = !String(value || '').includes(condition.value || '');

          console.log(`[fileMatchesIgnoreRules] frontmatter eval: key=${key}, value=${value} vs ${condition.value} with ${operator} -> ${match}`);
          return match;
        }

        return false;
      });

      if (conditionsMatch) return true;
    }

    return false;
  }

  setupKeyboardDetection() {
    if (!Platform.isMobile) return;
    if (typeof window === 'undefined') return;

    // Mobile platforms differ: sometimes visualViewport shrinks, sometimes window.innerHeight shrinks
    const getViewportHeight = () => window.visualViewport?.height || window.innerHeight;

    this.baseHeight = Math.max(window.innerHeight || 0, getViewportHeight() || 0);

    const evaluateKeyboardState = () => {
      const currentHeight = getViewportHeight();
      if (!currentHeight) return;

      // Keep baseline resilient after orientation/UI chrome changes.
      if (currentHeight > this.baseHeight) {
        this.baseHeight = currentHeight;
      }

      const delta = this.baseHeight - currentHeight;
      const ratio = this.baseHeight > 0 ? delta / this.baseHeight : 0;
      const visible = delta > 140 || ratio > 0.18;

      if (visible === this.keyboardVisible) return;
      this.keyboardVisible = visible;
      this.plugin.keyboardVisible = visible;
      this.handleKeyboardVisibilityChange(visible);
    };

    this.visualViewportResizeHandler = () => evaluateKeyboardState();
    this.visualViewportScrollHandler = () => evaluateKeyboardState();

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this.visualViewportResizeHandler);
      window.visualViewport.addEventListener('scroll', this.visualViewportScrollHandler);
    }
    // Critical fallback for Obsidian Mobile where visualViewport doesn't always fire
    window.addEventListener('resize', this.visualViewportResizeHandler);

    evaluateKeyboardState();
  }

  teardownKeyboardDetection() {
    if (typeof window === 'undefined') return;

    if (window.visualViewport) {
      if (this.visualViewportResizeHandler) {
        window.visualViewport.removeEventListener('resize', this.visualViewportResizeHandler);
      }
      if (this.visualViewportScrollHandler) {
        window.visualViewport.removeEventListener('scroll', this.visualViewportScrollHandler);
      }
    }

    if (this.visualViewportResizeHandler) {
      window.removeEventListener('resize', this.visualViewportResizeHandler);
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
      for (const view of Array.from(this.noteReferencesPanels.keys())) {
        this.removeNoteReferencesPanel(view);
      }
      for (const view of Array.from(this.noteGraphPanels.keys())) {
        this.removeNoteGraphPanel(view);
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
    const targetView = resolvePrimaryMarkdownView(this.plugin.app);

    if (targetView && isCompatibleMarkdownView(targetView)) {
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
        this.ensureNoteGraphPanel(targetView);
      } catch (error) {
        logger.error('[TPS GCM] Failed to ensure note graph panel:', error);
      }
      try {
        this.ensureNoteReferencesPanel(targetView);
      } catch (error) {
        logger.error('[TPS GCM] Failed to ensure note references panel:', error);
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

    for (const view of Array.from(this.noteReferencesPanels.keys())) {
      if (!activeViews.has(view)) {
        this.removeNoteReferencesPanel(view);
      }
    }

    for (const view of Array.from(this.noteGraphPanels.keys())) {
      if (!activeViews.has(view)) {
        this.removeNoteGraphPanel(view);
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

  private removeGlobalStraysOutsideTarget(targetView: MarkdownView | null): void {
    const targetRoot = targetView?.contentEl || null;
    const targetContainer = ((targetView as any)?.containerEl as HTMLElement | undefined) || null;
    // Live preview panels live in document.body â€” keep the one owned by the target view
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
    if (!isCompatibleMarkdownView(view)) return;

    const file = view.file;
    if (file instanceof TFile && this.fileMatchesIgnoreRules(file, this.plugin.settings.inlineMenu_IgnoreRules)) {
      this.removeReadingMenu(view);
      return;
    }

    const mode = getViewMode(view);
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
    if (!isCompatibleMarkdownView(view)) return;

    const file = view.file;
    if (file instanceof TFile && this.fileMatchesIgnoreRules(file, this.plugin.settings.inlineMenu_IgnoreRules)) {
      this.removeLiveMenu(view);
      return;
    }

    const mode = getViewMode(view);
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

    const mode = getViewMode(view);
    // Show in both preview and source (live preview) modes
    return mode === 'preview' || mode === 'source';
  }

  private shouldRenderInlineNotePanels(view: MarkdownView): boolean {
    const file = view.file;
    if (!(file instanceof TFile)) return false;
    if (file.extension?.toLowerCase() !== 'md') return false;
    if (this.plugin.shouldIgnoreAutoFrontmatterWrite(file)) return false;

    // We do NOT check inlineMenu_IgnoreRules here, because the user wants References and Graph
    // to be visible on Daily Notes even if the Global Context Menu is hidden.

    const mode = getViewMode(view);
    return mode === 'preview' || mode === 'source';
  }

  private resolveInlineSubitemsAnchor(view: MarkdownView): { parent: HTMLElement; reference: Element | null; titleEl?: Element | null } | null {
    const contentRoot = view.contentEl;
    if (!contentRoot) return null;

    const mode = getViewMode(view);
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

  private resolveNoteFooterParent(view: MarkdownView): HTMLElement | null {
    const contentRoot = view.contentEl;
    if (!contentRoot) return null;

    const mode = getViewMode(view);
    if (mode === 'preview') {
      return contentRoot.querySelector<HTMLElement>('.markdown-preview-view .markdown-preview-sizer');
    }

    if (mode === 'source') {
      // In live preview, prefer mounting under CM content so we can place references
      // relative to the last rendered line (instead of viewport bottom).
      const hostRoot =
        contentRoot.querySelector<HTMLElement>('.cm-content') ||
        contentRoot.querySelector<HTMLElement>('.cm-sizer') ||
        contentRoot.querySelector<HTMLElement>('.cm-contentContainer') ||
        contentRoot.querySelector<HTMLElement>('.cm-scroller');
      if (!hostRoot) return null;

      let footerHost = hostRoot.querySelector<HTMLElement>(':scope > .tps-gcm-note-footer-host');
      if (!footerHost) {
        footerHost = document.createElement('div');
        footerHost.className = 'tps-gcm-note-footer-host';
        hostRoot.appendChild(footerHost);
      }
      // CRITICAL: Prevent CodeMirror from parsing our DOM nodes as user-typed text
      footerHost.contentEditable = 'false';
      return footerHost;
    }

    return null;
  }

  private resolveNoteGraphHost(view: MarkdownView): HTMLElement | null {
    const contentRoot = view.contentEl;
    if (!contentRoot) return null;

    const mode = getViewMode(view);
    if (mode === 'preview') {
      return contentRoot.querySelector<HTMLElement>('.markdown-preview-view .markdown-preview-sizer')
        || contentRoot.querySelector<HTMLElement>('.markdown-preview-view');
    }

    if (mode === 'source') {
      const sourceView = contentRoot.querySelector<HTMLElement>('.markdown-source-view');
      if (!sourceView) return null;
      return sourceView.querySelector<HTMLElement>('.cm-sizer')
        || sourceView.querySelector<HTMLElement>('.cm-contentContainer')
        || sourceView.querySelector<HTMLElement>('.cm-scroller')
        || sourceView;
    }

    return null;
  }

  private positionNoteGraphPanel(view: MarkdownView, panel: HTMLElement, host: HTMLElement): void {
    const titleEl = this.resolveInlineTitleElement(view);
    window.requestAnimationFrame(() => {
      if (!panel.isConnected || !host.isConnected) return;
      const hostRect = host.getBoundingClientRect();
      const titleRect = titleEl?.getBoundingClientRect();
      const top = titleRect
        ? Math.max(8, Math.round(titleRect.top - hostRect.top))
        : 12;
      panel.style.top = `${top}px`;
      panel.style.right = '12px';
    });
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

    // Note: the subitems panel sits BELOW the context menu bar via flexbox order â€” no offsetY adjustment needed here.
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
      menuEl.style.bottom = 'calc(var(--tps-auto-base-embed-bottom, var(--tps-gcm-live-bottom, 16px)) + env(safe-area-inset-bottom, 0px) + var(--tps-auto-base-embed-height, 0px) + 8px)';
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

    const mode = getViewMode(view);
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
    // First, prefer explicit frontmatter color values.
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

    // Fall back to Notebook Navigator rule-derived color only when the file
    // is not excluded from companion frontmatter writes.
    if (file && !this.isCompanionWriteExcluded(file)) {
      const companionColor = this.resolveCompanionRuleColor(file, frontmatter);
      if (companionColor) {
        return companionColor;
      }
    }
    return '';
  }

  private isCompanionWriteExcluded(file: TFile): boolean {
    const pluginsApi: any = (this.plugin.app as any)?.plugins;
    const companion: any =
      pluginsApi?.plugins?.['tps-notebook-navigator-companion']
      ?? pluginsApi?.plugins?.['TPS-Notebook-Navigator-Companion (Dev)'];
    const exclusionService: any = companion?.exclusionService;
    if (!exclusionService || typeof exclusionService.shouldIgnore !== 'function') return false;
    try {
      return !!exclusionService.shouldIgnore(file, { bypassCreationGrace: true });
    } catch {
      return false;
    }
  }

  private resolveCompanionRuleColor(file: TFile, frontmatter: Record<string, any>): string {
    const pluginsApi: any = (this.plugin.app as any)?.plugins;
    const companion: any = pluginsApi?.plugins?.['tps-notebook-navigator-companion'];
    const ruleEngine: any = companion?.ruleEngine;
    if (companion?.settings?.enabled && ruleEngine?.resolveVisualOutputs) {
      try {
        const cache = this.plugin.app.metadataCache.getFileCache(file) as any;
        const cacheTags = parseTagInput([...(getAllTags(cache) || []), frontmatter?.tags, frontmatter?.tag]);
        const visual = ruleEngine.resolveVisualOutputs(companion.settings.rules || [], {
          file: {
            path: file.path,
            name: file.name,
            basename: file.basename,
            extension: file.extension,
          },
          frontmatter,
          tags: Array.from(new Set(cacheTags.map((tag) => normalizeTagValue(tag)).filter(Boolean))),
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

    // Finally, check Notebook Navigator rules if enabled and the file is not
    // excluded from companion writes.
    if (this.isCompanionWriteExcluded(file)) {
      return '';
    }

    // Notebook Navigator rule-derived icon fallback
    const ruleEngine: any = companion?.ruleEngine;
    if (companion?.settings?.enabled && ruleEngine?.resolveVisualOutputs) {
      try {
        const cache = this.plugin.app.metadataCache.getFileCache(file) as any;
        const cacheTags = parseTagInput([...(getAllTags(cache) || []), frontmatter?.tags, frontmatter?.tag]);
        const visual = ruleEngine.resolveVisualOutputs(companion.settings.rules || [], {
          file: {
            path: file.path,
            name: file.name,
            basename: file.basename,
            extension: file.extension,
          },
          frontmatter,
          tags: Array.from(new Set(cacheTags.map((tag) => normalizeTagValue(tag)).filter(Boolean))),
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

  private getDirectLinks(file: TFile): { incoming: TFile[], outgoing: TFile[] } {
    const app = this.plugin.app;

    // Outgoing
    const resolvedLinks = app.metadataCache.resolvedLinks[file.path] || {};
    const outgoingPaths = Object.keys(resolvedLinks);
    const outgoing: TFile[] = [];
    for (const p of outgoingPaths) {
      if (p === file.path) continue; // skip self-references
      const f = app.vault.getAbstractFileByPath(p);
      if (f instanceof TFile) outgoing.push(f);
    }

    // Incoming
    const allLinks = app.metadataCache.resolvedLinks || {};
    const incoming: TFile[] = [];
    for (const sourcePath in allLinks) {
      if (sourcePath === file.path) continue;
      if (allLinks[sourcePath][file.path] !== undefined) {
        const f = app.vault.getAbstractFileByPath(sourcePath);
        if (f instanceof TFile) incoming.push(f);
      }
    }

    outgoing.sort((a, b) => this.getFileDisplayTitle(a).localeCompare(this.getFileDisplayTitle(b)));
    incoming.sort((a, b) => this.getFileDisplayTitle(a).localeCompare(this.getFileDisplayTitle(b)));

    return { incoming, outgoing };
  }

  private getFrontmatterLinkLabel(sourceFile: TFile, targetFile: TFile): string | null {
    const frontmatter = (this.plugin.app.metadataCache.getFileCache(sourceFile)?.frontmatter || {}) as Record<string, any>;
    for (const [key, value] of Object.entries(frontmatter)) {
      if (key === 'position') continue;
      if (this.frontmatterValueLinksToFile(value, sourceFile.path, targetFile)) {
        return key;
      }
    }
    return null;
  }

  private frontmatterValueLinksToFile(value: any, sourcePath: string, targetFile: TFile): boolean {
    if (value == null) return false;

    if (Array.isArray(value)) {
      return value.some((entry) => this.frontmatterValueLinksToFile(entry, sourcePath, targetFile));
    }

    if (typeof value === 'object') {
      return Object.values(value).some((entry) => this.frontmatterValueLinksToFile(entry, sourcePath, targetFile));
    }

    const raw = String(value).trim();
    if (!raw) return false;

    const candidates = new Set<string>();
    const addCandidate = (candidate: string | null | undefined) => {
      const normalized = String(candidate || '').trim();
      if (normalized) candidates.add(normalized);
    };

    const direct = this.resolveParentValueToFile(raw, sourcePath);
    if (direct?.path === targetFile.path) {
      return true;
    }

    const wikiMatches = raw.matchAll(/\[\[([^\]]+)\]\]/g);
    for (const match of wikiMatches) {
      addCandidate(match[1]);
    }

    const markdownMatches = raw.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
    for (const match of markdownMatches) {
      addCandidate(match[1]);
    }

    if (candidates.size === 0) {
      addCandidate(raw);
    }

    for (const candidate of candidates) {
      const resolved = this.resolveParentValueToFile(candidate, sourcePath);
      if (resolved?.path === targetFile.path) {
        return true;
      }
    }

    return false;
  }

  private isSubitemsPanelCollapsed(file: TFile, view: MarkdownView): boolean {
    const trackedPanel = this.inlineSubitemsPanels.get(view);
    if (
      trackedPanel instanceof HTMLElement &&
      trackedPanel.isConnected &&
      trackedPanel.dataset.filePath === file.path
    ) {
      return trackedPanel.classList.contains('tps-gcm-subitems-panel--collapsed');
    }
    return this.collapsedStateByPath.get(file.path) ?? false;
  }

  private renderTopLinkPopoverRow(
    popover: HTMLElement,
    linkedFile: TFile,
    sourceFile: TFile,
    direction: 'outgoing' | 'incoming',
    frontmatterKey?: string | null
  ): void {
    const row = document.createElement('button');
    row.type = 'button';
    row.style.width = '100%';
    row.style.textAlign = 'left';
    row.style.padding = '8px 10px';
    row.style.border = 'none';
    row.style.borderRadius = '8px';
    row.style.background = 'transparent';
    row.style.color = 'inherit';
    row.style.cursor = 'pointer';
    row.style.display = 'block';
    row.textContent = this.getFileDisplayTitle(linkedFile);

    row.addEventListener('mouseenter', (evt) => {
      const previewSource = direction === 'outgoing' ? sourceFile : linkedFile;
      const previewTarget = direction === 'outgoing' ? linkedFile : sourceFile;
      void this.showTopLinkPreviewCard(previewTarget, previewSource, row, evt as MouseEvent, frontmatterKey || null);
    });
    row.addEventListener('mouseleave', () => this.scheduleHideTopLinkPreviewCard(300));

    addSafeClickListener(row, (evt) => {
      const now = Date.now();
      const isSecondTap =
        this.topLinkPreviewArmedPath === linkedFile.path &&
        now <= this.topLinkPreviewArmedUntil;
      if (!isSecondTap) {
        this.topLinkPreviewArmedPath = linkedFile.path;
        this.topLinkPreviewArmedUntil = now + 8000;
        const previewSource = direction === 'outgoing' ? sourceFile : linkedFile;
        const previewTarget = direction === 'outgoing' ? linkedFile : sourceFile;
        void this.showTopLinkPreviewCard(previewTarget, previewSource, row, evt as MouseEvent, frontmatterKey || null);
        return;
      }

      this.topLinkPreviewArmedPath = null;
      this.topLinkPreviewArmedUntil = 0;
      this.hideTopLinkPreviewCard();
      this.hideTopLinksPopover();
      void this.plugin.openFileInLeaf(linkedFile, false, () => this.plugin.app.workspace.getLeaf(false), { revealLeaf: true });
    });

    popover.appendChild(row);
  }

  private addTopLinkMenuItem(
    menu: Menu,
    sourceFile: TFile,
    targetFile: TFile,
    labelText: string,
    iconName: string
  ): void {
    menu.addItem((item: any) => {
      item.setTitle(labelText).setIcon(iconName).onClick((evt: MouseEvent) => {
        const now = Date.now();
        const isSecondTap =
          this.topLinkPreviewArmedPath === targetFile.path &&
          now <= this.topLinkPreviewArmedUntil;

        if (!isSecondTap) {
          this.topLinkPreviewArmedPath = targetFile.path;
          this.topLinkPreviewArmedUntil = now + 8000;
          void this.showTopLinkPreviewCard(targetFile, sourceFile, this.resolveMenuItemElement(item), evt);
          return;
        }

        this.topLinkPreviewArmedPath = null;
        this.topLinkPreviewArmedUntil = 0;
        this.hideTopLinkPreviewCard();
        void this.plugin.openFileInLeaf(targetFile, false, () => this.plugin.app.workspace.getLeaf(false), { revealLeaf: true });
      });

      // Desktop hover support for contextual note preview.
      window.setTimeout(() => {
        const el = this.resolveMenuItemElement(item);
        if (!el || el.dataset.tpsTopLinkHoverBound === 'true') return;
        el.dataset.tpsTopLinkHoverBound = 'true';
        el.addEventListener('mouseover', (evt: MouseEvent) => {
          void this.showTopLinkPreviewCard(targetFile, sourceFile, el, evt);
        });
        el.addEventListener('mouseleave', () => {
          this.scheduleHideTopLinkPreviewCard(350);
        });
      }, 0);
    });
  }

  private resolveMenuItemElement(item: any): HTMLElement | null {
    const direct = item?.dom;
    if (direct instanceof HTMLElement) return direct;
    const domEl = item?.dom?.el;
    if (domEl instanceof HTMLElement) return domEl;
    const el = item?.el;
    if (el instanceof HTMLElement) return el;
    const titleEl = item?.titleEl;
    if (titleEl instanceof HTMLElement) return titleEl.closest('.menu-item') as HTMLElement | null;
    return null;
  }

  private async showTopLinkPreviewCard(
    targetFile: TFile,
    sourceFile: TFile,
    targetEl: HTMLElement | null,
    event: MouseEvent | null,
    frontmatterKey?: string | null,
  ): Promise<void> {
    const anchor = targetEl ?? (event?.currentTarget as HTMLElement | null) ?? (event?.target as HTMLElement | null);
    if (!anchor) return;
    const previewText = await this.getTopLinkPreviewText(targetFile);
    const detectedFrontmatterKey =
      String(frontmatterKey || '').trim() || this.getFrontmatterLinkLabel(sourceFile, targetFile);
    const referenceSnippet = await this.getSourceReferenceSnippet(sourceFile, targetFile, {
      suppressHighlight: !!detectedFrontmatterKey,
      frontmatterKey: detectedFrontmatterKey || null,
    });
    const normalizedSnippet = referenceSnippet
      || (detectedFrontmatterKey
        ? {
          before: '',
          match: `Frontmatter field: ${detectedFrontmatterKey}`,
          after: '',
          suppressHighlight: true,
        }
        : null);
    this.renderTopLinkPreviewCard(
      this.getFileDisplayTitle(targetFile),
      this.getFileDisplayTitle(sourceFile),
      previewText,
      normalizedSnippet,
      anchor
    );
  }

  private async getTopLinkPreviewText(file: TFile): Promise<string> {
    const cached = this.topLinkPreviewTextCache.get(file.path);
    if (cached) return cached;
    try {
      const raw = await this.plugin.app.vault.cachedRead(file);
      const text = this.extractTopLinkPreviewText(raw);
      this.topLinkPreviewTextCache.set(file.path, text);
      return text;
    } catch {
      return 'Unable to load note preview.';
    }
  }

  private extractTopLinkPreviewText(rawContent: string): string {
    let content = String(rawContent || '');
    if (content.startsWith('---')) {
      const end = content.indexOf('\n---', 3);
      if (end >= 0) {
        content = content.slice(end + 4);
      }
    }
    const normalized = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('```'))
      .join(' ');
    if (!normalized) return 'No body text.';
    return normalized.length > 320 ? `${normalized.slice(0, 320)}...` : normalized;
  }

  private getFileDisplayTitle(file: TFile): string {
    const fm = (this.plugin.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
    const title = typeof fm.title === 'string' ? fm.title.trim() : '';
    return title || file.basename;
  }

  private async getSourceReferenceSnippet(
    sourceFile: TFile,
    targetFile: TFile,
    options?: { suppressHighlight?: boolean; frontmatterKey?: string | null }
  ): Promise<{ before: string; match: string; after: string; suppressHighlight?: boolean } | null> {
    try {
      const raw = await this.plugin.app.vault.cachedRead(sourceFile);
      const lines = raw.split('\n');
      const frontmatterEndLine = this.getFrontmatterEndLine(raw);
      const regex = /!?\[\[([^[\]]+)\]\]|!?\[[^\]]*]\(([^)]+)\)/g;
      let fallbackFrontmatter: { before: string; match: string; after: string; suppressHighlight?: boolean } | null = null;

      for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
        const line = lines[lineNumber] || '';
        regex.lastIndex = 0;
        let match: RegExpExecArray | null = null;
        while ((match = regex.exec(line)) !== null) {
          const full = match[0] || '';
          const linkTargetRaw = (match[1] || match[2] || '').trim();
          if (!linkTargetRaw) continue;
          const normalizedLink = this.normalizeLinkTarget(linkTargetRaw);
          if (!normalizedLink) continue;
          const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(normalizedLink, sourceFile.path);
          if (!(resolved instanceof TFile) || resolved.path !== targetFile.path) continue;

          const snippet = this.extractInlineReferenceSnippet(line, match.index ?? 0, full, sourceFile.path);
          if (lineNumber > frontmatterEndLine) {
            return snippet;
          }
          if (!fallbackFrontmatter) {
            fallbackFrontmatter = { ...snippet, suppressHighlight: true };
          }
        }
      }

      if (fallbackFrontmatter) {
        if (options?.suppressHighlight) {
          fallbackFrontmatter.suppressHighlight = true;
        }
        if (options?.frontmatterKey) {
          fallbackFrontmatter.before = '';
          fallbackFrontmatter.match = `Frontmatter field: ${options.frontmatterKey}`;
          fallbackFrontmatter.after = '';
          fallbackFrontmatter.suppressHighlight = true;
        }
      }
      return fallbackFrontmatter;
    } catch {
      return null;
    }
  }

  private getFrontmatterEndLine(rawContent: string): number {
    const lines = String(rawContent || '').split('\n');
    if (lines[0]?.trim() !== '---') return -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]?.trim() === '---') return i;
    }
    return -1;
  }

  private extractInlineReferenceSnippet(
    line: string,
    startIndex: number,
    rawMatch: string,
    sourcePath: string
  ): { before: string; match: string; after: string } {
    const sourceLine = String(line || '');
    const matchText = this.linkTokenDisplayText(rawMatch, sourcePath);
    const endIndex = startIndex + rawMatch.length;
    const beforeRaw = sourceLine.slice(Math.max(0, startIndex - 80), startIndex);
    const afterRaw = sourceLine.slice(endIndex, Math.min(sourceLine.length, endIndex + 80));
    const before = beforeRaw.replace(/\s+/g, ' ').trim();
    const after = afterRaw.replace(/\s+/g, ' ').trim();
    return {
      before: before ? `…${before}` : '',
      match: matchText,
      after: after ? `${after}…` : '',
    };
  }

  private normalizeLinkTarget(rawTarget: string): string {
    let target = String(rawTarget || '').trim();
    if (!target) return '';
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1).trim();
    }
    target = target.replace(/^!/, '').trim();
    target = target.replace(/^['"]|['"]$/g, '').trim();
    const pipeIndex = target.indexOf('|');
    if (pipeIndex >= 0) target = target.slice(0, pipeIndex).trim();
    const hashIndex = target.indexOf('#');
    if (hashIndex >= 0) target = target.slice(0, hashIndex).trim();
    return target;
  }

  private linkTokenDisplayText(rawToken: string, sourcePath: string): string {
    const wiki = rawToken.match(/^!?\[\[([^\]]+)\]\]$/);
    if (wiki) {
      const inner = wiki[1];
      if (inner.includes('|')) {
        const alias = inner.split('|')[1]?.trim();
        if (alias) return alias;
      }
      const target = inner.split('|')[0].split('#')[0].trim();
      const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
      if (resolved instanceof TFile) return this.getFileDisplayTitle(resolved);
      return target;
    }
    const markdown = rawToken.match(/^!?\[([^\]]*)\]\(([^)]+)\)$/);
    if (markdown) {
      const label = String(markdown[1] || '').trim();
      if (label) return label;
      const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(this.normalizeLinkTarget(markdown[2]), sourcePath);
      if (resolved instanceof TFile) return this.getFileDisplayTitle(resolved);
    }
    return rawToken;
  }

  private renderTopLinkPreviewCard(
    targetName: string,
    sourceName: string,
    previewText: string,
    referenceSnippet: { before: string; match: string; after: string; suppressHighlight?: boolean } | null,
    targetEl: HTMLElement | null
  ): void {
    if (!targetEl) return;
    if (this.topLinkPreviewHideTimer !== null) {
      window.clearTimeout(this.topLinkPreviewHideTimer);
      this.topLinkPreviewHideTimer = null;
    }
    if (!this.topLinkPreviewEl) {
      const card = document.createElement('div');
      card.className = 'tps-gcm-top-link-preview';
      card.style.position = 'fixed';
      card.style.zIndex = '100000';
      card.style.maxWidth = '420px';
      card.style.minWidth = '260px';
      card.style.padding = '10px 12px';
      card.style.borderRadius = '10px';
      card.style.border = '1px solid var(--background-modifier-border)';
      card.style.background = 'var(--background-primary)';
      card.style.boxShadow = '0 12px 30px rgba(0,0,0,0.35)';
      card.style.pointerEvents = 'none';
      this.topLinkPreviewEl = card;
      document.body.appendChild(card);
    }

    this.topLinkPreviewEl.innerHTML = '';
    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.style.marginBottom = '6px';
    title.textContent = targetName;
    const subtitle = document.createElement('div');
    subtitle.style.opacity = '0.75';
    subtitle.style.fontSize = '12px';
    subtitle.style.marginBottom = '8px';
    subtitle.textContent = `Linked from ${sourceName}`;
    const body = document.createElement('div');
    body.style.fontSize = '13px';
    body.style.lineHeight = '1.45';
    body.textContent = previewText;

    const referenceWrap = document.createElement('div');
    referenceWrap.style.marginTop = '10px';
    referenceWrap.style.paddingTop = '8px';
    referenceWrap.style.borderTop = '1px solid var(--background-modifier-border)';
    const referenceLabel = document.createElement('div');
    referenceLabel.style.opacity = '0.75';
    referenceLabel.style.fontSize = '12px';
    referenceLabel.style.marginBottom = '4px';
    referenceLabel.textContent = 'Reference context';
    const referenceBody = document.createElement('div');
    referenceBody.style.fontSize = '12px';
    referenceBody.style.lineHeight = '1.4';
    if (referenceSnippet) {
      if (referenceSnippet.before) {
        const before = document.createElement('span');
        before.textContent = `${referenceSnippet.before} `;
        referenceBody.appendChild(before);
      }
      if (referenceSnippet.suppressHighlight) {
        const plain = document.createElement('span');
        plain.textContent = referenceSnippet.match || 'Frontmatter reference';
        referenceBody.appendChild(plain);
      } else {
        const highlight = document.createElement('mark');
        highlight.textContent = referenceSnippet.match;
        referenceBody.appendChild(highlight);
      }
      if (referenceSnippet.after) {
        const after = document.createElement('span');
        after.textContent = ` ${referenceSnippet.after}`;
        referenceBody.appendChild(after);
      }
    } else {
      referenceBody.style.opacity = '0.75';
      referenceBody.textContent = 'No direct inline reference found.';
    }
    referenceWrap.appendChild(referenceLabel);
    referenceWrap.appendChild(referenceBody);
    this.topLinkPreviewEl.appendChild(title);
    this.topLinkPreviewEl.appendChild(subtitle);
    this.topLinkPreviewEl.appendChild(body);
    this.topLinkPreviewEl.appendChild(referenceWrap);

    const rect = targetEl.getBoundingClientRect();
    const cardWidth = 420;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - cardWidth - 12));
    const top = Math.min(window.innerHeight - 120, rect.bottom + 8);
    this.topLinkPreviewEl.style.left = `${left}px`;
    this.topLinkPreviewEl.style.top = `${top}px`;
    this.topLinkPreviewEl.style.display = 'block';
  }

  private scheduleHideTopLinkPreviewCard(delayMs: number): void {
    if (this.topLinkPreviewHideTimer !== null) {
      window.clearTimeout(this.topLinkPreviewHideTimer);
    }
    this.topLinkPreviewHideTimer = window.setTimeout(() => {
      this.hideTopLinkPreviewCard();
    }, Math.max(0, delayMs));
  }

  private hideTopLinkPreviewCard(): void {
    if (this.topLinkPreviewHideTimer !== null) {
      window.clearTimeout(this.topLinkPreviewHideTimer);
      this.topLinkPreviewHideTimer = null;
    }
    if (this.topLinkPreviewEl) {
      this.topLinkPreviewEl.style.display = 'none';
    }
  }

  private toggleTopLinksPopover(anchorEl: HTMLElement, sourceFile: TFile, outgoing: TFile[], incoming: TFile[]): void {
    const existingSourcePath = this.topLinksPopoverEl?.dataset.sourcePath || '';
    if (this.topLinksPopoverEl && existingSourcePath === sourceFile.path) {
      this.hideTopLinksPopover();
      return;
    }

    this.hideTopLinksPopover();

    const popover = document.createElement('div');
    popover.className = 'tps-gcm-top-links-popover';
    popover.dataset.sourcePath = sourceFile.path;
    popover.style.position = 'fixed';
    popover.style.zIndex = '100000';
    popover.style.minWidth = '320px';
    popover.style.maxWidth = '560px';
    popover.style.maxHeight = '60vh';
    popover.style.overflowY = 'auto';
    popover.style.borderRadius = '12px';
    popover.style.border = '1px solid var(--background-modifier-border)';
    popover.style.background = 'var(--background-primary)';
    popover.style.boxShadow = '0 16px 32px rgba(0,0,0,0.35)';
    popover.style.padding = '8px';

    const appendSection = (title: string, files: TFile[], direction: 'outgoing' | 'incoming') => {
      if (files.length === 0) return;
      const header = document.createElement('div');
      header.style.fontSize = '12px';
      header.style.opacity = '0.75';
      header.style.padding = '6px 8px';
      header.textContent = `${title} (${files.length})`;
      popover.appendChild(header);

      const directRows: TFile[] = [];
      const groupedByFrontmatter = new Map<string, TFile[]>();
      for (const linkedFile of files) {
        const frontmatterKey = direction === 'outgoing'
          ? this.getFrontmatterLinkLabel(sourceFile, linkedFile)
          : this.getFrontmatterLinkLabel(linkedFile, sourceFile);
        if (!frontmatterKey) {
          directRows.push(linkedFile);
          continue;
        }
        const existing = groupedByFrontmatter.get(frontmatterKey) || [];
        existing.push(linkedFile);
        groupedByFrontmatter.set(frontmatterKey, existing);
      }

      for (const linkedFile of directRows) {
        this.renderTopLinkPopoverRow(popover, linkedFile, sourceFile, direction, null);
      }

      const sortedFrontmatterKeys = Array.from(groupedByFrontmatter.keys())
        .sort((a, b) => a.localeCompare(b));
      for (const key of sortedFrontmatterKeys) {
        const linkedFiles = groupedByFrontmatter.get(key) || [];
        if (linkedFiles.length === 0) continue;
        const fmHeader = document.createElement('div');
        fmHeader.style.fontSize = '11px';
        fmHeader.style.opacity = '0.7';
        fmHeader.style.padding = '8px 10px 4px 10px';
        fmHeader.textContent = `${key} (${linkedFiles.length})`;
        popover.appendChild(fmHeader);
        for (const linkedFile of linkedFiles) {
          this.renderTopLinkPopoverRow(popover, linkedFile, sourceFile, direction, key);
        }
      }
    };

    appendSection('Outgoing mentions', outgoing, 'outgoing');
    if (outgoing.length > 0 && incoming.length > 0) {
      const separator = document.createElement('div');
      separator.style.height = '1px';
      separator.style.margin = '6px 4px';
      separator.style.background = 'var(--background-modifier-border)';
      popover.appendChild(separator);
    }
    appendSection('Incoming mentions', incoming, 'incoming');

    document.body.appendChild(popover);
    this.topLinksPopoverEl = popover;

    const rect = anchorEl.getBoundingClientRect();
    const width = Math.min(560, Math.max(320, rect.width + 260));
    popover.style.width = `${width}px`;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const top = Math.min(window.innerHeight - 24, rect.bottom + 8);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;

    this.topLinksPopoverOutsideHandler = (evt: MouseEvent) => {
      const target = evt.target as Node | null;
      if (!target) return;
      if (popover.contains(target)) return;
      if (anchorEl.contains(target)) return;
      this.hideTopLinksPopover();
    };
    window.setTimeout(() => {
      if (this.topLinksPopoverOutsideHandler) {
        document.addEventListener('mousedown', this.topLinksPopoverOutsideHandler, true);
      }
    }, 0);
  }

  private hideTopLinksPopover(): void {
    if (this.topLinksPopoverOutsideHandler) {
      document.removeEventListener('mousedown', this.topLinksPopoverOutsideHandler, true);
      this.topLinksPopoverOutsideHandler = null;
    }
    if (this.topLinksPopoverEl) {
      this.topLinksPopoverEl.remove();
      this.topLinksPopoverEl = null;
    }
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
    const relationshipPaths = this.getParentChildRelationshipPaths(file, parentFiles);
    const embeddedTargets = this.getEmbeddedMarkdownTargetPaths(file);
    const promotedChecklistTargets = this.plugin.settings.ignoreEmbeddedChildrenInTopLinks
      ? this.getPromotedChecklistLinkedTargetPaths(file)
      : null;

    const { incoming: rawIncoming, outgoing: rawOutgoing } = this.getDirectLinks(file);
    const incoming = rawIncoming.filter((linkFile) => !relationshipPaths.has(linkFile.path));
    const outgoing = rawOutgoing.filter((linkFile) => {
      if (relationshipPaths.has(linkFile.path)) return false;
      if (embeddedTargets?.has(linkFile.path)) return false;
      if (promotedChecklistTargets?.has(linkFile.path)) return false;
      return true;
    });
    const totalLinks = incoming.length + outgoing.length;
    const showParentButton = parentFiles.length > 0;

    if (totalLinks === 0 && !showParentButton) {
      this.removeTopParentNav(view);
      return;
    }

    this.removeTopParentNav(view);

    const container = document.createElement('div');
    container.className = 'tps-gcm-top-parent-nav';
    container.dataset.filePath = file.path;

    if (totalLinks > 0) {
      const linksButton = document.createElement('button');
      linksButton.type = 'button';
      linksButton.className = 'tps-gcm-parent-nav-button tps-gcm-parent-nav-button--top';
      linksButton.title = 'View mentions';
      setIcon(linksButton, 'link');

      const linksLabel = document.createElement('span');
      linksLabel.className = 'tps-gcm-parent-nav-label';
      linksLabel.textContent = totalLinks === 1 ? '1 Mention' : `${totalLinks} Mentions`;
      linksButton.appendChild(linksLabel);

      addSafeClickListener(linksButton, () => {
        const latestParents = this.resolveParentFiles(file);
        const latestRelationshipPaths = this.getParentChildRelationshipPaths(file, latestParents);
        const latestEmbeddedTargets = this.getEmbeddedMarkdownTargetPaths(file);
        const latestPromotedChecklistTargets = this.plugin.settings.ignoreEmbeddedChildrenInTopLinks
          ? this.getPromotedChecklistLinkedTargetPaths(file)
          : null;
        const { incoming: refreshedIncoming, outgoing: refreshedOutgoing } = this.getDirectLinks(file);
        const currentIncoming = refreshedIncoming.filter((linkFile) => !latestRelationshipPaths.has(linkFile.path));
        const currentOutgoing = refreshedOutgoing.filter((linkFile) => {
          if (latestRelationshipPaths.has(linkFile.path)) return false;
          if (latestEmbeddedTargets?.has(linkFile.path)) return false;
          if (latestPromotedChecklistTargets?.has(linkFile.path)) return false;
          return true;
        });
        this.toggleTopLinksPopover(linksButton, file, currentOutgoing, currentIncoming);
      });

      container.appendChild(linksButton);
    }

    if (showParentButton) {
      const parentButton = document.createElement('button');
      parentButton.type = 'button';
      parentButton.className = 'tps-gcm-parent-nav-button tps-gcm-parent-nav-button--top';
      parentButton.title = parentFiles.length === 1 ? 'Go to parent' : 'Select parent';
      setIcon(parentButton, 'arrow-up');

      const parentLabel = document.createElement('span');
      parentLabel.className = 'tps-gcm-parent-nav-label';
      parentLabel.textContent = parentFiles.length === 1 ? 'Parent' : `${parentFiles.length} Parents`;
      parentButton.appendChild(parentLabel);

      addSafeClickListener(parentButton, () => {
        if (parentFiles.length === 1) {
          void this.plugin.openFileInLeaf(parentFiles[0], false, () => this.plugin.app.workspace.getLeaf(false), {
            revealLeaf: true,
            ignoreCanvasDragGuard: true,
          });
          return;
        }
        const menu = new Menu();
        for (const parentFile of parentFiles) {
          menu.addItem((item) => {
            item
              .setTitle(this.getFileDisplayTitle(parentFile))
              .setIcon('file-text')
              .onClick(() => {
                void this.plugin.openFileInLeaf(parentFile, false, () => this.plugin.app.workspace.getLeaf(false), {
                  revealLeaf: true,
                  ignoreCanvasDragGuard: true,
                });
              });
          });
        }
        const rect = parentButton.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom });
      });

      container.appendChild(parentButton);
    }

    titleEl.parentElement?.insertBefore(container, titleEl);
    this.topParentNavs.set(view, container);
  }

  private removeTopParentNav(view: MarkdownView): void {
    this.hideTopLinkPreviewCard();
    this.hideTopLinksPopover();
    const navEl = this.topParentNavs.get(view);
    if (navEl) {
      navEl.remove();
      this.topParentNavs.delete(view);
    }
    // Clean up any remaining ones just in case
    const titleEl = this.resolveInlineTitleElement(view);
    titleEl?.parentElement?.querySelectorAll('.tps-gcm-top-parent-nav').forEach(node => node.remove());
  }

  private getParentChildRelationshipPaths(file: TFile, knownParents?: TFile[]): Set<string> {
    const relationshipPaths = new Set<string>();
    const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'childOf').trim() || 'childOf';
    const childKey = String(this.plugin.settings.childLinkFrontmatterKey || 'parentOf').trim() || 'parentOf';

    const parentFiles = knownParents ?? this.resolveParentFiles(file);
    for (const parentFile of parentFiles) {
      relationshipPaths.add(parentFile.path);
    }

    const ownFrontmatter = (this.plugin.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
    const ownChildrenRaw = this.getFrontmatterValueCaseInsensitive(ownFrontmatter, childKey);
    for (const linkedChild of this.extractLinkedFilesFromFrontmatterValue(ownChildrenRaw, file.path)) {
      relationshipPaths.add(linkedChild.path);
    }

    // Include reverse-only relationships if one direction is missing.
    for (const candidate of this.plugin.app.vault.getMarkdownFiles()) {
      if (candidate.path === file.path) continue;
      const candidateFrontmatter = (this.plugin.app.metadataCache.getFileCache(candidate)?.frontmatter || {}) as Record<string, any>;

      const candidateParentsRaw = this.getFrontmatterValueCaseInsensitive(candidateFrontmatter, parentKey);
      const candidateParents = this.extractLinkedFilesFromFrontmatterValue(candidateParentsRaw, candidate.path);
      if (candidateParents.some((linkedFile) => linkedFile.path === file.path)) {
        relationshipPaths.add(candidate.path);
      }

      const candidateChildrenRaw = this.getFrontmatterValueCaseInsensitive(candidateFrontmatter, childKey);
      const candidateChildren = this.extractLinkedFilesFromFrontmatterValue(candidateChildrenRaw, candidate.path);
      if (candidateChildren.some((linkedFile) => linkedFile.path === file.path)) {
        relationshipPaths.add(candidate.path);
      }
    }

    return relationshipPaths;
  }

  private getEmbeddedMarkdownTargetPaths(file: TFile): Set<string> {
    const result = new Set<string>();
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const embeds = cache?.embeds || [];
    for (const embed of embeds) {
      const linkPath = String((embed as any)?.link || '').trim();
      if (!linkPath) continue;
      const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
      if (resolved instanceof TFile && resolved.extension?.toLowerCase() === 'md') {
        result.add(resolved.path);
      }
    }
    return result;
  }

  private getPromotedChecklistLinkedTargetPaths(file: TFile): Set<string> {
    const result = new Set<string>();
    const cache = this.plugin.app.metadataCache.getFileCache(file) as any;
    const links = Array.isArray(cache?.links) ? cache.links : [];
    const listItems = Array.isArray(cache?.listItems) ? cache.listItems : [];
    if (links.length === 0 || listItems.length === 0) return result;

    const completedChecklistLines = new Set<number>();
    for (const item of listItems) {
      const line = Number(item?.position?.start?.line);
      const taskState = String(item?.task ?? '');
      if (!Number.isFinite(line)) continue;
      if (this.isResolvedChecklistTaskState(taskState)) {
        completedChecklistLines.add(line);
      }
    }

    if (completedChecklistLines.size === 0) return result;

    for (const link of links) {
      const line = Number(link?.position?.start?.line);
      if (!Number.isFinite(line) || !completedChecklistLines.has(line)) continue;
      const linkPath = String(link?.link || '').trim();
      if (!linkPath) continue;
      const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
      if (resolved instanceof TFile && resolved.extension?.toLowerCase() === 'md') {
        result.add(resolved.path);
      }
    }

    return result;
  }

  private isResolvedChecklistTaskState(taskState: string): boolean {
    const normalized = String(taskState ?? '').trim().toLowerCase();
    return normalized.length > 0 && normalized !== ' ';
  }

  private extractLinkedFilesFromFrontmatterValue(value: any, sourcePath: string): TFile[] {
    const results = new Map<string, TFile>();
    const visitedObjects = new Set<any>();

    const addCandidate = (candidate: string): void => {
      const resolved = this.resolveParentValueToFile(candidate, sourcePath);
      if (resolved) {
        results.set(resolved.path, resolved);
      }
    };

    const visit = (current: any): void => {
      if (current === null || current === undefined) return;
      if (Array.isArray(current)) {
        if (visitedObjects.has(current)) return;
        visitedObjects.add(current);
        current.forEach((entry) => visit(entry));
        return;
      }
      if (typeof current === 'object') {
        if (visitedObjects.has(current)) return;
        visitedObjects.add(current);
        Object.values(current).forEach((entry) => visit(entry));
        return;
      }

      const raw = String(current).trim();
      if (!raw) return;

      let matchedStructuredLink = false;
      const wikiMatches = raw.matchAll(/\[\[([^\]]+)\]\]/g);
      for (const match of wikiMatches) {
        matchedStructuredLink = true;
        addCandidate(match[1]);
      }

      const markdownMatches = raw.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
      for (const match of markdownMatches) {
        matchedStructuredLink = true;
        addCandidate(match[1]);
      }

      if (!matchedStructuredLink) {
        addCandidate(raw);
      }
    };

    visit(value);
    return Array.from(results.values());
  }

  private resolveParentFiles(file: TFile): TFile[] {
    const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'childOf').trim() || 'childOf';
    const childKey = String(this.plugin.settings.childLinkFrontmatterKey || 'parentOf').trim() || 'parentOf';
    const parentFiles = new Map<string, TFile>();

    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter || {}) as Record<string, any>;
    const raw = this.getFrontmatterValueCaseInsensitive(fm, parentKey);
    const values = Array.isArray(raw) ? raw : (raw === undefined || raw === null ? [] : [raw]);

    for (const val of values) {
      const parentFile = this.resolveParentValueToFile(val, file.path);
      if (parentFile && parentFile.path !== file.path) {
        parentFiles.set(parentFile.path, parentFile);
      }
    }

    // Reverse-only link support: parent note defines this note in its child key.
    for (const candidate of this.plugin.app.vault.getMarkdownFiles()) {
      if (candidate.path === file.path) continue;
      const candidateFrontmatter = (this.plugin.app.metadataCache.getFileCache(candidate)?.frontmatter || {}) as Record<string, any>;
      const childRaw = this.getFrontmatterValueCaseInsensitive(candidateFrontmatter, childKey);
      const children = this.extractLinkedFilesFromFrontmatterValue(childRaw, candidate.path);
      if (children.some((linkedFile) => linkedFile.path === file.path)) {
        parentFiles.set(candidate.path, candidate);
      }
    }

    return Array.from(parentFiles.values());
  }

  private resolveParentValueToFile(value: any, sourcePath: string): TFile | null {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const candidates = this.extractParentLinkCandidates(raw);
    for (const candidate of candidates) {
      const cleaned = this.normalizeParentLinkTarget(candidate);
      if (!cleaned || this.isLikelyExternalParentLink(cleaned)) continue;

      const dest = this.plugin.app.metadataCache.getFirstLinkpathDest(cleaned, sourcePath);
      if (dest instanceof TFile) return dest;

      const normalizedPath = normalizePath(cleaned);
      const file = this.plugin.app.vault.getAbstractFileByPath(normalizedPath);
      if (file instanceof TFile) return file;

      const withMd = normalizedPath.endsWith('.md') ? normalizedPath : `${normalizedPath}.md`;
      const fileWithMd = this.plugin.app.vault.getAbstractFileByPath(withMd);
      if (fileWithMd instanceof TFile) return fileWithMd;
    }

    return null;
  }

  private extractParentLinkCandidates(rawValue: string): string[] {
    const raw = String(rawValue || '').trim();
    if (!raw) return [];

    const candidates: string[] = [];
    const seen = new Set<string>();
    const push = (candidate: string) => {
      const value = String(candidate || '').trim();
      if (!value) return;
      const key = value.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(value);
    };

    const variants = [raw];
    try {
      const decoded = decodeURIComponent(raw);
      if (decoded && decoded !== raw) variants.push(decoded);
    } catch {
      // ignore invalid URI sequences
    }

    for (const value of variants) {
      let matchedStructuredLink = false;
      const wikiMatches = value.matchAll(/\[\[([^\]]+)\]\]/g);
      for (const match of wikiMatches) {
        matchedStructuredLink = true;
        if (match[1]) push(match[1]);
      }

      const markdownMatches = value.matchAll(/\[[^\]]*]\(([^)]+)\)/g);
      for (const match of markdownMatches) {
        matchedStructuredLink = true;
        if (match[1]) push(match[1]);
      }

      if (!matchedStructuredLink) {
        push(value);
      }
    }

    return candidates;
  }

  private normalizeParentLinkTarget(rawTarget: string): string {
    let target = String(rawTarget || '').trim();
    if (!target) return '';

    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1).trim();
    }
    target = target.replace(/^!/, '').trim();
    target = target.replace(/^['"]|['"]$/g, '').trim();

    const pipeIndex = target.indexOf('|');
    if (pipeIndex >= 0) target = target.slice(0, pipeIndex).trim();
    const hashIndex = target.indexOf('#');
    if (hashIndex >= 0) target = target.slice(0, hashIndex).trim();

    try {
      target = decodeURIComponent(target);
    } catch {
      // ignore invalid URI sequences
    }

    return target.trim();
  }

  private isLikelyExternalParentLink(value: string): boolean {
    return /^(https?:|mailto:|tel:|file:|data:)/i.test(String(value || '').trim());
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
    const hasCollapsedEntry = this.collapsedStateByPath.has(path);
    const wasCollapsed = this.collapsedStateByPath.get(path) ?? false;

    this.removeInlineSubitemsPanel(view);

    try {
      const panel = this.plugin.menuController.createSubitemsPanel(file);
      // We use the --live class ONLY if standard body attachment is needed (fallback)
      // If attaching to menu container, we omit it to let flexbox handle flow
      panel.addClass('tps-gcm-subitems-panel--title-inline');
      if (wasCollapsed) panel.addClass('tps-gcm-subitems-panel--collapsed');

      // Mark for auto-collapse detection on second content render (first open of this file)
      if (!hasCollapsedEntry && (this.plugin.settings.subitemsPanelAutoCollapse ?? true)) {
        panel.dataset.autoCollapse = 'pending';
      }

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
        // Position panel above or below the inline menu based on setting
        const panelPosition = this.plugin.settings.subitemsPanelPosition ?? 'below';
        if (panelPosition === 'above') {
          panel.style.order = '-1';
          panel.style.marginBottom = 'var(--tps-gcm-subitems-margin-bottom)';
          panel.style.marginTop = '';
        } else {
          panel.style.order = '1';
          panel.style.marginTop = 'var(--tps-gcm-subitems-margin-bottom)';
          panel.style.marginBottom = '';
        }
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
    const mode = getViewMode(view);
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
    const keyboardHidden =
      this.keyboardVisible &&
      Platform.isMobile &&
      (this.plugin.settings.suppressMobileKeyboard ?? true);
    menuEl.classList.toggle('tps-gcm-gesture-collapsed', this.swipeCollapsed);
    menuEl.classList.toggle('tps-gcm-menu--keyboard-hidden', keyboardHidden);

    // Also set inline styles for collapsed/keyboard-hidden state to ensure consistency
    if (this.swipeCollapsed || keyboardHidden) {
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

    const state = { scroller, lastTop: scroller.scrollTop, accum: 0, listener: () => { } };

    state.listener = () => {
      if (this.keyboardVisible) return;

      const top = scroller.scrollTop;
      const delta = top - state.lastTop;
      state.lastTop = top;

      // Direction changed â€” reset accumulator.
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
    const mode = getViewMode(view);
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

  private ensureNoteReferencesPanel(view: MarkdownView): void {
    const s = this.plugin.settings;
    if (!this.shouldRenderInlineNotePanels(view) || (!s.showReferencesInSubitemsPanel && !s.showMentionsInSubitemsPanel)) {
      this.removeNoteReferencesPanel(view);
      return;
    }

    const file = view.file;
    if (!(file instanceof TFile) || file.extension?.toLowerCase() !== 'md') {
      this.removeNoteReferencesPanel(view);
      return;
    }

    const parent = this.resolveNoteFooterParent(view);
    if (!parent) {
      logger.debug('[TPS GCM] Inline references: no footer parent found', {
        file: file.path,
        mode: getViewMode(view),
      });
      this.removeNoteReferencesPanel(view);
      return;
    }

    parent.querySelectorAll('.tps-gcm-note-references').forEach((node) => {
      if (node !== this.noteReferencesPanels.get(view)) {
        node.remove();
      }
    });

    const tracked = this.noteReferencesPanels.get(view) || null;
    if (tracked && tracked.isConnected && tracked.parentElement === parent && tracked.dataset.filePath === file.path) {
      this.syncInlineNotePanelLayout(view);
      void this.plugin.menuController.getPanelBuilder().refreshNoteReferencesPanel(file, tracked.querySelector('.tps-gcm-note-references-body') as HTMLElement);
      return;
    }

    this.removeNoteReferencesPanel(view);

    // CRITICAL: `removeNoteReferencesPanel` removes the empty footer-host from the DOM!
    // We must re-resolve the parent so we don't append to a detached node.
    const finalParent = this.resolveNoteFooterParent(view);
    if (!finalParent) return;

    const panel = this.plugin.menuController.createNoteReferencesPanel(file);
    panel.dataset.filePath = file.path;
    finalParent.appendChild(panel);
    this.noteReferencesPanels.set(view, panel);
    logger.debug('[TPS GCM] Inline references mounted', {
      file: file.path,
      mode: getViewMode(view),
      parentClass: finalParent.className,
    });
    this.syncInlineNotePanelLayout(view);

    // Now that it's connected to the live DOM, force a refresh. 
    // This bypasses the `!body.isConnected` abort check inside refreshNoteReferencesPanel
    const bodyObj = panel.querySelector('.tps-gcm-note-references-body') as HTMLElement | null;
    if (bodyObj) {
      void this.plugin.menuController.getPanelBuilder().refreshNoteReferencesPanel(file, bodyObj);
    }
  }

  private removeNoteReferencesPanel(view: MarkdownView): void {
    const panel = this.noteReferencesPanels.get(view);
    if (panel) {
      panel.remove();
      this.noteReferencesPanels.delete(view);
    }

    const parent = this.resolveNoteFooterParent(view);
    parent?.querySelectorAll('.tps-gcm-note-references').forEach((node) => node.remove());
    if (parent instanceof HTMLElement && parent.classList.contains('tps-gcm-note-footer-host') && !parent.children.length) {
      parent.remove();
    }
    view.contentEl?.querySelectorAll('.tps-gcm-note-footer-host').forEach((node) => {
      if (node instanceof HTMLElement && !node.children.length) {
        node.remove();
      }
    });
  }

  private ensureNoteGraphPanel(view: MarkdownView): void {
    if (!this.shouldRenderInlineNotePanels(view) || !this.plugin.settings.showInlineNoteGraph) {
      this.removeNoteGraphPanel(view);
      return;
    }

    const file = view.file;
    if (!(file instanceof TFile) || file.extension?.toLowerCase() !== 'md') {
      this.removeNoteGraphPanel(view);
      return;
    }

    const parent = this.resolveNoteGraphHost(view);
    if (!parent) {
      this.removeNoteGraphPanel(view);
      return;
    }

    view.contentEl?.querySelectorAll('.tps-gcm-note-graph').forEach((node) => {
      if (node !== this.noteGraphPanels.get(view)) {
        node.remove();
      }
    });
    view.contentEl?.querySelectorAll('.tps-gcm-note-graph-host').forEach((node) => {
      if (node !== parent) {
        node.classList.remove('tps-gcm-note-graph-host');
      }
    });

    parent.classList.add('tps-gcm-note-graph-host');

    const tracked = this.noteGraphPanels.get(view) || null;
    if (tracked && tracked.isConnected && tracked.parentElement === parent && tracked.dataset.filePath === file.path) {
      this.positionNoteGraphPanel(view, tracked, parent);
      this.syncInlineNotePanelLayout(view);
      void this.plugin.menuController.getPanelBuilder().refreshNoteGraphPanel(file, tracked.querySelector('.tps-gcm-note-graph-body') as HTMLElement);
      return;
    }

    this.removeNoteGraphPanel(view);

    const panel = this.plugin.menuController.createNoteGraphPanel(file);
    panel.dataset.filePath = file.path;
    parent.appendChild(panel);
    this.noteGraphPanels.set(view, panel);
    this.positionNoteGraphPanel(view, panel, parent);
    this.syncInlineNotePanelLayout(view);
  }

  private removeNoteGraphPanel(view: MarkdownView): void {
    const panel = this.noteGraphPanels.get(view);
    if (panel) {
      panel.remove();
      this.noteGraphPanels.delete(view);
    }

    this.resolveNoteGraphHost(view)?.classList.remove('tps-gcm-note-graph-host');
    view.contentEl?.querySelectorAll('.tps-gcm-note-graph').forEach((node) => node.remove());
    this.syncInlineNotePanelLayout(view);
  }

  private syncInlineNotePanelLayout(view: MarkdownView): void {
    window.requestAnimationFrame(() => {
      const referencesPanel = this.noteReferencesPanels.get(view);
      if (!referencesPanel?.isConnected) return;

      referencesPanel.style.removeProperty('margin-top');
      referencesPanel.style.removeProperty('margin-right');
      referencesPanel.style.removeProperty('max-width');

      const mode = getViewMode(view);
      if (mode === 'source') {
        const sourceView = view.contentEl?.querySelector<HTMLElement>('.markdown-source-view');
        const cmContent = sourceView?.querySelector<HTMLElement>('.cm-content') || null;
        if (!cmContent || !cmContent.contains(referencesPanel)) return;

        const lines = Array.from(cmContent.querySelectorAll<HTMLElement>(':scope > .cm-line'));
        const lastLine =
          [...lines].reverse().find((line) => (line.textContent || '').trim().length > 0) ||
          lines[lines.length - 1] ||
          null;
        if (!lastLine) return;

        const contentRect = cmContent.getBoundingClientRect();
        const lastLineRect = lastLine.getBoundingClientRect();
        const trailingSlack = Math.max(0, Math.round(contentRect.bottom - lastLineRect.bottom));
        const targetGap = 50;
        const adjusted = Math.max(-600, Math.min(120, targetGap - trailingSlack));
        referencesPanel.style.marginTop = `${adjusted}px`;
      }
    });
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
    if (instances?.reading) {
      instances.reading.remove();
      instances.reading = null;
    }
    view.contentEl
      ?.querySelectorAll<HTMLElement>('.tps-global-context-menu--persistent.tps-global-context-menu--reading')
      .forEach((el) => el.remove());

    if (!instances?.live) {
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
    this.detachLiveHeightObserver(view);
    if (instances?.live) {
      instances.live.remove();
      instances.live = null;
    }
    view.contentEl
      ?.querySelectorAll<HTMLElement>('.tps-global-context-menu--persistent.tps-global-context-menu--live')
      .forEach((el) => el.remove());

    if (!instances?.reading) {
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
    this.removeNoteReferencesPanel(view);
    this.removeNoteGraphPanel(view);
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
    if (!force && lastEdit && quietMs && Date.now() - lastEdit < quietMs) {
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
          this.removeNoteReferencesPanel(view);
          this.removeNoteGraphPanel(view);
        }
        this.ensureInlineSubitemsPanel(view);
        this.ensureNoteGraphPanel(view);
        this.ensureNoteReferencesPanel(view);
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
    for (const view of Array.from(this.noteReferencesPanels.keys())) {
      this.removeNoteReferencesPanel(view);
    }
    for (const view of Array.from(this.noteGraphPanels.keys())) {
      this.removeNoteGraphPanel(view);
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
