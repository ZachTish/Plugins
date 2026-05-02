import { App, Menu, TFile, MarkdownView, getAllTags } from 'obsidian';
import * as logger from '../logger';
import type TPSGlobalContextMenuPlugin from '../main';
import { StatusChoiceModal } from '../modals/status-choice-modal';
import { CheckboxPatterns, type CheckboxStateChar } from '../core';
import { applyRulesToFile as applyRulesToFileShared, evaluateIconColorRules } from '../utils/rule-resolver';
import type { RuleEvaluationContext } from '../types';
import { normalizeTagValue } from '../utils/tag-utils';

/**
 * Handles task checkbox context actions and long-press state selection.
 *
 * Direct click-to-cycle behavior has been removed; state changes now go
 * through the explicit selector opened by right-click or long-press.
 */
export class TaskCheckboxHandler {
    private app: App;
    private pendingChecklistReorderTimers: Map<string, number> = new Map();
    private bypassNextTaskCycleClick = false;
    private recentTaskCycleClicks: Map<string, number> = new Map();
    private longPressTimerId: number | null = null;
    private suppressSyntheticClickUntil = 0;

    constructor(private plugin: TPSGlobalContextMenuPlugin) {
        this.app = plugin.app;
    }

    dispose(): void {
        for (const timerId of this.pendingChecklistReorderTimers.values()) {
            window.clearTimeout(timerId);
        }
        this.pendingChecklistReorderTimers.clear();
        if (this.longPressTimerId !== null) {
            window.clearTimeout(this.longPressTimerId);
            this.longPressTimerId = null;
        }
    }

    async syncTaskVisualPropertiesForFile(file: TFile): Promise<boolean> {
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return false;

        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        let changed = false;

        for (let index = 0; index < lines.length; index++) {
            const currentLine = lines[index];
            if (!CheckboxPatterns.ANY_CHECKBOX_CONTENT.test(currentLine)) continue;
            const nextLine = this.applyTaskVisualInlineProperties(file, currentLine);
            if (nextLine === currentLine) continue;
            lines[index] = nextLine;
            changed = true;
        }

        if (!changed) return false;
        await this.app.vault.modify(file, lines.join('\n'));
        return true;
    }

    async handleContextMenu(evt: MouseEvent): Promise<void> {
        const targetEl = evt.target instanceof HTMLElement ? evt.target : null;
        if (!targetEl) return;
        const checkboxEl = this.resolveTaskCheckboxTarget(targetEl);
        if (!checkboxEl) return;
        const context = await this.resolveTaskContextForMenuTarget(checkboxEl);
        if (!context) return;

        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();
        this.showTaskStateSelectorMenu(context.file, context.view, context.lineNumber, evt.clientX, evt.clientY, context.isReadingView);
    }

    handleTouchStart(evt: TouchEvent): void {
        if (evt.touches.length !== 1) return;
        const targetEl = evt.target instanceof HTMLElement ? evt.target : null;
        if (!targetEl) return;
        const checkboxEl = this.resolveTaskCheckboxTarget(targetEl);
        if (!checkboxEl) return;
        const view = this.resolveMarkdownViewForElement(checkboxEl);
        const file = view?.file;
        if (!view || !file) return;
        const isReadingView = !!checkboxEl.closest('.markdown-reading-view, .markdown-preview-view');
        const lineNumber = this.findTaskLineNumber(checkboxEl, view, isReadingView);
        if (lineNumber < 0) return;

        if (this.longPressTimerId !== null) {
            window.clearTimeout(this.longPressTimerId);
            this.longPressTimerId = null;
        }

        const touch = evt.touches[0];
        this.longPressTimerId = window.setTimeout(() => {
            this.longPressTimerId = null;
            this.suppressSyntheticClickUntil = Date.now() + 800;
            this.showTaskStateSelectorMenu(file, view, lineNumber, touch.clientX, touch.clientY, isReadingView);
        }, 550);
    }

    handleTouchMove(): void {
        this.cancelLongPress();
    }

    handleTouchEnd(): void {
        this.cancelLongPress();
    }

    handleTouchCancel(): void {
        this.cancelLongPress();
    }

