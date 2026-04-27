import { MarkdownView, Notice, TFile, normalizePath, setIcon } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import { createSubitemForParentWithTitle } from './subitem-creation-service';
import { generateSubitemId, SUBITEM_ID_KEY } from '../utils/subitem-id';
import * as logger from '../logger';
import { getFileDisplayTitle } from '../utils/file-display-title';
import { statusForCheckboxState } from '../core';

const BUTTON_CLASS = 'tps-gcm-inline-subtask-btn';
const BUTTON_VISIBLE_CLASS = 'is-visible';
const HOST_HIGHLIGHT_CLASS = 'tps-gcm-inline-subtask-host-hover';
const HOST_ACTIVE_CLASS = 'tps-gcm-inline-subtask-host-active';
const HOST_BLOCKED_CLASS = 'tps-gcm-inline-subtask-host-blocked';
const NESTED_HIGHLIGHT_CLASS = 'tps-gcm-inline-subtask-nested-highlight';
const NESTED_BLOCKED_CLASS = 'tps-gcm-inline-subtask-nested-blocked';
const BLOCKED_SECTION_CLASS = 'tps-gcm-inline-subtask-blocked-section';
const TASK_LINE_REGEX = /^[ \t]*([-*+]|\d+\.)\s+\[[^\]]*\]\s+/;
const BULLET_LINE_REGEX = /^[ \t]*([-*+]|\d+\.)\s+(?!\[[^\]]*\]\s+)(.+)$/;

type HoverState = {
  button: HTMLButtonElement;
  moveListener: (evt: MouseEvent) => void;
  leaveListener: (evt: MouseEvent) => void;
  pointerUpListener: () => void;
  keyupListener: () => void;
  selectionListener: () => void;
  buttonEnterListener: () => void;
  buttonLeaveListener: (evt: MouseEvent) => void;
  scrollListener: () => void;
  currentTarget: HTMLElement | null;
  currentHost: HTMLElement | null;
  currentBlockedReason: string | null;
  hoverLocked: boolean;
  activationMode: 'hover' | 'caret' | null;
  hideTimer: number | null;
};

export class InlineTaskSubtaskService {
  private hoverStates = new Map<MarkdownView, HoverState>();

  constructor(private plugin: TPSGlobalContextMenuPlugin) {}

  ensureForAllMarkdownViews(): void {
    const views = this.plugin.app.workspace
      .getLeavesOfType('markdown')
      .map((leaf) => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView);
    const active = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const primary = (active instanceof MarkdownView ? active : views[0]) || null;

    for (const view of Array.from(this.hoverStates.keys())) {
      if (!primary || view !== primary) {
        this.removeForView(view);
      }
    }
    if (primary) {
      this.ensureForView(primary);
    }
  }

