import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { FuzzySuggestModal, MarkdownView, Modal, Notice, TFile } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import { getSubitemIdFromRecord, SUBITEM_ID_KEY } from '../utils/subitem-id';
import { getFileDisplayTitle } from '../utils/file-display-title';
import { extractLinkTargetsFromText, resolveLinkTargetToFile } from './link-target-service';
import { FileSuggestModal } from '../modals/FileSuggestModal';
import { TextInputModal } from '../modals/text-input-modal';
import { getDailyNoteResolver } from '../../../TPS-Controller (Dev)/src/utils/daily-note-resolver';
import { ensureDailyNoteFile } from '../../../TPS-Controller (Dev)/src/utils/daily-note-create';

const BADGE_CLASS = 'tps-gcm-time-tracker-badge';
const RUNNING_BADGE_CLASS = 'tps-gcm-time-tracker-badge--running';
const STATUS_BAR_CLASS = 'mod-clickable';
const SESSION_SOURCE_PATH_KEY = 'sessionSourcePath';
const SESSION_SOURCE_LINE_KEY = 'sessionSourceLine';
const SESSION_SOURCE_TYPE_KEY = 'sessionSourceType';
const refreshTimerInlineEffect = StateEffect.define<number>();
const TIMER_LEGACY_PROPERTY_ALIASES = {
  start: ['timeStart'],
  end: ['timeEnd'],
  status: ['timeStatus'],
  id: ['timeId'],
  minutes: ['timeMinutes'],
  seconds: ['timeSeconds'],
} as const;

type LegacyTimerPropertyKind = keyof typeof TIMER_LEGACY_PROPERTY_ALIASES;

class TimerInlineWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly isRunning: boolean,
  ) {
    super();
  }

  eq(other: TimerInlineWidget): boolean {
    return other.text === this.text && other.isRunning === this.isRunning;
  }

  toDOM(): HTMLElement {
    const badge = document.createElement('span');
    badge.className = `${BADGE_CLASS}${this.isRunning ? ` ${RUNNING_BADGE_CLASS}` : ''}`;
    badge.setAttribute('contenteditable', 'false');
    badge.textContent = ` ${this.text}`;
    return badge;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

interface TimerMetadata {
  start: Date;
  status: string;
  minutes: number | null;
}

interface VaultTaskChoice {
  file: TFile;
  lineNumber: number;
  lineText: string;
  label: string;
}

interface ActiveTimerInfo {
  file: TFile;
  filePath: string;
  lineNumber: number;
  start: Date;
  label: string;
  lineText: string;
  subitemId: string;
  sourcePath: string | null;
  sourceLineNumber: number | null;
}

export interface ProjectedTimeBlock {
  sourceFile: TFile;
  lineNumber: number;
  lineText: string;
  status: string;
  start: Date;
  minutes: number | null;
  label: string;
  linkedFile: TFile | null;
  isExternal: boolean;
}

type CheckboxStateChar = ' ' | 'x' | 'X' | '?' | '-' | '/';

export class TimeTrackingService {
  private intervalId: number | null = null;
  private refreshStateTimerId: number | null = null;
  private statusBarEl: HTMLElement | null = null;
  private activeTimerInfo: ActiveTimerInfo | null = null;
  private eventsRegistered = false;
  private refreshGeneration = 0;
  private lastDurationSyncKey: string | null = null;
  private durationSyncInFlight = false;
  private editorExtension = this.createEditorExtension();

  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  start(): void {
    if (this.intervalId !== null) return;
    this.ensureStatusBar();
    this.registerStateRefreshHooks();
    this.intervalId = window.setInterval(() => this.renderTick(), 1000);
    this.scheduleActiveTimerRefresh(0);
  }

  detach(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.refreshStateTimerId !== null) {
      window.clearTimeout(this.refreshStateTimerId);
      this.refreshStateTimerId = null;
    }
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
    this.statusBarEl?.remove();
    this.statusBarEl = null;
  }

  getEditorExtension() {
    return this.editorExtension;
  }

  async getProjectedTimeBlocksForFile(targetFile: TFile): Promise<ProjectedTimeBlock[]> {
    if (!this.isMarkdownFile(targetFile)) return [];

    const targetPath = targetFile.path;
    const targetDayKey = this.getDailyNoteDateKey(targetFile);
    const isDailyNote = !!targetDayKey;
    const output: ProjectedTimeBlock[] = [];

    for (const sourceFile of this.plugin.app.vault.getMarkdownFiles()) {
      const content = await this.plugin.app.vault.cachedRead(sourceFile);
      const lines = content.split('\n');
      for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
        const lineText = lines[lineNumber] || '';
        const metadata = this.parseTimerMetadata(lineText);
        if (!metadata?.start) continue;

        const linkedFiles = this.resolveLinkedNotesForLine(lineText, sourceFile.path);
        const linkedFile = linkedFiles[0] || null;
        const matchesTarget = isDailyNote
          ? this.getDateKey(metadata.start) === targetDayKey
          : linkedFiles.some((candidate) => candidate.path === targetPath);
        if (!matchesTarget) continue;

        output.push({
          sourceFile,
          lineNumber,
          lineText,
          status: metadata.status,
          start: metadata.start,
          minutes: metadata.minutes,
          label: this.getTaskLabel(lineText) || sourceFile.basename,
          linkedFile,
          isExternal: sourceFile.path !== targetPath,
        });
      }
    }

    output.sort((left, right) => left.start.getTime() - right.start.getTime());
    return output;
  }

  async startForNote(file: TFile, label?: string): Promise<boolean> {
    if (!this.isMarkdownFile(file)) return false;
    const active = await this.getActiveTimerInfo();
    if (active) {
      if (active.sourcePath === file.path && active.sourceLineNumber === null) {
        await this.openFile(active.file);
        new Notice('Time tracking is already running for this note.');
        return false;
      }
      await this.openFile(active.file);
      new Notice(`Time tracking is already running in ${active.file.basename}.`);
      return false;
    }
    const sessionLine = this.buildRunningSessionHeading(
      label || getFileDisplayTitle(this.plugin.app, file) || file.basename,
      file,
      this.buildNoteLinkLabel(file, label),
      file.path,
      null,
      'note',
    );
    const targetFile = await this.appendSessionLineToDailyNote(sessionLine);
    if (!(targetFile instanceof TFile)) return false;
    await this.openFile(targetFile);
    this.scheduleActiveTimerRefresh();
    new Notice('Started time tracking.');
    return true;
  }

  async startFromTaskLine(
    parentFile: TFile,
    view: MarkdownView,
    lineNumber: number,
    isReadingView: boolean,
  ): Promise<boolean> {
    if (!this.isMarkdownFile(parentFile)) return false;
    const content = await this.plugin.app.vault.read(parentFile);
    const lines = content.split('\n');
    if (lineNumber < 0 || lineNumber >= lines.length) return false;
    const line = lines[lineNumber] || '';

    if (this.parseTimerMetadata(line)?.start) {
      new Notice('Set the task to complete or won\'t do to stop time tracking.');
      return false;
    }

    const active = await this.getActiveTimerInfo();
    if (active) {
      if (active.sourcePath === parentFile.path && active.sourceLineNumber === lineNumber) {
        await this.openFile(active.file);
        new Notice('Time tracking is already running for this task.');
        return false;
      }
      await this.openFile(active.file);
      new Notice(`Time tracking is already running in ${active.file.basename}.`);
      return false;
    }

    if (this.isTodayDailyNote(parentFile)) {
      const linkedNote = this.resolvePrimaryLinkedNote(line, parentFile.path) || parentFile;
      const label = this.getTaskLabel(line) || 'Time entry';
      const sessionLine = this.buildRunningSessionHeading(
        label,
        linkedNote,
        this.buildNoteLinkLabel(linkedNote, linkedNote === parentFile ? getFileDisplayTitle(this.plugin.app, parentFile) : undefined),
        parentFile.path,
        lineNumber,
        'task',
      );
      lines[lineNumber] = sessionLine;
      await this.plugin.app.vault.modify(parentFile, lines.join('\n'));
      await this.openFile(parentFile);
      this.scheduleActiveTimerRefresh();
      new Notice('Started time tracking.');
      return true;
    }

    const linkedNote = this.resolvePrimaryLinkedNote(line, parentFile.path) || parentFile;
    const label = this.getTaskLabel(line) || 'Time entry';
    const sessionLine = this.buildRunningSessionHeading(
      label,
      linkedNote,
      this.buildNoteLinkLabel(linkedNote, linkedNote === parentFile ? getFileDisplayTitle(this.plugin.app, parentFile) : undefined),
      parentFile.path,
      lineNumber,
      'task',
    );
    const targetFile = await this.appendSessionLineToDailyNote(sessionLine);
    if (!(targetFile instanceof TFile)) return false;
    await this.openFile(targetFile);
    this.scheduleActiveTimerRefresh();
    new Notice('Started time tracking.');
    return true;
  }

  async startFromDailyNoteEmptyLine(
    file: TFile,
    _view: MarkdownView,
    lineNumber: number,
  ): Promise<boolean> {
    if (!this.isMarkdownFile(file) || !this.isTodayDailyNote(file)) return false;

    const content = await this.plugin.app.vault.read(file);
    const lines = content.split('\n');
    if (lineNumber < 0 || lineNumber >= lines.length) return false;
    if (String(lines[lineNumber] || '').trim().length > 0) {
      new Notice('Time tracking from this menu is only available on an empty line.');
      return false;
    }

    const active = await this.getActiveTimerInfo();
    if (active) {
      await this.openFile(active.file);
      new Notice(`Time tracking is already running in ${active.file.basename}.`);
      return false;
    }

    const choice = await this.promptForDailyNoteSessionStart(file);
    if (!choice) return false;

    if (choice.kind === 'task') {
      return this.startFromTaskLine(choice.task.file, _view, choice.task.lineNumber, false);
    }

    const sessionLine = choice.kind === 'note'
      ? this.buildRunningSessionHeading(
          choice.label,
          choice.note,
          this.buildNoteLinkLabel(choice.note, choice.label),
          choice.note.path,
          null,
          'note',
        )
      : this.buildRunningSessionHeading(
          choice.label,
          null,
          null,
          file.path,
          null,
          'manual',
        );

    lines[lineNumber] = sessionLine;
    await this.plugin.app.vault.modify(file, lines.join('\n'));
    await this.openFile(file);
    this.scheduleActiveTimerRefresh();
    new Notice('Started time tracking.');
    return true;
  }

  async stopTimerAtLine(
    file: TFile,
    _view: MarkdownView | null,
    lineNumber: number,
    _isReadingView = false,
  ): Promise<boolean> {
    if (!this.isMarkdownFile(file)) return false;
    const content = await this.plugin.app.vault.read(file);
    const lines = content.split('\n');
    if (lineNumber < 0 || lineNumber >= lines.length) return false;
    const stoppedLine = this.buildStoppedTimerLine(lines[lineNumber]);
    if (!stoppedLine || stoppedLine === lines[lineNumber]) {
      new Notice('No running timer found on that line.');
      return false;
    }
    lines[lineNumber] = stoppedLine;
    await this.plugin.app.vault.modify(file, lines.join('\n'));
    this.scheduleActiveTimerRefresh();
    new Notice('Stopped time tracking.');
    return true;
  }

  async stopFirstRunningTimer(file: TFile): Promise<boolean> {
    if (!this.isMarkdownFile(file)) return false;
    const content = await this.plugin.app.vault.read(file);
    const lines = content.split('\n');
    const index = lines.findIndex((line) => this.isRunningTimerLine(line));
    if (index < 0) {
      new Notice('No running timer found in this note.');
      return false;
    }
    const stoppedLine = this.buildStoppedTimerLine(lines[index]);
    if (!stoppedLine) return false;
    lines[index] = stoppedLine;
    await this.plugin.app.vault.modify(file, lines.join('\n'));
    this.scheduleActiveTimerRefresh();
    new Notice('Stopped time tracking.');
    return true;
  }

  private async createTaskTimeTrackerForNote(file: TFile, label?: string): Promise<boolean> {
    return this.startForNote(file, label);
  }

  async stopTimerForTerminalTaskState(file: TFile, lineNumber: number): Promise<boolean> {
    if (!this.isMarkdownFile(file)) return false;
    const content = await this.plugin.app.vault.read(file);
    const lines = content.split('\n');
    if (lineNumber < 0 || lineNumber >= lines.length) return false;

    const line = lines[lineNumber] || '';
    if (this.isRunningTimerLine(line)) {
      const stoppedLine = this.buildStoppedTimerLine(line);
      if (!stoppedLine || stoppedLine === line) return false;
      lines[lineNumber] = stoppedLine;
      await this.plugin.app.vault.modify(file, lines.join('\n'));
      this.scheduleActiveTimerRefresh();
      return true;
    }

    const active = await this.getActiveTimerInfo();
    if (!active) return false;
    if (active.sourcePath === file.path && active.sourceLineNumber === lineNumber) {
      return this.stopFirstRunningTimer(active.file);
    }
    if (!this.lineReferencesActiveTimer(line, file.path, active, lineNumber)) return false;
    return this.stopFirstRunningTimer(active.file);
  }

  async setTimerStatusForLine(file: TFile, lineNumber: number, targetStatus: string): Promise<boolean> {
    if (!this.isMarkdownFile(file)) return false;
    const normalizedTargetStatus = String(targetStatus || '').trim().toLowerCase();
    if (!normalizedTargetStatus) return false;

    const content = await this.plugin.app.vault.read(file);
    const lines = content.split('\n');
    if (lineNumber < 0 || lineNumber >= lines.length) return false;

    const currentLine = lines[lineNumber] || '';
    const metadata = this.parseTimerMetadata(currentLine);
    if (!metadata?.start) return false;

    const nextLine = this.buildTimerLineForStatus(currentLine, metadata, normalizedTargetStatus);
    if (!nextLine || nextLine === currentLine) return false;

    lines[lineNumber] = nextLine;
    await this.plugin.app.vault.modify(file, lines.join('\n'));

    this.scheduleActiveTimerRefresh();
    return true;
  }

  private async findRunningTimerLine(file: TFile): Promise<number> {
    const content = await this.plugin.app.vault.read(file);
    return content.split('\n').findIndex((line) => this.isRunningTimerLine(line));
  }

  private isRunningTimerLine(line: string): boolean {
    const metadata = this.parseTimerMetadata(line);
    return !!metadata?.start && metadata.status === 'working';
  }

  private renderTick(): void {
    void this.syncRunningDurationProperty();
    this.renderOpenTimers();
    this.renderStatusBar();
    this.refreshLivePreviewEditors();
  }

  private ensureStatusBar(): void {
    if (this.statusBarEl) return;
    this.statusBarEl = this.plugin.addStatusBarItem();
    this.statusBarEl.addClass(STATUS_BAR_CLASS);
    this.statusBarEl.style.display = 'none';
    this.statusBarEl.addEventListener('click', () => {
      const active = this.activeTimerInfo;
      if (!active) return;
      void this.openFile(active.file);
    });
  }

  private registerStateRefreshHooks(): void {
    if (this.eventsRegistered) return;
    this.eventsRegistered = true;

    this.plugin.registerEvent(this.plugin.app.vault.on('modify', (file) => {
      if (file instanceof TFile && this.isMarkdownFile(file)) this.scheduleActiveTimerRefresh();
    }));
    this.plugin.registerEvent(this.plugin.app.vault.on('create', (file) => {
      if (file instanceof TFile && this.isMarkdownFile(file)) this.scheduleActiveTimerRefresh();
    }));
    this.plugin.registerEvent(this.plugin.app.vault.on('delete', () => this.scheduleActiveTimerRefresh()));
    this.plugin.registerEvent(this.plugin.app.vault.on('rename', () => this.scheduleActiveTimerRefresh()));
    this.plugin.registerEvent(this.plugin.app.workspace.on('file-open', () => this.scheduleRender()));
    this.plugin.registerEvent(this.plugin.app.workspace.on('layout-change', () => this.scheduleRender()));
  }

  private createEditorExtension() {
    const service = this;
    return ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;

        constructor(view: EditorView) {
          this.decorations = service.buildEditorDecorations(view);
        }

        update(update: ViewUpdate) {
          const hasRefreshEffect = update.transactions.some((tr) =>
            tr.effects.some((effect) => effect.is(refreshTimerInlineEffect)),
          );

          if (update.docChanged || update.viewportChanged || hasRefreshEffect) {
            this.decorations = service.buildEditorDecorations(update.view);
          }
        }
      },
      {
        decorations: (value) => value.decorations,
      },
    );
  }

  private buildEditorDecorations(view: EditorView): DecorationSet {
    const markdownView = this.resolveMarkdownViewForEditor(view);
    const file = markdownView?.file;
    if (!(markdownView instanceof MarkdownView) || !(file instanceof TFile)) {
      return Decoration.none;
    }

    const mode = typeof (markdownView as any)?.getMode === 'function'
      ? (markdownView as any).getMode()
      : null;
    if (mode !== 'source') {
      return Decoration.none;
    }

    const builder = new RangeSetBuilder<Decoration>();
    for (const lineNumber of this.getVisibleLineNumbers(view)) {
      const line = view.state.doc.line(lineNumber);
      const badgeState = this.getBadgeStateForLine(line.text, file.path);
      if (!badgeState) continue;
      builder.add(
        line.to,
        line.to,
        Decoration.widget({
          widget: new TimerInlineWidget(badgeState.text, badgeState.isRunning),
          side: 1,
          inclusive: false,
        }),
      );
    }
    return builder.finish();
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

  private refreshLivePreviewEditors(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const markdownView = leaf.view;
      if (!(markdownView instanceof MarkdownView)) continue;
      const mode = typeof (markdownView as any)?.getMode === 'function'
        ? (markdownView as any).getMode()
        : null;
      if (mode !== 'source') continue;
      const cm = (markdownView.editor as any)?.cm as EditorView | undefined;
      if (!cm || typeof cm.dispatch !== 'function') continue;
      try {
        cm.dispatch({ effects: refreshTimerInlineEffect.of(Date.now()) });
      } catch {
        // Ignore stale editors during workspace churn.
      }
    }
  }

  private async getActiveTimerInfo(): Promise<ActiveTimerInfo | null> {
    if (this.activeTimerInfo) return this.activeTimerInfo;
    await this.refreshActiveTimerState();
    return this.activeTimerInfo;
  }

  private scheduleActiveTimerRefresh(delayMs = 80): void {
    if (this.refreshStateTimerId !== null) {
      window.clearTimeout(this.refreshStateTimerId);
      this.refreshStateTimerId = null;
    }
    this.refreshStateTimerId = window.setTimeout(() => {
      this.refreshStateTimerId = null;
      void this.refreshActiveTimerState();
    }, Math.max(0, delayMs));
  }

  private async refreshActiveTimerState(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const next = await this.scanForActiveTimer();
    if (generation !== this.refreshGeneration) return;
    this.activeTimerInfo = next;
    if (!next) this.lastDurationSyncKey = null;
    this.renderTick();
  }

  private async scanForActiveTimer(): Promise<ActiveTimerInfo | null> {
    const markdownFiles = this.plugin.app.vault.getMarkdownFiles();
    for (const file of markdownFiles) {
      const content = await this.plugin.app.vault.cachedRead(file);
      const candidate = this.extractActiveTimerFromContent(file, content);
      if (candidate) return candidate;
    }
    return null;
  }

  private extractActiveTimerFromContent(file: TFile, content: string): ActiveTimerInfo | null {
    const lines = content.split('\n');
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
      const line = lines[lineNumber] || '';
      const metadata = this.parseTimerMetadata(line);
      if (!metadata?.start || metadata.status !== 'working') continue;
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const subitemId = getSubitemIdFromRecord((cache?.frontmatter || {}) as Record<string, unknown>);
      const sourceMetadata = this.parseSessionSourceMetadata(line);
      return {
        file,
        filePath: file.path,
        lineNumber,
        start: metadata.start,
        label: this.getTrackedLineLabel(line) || file.basename,
        lineText: line,
        subitemId,
        sourcePath: sourceMetadata.path,
        sourceLineNumber: sourceMetadata.lineNumber,
      };
    }
    return null;
  }

  private async syncRunningDurationProperty(): Promise<void> {
    const active = this.activeTimerInfo;
    if (!active) {
      this.lastDurationSyncKey = null;
      return;
    }

    const elapsedMinutes = Math.max(0, Math.floor((Date.now() - active.start.getTime()) / 60000));
    if (elapsedMinutes <= 0) return;

    const syncKey = `${active.filePath}:${active.start.getTime()}:${elapsedMinutes}`;
    if (this.lastDurationSyncKey === syncKey || this.durationSyncInFlight) return;

    this.durationSyncInFlight = true;
    try {
      const content = await this.plugin.app.vault.read(active.file);
      const lines = content.split('\n');
      const lineIndex = this.resolveActiveTimerLineIndex(lines, active);
      if (lineIndex < 0) return;

      const currentLine = lines[lineIndex] || '';
      const metadata = this.parseTimerMetadata(currentLine);
      if (!metadata?.start || metadata.status !== 'working') return;

      const nextLine = this.buildRunningDurationLine(currentLine, elapsedMinutes);
      if (!nextLine) return;
      if (nextLine !== currentLine) {
        lines[lineIndex] = nextLine;
        await this.plugin.app.vault.modify(active.file, lines.join('\n'));
        this.activeTimerInfo = {
          ...active,
          lineNumber: lineIndex,
          lineText: nextLine,
        };
      }
      this.lastDurationSyncKey = syncKey;
    } finally {
      this.durationSyncInFlight = false;
    }
  }

  private resolveActiveTimerLineIndex(lines: string[], active: ActiveTimerInfo): number {
    if (active.lineNumber >= 0 && active.lineNumber < lines.length) {
      const currentLine = lines[active.lineNumber] || '';
      const metadata = this.parseTimerMetadata(currentLine);
      if (metadata?.start && metadata.status === 'working' && metadata.start.getTime() === active.start.getTime()) {
        return active.lineNumber;
      }
    }

    return lines.findIndex((line) => {
      const metadata = this.parseTimerMetadata(line);
      return !!metadata?.start && metadata.status === 'working' && metadata.start.getTime() === active.start.getTime();
    });
  }

  private getConfiguredPropertyKey(propertyId: 'scheduled' | 'status' | 'timeEstimate', fallback: string): string {
    const configured = Array.isArray(this.plugin.settings.properties)
      ? this.plugin.settings.properties.find((prop) => {
          const id = String(prop?.id || '').trim().toLowerCase();
          return id === propertyId.toLowerCase();
        })
      : null;
    return String(configured?.key || fallback).trim() || fallback;
  }

  private getScheduledPropertyKey(): string {
    return this.getConfiguredPropertyKey('scheduled', 'scheduled');
  }

  private getStatusPropertyKey(): string {
    return this.getConfiguredPropertyKey('status', 'status');
  }

  private getTimeEstimatePropertyKey(): string {
    return this.getConfiguredPropertyKey('timeEstimate', 'timeEstimate');
  }

  private async promptForScheduledConflictAction(file: TFile): Promise<'overwrite' | 'task' | null> {
    return new Promise<'overwrite' | 'task' | null>((resolve) => {
      const modal = new Modal(this.plugin.app);
      let settled = false;
      const finish = (value: 'overwrite' | 'task' | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      modal.titleEl.textContent = 'Scheduled values already exist';
      modal.contentEl.createEl('p', {
        text: `${file.basename} already has scheduled values. Do you want to overwrite them for note-level tracking or create a task time tracker instead?`,
      });

      const buttonContainer = modal.contentEl.createDiv({ cls: 'modal-button-container' });
      const overwriteBtn = buttonContainer.createEl('button', { text: 'Overwrite scheduled values', cls: 'mod-cta' });
      overwriteBtn.onclick = () => {
        finish('overwrite');
        modal.close();
      };

      const taskBtn = buttonContainer.createEl('button', { text: 'Create task time tracker' });
      taskBtn.onclick = () => {
        finish('task');
        modal.close();
      };

      const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
      cancelBtn.onclick = () => {
        finish(null);
        modal.close();
      };

      modal.onClose = () => finish(null);
      modal.open();
    });
  }

  private async promptForTaskTrackerTarget(sourceFile: TFile): Promise<TFile | null> {
    const location = await this.promptForTaskTrackerLocation(sourceFile);
    if (location === 'daily-note') {
      return this.ensureTodayDailyNote();
    }
    if (location === 'parent-note') {
      const parents = this.plugin.parentLinkResolutionService
        .getParentsForChild(sourceFile)
        .map((entry) => entry.file)
        .filter((file, index, items) => items.findIndex((candidate) => candidate.path === file.path) === index && file.path !== sourceFile.path);
      if (parents.length === 0) {
        new Notice('No parent note is linked to this note.');
        return null;
      }
      if (parents.length === 1) return parents[0];
      return this.promptForParentTarget(parents);
    }
    return null;
  }

  private async promptForTaskTrackerLocation(sourceFile: TFile): Promise<'daily-note' | 'parent-note' | null> {
    return new Promise<'daily-note' | 'parent-note' | null>((resolve) => {
      const modal = new Modal(this.plugin.app);
      let settled = false;
      const finish = (value: 'daily-note' | 'parent-note' | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      modal.titleEl.textContent = 'Create Task Time Tracker';
      modal.contentEl.createEl('p', {
        text: `Where should the task time tracker for ${sourceFile.basename} be created?`,
      });

      const buttonContainer = modal.contentEl.createDiv({ cls: 'modal-button-container' });
      const dailyBtn = buttonContainer.createEl('button', { text: 'Daily Note', cls: 'mod-cta' });
      dailyBtn.onclick = () => {
        finish('daily-note');
        modal.close();
      };

      const parentBtn = buttonContainer.createEl('button', { text: 'Parent Note' });
      parentBtn.onclick = () => {
        finish('parent-note');
        modal.close();
      };

      const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
      cancelBtn.onclick = () => {
        finish(null);
        modal.close();
      };

      modal.onClose = () => finish(null);
      modal.open();
    });
  }

  private async promptForParentTarget(parents: TFile[]): Promise<TFile | null> {
    return new Promise<TFile | null>((resolve) => {
      class ParentFileSuggestModal extends FileSuggestModal {
        constructor() {
          super(thisApp, (file) => resolve(file));
        }

        getItems(): TFile[] {
          return parents;
        }
      }

      const thisApp = this.plugin.app;
      const modal = new ParentFileSuggestModal();
      const originalOnClose = modal.onClose.bind(modal);
      let settled = false;
      const finish = (value: TFile | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      modal.setPlaceholder('Choose a parent note');
      modal.onChooseItem = (item: TFile) => {
        finish(item);
        originalOnClose();
      };
      modal.onClose = () => {
        originalOnClose();
        finish(null);
      };
      modal.open();
    });
  }

  private async ensureTodayDailyNote(): Promise<TFile | null> {
    const resolver = getDailyNoteResolver(this.plugin.app, {
      formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
    });
    const targetDate = new Date();
    const targetPath = resolver.buildPath(targetDate, 'md');
    const existing = this.plugin.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) return existing;

    const created = await ensureDailyNoteFile(this.plugin.app as any, targetDate, {
      formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
    });
    if (created instanceof TFile) return created;

    new Notice('Could not create or resolve today\'s daily note.');
    return null;
  }

  private buildNoteLinkLabel(file: TFile, label?: string): string {
    const alias = String(label || getFileDisplayTitle(this.plugin.app, file) || file.basename).trim() || file.basename;
    return `[[${file.path}|${alias}]]`;
  }

  private async appendSessionLineToDailyNote(line: string): Promise<TFile | null> {
    const targetFile = await this.ensureTodayDailyNote();
    if (!(targetFile instanceof TFile)) return null;
    const content = await this.plugin.app.vault.read(targetFile);
    const separator = content.endsWith('\n') || content.length === 0 ? '' : '\n';
    await this.plugin.app.vault.modify(targetFile, `${content}${separator}${line}\n`);
    return targetFile;
  }

  private async promptForDailyNoteSessionStart(
    file: TFile,
  ): Promise<
    | { kind: 'task'; task: VaultTaskChoice }
    | { kind: 'note'; note: TFile; label: string }
    | { kind: 'manual'; label: string }
    | null
  > {
    type Result =
      | { kind: 'task'; task: VaultTaskChoice }
      | { kind: 'note'; note: TFile; label: string }
      | { kind: 'manual'; label: string }
      | null;

    return new Promise<Result>((resolve) => {
      const modal = new Modal(this.plugin.app);
      let settled = false;
      const finish = (value: Result) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const chooseTask = async () => {
        modal.close();
        const task = await this.promptForVaultTaskChoice();
        finish(task ? { kind: 'task', task } : null);
      };

      const chooseNote = async () => {
        modal.close();
        const note = await this.promptForSourceNote();
        if (!(note instanceof TFile)) {
          finish(null);
          return;
        }
        finish({ kind: 'note', note, label: getFileDisplayTitle(this.plugin.app, note) || note.basename });
      };

      const chooseManual = async () => {
        modal.close();
        const title = await this.promptForManualSessionTitle();
        finish(title ? { kind: 'manual', label: title } : null);
      };

      modal.titleEl.textContent = 'What are you doing?';
      modal.contentEl.createEl('p', {
        text: 'Choose a task or note from anywhere in the vault, or type a session title.',
      });

      const buttonContainer = modal.contentEl.createDiv({ cls: 'modal-button-container' });
      buttonContainer.createEl('button', { text: 'Choose task', cls: 'mod-cta' }).onclick = () => {
        void chooseTask();
      };
      buttonContainer.createEl('button', { text: 'Choose note' }).onclick = () => {
        void chooseNote();
      };
      buttonContainer.createEl('button', { text: 'Type title' }).onclick = () => {
        void chooseManual();
      };
      buttonContainer.createEl('button', { text: 'Cancel' }).onclick = () => {
        finish(null);
        modal.close();
      };

      modal.onClose = () => finish(null);
      modal.open();
    });
  }

  private async promptForVaultTaskChoice(): Promise<VaultTaskChoice | null> {
    const tasks = await this.getVaultTaskChoices();
    if (tasks.length === 0) {
      new Notice('No task items found in the vault.');
      return null;
    }

    return new Promise<VaultTaskChoice | null>((resolve) => {
      const app = this.plugin.app;
      let settled = false;
      const finish = (value: VaultTaskChoice | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const modal = new (class extends FuzzySuggestModal<VaultTaskChoice> {
        constructor() {
          super(app);
          this.setPlaceholder('Choose task...');
        }

        getItems(): VaultTaskChoice[] {
          return tasks;
        }

        getItemText(item: VaultTaskChoice): string {
          return `${item.label} - ${item.file.path}`;
        }

        renderSuggestion(match: any, el: HTMLElement): void {
          const item = match?.item as VaultTaskChoice;
          el.createDiv({ text: item.label, cls: 'suggestion-title' });
          el.createEl('small', { text: `${item.file.path}:${item.lineNumber + 1}`, cls: 'suggestion-note' });
        }

        onChooseItem(item: VaultTaskChoice): void {
          finish(item);
        }

        onClose(): void {
          finish(null);
        }
      })();

      modal.open();
    });
  }

  private async getVaultTaskChoices(): Promise<VaultTaskChoice[]> {
    const tasks: VaultTaskChoice[] = [];
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      const content = await this.plugin.app.vault.cachedRead(file);
      const lines = content.split('\n');
      for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
        const lineText = String(lines[lineNumber] || '');
        const parsed = this.plugin.itemSemanticsService.parseTaskLine(lineText);
        if (!parsed) continue;
        if (this.parseTimerMetadata(lineText)?.start) continue;
        const label = this.getTaskLabel(lineText);
        if (!label) continue;
        tasks.push({ file, lineNumber, lineText, label });
      }
    }
    return tasks;
  }

  private async promptForSourceNote(): Promise<TFile | null> {
    return new Promise<TFile | null>((resolve) => {
      let settled = false;
      const finish = (value: TFile | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const modal = new FileSuggestModal(this.plugin.app, (selected) => finish(selected), { extensions: ['md'] });
      const originalOnClose = modal.onClose.bind(modal);
      modal.onClose = () => {
        originalOnClose();
        finish(null);
      };
      modal.setPlaceholder('Choose a note');
      modal.open();
    });
  }

  private async promptForManualSessionTitle(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve(value && value.trim() ? value.trim() : null);
      };
      const modal = new TextInputModal(this.plugin.app, 'Session title', '', (value) => finish(value));
      const originalOnClose = modal.onClose.bind(modal);
      modal.onClose = () => {
        originalOnClose();
        finish(null);
      };
      modal.open();
    });
  }

  async finalizeNoteLevelTimerForStatus(file: TFile, nextStatus: string): Promise<boolean> {
    return false;
  }

  private getFrontmatterValueCaseInsensitive(frontmatter: Record<string, unknown>, key: string): unknown {
    const actualKey = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    return actualKey ? frontmatter[actualKey] : undefined;
  }

  private setFrontmatterValueCaseInsensitive(frontmatter: Record<string, unknown>, key: string, value: unknown): void {
    const actualKey = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === key.toLowerCase()) || key;
    frontmatter[actualKey] = value;
  }

  private deleteFrontmatterValueCaseInsensitive(frontmatter: Record<string, unknown>, key: string): void {
    const actualKey = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (actualKey) delete frontmatter[actualKey];
  }

  private hasExistingScheduledValuesForFile(file: TFile): boolean {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const frontmatter = (cache?.frontmatter || {}) as Record<string, unknown>;
    const scheduledKey = this.getScheduledPropertyKey().toLowerCase();
    const durationKey = this.getTimeEstimatePropertyKey().toLowerCase();

    return Object.entries(frontmatter).some(([key, value]) => {
      const normalizedKey = String(key || '').trim().toLowerCase();
      if (normalizedKey !== scheduledKey && normalizedKey !== durationKey && normalizedKey !== 'allday') {
        return false;
      }
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return Number.isFinite(value);
      if (Array.isArray(value)) return value.length > 0;
      return String(value ?? '').trim().length > 0;
    });
  }

  private hasExistingScheduledValuesForLine(line: string): boolean {
    const parsed = this.plugin.itemSemanticsService.parseTaskLine(line);
    const properties = parsed?.inlineProperties || this.plugin.itemSemanticsService.parseInlineProperties(line);
    const scheduledKey = this.getScheduledPropertyKey().toLowerCase();
    const durationKey = this.getTimeEstimatePropertyKey().toLowerCase();
    const hasInlineScheduled = !!String(properties[scheduledKey] || '').trim();
    const hasInlineDuration = !!String(properties[durationKey] || '').trim();
    const hasInlineAllDay = !!String(properties.allday || '').trim();
    return hasInlineScheduled
      || hasInlineDuration
      || hasInlineAllDay
      || !!parsed?.scheduledDateToken
      || !!parsed?.scheduledTimeToken;
  }

  private getCheckboxStateChar(line: string): CheckboxStateChar | null {
    const match = String(line || '').match(/^\s*(?:[-*+]|\d+\.)\s+\[([^\]]*)\]/);
    if (!match) return null;
    const value = String(match[1] || '').trim();
    if (value === ' ') return ' ';
    if (value === 'x' || value === 'X' || value === '?' || value === '-' || value === '/') {
      return value as CheckboxStateChar;
    }
    if (!value) return ' ';
    return null;
  }

  private getCheckboxStateCharForStatus(status: string, fallback: CheckboxStateChar | null): CheckboxStateChar {
    const mapped = String(this.plugin.itemSemanticsService.mapStatusToCheckboxState(status) || '').trim();
    const match = mapped.match(/^\[([^\]]*)\]$/);
    const value = String(match?.[1] || '').trim();
    if (value === 'x' || value === 'X' || value === '?' || value === '-' || value === '/') {
      return value as CheckboxStateChar;
    }
    if (!value) return ' ';
    return fallback || ' ';
  }

  private getInlinePropertyValue(properties: Record<string, string>, keys: readonly string[]): string {
    for (const key of keys) {
      const value = properties[String(key || '').trim().toLowerCase()];
      if (value) return value;
    }
    return '';
  }

  private getLegacyInlinePropertyValue(properties: Record<string, string>, kind: LegacyTimerPropertyKind): string {
    return this.getInlinePropertyValue(properties, TIMER_LEGACY_PROPERTY_ALIASES[kind]);
  }

  private stripInlinePropertyKeys(line: string, keys: string[]): string {
    const normalized = Array.from(new Set(keys.map((value) => String(value || '').trim()).filter(Boolean)));
    if (normalized.length === 0) return line;
    const escaped = normalized.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return line.replace(new RegExp(`\\s*\\[(?:${escaped.join('|')})::\\s*[^\\]]+\\]`, 'gi'), '');
  }

  private setInlinePropertyValuePreservingOrder(
    line: string,
    key: string,
    value: string | number,
    aliases: string[] = [],
    insertBeforeKeys: string[] = [],
  ): string {
    const allKeys = Array.from(new Set([key, ...aliases].map((entry) => String(entry || '').trim()).filter(Boolean)));
    if (allKeys.length === 0) return line;

    const escapedAllKeys = allKeys.map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const propertyRe = new RegExp(`\\s*\\[(?:${escapedAllKeys.join('|')})::\\s*[^\\]]+\\]`, 'gi');
    const matches = Array.from(line.matchAll(propertyRe));
    const replacementCore = `[${key}:: ${String(value)}]`;

    if (matches.length > 0) {
      const firstMatch = matches[0];
      const firstIndex = firstMatch.index ?? 0;
      const firstText = firstMatch[0] || '';
      const leadingWhitespace = (firstText.match(/^\s*/) || [' '])[0] || ' ';
      const before = line.slice(0, firstIndex);
      const after = line.slice(firstIndex + firstText.length).replace(propertyRe, '');
      return `${before}${leadingWhitespace}${replacementCore}${after}`.trimEnd();
    }

    const beforeKeys = Array.from(new Set(insertBeforeKeys.map((entry) => String(entry || '').trim()).filter(Boolean)));
    if (beforeKeys.length > 0) {
      const escapedBeforeKeys = beforeKeys.map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const beforeRe = new RegExp(`\\s*\\[(?:${escapedBeforeKeys.join('|')})::\\s*[^\\]]+\\]`, 'i');
      if (beforeRe.test(line)) {
        return line.replace(beforeRe, (match) => ` ${replacementCore}${match}`).trimEnd();
      }
    }

    return `${line.trimEnd()} ${replacementCore}`;
  }

  private formatScheduledTimestamp(date: Date): string {
    const momentApi = (window as any)?.moment;
    if (typeof momentApi === 'function') {
      const parsed = momentApi(date);
      if (parsed?.isValid?.()) {
        return parsed.format('YYYY-MM-DD HH:mm:ss');
      }
    }
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  private parseScheduledTimestamp(value: string): Date | null {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?$/.test(raw)
      ? raw.replace(/\s+/, 'T')
      : /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? `${raw}T00:00:00`
      : raw;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private getDateKey(value: Date): string {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private getDailyNoteDateKey(file: TFile): string | null {
    const momentApi = (window as any)?.moment;
    if (typeof momentApi === 'function') {
      const parsed = momentApi(file.basename, ['YYYY-MM-DD', 'ddd, MMM D YYYY', 'ddd, MMM DD YYYY'], true);
      if (parsed?.isValid?.()) {
        return parsed.format('YYYY-MM-DD');
      }
    }

    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const frontmatter = (cache?.frontmatter || {}) as Record<string, unknown>;
    const scheduledValue = Object.entries(frontmatter).find(([key]) => key.toLowerCase() === 'scheduled')?.[1];
    const scheduled = this.parseScheduledTimestamp(String(scheduledValue || ''));
    return scheduled ? this.getDateKey(scheduled) : null;
  }

  private isTodayDailyNote(file: TFile): boolean {
    const dayKey = this.getDailyNoteDateKey(file);
    return !!dayKey && dayKey === this.getDateKey(new Date());
  }

  private buildRunningTimerLine(label: string): string {
    const scheduledKey = this.getScheduledPropertyKey();
    const statusKey = this.getStatusPropertyKey();
    const title = this.escapeInlinePropertyText(this.plugin.itemSemanticsService.cleanTaskText(label) || 'Track time');
    const workingState = this.getCheckboxStateCharForStatus('working', ' ');
    return `- [${workingState}] ${title} [${scheduledKey}:: ${this.formatScheduledTimestamp(new Date())}] [${statusKey}:: working]`;
  }

  private buildRunningSessionHeading(
    label: string,
    linkedFile: TFile | null,
    linkedLabel: string | null,
    sourcePath: string,
    sourceLineNumber: number | null,
    sourceType: 'note' | 'task' | 'manual',
  ): string {
    const scheduledKey = this.getScheduledPropertyKey();
    const escapedLabel = this.escapeInlinePropertyText(label || 'Session');
    const segments = [`## Session: ${escapedLabel}`];
    if (linkedFile && linkedLabel) {
      segments.push(linkedLabel);
    }
    segments.push(
      `[${scheduledKey}:: ${this.formatScheduledTimestamp(new Date())}]`,
      `[${SESSION_SOURCE_TYPE_KEY}:: ${sourceType}]`,
      `[${SESSION_SOURCE_PATH_KEY}:: ${sourcePath}]`,
    );
    if (typeof sourceLineNumber === 'number' && Number.isFinite(sourceLineNumber)) {
      segments.push(`[${SESSION_SOURCE_LINE_KEY}:: ${sourceLineNumber}]`);
    }
    return segments.join(' ');
  }

  private buildStoppedTimerLine(line: string): string | null {
    const metadata = this.parseTimerMetadata(line);
    if (!metadata?.start) return null;
    if (metadata.status !== 'working' && metadata.minutes !== null) return null;
    const scheduledKey = this.getScheduledPropertyKey();
    const statusKey = this.getStatusPropertyKey();
    const timeEstimateKey = this.getTimeEstimatePropertyKey();
    const end = new Date();
    const minutes = Math.max(0, Math.round((end.getTime() - metadata.start.getTime()) / 60000));
    const isSessionHeading = this.isSessionHeadingLine(line);

    if (isSessionHeading) {
      let nextLine = this.stripInlinePropertyKeys(line, [statusKey, this.getStatusPropertyKey(), ...TIMER_LEGACY_PROPERTY_ALIASES.status]);
      nextLine = this.stripInlinePropertyKeys(nextLine, [timeEstimateKey, this.getTimeEstimatePropertyKey(), ...TIMER_LEGACY_PROPERTY_ALIASES.minutes, ...TIMER_LEGACY_PROPERTY_ALIASES.seconds, ...TIMER_LEGACY_PROPERTY_ALIASES.end, ...TIMER_LEGACY_PROPERTY_ALIASES.id]);
      nextLine = this.stripInlinePropertyKeys(nextLine, [scheduledKey, this.getScheduledPropertyKey(), ...TIMER_LEGACY_PROPERTY_ALIASES.start]);
      return `${nextLine} [${scheduledKey}:: ${this.formatScheduledTimestamp(metadata.start)}] [${timeEstimateKey}:: ${minutes}]`;
    }

    let nextLine = line.replace(/^(\s*(?:[-*+]|\d+\.)\s*)\[[^\]]*\]/, '$1[x]');
    nextLine = this.stripInlinePropertyKeys(nextLine, [statusKey, this.getStatusPropertyKey(), ...TIMER_LEGACY_PROPERTY_ALIASES.status]);
    nextLine = this.stripInlinePropertyKeys(nextLine, [timeEstimateKey, this.getTimeEstimatePropertyKey(), ...TIMER_LEGACY_PROPERTY_ALIASES.minutes, ...TIMER_LEGACY_PROPERTY_ALIASES.seconds, ...TIMER_LEGACY_PROPERTY_ALIASES.end, ...TIMER_LEGACY_PROPERTY_ALIASES.id]);
    nextLine = this.stripInlinePropertyKeys(nextLine, [scheduledKey, this.getScheduledPropertyKey(), ...TIMER_LEGACY_PROPERTY_ALIASES.start]);
    return `${nextLine} [${scheduledKey}:: ${this.formatScheduledTimestamp(metadata.start)}] [${timeEstimateKey}:: ${minutes}] [${statusKey}:: complete]`;
  }

  private buildTimerLineForStatus(line: string, metadata: TimerMetadata, targetStatus: string): string | null {
    const normalizedTargetStatus = String(targetStatus || '').trim().toLowerCase();
    if (!normalizedTargetStatus) return null;
    if (this.isSessionHeadingLine(line)) {
      if (normalizedTargetStatus === 'complete' || normalizedTargetStatus === 'wont-do') {
        return this.buildStoppedTimerLine(line);
      }
      if (normalizedTargetStatus === 'working') {
        const scheduledKey = this.getScheduledPropertyKey();
        const timeEstimateKey = this.getTimeEstimatePropertyKey();
        let nextLine = this.stripInlinePropertyKeys(line, [timeEstimateKey, this.getTimeEstimatePropertyKey(), ...TIMER_LEGACY_PROPERTY_ALIASES.minutes, ...TIMER_LEGACY_PROPERTY_ALIASES.seconds, ...TIMER_LEGACY_PROPERTY_ALIASES.end, ...TIMER_LEGACY_PROPERTY_ALIASES.id]);
        nextLine = this.stripInlinePropertyKeys(nextLine, [scheduledKey, this.getScheduledPropertyKey(), ...TIMER_LEGACY_PROPERTY_ALIASES.start]);
        return `${nextLine} [${scheduledKey}:: ${this.formatScheduledTimestamp(metadata.start)}]`;
      }
      return line;
    }
    if (normalizedTargetStatus === 'complete' && metadata.status === 'working') {
      return this.buildStoppedTimerLine(line);
    }

    const scheduledKey = this.getScheduledPropertyKey();
    const statusKey = this.getStatusPropertyKey();
    const timeEstimateKey = this.getTimeEstimatePropertyKey();
    const checkboxState = this.getCheckboxStateCharForStatus(normalizedTargetStatus, this.getCheckboxStateChar(line));
    const preservedMinutes = normalizedTargetStatus === 'complete'
      ? metadata.minutes
      : normalizedTargetStatus === 'working'
      ? null
      : metadata.minutes;

    let nextLine = line.replace(/^(\s*(?:[-*+]|\d+\.)\s*)\[[^\]]*\]/, `$1[${checkboxState}]`);
    nextLine = this.stripInlinePropertyKeys(nextLine, [statusKey, this.getStatusPropertyKey(), ...TIMER_LEGACY_PROPERTY_ALIASES.status]);
    nextLine = this.stripInlinePropertyKeys(nextLine, [timeEstimateKey, this.getTimeEstimatePropertyKey(), ...TIMER_LEGACY_PROPERTY_ALIASES.minutes, ...TIMER_LEGACY_PROPERTY_ALIASES.seconds, ...TIMER_LEGACY_PROPERTY_ALIASES.end, ...TIMER_LEGACY_PROPERTY_ALIASES.id]);
    nextLine = this.stripInlinePropertyKeys(nextLine, [scheduledKey, this.getScheduledPropertyKey(), ...TIMER_LEGACY_PROPERTY_ALIASES.start]);

    const segments = [
      nextLine.trimEnd(),
      `[${scheduledKey}:: ${this.formatScheduledTimestamp(metadata.start)}]`,
    ];
    if (Number.isFinite(preservedMinutes as number | null) && preservedMinutes !== null) {
      segments.push(`[${timeEstimateKey}:: ${preservedMinutes}]`);
    }
    segments.push(`[${statusKey}:: ${normalizedTargetStatus}]`);
    return segments.join(' ');
  }

  private buildRunningDurationLine(line: string, elapsedMinutes: number): string | null {
    if (elapsedMinutes < 0) return null;
    const timeEstimateKey = this.getTimeEstimatePropertyKey();
    return this.setInlinePropertyValuePreservingOrder(
      line,
      timeEstimateKey,
      elapsedMinutes,
      [
        ...TIMER_LEGACY_PROPERTY_ALIASES.minutes,
        ...TIMER_LEGACY_PROPERTY_ALIASES.seconds,
        ...TIMER_LEGACY_PROPERTY_ALIASES.end,
        ...TIMER_LEGACY_PROPERTY_ALIASES.id,
      ],
      [this.getStatusPropertyKey(), ...TIMER_LEGACY_PROPERTY_ALIASES.status],
    );
  }

  private buildLinkedTaskLine(line: string, child: TFile, title: string, subitemId: string): string | null {
    const match = line.match(/^(\s*(?:[-*+]|\d+\.)\s*)\[([^\]]*)\]\s*(.*)$/);
    if (!match) return null;
    const prefix = match[1] || '- ';
    const alias = this.escapeWikiAlias(this.plugin.itemSemanticsService.cleanTaskText(title) || child.basename);
    const target = child.path.replace(/\.md$/i, '');
    return `${prefix}[ ] [[${target}|${alias}]] [${SUBITEM_ID_KEY}:: ${subitemId}]`;
  }

  private getTaskLabel(line: string): string {
    const parsed = this.plugin.itemSemanticsService.parseTaskLine(line);
    if (parsed?.text) {
      return parsed.text
        .replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_match, target, alias) => {
          const visible = String(alias || '').trim();
          if (visible) return visible;
          const fallback = String(target || '').trim().split('/').pop() || String(target || '').trim();
          return fallback;
        })
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text) => String(text || '').trim())
        .replace(/\s{2,}/g, ' ')
        .trim();
    }
    return this.plugin.itemSemanticsService.cleanTaskText(line);
  }

  private getTrackedLineLabel(line: string): string {
    const sessionMatch = String(line || '').match(/^\s*#{1,6}\s+Session:\s*(.*)$/i);
    if (sessionMatch) {
      const withoutProperties = this.plugin.itemSemanticsService.stripInlineProperties(sessionMatch[1] || '');
      const normalized = withoutProperties.replace(/\s+/g, ' ').trim();
      if (normalized) return normalized;
    }
    return this.getTaskLabel(line);
  }

  private resolvePrimaryLinkedNote(line: string, sourcePath: string): TFile | null {
    return this.resolveLinkedNotesForLine(line, sourcePath)[0] || null;
  }

  private resolveLinkedNotesForLine(line: string, sourcePath: string): TFile[] {
    const parsed = this.plugin.itemSemanticsService.parseTaskLine(line);
    const body = String(parsed?.body || line || '');
    const inlineProperties = this.plugin.itemSemanticsService.parseInlineProperties(body);
    const resolved = new Map<string, TFile>();

    const addResolved = (file: TFile | null) => {
      if (!(file instanceof TFile) || file.extension?.toLowerCase() !== 'md') return;
      resolved.set(file.path, file);
    };

    for (const key of this.getPreferredRelationshipKeys()) {
      const rawValue = inlineProperties[key.toLowerCase()];
      if (!rawValue) continue;
      for (const file of this.plugin.parentLinkResolutionService.resolveFilesFromFrontmatterValue(rawValue, sourcePath)) {
        addResolved(file);
      }
    }

    const strippedBody = this.plugin.itemSemanticsService.stripInlineProperties(body);
    for (const target of extractLinkTargetsFromText(strippedBody, false)) {
      addResolved(resolveLinkTargetToFile(this.plugin.app, target, sourcePath));
    }

    return Array.from(resolved.values());
  }

  private getPreferredRelationshipKeys(): string[] {
    const configured = String(this.plugin.settings.parentLinkFrontmatterKey || 'childOf').trim();
    const keys = new Set<string>();
    if (configured) {
      keys.add(configured);
      if (configured.endsWith('s')) {
        keys.add(configured.slice(0, -1));
      } else {
        keys.add(`${configured}s`);
      }
    }
    keys.add('project');
    keys.add('projects');
    return Array.from(keys).filter(Boolean);
  }

  private isSessionHeadingLine(text: string): boolean {
    return /^\s*#{1,6}\s+Session:\s+/i.test(String(text || ''));
  }

  private parseTimerMetadata(text: string): TimerMetadata | null {
    const properties = this.plugin.itemSemanticsService.parseInlineProperties(text);
    const scheduledKey = this.getScheduledPropertyKey().toLowerCase();
    const statusKey = this.getStatusPropertyKey().toLowerCase();
    const timeEstimateKey = this.getTimeEstimatePropertyKey().toLowerCase();
    const scheduledRaw = this.getInlinePropertyValue(properties, [scheduledKey]);
    const scheduled = this.parseScheduledTimestamp(scheduledRaw);
    const minutesRaw = this.getInlinePropertyValue(properties, [timeEstimateKey]);
    const minutes = minutesRaw ? Number(minutesRaw) : null;
    const explicitStatus = this.getInlinePropertyValue(properties, [statusKey]).trim().toLowerCase();
    const derivedStatus = this.isSessionHeadingLine(text)
      ? this.inferSessionHeadingStatus(Number.isFinite(minutes) ? minutes : null)
      : explicitStatus || this.inferTimerStatusFromCheckbox(text, Number.isFinite(minutes) ? minutes : null);
    if (scheduled && (derivedStatus === 'working' || derivedStatus === 'complete')) {
      return {
        start: scheduled,
        status: derivedStatus,
        minutes: Number.isFinite(minutes) ? minutes : null,
      };
    }

    const startRaw = this.getLegacyInlinePropertyValue(properties, 'start');
    if (!startRaw) return null;
    const start = new Date(startRaw);
    if (Number.isNaN(start.getTime())) return null;
    const endRaw = this.getLegacyInlinePropertyValue(properties, 'end');
    const end = endRaw ? new Date(endRaw) : null;
    const secondsRaw = this.getLegacyInlinePropertyValue(properties, 'seconds');
    const seconds = secondsRaw ? Number(secondsRaw) : null;
    const legacyMinutesRaw = this.getLegacyInlinePropertyValue(properties, 'minutes');
    const legacyMinutes = legacyMinutesRaw ? Number(legacyMinutesRaw) : null;
    const computedMinutes = Number.isFinite(legacyMinutes)
      ? legacyMinutes
      : Number.isFinite(seconds)
      ? Math.max(0, Math.round(seconds / 60))
      : end && !Number.isNaN(end.getTime())
      ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000))
      : null;
    return {
      start,
      status: end && !Number.isNaN(end.getTime())
        ? 'complete'
        : this.getLegacyInlinePropertyValue(properties, 'status').trim().toLowerCase() || 'working',
      minutes: Number.isFinite(computedMinutes) ? computedMinutes : null,
    };
  }

  private parseSessionSourceMetadata(text: string): { path: string | null; lineNumber: number | null; type: string | null } {
    const properties = this.plugin.itemSemanticsService.parseInlineProperties(text);
    const rawPath = String(properties[SESSION_SOURCE_PATH_KEY.toLowerCase()] || '').trim();
    const rawLine = String(properties[SESSION_SOURCE_LINE_KEY.toLowerCase()] || '').trim();
    const rawType = String(properties[SESSION_SOURCE_TYPE_KEY.toLowerCase()] || '').trim().toLowerCase() || null;
    const lineNumber = rawLine === '' ? null : Number(rawLine);
    return {
      path: rawPath || null,
      lineNumber: Number.isInteger(lineNumber) ? lineNumber : null,
      type: rawType,
    };
  }

  private inferSessionHeadingStatus(minutes: number | null): string {
    return Number.isFinite(minutes) && minutes !== null ? 'complete' : 'working';
  }

  private inferTimerStatusFromCheckbox(line: string, minutes: number | null): string {
    const checkboxState = this.getCheckboxStateChar(line);
    if (checkboxState === '/' || checkboxState === '?') return 'working';
    if (checkboxState === 'x' || checkboxState === 'X' || checkboxState === '-') return 'complete';
    if (checkboxState === ' ') {
      return Number.isFinite(minutes) && minutes !== null ? 'complete' : 'working';
    }
    return '';
  }

  private renderOpenTimers(): void {
    for (const view of this.getOpenMarkdownViews()) {
      const file = view.file;
      if (!(file instanceof TFile)) continue;
      const selectors = [
        '.markdown-reading-view li',
        '.markdown-preview-view li',
        '.markdown-reading-view .tps-gcm-linked-subitem-row-content',
        '.markdown-preview-view .tps-gcm-linked-subitem-row-content',
        '.markdown-source-view .tps-gcm-linked-subitem-cm-widget',
        '.markdown-source-view .tps-gcm-linked-subitem-row-content.is-cm-widget',
      ];
      view.containerEl.querySelectorAll<HTMLElement>(selectors.join(',')).forEach((lineEl) => {
        const host = this.getBadgeHost(lineEl);
        const existing = host.querySelector(`:scope > .${BADGE_CLASS}`);
        existing?.remove();

        const lineText = this.getSourceLineText(view, lineEl) || this.getTimerLineText(lineEl);
        const badgeState = this.getBadgeStateForLine(lineText, file.path);
        if (!badgeState) return;

        const badge = document.createElement('span');
        badge.className = `${BADGE_CLASS}${badgeState.isRunning ? ` ${RUNNING_BADGE_CLASS}` : ''}`;
        badge.setAttribute('contenteditable', 'false');
        badge.textContent = ` ${badgeState.text}`;
        host.appendChild(badge);
      });
    }
  }

  private getBadgeHost(lineEl: HTMLElement): HTMLElement {
    const directInlineHost = lineEl.matches(
      '.tps-gcm-linked-subitem-row-content, .tps-gcm-linked-subitem-cm-widget, .tps-gcm-linked-subitem-row-content.is-cm-widget',
    )
      ? lineEl
      : null;
    if (directInlineHost) return directInlineHost;

    const structuredHost = lineEl.querySelector<HTMLElement>(
      ':scope > .list-item, :scope > .list-item-content, :scope > .list-item-inner, :scope > .task-list-item-checkbox + *',
    );
    if (structuredHost) return structuredHost;

    const paragraph = lineEl.querySelector(':scope > p');
    if (paragraph instanceof HTMLElement) return paragraph;

    return lineEl;
  }

  private getOpenMarkdownViews(): MarkdownView[] {
    return this.plugin.app.workspace.getLeavesOfType('markdown')
      .map((leaf) => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView);
  }

  private getBadgeStateForLine(
    lineText: string,
    sourcePath: string,
  ): { text: string; isRunning: boolean } | null {
    const metadata = this.parseTimerMetadata(lineText);
    if (metadata) {
      const elapsedMs = metadata.status === 'working'
        ? Math.max(0, Date.now() - metadata.start.getTime())
        : metadata.minutes !== null
        ? Math.max(0, metadata.minutes * 60000)
        : 0;
      return {
        text: this.formatElapsed(elapsedMs, null, metadata.minutes),
        isRunning: metadata.status === 'working',
      };
    }

    const active = this.activeTimerInfo;
    if (!active) return null;
    if (!this.lineReferencesActiveTimer(lineText, sourcePath, active)) return null;

    return {
      text: this.formatElapsed(Math.max(0, Date.now() - active.start.getTime()), null, null),
      isRunning: true,
    };
  }

  private lineReferencesActiveTimer(lineText: string, sourcePath: string, active: ActiveTimerInfo, sourceLineNumber?: number): boolean {
    if (
      active.sourcePath
      && active.sourcePath === sourcePath
      && typeof active.sourceLineNumber === 'number'
      && typeof sourceLineNumber === 'number'
      && active.sourceLineNumber === sourceLineNumber
    ) {
      return true;
    }

    const properties = this.plugin.itemSemanticsService.parseInlineProperties(lineText);
    const lineSubitemId = String(properties[SUBITEM_ID_KEY.toLowerCase()] || properties.subitemid || '').trim();
    if (lineSubitemId && active.subitemId && lineSubitemId === active.subitemId) return true;

    const lineLabel = this.getTaskLabel(lineText);
    if (sourcePath === active.filePath && lineLabel && lineLabel === active.label) return true;
    if (active.sourcePath === sourcePath && lineLabel && lineLabel === active.label) return true;

    const linked = this.resolveLinkedNotesForLine(lineText, sourcePath);
    return linked.some((candidate) => candidate.path === active.filePath);
  }

  private renderStatusBar(): void {
    this.ensureStatusBar();
    if (!this.statusBarEl) return;

    const active = this.activeTimerInfo;
    if (!active) {
      this.statusBarEl.style.display = 'none';
      this.statusBarEl.textContent = '';
      this.statusBarEl.title = '';
      return;
    }

    this.statusBarEl.style.display = '';
    this.statusBarEl.textContent = `Timer ${this.formatElapsed(Math.max(0, Date.now() - active.start.getTime()), null, null)} ${active.label}`;
    this.statusBarEl.title = active.file.path;
  }

  private getTimerLineText(lineEl: HTMLElement): string {
    const clone = lineEl.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(`.${BADGE_CLASS}, ul, ol`).forEach((el) => el.remove());
    return clone.textContent || '';
  }

  private getSourceLineText(view: MarkdownView, lineEl: HTMLElement): string | null {
    const file = view.file;
    if (!(file instanceof TFile)) return null;
    const editor = view.editor as any;
    const source = typeof editor?.getValue === 'function' ? editor.getValue() : ((view as any)?.data || '');
    const lines = String(source || '').split('\n');
    const dataLineEl = lineEl.closest('[data-line]') as HTMLElement | null;
    const rawDataLine = dataLineEl?.getAttribute('data-line') ?? lineEl.getAttribute('data-line') ?? '';
    const directLineNumber = Number.parseInt(rawDataLine, 10);
    if (Number.isInteger(directLineNumber) && directLineNumber >= 0 && directLineNumber < lines.length) {
      return lines[directLineNumber] ?? null;
    }

    const renderedText = this.getTimerLineText(lineEl).trim();
    if (!renderedText) return null;
    const exact = lines.find((line) => {
      const label = this.getTrackedLineLabel(line);
      return !!label && label === renderedText;
    });
    return exact || null;
  }

  private formatElapsed(elapsedMs: number, seconds: number | null, minutes: number | null): string {
    const totalSeconds = seconds !== null
      ? Math.max(0, Math.round(seconds))
      : minutes !== null
      ? Math.max(0, Math.round(minutes * 60))
      : Math.max(0, Math.floor(elapsedMs / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    if (hours > 0) return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  private async openFile(file: TFile): Promise<void> {
    await this.plugin.openFileInLeaf(file, false, () => this.plugin.app.workspace.getLeaf(false), {
      revealLeaf: true,
      ignoreCanvasDragGuard: true,
    });
  }

  private scheduleRender(): void {
    window.setTimeout(() => {
      this.renderOpenTimers();
      this.refreshLivePreviewEditors();
    }, 50);
  }

  private escapeInlinePropertyText(value: string): string {
    return String(value || '').replace(/\s+/g, ' ').replace(/\]/g, '').trim();
  }

  private escapeWikiAlias(value: string): string {
    return String(value || '').replace(/\]/g, '').replace(/\|/g, '-').trim();
  }

  private isMarkdownFile(file: TFile): boolean {
    return file instanceof TFile && file.extension?.toLowerCase() === 'md';
  }
}
