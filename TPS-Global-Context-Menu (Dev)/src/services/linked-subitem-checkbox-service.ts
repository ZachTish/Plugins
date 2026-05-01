import { MarkdownView, Menu, Notice, TFile } from 'obsidian';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import type TPSGlobalContextMenuPlugin from '../main';
import * as logger from '../logger';
import { resolveCustomProperties } from '../resolve-profiles';
import { getViewMode } from './leaf-resolver';
import { resolveLinkTargetToFile } from './link-target-service';
import { ViewModeService } from './view-mode-service';
import type { BodySubitemLink } from './subitem-types';
import { checkAndPromptForUnresolvedSubitems } from './unresolved-subitem-modal';
import { SubitemLineModelService, type SubitemLineModel, type PropertyPill } from './subitem-line-model';
import { buildLinkedSubitemRow } from './linked-subitem-row-builder';
import { CheckboxPatterns } from '../core';

const VIRTUAL_CHECKBOX_CLASS = 'tps-gcm-linked-subitem-checkbox';
const CM_WIDGET_CLASS = 'tps-gcm-linked-subitem-cm-widget';
const DECORATION_VERSION = '2';
const refreshLinkedSubitemEffect = StateEffect.define<number>();

function shouldRenderReadingModeLeadingControl(model: SubitemLineModel): boolean {
  return model.kind === 'checkbox' || model.kind === 'heading' || model.hasExplicitStatus;
}