  ensureForView(view: MarkdownView): void {
    const file = view.file;
    if (!(file instanceof TFile) || file.extension !== 'md') {
      this.removeForView(view);
      return;
    }

    if (this.hoverStates.has(view)) return;

    const root = ((view as any).containerEl as HTMLElement | undefined) || view.contentEl;
    if (!root) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.setAttribute('aria-label', 'Promote list item to note');
    button.setAttribute('contenteditable', 'false');
    button.setAttribute('draggable', 'false');
    button.title = 'Promote list item to note';
    setIcon(button, 'git-branch');

    const state: HoverState = {
      button,
      moveListener: (evt: MouseEvent) => this.handleMouseMove(view, evt),
      leaveListener: (evt: MouseEvent) => this.handleMouseLeave(view, evt),
      pointerUpListener: () => this.handleCaretActivity(view),
      keyupListener: () => this.handleCaretActivity(view),
      selectionListener: () => this.handleCaretActivity(view),
      buttonEnterListener: () => this.handleButtonEnter(view),
      buttonLeaveListener: (evt: MouseEvent) => this.handleButtonLeave(view, evt),
      scrollListener: () => this.hideButton(view),
      currentTarget: null,
      currentHost: null,
      currentBlockedReason: null,
      hoverLocked: false,
      activationMode: null,
      hideTimer: null,
    };

    button.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      evt.stopImmediatePropagation();
      const target = state.currentTarget;
      if (!target) return;
      void this.convertListItemToSubtask(target);
    });
    button.addEventListener('mouseenter', state.buttonEnterListener, { passive: true });
    button.addEventListener('mouseleave', state.buttonLeaveListener, { passive: true });

    document.body.appendChild(button);
    document.addEventListener('mousemove', state.moveListener, { passive: true });
    document.addEventListener('mouseleave', state.leaveListener, { passive: true });
    document.addEventListener('mouseup', state.pointerUpListener, { passive: true });
    document.addEventListener('keyup', state.keyupListener, { passive: true });
    document.addEventListener('selectionchange', state.selectionListener, { passive: true });

    const scroller =
      root.querySelector<HTMLElement>('.cm-scroller') ||
      root.querySelector<HTMLElement>('.markdown-preview-view') ||
      root;
    scroller.addEventListener('scroll', state.scrollListener, { passive: true });

    this.hoverStates.set(view, state);
  }

  removeForView(view: MarkdownView): void {
    const state = this.hoverStates.get(view);
    if (!state) return;
    const root = ((view as any).containerEl as HTMLElement | undefined) || view.contentEl;

    document.removeEventListener('mousemove', state.moveListener);
    document.removeEventListener('mouseleave', state.leaveListener);
    document.removeEventListener('mouseup', state.pointerUpListener);
    document.removeEventListener('keyup', state.keyupListener);
    document.removeEventListener('selectionchange', state.selectionListener);
    state.button.removeEventListener('mouseenter', state.buttonEnterListener);
    state.button.removeEventListener('mouseleave', state.buttonLeaveListener);

    const scroller =
      root?.querySelector<HTMLElement>('.cm-scroller') ||
      root?.querySelector<HTMLElement>('.markdown-preview-view') ||
      root ||
      null;
    scroller?.removeEventListener('scroll', state.scrollListener);

    if (state.hideTimer !== null) {
      window.clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }

    state.button.remove();
    this.hoverStates.delete(view);
  }

  detach(): void {
    for (const view of Array.from(this.hoverStates.keys())) {
      this.removeForView(view);
    }
  }

  private handleMouseMove(view: MarkdownView, evt: MouseEvent): void {
    const root = ((view as any).containerEl as HTMLElement | undefined) || view.contentEl;
    if (!root?.isConnected) {
      this.hideButton(view);
      return;
    }

    const state = this.hoverStates.get(view);
    if (!state) return;

    const hoveredEl = document.elementFromPoint(evt.clientX, evt.clientY);
    const targetEl =
      hoveredEl instanceof HTMLElement
        ? hoveredEl
        : (evt.target instanceof HTMLElement ? evt.target : null);
    if (!targetEl) {
      if (state?.activationMode !== 'caret') {
        this.clearHostClasses(view);
        this.scheduleHide(view, 80);
      }
      return;
    }
    if (!state.button.contains(targetEl)) {
      state.hoverLocked = false;
    }

    // Deterministic reading-mode path: resolve row by Y every mouse move.
    if (this.isReadingPreviewVisible(view)) {
      if (state.button.contains(targetEl)) {
        if (state.hideTimer !== null) {
          window.clearTimeout(state.hideTimer);
          state.hideTimer = null;
        }
        state.hoverLocked = true;
        state.activationMode = 'hover';
        state.button.classList.add(BUTTON_VISIBLE_CLASS);
        return;
      }

      const readingLiHost = this.resolveReadingHostAtPointer(view, targetEl, evt.clientY);
      if (readingLiHost && !readingLiHost.closest('.tps-global-context-menu, .tps-gcm-panel')) {
        if (this.isPointerOverPromoteHotspot(readingLiHost, evt.clientX, evt.clientY)) {
          if (this.tryShowForHost(view, state, readingLiHost)) {
            state.activationMode = 'hover';
            return;
          }
        } else if (state.activationMode !== 'caret') {
          this.clearHostClasses(view);
          this.scheduleHide(view, 110);
          return;
        }
      }
      if (state.activationMode !== 'caret') {
        this.clearHostClasses(view);
        this.scheduleHide(view, 110);
      }
      return;
    }

    const resolvedHoverHost = this.findConvertibleListHost(targetEl);
    // Keep icon visible only when pointer remains inside the promote hotspot for the same host.
    if (state.currentHost && resolvedHoverHost && state.currentHost === resolvedHoverHost) {
      if (!this.isPointerOverPromoteHotspot(resolvedHoverHost, evt.clientX, evt.clientY)) {
        if (state.activationMode !== 'caret') {
          this.clearHostClasses(view);
          this.scheduleHide(view, 110);
        }
        return;
      }
      if (state.hideTimer !== null) {
        window.clearTimeout(state.hideTimer);
        state.hideTimer = null;
      }
      state.activationMode = 'hover';
      state.button.classList.add(BUTTON_VISIBLE_CLASS);
      return;
    }

    if (!root.contains(targetEl)) {
      if (state?.button.contains(targetEl)) {
        if (state.hideTimer !== null) {
          window.clearTimeout(state.hideTimer);
          state.hideTimer = null;
        }
        state.hoverLocked = true;
        state.activationMode = 'hover';
        state.button.classList.add(BUTTON_VISIBLE_CLASS);
        return;
      }
      // Reading-mode fallback: some rendered markdown content can live outside view.contentEl.
      if (
        resolvedHoverHost &&
        !resolvedHoverHost.closest('.tps-global-context-menu, .tps-gcm-panel')
      ) {
        if (this.isPointerOverPromoteHotspot(resolvedHoverHost, evt.clientX, evt.clientY)) {
          if (this.tryShowForHost(view, state, resolvedHoverHost)) {
            state.activationMode = 'hover';
            return;
          }
        } else if (state.activationMode !== 'caret') {
          this.clearHostClasses(view);
          this.scheduleHide(view, 110);
          return;
        }
      }
      if (state.activationMode !== 'caret') {
        this.clearHostClasses(view);
        this.scheduleHide(view, 110);
      }
      return;
    }

    if (state.button.contains(targetEl)) {
      if (state.hideTimer !== null) {
        window.clearTimeout(state.hideTimer);
        state.hideTimer = null;
      }
      state.hoverLocked = true;
      state.activationMode = 'hover';
      state.button.classList.add(BUTTON_VISIBLE_CLASS);
      return;
    }

    const host = resolvedHoverHost;
    if (host && !this.isPointerOverPromoteHotspot(host, evt.clientX, evt.clientY)) {
      if (state.activationMode !== 'caret') {
        this.clearHostClasses(view);
        this.scheduleHide(view, 110);
      }
      return;
    }
    if (!host || host.closest('.tps-global-context-menu, .tps-gcm-panel')) {
      if (state.activationMode !== 'caret') {
        this.clearHostClasses(view);
        this.scheduleHide(view, 110);
      }
      return;
    }
    if (!this.tryShowForHost(view, state, host)) {
      if (state.activationMode !== 'caret') {
        this.clearHostClasses(view);
        this.scheduleHide(view, 110);
      }
      return;
    }
    state.activationMode = 'hover';
  }

  private tryShowForHost(view: MarkdownView, state: HoverState, host: HTMLElement): boolean {
    if (!this.isConvertibleListHost(host, view)) return false;
    const conversionTarget = this.resolveConversionTarget(host);
    if (!conversionTarget) return false;
    if (state.hideTimer !== null) {
      window.clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
    if (state.currentHost && state.currentHost !== host) {
      state.currentHost.classList.remove(HOST_HIGHLIGHT_CLASS);
      state.currentHost.classList.remove(HOST_ACTIVE_CLASS);
      state.currentHost.classList.remove(HOST_BLOCKED_CLASS);
    }
    this.clearBlockedVisuals(view);
    const blockedReason = this.getBlockedReasonForHost(host, view);
    state.currentTarget = blockedReason ? null : conversionTarget;
    state.currentHost = host;
    state.currentBlockedReason = blockedReason;
    state.activationMode = 'hover';
    host.classList.remove(HOST_ACTIVE_CLASS);
    host.classList.add(HOST_HIGHLIGHT_CLASS);
    state.button.classList.toggle('is-blocked', !!blockedReason);
    state.button.disabled = !!blockedReason;
    state.button.title = blockedReason || 'Promote list item to note';
    this.positionButton(view, state.button, host);
    state.button.classList.add(BUTTON_VISIBLE_CLASS);
    return true;
  }

  private handleMouseLeave(view: MarkdownView, evt: MouseEvent): void {
    const state = this.hoverStates.get(view);
    if (!state) return;
    if (state.hoverLocked) return;
    const related = evt.relatedTarget instanceof Node ? evt.relatedTarget : null;
    const root = ((view as any).containerEl as HTMLElement | undefined) || view.contentEl;
    if (related && (root?.contains(related) || state.button.contains(related))) return;
    this.scheduleHide(view, 120);
  }

  private handleCaretActivity(view: MarkdownView): void {
    window.setTimeout(() => {
    if (this.isReadingPreviewVisible(view) && this.isPureReadingMode(view)) {
        return;
      }
      const root = ((view as any).containerEl as HTMLElement | undefined) || view.contentEl;
      if (!root?.isConnected) {
        this.hideButton(view);
        return;
      }

      const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const selection = document.getSelection();
      const anchorNode = selection?.anchorNode || null;
      const anchorEl =
        anchorNode instanceof HTMLElement
          ? anchorNode
          : (anchorNode?.parentElement || null);

      if ((activeEl && !root.contains(activeEl)) && (anchorEl && !root.contains(anchorEl))) {
        return;
      }

      const activeTaskMarked = activeEl?.closest?.('[data-task]') as HTMLElement | null;
      const anchorTaskMarked = anchorEl?.closest?.('[data-task]') as HTMLElement | null;
      const host =
        activeTaskMarked?.closest?.('.cm-line, .task-list-item') as HTMLElement | null ||
        anchorTaskMarked?.closest?.('.cm-line, .task-list-item') as HTMLElement | null ||
        (activeEl?.closest?.('.cm-activeLine, .task-list-item') as HTMLElement | null) ||
        (anchorEl?.closest?.('.cm-activeLine, .task-list-item') as HTMLElement | null) ||
        null;

      if (
        host?.classList.contains('tps-gcm-linked-subitem-task') ||
        host?.classList.contains('tps-gcm-linked-subitem-row') ||
        !!host?.querySelector?.('.tps-gcm-linked-subitem-link, .tps-gcm-linked-subitem-props, .tps-gcm-linked-subitem-pill')
      ) {
        return;
      }

      if (!host || !this.isConvertibleListHost(host, view)) {
        if (!host) return;
        logger.log('[TPS GCM] [InlineSubtask] caret host not convertible', {
          file: view.file?.path ?? null,
          activeTag: activeEl?.tagName ?? null,
          anchorTag: anchorEl?.tagName ?? null,
          hostClass: host?.className ?? null,
          activeHasDataTask: !!activeTaskMarked,
          anchorHasDataTask: !!anchorTaskMarked,
        });
        return;
      }

      const conversionTarget = this.resolveConversionTarget(host);
      const state = this.hoverStates.get(view);
      if (!state || !conversionTarget) return;
      if (state.hideTimer !== null) {
        window.clearTimeout(state.hideTimer);
        state.hideTimer = null;
      }
      this.clearBlockedVisuals(view);
      const blockedReason = this.getBlockedReasonForHost(host, view);
      state.currentHost = host;
      state.currentTarget = blockedReason ? null : conversionTarget;
      state.activationMode = 'caret';
      host.classList.remove(HOST_HIGHLIGHT_CLASS);
      host.classList.add(HOST_ACTIVE_CLASS);
      host.classList.toggle(HOST_BLOCKED_CLASS, !!blockedReason);
      if (blockedReason) {
        this.applyBlockedVisuals(host, view);
      }
      state.button.classList.toggle('is-blocked', !!blockedReason);
      state.button.disabled = !!blockedReason;
      state.button.title = blockedReason || 'Promote list item to note';
      this.positionButton(view, state.button, host);
      state.button.classList.add(BUTTON_VISIBLE_CLASS);
      logger.log('[TPS GCM] [InlineSubtask] showing from caret', {
        file: view.file?.path ?? null,
        hostClass: host.className,
        hasDataTask: host.matches('[data-task]') || !!host.querySelector('[data-task]'),
      });
    }, 0);
  }

  private handleButtonEnter(view: MarkdownView): void {
    const state = this.hoverStates.get(view);
    if (!state) return;
    if (state.hideTimer !== null) {
      window.clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
    state.hoverLocked = true;
    state.activationMode = 'hover';
    state.button.classList.add(BUTTON_VISIBLE_CLASS);
    const host = state.currentHost;
    if (!host) return;
    host.classList.add(HOST_HIGHLIGHT_CLASS);
    host.classList.remove(HOST_ACTIVE_CLASS);
    this.applyNestedHighlight(host, view);
    const blocked = !!state.currentBlockedReason;
    host.classList.toggle(HOST_BLOCKED_CLASS, blocked);
    if (blocked) {
      this.applyBlockedVisuals(host, view);
    }
  }

  private handleButtonLeave(view: MarkdownView, evt: MouseEvent): void {
    const state = this.hoverStates.get(view);
    if (!state) return;
    state.hoverLocked = false;
    if (state.activationMode === 'caret') {
      return;
    }
    state.currentHost?.classList.remove(HOST_HIGHLIGHT_CLASS);
    state.currentHost?.classList.remove(HOST_ACTIVE_CLASS);
    state.currentHost?.classList.remove(HOST_BLOCKED_CLASS);
    this.clearBlockedVisuals(view);
    const root = ((view as any).containerEl as HTMLElement | undefined) || view.contentEl;
    const related = evt.relatedTarget instanceof Node ? evt.relatedTarget : null;
    if (related && root?.contains(related)) return;
    this.scheduleHide(view, 90);
  }

  private scheduleHide(view: MarkdownView, delayMs: number): void {
    const state = this.hoverStates.get(view);
    if (!state) return;
    if (state.hideTimer !== null) {
      window.clearTimeout(state.hideTimer);
    }
    state.hideTimer = window.setTimeout(() => {
      state.hideTimer = null;
      this.hideButton(view);
    }, Math.max(0, delayMs));
  }

  private hideButton(view: MarkdownView): void {
    const state = this.hoverStates.get(view);
    if (!state) return;
    if (state.hideTimer !== null) {
      window.clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
    state.hoverLocked = false;
    state.activationMode = null;
    state.currentHost?.classList.remove(HOST_HIGHLIGHT_CLASS);
    state.currentHost?.classList.remove(HOST_ACTIVE_CLASS);
    state.currentHost?.classList.remove(HOST_BLOCKED_CLASS);
    this.clearBlockedVisuals(view);
    state.currentTarget = null;
    state.currentHost = null;
    state.currentBlockedReason = null;
    state.button.classList.remove(BUTTON_VISIBLE_CLASS);
    state.button.classList.remove('is-blocked');
    state.button.disabled = false;
    state.button.title = 'Promote list item to note';
  }

  private clearHostClasses(view: MarkdownView): void {
    const state = this.hoverStates.get(view);
    if (!state || !state.currentHost) return;
    state.currentHost.classList.remove(HOST_HIGHLIGHT_CLASS);
    state.currentHost.classList.remove(HOST_ACTIVE_CLASS);
    state.currentHost.classList.remove(HOST_BLOCKED_CLASS);
    this.clearBlockedVisuals(view);
  }

  private clearBlockedVisuals(view: MarkdownView): void {
    const root = ((view as any).containerEl as HTMLElement | undefined) || view.contentEl;
    if (!root) return;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`.${BLOCKED_SECTION_CLASS}`))) {
      el.classList.remove(BLOCKED_SECTION_CLASS);
    }
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`.${NESTED_HIGHLIGHT_CLASS}`))) {
      el.classList.remove(NESTED_HIGHLIGHT_CLASS);
    }
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`.${NESTED_BLOCKED_CLASS}`))) {
      el.classList.remove(NESTED_BLOCKED_CLASS);
    }
  }

  private applyBlockedVisuals(host: HTMLElement, view: MarkdownView): void {
    const section = host.closest<HTMLElement>('li, .task-list-item');
    if (section) {
      section.classList.add(BLOCKED_SECTION_CLASS);
      const nestedLis = section.querySelectorAll<HTMLElement>('li, .task-list-item');
      for (const li of Array.from(nestedLis)) {
        if (li === section) continue;
        const isLinkedSubitemRow =
          li.classList.contains('tps-gcm-linked-subitem-task') ||
          li.classList.contains('tps-gcm-linked-subitem-row') ||
          !!li.querySelector(':scope > .tps-gcm-linked-subitem-row, :scope > .tps-gcm-linked-subitem-link, :scope > .tps-gcm-linked-subitem-pill') ||
          !!li.querySelector(':scope > a.internal-link[href*="Markdown/Action Items/"], :scope > .internal-link[href*="Markdown/Action Items/"]');
        if (isLinkedSubitemRow) {
          li.classList.add(NESTED_BLOCKED_CLASS);
        }
      }
      return;
    }

    if (host.classList.contains('cm-line')) {
      const parentDepth = this.getVisualIndentDepth(host);
      let sib: Element | null = host.nextElementSibling;
      while (sib) {
        if (!(sib instanceof HTMLElement) || !sib.classList.contains('cm-line')) break;
        const depth = this.getVisualIndentDepth(sib);
        if (depth <= parentDepth) break;
        const isLinkedSubitemRow =
          sib.classList.contains('tps-gcm-linked-subitem-task') ||
          sib.classList.contains('tps-gcm-linked-subitem-row') ||
          !!sib.querySelector('.tps-gcm-linked-subitem-row, .tps-gcm-linked-subitem-link, .tps-gcm-linked-subitem-pill') ||
          !!sib.querySelector('a.internal-link[href*="Markdown/Action Items/"], .internal-link[href*="Markdown/Action Items/"]');
        if (isLinkedSubitemRow) {
          sib.classList.add(NESTED_BLOCKED_CLASS);
        }
        sib = sib.nextElementSibling;
      }
    }
  }

  private applyNestedHighlight(host: HTMLElement, view: MarkdownView): void {
    const section = host.closest<HTMLElement>('li, .task-list-item');
    if (section) {
    const nestedLis = section.querySelectorAll<HTMLElement>('li, .task-list-item');
    for (const li of Array.from(nestedLis)) {
      if (li === section) continue;
      li.classList.add(NESTED_HIGHLIGHT_CLASS);
    }
    return;
  }

    if (host.classList.contains('cm-line')) {
      const parentDepth = this.getVisualIndentDepth(host);
      let sib: Element | null = host.nextElementSibling;
      while (sib) {
        if (!(sib instanceof HTMLElement) || !sib.classList.contains('cm-line')) break;
        const depth = this.getVisualIndentDepth(sib);
        // Stop when indentation returns to parent level.
        if (depth <= parentDepth) break;
        sib.classList.add(NESTED_HIGHLIGHT_CLASS);
        sib = sib.nextElementSibling;
      }
    }
  }

  private getVisualIndentDepth(lineEl: HTMLElement): number {
    // CM6 renders indentation as repeated .cm-indent spans in live preview.
    // Count them directly from this line for stable nested-range detection.
    const direct = lineEl.querySelectorAll(':scope .cm-indent');
    return direct.length;
  }

  private findConvertibleListHost(targetEl: HTMLElement): HTMLElement | null {
    const taskMarked = targetEl.closest<HTMLElement>('[data-task]');
    if (taskMarked) {
      const host = taskMarked.closest<HTMLElement>('.cm-line, .task-list-item, li');
      if (host) return host;
    }

    const taskItem = targetEl.closest<HTMLElement>('.task-list-item');
    if (taskItem) return taskItem;

    const listItem = targetEl.closest<HTMLElement>('li');
    if (listItem) return listItem;

    const cmLine = targetEl.closest<HTMLElement>('.cm-line');
    if (cmLine) return cmLine;

    return null;
  }

  private isConvertibleListHost(host: HTMLElement, view: MarkdownView): boolean {
    if (this.isDirectLinkedSubitemHost(host)) return false;
    if (this.isFrontmatterHost(host)) return false;

    // Reject only rows that are themselves rendered linked-subitem rows.
    // Allow parent rows even if they contain nested linked subitems.
    const directLinkedSubitemRow =
      host.matches(':scope > .tps-gcm-linked-subitem-row, :scope > .tps-gcm-linked-subitem-link, :scope > .tps-gcm-linked-subitem-props') ||
      !!host.querySelector(':scope > .tps-gcm-linked-subitem-cm-widget, :scope > .tps-gcm-linked-subitem-row-content.is-cm-widget');
    if (directLinkedSubitemRow) return false;

    if (host.classList.contains('task-list-item')) {
      if (host.closest('.markdown-preview-view')) {
        const previewText = this.getPrimaryListItemText(host).replace(/\s+/g, ' ').trim();
        return !!previewText;
      }
      const context = this.getListLineContext(host, view);
      if (context) {
        if (this.isLineInFrontmatter(this.getViewSourceText(view).split('\n'), context.lineNumber)) return false;
        if (this.plugin.bodySubitemLinkService.parseLine(context.rawLine)) return false;
        return !!this.parseListLine(context.rawLine);
      }
      const text = this.getPrimaryListItemText(host).replace(/\s+/g, ' ').trim();
      return !!text;
    }

    if (host.tagName === 'LI') {
      if (host.closest('.markdown-preview-view')) {
        const previewText = this.getPrimaryListItemText(host).replace(/\s+/g, ' ').trim();
        return !!previewText;
      }
      const context = this.getListLineContext(host, view);
      if (context) {
        if (this.isLineInFrontmatter(this.getViewSourceText(view).split('\n'), context.lineNumber)) return false;
        if (this.plugin.bodySubitemLinkService.parseLine(context.rawLine)) return false;
        return !!this.parseListLine(context.rawLine);
      }
      const text = this.getPrimaryListItemText(host).replace(/\s+/g, ' ').trim();
      return !!text;
    }

    if (host.classList.contains('cm-line')) {
      const context = this.getListLineContext(host, view);
      if (!context) return false;
      if (this.isLineInFrontmatter(this.getViewSourceText(view).split('\n'), context.lineNumber)) return false;
      if (this.plugin.bodySubitemLinkService.parseLine(context.rawLine)) return false;
      return !!this.parseListLine(context.rawLine);
    }

    return false;
  }

  private isDirectLinkedSubitemHost(host: HTMLElement): boolean {
    if (host.classList.contains('tps-gcm-linked-subitem-task') || host.classList.contains('tps-gcm-linked-subitem-row')) {
      return true;
    }

    // Match linked-subitem markup only on this row, not in nested child lists.
    const directRowLinked =
      host.matches(':scope > .tps-gcm-linked-subitem-row, :scope > .tps-gcm-linked-subitem-link, :scope > .tps-gcm-linked-subitem-props') ||
      !!host.querySelector(':scope > .tps-gcm-linked-subitem-row, :scope > .tps-gcm-linked-subitem-link, :scope > .tps-gcm-linked-subitem-props') ||
      !!host.querySelector(':scope > span .tps-gcm-linked-subitem-row, :scope > span .tps-gcm-linked-subitem-link');
    if (directRowLinked) return true;

    // If first direct link on this row points to Action Items, treat as promoted row.
    const directActionLink = host.querySelector(':scope > a.internal-link[href*="Markdown/Action Items/"], :scope > span > a.internal-link[href*="Markdown/Action Items/"]');
    if (directActionLink) return true;

    return false;
  }

  private resolveConversionTarget(host: HTMLElement): HTMLElement | null {
    if (host.classList.contains('task-list-item')) {
      return host.querySelector<HTMLElement>('input.task-list-item-checkbox, .task-list-item-checkbox') || host;
    }

    if (host.tagName === 'LI') {
      return host;
    }

    if (host.classList.contains('cm-line')) {
      return host.querySelector<HTMLElement>('input.task-list-item-checkbox, .task-list-item-checkbox, .cm-formatting-task') || host;
    }

    return null;
  }

  private positionButton(view: MarkdownView, button: HTMLButtonElement, host: HTMLElement): void {
    const placement = this.getPromoteButtonPlacement(host);
    if (!placement) return;
    button.style.top = `${Math.max(4, placement.top)}px`;
    button.style.left = `${Math.max(4, placement.left)}px`;
  }

  private getPromoteButtonPlacement(host: HTMLElement): { top: number; left: number } | null {
    const rect = this.getHostRowRect(host);
    if (rect.width <= 0 || rect.height <= 0) return null;

    const rowAnchor = host.querySelector<HTMLElement>(':scope > .list-bullet, :scope > input.task-list-item-checkbox, :scope > .task-list-item-checkbox');
    const anchorRect = rowAnchor?.getBoundingClientRect();

    const size = 22;
    const top = anchorRect
      ? anchorRect.top + Math.max(0, Math.round((anchorRect.height - size) / 2))
      : rect.top + Math.max(1, Math.round((rect.height - size) / 2));
    const left = anchorRect ? anchorRect.left - 26 : rect.left - 18;

    return { top, left };
  }

  private isPointerOverPromoteHotspot(host: HTMLElement, clientX: number, clientY: number): boolean {
    const placement = this.getPromoteButtonPlacement(host);
    if (!placement) return false;
    const size = 22;
    const paddingX = 12;
    const paddingY = 8;
    const left = placement.left - paddingX;
    const top = placement.top - paddingY;
    const right = placement.left + size + paddingX;
    const bottom = placement.top + size + paddingY;
    return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
  }

  private getHostRowRect(host: HTMLElement): DOMRect {
    let rect = host.getBoundingClientRect();

    // Reading mode LI can include nested lists; reduce rect to first visual row.
    if ((host.tagName === 'LI' || host.classList.contains('task-list-item')) && host.closest('.markdown-preview-view')) {
      const nested = host.querySelector<HTMLElement>(':scope > ul, :scope > ol');
      if (nested) {
        const nestedRect = nested.getBoundingClientRect();
        const firstRowHeight = Math.max(18, nestedRect.top - rect.top);
        rect = new DOMRect(rect.left, rect.top, rect.width, firstRowHeight);
      }
    }

    return rect;
  }

  private resolveReadingHostAtPointer(
    view: MarkdownView,
    targetEl: HTMLElement,
    clientY: number,
  ): HTMLElement | null {
    const direct = targetEl.closest<HTMLElement>('.markdown-preview-view li, .markdown-preview-view .task-list-item');
    if (direct) return direct;

    const preview = targetEl.closest<HTMLElement>('.markdown-preview-view, .markdown-reading-view');
    if (!preview) {
      const root = ((view as any).containerEl as HTMLElement | undefined) || view.contentEl;
      if (!root) return null;
      // fallback if target isn't directly inside preview wrapper
      const fallbackPreview = root.querySelector<HTMLElement>('.markdown-preview-view, .markdown-reading-view');
      if (!fallbackPreview) return null;
      return this.findReadingHostByY(fallbackPreview, clientY);
    }
    return this.findReadingHostByY(preview, clientY);
  }

  private findReadingHostByY(preview: HTMLElement, clientY: number): HTMLElement | null {
    if (!preview) return null;

    let best: HTMLElement | null = null;
    let bestTop = -Infinity;
    const rows = preview.querySelectorAll<HTMLElement>('li, .task-list-item');
    for (const row of Array.from(rows)) {
      const r = this.getHostRowRect(row);
      if (r.height <= 0) continue;
      if (clientY < r.top - 2 || clientY > r.bottom + 2) continue;
      if (r.top >= bestTop) {
        bestTop = r.top;
        best = row;
      }
    }
    return best;
  }

  private isReadingPreviewVisible(view: MarkdownView): boolean {
    const root = ((view as any).containerEl as HTMLElement | undefined) || view.contentEl;
    if (!root) return false;
    const preview = root.querySelector<HTMLElement>('.markdown-preview-view, .markdown-reading-view');
    if (!preview || !preview.isConnected) return false;
    const style = window.getComputedStyle(preview);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = preview.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  private isPureReadingMode(view: MarkdownView): boolean {
    const root = ((view as any).containerEl as HTMLElement | undefined) || view.contentEl;
    if (!root) return false;
    const sourceView = root.querySelector<HTMLElement>('.markdown-source-view');
    if (!sourceView) return true;
    const style = window.getComputedStyle(sourceView);
    return style.display === 'none';
  }

  private async convertListItemToSubtask(targetEl: HTMLElement): Promise<void> {
    const view = this.resolveMarkdownViewForElement(targetEl);
    const context = view ? this.getListLineContext(targetEl, view) : null;
    if (!context) return;

    const content = await this.plugin.subitemRelationshipSyncService.readMarkdownText(context.file);
    const lines = content.split('\n');
    if (this.isLineInFrontmatter(lines, context.lineNumber)) {
      new Notice('Cannot promote frontmatter entries into notes.');
      return;
    }
    const rawLine = lines[context.lineNumber] || '';
    const parsed = this.parseListLine(rawLine);
    if (!parsed || !parsed.title) {
      new Notice('Unable to promote this list item to a note.');
      return;
    }

    const inlineProperties = this.extractInlineProperties(rawLine);
    const subitemId = String(inlineProperties[SUBITEM_ID_KEY] || '').trim() || generateSubitemId();
    inlineProperties[SUBITEM_ID_KEY] = subitemId;
    const isCalendarSynced = this.isCalendarSynced(inlineProperties);

    const nested = this.collectNestedContentBlock(lines, context.lineNumber, parsed.indent);
    if (nested.hasNestedSubitemLink) {
      new Notice('Cannot promote this list item yet because nested content contains linked subitems.');
      return;
    }

    const created = await createSubitemForParentWithTitle(this.plugin, context.file, parsed.title, undefined, {
      insertParentBodyLink: false,
      seedDefaults: !!parsed.checkboxToken,
      initialFrontmatter: inlineProperties,
    });
    if (!(created instanceof TFile)) return;
    await this.syncPromotedChildStatus(created, parsed.checkboxToken);

    const linkPath = normalizePath(created.path.replace(/\.md$/i, ''));
    const linkMarkup = `[[${linkPath}|${getFileDisplayTitle(this.plugin.app, created)}]] [${SUBITEM_ID_KEY}:: ${subitemId}]`;

    if (isCalendarSynced) {
      lines.splice(context.lineNumber, 1);
      if (nested.endExclusive > context.lineNumber + 1) {
        lines.splice(context.lineNumber, nested.endExclusive - (context.lineNumber + 1));
      }
    } else {
      lines[context.lineNumber] = parsed.checkboxToken
        ? `${parsed.indent}${parsed.marker} ${parsed.checkboxToken} ${linkMarkup}`
        : `${parsed.indent}${parsed.marker} ${linkMarkup}`;
      if (nested.endExclusive > context.lineNumber + 1) {
        lines.splice(context.lineNumber + 1, nested.endExclusive - (context.lineNumber + 1));
      }
    }

    try {
      const nextContent = lines.join('\n');
      await this.plugin.subitemRelationshipSyncService.mutateMarkdownBody(context.file, async (currentLines) => {
        if (context.lineNumber < 0 || context.lineNumber >= currentLines.length) return false;
        if ((currentLines[context.lineNumber] || '') === lines[context.lineNumber] && nested.endExclusive <= context.lineNumber + 1) return false;
        currentLines[context.lineNumber] = lines[context.lineNumber];
        if (nested.endExclusive > context.lineNumber + 1) {
          currentLines.splice(context.lineNumber + 1, nested.endExclusive - (context.lineNumber + 1));
        }
        return true;
      });

      if (nested.lines.length > 0) {
        const nestedBody = nested.lines.join('\n').trimEnd();
        if (nestedBody) {
          await this.plugin.subitemRelationshipSyncService.mutateMarkdownBody(created, async (childLines) => {
            while (childLines.length > 0 && !String(childLines[childLines.length - 1] || '').trim()) childLines.pop();
            if (childLines.length > 0) childLines.push('');
            childLines.push(...nestedBody.split('\n'));
            return true;
          });
        }
      }

      await this.plugin.subitemRelationshipSyncService?.reconcileMarkdownParentText(context.file, nextContent);
      this.plugin.persistentMenuManager?.refreshMenusForFile(context.file, true);
      this.ensureForAllMarkdownViews();
      new Notice(`Promoted "${parsed.title}" to note.`);
    } catch (error) {
      logger.error('[TPS GCM] Failed replacing checkbox line after subtask conversion', error);
      new Notice('Created note, but failed to update the original list item line.');
    }
  }

  private extractInlineProperties(rawText: string): Record<string, string> {
    const properties: Record<string, string> = {};
    const regex = /\[([a-zA-Z0-9_-]+)::\s*([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(String(rawText || ''))) !== null) {
      const key = String(m[1] || '').trim();
      const value = String(m[2] || '').trim();
      if (!key || !value) continue;
      properties[key] = value;
    }
    return properties;
  }

  private async syncPromotedChildStatus(file: TFile, checkboxToken: string | null): Promise<void> {
    const normalizedStatus = this.getPromotionStatusForCheckboxToken(checkboxToken);
    if (!normalizedStatus) {
      await this.plugin.bulkEditService.removeFrontmatterKey([file], 'status', { userInitiated: true });
      return;
    }
    await this.plugin.bulkEditService.setStatus([file], normalizedStatus, { userInitiated: true });
  }

  private getPromotionStatusForCheckboxToken(checkboxToken: string | null): string | null {
    if (!checkboxToken) return null;
    const match = String(checkboxToken || '').match(/^\[([^\]]*)\]$/);
    if (!match) return null;
    return statusForCheckboxState(match[1] || '', this.plugin.app);
  }

  private isCalendarSynced(properties: Record<string, string>): boolean {
    const keys = Object.keys(properties).map((k) => k.toLowerCase());
    return keys.includes('externaleventid')
      || keys.includes('tpscalendaruid')
      || keys.includes('tpscalendarsourceurl');
  }

  private parseListLine(rawLine: string): { indent: string; marker: string; checkboxToken: string | null; title: string } | null {
    const taskMatch = rawLine.match(/^([ \t]*)([-*+]|\d+\.)\s+\[[^\]]*\]\s+(.*)$/);
    const bulletMatch = rawLine.match(/^([ \t]*)([-*+]|\d+\.)\s+(?!\[[^\]]*\]\s+)(.+)$/);
    const match = taskMatch || bulletMatch;
    if (!match) return null;
    const indent = match[1] || '';
    const marker = match[2] || '-';
    const body = String(match[3] || '').trim();
    if (!body) return null;
    if (/^\[\[+$/.test(body)) return null;
    if (/^!?\[\[[^\]]+\]\]$/.test(body)) return null;
    if (/^\[[^\]]+]\s+!?\[\[[^\]]+\]\]$/.test(body)) return null;

    const cleaned = body
      .replace(/\[[^[\]]+::[^[\]]+\]/g, '')
      .replace(/(?:^|\s)(📅|⏳|🛫|⏫|🔁)\s*\S+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      indent,
      marker,
      checkboxToken: taskMatch ? String(rawLine.match(/^([ \t]*)([-*+]|\d+\.)\s+(\[[^\]]*\])\s+/)?.[3] || '').trim() || '[ ]' : null,
      title: cleaned || body,
    };
  }

  private resolveMarkdownViewForElement(targetEl: HTMLElement): MarkdownView | null {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const containerEl = (view as any).containerEl as HTMLElement | undefined;
      const contentEl = view.contentEl as HTMLElement | undefined;
      if (containerEl?.contains(targetEl) || contentEl?.contains(targetEl)) return view;
    }
    return this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
  }

  private getListLineContext(
    targetEl: HTMLElement,
    view: MarkdownView,
  ): { view: MarkdownView; file: TFile; lineNumber: number; rawLine: string } | null {
    const file = view.file;
    if (!(file instanceof TFile)) return null;

    const dataLineEl = targetEl.closest('[data-line]') as HTMLElement | null;
    const rawDataLine = dataLineEl?.getAttribute('data-line') ?? '';
    const dataLine = Number.parseInt(rawDataLine, 10);
    if (Number.isFinite(dataLine)) {
      const source = this.getViewSourceText(view);
      const lines = source.split('\n');
      if (this.isLineInFrontmatter(lines, dataLine)) return null;
      return { view, file, lineNumber: dataLine, rawLine: lines[dataLine] ?? '' };
    }

    const editorAny = view.editor as any;
    const cm = editorAny?.cm;
    const lineHost = targetEl.closest('.cm-line') as HTMLElement | null;
    if (cm && typeof cm.posAtDOM === 'function' && lineHost) {
      try {
        const offset = cm.posAtDOM(lineHost);
        const line = cm.state?.doc?.lineAt?.(offset)?.number;
        if (typeof line === 'number' && Number.isFinite(line)) {
          const source = this.getViewSourceText(view);
          const lines = source.split('\n');
          const lineNumber = Math.max(0, line - 1);
          if (this.isLineInFrontmatter(lines, lineNumber)) return null;
          return { view, file, lineNumber, rawLine: lines[lineNumber] ?? '' };
        }
      } catch {
        // fall through to reading-mode text match
      }
    }

    const source = this.getViewSourceText(view);
    const lines = source.split('\n');
    const hostRoot = targetEl.closest<HTMLElement>('li, .task-list-item, .cm-line') || targetEl;
    const primaryHostText = this.getPrimaryListItemText(hostRoot).replace(/\s+/g, ' ').trim();
    const fallbackHostText = (hostRoot.textContent || '').replace(/\s+/g, ' ').trim();
    const normalizedPrimary = primaryHostText.toLowerCase();
    const normalizedFallback = fallbackHostText.toLowerCase();
    if (!normalizedPrimary && !normalizedFallback) return null;

    const lineNumber = lines.findIndex((line) => {
      const parsed = this.parseListLine(line);
      if (!parsed) return false;
      const normalizedTitle = parsed.title.replace(/\s+/g, ' ').trim().toLowerCase();
      if (!normalizedTitle) return false;
      if (normalizedPrimary) {
        if (
          normalizedPrimary === normalizedTitle ||
          normalizedPrimary.startsWith(normalizedTitle) ||
          normalizedTitle.startsWith(normalizedPrimary)
        ) {
          return true;
        }
      }
      if (!normalizedFallback) return false;
      return (
        normalizedFallback === normalizedTitle ||
        normalizedFallback.startsWith(normalizedTitle) ||
        normalizedTitle.startsWith(normalizedFallback)
      );
    });
    if (lineNumber < 0) return null;
    if (this.isLineInFrontmatter(lines, lineNumber)) return null;
    return { view, file, lineNumber, rawLine: lines[lineNumber] ?? '' };
  }

  private getPrimaryListItemText(host: HTMLElement): string {
    if (host.classList.contains('cm-line')) {
      return host.textContent || '';
    }

    if (host.tagName !== 'LI' && !host.classList.contains('task-list-item')) {
      return host.textContent || '';
    }

    const chunks: string[] = [];
    for (const child of Array.from(host.childNodes)) {
      if (child instanceof HTMLElement) {
        const tag = child.tagName;
        if (tag === 'UL' || tag === 'OL') break;
        if (child.classList.contains('list-collapse-indicator')) continue;
        if (child.classList.contains('collapse-icon')) continue;
        if (child.classList.contains('list-bullet')) continue;
        chunks.push(child.textContent || '');
        continue;
      }
      if (child.nodeType === Node.TEXT_NODE) {
        chunks.push(child.textContent || '');
      }
    }
    return chunks.join(' ');
  }

  private getBlockedReasonForHost(host: HTMLElement, view: MarkdownView): string | null {
    if (this.isFrontmatterHost(host)) {
      return 'Cannot promote frontmatter entries into notes.';
    }
    const section = host.closest<HTMLElement>('li, .task-list-item');
    if (
      section &&
      (
        section.querySelector(':scope > ul .tps-gcm-linked-subitem-task, :scope > ol .tps-gcm-linked-subitem-task') ||
        section.querySelector(':scope > ul .tps-gcm-linked-subitem-row, :scope > ol .tps-gcm-linked-subitem-row') ||
        section.querySelector(':scope > ul .tps-gcm-linked-subitem-link, :scope > ol .tps-gcm-linked-subitem-link') ||
        section.querySelector(':scope > ul a.internal-link[href*="Markdown/Action Items/"], :scope > ol a.internal-link[href*="Markdown/Action Items/"]')
      )
    ) {
      return 'Cannot promote yet: nested linked subitems are present.';
    }

    const context = this.getListLineContext(host, view);
    if (!context) return null;
    const source = this.getViewSourceText(view);
    const lines = source.split('\n');
    if (this.isLineInFrontmatter(lines, context.lineNumber)) {
      return 'Cannot promote frontmatter entries into notes.';
    }
    const parsed = this.parseListLine(context.rawLine);
    if (!parsed) return null;
    const nested = this.collectNestedContentBlock(lines, context.lineNumber, parsed.indent);
    if (nested.hasNestedSubitemLink) {
      return 'Cannot promote yet: nested linked subitems are present.';
    }
    return null;
  }

  private collectNestedContentBlock(
    lines: string[],
    parentLineNumber: number,
    parentIndentText: string,
  ): { endExclusive: number; lines: string[]; hasNestedSubitemLink: boolean } {
    const parentIndent = this.getIndentColumns(lines[parentLineNumber] || '');
    let endExclusive = parentLineNumber + 1;
    let hasNestedSubitemLink = false;
    const nestedRaw: string[] = [];
    let started = false;

    for (let i = parentLineNumber + 1; i < lines.length; i += 1) {
      const line = lines[i] || '';
      if (!line.trim()) {
        if (started) {
          nestedRaw.push(line);
          endExclusive = i + 1;
        }
        continue;
      }
      const indent = this.getIndentColumns(line);
      if (indent <= parentIndent) break;
      started = true;
      nestedRaw.push(line);
      endExclusive = i + 1;
      if (this.plugin.bodySubitemLinkService.parseLine(line)) {
        hasNestedSubitemLink = true;
      }
    }

    const outdented = nestedRaw.map((line) => this.outdentNestedLine(line, parentIndentText));
    return { endExclusive, lines: outdented, hasNestedSubitemLink };
  }

  private getIndentColumns(line: string): number {
    const match = String(line || '').match(/^[ \t]*/)?.[0] ?? '';
    return match.split('').reduce((total, ch) => total + (ch === '\t' ? 2 : 1), 0);
  }

  private outdentNestedLine(line: string, parentIndentText: string): string {
    let out = String(line || '');
    if (parentIndentText && out.startsWith(parentIndentText)) {
      out = out.slice(parentIndentText.length);
    }
    if (out.startsWith('\t')) return out.slice(1);
    if (out.startsWith('  ')) return out.slice(2);
    if (out.startsWith(' ')) return out.slice(1);
    return out;
  }

  private getViewSourceText(view: MarkdownView): string {
    const editor = view.editor as any;
    if (typeof editor?.getValue === 'function') return String(editor.getValue() || '');
    return String((view as any)?.data || '');
  }

  private isFrontmatterHost(host: HTMLElement): boolean {
    return !!host.closest('.cm-hmd-frontmatter, .HyperMD-frontmatter');
  }

  private isLineInFrontmatter(lines: string[], lineNumber: number): boolean {
    if (lineNumber < 0 || lineNumber >= lines.length) return false;
    if (String(lines[0] || '').trim() !== '---') return false;

    for (let index = 1; index < lines.length; index += 1) {
      if (String(lines[index] || '').trim() !== '---') continue;
      return lineNumber > 0 && lineNumber < index;
    }

    return false;
  }
}
