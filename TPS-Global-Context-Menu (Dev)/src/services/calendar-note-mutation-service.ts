import { TFile } from 'obsidian';
import TPSGlobalContextMenuPlugin from '../main';
import * as logger from '../logger';
import type { TemplateVars } from '../../../TPS-Calendar-Base (Dev)/src/utils/template-variable-service';
import { applyParentLinkToChild } from '../../../TPS-Calendar-Base (Dev)/src/services/parent-child-link';

export type CalendarEventFields = {
  dateField?: string | null;
  startField: string;
  endField?: string | null;
  allDayField?: string | null;
  useEndDuration?: boolean;
};

export type CalendarCreateNoteInput = {
  path: string;
  initialContent: string;
  frontmatterDefaults?: Record<string, unknown>;
  frontmatterOverrides?: Record<string, unknown>;
  parentFile?: TFile | null;
  templateFile?: TFile | null;
  templateVars?: TemplateVars;
  userInitiated?: boolean;
  dedupe?: {
    exactPath?: boolean;
    sameFolderBasename?: boolean;
  };
};

export type CalendarEventMutationInput = {
  file: TFile;
  start: string;
  end?: string | null;
  allDay?: boolean;
  folderPath?: string | null;
  updates?: Record<string, unknown>;
  eventFields: CalendarEventFields;
  userInitiated?: boolean;
};

export type CalendarFrontmatterMutationInput = {
  file: TFile;
  updates?: Record<string, unknown>;
  deletes?: string[];
  folderPath?: string | null;
  transform?: (frontmatter: Record<string, unknown>) => void;
  userInitiated?: boolean;
};

export class CalendarNoteMutationService {
  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  async applyFrontmatterMutation(input: CalendarFrontmatterMutationInput): Promise<boolean> {
    const { file, updates, deletes, folderPath, transform, userInitiated } = input;
    if (!(file instanceof TFile)) return false;

    const changed = await this.plugin.frontmatterMutationService.process(file, async (frontmatter) => {
      if (updates && typeof updates === 'object') {
        for (const [key, value] of Object.entries(updates)) {
          if (value === undefined) continue;
          frontmatter[key] = value;
        }
      }

      for (const key of deletes || []) {
        delete frontmatter[key];
      }

      if (typeof folderPath === 'string' && folderPath.trim()) {
        frontmatter.folderPath = folderPath.trim();
      }

      if (typeof transform === 'function') {
        transform(frontmatter as Record<string, unknown>);
      }
    }, { userInitiated: userInitiated ?? false });

    await this.finalizeMutation(file);
    return changed;
  }

  async applyEventMutation(input: CalendarEventMutationInput): Promise<boolean> {
    const { file, start, end, allDay, folderPath, updates, eventFields, userInitiated } = input;
    if (!(file instanceof TFile)) return false;
    if (!eventFields?.startField) return false;

    const changed = await this.plugin.frontmatterMutationService.process(file, async (frontmatter) => {
      if (eventFields.dateField) {
        frontmatter[eventFields.dateField] = this.extractDateOnly(start);
      }
      frontmatter[eventFields.startField] = start;

      if (eventFields.endField) {
        if (eventFields.useEndDuration) {
          if (typeof end === 'string' && end.trim()) {
            frontmatter[eventFields.endField] = this.computeDurationMinutes(start, end);
          }
        } else if (typeof end === 'string' && end.trim()) {
          frontmatter[eventFields.endField] = end;
        }
      }

      if (eventFields.allDayField && typeof allDay === 'boolean') {
        frontmatter[eventFields.allDayField] = allDay;
      }

      if (typeof folderPath === 'string' && folderPath.trim()) {
        frontmatter.folderPath = folderPath.trim();
      }

      if (updates && typeof updates === 'object') {
        for (const [key, value] of Object.entries(updates)) {
          if (value === undefined) continue;
          frontmatter[key] = value;
        }
      }
    }, { userInitiated: userInitiated ?? false });

    await this.finalizeMutation(file);

    return changed;
  }

  async createCalendarNote(input: CalendarCreateNoteInput): Promise<TFile> {
    const existing = this.findExistingForCreate(input.path, input.dedupe);
    const created = existing ?? await this.createFileRetrying(input.path, input.initialContent || '---\n---\n');

    if (!existing) {
      await this.runTemplaterOnFile(created);
      await this.ensureWritableFrontmatterDocument(created);
    }

    const frontmatterUpdates = {
      ...(input.frontmatterDefaults || {}),
      ...(input.frontmatterOverrides || {}),
      folderPath: created.parent?.path || '/',
    };
    await this.plugin.frontmatterMutationService.process(created, async (frontmatter) => {
      for (const [key, value] of Object.entries(frontmatterUpdates)) {
        if (value === undefined) continue;
        frontmatter[key] = value;
      }
    }, { userInitiated: true });

    if (input.parentFile instanceof TFile) {
      await applyParentLinkToChild(this.plugin.app, created, input.parentFile, String(this.plugin.settings.parentLinkFrontmatterKey || 'parent').trim() || 'parent');
    }

    await this.finalizeMutation(created);
    return created;
  }

