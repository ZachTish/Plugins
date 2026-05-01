import { Notice, TFile, normalizePath } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import {
  ScheduledLinkMismatchModal,
  type ScheduledLinkResolution,
} from '../modals/scheduled-link-mismatch-modal';
import { ScheduledModal, type ScheduledResult } from '../modals/scheduled-modal';
import { getDailyNoteResolver } from '../../../TPS-Controller (Dev)/src/utils/daily-note-resolver';
import { ensureDailyNoteFile } from '../../../TPS-Controller (Dev)/src/utils/daily-note-create';
import { getConfiguredTimeEstimatePropertyKey } from '../utils/configured-property-key';

export interface ScheduledLinkMismatch {
  direction: 'daily-note-opened' | 'scheduled-note-opened';
  scheduledFile: TFile;
  scheduledDate: string;
  dailyNoteFile: TFile | null;
}

export class ScheduledLinkGuardService {
  private processingPaths = new Set<string>();

  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  async handleFileOpen(file: TFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension?.toLowerCase() !== 'md') return;
    if (this.processingPaths.has(file.path)) return;
    if (this.plugin.settings.enableAutoPopulateDailyNotes === false) {
      console.debug?.('[TPS GCM] [ScheduledLinkGuard] skipping file-open because auto-populate is disabled', {
        file: file.path,
      });
      return;
    }