    getTaskContextFromElement(targetEl: HTMLElement): {
        view: MarkdownView;
        file: TFile;
        lineNumber: number;
        isReadingView: boolean;
    } | null {
        const checkboxEl = this.resolveTaskCheckboxTarget(targetEl);
        if (!checkboxEl) return null;
        const view = this.resolveMarkdownViewForElement(checkboxEl);
        const file = view?.file;
        if (!view || !file) return null;
        const isReadingView = !!checkboxEl.closest('.markdown-reading-view, .markdown-preview-view');
        const lineNumber = this.findTaskLineNumber(checkboxEl, view, isReadingView);
        if (lineNumber < 0) return null;
        return { view, file, lineNumber, isReadingView };
    }

    getTaskSourceLineFromElement(targetEl: HTMLElement): {
        view: MarkdownView;
        file: TFile;
        lineNumber: number;
        isReadingView: boolean;
        rawLine: string;
    } | null {
        const context = this.getTaskContextFromElement(targetEl);
        if (!context) return null;
        const source = this.getViewSourceText(context.view);
        const lines = source.split('\n');
        return {
            ...context,
            rawLine: lines[context.lineNumber] ?? '',
        };
    }

    private cancelLongPress(): void {
        if (this.longPressTimerId !== null) {
            window.clearTimeout(this.longPressTimerId);
            this.longPressTimerId = null;
        }
    }

    // ── Target resolution ──────────────────────────────────────────────────

