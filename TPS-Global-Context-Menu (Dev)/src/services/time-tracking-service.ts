import { MarkdownView, Notice, TFile } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import { createSubitemForParentWithTitle, getDefaultSubitemFolderPath } from './subitem-creation-service';
import { generateSubitemId, SUBITEM_ID_KEY } from '../utils/subitem-id';

const BADGE_CLASS = 'tps-gcm-time-tracker-badge';
const RUNNING_BADGE_CLASS = 'tps-gcm-time-tracker-badge--running';
const TIMER_ID_PREFIX = 'tt_';

interface TimerMetadata {
  start: Date;
  end: Date | null;
  status: string;
  minutes: number | null;
  seconds: number | null;
}

export class TimeTrackingService {
  private intervalId: number | null = null;

  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = window.setInterval(() => this.renderOpenTimers(), 1000);
    this.renderOpenTimers();
  }

  detach(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((el) => el.remove());
  }

  async startForNote(file: TFile, label = 'Track time'): Promise<boolean> {
    if (!this.isMarkdownFile(file)) return false;
    const existing = await this.findRunningTimerLine(file);
    if (existing >= 0) {
      await this.openFile(file);
      new Notice('Time tracking is already running in this note.');
      return false;
    }

    const content = await this.plugin.app.vault.read(file);
    const line = this.buildRunningTimerLine(label);
    const separator = content.endsWith('\n') || content.length === 0 ? '' : '\n';
    await this.plugin.app.vault.modify(file, `${content}${separator}${line}\n`);
    await this.openFile(file);
    this.scheduleRender();
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
      return this.stopTimerAtLine(parentFile, view, lineNumber, isReadingView);
    }

    const linkedNote = this.resolveFirstLinkedNote(line, parentFile.path);
    if (linkedNote) {
      return this.startForNote(linkedNote, this.getTaskLabel(line));
    }

    const subitemId = generateSubitemId();
    const title = this.getTaskLabel(line) || 'Time entry';
    const child = await createSubitemForParentWithTitle(
      this.plugin,
      parentFile,
      title,
      getDefaultSubitemFolderPath(this.plugin, parentFile),
      {
        insertParentBodyLink: false,
        seedDefaults: false,
        seedParentTags: false,
        seedVisualMetadata: false,
        initialFrontmatter: { [SUBITEM_ID_KEY]: subitemId },
      },
    );
    if (!child) return false;

    const nextLine = this.buildLinkedTaskLine(line, child, title, subitemId);
    if (!nextLine) {
      new Notice('Could not convert that task into a tracked note.');
      return false;
    }

    lines[lineNumber] = nextLine;
    await this.plugin.app.vault.modify(parentFile, lines.join('\n'));
    await this.startForNote(child, title);
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
    this.scheduleRender();
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
    this.scheduleRender();
    new Notice('Stopped time tracking.');
    return true;
  }

  private async findRunningTimerLine(file: TFile): Promise<number> {
    const content = await this.plugin.app.vault.read(file);
    return content.split('\n').findIndex((line) => this.isRunningTimerLine(line));
  }

  private isRunningTimerLine(line: string): boolean {
    const metadata = this.parseTimerMetadata(line);
    return !!metadata?.start && !metadata.end && metadata.status !== 'complete';
  }

  private buildRunningTimerLine(label: string): string {
    const title = this.escapeInlinePropertyText(this.plugin.itemSemanticsService.cleanTaskText(label) || 'Track time');
    return `- [ ] ${title} [timeStart:: ${new Date().toISOString()}] [timeStatus:: running] [timeId:: ${this.createTimerId()}]`;
  }

  private buildStoppedTimerLine(line: string): string | null {
    const metadata = this.parseTimerMetadata(line);
    if (!metadata?.start || metadata.end || metadata.status === 'complete') return null;
    const end = new Date();
    const seconds = Math.max(0, Math.round((end.getTime() - metadata.start.getTime()) / 1000));
    const minutes = Math.max(0, Math.round(seconds / 60));
    let nextLine = line.replace(/^(\s*(?:[-*+]|\d+\.)\s*)\[[^\]]*\]/, '$1[x]');
    nextLine = nextLine.replace(/\s*\[timeStatus::\s*[^\]]+\]/gi, '');
    nextLine = nextLine.replace(/\s*\[timeEnd::\s*[^\]]+\]/gi, '');
    nextLine = nextLine.replace(/\s*\[timeMinutes::\s*[^\]]+\]/gi, '');
    nextLine = nextLine.replace(/\s*\[timeSeconds::\s*[^\]]+\]/gi, '');
    return `${nextLine} [timeEnd:: ${end.toISOString()}] [timeSeconds:: ${seconds}] [timeMinutes:: ${minutes}] [timeStatus:: complete]`;
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
    if (parsed?.text) return parsed.text.replace(/\[\[[^\]|]+(?:\|([^\]]+))?\]\]/g, '$1').trim();
    return this.plugin.itemSemanticsService.cleanTaskText(line);
  }

  private resolveFirstLinkedNote(line: string, sourcePath: string): TFile | null {
    const taskBody = line.match(/^\s*(?:[-*+]|\d+\.)\s*\[[^\]]*\]\s*(.*)$/)?.[1] || '';
    if (!taskBody.includes(`[${SUBITEM_ID_KEY}::`) && !/^\s*(?:\[\[|\[[^\]]+\]\()/.test(taskBody)) {
      return null;
    }

    const wiki = taskBody.match(/^\s*\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/);
    if (wiki?.[1]) {
      const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(wiki[1].trim(), sourcePath);
      if (resolved instanceof TFile && resolved.extension === 'md') return resolved;
    }
    const markdown = taskBody.match(/^\s*\[[^\]]+\]\(([^)]+\.md)(?:#[^)]+)?\)/i);
    if (markdown?.[1]) {
      const decoded = decodeURIComponent(markdown[1].trim());
      const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(decoded.replace(/\.md$/i, ''), sourcePath);
      if (resolved instanceof TFile && resolved.extension === 'md') return resolved;
    }
    return null;
  }

  private parseTimerMetadata(text: string): TimerMetadata | null {
    const properties = this.plugin.itemSemanticsService.parseInlineProperties(text);
    const startRaw = properties.timestart;
    if (!startRaw) return null;
    const start = new Date(startRaw);
    if (Number.isNaN(start.getTime())) return null;
    const endRaw = properties.timeend || '';
    const end = endRaw ? new Date(endRaw) : null;
    const secondsRaw = properties.timeseconds || '';
    const seconds = secondsRaw ? Number(secondsRaw) : null;
    const minutesRaw = properties.timeminutes || '';
    const minutes = minutesRaw ? Number(minutesRaw) : null;
    return {
      start,
      end: end && !Number.isNaN(end.getTime()) ? end : null,
      status: String(properties.timestatus || '').trim().toLowerCase(),
      minutes: Number.isFinite(minutes) ? minutes : null,
      seconds: Number.isFinite(seconds) ? seconds : null,
    };
  }

  private renderOpenTimers(): void {
    const selectors = [
      '.markdown-source-view .cm-line',
      '.markdown-reading-view li',
      '.markdown-preview-view li',
    ];
    document.querySelectorAll<HTMLElement>(selectors.join(',')).forEach((lineEl) => {
      const existing = lineEl.querySelector(`:scope > .${BADGE_CLASS}`);
      existing?.remove();
      const metadata = this.parseTimerMetadata(this.getTimerLineText(lineEl));
      if (!metadata) return;
      const elapsedMs = metadata.end
        ? Math.max(0, metadata.end.getTime() - metadata.start.getTime())
        : Math.max(0, Date.now() - metadata.start.getTime());
      const badge = document.createElement('span');
      badge.className = `${BADGE_CLASS}${metadata.end ? '' : ` ${RUNNING_BADGE_CLASS}`}`;
      badge.setAttribute('contenteditable', 'false');
      badge.textContent = ` ${this.formatElapsed(elapsedMs, metadata.seconds, metadata.minutes)}`;
      lineEl.appendChild(badge);
    });
  }

  private getTimerLineText(lineEl: HTMLElement): string {
    const clone = lineEl.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(`.${BADGE_CLASS}, ul, ol`).forEach((el) => el.remove());
    return clone.textContent || '';
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
    window.setTimeout(() => this.renderOpenTimers(), 50);
  }

  private createTimerId(): string {
    return `${TIMER_ID_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
