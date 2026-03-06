import { App, TFile, MarkdownView } from 'obsidian';
import * as logger from '../logger';
import type TPSGlobalContextMenuPlugin from '../main';

/**
 * Handles the task checkbox state cycle ([ ] → [x] → [?] → [-] → [ ])
 * and the automatic checklist block reordering that follows a state change.
 *
 * Extracted from main.ts to keep the main class under 500 lines.
 */
export class TaskCheckboxHandler {
    private app: App;
    private pendingChecklistReorderTimers: Map<string, number> = new Map();
    private pendingPropertyUpdateTimers: Map<string, number> = new Map();
    private bypassNextTaskCycleClick = false;
    private recentTaskCycleClicks: Map<string, number> = new Map();

    constructor(private plugin: TPSGlobalContextMenuPlugin) {
        this.app = plugin.app;
    }

    async handleClick(evt: MouseEvent): Promise<void> {
        if (!this.plugin.settings.enableTaskCheckboxCycle) return;
        if (this.bypassNextTaskCycleClick) return;
        if (evt.button !== 0) return;

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

        if (this.isRecentTaskCycleClick(file.path, lineNumber)) return;
        this.setRecentTaskCycleClick(file.path, lineNumber);

        evt.preventDefault();
        evt.stopPropagation();
        evt.stopImmediatePropagation();

        try {
            const shouldUseVaultWrite = isReadingView;
            const updated = await this.cycleTaskState(file, view, lineNumber, shouldUseVaultWrite, isReadingView);
            if (!updated) {
                this.recentTaskCycleClicks.delete(`${file.path}:${lineNumber}`);
                this.triggerNativeCheckboxClick(checkboxEl);
            }
        } catch (error) {
            this.recentTaskCycleClicks.delete(`${file.path}:${lineNumber}`);
            logger.warn('[TPS GCM] Checkbox cycle failed', { file: file.path, lineNumber, error });
            this.triggerNativeCheckboxClick(checkboxEl);
        }
    }

    dispose(): void {
        for (const timerId of this.pendingChecklistReorderTimers.values()) {
            window.clearTimeout(timerId);
        }
        this.pendingChecklistReorderTimers.clear();
        for (const timerId of this.pendingPropertyUpdateTimers.values()) {
            window.clearTimeout(timerId);
        }
        this.pendingPropertyUpdateTimers.clear();
    }

    // ── Target resolution ──────────────────────────────────────────────────

    private resolveTaskCheckboxTarget(targetEl: HTMLElement): HTMLElement | null {
        const candidate = targetEl.closest('input.task-list-item-checkbox, .task-list-item-checkbox, .cm-formatting-task');
        if (!(candidate instanceof HTMLElement)) return null;
        if (candidate instanceof HTMLInputElement) {
            if (candidate.type !== 'checkbox') return null;
            if (!candidate.classList.contains('task-list-item-checkbox')) return null;
            return candidate;
        }
        if (candidate.classList.contains('task-list-item-checkbox') || candidate.classList.contains('cm-formatting-task')) {
            return candidate;
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
        lines[candidateLine] = next.nextLine;
        const updatedContent = lines.join('\n');
        if (updatedContent === content) return false;
        await this.app.vault.modify(file, updatedContent);
        this.scheduleChecklistPropertyUpdate(file);
        this.scheduleChecklistReorder(file);
        return true;
    }

    // ── Checklist completion property ─────────────────────────────────────

    scheduleChecklistPropertyUpdate(file: TFile): void {
        const key = file.path;
        const existing = this.pendingPropertyUpdateTimers.get(key);
        if (typeof existing === 'number') window.clearTimeout(existing);
        const timerId = window.setTimeout(() => {
            this.pendingPropertyUpdateTimers.delete(key);
            void this.runChecklistPropertyUpdate(key);
        }, 300);
        this.pendingPropertyUpdateTimers.set(key, timerId);
    }

    private async runChecklistPropertyUpdate(filePath: string): Promise<void> {
        if (!this.plugin.settings.enableChecklistCompletionProperty) return;
        const propKey = this.plugin.settings.checklistCompletionPropertyKey?.trim();
        if (!propKey) return;

        const af = this.plugin.app.vault.getAbstractFileByPath(filePath);
        if (!(af instanceof TFile) || af.extension !== 'md') return;

        let content: string;
        try {
            content = await this.plugin.app.vault.cachedRead(af);
        } catch (error) {
            logger.warn('[TPS GCM] Failed to read file for checklist property update', { filePath, error });
            return;
        }

        const lines = content.split('\n');
        const checklistStates: string[] = [];
        for (const line of lines) {
            const match = line.match(/^\s*(?:[-*+]|\d+\.)\s*\[( |x|X|\?|-)\]/);
            if (match) checklistStates.push(match[1]);
        }

        if (checklistStates.length === 0) return;

        const allDone = checklistStates.every((s) => s === 'x' || s === 'X' || s === '-');

        // Guard against infinite loop: skip if frontmatter already has the correct value
        const cache = this.plugin.app.metadataCache.getFileCache(af);
        if (cache?.frontmatter?.[propKey] === allDone) return;

        try {
            await this.plugin.bulkEditService.runSerializedFrontmatterWrite(af, async () => {
                await this.plugin.app.fileManager.processFrontMatter(af, (fm) => {
                    fm[propKey] = allDone;
                });
            });
        } catch (error) {
            logger.warn('[TPS GCM] Failed to write checklist completion property', { filePath, error });
        }
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

    private applyNextTaskStateToLine(line: string): { nextLine: string; nextState: ' ' | 'x' | '?' | '-' } | null {
        const match = line.match(/^(\s*(?:[-*+]|\d+\.)\s*)\[( |x|X|\?|-)\](.*)$/);
        if (!match) return null;
        const nextState = this.getNextTaskState(match[2]);
        if (!nextState) return null;
        return { nextLine: `${match[1]}[${nextState}]${match[3]}`, nextState };
    }

    private getNextTaskState(currentState: string): ' ' | 'x' | '?' | '-' | null {
        if (currentState === ' ') return 'x';
        if (currentState === 'x' || currentState === 'X') return '?';
        if (currentState === '?') return '-';
        if (currentState === '-') return ' ';
        return null;
    }

    // ── Checklist reordering ───────────────────────────────────────────────

    private getTaskLineState(line: string): ' ' | 'x' | 'X' | '?' | '-' | null {
        const match = line.match(/^\s*(?:[-*+]|\d+\.)\s*\[( |x|X|\?|-)\]/);
        return match ? (match[1] as ' ' | 'x' | 'X' | '?' | '-') : null;
    }

    private getTaskLineIndent(line: string): string | null {
        const match = line.match(/^(\s*)(?:[-*+]|\d+\.)\s*\[(?: |x|X|\?|-)\]/);
        return match ? match[1] : null;
    }

    private getTaskSortRank(state: ' ' | 'x' | 'X' | '?' | '-'): number {
        if (state === '?') return 0;
        if (state === ' ') return 1;
        if (state === '-') return 2;
        return 3;
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
