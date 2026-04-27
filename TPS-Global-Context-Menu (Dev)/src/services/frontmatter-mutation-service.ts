import { MarkdownView, Notice, TFile, parseYaml, stringifyYaml } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import * as logger from '../logger';
import { casefold, deleteValueCaseInsensitive, findKeyCaseInsensitive, setValueCaseInsensitive } from '../core';
import { getCompatibleMarkdownViewFromLeaf, pickBestMarkdownLeaf } from './leaf-resolver';
import { mergeNormalizedTags } from '../utils/tag-utils';

type FrontmatterRecord = Record<string, unknown>;
type FrontmatterMutator = (frontmatter: FrontmatterRecord) => void | Promise<void>;
export type WriteOptions = { userInitiated?: boolean };

export class FrontmatterMutationService {
  private writeChains = new Map<string, Promise<void>>();
  private warnedPaths = new Set<string>();
  private recentWrites = new Map<string, number>();
  private static readonly PARSE_RETRY_DELAYS_MS = [40, 120, 250];
  private static readonly RECENT_WRITE_IGNORE_MS = 2000;

  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  async process(file: TFile, mutator: FrontmatterMutator, options?: WriteOptions): Promise<boolean> {
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'md') return false;
    if (!options?.userInitiated && !this.plugin.isInitialSyncSettled()) {
      return false;
    }

