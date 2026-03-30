import { MarkdownView, Menu, Notice, TFile, setIcon } from 'obsidian';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type TPSGlobalContextMenuPlugin from '../main';
import * as logger from '../logger';
import { resolveCustomProperties } from '../resolve-profiles';
import { getViewMode } from './leaf-resolver';
import { resolveLinkTargetToFile } from './link-target-service';
import { ViewModeService } from './view-mode-service';
import type { BodySubitemLink } from './subitem-types';
import { SubitemLineModelService, type SubitemLineModel, type PropertyPill } from './subitem-line-model';
import { buildLinkedSubitemRow, getIconNameForState } from './linked-subitem-row-builder';

const VIRTUAL_CHECKBOX_CLASS = 'tps-gcm-linked-subitem-checkbox';
const CM_WIDGET_CLASS = 'tps-gcm-linked-subitem-cm-widget';
const DECORATION_VERSION = '2';
const refreshLinkedSubitemEffect = StateEffect.define<number>();

/**
 * Live Preview widget for a linked subitem.
 * It replaces only the wikilink token, leaving the native list marker and
 * checkbox intact.
 */
class LinkedSubitemRowWidget extends WidgetType {
  private readonly onClick: (path: string) => void;
  private readonly onPillClick: (evt: MouseEvent, pill: PropertyPill) => void;
  
  constructor(
    private readonly model: SubitemLineModel,
    private readonly onCheckboxClick: (evt: MouseEvent) => void,
    onLinkClick: (path: string) => void,
    onPillClick: (evt: MouseEvent, pill: PropertyPill) => void,
  ) {
    super();
    this.onClick = onLinkClick;
    this.onPillClick = onPillClick;
  }

  eq(other: LinkedSubitemRowWidget): boolean {
    return (
      other.model.childFile.path === this.model.childFile.path &&
      other.model.parentFile.path === this.model.parentFile.path &&
      other.model.checkboxState === this.model.checkboxState &&
      other.model.visualState === this.model.visualState &&
      JSON.stringify(other.model.pills) === JSON.stringify(this.model.pills)
    );
  }

  toDOM(): HTMLElement {
    const elements = buildLinkedSubitemRow(
      this.model,
      this.onCheckboxClick,
      this.onClick,
      this.onPillClick,
      { includeCheckbox: this.model.kind !== 'checkbox' },
    );
    elements.container.classList.add(CM_WIDGET_CLASS, 'is-cm-widget');
    return elements.container;
  }