    this.processingPaths.add(file.path);
    try {
      const isDaily = this.isDailyNote(file);

      if (isDaily) {
        const mismatches = await this.collectScheduledNotEmbedded(file);
        console.debug?.('[TPS GCM] [ScheduledLinkGuard] daily-note-opened scan', {
          file: file.path,
          mismatchCount: mismatches.length,
        });
        for (const mismatch of mismatches) {
          if (!(await this.mismatchStillExists(mismatch))) continue;
          const resolution = await this.promptForResolution(mismatch);
          if (resolution === 'cancel' || resolution === 'snooze') break;
          await this.applyResolution(mismatch, resolution);
        }
      } else {
        const mismatch = await this.collectMismatchForScheduledNote(file);
        if (mismatch && (await this.mismatchStillExists(mismatch))) {
          const resolution = await this.promptForResolution(mismatch);
          if (resolution !== 'cancel' && resolution !== 'snooze') {
            await this.applyResolution(mismatch, resolution);
          }
        }
      }
    } finally {
      this.processingPaths.delete(file.path);
    }
  }

  // ── Daily note detection ──────────────────────────────────────────────

  private isDailyNote(file: TFile): boolean {
    return this.plugin.fileNamingService.isDateOnlyBasename(file.basename);
  }

  /** Check if a file is tagged as a daily note (defensive catch for notes that
   *  have a date-like scheduled value but are daily notes nonetheless). */
  private hasDailyNoteTag(file: TFile): boolean {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
    const tagsKey = Object.keys(fm).find((k) => k.toLowerCase() === 'tags');
    const tags: string[] = Array.isArray(fm[tagsKey || 'tags'])
      ? (fm[tagsKey || 'tags'] as string[])
      : [];
    return tags.some((t) => String(t).trim().toLowerCase() === 'dailynote');
  }

  private extractDateFromDailyNote(file: TFile): string | null {
    return getDailyNoteResolver(this.plugin.app, {
      formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
    }).parseFilenameToDateKey(file.basename);
  }

  private getDailyNoteSettings(): { format: string; folder: string } {
    const resolver = getDailyNoteResolver(this.plugin.app, {
      formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
    });
    return { format: resolver.displayFormat, folder: resolver.folder };
  }

  private findCorrespondingDailyNote(dateStr: string): TFile | null {
    const m = (window as any).moment;
    const targetDate = m(dateStr, 'YYYY-MM-DD');
    if (!targetDate.isValid()) return null;

    const resolver = getDailyNoteResolver(this.plugin.app, {
      formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
    });
    const targetFilename = resolver.formatFilename(targetDate.toDate());
    const targetPath = resolver.buildPath(targetDate.toDate(), 'md');
    const folder = resolver.folder;

    const existing = this.plugin.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) return existing;

    // Fallback: search by filename only
    const justName = targetFilename.endsWith('.md') ? targetFilename : targetFilename + '.md';
    const found = this.plugin.app.metadataCache.getFirstLinkpathDest(justName, folder || '');
    if (found instanceof TFile) return found;

    return null;
  }

  // ── Mismatch collection ───────────────────────────────────────────────

  private async collectScheduledNotEmbedded(dailyNote: TFile): Promise<ScheduledLinkMismatch[]> {
    const dateStr = this.extractDateFromDailyNote(dailyNote);
    if (!dateStr) return [];

    const mismatches: ScheduledLinkMismatch[] = [];
    const embeddedPaths = this.getEmbeddedPaths(dailyNote);

    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      if (file.path === dailyNote.path) continue;
      if (this.isDailyNote(file)) continue;
      if (this.hasDailyNoteTag(file)) continue;
      if (this.shouldIgnore(file)) continue;

      const cache = this.plugin.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm) continue;

      const scheduled = String(fm.scheduled ?? '').trim();
      if (!scheduled) continue;

      const scheduledDate = (window as any).moment(scheduled);
      if (!scheduledDate.isValid()) continue;
      if (scheduledDate.format('YYYY-MM-DD') !== dateStr) continue;

      if (embeddedPaths.has(file.path)) continue;

      mismatches.push({
        direction: 'daily-note-opened',
        scheduledFile: file,
        scheduledDate: dateStr,
        dailyNoteFile: dailyNote,
      });
    }

    return mismatches;
  }

  private async collectMismatchForScheduledNote(file: TFile): Promise<ScheduledLinkMismatch | null> {
    if (this.isDailyNote(file)) return null;
    if (this.hasDailyNoteTag(file)) return null;
    if (this.shouldIgnore(file)) return null;

    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter;
    if (!fm) return null;

    const scheduled = String(fm.scheduled ?? '').trim();
    if (!scheduled) return null;

    const scheduledDate = (window as any).moment(scheduled);
    if (!scheduledDate.isValid()) return null;

    const dateStr = scheduledDate.format('YYYY-MM-DD');
    const dailyNote = this.findCorrespondingDailyNote(dateStr);

    // If the scheduled file IS the daily note, there's nothing to embed.
    if (dailyNote && dailyNote.path === file.path) return null;

    if (!dailyNote) {
      return {
        direction: 'scheduled-note-opened',
        scheduledFile: file,
        scheduledDate: dateStr,
        dailyNoteFile: null,
      };
    }

    const embeddedPaths = this.getEmbeddedPaths(dailyNote);
    if (embeddedPaths.has(file.path)) return null;

    return {
      direction: 'scheduled-note-opened',
      scheduledFile: file,
      scheduledDate: dateStr,
      dailyNoteFile: dailyNote,
    };
  }

  // ── Embed detection ───────────────────────────────────────────────────

  private getEmbeddedPaths(file: TFile): Set<string> {
    const result = new Set<string>();
    const cache = this.plugin.app.metadataCache.getFileCache(file);

    const embeds = (cache as any)?.embeds || (cache as any)?.links
      ? []
      : [];
    // Check embeds (transclusions like ![[NoteName]])
    const rawEmbeds: Array<{ link?: string }> = (cache as any)?.embeds || [];
    for (const embed of rawEmbeds) {
      const linkPath = String(embed.link || '').trim();
      if (!linkPath) continue;
      const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
      if (resolved instanceof TFile) result.add(resolved.path);
    }

    // Check links (plain links like [[NoteName]] including body subitem format)
    const rawLinks: Array<{ link?: string }> = (cache as any)?.links || [];
    for (const link of rawLinks) {
      const linkPath = String(link.link || '').trim();
      if (!linkPath) continue;
      const resolved = this.plugin.app.metadataCache.getFirstLinkpathDest(linkPath, file.path);
      if (resolved instanceof TFile) result.add(resolved.path);
    }

    return result;
  }

  // ── Ignore rules ──────────────────────────────────────────────────────

  private shouldIgnore(file: TFile): boolean {
    const ignoreFolders = this.plugin.settings.autoEmbedIgnoreFolders || [];
    const filePath = file.path.toLowerCase();
    for (const folder of ignoreFolders) {
      const normalizedFolder = folder.trim().toLowerCase();
      if (!normalizedFolder) continue;
      if (filePath.startsWith(normalizedFolder + '/') || filePath.startsWith(normalizedFolder)) {
        return true;
      }
    }

    const ignoreTags = this.plugin.settings.autoEmbedIgnoreTags || [];
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
    const tagsKey = Object.keys(fm).find((k) => k.toLowerCase() === 'tags');
    const fileTags: string[] = Array.isArray(fm[tagsKey || 'tags'])
      ? (fm[tagsKey || 'tags'] as string[])
      : [];

    for (const ignoreTag of ignoreTags) {
      const normalizedTag = ignoreTag.trim().toLowerCase().replace(/^#/, '');
      if (!normalizedTag) continue;
      for (const fileTag of fileTags) {
        if (String(fileTag).trim().toLowerCase().replace(/^#/, '') === normalizedTag) {
          return true;
        }
      }
    }

    return false;
  }

  // ── Validation ────────────────────────────────────────────────────────

  private async mismatchStillExists(mismatch: ScheduledLinkMismatch): Promise<boolean> {
    const liveFile = this.plugin.app.vault.getAbstractFileByPath(mismatch.scheduledFile.path);
    if (!(liveFile instanceof TFile)) return false;

    const cache = this.plugin.app.metadataCache.getFileCache(liveFile);
    const fm = cache?.frontmatter;
    const scheduled = String(fm?.scheduled ?? '').trim();
    if (!scheduled) return false;

    const scheduledDate = (window as any).moment(scheduled);
    if (!scheduledDate.isValid()) return false;
    if (scheduledDate.format('YYYY-MM-DD') !== mismatch.scheduledDate) return false;

    if (mismatch.dailyNoteFile) {
      const liveDailyNote = this.plugin.app.vault.getAbstractFileByPath(mismatch.dailyNoteFile.path);
      if (!(liveDailyNote instanceof TFile)) return false;
      const embeddedPaths = this.getEmbeddedPaths(liveDailyNote);
      if (embeddedPaths.has(liveFile.path)) return false;
    }

    return true;
  }

  // ── Prompt ────────────────────────────────────────────────────────────

  private promptForResolution(mismatch: ScheduledLinkMismatch): Promise<ScheduledLinkResolution> {
    return new Promise<ScheduledLinkResolution>((resolve) => {
      new ScheduledLinkMismatchModal(this.plugin.app, mismatch, resolve).open();
    });
  }

  // ── Resolution ────────────────────────────────────────────────────────

  private async applyResolution(
    mismatch: ScheduledLinkMismatch,
    resolution: ScheduledLinkResolution,
  ): Promise<void> {
    console.debug?.('[TPS GCM] [ScheduledLinkGuard] applying resolution', {
      resolution,
      direction: mismatch.direction,
      scheduledFile: mismatch.scheduledFile.path,
      dailyNoteFile: mismatch.dailyNoteFile?.path ?? null,
    });

    switch (resolution) {
      case 'embed-in-daily-note':
        await this.handleEmbed(mismatch);
        break;
      case 'reschedule':
        await this.handleReschedule(mismatch);
        break;
      case 'dismiss':
        new Notice(`Dismissed scheduled link for "${mismatch.scheduledFile.basename}".`);
        break;
      case 'snooze':
      case 'cancel':
      default:
        break;
    }
  }

  private async handleEmbed(mismatch: ScheduledLinkMismatch): Promise<void> {
    let dailyNote = mismatch.dailyNoteFile;

    if (!dailyNote) {
      dailyNote = await this.ensureDailyNoteExists(mismatch.scheduledDate);
      if (!dailyNote) {
        new Notice(`Failed to create daily note for ${mismatch.scheduledDate}.`);
        return;
      }
    }

    const checkboxState = this.resolveCheckboxState(mismatch.scheduledFile);
    const changed = await this.plugin.subitemRelationshipSyncService.insertBodyLink(
      dailyNote,
      mismatch.scheduledFile,
      checkboxState,
      { insertionMode: 'after-frontmatter' },
    );

    new Notice(
      changed
        ? `Embedded "${mismatch.scheduledFile.basename}" in "${dailyNote.basename}".`
        : `"${mismatch.scheduledFile.basename}" was already embedded in "${dailyNote.basename}".`,
    );
  }

  private async handleReschedule(mismatch: ScheduledLinkMismatch): Promise<void> {
    const cache = this.plugin.app.metadataCache.getFileCache(mismatch.scheduledFile);
    const fm = (cache?.frontmatter || {}) as Record<string, any>;
    const durationKey = getConfiguredTimeEstimatePropertyKey(this.plugin.settings);
    const currentDate = String(fm.scheduled ?? '').trim();
    const currentTimeEstimate = Number(fm[durationKey] ?? 0);
    const currentAllDay = Boolean(fm.allDay ?? false);

    const result = await new Promise<ScheduledResult | null>((resolve) => {
      new ScheduledModal(
        this.plugin.app,
        currentDate,
        currentTimeEstimate,
        currentAllDay,
        (r) => resolve(r),
      ).open();
    });

    if (!result || !result.date) return;

    await this.plugin.frontmatterMutationService.process(mismatch.scheduledFile, (fm) => {
      fm.scheduled = result.date;
      if (result.timeEstimate !== undefined) {
        fm[durationKey] = result.timeEstimate;
      }
      if (result.allDay !== undefined) {
        fm.allDay = result.allDay;
      }
    });

    new Notice(`Rescheduled "${mismatch.scheduledFile.basename}" to ${result.date}.`);
  }

  // ── Daily note creation ───────────────────────────────────────────────

  private async ensureDailyNoteExists(dateStr: string): Promise<TFile | null> {
    const m = (window as any).moment;
    const targetDate = m(dateStr, 'YYYY-MM-DD');
    if (!targetDate.isValid()) return null;

    const sharedCreated = await ensureDailyNoteFile(this.plugin.app as any, targetDate.toDate(), {
      formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
    });
    if (sharedCreated instanceof TFile) return sharedCreated;

    const resolver = getDailyNoteResolver(this.plugin.app, {
      formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
    });
    const targetFilename = resolver.formatFilename(targetDate.toDate());
    const targetPath = resolver.buildPath(targetDate.toDate(), 'md');

    const existing = this.plugin.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) return existing;

    // Try core daily notes plugin
    try {
      const internalPlugins = (this.plugin.app as any).internalPlugins;
      const dailyNotes = internalPlugins?.getPluginById?.('daily-notes');
      if (dailyNotes?.instance?.createNote) {
        const file = await dailyNotes.instance.createNote(targetDate);
        if (file instanceof TFile) return file;
      }
    } catch { /* fallback */ }

    // Try periodic notes plugin
    try {
      const periodicNotes = (this.plugin.app as any).plugins?.getPlugin?.('periodic-notes');
      if (periodicNotes?.createDailyNote) {
        const file = await periodicNotes.createDailyNote(targetDate);
        if (file instanceof TFile) return file;
      }
    } catch { /* fallback */ }

    // Manual creation fallback
    try {
      const slash = targetPath.lastIndexOf('/');
      const folderPath = slash >= 0 ? targetPath.substring(0, slash) : '';
      if (folderPath) {
        const adapter = this.plugin.app.vault.adapter;
        if (!(await adapter.exists(folderPath))) {
          await this.plugin.app.vault.createFolder(folderPath);
        }
      }
      const content = `---\ntitle: ${targetFilename}\ntags: [dailynote]\nscheduled: ${dateStr}\n---\n\n`;
      return await this.plugin.app.vault.create(targetPath, content);
    } catch (err) {
      console.error('[TPS GCM] [ScheduledLinkGuard] Failed to create daily note', err);
      return null;
    }
  }

  // ── Checkbox state ────────────────────────────────────────────────────

  private resolveCheckboxState(file: TFile): string | null {
    const statusKey = String(
      this.plugin.settings.properties?.find((prop) => prop.id === 'status')?.key || 'status',
    )
      .trim()
      || 'status';
    const frontmatter = (this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ||
      {}) as Record<string, unknown>;
    const actualKey = Object.keys(frontmatter).find((k) => k.toLowerCase() === statusKey.toLowerCase());
    if (!actualKey) return null;
    return '[ ]';
  }
}