    return this.executeMutation(file, mutator);
  }

  async processUserInitiated(file: TFile, mutator: FrontmatterMutator): Promise<boolean> {
    return this.process(file, mutator, { userInitiated: true });
  }

  private async executeMutation(file: TFile, mutator: FrontmatterMutator): Promise<boolean> {
    let changed = false;
    await this.runSerialized(file, async () => {
      const attempt = await this.readParsedWithRetries(file);
      if (!attempt) return;

      const { normalized, parsed } = attempt;
      if (!parsed.ok) {
        const { reason, error } = parsed as { ok: false; reason: string; error?: unknown };
        this.warnMalformed(file, reason, error);
        return;
      }

      const frontmatter = parsed.frontmatter;
      const before = stringifyYaml(this.sortFrontmatter(frontmatter)).trimEnd();
      await mutator(frontmatter);
      this.enforceDailyNoteTag(file, frontmatter);
      this.removeEmptyValues(frontmatter);
      const sorted = this.sortFrontmatter(frontmatter);
      const after = stringifyYaml(sorted).trimEnd();

      const nextContent = after
        ? `${normalized.bom}---\n${after}\n---${parsed.body ? `\n${parsed.body}` : '\n'}`
        : `${normalized.bom}${parsed.body}`;

      if (nextContent !== normalized.fullContent || before !== after) {
        if (!this.hasSuspiciousBrokenSubitemLine(normalized.fullContent) && this.hasSuspiciousBrokenSubitemLine(nextContent)) {
          this.warnMalformed(file, 'suspicious-broken-subitem-line');
          logger.warn('[TPS GCM] Refusing frontmatter write that would introduce a broken subitem line', {
            file: file.path,
            stack: new Error().stack,
          });
          return;
        }
        await this.writeContent(file, nextContent);
        this.markRecentWrite(file.path);
        this.refreshOpenFileUi(file);
        changed = true;
      }
    });

    return changed;
  }

  async writeContentSafely(file: TFile, content: string, options?: WriteOptions): Promise<boolean> {
    if (!(file instanceof TFile)) return false;
    if (!options?.userInitiated && !this.plugin.isInitialSyncSettled()) {
      return false;
    }
    await this.runSerialized(file, async () => {
      await this.plugin.app.vault.modify(file, content);
      this.markRecentWrite(file.path);
      this.refreshOpenFileUi(file);
    });
    return true;
  }

  wasRecentlyWritten(path: string): boolean {
    const key = String(path || '').trim();
    if (!key) return false;

    const until = this.recentWrites.get(key);
    if (!until) return false;

    if (Date.now() > until) {
      this.recentWrites.delete(key);
      return false;
    }

    return true;
  }

  isWriteInProgress(path: string): boolean {
    const key = String(path || '').trim();
    if (!key) return false;
    return this.writeChains.has(key);
  }

  async updateValues(files: TFile[], updates: Record<string, unknown>): Promise<TFile[]> {
    return await this.applyToFiles(files, async (frontmatter) => {
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === null) {
          deleteValueCaseInsensitive(frontmatter, key);
          continue;
        }
        setValueCaseInsensitive(frontmatter, key, value);
      }
    });
  }

  async setListValues(files: TFile[], key: string, values: unknown[]): Promise<TFile[]> {
    return await this.applyToFiles(files, async (frontmatter) => {
      const normalized = this.normalizeList(values);
      if (normalized.length === 0) {
        deleteValueCaseInsensitive(frontmatter, key);
      } else {
        setValueCaseInsensitive(frontmatter, key, normalized);
      }
    });
  }

  async addValuesToList(files: TFile[], key: string, values: unknown[]): Promise<TFile[]> {
    const additions = this.normalizeList(values);
    if (additions.length === 0) return [];
    return await this.applyToFiles(files, async (frontmatter) => {
      const existingKey = findKeyCaseInsensitive(frontmatter, key) || key;
      const current = this.normalizeList(frontmatter[existingKey]);
      const merged = [...current];
      const seen = new Set(current.map((value) => casefold(String(value))));
      for (const value of additions) {
        const marker = casefold(String(value));
        if (seen.has(marker)) continue;
        seen.add(marker);
        merged.push(value);
      }
      setValueCaseInsensitive(frontmatter, existingKey, merged);
    });
  }

  async removeValuesFromList(files: TFile[], key: string, values: unknown[]): Promise<TFile[]> {
    const removals = new Set(this.normalizeList(values).map((value) => casefold(String(value))));
    if (removals.size === 0) return [];
    return await this.applyToFiles(files, async (frontmatter) => {
      const existingKey = findKeyCaseInsensitive(frontmatter, key);
      if (!existingKey) return;
      const current = this.normalizeList(frontmatter[existingKey]);
      const filtered = current.filter((value) => !removals.has(casefold(String(value))));
      if (filtered.length === 0) {
        delete frontmatter[existingKey];
      } else {
        setValueCaseInsensitive(frontmatter, existingKey, filtered);
      }
    });
  }

  async setDateValue(files: TFile[], key: string, value: string | null): Promise<TFile[]> {
    return await this.applyToFiles(files, async (frontmatter) => {
      const normalized = String(value || '').trim();
      if (!normalized) {
        deleteValueCaseInsensitive(frontmatter, key);
      } else {
        setValueCaseInsensitive(frontmatter, key, normalized);
      }
    });
  }

  async deleteKeys(files: TFile[], keys: string[]): Promise<TFile[]> {
    const normalizedKeys = keys.map((key) => String(key || '').trim()).filter(Boolean);
    if (normalizedKeys.length === 0) return [];
    return await this.applyToFiles(files, async (frontmatter) => {
      for (const key of normalizedKeys) {
        deleteValueCaseInsensitive(frontmatter, key);
      }
    });
  }

  private async applyToFiles(files: TFile[], mutator: FrontmatterMutator): Promise<TFile[]> {
    const updated: TFile[] = [];
    for (const file of files) {
      try {
        if (await this.process(file, mutator)) {
          updated.push(file);
        }
      } catch (error) {
        logger.error('[TPS GCM] Frontmatter mutation failed', { file: file.path, error });
      }
    }
    return updated;
  }

  private async runSerialized(file: TFile, action: () => Promise<void>): Promise<void> {
    const key = file.path;
    const previous = this.writeChains.get(key) ?? Promise.resolve();

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.writeChains.set(key, previous.then(() => current).catch(() => current));

    try {
      await previous;
      await action();
    } finally {
      release();
      if (this.writeChains.get(key) === current) {
        this.writeChains.delete(key);
      }
    }
  }

  private markRecentWrite(path: string): void {
    const key = String(path || '').trim();
    if (!key) return;
    this.recentWrites.set(key, Date.now() + FrontmatterMutationService.RECENT_WRITE_IGNORE_MS);
  }

  private refreshOpenFileUi(file: TFile): void {
    const liveFile = this.plugin.app.vault.getAbstractFileByPath(file.path);
    if (!(liveFile instanceof TFile)) return;

    this.plugin.menuController?.panelBuilder?.clearFileTitleCache(liveFile.path);
    this.plugin.persistentMenuManager?.refreshMenusForFile(liveFile, true, { rebuildInlineSubitems: true });

    window.setTimeout(() => {
      const latest = this.plugin.app.vault.getAbstractFileByPath(liveFile.path);
      if (!(latest instanceof TFile)) return;
      this.plugin.persistentMenuManager?.refreshMenusForFile(latest, true, { rebuildInlineSubitems: true });
    }, 40);
  }

  private async readNormalized(file: TFile): Promise<{ bom: string; content: string; fullContent: string } | null> {
    try {
      const openView = this.getOpenMarkdownViewForFile(file);
      const fullContent = openView
        ? this.readViewSource(openView) ?? await this.plugin.app.vault.read(file)
        : await this.plugin.app.vault.read(file);
      const normalized = fullContent.replace(/\r\n/g, '\n');
      if (!normalized) {
        return { bom: '', content: '', fullContent: normalized };
      }
      if (normalized.startsWith('\uFEFF')) {
        return { bom: '\uFEFF', content: normalized.slice(1), fullContent: normalized };
      }
      return { bom: '', content: normalized, fullContent: normalized };
    } catch (error) {
      logger.warn('[TPS GCM] Failed reading file for frontmatter mutation', { file: file.path, error });
      return null;
    }
  }

  private async writeContent(file: TFile, nextContent: string): Promise<void> {
    const openViews = this.getOpenMarkdownViewsForFile(file);
    const editorViews = openViews.filter((view) => {
      const editor = (view as any)?.editor;
      return typeof editor?.setValue === 'function';
    });

    if (editorViews.length === 0) {
      await this.plugin.app.vault.modify(file, nextContent);
      return;
    }

    for (const view of editorViews) {
      const editor = (view as any).editor;
      editor.setValue(nextContent);
    }

    const primaryView = editorViews[0] as any;
    if (typeof primaryView?.requestSave === 'function') {
      primaryView.requestSave();
      return;
    }
    if (typeof primaryView?.save === 'function') {
      try {
        await primaryView.save(false);
        return;
      } catch (error) {
        logger.warn('[TPS GCM] Failed saving open markdown view after frontmatter mutation; falling back to vault.modify', {
          file: file.path,
          error,
        });
      }
    }

    await this.plugin.app.vault.modify(file, nextContent);
  }

  private async readParsedWithRetries(file: TFile): Promise<{
    normalized: { bom: string; content: string; fullContent: string };
    parsed:
      | { ok: true; frontmatter: FrontmatterRecord; body: string }
      | { ok: false; reason: string; error?: unknown };
  } | null> {
    let last: {
      normalized: { bom: string; content: string; fullContent: string };
      parsed:
        | { ok: true; frontmatter: FrontmatterRecord; body: string }
        | { ok: false; reason: string; error?: unknown };
    } | null = null;

    for (let attemptIndex = 0; attemptIndex <= FrontmatterMutationService.PARSE_RETRY_DELAYS_MS.length; attemptIndex++) {
      const normalized = await this.readNormalized(file);
      if (!normalized) return null;

      let parsed:
        | { ok: true; frontmatter: FrontmatterRecord; body: string }
        | { ok: false; reason: string; error?: unknown };
      try {
        parsed = this.parseFrontmatterDocument(normalized.content);
      } catch (error) {
        parsed = { ok: false, reason: 'yaml-parse-failed', error };
      }

      if (parsed.ok) {
        if (attemptIndex > 0) {
          logger.debug('[TPS GCM] Frontmatter parse recovered after retry', {
            file: file.path,
            attempts: attemptIndex + 1,
          });
        }
        return { normalized, parsed };
      }

      last = { normalized, parsed };
      const delay = FrontmatterMutationService.PARSE_RETRY_DELAYS_MS[attemptIndex];
      if (delay == null) break;
      await this.sleep(delay);
    }

    return last;
  }

  private parseFrontmatterDocument(content: string):
    | { ok: true; frontmatter: FrontmatterRecord; body: string }
    | { ok: false; reason: string; error?: unknown } {
    const trimmedLeading = content.replace(/^\s*/, '');
    const working = trimmedLeading.startsWith('---\n') ? trimmedLeading : content;

    if (!working.startsWith('---\n')) {
      const recovered = this.tryRecoverMissingOpeningDelimiter(working);
      if (recovered) {
        return recovered;
      }
      return { ok: true, frontmatter: {}, body: working };
    }

    const blocks: string[] = [];
    let cursor = 0;
    while (working.startsWith('---\n', cursor)) {
      const closeIndex = working.indexOf('\n---\n', cursor + 3);
      if (closeIndex === -1) {
        return { ok: false, reason: 'unterminated-frontmatter' };
      }
      blocks.push(working.slice(cursor + 4, closeIndex));
      cursor = closeIndex + 5;

      const remainder = working.slice(cursor);
      const gap = remainder.match(/^[ \t\r\n]*/)?.[0] ?? '';
      const next = remainder.slice(gap.length);
      if (!next.startsWith('---\n')) {
        return {
          ok: true,
          frontmatter: this.tryMergeFrontmatterBlocks(blocks),
          body: remainder,
        };
      }
      cursor += gap.length;
    }

    return {
      ok: true,
      frontmatter: this.tryMergeFrontmatterBlocks(blocks),
      body: working.slice(cursor),
    };
  }

  private tryRecoverMissingOpeningDelimiter(content: string): { ok: true; frontmatter: FrontmatterRecord; body: string } | null {
    const closeIndex = content.indexOf('\n---\n');
    if (closeIndex <= 0) return null;

    const candidateBlock = content.slice(0, closeIndex).trim();
    if (!candidateBlock) return null;

    const lines = candidateBlock
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;

    const yamlLike = lines.every((line) => /^[A-Za-z0-9_"'.-]+\s*:/.test(line));
    if (!yamlLike) return null;

    return {
      ok: true,
      frontmatter: this.tryMergeFrontmatterBlocks([candidateBlock]),
      body: content.slice(closeIndex + '\n---\n'.length),
    };
  }

  private tryMergeFrontmatterBlocks(blocks: string[]): FrontmatterRecord {
    const merged: FrontmatterRecord = {};
    try {
      for (const block of blocks) {
        if (!String(block || '').trim()) continue;
        const parsed = parseYaml(block);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        for (const [key, value] of Object.entries(parsed as FrontmatterRecord)) {
          setValueCaseInsensitive(merged, key, value);
        }
      }
      return merged;
    } catch (error) {
      throw new Error(`yaml-parse-failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private sortFrontmatter(frontmatter: FrontmatterRecord): FrontmatterRecord {
    const ordered: FrontmatterRecord = {};
    const entries = Object.entries(frontmatter || {});
    const claimed = new Set<string>();
    const propertyKeys = (this.plugin.settings.properties || [])
      .map((property) => String(property?.key || '').trim())
      .filter(Boolean);

    for (const configuredKey of propertyKeys) {
      const match = entries.find(([key]) => casefold(key) === casefold(configuredKey));
      if (!match) continue;
      ordered[configuredKey] = match[1];
      claimed.add(casefold(match[0]));
    }

    const remainder = entries
      .filter(([key]) => !claimed.has(casefold(key)))
      .sort((left, right) => left[0].localeCompare(right[0], undefined, { sensitivity: 'base' }));

    for (const [key, value] of remainder) {
      ordered[key] = value;
    }

    return ordered;
  }

  private removeEmptyValues(frontmatter: FrontmatterRecord): void {
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value === undefined) {
        delete frontmatter[key];
        continue;
      }
      if (Array.isArray(value) && value.length === 0) {
        delete frontmatter[key];
      }
    }
  }

  private enforceDailyNoteTag(file: TFile, frontmatter: FrontmatterRecord): void {
    const isDailyNote = !!this.plugin.fileNamingService?.isDateOnlyBasename?.(file.basename);
    if (!isDailyNote) return;
    setValueCaseInsensitive(frontmatter, 'tags', mergeNormalizedTags(frontmatter.tags, 'dailynote'));
  }

  private normalizeList(value: unknown): string[] {
    const source = Array.isArray(value) ? value : value == null ? [] : [value];
    return source
      .flatMap((entry) => Array.isArray(entry) ? entry : [entry])
      .map((entry) => String(entry ?? '').trim())
      .filter(Boolean);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private hasSuspiciousBrokenSubitemLine(text: string): boolean {
    return String(text || '').split('\n').some((line) =>
      /^[ \t]*(?:[-*+]|\d+\.)\s+(?:\[[^\]]+]\s+)?\[\[$/.test(line.trimEnd()),
    );
  }

  private getOpenMarkdownViewForFile(file: TFile): MarkdownView | null {
    return this.getOpenMarkdownViewsForFile(file)[0] ?? null;
  }

  private getOpenMarkdownViewsForFile(file: TFile): MarkdownView[] {
    const leaves = [];
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      if (view.file?.path !== file.path) continue;
      leaves.push(leaf);
    }
    if (leaves.length === 0) return [];

    const activeLeaf = this.plugin.app.workspace.activeLeaf ?? null;
    const bestLeaf = pickBestMarkdownLeaf(leaves, activeLeaf);
    const orderedLeaves = bestLeaf
      ? [bestLeaf, ...leaves.filter((leaf) => leaf !== bestLeaf)]
      : leaves;

    return orderedLeaves
      .map((leaf) => getCompatibleMarkdownViewFromLeaf(leaf))
      .filter((view): view is MarkdownView => view instanceof MarkdownView);
  }

  private readViewData(view: MarkdownView): string {
    const anyView = view as any;
    const editor = anyView.editor;
    if (typeof editor?.getValue === 'function') {
      return String(editor.getValue() || '');
    }
    if (typeof anyView.getViewData === 'function') {
      const data = anyView.getViewData();
      if (typeof data === 'string') return data;
    }
    return String(anyView.data || '');
  }

  private readViewSource(view: MarkdownView): string | null {
    const anyView = view as any;
    const editor = anyView.editor;
    if (typeof editor?.getValue === 'function') {
      return String(editor.getValue() || '');
    }
    return null;
  }

  private warnMalformed(file: TFile, reason: string, error?: unknown): void {
    if (!this.warnedPaths.has(file.path)) {
      this.warnedPaths.add(file.path);
      new Notice(`Skipped frontmatter write for "${file.path}" (${reason}).`);
    }
    const detail = error instanceof Error ? error.message : error == null ? '' : String(error);
    logger.warn(`[TPS GCM] Skipping malformed frontmatter mutation for ${file.path} (${reason})${detail ? `: ${detail}` : ''}`);
  }
}