    private isTaskLineHost(targetEl: HTMLElement): boolean {
        if (!targetEl.classList.contains('cm-line')) return false;
        const text = targetEl.textContent || '';
        return CheckboxPatterns.TASK_LINE.test(text) && /\[[^\]]*\]/.test(text);
    }

    private resolveTaskCheckboxTarget(targetEl: HTMLElement): HTMLElement | null {
        const candidate = targetEl.closest('input.task-list-item-checkbox, .task-list-item-checkbox, .cm-formatting-task');
        if (candidate instanceof HTMLElement) {
            if (candidate instanceof HTMLInputElement) {
                if (candidate.type !== 'checkbox') return null;
                if (!candidate.classList.contains('task-list-item-checkbox')) return null;
                return candidate;
            }
            if (candidate.classList.contains('task-list-item-checkbox') || candidate.classList.contains('cm-formatting-task')) {
                return candidate;
            }
        }

        const renderedTaskRow = targetEl.closest('.task-list-item, .dataview-task-list-item');
        if (renderedTaskRow instanceof HTMLElement) {
            const checkbox = renderedTaskRow.querySelector('input.task-list-item-checkbox, .task-list-item-checkbox');
            if (checkbox instanceof HTMLElement) return checkbox;
            return renderedTaskRow;
        }

        const lineHost = targetEl.closest('.cm-line');
        if (lineHost instanceof HTMLElement && this.isTaskLineHost(lineHost)) {
            return lineHost;
        }
        return null;
    }

    private resolveMarkdownViewForElement(targetEl: HTMLElement): MarkdownView | null {
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            const view = leaf.view;
            if (!(view instanceof MarkdownView)) continue;
            const containerEl = (view as any).containerEl as HTMLElement | undefined;
            const contentEl = view.contentEl as HTMLElement | undefined;
            const previewContainer = (view as any).previewMode?.containerEl as HTMLElement | undefined;
            if (containerEl?.contains(targetEl) || contentEl?.contains(targetEl) || previewContainer?.contains(targetEl)) return view;
        }
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) return null;
        const activeContainer = (activeView as any).containerEl as HTMLElement | undefined;
        const activeContent = activeView.contentEl as HTMLElement | undefined;
        if (activeContainer?.contains(targetEl) || activeContent?.contains(targetEl)) return activeView;
        return null;
    }

    private findTaskLineNumber(targetEl: HTMLElement, view: MarkdownView, preferReadingViewMap = false): number {
        if (preferReadingViewMap) {
            const mappedLine = this.mapReadingCheckboxToTaskLine(targetEl, view);
            if (mappedLine >= 0) return mappedLine;
        }
        const dataLineEl = targetEl.closest('[data-line]') as HTMLElement | null;
        const rawDataLine = dataLineEl?.getAttribute('data-line') ?? '';
        const dataLine = Number.parseInt(rawDataLine, 10);
        if (Number.isFinite(dataLine)) return dataLine;

        const editorAny = view.editor as any;
        const cm = editorAny?.cm;
        if (!cm || typeof cm.posAtDOM !== 'function') return -1;
        const lineHost = targetEl.closest('.cm-line') as HTMLElement | null;
        const domTarget = lineHost ?? targetEl;
        try {
            let offset: number | null = null;
            try { offset = cm.posAtDOM(domTarget); } catch { offset = cm.posAtDOM(domTarget, 0); }
            if (typeof offset !== 'number' || !Number.isFinite(offset)) return -1;
            const line = cm.state?.doc?.lineAt?.(offset)?.number;
            if (typeof line !== 'number' || !Number.isFinite(line)) return -1;
            return Math.max(0, line - 1);
        } catch { return -1; }
    }

    private async resolveTaskContextForMenuTarget(targetEl: HTMLElement): Promise<{
        view: MarkdownView;
        file: TFile;
        lineNumber: number;
        isReadingView: boolean;
    } | null> {
        const view = this.resolveMarkdownViewForElement(targetEl);
        const file = view?.file;
        if (!view || !file) return null;

        const isReadingView = !!targetEl.closest('.markdown-reading-view, .markdown-preview-view');
        const lineNumber = this.findTaskLineNumber(targetEl, view, isReadingView);
        if (lineNumber >= 0) {
            return { view, file, lineNumber, isReadingView };
        }

        if (!isReadingView) return null;
        return await this.resolveRenderedTaskSourceContext(targetEl, view);
    }

    private async resolveRenderedTaskSourceContext(targetEl: HTMLElement, view: MarkdownView): Promise<{
        view: MarkdownView;
        file: TFile;
        lineNumber: number;
        isReadingView: boolean;
    } | null> {
        const taskHost = targetEl.closest<HTMLElement>('[data-task], .task-list-item, .dataview-task-list-item, li');
        if (!taskHost) return null;

        const sourcePath = this.resolveRenderedTaskSourcePath(taskHost);
        if (!sourcePath) return null;

        const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
        if (!(sourceFile instanceof TFile) || sourceFile.extension !== 'md') return null;

        const lineNumber = await this.findRenderedTaskSourceLine(sourceFile, taskHost);
        if (lineNumber < 0) return null;

        return {
            view,
            file: sourceFile,
            lineNumber,
            isReadingView: true,
        };
    }

    private resolveRenderedTaskSourcePath(taskHost: HTMLElement): string | null {
        const rowPathCarrier = taskHost.closest<HTMLElement>('[data-path], [data-file-path], [data-filepath]');
        const rowPath = rowPathCarrier?.dataset.path
            || rowPathCarrier?.getAttribute('data-file-path')
            || rowPathCarrier?.getAttribute('data-filepath');
        if (typeof rowPath === 'string' && rowPath.trim().length > 0) {
            return rowPath.trim();
        }

        const sourceLink = taskHost.querySelector<HTMLElement>('[data-path], [data-file-path], [data-filepath]');
        const sourceLinkPath = sourceLink?.dataset.path
            || sourceLink?.getAttribute('data-file-path')
            || sourceLink?.getAttribute('data-filepath');
        if (typeof sourceLinkPath === 'string' && sourceLinkPath.trim().length > 0) {
            return sourceLinkPath.trim();
        }

        const noteLink = taskHost.querySelector<HTMLElement>('a.internal-link, [data-href], [data-linkpath], [data-file]');
        const href = noteLink?.dataset.href || noteLink?.getAttribute('data-href') || noteLink?.dataset.linkpath || noteLink?.dataset.file;
        if (typeof href === 'string' && href.trim().length > 0) {
            const resolved = this.app.metadataCache.getFirstLinkpathDest(href.trim(), '');
            if (resolved instanceof TFile) return resolved.path;
        }

        return null;
    }

    private async findRenderedTaskSourceLine(sourceFile: TFile, taskHost: HTMLElement): Promise<number> {
        const content = await this.app.vault.cachedRead(sourceFile);
        const lines = content.split('\n');
        const cache = this.app.metadataCache.getFileCache(sourceFile) as any;
        const listItems = Array.isArray(cache?.listItems) ? cache.listItems : [];
        const renderedText = this.normalizeTaskTextForComparison(this.getRenderedTaskText(taskHost));
        if (!renderedText) return -1;

        let fallbackLine = -1;
        for (const item of listItems) {
            const line = Number(item?.position?.start?.line);
            const taskState = String(item?.task ?? '');
            if (!Number.isFinite(line) || line < 0 || line >= lines.length) continue;
            if (!taskState.length) continue;

            const normalizedLine = this.normalizeTaskTextForComparison(lines[line] || '');
            if (!normalizedLine) continue;
            if (normalizedLine === renderedText) return line;
            if (fallbackLine < 0 && (normalizedLine.includes(renderedText) || renderedText.includes(normalizedLine))) {
                fallbackLine = line;
            }
        }

        return fallbackLine;
    }

    private getRenderedTaskText(taskHost: HTMLElement): string {
        const rowContent = taskHost.querySelector<HTMLElement>(':scope > .list-item, :scope > .list-item-content, :scope > .list-item-inner, :scope > p');
        const cloneSource = rowContent ?? taskHost;
        const clone = cloneSource.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('input, .task-list-item-checkbox').forEach((el) => el.remove());
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

    private getViewSourceText(view: MarkdownView): string {
        const editor = view.editor as any;
        if (editor && typeof editor.getValue === 'function') {
            const value = editor.getValue();
            if (typeof value === 'string') return value;
        }
        const rawData = (view as any)?.data;
        if (typeof rawData === 'string') return rawData;
        return '';
    }

    private mapReadingCheckboxToTaskLine(targetEl: HTMLElement, view: MarkdownView): number {
        const readingRoot = targetEl.closest('.markdown-reading-view, .markdown-preview-view');
        if (!(readingRoot instanceof HTMLElement)) return -1;
        let inputEl: HTMLInputElement | null = null;
        if (targetEl instanceof HTMLInputElement && targetEl.type === 'checkbox') {
            inputEl = targetEl;
        } else {
            inputEl = targetEl.closest('.task-list-item')?.querySelector('input.task-list-item-checkbox') ?? null;
        }
        if (!inputEl) return -1;
        const checkboxes = Array.from(readingRoot.querySelectorAll('input.task-list-item-checkbox'));
        const checkboxIndex = checkboxes.indexOf(inputEl);
        if (checkboxIndex < 0) return -1;
        const source = this.getViewSourceText(view);
        if (!source) return -1;
        const lines = source.split('\n');
        const taskLineNumbers: number[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (this.applyNextTaskStateToLine(lines[i])) taskLineNumbers.push(i);
        }
        if (checkboxIndex >= taskLineNumbers.length) return -1;
        return taskLineNumbers[checkboxIndex];
    }

    // ── Recency dedup ──────────────────────────────────────────────────────

    private isRecentTaskCycleClick(filePath: string, lineNumber: number): boolean {
        const key = `${filePath}:${lineNumber}`;
        const now = Date.now();
        this.clearExpiredTaskCycleClickMarks(now);
        const previous = this.recentTaskCycleClicks.get(key);
        return typeof previous === 'number' && (now - previous) < 200;
    }

    private setRecentTaskCycleClick(filePath: string, lineNumber: number): void {
        this.recentTaskCycleClicks.set(`${filePath}:${lineNumber}`, Date.now());
    }

    private clearExpiredTaskCycleClickMarks(now: number): void {
        if (this.recentTaskCycleClicks.size < 100) return;
        for (const [key, ts] of this.recentTaskCycleClicks.entries()) {
            if ((now - ts) > 5000) this.recentTaskCycleClicks.delete(key);
        }
    }

    private triggerNativeCheckboxClick(checkboxEl: HTMLElement): void {
        let inputEl: HTMLInputElement | null = null;
        if (checkboxEl instanceof HTMLInputElement && checkboxEl.type === 'checkbox') {
            inputEl = checkboxEl;
        } else {
            inputEl = checkboxEl.closest('.task-list-item')?.querySelector('input.task-list-item-checkbox') ?? null;
        }
        if (!inputEl) return;
        this.bypassNextTaskCycleClick = true;
        try { inputEl.click(); }
        catch (error) { logger.warn('[TPS GCM] Native checkbox fallback click failed', error); }
        finally { window.setTimeout(() => { this.bypassNextTaskCycleClick = false; }, 0); }
    }

    // ── State cycling ──────────────────────────────────────────────────────

    private async cycleTaskState(file: TFile, view: MarkdownView, lineNumber: number, preferVaultWrite = false, strictLine = false): Promise<boolean> {
        const liveViewContent = !preferVaultWrite ? this.getViewSourceText(view) : '';
        const content = liveViewContent || await this.app.vault.read(file);
        const lines = content.split('\n');
        let candidateLine = -1;
        if (lineNumber >= 0 && lineNumber < lines.length && this.applyNextTaskStateToLine(lines[lineNumber])) {
            candidateLine = lineNumber;
        } else if (!strictLine) {
            candidateLine = this.resolveCandidateTaskLine(lines, lineNumber);
        }
        if (candidateLine < 0) return false;
        const next = this.applyNextTaskStateToLine(lines[candidateLine]);
        if (!next) return false;
        const previousState = this.getTaskLineState(lines[candidateLine]);
        lines[candidateLine] = this.applyTaskVisualInlineProperties(file, next.nextLine);
        const updatedContent = lines.join('\n');
        if (updatedContent === content) return false;
        await this.app.vault.modify(file, updatedContent);
        await this.applyRulesAfterTaskMutation(file);
        await this.maybeStopTimerOnTerminalState(file, previousState, next.nextState, candidateLine);
        await this.maybePromptToCompleteNote(file, previousState, next.nextState, lines);
        this.scheduleChecklistReorder(file);
        return true;
    }

    private async setTaskState(
        file: TFile,
        view: MarkdownView,
        lineNumber: number,
        targetState: CheckboxStateChar,
        preferVaultWrite = false,
        strictLine = false,
    ): Promise<boolean> {
        const liveViewContent = !preferVaultWrite ? this.getViewSourceText(view) : '';
        const content = liveViewContent || await this.app.vault.read(file);
        const lines = content.split('\n');
        let candidateLine = -1;
        const lineState = this.getTaskLineState(lines[lineNumber] ?? '');
        if (lineNumber >= 0 && lineNumber < lines.length && lineState) {
            candidateLine = lineNumber;
        } else if (!strictLine) {
            candidateLine = this.resolveCandidateTaskLine(lines, lineNumber);
        }
        if (candidateLine < 0) return false;
        const previousState = this.getTaskLineState(lines[candidateLine]);
        const nextLine = this.applySpecificTaskStateToLine(lines[candidateLine], targetState);
        if (!nextLine || nextLine === lines[candidateLine]) return false;
        lines[candidateLine] = this.applyTaskVisualInlineProperties(file, nextLine);
        const updatedContent = lines.join('\n');
        if (updatedContent === content) return false;
        await this.app.vault.modify(file, updatedContent);
        await this.applyRulesAfterTaskMutation(file);
        await this.maybeStopTimerOnTerminalState(file, previousState, targetState, candidateLine);
        await this.maybePromptToCompleteNote(file, previousState, targetState, lines);
        this.scheduleChecklistReorder(file);
        return true;
    }

    private async applyRulesAfterTaskMutation(file: TFile): Promise<void> {
        try {
            await applyRulesToFileShared(this.app, file, 'gcm-task-checkbox-update');
        } catch (error) {
            logger.warn('[TPS GCM] Failed reapplying rules after task checkbox mutation', { file: file.path, error });
        }
    }

    private applySpecificTaskStateToLine(line: string, targetState: CheckboxStateChar): string | null {
        const match = line.match(CheckboxPatterns.CHECKBOX_LINE_CAPTURE);
        if (!match) return null;
        return `${match[1]}[${targetState}] ${match[3] || ''}`.replace(/\s+$/, ' ');
    }

    private applyTaskVisualInlineProperties(file: TFile, line: string): string {
        const parsed = this.plugin.itemSemanticsService.parseTaskLine(line);
        if (!parsed || parsed.kind !== 'task') return line;

        const rules = Array.isArray(this.plugin.settings.notebookNavigatorRules)
            ? this.plugin.settings.notebookNavigatorRules
            : [];
        if (rules.length === 0) return line;

        const cache = this.app.metadataCache.getFileCache(file);
        const parentFrontmatter = { ...((cache?.frontmatter || {}) as Record<string, unknown>) };
        const mergedFrontmatter: Record<string, unknown> = { ...parentFrontmatter };
        for (const [key, value] of Object.entries(parsed.inlineProperties || {})) {
            const normalizedKey = String(key || '').trim().toLowerCase();
            if (!normalizedKey || normalizedKey === 'color' || normalizedKey === 'icon') continue;
            if (value !== undefined && value !== null && String(value).trim()) {
                mergedFrontmatter[key] = value;
            }
        }

        const taskStatus = String(parsed.inlineProperties.status || this.getRuleTaskStatusFromCheckbox(parsed.checkboxState || '[ ]')).trim();
        if (taskStatus) {
            mergedFrontmatter.status = taskStatus;
        }
        mergedFrontmatter.title = parsed.text;
        mergedFrontmatter.name = parsed.text;
        mergedFrontmatter.text = parsed.text;
        mergedFrontmatter.body = parsed.text;

        const parentTags = new Set<string>();
        for (const rawTag of getAllTags(cache || {}) || []) {
            const normalized = normalizeTagValue(rawTag);
            if (normalized) parentTags.add(normalized);
        }

        const context: RuleEvaluationContext = {
            file: {
                path: `${file.path}::task-checkbox`,
                name: `${parsed.text || file.basename}.md`,
                basename: parsed.text || file.basename,
                extension: 'md',
            },
            frontmatter: mergedFrontmatter,
            tags: Array.from(parentTags),
            body: parsed.text,
            parent: {
                file: {
                    path: file.path,
                    name: file.name,
                    basename: file.basename,
                    extension: file.extension,
                },
                frontmatter: parentFrontmatter,
                tags: Array.from(parentTags),
            },
        };

        let updated = line;
        try {
            const visual = evaluateIconColorRules(this.app, rules, context);
            updated = this.setTaskInlineProperty(updated, 'icon', String(visual?.icon?.value || '').trim() || null);
            updated = this.setTaskInlineProperty(updated, 'color', this.formatTaskInlineColorValue(visual?.color?.value));
            return updated;
        } catch (error) {
            logger.warn('[TPS GCM] Failed applying task visual inline properties after checkbox update', { file: file.path, error });
            return line;
        }
    }

    private setTaskInlineProperty(line: string, key: string, value: string | null): string {
        const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const propertyRe = new RegExp(`\\s*\\[${escapedKey}::\\s*[^\\]]*\\]`, 'i');
        if (!value) {
            return line.replace(propertyRe, '').replace(/\s{2,}/g, ' ').trimEnd();
        }

        const propertyText = `[${key}:: ${value}]`;
        const updated = propertyRe.test(line)
            ? line.replace(propertyRe, ` ${propertyText}`)
            : `${line} ${propertyText}`;
        return updated.replace(/\s{2,}/g, ' ').trimEnd();
    }

    private formatTaskInlineColorValue(value: unknown): string | null {
        const formatted = String(value ?? '').trim();
        if (!formatted) return null;

        const match = formatted.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (!match) return formatted;

        const hex = match[1];
        if (hex.length === 3) {
            return hex.split('').map((char) => char + char).join('').toLowerCase();
        }

        return hex.toLowerCase();
    }

    private getRuleTaskStatusFromCheckbox(checkboxState: string): string {
        const normalized = String(checkboxState || '').replace(/^\[|\]$/g, '').trim();
        if (/^[xX]$/.test(normalized)) return 'complete';
        if (normalized === '-') return 'wont-do';
        if (normalized === '/') return 'working';
        if (normalized === '?') return 'holding';
        return 'open';
    }

    private showTaskStateSelectorMenu(
        file: TFile,
        view: MarkdownView,
        lineNumber: number,
        x: number,
        y: number,
        isReadingView: boolean,
    ): void {
        const menu = new Menu();
        const options: Array<{ state: ' ' | 'x' | '?' | '-' | '/'; label: string }> = [
            { state: ' ', label: 'Todo [ ]' },
            { state: '/', label: 'Working [/]' },
            { state: '?', label: 'Holding [?]' },
            { state: 'x', label: 'Complete [x]' },
            { state: '-', label: "Won\u2019t Do [-]" },
        ];

        for (const option of options) {
            menu.addItem((item) => {
                item.setTitle(option.label).onClick(() => {
                    void this.setTaskState(file, view, lineNumber, option.state, isReadingView, isReadingView);
                });
            });
        }

        menu.addSeparator();
        menu.addItem((item) => {
            item.setTitle('Start Time Tracking')
                .setIcon('timer')
                .onClick(() => {
                    void this.plugin.timeTrackingService.startFromTaskLine(file, view, lineNumber, isReadingView);
                });
        });

        menu.showAtPosition({ x, y });
    }

    private async maybeStopTimerOnTerminalState(
        file: TFile,
        previousState: CheckboxStateChar | null,
        nextState: CheckboxStateChar,
        lineNumber: number,
    ): Promise<void> {
        if ((nextState !== 'x' && nextState !== '-') || previousState === nextState) return;
        try {
            await this.plugin.timeTrackingService.stopTimerForTerminalTaskState(file, lineNumber);
        } catch (error) {
            logger.warn('[TPS GCM] Failed stopping timer from task terminal state change', { file: file.path, lineNumber, error });
        }
    }

    private async maybePromptToCompleteNote(
        file: TFile,
        previousState: CheckboxStateChar | null,
        nextState: CheckboxStateChar,
        updatedLines: string[],
    ): Promise<void> {
        // Prompt only when an open checklist item [ ] is moved to any non-open state.
        if (previousState !== ' ') return;
        if (nextState === ' ') return;
        if (this.hasOpenChecklistItems(updatedLines)) return;
        const cache = this.app.metadataCache.getFileCache(file);
        const status = String(cache?.frontmatter?.status ?? '').trim().toLowerCase();
        if (status === 'complete' || status === 'wont-do') return;
        const statusChoices = this.getChecklistFinalPromptStatuses();
        if (statusChoices.length === 0) return;
        const chosenStatus = await this.promptForFinalChecklistStatus(statusChoices);
        if (!chosenStatus) return;
        try {
            await this.plugin.bulkEditService.setStatus([file], chosenStatus, { userInitiated: true });
        } catch (error) {
            logger.warn('[TPS GCM] Failed auto-completing note after last checkbox completion', { file: file.path, error });
        }
    }

    /**
     * Shared post-mutation pipeline for checklist state changes performed outside
     * the native markdown checkbox click handler (e.g. panel/reminder UI).
     * This keeps checklist property sync, reorder, and final-status prompting
     * consistent no matter where the edit originated.
     */
    async handleExternalChecklistStateMutation(
        file: TFile,
        previousState: CheckboxStateChar | null,
        nextState: CheckboxStateChar,
        updatedLines: string[],
    ): Promise<void> {
        await this.maybePromptToCompleteNote(file, previousState, nextState, updatedLines);
        this.scheduleChecklistReorder(file);
    }

    private hasOpenChecklistItems(lines: string[]): boolean {
        return lines.some((line) => CheckboxPatterns.OPEN_CHECKBOX.test(line));
    }

    private getChecklistFinalPromptStatuses(): string[] {
        const configured = Array.isArray(this.plugin.settings.checklistFinalPromptStatuses)
            ? this.plugin.settings.checklistFinalPromptStatuses
            : [];
        const normalized = configured
            .map((value) => String(value || '').trim())
            .filter(Boolean);
        if (normalized.length > 0) return normalized;
        return ['complete', 'wont-do'];
    }

    private async promptForFinalChecklistStatus(statuses: string[]): Promise<string | null> {
        return await new Promise<string | null>((resolve) => {
            new StatusChoiceModal(this.app, statuses, (status) => resolve(status)).open();
        });
    }

    private resolveCandidateTaskLine(lines: string[], preferredLine: number): number {
        if (preferredLine >= 0 && preferredLine < lines.length && this.applyNextTaskStateToLine(lines[preferredLine])) return preferredLine;
        for (let offset = 1; offset <= 3; offset++) {
            const above = preferredLine - offset;
            if (above >= 0 && above < lines.length && this.applyNextTaskStateToLine(lines[above])) return above;
            const below = preferredLine + offset;
            if (below >= 0 && below < lines.length && this.applyNextTaskStateToLine(lines[below])) return below;
        }
        return -1;
    }

    private applyNextTaskStateToLine(line: string): { nextLine: string; nextState: CheckboxStateChar } | null {
        const match = line.match(CheckboxPatterns.CHECKBOX_LINE_CAPTURE);
        if (!match) return null;
        const nextState = this.getNextTaskState(match[2]);
        if (!nextState) return null;
        return { nextLine: `${match[1]}[${nextState}] ${match[3] || ''}`.replace(/\s+$/, ' '), nextState };
    }

    private getNextTaskState(currentState: string): CheckboxStateChar | null {
        if (currentState === ' ') return '/';
        if (currentState === '/') return 'x';
        if (currentState === 'x' || currentState === 'X') return '?';
        if (currentState === '?') return '-';
        if (currentState === '-') return ' ';
        return null;
    }

    // ── Checklist reordering ───────────────────────────────────────────────

    private getTaskLineState(line: string): CheckboxStateChar | null {
        const match = line.match(CheckboxPatterns.CHECKBOX_WITH_STATE);
        return match ? (match[1] as CheckboxStateChar) : null;
    }

    private getTaskLineIndent(line: string): string | null {
        const match = line.match(CheckboxPatterns.CHECKBOX_LINE_CAPTURE);
        return match ? match[1] : null;
    }

    private getTaskSortRank(state: CheckboxStateChar): number {
        if (state === '?') return 0;
        if (state === ' ') return 1;
        if (state === '/') return 2;
        if (state === '-') return 3;
        return 4;
    }

    scheduleChecklistReorder(file: TFile): void {
        const key = file.path;
        const existingTimer = this.pendingChecklistReorderTimers.get(key);
        if (typeof existingTimer === 'number') window.clearTimeout(existingTimer);
        const timerId = window.setTimeout(() => {
            this.pendingChecklistReorderTimers.delete(key);
            void this.runDelayedChecklistReorder(key);
        }, 5000);
        this.pendingChecklistReorderTimers.set(key, timerId);
    }

    private async runDelayedChecklistReorder(filePath: string): Promise<void> {
        try {
            const af = this.app.vault.getAbstractFileByPath(filePath);
            if (!(af instanceof TFile) || af.extension !== 'md') return;
            const content = await this.app.vault.read(af);
            const lines = content.split('\n');
            const changed = this.reorderAllChecklistBlocks(lines);
            if (!changed) return;
            const updatedContent = lines.join('\n');
            if (updatedContent !== content) await this.app.vault.modify(af, updatedContent);
        } catch (error) {
            logger.warn('[TPS GCM] Delayed checklist reorder failed', { filePath, error });
        }
    }

    private reorderAllChecklistBlocks(lines: string[]): boolean {
        let changed = false;
        for (let i = 0; i < lines.length; i++) {
            const state = this.getTaskLineState(lines[i]);
            const indent = this.getTaskLineIndent(lines[i]);
            if (!state || indent === null) continue;
            let end = i;
            while (end + 1 < lines.length) {
                if (!this.getTaskLineState(lines[end + 1]) || this.getTaskLineIndent(lines[end + 1]) !== indent) break;
                end++;
            }
            if (this.reorderChecklistRange(lines, i, end)) changed = true;
            i = end;
        }
        return changed;
    }

    private reorderChecklistRange(lines: string[], start: number, end: number): boolean {
        if (start < 0 || end >= lines.length || end <= start) return false;
        const block = lines.slice(start, end + 1);
        const ranked = block.map((line, index) => {
            const state = this.getTaskLineState(line);
            return { line, index, rank: state ? this.getTaskSortRank(state) : 999 };
        });
        ranked.sort((a, b) => (a.rank - b.rank) || (a.index - b.index));
        const sortedBlock = ranked.map((e) => e.line);
        let changed = false;
        for (let i = 0; i < block.length; i++) {
            if (block[i] !== sortedBlock[i]) { changed = true; break; }
        }
        if (!changed) return false;
        for (let i = 0; i < sortedBlock.length; i++) lines[start + i] = sortedBlock[i];
        return true;
    }
}