function shouldRenderLivePreviewLeadingControl(model: SubitemLineModel): boolean {
  if (model.kind === 'checkbox' || model.kind === 'heading') return true;
  return model.hasExplicitStatus;
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

class LinkedSubitemPillsWidget extends WidgetType {
  constructor(
    private readonly model: SubitemLineModel,
    private readonly onPillClick: (evt: MouseEvent, pill: PropertyPill) => void,
    private readonly onLineTailClick: (evt: MouseEvent) => void,
  ) {
    super();
  }

  eq(other: LinkedSubitemPillsWidget): boolean {
    return (
      other.model.childFile.path === this.model.childFile.path &&
      other.model.parentFile.path === this.model.parentFile.path &&
      JSON.stringify(other.model.pills) === JSON.stringify(this.model.pills)
    );
  }

  toDOM(): HTMLElement {
    const elements = buildLinkedSubitemRow(
      this.model,
      () => {},
      () => {},
      () => {},
      this.onPillClick,
      {
        includeCheckbox: false,
        includeBulletMarker: false,
      },
    );
    const wrapper = document.createElement('span');
    wrapper.className = `${CM_WIDGET_CLASS} tps-gcm-linked-subitem-pills-only`;
    wrapper.dataset.linkedSubitemPath = this.model.childFile.path;
    wrapper.dataset.linkedSubitemParent = this.model.parentFile.path;
    wrapper.addEventListener('mousedown', (evt) => {
      const target = evt.target as HTMLElement | null;
      if (target?.closest('.tps-gcm-linked-subitem-pill')) return;
      evt.preventDefault();
      evt.stopPropagation();
    });
    wrapper.addEventListener('click', (evt) => {
      const target = evt.target as HTMLElement | null;
      if (target?.closest('.tps-gcm-linked-subitem-pill')) return;
      evt.preventDefault();
      evt.stopPropagation();
      this.onLineTailClick(evt);
    });
    wrapper.appendChild(elements.pillsContainer);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class LinkedSubitemCheckboxService {
  private observers = new Map<MarkdownView, MutationObserver>();
  private refreshTimers = new Map<MarkdownView, number>();
  private selfHealAttempts = new WeakMap<MarkdownView, number>();
  private syncingFiles = new Set<string>();
  private pendingClearedStatusSyncs = new Set<string>();
  private decoratingViews = new WeakSet<MarkdownView>();
  private elementStates = new WeakMap<HTMLElement, string>();
  // NOTE: Removed lastSuccessfulEditorDecorations cache - it was preserving stale decorations
  // with invalid positions after document changes, causing RangeError runtime errors.
  private editorExtension = this.createEditorExtension();
  private subitemLineModelService: SubitemLineModelService;

  constructor(private plugin: TPSGlobalContextMenuPlugin) {
    this.subitemLineModelService = new SubitemLineModelService(plugin);
  }

  private shouldEnhanceLinkedSubitems(): boolean {
    return this.plugin.settings.enableLinkedSubitemCheckboxes || this.plugin.settings.showCustomPropertiesInInlineUi !== false;
  }

  private shouldRenderLinkedSubitemCheckboxes(model?: SubitemLineModel): boolean {
    if (this.plugin.settings.enableLinkedSubitemCheckboxes !== false) return true;
    return !!model?.hasExplicitStatus;
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

  private createReadingModeObserver(view: MarkdownView): MutationObserver {
    return new MutationObserver(() => {
      if (this.decoratingViews.has(view)) return;
      this.scheduleDecorate(view);
    });
  }

  private reconnectReadingModeObserver(view: MarkdownView): void {
    const root = view.contentEl;
    if (!root) return;
    const observer = this.observers.get(view);
    if (!observer) return;
    observer.disconnect();
    observer.observe(root, { childList: true, subtree: true });
  }

  ensureForView(view: MarkdownView): void {
    const file = view.file;
    if (!(file instanceof TFile) || file.extension !== 'md' || !this.shouldEnhanceLinkedSubitems()) {
      this.removeForView(view);
      return;
    }

    const mode = this.getLinkedSubitemRenderMode(view);
    logger.log('[TPS GCM] [LinkedSubitemTrace] ensureForView', {
      file: file.path,
      mode,
      observerPresent: this.observers.has(view),
      activeFile: this.plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null,
    });

    if (mode !== 'preview') {
      const observer = this.observers.get(view);
      if (observer) {
        observer.disconnect();
        this.observers.delete(view);
      }
      this.resetSelfHealAttempts(view);
      this.clearReadingModeDecorations(view);
      logger.log('[TPS GCM] [LinkedSubitemTrace] source-mode preserve-live-widgets', {
        file: file.path,
        mode,
      });
      return;
    }

    if (!this.observers.has(view)) {
      this.observers.set(view, this.createReadingModeObserver(view));
    }
    this.reconnectReadingModeObserver(view);

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
    const targetEl = evt.target instanceof HTMLElement ? evt.target : null;
    if (targetEl && await this.handleMissingLinkedSubitemInteraction(evt, targetEl)) {
      return true;
    }
    const pillEl = targetEl?.closest('.tps-gcm-linked-subitem-pill') as HTMLElement | null;
    if (pillEl) {
      return this.handlePropertyPillClick(evt, pillEl);
    }
    const customCheckboxEl = targetEl?.closest(`.${VIRTUAL_CHECKBOX_CLASS}`) as HTMLElement | null;
    if (customCheckboxEl) {
      return this.handleCustomCheckboxClick(evt, customCheckboxEl);
    }

    const customBulletEl = targetEl?.closest('.tps-gcm-linked-subitem-bullet-marker') as HTMLElement | null;
    if (customBulletEl) {
      return this.handleBulletClick(evt, customBulletEl);
    }

    const nativeBulletEl = targetEl?.closest('.list-bullet') as HTMLElement | null;
    if (nativeBulletEl) {
      const taskHost = nativeBulletEl.closest('.tps-gcm-linked-subitem-task.kind-bullet');
      if (taskHost instanceof HTMLElement) {
        return this.handleNativeBulletInSubitemLine(evt, taskHost);
      }
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

    await this.applyLinkedSubitemStatusChange(childFile, nextStatus);
    return true;
  }

  private async handleBulletClick(evt: MouseEvent, bulletEl: HTMLElement | null): Promise<boolean> {
    const childPath = bulletEl?.dataset.linkedSubitemPath;
    if (!childPath) return false;
    const childFile = this.plugin.app.vault.getFileByPath(childPath);
    if (!(childFile instanceof TFile)) return false;

    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();

    this.showLinkedSubitemStatusMenu(childFile, evt.clientX, evt.clientY);
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

    await this.applyLinkedSubitemStatusChange(childFile, nextStatus);
    this.scheduleDecorate(view);
    return true;
  }

  private async handleNativeBulletInSubitemLine(
    evt: MouseEvent,
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

    this.showLinkedSubitemStatusMenu(childFile, evt.clientX, evt.clientY);
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
    const targetEl = evt.target instanceof HTMLElement ? evt.target : null;
    if (targetEl && await this.handleMissingLinkedSubitemInteraction(evt, targetEl)) {
      return true;
    }
    const checkboxEl = targetEl?.closest(`.${VIRTUAL_CHECKBOX_CLASS}`) as HTMLElement | null;
    if (checkboxEl) {
      const childPath = checkboxEl.dataset.linkedSubitemPath;
      const parentPath = checkboxEl.dataset.linkedSubitemParent;
      if (!childPath || !parentPath) return false;

      const childFile = this.plugin.app.vault.getFileByPath(childPath);
      const parentFile = this.plugin.app.vault.getFileByPath(parentPath);
      if (!(childFile instanceof TFile) || !(parentFile instanceof TFile)) return false;

      evt.preventDefault();
      evt.stopPropagation();
      evt.stopImmediatePropagation();

      this.showLinkedSubitemStatusMenu(childFile, evt.clientX, evt.clientY);
      return true;
    }

    const customBulletEl = targetEl?.closest('.tps-gcm-linked-subitem-bullet-marker') as HTMLElement | null;
    if (customBulletEl) {
      return this.handleBulletClick(evt, customBulletEl);
    }

    const nativeBulletEl = targetEl?.closest('.list-bullet') as HTMLElement | null;
    if (nativeBulletEl) {
      const taskHost = nativeBulletEl.closest('.tps-gcm-linked-subitem-task.kind-bullet');
      if (taskHost instanceof HTMLElement) {
        return this.handleNativeBulletInSubitemLine(evt, taskHost);
      }
    }

    return false;
  }

  private async handleMissingLinkedSubitemInteraction(evt: MouseEvent, targetEl: HTMLElement): Promise<boolean> {
    const host = targetEl.closest(
      '.tps-gcm-linked-subitem-link, .tps-gcm-linked-subitem-row-content, .tps-gcm-linked-subitem-task, .tps-gcm-linked-subitem-pill, .tps-gcm-linked-subitem-checkbox, .tps-gcm-linked-subitem-bullet-marker',
    ) as HTMLElement | null;
    if (!(host instanceof HTMLElement)) return false;

    const childPath = host.dataset.linkedSubitemPath
      || host.closest<HTMLElement>('[data-linked-subitem-path]')?.dataset.linkedSubitemPath
      || '';
    if (!childPath) return false;

    const childFile = this.plugin.app.vault.getFileByPath(childPath);
    if (childFile instanceof TFile) return false;

    evt.preventDefault();
    evt.stopPropagation();
    evt.stopImmediatePropagation();

    const parentPath = host.dataset.linkedSubitemParent
      || host.closest<HTMLElement>('[data-linked-subitem-parent]')?.dataset.linkedSubitemParent
      || '';
    const parentFile = parentPath ? this.plugin.app.vault.getFileByPath(parentPath) : null;

    if (parentFile instanceof TFile) {
      await checkAndPromptForUnresolvedSubitems(this.plugin, parentFile);
      this.scheduleRefreshForParentFile(parentFile);
    } else {
      this.scheduleDecorateForActiveView();
      this.refreshLivePreviewEditors();
      new Notice('This linked subitem no longer exists.');
    }
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

    if (kind === 'status' || (propertyType === 'selector' && propertyKey === 'status')) {
      this.showLinkedSubitemStatusMenu(childFile, evt.clientX, evt.clientY);
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
        const fm = (entries[0]?.frontmatter || {}) as Record<string, unknown>;
        const actualKey = Object.keys(fm).find((key) => key.toLowerCase() === String(propertyKey || '').toLowerCase());
        const currentRawValue = actualKey ? fm[actualKey] : undefined;
        const currentValue = String(currentRawValue ?? '').trim();
        const hasPropertyKey = !!actualKey;
        const isEmptyValue = hasPropertyKey && (currentRawValue === '' || currentRawValue === null || currentRawValue === undefined);
        const menu = new Menu();
        menu.addItem((item) => {
          item
            .setTitle('(none)')
            .setChecked(!hasPropertyKey)
            .onClick(async () => {
              await this.plugin.bulkEditService.removeFrontmatterKey([childFile], propertyKey);
              await this.refreshReferencesForChild(childFile);
              this.triggerLinkedSubitemRenderRefresh();
            });
        });
        menu.addItem((item) => {
          item
            .setTitle('(empty)')
            .setChecked(isEmptyValue)
            .onClick(async () => {
              await this.plugin.bulkEditService.updateFrontmatter([childFile], { [propertyKey]: '' });
              await this.refreshReferencesForChild(childFile);
              this.triggerLinkedSubitemRenderRefresh();
            });
        });
        menu.addSeparator();
        for (const option of options) {
          menu.addItem((item) => {
            item.setTitle(option);
            if (currentValue === option) item.setChecked(true);
            item.onClick(async () => {
              await this.plugin.bulkEditService.updateFrontmatter([childFile], { [propertyKey]: option });
              await this.refreshReferencesForChild(childFile);
              this.triggerLinkedSubitemRenderRefresh();
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
    if (!(activeView instanceof MarkdownView) || !(activeFile instanceof TFile) || activeFile.extension !== 'md' || !this.shouldEnhanceLinkedSubitems()) return;
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

  private scheduleSelfHeal(view: MarkdownView, reason: string, delay = 120): void {
    const attempts = this.selfHealAttempts.get(view) ?? 0;
    if (attempts >= 3) {
      logger.warn('[TPS GCM] [SelfHeal] giving up after repeated retries', {
        file: view.file?.path ?? null,
        reason,
        attempts,
      });
      return;
    }

    this.selfHealAttempts.set(view, attempts + 1);
    logger.warn('[TPS GCM] [SelfHeal] scheduling retry', {
      file: view.file?.path ?? null,
      reason,
      attempt: attempts + 1,
      delay,
    });

    const existing = this.refreshTimers.get(view);
    if (existing != null) window.clearTimeout(existing);
    const timer = window.setTimeout(() => {
      this.refreshTimers.delete(view);
      this.decorateView(view);
    }, Math.max(0, delay));
    this.refreshTimers.set(view, timer);
  }

  private resetSelfHealAttempts(view: MarkdownView): void {
    this.selfHealAttempts.delete(view);
  }

  private scheduleDecorateForActiveView(): void {
    const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (!(activeView instanceof MarkdownView)) return;
    if (this.getLinkedSubitemRenderMode(activeView) !== 'preview') return;
    this.scheduleDecorate(activeView);
  }

  private clearReadingModeDecorations(view: MarkdownView): void {
    const previewContainer = this.getVisiblePreviewContainer(view);
    if (!(previewContainer instanceof HTMLElement)) return;
    logger.log('[TPS GCM] [LinkedSubitemTrace] clearReadingModeDecorations', {
      file: view.file?.path ?? null,
      previewTag: previewContainer.tagName,
      previewClasses: previewContainer.className,
      pillsCount: previewContainer.querySelectorAll('.tps-gcm-linked-subitem-pills').length,
      rowCount: previewContainer.querySelectorAll('.tps-gcm-linked-subitem-row-content').length,
    });

    previewContainer.querySelectorAll<HTMLElement>('.tps-gcm-linked-subitem-replaced').forEach((el) => {
      const originalHtml = el.dataset.tpsGcmOriginalHtml;
      if (typeof originalHtml === 'string') {
        el.innerHTML = originalHtml;
        delete el.dataset.tpsGcmOriginalHtml;
      }
      el.classList.remove('tps-gcm-linked-subitem-replaced');
    });

    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-pill').forEach((el) => el.remove());
    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-checkbox').forEach((el) => el.remove());
    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-row-content').forEach((el) => el.remove());
    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-task').forEach((el) => {
      el.classList.remove('tps-gcm-linked-subitem-task', 'is-open', 'is-complete', 'is-canceled', 'is-working', 'kind-checkbox', 'kind-bullet', 'kind-bare', 'kind-heading');
      delete (el as HTMLElement).dataset.linkedSubitemKind;
    });
    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-link').forEach((el) => {
      el.classList.remove('tps-gcm-linked-subitem-link');
    });
    previewContainer.querySelectorAll('.tps-gcm-hidden-native-link').forEach((el) => {
      el.classList.remove('tps-gcm-hidden-native-link');
    });
    previewContainer.querySelectorAll('.tps-gcm-linked-subitem-checkbox-hidden').forEach((el) => {
      el.classList.remove('tps-gcm-linked-subitem-checkbox-hidden');
      if (el instanceof HTMLInputElement) {
        el.style.display = '';
      }
    });
  }

  private clearDecorations(view: MarkdownView): void {
    const root = view.contentEl;
    if (!root) return;
    const mode = this.getLinkedSubitemRenderMode(view);
    if (mode === 'source') {
      logger.log('[TPS GCM] [LinkedSubitemTrace] clearDecorations skipped in source mode', {
        file: view.file?.path ?? null,
      });
      return;
    }
    const previewContainer = this.getVisiblePreviewContainer(view) || root;
    logger.log('[TPS GCM] [LinkedSubitemTrace] clearDecorations', {
      file: view.file?.path ?? null,
      mode,
      previewTag: previewContainer.tagName,
      previewClasses: (previewContainer as HTMLElement).className,
      pillsCount: previewContainer.querySelectorAll('.tps-gcm-linked-subitem-pills').length,
      rowCount: previewContainer.querySelectorAll('.tps-gcm-linked-subitem-row-content').length,
      replacedCount: previewContainer.querySelectorAll('.tps-gcm-linked-subitem-replaced').length,
    });
    if (!(previewContainer instanceof HTMLElement)) return;

    previewContainer.querySelectorAll<HTMLElement>('.tps-gcm-linked-subitem-replaced').forEach((el) => {
      const originalHtml = el.dataset.tpsGcmOriginalHtml;
      if (typeof originalHtml === 'string') {
        el.innerHTML = originalHtml;
        delete el.dataset.tpsGcmOriginalHtml;
      }
      el.classList.remove('tps-gcm-linked-subitem-replaced');
    });

    this.clearReadingModeDecorations(view);
  }

  private hasRenderedLinkedSubitems(view: MarkdownView): boolean {
    const root = view.contentEl;
    if (!root) return false;
    return !!root.querySelector(
      '.tps-gcm-linked-subitem-task, .tps-gcm-linked-subitem-row-content, .tps-gcm-linked-subitem-replaced',
    );
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
      this.resetSelfHealAttempts(view);
      this.clearDecorations(view);
      return;
    }

    if (this.decoratingViews.has(view)) {
      return;
    }

    this.decoratingViews.add(view);
    const observer = this.observers.get(view);
    observer?.disconnect();
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
        const model = this.subitemLineModelService.buildModel(parsed, childFile, file, lines[i]);
        if (parsed.kind === 'checkbox' && !model.hasExplicitStatus) {
          this.queueClearedStatusSync(childFile);
        }
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
        this.scheduleSelfHeal(view, 'reading-mode line mapping produced zero matches');
        return;
      }

      if (lineToElement.size < subitemEntries.size) {
        logger.warn('[TPS GCM] [LinkedSubitem] partial reading mode line mapping', {
          file: file.path,
          matchedCount: lineToElement.size,
          expectedCount: subitemEntries.size,
          missingLines: Array.from(subitemEntries.keys()).filter((lineNum) => !lineToElement.has(lineNum)),
        });
      }

      this.clearDecorations(view);
      
      // Now decorate each matched element
      let hadValidationFailure = false;
      for (const [lineNum, entry] of subitemEntries) {
        const li = lineToElement.get(lineNum);
        if (!li) {
          logger.log('[TPS GCM] [LinkedSubitem] no element for line', { lineNum, line: lines[lineNum] });
          hadValidationFailure = true;
          continue;
        }
        
        const { parsed, childFile, model } = entry;
        const renderPlan = this.buildRenderPlan('reading', model, {
          lineNumber: lineNum,
          sourceLine: lines[lineNum] ?? '',
          sourceIndent: this.getLeadingIndentInfo(lines[lineNum] ?? ''),
        });
        logger.log('[TPS GCM] [RenderPlan] reading', renderPlan);
        
        const elements = buildLinkedSubitemRow(
          model,
          () => {},
          () => {},
          () => {},
          (evt, pill) => {
            void this.handlePropertyPillClick(evt, this.findPillElement(elements.pillsContainer, pill));
          },
          { includeCheckbox: false, includeBulletMarker: false },
        );

        logger.log('[TPS GCM] [DIAG] reading-mode rendered pills before insert', {
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

        this.logReadingModeHostDiagnostics(file.path, childFile.path, lineNum, li, elements.pillsContainer);
        this.injectReadingModePillsWidget(li, childFile, model, elements.pillsContainer);
        const validation = this.validateReadingModeReplacement(li, model, renderPlan);
        logger.log('[TPS GCM] [RenderResult] reading', validation);
        if (!validation.ok) {
          hadValidationFailure = true;
        }
      }

      if (hadValidationFailure) {
        this.scheduleSelfHeal(view, 'reading-mode replacement validation failed');
      } else {
        this.resetSelfHealAttempts(view);
      }
    } finally {
      if (this.getLinkedSubitemRenderMode(view) === 'preview') {
        this.reconnectReadingModeObserver(view);
      }
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
          logger.log('[TPS GCM] [SectionMap] reading host candidate', {
            line,
            sectionTag: el.tagName,
            sectionClasses: el.className,
            hostTag: host.tagName,
            hostClasses: host.className,
            hostText: this.getListItemText(host),
          });
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
      mappedLines: Array.from(result.keys()),
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
    const target = li.matches('li') ? li : (li.closest('li') as HTMLElement | null) ?? li;
    const preservedNodes = Array.from(target.children).filter((child) => child.matches('ul, ol, .list-bullet'));
    logger.log('[TPS GCM] [DIAG] replaceListContent before', {
      lineKind,
      originalChildNodeCount: target.childNodes.length,
      originalElementChildCount: target.childElementCount,
      originalHtml: target.innerHTML,
      nestedListCount: preservedNodes.filter((child) => child.matches('ul, ol')).length,
      preservedNodeTags: preservedNodes.map((child) => child.tagName),
      customContentPillCount: customContent.querySelectorAll('.tps-gcm-linked-subitem-pill').length,
    });

    if (!target.dataset.tpsGcmOriginalHtml) {
      target.dataset.tpsGcmOriginalHtml = target.innerHTML;
    }

    for (const preservedNode of preservedNodes) {
      preservedNode.remove();
    }
    while (target.firstChild) {
      target.removeChild(target.firstChild);
    }

    for (const preservedNode of preservedNodes) {
      if (preservedNode.matches('.list-bullet')) {
        target.appendChild(preservedNode);
      }
    }

    target.appendChild(customContent);

    for (const preservedNode of preservedNodes) {
      if (preservedNode.matches('ul, ol')) {
        target.appendChild(preservedNode);
      }
    }

    target.classList.add('tps-gcm-linked-subitem-replaced');

    logger.log('[TPS GCM] [DIAG] replaceListContent after', {
      lineKind,
      finalChildNodeCount: target.childNodes.length,
      finalElementChildCount: target.childElementCount,
      finalHtml: target.innerHTML,
      renderedPillCount: target.querySelectorAll('.tps-gcm-linked-subitem-pill').length,
    });
  }

  private buildRenderPlan(
    mode: 'reading' | 'live-preview',
    model: SubitemLineModel,
    context: {
      lineNumber: number;
      sourceLine: string;
      sourceIndent: { whitespace: string; depth: number; visualColumns: number };
    },
  ): Record<string, unknown> {
    const includeCheckbox = this.shouldRenderLinkedSubitemCheckboxes(model) && (mode === 'reading'
      ? shouldRenderReadingModeLeadingControl(model)
      : shouldRenderLivePreviewLeadingControl(model));
    const includeBulletMarker = mode === 'live-preview' && model.kind === 'bullet';

    return {
      mode,
      parentFile: model.parentFile.path,
      childFile: model.childFile.path,
      lineNumber: context.lineNumber,
      lineKind: model.kind,
      sourceLine: context.sourceLine,
      sourceIndentDepth: context.sourceIndent.depth,
      sourceIndentColumns: context.sourceIndent.visualColumns,
      sourceIndentWhitespace: context.sourceIndent.whitespace.replace(/\t/g, '\\t'),
      linkTarget: model.linkTarget,
      displayLabel: model.displayLabel,
      hasExplicitStatus: model.hasExplicitStatus,
      effectiveCheckboxState: model.checkboxState,
      effectiveVisualState: model.visualState,
      includeCheckbox,
      includeBulletMarker,
      pillCount: model.pills.length,
      pillKinds: model.pills.map((pill) => pill.kind),
    };
  }

  private getLeadingIndentInfo(line: string): { whitespace: string; depth: number; visualColumns: number } {
    const whitespace = String(line || '').match(/^[\t ]*/)?.[0] ?? '';
    const visualColumns = whitespace.split('').reduce((total, char) => total + (char === '\t' ? 2 : 1), 0);
    return {
      whitespace,
      depth: whitespace.length,
      visualColumns,
    };
  }

  private validateReadingModeReplacement(
    li: HTMLElement,
    model: SubitemLineModel,
    renderPlan: Record<string, unknown>,
  ): Record<string, unknown> {
    const link = this.findReadingModeNativeLink(li, model.childFile, model.displayLabel);
    const pills = li.querySelector('.tps-gcm-linked-subitem-pills') as HTMLElement | null;
    const nestedListCount = Array.from(li.children).filter((child) => child.matches('ul, ol')).length;
    const nativeBullet = li.querySelector(':scope > .list-bullet') as HTMLElement | null;
    const expectedLabel = String(model.displayLabel || model.childFile.basename || model.childFile.name || '').trim()
      || model.childFile.basename;
    const renderedLabel = String(link?.textContent?.trim() || '');

    const ok = Boolean(
      link &&
      pills &&
      renderedLabel === expectedLabel &&
      nestedListCount >= 0,
    );

    return {
      ...renderPlan,
      ok,
      hostTag: li.tagName,
      hostClasses: li.className,
      hasLink: !!link,
      hasPills: !!pills,
      renderedLabel,
      expectedLabel,
      nativeBulletStillPresent: !!nativeBullet,
      nestedListCount,
      hostHtml: li.innerHTML,
    };
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

  private injectReadingModePillsWidget(
    li: HTMLElement,
    childFile: TFile,
    model: SubitemLineModel,
    pillsContainer: HTMLElement,
  ): void {
    const host = this.normalizeReadingModeHostElement(li) ?? li;
    const isHeading = /^H[1-6]$/.test(host.tagName);
    const renderLeadingControl = this.shouldRenderLinkedSubitemCheckboxes(model) && shouldRenderReadingModeLeadingControl(model);
    const renderedKind = renderLeadingControl && model.kind !== 'heading' ? 'checkbox' : model.kind;
    const nativeLink = this.findReadingModeNativeLink(host, childFile, model.displayLabel);
    if (!nativeLink) {
      logger.warn('[TPS GCM] [LinkedSubitemTrace] reading insert skipped', {
        parentFile: model.parentFile.path,
        childFile: childFile.path,
        hostTag: host.tagName,
        hostClasses: host.className,
        hostHtml: host.innerHTML,
        reason: 'native-link-not-found',
      });
      return;
    }

    host.classList.add('tps-gcm-linked-subitem-task', `kind-${renderedKind}`);
    host.classList.remove('kind-bare', 'kind-bullet', 'kind-checkbox', 'kind-heading');
    host.classList.add(`kind-${renderedKind}`);
    host.dataset.linkedSubitemKind = renderedKind;

    if (renderLeadingControl) {
      const existingCheckbox = host.querySelector(':scope > .tps-gcm-linked-subitem-checkbox');
      if (existingCheckbox) existingCheckbox.remove();

      const checkboxInput = document.createElement('input');
      checkboxInput.type = 'checkbox';
      checkboxInput.tabIndex = -1;
      checkboxInput.className = `tps-gcm-linked-subitem-checkbox state-${model.visualState}${isHeading ? ' is-heading' : ''}`;
      const state = model.checkboxState || '[ ]';
      checkboxInput.setAttribute('aria-label', 'Toggle linked subitem status');
      checkboxInput.dataset.linkedSubitemPath = childFile.path;
      checkboxInput.dataset.linkedSubitemParent = model.parentFile.path;
      checkboxInput.dataset.linkedSubitemState = state;
      checkboxInput.checked = /[xX]/.test(state);
      checkboxInput.indeterminate = state.includes('?') || state.includes('-') || state.includes('/');
      checkboxInput.addEventListener('mousedown', (evt) => { evt.preventDefault(); evt.stopPropagation(); });
      checkboxInput.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        void this.handleCustomCheckboxClick(evt, checkboxInput);
      });
      host.insertBefore(checkboxInput, nativeLink);
    }

    const existing = host.querySelector(':scope .tps-gcm-linked-subitem-pills');
    if (existing) {
      logger.log('[TPS GCM] [LinkedSubitemTrace] reading remove-existing-pills', {
        parentFile: model.parentFile.path,
        childFile: childFile.path,
        existingHtml: (existing as HTMLElement).outerHTML,
      });
      existing.remove();
    }

    nativeLink.insertAdjacentText('afterend', ' ');
    nativeLink.insertAdjacentElement('afterend', pillsContainer);
    logger.log('[TPS GCM] [LinkedSubitemTrace] reading insert complete', {
      parentFile: model.parentFile.path,
      childFile: childFile.path,
      label: model.displayLabel,
      nativeLinkText: nativeLink.textContent?.trim() ?? '',
      nativeLinkHref: nativeLink.getAttribute('href') || '',
      pillCount: pillsContainer.querySelectorAll('.tps-gcm-linked-subitem-pill').length,
      hostHtml: host.innerHTML,
    });
  }

  private findReadingModeNativeLink(
    li: HTMLElement,
    childFile: TFile,
    displayLabel: string,
  ): HTMLAnchorElement | null {
    const scope = this.normalizeReadingModeHostElement(li) ?? li;
    const candidates = Array.from(scope.querySelectorAll<HTMLAnchorElement>('a.internal-link, a'));
    logger.log('[TPS GCM] [LinkedSubitemTrace] reading link candidates', {
      childFile: childFile.path,
      displayLabel,
      candidateCount: candidates.length,
      candidates: candidates.map((anchor) => ({
        text: String(anchor.textContent || '').trim(),
        href: anchor.getAttribute('href') || '',
        classes: anchor.className,
      })),
    });
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
        logger.log('[TPS GCM] [LinkedSubitemTrace] reading link candidate matched', {
          childFile: childFile.path,
          href,
          text,
        });
        return anchor;
      }
    }

    logger.log('[TPS GCM] [LinkedSubitemTrace] reading link fallback-first', {
      childFile: childFile.path,
      fallbackText: String(candidates[0]?.textContent || '').trim(),
      fallbackHref: candidates[0]?.getAttribute('href') || '',
    });
    return candidates[0];
  }

  private normalizeReadingModeHostElement(el: HTMLElement | null | undefined): HTMLElement | null {
    if (!(el instanceof HTMLElement)) return null;
    if (el.matches('li.task-list-item, li')) return el;

    const descendantListHost = el.querySelector<HTMLElement>('li.task-list-item, li');
    if (descendantListHost) return descendantListHost;

    const ancestorListHost = el.closest<HTMLElement>('li.task-list-item, li');
    if (ancestorListHost) return ancestorListHost;

    if (el.matches('h1, h2, h3, h4, h5, h6')) return el;

    const descendantHeading = el.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6');
    if (descendantHeading) return descendantHeading;

    const ancestorHeading = el.closest<HTMLElement>('h1, h2, h3, h4, h5, h6');
    if (ancestorHeading) return ancestorHeading;

    if (el.matches('p')) return el;

    const descendantHost = el.querySelector<HTMLElement>('p');
    if (descendantHost) return descendantHost;

    const ancestorHost = el.closest<HTMLElement>('p');
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
    await this.applyLinkedSubitemStatusChange(file, normalizedStatus);
  }

  private async clearLinkedSubitemStatusKey(file: TFile): Promise<void> {
    const statusKey = this.getStatusKey();
    await this.plugin.bulkEditService.removeFrontmatterKey([file], statusKey);
    await this.syncClearedStatusAcrossParents(file);
    new Notice(`Cleared "${statusKey}" on "${file.basename}".`);
  }

  private async setLinkedSubitemStatusEmpty(file: TFile): Promise<void> {
    const statusKey = this.getStatusKey();
    await this.plugin.bulkEditService.updateFrontmatter([file], { [statusKey]: '' });
    await this.syncClearedStatusAcrossParents(file);
    new Notice(`Set "${statusKey}" empty on "${file.basename}".`);
  }

  private async applyLinkedSubitemStatusChange(file: TFile, normalizedStatus: string): Promise<void> {
    if (normalizedStatus === 'complete' || normalizedStatus === 'wont-do') {
      await this.plugin.timeTrackingService.stopFirstRunningTimer(file);
    }
    await this.plugin.bulkEditService.setStatus([file], normalizedStatus);
    await this.syncCheckboxStateAcrossParents(file, normalizedStatus);
    await this.refreshReferencesForChild(file);
    this.triggerLinkedSubitemRenderRefresh();
    new Notice(`Set "${file.basename}" to ${normalizedStatus}.`);
  }

  private showLinkedSubitemStatusMenu(childFile: TFile, x: number, y: number): void {
    const statuses = this.getStatusOptions();
    const currentStatus = this.getNormalizedStatus(childFile);
    const statusKey = this.getStatusKey();
    const childFrontmatter = (this.plugin.app.metadataCache.getFileCache(childFile)?.frontmatter || {}) as Record<string, unknown>;
    const actualStatusKey = Object.keys(childFrontmatter).find((key) => key.toLowerCase() === statusKey.toLowerCase());
    const hasStatusKey = !!actualStatusKey;
    const currentRawStatus = actualStatusKey ? childFrontmatter[actualStatusKey] : undefined;
    const isEmptyStatus = hasStatusKey && (currentRawStatus === '' || currentRawStatus === null || currentRawStatus === undefined);

    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle('(none)')
        .setChecked(!hasStatusKey)
        .onClick(() => {
          void this.clearLinkedSubitemStatusKey(childFile);
        });
    });
    menu.addItem((item) => {
      item
        .setTitle('(empty)')
        .setChecked(isEmptyStatus)
        .onClick(() => {
          void this.setLinkedSubitemStatusEmpty(childFile);
        });
    });
    if (statuses.length > 0) menu.addSeparator();
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
    menu.showAtPosition({ x, y });
  }

  async syncClearedStatusAcrossParents(childFile: TFile): Promise<void> {
    await this.convertChecklistLinksToBulletForChild(childFile);
    await this.refreshReferencesForChild(childFile);
    this.triggerLinkedSubitemRenderRefresh();
  }

  async syncCheckboxStateAcrossParents(childFile: TFile, status: string): Promise<void> {
    const checkboxState = this.mapStatusToCheckboxState(status);
    if (!checkboxState) return;

    const references = await this.plugin.subitemReferenceIndexService.getReferencesForChild(childFile);
    const parentPaths = Array.from(new Set(references.map((entry) => String(entry.parentPath || '').trim()).filter(Boolean)));
    for (const parentPath of parentPaths) {
      const parentFile = this.plugin.app.vault.getFileByPath(parentPath);
      if (!(parentFile instanceof TFile)) continue;
      await this.plugin.subitemRelationshipSyncService.mutateMarkdownBody(parentFile, async (lines) => {
        let changed = false;
        for (let i = 0; i < lines.length; i += 1) {
          const raw = String(lines[i] || '');
          const parsed = this.plugin.bodySubitemLinkService.parseLine(raw);
          if (!parsed || (parsed.kind !== 'checkbox' && parsed.kind !== 'bullet' && parsed.kind !== 'heading')) continue;
          const resolved = this.resolveLinkedFile(parsed.linkTarget, parentFile.path);
          if (!(resolved instanceof TFile) || resolved.path !== childFile.path) continue;
          let nextLine = raw;
          if (parsed.kind === 'checkbox') {
            nextLine = raw.replace(
              CheckboxPatterns.CHECKBOX_LINE_CAPTURE,
              (_match, prefix, _state, text) => `${prefix}[${checkboxState}] ${text || ''}`.replace(/\s+$/, ' ')
            );
          } else if (parsed.kind === 'bullet') {
            const bulletPrefix = raw.match(CheckboxPatterns.TASK_LINE);
            if (bulletPrefix) {
              const prefix = bulletPrefix[0];
              nextLine = `${prefix}${checkboxState} ${raw.slice(prefix.length)}`;
            }
          }
          if (nextLine !== raw) {
            lines[i] = nextLine;
            changed = true;
          }
        }
        return changed;
      });
    }
  }

  private queueClearedStatusSync(childFile: TFile): void {
    const key = childFile.path;
    if (this.pendingClearedStatusSyncs.has(key)) return;
    this.pendingClearedStatusSyncs.add(key);
    window.setTimeout(() => {
      void this.syncClearedStatusAcrossParents(childFile)
        .catch((error) => {
          logger.warn('[TPS GCM] Failed queued cleared-status sync', {
            childFile: childFile.path,
            error,
          });
        })
        .finally(() => {
          this.pendingClearedStatusSyncs.delete(key);
        });
    }, 0);
  }

  async convertChecklistLinksToBulletForChild(childFile: TFile): Promise<void> {
    const references = await this.plugin.subitemReferenceIndexService.getReferencesForChild(childFile);
    const parentPaths = Array.from(
      new Set(
        references
          .map((entry) => String(entry.parentPath || '').trim())
          .filter(Boolean),
      ),
    );
    for (const parentPath of parentPaths) {
      const parentFile = this.plugin.app.vault.getFileByPath(parentPath);
      if (!(parentFile instanceof TFile)) continue;
      await this.plugin.subitemRelationshipSyncService.mutateMarkdownBody(parentFile, async (lines) => {
        let changed = false;
        for (let i = 0; i < lines.length; i += 1) {
          const raw = String(lines[i] || '');
          const parsed = this.plugin.bodySubitemLinkService.parseLine(raw);
          if (!parsed || parsed.kind !== 'checkbox') continue;
          const resolved = this.resolveLinkedFile(parsed.linkTarget, parentFile.path);
          if (!(resolved instanceof TFile) || resolved.path !== childFile.path) continue;
          const bulletLine = raw.replace(CheckboxPatterns.CHECKBOX_LINE_CAPTURE, (_match, prefix, _state, text) => `${prefix}${text}`);
          if (bulletLine !== raw) {
            lines[i] = bulletLine;
            changed = true;
          }
        }
        return changed;
      });
    }
  }

  private triggerLinkedSubitemRenderRefresh(): void {
    this.scheduleDecorateForActiveView();
    this.refreshLivePreviewEditors();
    // Metadata cache/frontmatter updates can lag one tick; run a second pass.
    window.setTimeout(() => {
      this.scheduleDecorateForActiveView();
      this.refreshLivePreviewEditors();
    }, 180);
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
        lastPotentialCount = 0;
        lastDocLength = 0;
        initialized = false;

        constructor(view: EditorView) {
          const result = service.buildEditorDecorations(view);
          this.decorations = result.decorations;
          this.lastMatchCount = result.matchCount;
          this.lastPotentialCount = result.potentialCount;
          this.lastDocLength = view.state.doc.length;
          this.initialized = true;
        }

        update(update: ViewUpdate) {
          const hasRefreshEffect = update.transactions.some((tr) =>
            tr.effects.some((effect) => effect.is(refreshLinkedSubitemEffect))
          );
          
          // SAFETY: Treat a fresh rebuild as authoritative even when it returns
          // zero matches. Keeping stale decorations is what causes ghost rows in
          // plain source mode and partially broken rows after focus/mode churn.
          if (update.docChanged) {
            const result = service.buildEditorDecorations(update.view);
            if (service.shouldKeepExistingEditorDecorations(update.view, result, this.lastMatchCount, this.lastPotentialCount, this.lastDocLength)) {
              service.scheduleEditorRefresh(update.view, 90);
              return;
            }
            this.decorations = result.decorations;
            this.lastMatchCount = result.matchCount;
            this.lastPotentialCount = result.potentialCount;
            this.lastDocLength = update.state.doc.length;
            return;
          }

          if (hasRefreshEffect) {
            const result = service.buildEditorDecorations(update.view);
            if (service.shouldKeepExistingEditorDecorations(update.view, result, this.lastMatchCount, this.lastPotentialCount, this.lastDocLength)) {
              service.scheduleEditorRefresh(update.view, 90);
              return;
            }
            this.decorations = result.decorations;
            this.lastMatchCount = result.matchCount;
            this.lastPotentialCount = result.potentialCount;
            this.lastDocLength = update.state.doc.length;
            return;
          }
          
          // Rebuild on viewport changes while visible so newly exposed lines and
          // cleared rows stay in sync as the editor reflows.
          if (update.viewportChanged && this.initialized) {
            const result = service.buildEditorDecorations(update.view);
            if (service.shouldKeepExistingEditorDecorations(update.view, result, this.lastMatchCount, this.lastPotentialCount, this.lastDocLength)) {
              service.scheduleEditorRefresh(update.view, 90);
              return;
            }
            this.decorations = result.decorations;
            this.lastMatchCount = result.matchCount;
            this.lastPotentialCount = result.potentialCount;
            this.lastDocLength = update.state.doc.length;
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
   * Important: only append a widget after the native wikilink token. Do not
   * replace text, list markers, or checkboxes.
   */
  private buildEditorDecorations(view: EditorView): {
    decorations: DecorationSet;
    matchCount: number;
    potentialCount: number;
    filePath: string | null;
  } {
    const markdownView = this.resolveMarkdownViewForEditor(view);
    const parentFile = markdownView?.file;

    if (!this.shouldEnhanceLinkedSubitems()) {
      return { decorations: Decoration.none, matchCount: 0, potentialCount: 0, filePath: null };
    }
    if (!(markdownView instanceof MarkdownView) || !(parentFile instanceof TFile)) {
      return { decorations: Decoration.none, matchCount: 0, potentialCount: 0, filePath: parentFile instanceof TFile ? parentFile.path : null };
    }
    if (!this.isLivePreviewEditorVisible(markdownView)) {
      return { decorations: Decoration.none, matchCount: 0, potentialCount: 0, filePath: parentFile.path };
    }

    const builder = new RangeSetBuilder<Decoration>();
    let matchCount = 0;
    let potentialCount = 0;
    let hadRecoverableFailure = false;

    for (const lineNumber of this.getVisibleLineNumbers(view)) {
        const line = view.state.doc.line(lineNumber);
        const parsed = this.plugin.bodySubitemLinkService.parseLine(line.text);
        if (parsed) {
          potentialCount++;
          const childFile = this.resolveLinkedFile(parsed.linkTarget, parentFile.path);
          if (childFile instanceof TFile) {
            const model = this.subitemLineModelService.buildModel(parsed, childFile, parentFile, line.text);
            if (parsed.kind === 'checkbox' && !model.hasExplicitStatus) {
              this.queueClearedStatusSync(childFile);
            }
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
            
            if (this.lineHasRangeSelection(view, line.from, line.to)) {
               continue;
            }
            
            const linkOffset = line.text.indexOf(parsed.wikilink);
            if (linkOffset < 0) {
              logger.warn('[TPS GCM] [RenderSkip] live-preview wikilink offset missing', {
                parentFile: parentFile.path,
                childFile: childFile.path,
                lineNumber: line.number,
                lineText: line.text,
                wikilink: parsed.wikilink,
              });
              hadRecoverableFailure = true;
              continue;
            }

            const replaceFrom = line.from + linkOffset;
            const replaceTo = replaceFrom + parsed.wikilink.length;

            const docLength = view.state.doc.length;
            const safeReplaceFrom = Math.max(line.from, Math.min(replaceFrom, line.to));
            const safeReplaceTo = Math.max(safeReplaceFrom, Math.min(replaceTo, line.to));
            
            if (safeReplaceTo > docLength || safeReplaceFrom < 0) {
              logger.warn('[TPS GCM] [RenderSkip] live-preview invalid insert position', {
                parentFile: parentFile.path,
                childFile: childFile.path,
                lineNumber: line.number,
                lineText: line.text,
                replaceFrom: safeReplaceFrom,
                replaceTo: safeReplaceTo,
                lineFrom: line.from,
                lineTo: line.to,
                docLength,
                kind: model.kind,
              });
              hadRecoverableFailure = true;
              continue;
            }

            this.logLivePreviewRenderDecision(
              parentFile.path,
              childFile.path,
              line.number,
              line.text,
              model,
              safeReplaceFrom,
              safeReplaceTo,
            );
            
            const widget = new LinkedSubitemPillsWidget(
              model,
              (evt, pill) => {
                void this.handlePropertyPillClick(
                  evt,
                  (evt.target as HTMLElement).closest('.tps-gcm-linked-subitem-pill') as HTMLElement,
                );
              },
              () => {
                this.placeCursorAtVisibleTaskEnd(view, safeReplaceTo);
              },
            );

            builder.add(
              safeReplaceTo,
              safeReplaceTo,
              Decoration.widget({
                widget,
                side: 1,
                inclusive: false,
              }),
            );

            if (parsed.kind === 'heading') {
              builder.add(
                line.from,
                line.from,
                Decoration.line({
                  class: `tps-gcm-linked-subitem-task kind-heading ${model.visualStateClass}`,
                }),
              );
            }
            logger.log('[TPS GCM] [LinkedSubitemTrace] live widget added', {
              parentFile: parentFile.path,
              childFile: childFile.path,
              lineNumber: line.number,
              lineFrom: line.from,
              lineTo: line.to,
              linkOffset,
              widgetInsertAt: safeReplaceTo,
              wikilink: parsed.wikilink,
              pillCount: model.pills.length,
              lineText: line.text,
            });
            this.logLivePreviewLineDiagnostics(parentFile.path, childFile.path, line.number, view, line.from, line.to);
          }
        }
    }
    
    logger.log('[TPS GCM] [LinkedSubitemCM] decoration build', {
      file: parentFile.path,
      matchCount,
      potentialCount,
      visibleRanges: view.visibleRanges.length,
      hadRecoverableFailure,
    });

    if (hadRecoverableFailure && potentialCount > 0 && matchCount > 0) {
      this.scheduleEditorRefresh(view, 120);
    }
    
    // SAFETY: Always return fresh decorations - never cache or reuse stale decorations.
    // This prevents "RangeError: Invalid position" errors when document changes.
    return {
      decorations: builder.finish(),
      matchCount,
      potentialCount,
      filePath: parentFile.path,
    };
  }

  private getVisibleLineNumbers(view: EditorView): number[] {
    const doc = view.state.doc;
    const maxLine = doc.lines;
    if (maxLine <= 0) return [];

    const lineNumbers = new Set<number>();
    const overscan = 2;
    const ranges = Array.isArray(view.visibleRanges) && view.visibleRanges.length > 0
      ? view.visibleRanges
      : [{ from: 0, to: doc.length }];

    for (const range of ranges) {
      const safeFrom = Math.max(0, Math.min(range.from, doc.length));
      const safeTo = Math.max(safeFrom, Math.min(range.to, doc.length));
      const startLine = Math.max(1, doc.lineAt(safeFrom).number - overscan);
      const endLine = Math.min(maxLine, doc.lineAt(safeTo).number + overscan);
      for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
        lineNumbers.add(lineNumber);
      }
    }

    return Array.from(lineNumbers).sort((a, b) => a - b);
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
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const markdownView = leaf.view;
      if (!(markdownView instanceof MarkdownView)) continue;
      if (this.getLinkedSubitemRenderMode(markdownView) !== 'source') continue;
      const cm = (markdownView.editor as any)?.cm as EditorView | undefined;
      if (!cm || typeof cm.dispatch !== 'function') continue;
      try {
        cm.dispatch({ effects: refreshLinkedSubitemEffect.of(Date.now()) });
      } catch {
        // Ignore stale editors during workspace churn.
      }
    }
  }

  private scheduleEditorRefresh(editorView: EditorView, delayMs = 90): void {
    window.setTimeout(() => {
      try {
        editorView.dispatch({ effects: refreshLinkedSubitemEffect.of(Date.now()) });
      } catch {
        // Ignore stale editors during workspace churn.
      }
    }, Math.max(0, delayMs));
  }

  private placeCursorAtVisibleTaskEnd(view: EditorView, position: number): void {
    const docLength = view.state.doc.length;
    const safePosition = Math.max(0, Math.min(position, docLength));
    window.setTimeout(() => {
      try {
        view.dispatch({
          selection: { anchor: safePosition, head: safePosition },
          scrollIntoView: true,
        });
        view.focus();
      } catch {
        // Ignore stale editors during workspace churn.
      }
    }, 0);
  }

  private logReadingModeHostDiagnostics(
    parentPath: string,
    childPath: string,
    lineNumber: number,
    host: HTMLElement,
    row: HTMLElement,
  ): void {
    const computed = window.getComputedStyle(host);
    const rect = host.getBoundingClientRect();
    logger.log('[TPS GCM] [DIAG] reading-mode host layout', {
      parentFile: parentPath,
      childFile: childPath,
      lineNumber,
      hostTag: host.tagName,
      hostClasses: host.className,
      childElementCount: host.childElementCount,
      rectTop: Math.round(rect.top),
      rectHeight: Math.round(rect.height),
      rectLeft: Math.round(rect.left),
      rectWidth: Math.round(rect.width),
      marginTop: computed.marginTop,
      marginBottom: computed.marginBottom,
      marginLeft: computed.marginLeft,
      paddingTop: computed.paddingTop,
      paddingBottom: computed.paddingBottom,
      paddingLeft: computed.paddingLeft,
      textIndent: computed.textIndent,
      listStyleType: computed.listStyleType,
      display: computed.display,
      alignItems: computed.alignItems,
      lineHeight: computed.lineHeight,
      rowHtml: row.outerHTML,
      hostHtml: host.innerHTML,
    });
  }

  private logLivePreviewLineDiagnostics(
    parentPath: string,
    childPath: string,
    lineNumber: number,
    view: EditorView,
    from: number,
    to: number,
  ): void {
    try {
      const safeFrom = Math.max(0, Math.min(from, view.state.doc.length));
      const safeTo = Math.max(safeFrom, Math.min(to, view.state.doc.length));
      const line = view.state.doc.lineAt(safeFrom);
      const lineText = line.text;
      const visibleLine = Array.from(view.dom.querySelectorAll('.cm-line')).find((node) => {
        if (!(node instanceof HTMLElement)) return false;
        const text = node.textContent ?? '';
        return text.includes(lineText) || lineText.includes(text);
      }) as HTMLElement | undefined;

      if (!(visibleLine instanceof HTMLElement)) {
        logger.log('[TPS GCM] [DIAG] live-preview line layout skipped', {
          parentFile: parentPath,
          childFile: childPath,
          lineNumber,
          from: safeFrom,
          to: safeTo,
          reason: 'cm-line not found in visible DOM',
          lineText,
        });
        return;
      }
      const computed = window.getComputedStyle(visibleLine);
      const rect = visibleLine.getBoundingClientRect();
      logger.log('[TPS GCM] [DIAG] live-preview line layout', {
        parentFile: parentPath,
        childFile: childPath,
        lineNumber,
        from: safeFrom,
        to: safeTo,
        lineClasses: visibleLine.className,
        rectTop: Math.round(rect.top),
        rectHeight: Math.round(rect.height),
        rectLeft: Math.round(rect.left),
        rectWidth: Math.round(rect.width),
        paddingTop: computed.paddingTop,
        paddingBottom: computed.paddingBottom,
        paddingLeft: computed.paddingLeft,
        textIndent: computed.textIndent,
        lineHeight: computed.lineHeight,
        marginLeft: computed.marginLeft,
        display: computed.display,
        lineHtml: visibleLine.innerHTML,
        lineText,
      });
    } catch (error) {
      logger.log('[TPS GCM] [DIAG] live-preview line layout skipped', {
        parentFile: parentPath,
        childFile: childPath,
        lineNumber,
        from,
        to,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private logLivePreviewRenderDecision(
    parentPath: string,
    childPath: string,
    lineNumber: number,
    lineText: string,
    model: SubitemLineModel,
    replaceFrom: number,
    replaceTo: number,
  ): void {
    logger.log('[TPS GCM] [RenderPlan] live-preview', this.buildRenderPlan('live-preview', model, {
      lineNumber,
      sourceLine: lineText,
      sourceIndent: this.getLeadingIndentInfo(lineText),
    }), {
      replaceFrom,
      replaceTo,
      replaceLength: Math.max(0, replaceTo - replaceFrom),
    });
  }

  private shouldKeepExistingEditorDecorations(
    editorView: EditorView,
    result: { matchCount: number; potentialCount: number; filePath: string | null },
    previousMatchCount: number,
    previousPotentialCount: number,
    previousDocLength: number,
  ): boolean {
    if (result.matchCount > 0 || result.potentialCount > 0) return false;
    if (previousMatchCount <= 0 && previousPotentialCount <= 0) return false;
    if (editorView.state.doc.length !== previousDocLength) return false;

    const markdownView = this.resolveMarkdownViewForEditor(editorView);
    if (!(markdownView instanceof MarkdownView)) return false;
    if (!this.isLivePreviewEditorVisible(markdownView)) return false;

    return true;
  }

  private getMappings() {
    return this.subitemLineModelService.getMappings();
  }

  private getLinkedSubitemRenderMode(view: MarkdownView): 'preview' | 'source' | null {
    const previewContainer = this.getVisiblePreviewContainer(view);
    if (previewContainer) return 'preview';

    const root = view.contentEl as HTMLElement | undefined;
    const sourceContainer = root?.querySelector('.markdown-source-view.is-live-preview') as HTMLElement | null;
    if (this.isVisibleRenderContainer(sourceContainer)) return 'source';

    return getViewMode(view);
  }

  private isLivePreviewEditorVisible(view: MarkdownView): boolean {
    const root = view.contentEl as HTMLElement | undefined;
    const livePreviewContainer = root?.querySelector('.markdown-source-view.is-live-preview') as HTMLElement | null;
    return this.isVisibleRenderContainer(livePreviewContainer);
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