  private async finalizeMutation(file: TFile): Promise<void> {
    const liveFile = this.plugin.app.vault.getAbstractFileByPath(file.path);
    if (!(liveFile instanceof TFile)) return;
    try {
      await this.plugin.fileNamingService.syncFolderPath(liveFile);
      this.plugin.persistentMenuManager?.refreshMenusForFile(liveFile, true);
    } catch (error) {
      logger.warn('[TPS GCM] Failed post-mutation refresh for calendar note', { file: file.path, error });
    }
  }

  private findExistingForCreate(path: string, dedupe?: CalendarCreateNoteInput['dedupe']): TFile | null {
    const normalizedPath = String(path || '').trim();
    if (!normalizedPath) return null;

    if (dedupe?.exactPath !== false) {
      const exact = this.plugin.app.vault.getAbstractFileByPath(normalizedPath);
      if (exact instanceof TFile) return exact;
    }

    if (dedupe?.sameFolderBasename) {
      const slashIndex = normalizedPath.lastIndexOf('/');
      const folder = slashIndex >= 0 ? normalizedPath.slice(0, slashIndex) : '';
      const fileName = slashIndex >= 0 ? normalizedPath.slice(slashIndex + 1) : normalizedPath;
      const basename = fileName.replace(/\.md$/i, '').toLowerCase();
      for (const file of this.plugin.app.vault.getMarkdownFiles()) {
        if ((file.parent?.path || '') !== folder) continue;
        if (file.basename.toLowerCase() === basename) return file;
      }
    }

    return null;
  }

  private computeDurationMinutes(start: string, end: string): number {
    const startMs = Date.parse(start.replace(' ', 'T'));
    const endMs = Date.parse(end.replace(' ', 'T'));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
    return Math.max(0, Math.round((endMs - startMs) / 60000));
  }

  private extractDateOnly(value: string): string {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
    return match?.[1] || trimmed.split(' ')[0] || trimmed;
  }

  private async createFileRetrying(initialPath: string, content: string): Promise<TFile> {
    const MAX_RETRIES = 20;
    const withoutExt = initialPath.endsWith('.md') ? initialPath.slice(0, -3) : initialPath;
    const baseWithoutCounter = withoutExt.replace(/ \d+$/, '');

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const path = attempt === 0 ? initialPath : `${baseWithoutCounter} ${attempt}.md`;
      try {
        return await this.plugin.app.vault.create(path, content);
      } catch (error: any) {
        const isExists = typeof error?.message === 'string' && error.message.toLowerCase().includes('already exists');
        if (!isExists || attempt === MAX_RETRIES) throw error;
      }
    }

    throw new Error(`[TPS GCM] Could not create file after retries for "${initialPath}"`);
  }

  private async runTemplaterOnFile(file: TFile): Promise<void> {
    const templater = (this.plugin.app as any)?.plugins?.plugins?.['templater-obsidian'];
    if (!templater?.templater) return;
    try {
      await templater.templater.overwrite_file_commands(file, false);
    } catch (error) {
      logger.warn('[TPS GCM] Templater failed during calendar note create', { file: file.path, error });
    }
  }

  private async ensureWritableFrontmatterDocument(file: TFile): Promise<void> {
    const raw = await this.plugin.app.vault.read(file);
    const normalized = raw.replace(/\r\n/g, '\n');
    const bom = normalized.startsWith('\uFEFF') ? '\uFEFF' : '';
    const content = bom ? normalized.slice(1) : normalized;
    if (/^(?:---\n\s*)+$/.test(content)) {
      const repaired = `${bom}---\n---\n`;
      if (normalized !== repaired) {
        await this.plugin.app.vault.modify(file, repaired);
        logger.warn('[TPS GCM] Collapsed delimiter-only note to canonical empty frontmatter document', {
          file: file.path,
        });
      }
      return;
    }
    if (!content.startsWith('---\n')) {
      const closeIndex = content.indexOf('\n---\n');
      if (closeIndex > 0) {
        const candidateBlock = content.slice(0, closeIndex).trim();
        const lines = candidateBlock
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const yamlLike = lines.length > 0 && lines.every((line) => /^[A-Za-z0-9_"'.-]+\s*:/.test(line));
        if (yamlLike) {
          const repaired = `${bom}---\n${candidateBlock}\n---\n${content.slice(closeIndex + '\n---\n'.length)}`;
          await this.plugin.app.vault.modify(file, repaired);
          logger.warn('[TPS GCM] Repaired newly created note with missing opening frontmatter delimiter before canonical mutation', {
            file: file.path,
          });
        }
      }
      return;
    }
    if (content.indexOf('\n---\n', 4) !== -1) return;

    const repaired = `${bom}---\n---\n${content}`;
    await this.plugin.app.vault.modify(file, repaired);
    logger.warn('[TPS GCM] Repaired newly created note with unterminated frontmatter before canonical mutation', {
      file: file.path,
    });
  }
}
