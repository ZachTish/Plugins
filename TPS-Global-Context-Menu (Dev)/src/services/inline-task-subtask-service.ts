import { MarkdownView, Notice, TFile, normalizePath, setIcon } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import { createSubitemForParentWithTitle } from './subitem-creation-service';
import * as logger from '../logger';

const BUTTON_CLASS = 'tps-gcm-inline-subtask-btn';
const BUTTON_VISIBLE_CLASS = 'is-visible';
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
  hoverLocked: boolean;
  hideTimer: number | null;
};

export class InlineTaskSubtaskService {
  private hoverStates = new Map<MarkdownView, HoverState>();

  constructor(private plugin: TPSGlobalContextMenuPlugin) {}

  ensureForAllMarkdownViews(): void {
    const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const liveViews = new Set<MarkdownView>();

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

    for (const view of Array.from(this.hoverStates.keys())) {
      if (!liveViews.has(view)) {
        this.removeForView(view);
      }
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
    button.setAttribute('aria-label', 'Convert list item to subtask');
    button.setAttribute('contenteditable', 'false');
    button.setAttribute('draggable', 'false');
    button.title = 'Convert list item to subtask';
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
      hoverLocked: false,
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

    const hoveredEl = document.elementFromPoint(evt.clientX, evt.clientY);
    const targetEl =
      hoveredEl instanceof HTMLElement
        ? hoveredEl
        : (evt.target instanceof HTMLElement ? evt.target : null);
    if (!targetEl) {
      this.scheduleHide(view, 80);
      return;
    }
    if (!root.contains(targetEl)) {
      const state = this.hoverStates.get(view);
      if (state?.button.contains(targetEl)) {
        if (state.hideTimer !== null) {
          window.clearTimeout(state.hideTimer);
          state.hideTimer = null;
        }
        state.hoverLocked = true;
        state.button.classList.add(BUTTON_VISIBLE_CLASS);
        return;
      }
      this.scheduleHide(view, 110);
      return;
    }

    const state = this.hoverStates.get(view);
    if (!state) return;
    if (state.button.contains(targetEl)) {
      if (state.hideTimer !== null) {
        window.clearTimeout(state.hideTimer);
        state.hideTimer = null;
      }
      state.hoverLocked = true;
      state.button.classList.add(BUTTON_VISIBLE_CLASS);
      return;
    }

    const host = this.findConvertibleListHost(targetEl);
    if (!host || host.closest('.tps-global-context-menu, .tps-gcm-panel, .tps-auto-base-embed')) {
      this.scheduleHide(view, 110);
      return;
    }

    if (!this.isConvertibleListHost(host, view)) {
      this.scheduleHide(view, 110);
      return;
    }

    const conversionTarget = this.resolveConversionTarget(host);
    if (!conversionTarget) {
      this.scheduleHide(view, 110);
      return;
    }

    if (state.hideTimer !== null) {
      window.clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
    state.currentTarget = conversionTarget;
    state.currentHost = host;
    this.positionButton(view, state.button, host);
    state.button.classList.add(BUTTON_VISIBLE_CLASS);
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
      state.currentHost = host;
      state.currentTarget = conversionTarget;
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
    state.button.classList.add(BUTTON_VISIBLE_CLASS);
  }

  private handleButtonLeave(view: MarkdownView, evt: MouseEvent): void {
    const state = this.hoverStates.get(view);
    if (!state) return;
    state.hoverLocked = false;
    const root = ((view as any).containerEl as HTMLElement | undefined) || view.contentEl;
    const related = evt.relatedTarget instanceof Node ? evt.relatedTarget : null;
    if (related && root?.contains(related)) return;
    this.scheduleHide(view, 90);
  }

  private scheduleHide(view: MarkdownView, delayMs: number): void {
    const state = this.hoverStates.get(view);
    if (!state) return;
    if (state.hoverLocked) return;
    if (state.hideTimer !== null) {
      window.clearTimeout(state.hideTimer);
    }
    state.hideTimer = window.setTimeout(() => {
      state.hideTimer = null;
      if (state.hoverLocked) return;
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
    state.currentTarget = null;
    state.currentHost = null;
    state.button.classList.remove(BUTTON_VISIBLE_CLASS);
  }

  private findConvertibleListHost(targetEl: HTMLElement): HTMLElement | null {
    if (
      targetEl.closest('.tps-gcm-linked-subitem-task, .tps-gcm-linked-subitem-row, .tps-gcm-linked-subitem-link, .tps-gcm-linked-subitem-props')
    ) {
      return null;
    }

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
    if (
      host.classList.contains('tps-gcm-linked-subitem-task') ||
      host.classList.contains('tps-gcm-linked-subitem-row') ||
      host.querySelector('.tps-gcm-linked-subitem-link, .tps-gcm-linked-subitem-props')
    ) {
      return false;
    }

    if (host.classList.contains('task-list-item')) {
      const context = this.getListLineContext(host, view);
      if (context && this.plugin.bodySubitemLinkService.parseLine(context.rawLine)) {
        return false;
      }
      return !!context && !!this.parseListLine(context.rawLine);
    }

    if (host.tagName === 'LI') {
      const context = this.getListLineContext(host, view);
      if (context && this.plugin.bodySubitemLinkService.parseLine(context.rawLine)) {
        return false;
      }
      return !!context && !!this.parseListLine(context.rawLine);
    }

    if (host.classList.contains('cm-line')) {
      const context = this.getListLineContext(host, view);
      if (!context) return false;
      if (this.plugin.bodySubitemLinkService.parseLine(context.rawLine)) return false;
      return !!this.parseListLine(context.rawLine);
    }

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
    const rect = host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const size = 22;
    const top = rect.top + Math.max(1, Math.round((rect.height - size) / 2));

    // Find the last meaningful text content element to position button after text
    let textEndX = rect.left;
    
    // For Live Preview (cm-line), find the last text-containing element
    if (host.classList.contains('cm-line')) {
      const textElements = host.querySelectorAll<HTMLElement>('.cm-list-mark, .cm-formatting-task, .cm-meta, .cm-hmd-frontmatter, span:not(.cm-foldmark):not(.cm-formatting-list)');
      for (const el of Array.from(textElements)) {
        // Skip elements that are purely formatting markers at the start
        const elRect = el.getBoundingClientRect();
        if (elRect.width > 0 && elRect.right > textEndX) {
          textEndX = elRect.right;
        }
      }
      // Fallback: use the host's right edge if no text elements found
      if (textEndX === rect.left) {
        textEndX = rect.right;
      }
    } else {
      // For reading mode (task-list-item, li), find text content end
      const textNodes = this.getTextNodeEndPositions(host);
      if (textNodes.length > 0) {
        textEndX = Math.max(...textNodes);
      } else {
        textEndX = rect.right;
      }
    }

    // Position button immediately after text with small padding
    const left = textEndX + 6;

    button.style.top = `${Math.max(4, top)}px`;
    button.style.left = `${Math.max(4, left)}px`;
  }

  /**
   * Get the right-edge X coordinates of text nodes within an element.
   */
  private getTextNodeEndPositions(element: HTMLElement): number[] {
    const positions: number[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      // Skip whitespace-only nodes
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0) {
        positions.push(rect.right);
      }
    }
    return positions;
  }

  private async convertListItemToSubtask(targetEl: HTMLElement): Promise<void> {
    const view = this.resolveMarkdownViewForElement(targetEl);
    const context = view ? this.getListLineContext(targetEl, view) : null;
    if (!context) return;

    const content = await this.plugin.subitemRelationshipSyncService.readMarkdownText(context.file);
    const lines = content.split('\n');
    const rawLine = lines[context.lineNumber] || '';
    const parsed = this.parseListLine(rawLine);
    if (!parsed || !parsed.title) {
      new Notice('Unable to convert this list item to a subtask.');
      return;
    }

    const created = await createSubitemForParentWithTitle(this.plugin, context.file, parsed.title, undefined, {
      insertParentBodyLink: false,
      seedDefaults: !!parsed.checkboxToken,
    });
    if (!(created instanceof TFile)) return;

    const linkPath = normalizePath(created.path.replace(/\.md$/i, ''));
    const linkMarkup = `[[${linkPath}|${created.basename}]]`;
    lines[context.lineNumber] = parsed.checkboxToken
      ? `${parsed.indent}${parsed.marker} ${parsed.checkboxToken} ${linkMarkup}`
      : `${parsed.indent}${parsed.marker} ${linkMarkup}`;

    try {
      const nextContent = lines.join('\n');
      await this.plugin.subitemRelationshipSyncService.mutateMarkdownBody(context.file, async (currentLines) => {
        if (context.lineNumber < 0 || context.lineNumber >= currentLines.length) return false;
        if ((currentLines[context.lineNumber] || '') === lines[context.lineNumber]) return false;
        currentLines[context.lineNumber] = lines[context.lineNumber];
        return true;
      });
      await this.plugin.subitemRelationshipSyncService?.reconcileMarkdownParentText(context.file, nextContent);
      this.plugin.persistentMenuManager?.refreshMenusForFile(context.file, true);
      this.ensureForAllMarkdownViews();
      new Notice(`Converted "${parsed.title}" to subtask.`);
    } catch (error) {
      logger.error('[TPS GCM] Failed replacing checkbox line after subtask conversion', error);
      new Notice('Created subtask, but failed to update the original list item line.');
    }
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
          return { view, file, lineNumber: Math.max(0, line - 1), rawLine: lines[Math.max(0, line - 1)] ?? '' };
        }
      } catch {
        // fall through to reading-mode text match
      }
    }

    const source = this.getViewSourceText(view);
    const lines = source.split('\n');
    const hostText = (targetEl.textContent || '').replace(/\s+/g, ' ').trim();
    if (!hostText) return null;
    const lineNumber = lines.findIndex((line) => {
      const parsed = this.parseListLine(line);
      if (!parsed) return false;
      return parsed.title.replace(/\s+/g, ' ').trim() === hostText;
    });
    if (lineNumber < 0) return null;
    return { view, file, lineNumber, rawLine: lines[lineNumber] ?? '' };
  }

  private getViewSourceText(view: MarkdownView): string {
    const editor = view.editor as any;
    if (typeof editor?.getValue === 'function') return String(editor.getValue() || '');
    return String((view as any)?.data || '');
  }
}