  updateDOM(dom: HTMLElement): boolean {
    // Check if this is still the same subitem
    if (dom.dataset.linkedSubitemPath !== this.model.childFile.path) return false;
    
    // Update checkbox state if changed
    const checkbox = dom.querySelector(`.${VIRTUAL_CHECKBOX_CLASS}`) as HTMLElement | null;
    if (checkbox && checkbox.dataset.linkedSubitemState !== this.model.checkboxState) {
      checkbox.dataset.linkedSubitemState = this.model.checkboxState || '[ ]';
      checkbox.className = `${VIRTUAL_CHECKBOX_CLASS} state-${this.model.visualState}`;
      checkbox.innerHTML = '';
      setIcon(checkbox, getIconNameForState(this.model.checkboxState || '[ ]'));
    }
    
    return true;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class LinkedSubitemSpacerWidget extends WidgetType {
  toDOM(): HTMLElement {
    const spacer = document.createElement('span');
    spacer.className = 'tps-gcm-linked-subitem-caret-spacer';
    spacer.setAttribute('aria-hidden', 'true');
    spacer.textContent = '\u00a0';
    return spacer;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class LinkedSubitemCheckboxService {
  private observers = new Map<MarkdownView, MutationObserver>();
  private refreshTimers = new Map<MarkdownView, number>();
  private syncingFiles = new Set<string>();
  private decoratingViews = new WeakSet<MarkdownView>();
  private elementStates = new WeakMap<HTMLElement, string>();
  // NOTE: Removed lastSuccessfulEditorDecorations cache - it was preserving stale decorations
  // with invalid positions after document changes, causing RangeError runtime errors.
  private editorExtension = this.createEditorExtension();
  private subitemLineModelService: SubitemLineModelService;

  constructor(private plugin: TPSGlobalContextMenuPlugin) {
    this.subitemLineModelService = new SubitemLineModelService(plugin);
  }

  getEditorExtension() {
    return this.editorExtension;
  }

  ensureForAllMarkdownViews(): void {
    const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const liveViews = new Set<MarkdownView>();

    document.body.dataset.tpsGcmLinkedSubitemStyle = this.plugin.settings.linkedSubitemCheckboxStyle || 'soft-link';

    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      liveViews.add(view);
      if (view === activeView) {
        this.ensureForView(view);
      } else {
        this.removeForView(view);
      }
    }

    for (const view of Array.from(this.observers.keys())) {
      if (!liveViews.has(view)) this.removeForView(view);
    }
  }

  ensureForView(view: MarkdownView): void {
    const file = view.file;
    if (!(file instanceof TFile) || file.extension !== 'md' || !this.plugin.settings.enableLinkedSubitemCheckboxes) {
      this.removeForView(view);
      return;
    }

    const mode = this.getLinkedSubitemRenderMode(view);

    if (mode !== 'preview') {
      const observer = this.observers.get(view);
      if (observer) {
        observer.disconnect();
        this.observers.delete(view);
      }
      this.clearDecorations(view);
      return;
    }

    if (!this.observers.has(view)) {
      const root = view.contentEl;
      if (root) {
        const observer = new MutationObserver(() => {
          if (this.decoratingViews.has(view)) return;
          this.scheduleDecorate(view);
        });
        observer.observe(root, { childList: true, subtree: true });
        this.observers.set(view, observer);
      }
    }

    this.scheduleDecorate(view);
  }

  removeForView(view: MarkdownView): void {
    const observer = this.observers.get(view);
    if (observer) {
      observer.disconnect();
      this.observers.delete(view);
    }
    const timer = this.refreshTimers.get(view);
    if (timer != null) {
      window.clearTimeout(timer);
      this.refreshTimers.delete(view);
    }
    this.clearDecorations(view);
  }

  detach(): void {
    for (const view of Array.from(this.observers.keys())) {
      this.removeForView(view);
    }
  }

  async handleClick(evt: MouseEvent): Promise<boolean> {
    if (!this.plugin.settings.enableLinkedSubitemCheckboxes) return false;
    const targetEl = evt.target instanceof HTMLElement ? evt.target : null;
    const pillEl = targetEl?.closest('.tps-gcm-linked-subitem-pill') as HTMLElement | null;
    if (pillEl) {
      return this.handlePropertyPillClick(evt, pillEl);
    }
    
    const customCheckboxEl = targetEl?.closest(`.${VIRTUAL_CHECKBOX_CLASS}`) as HTMLElement | null;
    if (customCheckboxEl) {
      return this.handleCustomCheckboxClick(evt, customCheckboxEl);
    }
    
    const nativeCheckboxEl = targetEl?.closest('input.task-list-item-checkbox') as HTMLInputElement | null;
    if (nativeCheckboxEl) {
      const taskHost = nativeCheckboxEl.closest('.tps-gcm-linked-subitem-task');
      if (taskHost instanceof HTMLElement) {
        return this.handleNativeCheckboxInSubitemLine(evt, nativeCheckboxEl, taskHost);
      }
    }
    
    return false;
  }

  private async handleCustomCheckboxClick(evt: MouseEvent, checkboxEl: HTMLElement): Promise<boolean> {
    const childPath = checkboxEl.dataset.linkedSubitemPath;
    const parentPath = checkboxEl.dataset.linkedSubitemParent;
    if (!childPath || !parentPath) return false;

    const childFile = this.plugin.app.vault.getFileByPath(childPath);
    const parentFile = this.plugin.app.vault.getFileByPath(parentPath);
    if (!(childFile instanceof TFile) || !(parentFile instanceof TFile)) return false;

    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();

    const currentStatus = this.getNormalizedStatus(childFile);
    const currentState = this.mapStatusToCheckboxState(currentStatus);
    const nextStatus = this.getToggleTargetForState(currentState, currentStatus);
    if (!nextStatus) return false;

    const statusKey = this.getStatusKey();
    await this.plugin.app.fileManager.processFrontMatter(childFile, (fm) => {
      fm[statusKey] = nextStatus;
    });

    await this.refreshReferencesForChild(childFile);
    this.scheduleDecorateForActiveView();
    this.refreshLivePreviewEditors();
    new Notice(`Set "${childFile.basename}" to ${nextStatus}.`);
    return true;
  }

  private async handleNativeCheckboxInSubitemLine(
    evt: MouseEvent,
    checkboxEl: HTMLInputElement,
    taskHost: HTMLElement,
  ): Promise<boolean> {
    const view = this.resolveMarkdownViewForElement(taskHost);
    if (!(view instanceof MarkdownView)) return false;
    const parentFile = view.file;
    if (!(parentFile instanceof TFile)) return false;

    const sourceLine = this.getSourceLineForReadingHost(view, taskHost);
    const parsed = sourceLine ? this.plugin.bodySubitemLinkService.parseLine(sourceLine.rawLine) : null;
    if (!parsed) return false;
    
    const childFile = this.resolveLinkedFile(parsed.linkTarget, parentFile.path);
    if (!(childFile instanceof TFile)) return false;

    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();

    const currentStatus = this.getNormalizedStatus(childFile);
    const currentState = this.mapStatusToCheckboxState(currentStatus);
    const nextStatus = this.getToggleTargetForState(currentState, currentStatus);
    if (!nextStatus) return false;

    const statusKey = this.getStatusKey();
    await this.plugin.app.fileManager.processFrontMatter(childFile, (fm) => {
      fm[statusKey] = nextStatus;
    });

    await this.refreshReferencesForChild(childFile);
    this.scheduleDecorate(view);
    this.refreshLivePreviewEditors();
    new Notice(`Set "${childFile.basename}" to ${nextStatus}.`);
    return true;
  }

  private resolveMarkdownViewForElement(targetEl: HTMLElement): MarkdownView | null {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const containerEl = (view as any).containerEl as HTMLElement | undefined;
      const contentEl = view.contentEl as HTMLElement | undefined;
      const previewContainer = (view as any).previewMode?.containerEl as HTMLElement | undefined;
      if (containerEl?.contains(targetEl) || contentEl?.contains(targetEl) || previewContainer?.contains(targetEl)) {
        return view;
      }
    }
    return null;
  }

  async handleContextMenu(evt: MouseEvent): Promise<boolean> {
    if (!this.plugin.settings.enableLinkedSubitemCheckboxes) return false;
    const targetEl = evt.target instanceof HTMLElement ? evt.target : null;
    const checkboxEl = targetEl?.closest(`.${VIRTUAL_CHECKBOX_CLASS}`) as HTMLElement | null;
    if (!checkboxEl) return false;

    const childPath = checkboxEl.dataset.linkedSubitemPath;
    const parentPath = checkboxEl.dataset.linkedSubitemParent;
    if (!childPath || !parentPath) return false;

    const childFile = this.plugin.app.vault.getFileByPath(childPath);
    const parentFile = this.plugin.app.vault.getFileByPath(parentPath);
    if (!(childFile instanceof TFile) || !(parentFile instanceof TFile)) return false;

    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();

    const statuses = this.getStatusOptions();
    if (statuses.length === 0) return false;

    const currentStatus = this.getNormalizedStatus(childFile);
    const menu = new Menu();
    for (const status of statuses) {
      menu.addItem((item) => {
        const normalized = String(status || '').trim().toLowerCase();
        item.setTitle(status);
        if (normalized && normalized === currentStatus) {
          item.setChecked(true);
        }
        item.onClick(() => {
          void this.setLinkedSubitemStatus(childFile, status);
        });
      });
    }

    menu.showAtPosition({ x: evt.clientX, y: evt.clientY });
    return true;
  }

  private async handlePropertyPillClick(evt: MouseEvent, pillEl: HTMLElement): Promise<boolean> {
    const childPath = pillEl.dataset.linkedSubitemPath;
    const kind = pillEl.dataset.linkedSubitemPillKind;
    const value = pillEl.dataset.linkedSubitemPillValue || '';
    const propertyKey = pillEl.dataset.linkedSubitemPropertyKey || '';
    const propertyType = pillEl.dataset.linkedSubitemPropertyType || '';
    if (!childPath || !kind) return false;

    const childFile = this.plugin.app.vault.getFileByPath(childPath);
    if (!(childFile instanceof TFile)) return false;
    const entries = [{ file: childFile, frontmatter: (this.plugin.app.metadataCache.getFileCache(childFile)?.frontmatter || {}) as Record<string, unknown> }];
    const menuController = this.plugin.menuController as any;
    const propertyRowService = menuController?.propertyRowService as any;

    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();

    if ((kind === 'status' || (propertyType === 'selector' && propertyKey === 'status')) && propertyRowService?.openStatusSubmenu) {
      const statusProp = this.resolveCustomProperty(entries, 'status', 'status');
      propertyRowService.openStatusSubmenu(pillEl, entries, undefined, statusProp?.options);
      return true;
    }
    if ((kind === 'priority' || (propertyType === 'selector' && propertyKey === 'priority')) && propertyRowService?.openPrioritySubmenu) {
      const priorityProp = this.resolveCustomProperty(entries, 'priority', 'priority');
      propertyRowService.openPrioritySubmenu(pillEl, entries, undefined, priorityProp?.options);
      return true;
    }
    if (kind === 'scheduled' || propertyType === 'datetime') {
      menuController?.openScheduledModal?.(entries, propertyKey || 'scheduled');
      return true;
    }
    if (kind === 'recurrence' || propertyType === 'recurrence') {
      menuController?.openRecurrenceModalNative?.(entries);
      return true;
    }
    if (kind === 'folder' && propertyRowService?.openTypeSubmenu) {
      propertyRowService.openTypeSubmenu(pillEl, entries);
      return true;
    }
    if (kind === 'action') {
      menuController?.openAddTagModal?.(entries, 'tags');
      return true;
    }
    if (kind === 'tag') {
      menuController?.triggerTagSearch?.(String(value || '').replace(/^#/, ''));
      return true;
    }
    if (propertyType === 'selector' && propertyKey) {
      const prop = this.resolveCustomProperty(entries, propertyKey, propertyKey);
      const options = Array.isArray(prop?.options) ? prop.options : [];
      if (options.length > 0) {
        const currentValue = String((entries[0]?.frontmatter || {})[propertyKey] || '').trim();
        const menu = new Menu();
        for (const option of options) {
          menu.addItem((item) => {
            item.setTitle(option);
            if (currentValue === option) item.setChecked(true);
            item.onClick(async () => {
              await this.plugin.bulkEditService.updateFrontmatter([childFile], { [propertyKey]: option });
              await this.refreshReferencesForChild(childFile);
              this.scheduleDecorateForActiveView();
              this.refreshLivePreviewEditors();
            });
          });
        }
        menu.showAtPosition({ x: evt.clientX, y: evt.clientY });
        return true;
      }
    }
    return false;
  }

  async syncActiveViewFile(): Promise<void> {
    const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const activeFile = activeView?.file;
    if (!(activeView instanceof MarkdownView) || !(activeFile instanceof TFile) || activeFile.extension !== 'md' || !this.plugin.settings.enableLinkedSubitemCheckboxes) return;
    if (this.getLinkedSubitemRenderMode(activeView) === 'preview') {
      this.scheduleDecorate(activeView);
    } else {
      this.refreshLivePreviewEditors();
    }
  }

  async syncDerivedStatusForChild(childFile: TFile): Promise<boolean> {
    const references = await this.plugin.subitemReferenceIndexService.getReferencesForChild(childFile);
    return await this.syncDerivedStatusForChildFromReferences(childFile, references);
  }

  async syncDerivedStatusForChildFromReferences(childFile: TFile, references: BodySubitemLink[]): Promise<boolean> {
    const checkboxReference = references.find((reference) => reference.kind === 'checkbox' && !!reference.checkboxState);
    const targetStatus = checkboxReference?.checkboxState ? this.getStatusForCheckboxState(checkboxReference.checkboxState) : '';
    const currentStatus = this.getNormalizedStatus(childFile);
    const statusKey = this.getStatusKey();

    if (!targetStatus) {
      if (!currentStatus) return false;
      await this.plugin.frontmatterMutationService.deleteKeys([childFile], [statusKey]);
      await this.refreshReferencesForChild(childFile);
      this.scheduleDecorateForActiveView();
      this.refreshLivePreviewEditors();
      return true;
    }

    if (currentStatus === targetStatus.toLowerCase()) return false;
    await this.plugin.frontmatterMutationService.updateValues([childFile], { [statusKey]: targetStatus });
    await this.refreshReferencesForChild(childFile);
    this.scheduleDecorateForActiveView();
    this.refreshLivePreviewEditors();
    return true;
  }

  async refreshReferencesForChild(childFile: TFile): Promise<void> {
    const references = await this.plugin.subitemReferenceIndexService.getReferencesForChild(childFile);
    const parentPaths = new Set<string>();
    for (const reference of references) {
      if (reference.parentPath) parentPaths.add(reference.parentPath);
    }

    for (const parentPath of parentPaths) {
      const parentFile = this.plugin.app.vault.getFileByPath(parentPath);
      if (!(parentFile instanceof TFile)) continue;
      this.scheduleRefreshForParentFile(parentFile);
    }
  }

  private scheduleDecorate(view: MarkdownView): void {
    const existing = this.refreshTimers.get(view);
    if (existing != null) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.refreshTimers.delete(view);
      this.decorateView(view);
    }, 60);
    this.refreshTimers.set(view, timer);
  }

  private scheduleDecorateForActiveView(): void {
    const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!(activeView instanceof MarkdownView)) return;
    if (this.getLinkedSubitemRenderMode(activeView) !== 'preview') return;
    this.scheduleDecorate(activeView);
  }

  private clearDecorations(view: MarkdownView): void {
    const root = view.contentEl;
    if (!root) return;
    const previewContainer = this.getVisiblePreviewContainer(view);
    if (!(previewContainer instanceof HTMLElement)) return;

    // Remove all custom elements
    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-pill').forEach(el => el.remove());
    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-checkbox').forEach(el => el.remove());
    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-row-content').forEach(el => el.remove());
    
    // Remove all marker classes
    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-task').forEach(el => {
      el.classList.remove('tps-gcm-linked-subitem-task', 'is-open', 'is-complete', 'is-canceled');
    });
    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-link').forEach(el => {
      el.classList.remove('tps-gcm-linked-subitem-link');
    });
    previewContainer.querySelectorAll('.tps-gcm-hidden-native-link').forEach(el => {
      el.classList.remove('tps-gcm-hidden-native-link');
    });
    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-checkbox-hidden').forEach(el => {
      el.classList.remove('tps-gcm-linked-subitem-checkbox-hidden');
      if (el instanceof HTMLInputElement) {
        (el as HTMLInputElement).style.display = '';
      }
    });
    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-replaced').forEach(el => {
      el.classList.remove('tps-gcm-linked-subitem-replaced');
    });
  }

  /**
   * Decorate reading mode view using deterministic source-line-to-element mapping.
   * Uses the preview renderer's internal section info to reliably map source lines
   * to rendered DOM elements, ensuring parity with Live Preview.
   */
  private decorateView(view: MarkdownView): void {
    const root = view.contentEl;
    if (!root?.isConnected) return;

    const mode = this.getLinkedSubitemRenderMode(view);

    if (mode !== 'preview') {
      this.clearDecorations(view);
      return;
    }

    if (this.decoratingViews.has(view)) {
      return;
    }

    this.decoratingViews.add(view);
    try {
      const file = view.file;
      if (!(file instanceof TFile)) return;
      
      const editorAny = view.editor as any;
      const source = typeof editorAny?.getValue === 'function'
        ? String(editorAny.getValue() || '')
        : String((view as any)?.data || '');
      const lines = String(source || '').split('\n');
      
      // Parse all lines and build models for recognized subitem lines
      // ONLY standalone rows recognized by parseLine() are eligible for takeover
      const subitemEntries = new Map<number, { parsed: any; childFile: TFile; model: SubitemLineModel }>();
      for (let i = 0; i < lines.length; i++) {
        const parsed = this.plugin.bodySubitemLinkService.parseLine(lines[i]);
        if (!parsed) continue;
        const childFile = this.resolveLinkedFile(parsed.linkTarget, file.path);
        if (!(childFile instanceof TFile)) continue;
        const model = this.subitemLineModelService.buildModel(parsed, childFile, file);
        logger.log('[TPS GCM] [DIAG] reading-mode model', {
          parentFile: file.path,
          childFile: childFile.path,
          lineNumber: i,
          lineKind: parsed.kind,
          checkboxState: model.checkboxState,
          modelPillCount: model.pills.length,
          modelPills: model.pills.map((pill) => ({ kind: pill.kind, label: pill.label, value: pill.value })),
        });
        subitemEntries.set(i, { parsed, childFile, model });
      }
      
      logger.log('[TPS GCM] [LinkedSubitem] decorate reading mode', {
        file: file.path,
        subitemLineCount: subitemEntries.size,
      });

      // Use the currently visible preview container. Reading mode can keep multiple
      // preview wrappers in the DOM, and querying the first one may target a hidden
      // container, which clears the visible view and then injects into the wrong place.
      const previewContainer = this.getVisiblePreviewContainer(view) || root;
      
      // Build a deterministic map from source line numbers to rendered list items
      const lineToElement = this.buildDeterministicSourceLineToElementMap(
        view,
        previewContainer,
        lines,
        subitemEntries,
      );
      
      logger.log('[TPS GCM] [LinkedSubitem] reading mode line mapping', {
        matchedCount: lineToElement.size,
        expectedCount: subitemEntries.size,
      });

      if (subitemEntries.size === 0) {
        this.clearDecorations(view);
        return;
      }

      // Do not clear the current rendered rows if preview mapping temporarily drops out.
      // Reading mode can churn through transient wrapper states and otherwise falls back
      // to plain native links until another refresh happens to succeed.
      if (lineToElement.size === 0) {
        this.scheduleDecorate(view);
        return;
      }

      this.clearDecorations(view);
      
      // Now decorate each matched element
      for (const [lineNum, entry] of subitemEntries) {
        const li = lineToElement.get(lineNum);
        if (!li) {
          logger.log('[TPS GCM] [LinkedSubitem] no element for line', { lineNum, line: lines[lineNum] });
          continue;
        }
        
        const { parsed, childFile, model } = entry;
        
        // Mark the list item as a linked subitem task
        li.classList.add('tps-gcm-linked-subitem-task', model.visualStateClass);
        
        // Build the complete row content using shared builder
        const elements = buildLinkedSubitemRow(
          model,
          (evt) => {
            const checkboxEl = elements.checkbox;
            if (checkboxEl) {
              void this.handleCustomCheckboxClick(evt, checkboxEl);
            }
          },
          (path) => this.openLinkedSubitemPath(path),
          (evt, pill) => {
            void this.handlePropertyPillClick(evt, this.findPillElement(elements.pillsContainer, pill));
          },
          { includeCheckbox: model.kind !== 'checkbox' },
        );

        logger.log('[TPS GCM] [DIAG] reading-mode rendered row before replace', {
          parentFile: file.path,
          childFile: childFile.path,
          lineNumber: lineNum,
          modelPillCount: model.pills.length,
          renderedPillCount: elements.pillsContainer.children.length,
          renderedPills: Array.from(elements.pillsContainer.children).map((pillEl) => ({
            kind: (pillEl as HTMLElement).dataset.linkedSubitemPillKind,
            value: (pillEl as HTMLElement).dataset.linkedSubitemPillValue,
            text: (pillEl as HTMLElement).textContent,
          })),
        });
        
        this.injectReadingModeLinkWidget(li, childFile, model, elements.container);
      }
    } finally {
      window.setTimeout(() => this.decoratingViews.delete(view), 0);
    }
  }

  /**
   * Build a deterministic map from source line numbers to rendered list item elements.
   * Uses Obsidian's preview renderer section info to reliably map source lines to DOM elements.
   * This ensures parity between reading mode and Live Preview.
   */
  private buildDeterministicSourceLineToElementMap(
    view: MarkdownView,
    container: Element,
    lines: string[],
    subitemEntries: Map<number, { parsed: any; childFile: TFile; model: SubitemLineModel }>,
  ): Map<number, HTMLElement> {
    const result = new Map<number, HTMLElement>();
    
    // Get the preview renderer's section info for deterministic line mapping
    const previewRenderer = (view as any).previewMode?.renderer as any;
    if (!previewRenderer) {
      logger.log('[TPS GCM] [LinkedSubitem] no preview renderer, using fallback');
      return this.buildFallbackSourceLineToElementMap(container, lines, subitemEntries);
    }
    
    const sectionInfo = previewRenderer.sectionInfo;
    if (!sectionInfo) {
      logger.log('[TPS GCM] [LinkedSubitem] no section info, using fallback');
      return this.buildFallbackSourceLineToElementMap(container, lines, subitemEntries);
    }
    
    // Map section info line numbers to DOM elements
    const lineToElementMap = new Map<number, HTMLElement>();
    for (const section of sectionInfo.sections) {
      const { line, el } = section;
      if (el instanceof HTMLElement) {
        const host = this.normalizeReadingModeHostElement(el);
        if (host) {
          lineToElementMap.set(line, host);
        }
      }
    }
    
    // Build the result map using line-to-element mapping
    const usedLines = new Set<number>();
    for (const [lineNum, entry] of subitemEntries) {
      const el = lineToElementMap.get(lineNum);
      if (el && !usedLines.has(lineNum)) {
        result.set(lineNum, el);
        usedLines.add(lineNum);
      }
    }
    
    // Log mapping statistics
    logger.log('[TPS GCM] [LinkedSubitem] deterministic mapping', {
      matchedCount: result.size,
      expectedCount: subitemEntries.size,
      usedFallback: usedLines.size !== subitemEntries.size,
    });
    
    return result;
  }
  
  /**
   * Fallback method using text-based matching when preview renderer info is unavailable.
   * @deprecated Use buildDeterministicSourceLineToElementMap when possible.
   */
  private buildFallbackSourceLineToElementMap(
    container: Element,
    lines: string[],
    subitemEntries: Map<number, { parsed: any; childFile: TFile; model: SubitemLineModel }>,
  ): Map<number, HTMLElement> {
    const result = new Map<number, HTMLElement>();
    const usedLines = new Set<number>();
    
    // First pass: use data-line attributes for precise matching
    const listItems = Array.from(container.querySelectorAll<HTMLElement>('li'));
    for (const li of listItems) {
      const dataLine = this.getDataLineAttribute(li);
      if (dataLine !== null && subitemEntries.has(dataLine) && !usedLines.has(dataLine)) {
        result.set(dataLine, li);
        usedLines.add(dataLine);
      }
    }
    
    // Second pass: for any unmatched entries, use text-based matching
    for (const [lineNum, entry] of subitemEntries) {
      if (usedLines.has(lineNum)) continue;
      
      for (const li of listItems) {
        if (result.has(lineNum)) break;
        
        const liText = this.getListItemText(li);
        if (!liText) continue;
        
        const sourceLine = lines[lineNum];
        if (!sourceLine) continue;
        
        // Check if the source line's wikilink target appears in the rendered text
        const linkTarget = entry.parsed.linkTarget;
        const displayLabel = entry.model.displayLabel;
        
        // The rendered text should contain either the link target or display label
        if ((liText.includes(linkTarget) || liText.includes(displayLabel)) &&
            sourceLine.includes(entry.parsed.wikilink)) {
          result.set(lineNum, li);
          usedLines.add(lineNum);
        }
      }
    }
    
    return result;
  }

  /**
   * Extract the data-line attribute from an element or its ancestors.
   * Returns null if not found or invalid.
   */
  private getDataLineAttribute(el: HTMLElement): number | null {
    // Check the element itself
    const dataLine = el.getAttribute('data-line');
    if (dataLine !== null) {
      const line = parseInt(dataLine, 10);
      if (!isNaN(line) && line >= 0) return line;
    }
    
    // Check parent list item if this is a nested element
    const parentLi = el.closest('li');
    if (parentLi && parentLi !== el) {
      const parentDataLine = parentLi.getAttribute('data-line');
      if (parentDataLine !== null) {
        const line = parseInt(parentDataLine, 10);
        if (!isNaN(line) && line >= 0) return line;
      }
    }
    
    return null;
  }

  /**
   * Match a rendered list item to its source line using text content.
   */
  private matchListItemToSourceLine(
    li: HTMLElement,
    lines: string[],
    subitemEntries: Map<number, { parsed: any; childFile: TFile; model: SubitemLineModel }>,
  ): { parsed: any; childFile: TFile; model: SubitemLineModel } | null {
    // Get the text content of the list item (excluding nested lists)
    const liText = this.getListItemText(li);
    if (!liText) return null;
    
    // Try to find a matching source line
    for (const [lineNum, entry] of subitemEntries) {
      const sourceLine = lines[lineNum];
      if (!sourceLine) continue;
      
      // Check if the source line's wikilink target appears in the rendered text
      const linkTarget = entry.parsed.linkTarget;
      const displayLabel = entry.model.displayLabel;
      
      // The rendered text should contain either the link target or display label
      if (liText.includes(linkTarget) || liText.includes(displayLabel)) {
        // Verify the source line contains the wikilink
        if (sourceLine.includes(entry.parsed.wikilink)) {
          return entry;
        }
      }
    }
    
    return null;
  }

  /**
   * Get the text content of a list item, excluding nested list content.
   */
  private getListItemText(li: HTMLElement): string {
    // Clone the element to avoid modifying the original
    const clone = li.cloneNode(true) as HTMLElement;
    
    // Remove nested lists from the clone
    clone.querySelectorAll('ul, ol').forEach(nested => nested.remove());
    
    return (clone.textContent || '').trim();
  }

  /**
   * Replace the entire list item content with our custom row.
   * This rebuilds the list item from scratch, ensuring the takeover survives
   * preview rendering in reading mode. The bullet marker is preserved.
   */
  private replaceListContent(
    li: HTMLElement,
    customContent: HTMLElement,
    lineKind: string,
  ): void {
    // Find and preserve the bullet marker (the first element child)
    const bulletMarker = li.firstChild;
    logger.log('[TPS GCM] [DIAG] replaceListContent before', {
      lineKind,
      originalChildNodeCount: li.childNodes.length,
      originalElementChildCount: li.childElementCount,
      originalHtml: li.innerHTML,
      bulletMarkerNodeName: bulletMarker?.nodeName || null,
      customContentPillCount: customContent.querySelectorAll('.tps-gcm-linked-subitem-pill').length,
    });
    
    // Clear the list item content
    li.textContent = '';
    
    // Re-add the bullet marker at the beginning
    if (bulletMarker && bulletMarker.nodeType === Node.ELEMENT_NODE) {
      li.appendChild(bulletMarker);
    }
    
    // Append our custom row content
    li.appendChild(customContent);
    
    // Mark the list item as having replaced content
    li.classList.add('tps-gcm-linked-subitem-replaced');

    logger.log('[TPS GCM] [DIAG] replaceListContent after', {
      lineKind,
      finalChildNodeCount: li.childNodes.length,
      finalElementChildCount: li.childElementCount,
      finalHtml: li.innerHTML,
      renderedPillCount: li.querySelectorAll('.tps-gcm-linked-subitem-pill').length,
    });
  }

  /**
   * Replace the content of a list item with our custom row content.
   * This hides native checkboxes/links and shows our custom elements instead.
   * @deprecated Use replaceListContent instead for better nested list handling.
   */
  private replaceListItemContent(
    li: HTMLElement,
    customContent: HTMLElement,
    lineKind: string,
  ): void {
    // Delegate to the new method
    this.replaceListContent(li, customContent, lineKind);
  }

  /**
   * Reading mode decoration: hide the native link and inject our inline widget
   * immediately after it, preserving the original checkbox/list structure.
   */
  private injectReadingModeLinkWidget(
    li: HTMLElement,
    childFile: TFile,
    model: SubitemLineModel,
    customContent: HTMLElement,
  ): void {
    const host = this.normalizeReadingModeHostElement(li) ?? li;
    customContent.classList.add('is-reading-mode');
    const nativeLink = this.findReadingModeNativeLink(host, childFile, model.displayLabel);
    if (!nativeLink) return;

    nativeLink.classList.add('tps-gcm-hidden-native-link');
    nativeLink.insertAdjacentElement('afterend', customContent);
  }

  private findReadingModeNativeLink(
    li: HTMLElement,
    childFile: TFile,
    displayLabel: string,
  ): HTMLAnchorElement | null {
    const scope = this.normalizeReadingModeHostElement(li) ?? li;
    const candidates = Array.from(scope.querySelectorAll<HTMLAnchorElement>('a.internal-link, a'));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const childPath = childFile.path.replace(/\.md$/i, '').toLowerCase();
    const fullPath = childFile.path.toLowerCase();
    const basename = childFile.basename.toLowerCase();
    const label = String(displayLabel || '').trim().toLowerCase();

    for (const anchor of candidates) {
      const href = decodeURIComponent(anchor.getAttribute('href') || '').toLowerCase();
      const text = String(anchor.textContent || '').trim().toLowerCase();
      if (
        href.includes(fullPath) ||
        href.includes(childPath) ||
        text === basename ||
        (label && text === label)
      ) {
        return anchor;
      }
    }

    return candidates[0];
  }

  private normalizeReadingModeHostElement(el: HTMLElement | null | undefined): HTMLElement | null {
    if (!(el instanceof HTMLElement)) return null;
    if (el.matches('li.task-list-item, li, p')) return el;

    const descendantHost = el.querySelector<HTMLElement>('li.task-list-item, li, p');
    if (descendantHost) return descendantHost;

    const ancestorHost = el.closest<HTMLElement>('li.task-list-item, li, p');
    if (ancestorHost) return ancestorHost;

    return el;
  }

  private getSourceLineForReadingHost(
    view: MarkdownView,
    host: HTMLElement,
  ): { file: TFile; lineNumber: number; rawLine: string } | null {
    const file = view.file;
    if (!(file instanceof TFile)) return null;
    const text = this.getListItemText(host);
    if (!text) return null;
    const editor = view.editor as any;
    const source = typeof editor?.getValue === 'function' ? editor.getValue() : ((view as any)?.data || '');
    const lines = String(source || '').split('\n');
    const idx = lines.findIndex((line) => {
      const parsed = this.plugin.bodySubitemLinkService.parseLine(line);
      if (!parsed) return false;
      // Check if the line contains a link that matches the host text
      return text.includes(parsed.linkTarget) || line.includes(parsed.wikilink);
    });
    if (idx < 0) return null;
    return { file, lineNumber: idx, rawLine: lines[idx] ?? '' };
  }

  private async cleanupLegacyCheckboxes(file: TFile): Promise<void> {
    await this.plugin.subitemRelationshipSyncService.mutateMarkdownBody(file, async (lines) => {
      let changed = false;
      for (let index = 0; index < lines.length; index += 1) {
        const current = lines[index] || '';
        if (!this.lineNeedsLegacyCheckboxRepair(current)) continue;
        const normalized = this.normalizeCheckboxLinkSpacing(current);
        if (normalized !== current) {
          lines[index] = normalized;
          changed = true;
        }
      }
      return changed;
    });
  }

  private scheduleRefreshForParentFile(parentFile: TFile): void {
    const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file?.path === parentFile.path) {
      if (this.getLinkedSubitemRenderMode(activeView) === 'preview') {
        this.scheduleDecorate(activeView);
      } else {
        this.refreshLivePreviewEditors();
      }
    } else {
      this.scheduleDecorateForActiveView();
      this.refreshLivePreviewEditors();
    }
  }

  private resolveLinkedFile(linkTarget: string, sourcePath: string): TFile | null {
    return resolveLinkTargetToFile(this.plugin.app, linkTarget, sourcePath);
  }

  private getStatusKey(): string {
    return this.subitemLineModelService.getStatusKey();
  }

  private getStatusOptions(): string[] {
    const statusProp = this.plugin.settings.properties?.find((prop) => prop.id === 'status');
    const options = Array.isArray(statusProp?.options) ? statusProp.options : [];
    const normalized = options
      .map((option) => String(option || '').trim())
      .filter(Boolean);
    if (normalized.length > 0) return normalized;
    return ['todo', 'working', 'holding', 'wont-do', 'complete'];
  }

  private async setLinkedSubitemStatus(file: TFile, status: string): Promise<void> {
    const normalizedStatus = String(status || '').trim();
    if (!normalizedStatus) return;
    await this.plugin.bulkEditService.setStatus([file], normalizedStatus);
    await this.refreshReferencesForChild(file);
    this.scheduleDecorateForActiveView();
    this.refreshLivePreviewEditors();
    new Notice(`Set "${file.basename}" to ${normalizedStatus}.`);
  }

  private getNormalizedStatus(file: TFile): string {
    return this.subitemLineModelService.getNormalizedStatus(file);
  }

  private mapStatusToCheckboxState(status: string): string {
    return this.subitemLineModelService.mapStatusToCheckboxState(status);
  }

  private getStatusForCheckboxState(state: string): string {
    const mapping = this.getMappings().find((entry) => entry.checkboxState === state);
    return String(mapping?.statuses?.[0] || '').trim();
  }

  private createEditorExtension() {
    const service = this;
    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        lastMatchCount = 0;
        lastDocLength = 0;
        initialized = false;

        constructor(view: EditorView) {
          const result = service.buildEditorDecorations(view);
          this.decorations = result.decorations;
          this.lastMatchCount = result.matchCount;
          this.lastDocLength = view.state.doc.length;
          this.initialized = true;
        }

        update(update: ViewUpdate) {
          const hasRefreshEffect = update.transactions.some((tr) =>
            tr.effects.some((effect) => effect.is(refreshLinkedSubitemEffect))
          );
          const docLengthChanged = update.state.doc.length !== this.lastDocLength;
          
          // SAFETY: Always rebuild decorations on document changes or explicit refresh.
          // Never preserve stale decorations across actual document-length changes, or
          // they may point past the end of the document and throw RangeError.
          if (update.docChanged) {
            const result = service.buildEditorDecorations(update.view);
            if (
              result.matchCount > 0
              || this.lastMatchCount === 0
              || update.state.doc.length === 0
              || docLengthChanged
            ) {
              this.decorations = result.decorations;
              this.lastMatchCount = result.matchCount;
              this.lastDocLength = update.state.doc.length;
              if (result.matchCount === 0 && docLengthChanged && update.state.doc.length > 0) {
                window.setTimeout(() => {
                  try {
                    update.view.dispatch({ effects: refreshLinkedSubitemEffect.of(Date.now()) });
                  } catch {
                    // Ignore stale editor refresh attempts during workspace churn.
                  }
                }, 0);
              }
            } else {
              window.setTimeout(() => {
                try {
                  update.view.dispatch({ effects: refreshLinkedSubitemEffect.of(Date.now()) });
                } catch {
                  // Ignore stale editor refresh attempts during workspace churn.
                }
              }, 0);
            }
            return;
          }

          if (hasRefreshEffect) {
            const result = service.buildEditorDecorations(update.view);
            if (result.matchCount > 0 || this.lastMatchCount === 0) {
              this.decorations = result.decorations;
              this.lastMatchCount = result.matchCount;
              this.lastDocLength = update.state.doc.length;
            }
            return;
          }
          
          // Only rebuild on viewportChanged if we have no decorations yet (initial render)
          if (update.viewportChanged && this.lastMatchCount === 0 && this.initialized) {
            const result = service.buildEditorDecorations(update.view);
            if (result.matchCount > 0) {
              this.decorations = result.decorations;
              this.lastMatchCount = result.matchCount;
              this.lastDocLength = update.state.doc.length;
            }
          }
        }
      },
      {
        decorations: (value) => value.decorations,
      },
    );
  }

  /**
   * Build decorations for Live Preview.
   * TaskNotes-style behavior: keep the native markdown checkbox/list marker and
   * hide only the wikilink token, then render an inline widget beside it.
   *
   * Important: use mark+widget, not Decoration.replace. Replacing ranges from a
   * ViewPlugin can trip CodeMirror invariants during document/layout churn.
   */
  private buildEditorDecorations(view: EditorView): {
    decorations: DecorationSet;
    matchCount: number;
    potentialCount: number;
    filePath: string | null;
  } {
    if (!this.plugin.settings.enableLinkedSubitemCheckboxes) {
      return { decorations: Decoration.none, matchCount: 0, potentialCount: 0, filePath: null };
    }
    const markdownView = this.resolveMarkdownViewForEditor(view);
    const parentFile = markdownView?.file;
    if (!(markdownView instanceof MarkdownView) || !(parentFile instanceof TFile)) {
      return { decorations: Decoration.none, matchCount: 0, potentialCount: 0, filePath: parentFile instanceof TFile ? parentFile.path : null };
    }

    const builder = new RangeSetBuilder<Decoration>();
    let matchCount = 0;
    let potentialCount = 0;
    
    for (const range of view.visibleRanges) {
      let pos = range.from;
      while (pos <= range.to) {
        const line = view.state.doc.lineAt(pos);
        const parsed = this.plugin.bodySubitemLinkService.parseLine(line.text);
        if (parsed) {
          potentialCount++;
          const childFile = this.resolveLinkedFile(parsed.linkTarget, parentFile.path);
          if (childFile instanceof TFile) {
            const model = this.subitemLineModelService.buildModel(parsed, childFile, parentFile);
            matchCount++;
            logger.log('[TPS GCM] [DIAG] live-preview model', {
              parentFile: parentFile.path,
              childFile: childFile.path,
              lineNumber: line.number,
              lineText: line.text,
              lineKind: parsed.kind,
              checkboxState: model.checkboxState,
              modelPillCount: model.pills.length,
              modelPills: model.pills.map((pill) => ({ kind: pill.kind, label: pill.label, value: pill.value })),
            });
            
            // Suspend takeover only for an actual range selection.
            // A collapsed cursor should keep the row stable instead of falling back
            // to mixed native/widget rendering on the active line.
            if (this.lineHasRangeSelection(view, line.from, line.to)) {
               if (line.to >= range.to) break;
               pos = line.to + 1;
               continue;
             }
            
            // Add line class for styling
            builder.add(
              line.from,
              line.from,
              Decoration.line({
                class: `tps-gcm-linked-subitem-task tps-gcm-linked-subitem-cm-line ${model.visualStateClass}`,
              }),
            );
            
            const linkOffset = line.text.indexOf(parsed.wikilink);
            if (linkOffset < 0) {
              if (line.to >= range.to) break;
              pos = line.to + 1;
              continue;
            }

            let replaceFrom = line.from + linkOffset;
            let replaceTo = replaceFrom + parsed.wikilink.length;

            // SAFETY: Validate all positions are within line bounds and document bounds.
            // This prevents "RangeError: Invalid position" and "Decorations that replace line breaks" errors.
            const docLength = view.state.doc.length;
            replaceFrom = Math.max(line.from, Math.min(replaceFrom, line.to));
            replaceTo = Math.max(replaceFrom, Math.min(replaceTo, line.to));
            
            // Skip if positions are invalid or would create an empty/invalid range
            if (replaceFrom >= replaceTo || replaceTo > docLength || replaceFrom < 0) {
              if (line.to >= range.to) break;
              pos = line.to + 1;
              continue;
            }
            
            // Replace the wikilink token directly instead of collapsing it with CSS.
            // This keeps CodeMirror's coordinate math stable while leaving the
            // native task/list DOM in place.
            builder.add(
              replaceFrom,
              replaceTo,
              Decoration.replace({
                widget: new LinkedSubitemRowWidget(
                  model,
                  (evt) => {
                    void this.handleCustomCheckboxClick(
                      evt,
                      (evt.target as HTMLElement).closest(`.${VIRTUAL_CHECKBOX_CLASS}`) as HTMLElement,
                    );
                  },
                  (path) => this.openLinkedSubitemPath(path),
                  (evt, pill) => {
                    void this.handlePropertyPillClick(
                      evt,
                      (evt.target as HTMLElement).closest('.tps-gcm-linked-subitem-pill') as HTMLElement,
                    );
                  },
                ),
                inclusive: false,
              }),
            );
            builder.add(
              replaceTo,
              replaceTo,
              Decoration.widget({
                side: 1,
                widget: new LinkedSubitemSpacerWidget(),
              }),
            );
          }
        }
        if (line.to >= range.to) break;
        pos = line.to + 1;
      }
    }
    
    logger.log('[TPS GCM] [LinkedSubitemCM] decoration build', {
      file: parentFile.path,
      matchCount,
      potentialCount,
      visibleRanges: view.visibleRanges.length,
    });
    
    // SAFETY: Always return fresh decorations - never cache or reuse stale decorations.
    // This prevents "RangeError: Invalid position" errors when document changes.
    return {
      decorations: builder.finish(),
      matchCount,
      potentialCount,
      filePath: parentFile.path,
    };
  }

  private resolveMarkdownViewForEditor(editorView: EditorView): MarkdownView | null {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const containerEl = (view as any).containerEl as HTMLElement | undefined;
      const contentEl = view.contentEl as HTMLElement | undefined;
      if (containerEl?.contains(editorView.dom) || contentEl?.contains(editorView.dom)) {
        return view;
      }
    }
    return null;
  }

  public refreshLivePreviewEditors(): void {
    const markdownView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!(markdownView instanceof MarkdownView)) return;
    if (this.getLinkedSubitemRenderMode(markdownView) !== 'source') return;
    const cm = (markdownView.editor as any)?.cm as EditorView | undefined;
    if (!cm || typeof cm.dispatch !== 'function') return;
    try {
      cm.dispatch({ effects: refreshLinkedSubitemEffect.of(Date.now()) });
    } catch {
      // Ignore stale editors during workspace churn.
    }
  }

  private getMappings() {
    return this.subitemLineModelService.getMappings();
  }

  private getLinkedSubitemRenderMode(view: MarkdownView): 'preview' | 'source' | null {
    const previewContainer = this.getVisiblePreviewContainer(view);
    if (previewContainer) return 'preview';

    const root = view.contentEl as HTMLElement | undefined;
    const sourceContainer = root?.querySelector('.markdown-source-view') as HTMLElement | null;
    if (this.isVisibleRenderContainer(sourceContainer)) return 'source';

    return getViewMode(view);
  }

  private getVisiblePreviewContainer(view: MarkdownView): HTMLElement | null {
    const root = view.contentEl as HTMLElement | undefined;
    if (!root) return null;

    const previewCandidates = Array.from(
      root.querySelectorAll<HTMLElement>('.markdown-preview-view, .markdown-reading-view'),
    );
    return previewCandidates.find((el) => this.isVisibleRenderContainer(el)) ?? null;
  }

  private isVisibleRenderContainer(el: HTMLElement | null | undefined): el is HTMLElement {
    if (!(el instanceof HTMLElement) || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  private getToggleTargetForState(state: string, currentStatus: string): string | null {
    const normalizedStatus = String(currentStatus || '').trim().toLowerCase();
    const mapping = this.getMappings().find((entry) => entry.checkboxState === state)
      || this.getMappings().find((entry) => entry.statuses.some((status) => String(status || '').trim().toLowerCase() === normalizedStatus));
    return mapping?.toggleTargetStatus ? String(mapping.toggleTargetStatus).trim() : null;
  }

  private normalizeCheckboxLinkSpacing(line: string): string {
    const raw = String(line || '');
    const repairedMalformed = raw.replace(
      /^([ \t]*(?:[-*+]|\d+\.)\s+)\[(?!\[)([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]$/,
      (_match, prefix, target, alias) => `${prefix}[ ] [[${String(target || '').trim()}${alias ? `|${String(alias).trim()}` : ''}]]`,
    );
    const repairedTripleBracket = repairedMalformed.replace(
      /^((?:[ \t]*(?:[-*+]|\d+\.)\s+)?)?(\[[^\]]+])\s*\[\[\[([^\]]+)\]\]$/,
      '$1$2 [[$3]]',
    );
    return repairedTripleBracket.replace(
      /^((?:[ \t]*(?:[-*+]|\d+\.)\s+)?)?(\[[^\]]+])\s*(\[\[[^\]]+\]\])$/,
      '$1$2 $3',
    );
  }

  private lineNeedsLegacyCheckboxRepair(line: string): boolean {
    const raw = String(line || '');
    return /^([ \t]*(?:[-*+]|\d+\.)\s+)\[(?!\[)([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]$/.test(raw)
      || /^((?:[ \t]*(?:[-*+]|\d+\.)\s+)?)?(\[[^\]]+])\s*\[\[\[([^\]]+)\]\]$/.test(raw);
  }

  private matchActualCheckboxMarker(line: string): RegExpMatchArray | null {
    const prefixMatch = String(line || '').match(/^(\s*[-*+]\s*)/);
    if (!prefixMatch) return null;
    const prefix = prefixMatch[0];
    const remainder = line.slice(prefix.length);
    for (const state of this.plugin.bodySubitemLinkService.getConfiguredCheckboxStates()) {
      if (remainder.startsWith(`${state} [[`) || remainder === state || remainder.startsWith(`${state}\t[[`)) {
        const escaped = state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return line.match(new RegExp(`^(\\s*[-*+]\\s*)${escaped}`));
      }
    }
    return null;
  }

  /**
   * Check if a line has an active range selection (multi-character selection).
   * @deprecated Use lineHasActiveSelectionOrCursor instead for full editing suspension.
   */
  private lineHasRangeSelection(view: EditorView, from: number, to: number): boolean {
    return view.state.selection.ranges.some((range) => {
      const start = Math.min(range.anchor, range.head);
      const end = Math.max(range.anchor, range.head);
      if (start === end) return false;
      return end >= from && start <= to;
    });
  }

  /**
   * Check if a line has an active selection OR cursor position.
   * This suspends takeover decoration when the user is actively editing the line,
   * ensuring native markdown renders for active editing.
   */
  private lineHasActiveSelectionOrCursor(view: EditorView, from: number, to: number): boolean {
    return view.state.selection.ranges.some((range) => {
      const start = Math.min(range.anchor, range.head);
      const end = Math.max(range.anchor, range.head);
      if (start === end) return false;
      // Only suspend decoration for an actual range selection, not a collapsed cursor.
      return end >= from && start <= to;
    });
  }

  private openLinkedSubitemPath(path: string): void {
    const file = this.plugin.app.vault.getFileByPath(path);
    if (!(file instanceof TFile)) return;
    void this.plugin.openFileInLeaf(file, false, () => this.plugin.app.workspace.getLeaf(false), {
      revealLeaf: true,
      ignoreCanvasDragGuard: true,
    });
  }

  /**
   * Find a pill element in the container that matches the given pill data.
   * This handles cases where pill.value might be undefined.
   */
  private findPillElement(container: HTMLElement, pill: PropertyPill): HTMLElement | null {
    if (!container) return null;
    
    // Try to match by kind and value (if value exists)
    const valueSelector = pill.value
      ? `[data-linked-subitem-pill-kind="${pill.kind}"][data-linked-subitem-pill-value="${pill.value}"]`
      : `[data-linked-subitem-pill-kind="${pill.kind}"]`;
    let pillEl = container.querySelector(valueSelector) as HTMLElement | null;
    
    // If value match fails or value is undefined, try matching by kind only
    if (!pillEl && pill.value === undefined) {
      pillEl = container.querySelector(`[data-linked-subitem-pill-kind="${pill.kind}"]`) as HTMLElement | null;
    }
    
    // Fallback: return the last pill element if no match found
    if (!pillEl && container.lastElementChild) {
      return container.lastElementChild as HTMLElement;
    }
    
    return pillEl;
  }

  private resolveCustomProperty(entries: any[], id: string, key: string) {
    const properties = resolveCustomProperties(this.plugin.settings.properties || [], entries, new ViewModeService());
    return properties.find((prop) => prop.id === id || prop.key === key);
  }
}
