/**
 * Tag Service
 *
 * Tag normalization and tag lookup utilities.
 * Tag canvas/tag base orchestration is intentionally disabled.
 */

import { TFile, normalizePath } from "obsidian";
import type ExplorerPlugin from "./main";

export class TagService {
  private plugin: ExplorerPlugin;
  private fileTagCache: Map<string, Set<string>> = new Map();

  constructor(plugin: ExplorerPlugin) {
    this.plugin = plugin;
  }

  get app() {
    return this.plugin.app;
  }

  get settings() {
    return this.plugin.settings;
  }

  normalizeTag(tag: string): string {
    return tag.replace(/^#+/, "").trim().toLowerCase();
  }

  private parseTagInput(raw: any): string[] {
    const tokens = Array.isArray(raw)
      ? raw.flatMap((value: any) => this.parseTagInput(value))
      : typeof raw === "string"
        ? raw.split(/[\s,]+/).filter(Boolean)
        : raw == null
          ? []
          : [String(raw)];
    const normalized = tokens
      .map((value: any) => this.normalizeTag(String(value)))
      .filter(Boolean);
    return Array.from(new Set(normalized));
  }

  private sanitizeTagSegment(seg: string): string {
    return seg.replace(/[\\/:*?"<>|]/g, "_").trim();
  }

  buildTagNotePath(
    basePath: string,
    tag: string
  ): { path: string; relative: string } {
    const normalized = this.normalizeTag(tag);
    const parts = normalized
      .split("/")
      .map((p) => this.sanitizeTagSegment(p))
      .filter(Boolean);
    const relative =
      parts.length > 0 ? `${parts.join("/")}.canvas` : "untagged.canvas";
    return { path: normalizePath(`${basePath}/${relative}`), relative };
  }

  getTagNoteFolderPath(): string | null {
    return null;
  }

  shouldUseTagBaseViews(): boolean {
    return false;
  }

  primeFileTagCache(): void {
    this.fileTagCache.clear();
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      this.fileTagCache.set(file.path, this.getTagsForFile(file));
    }
  }

  getFileTagCacheEntry(path: string): Set<string> | undefined {
    return this.fileTagCache.get(path);
  }

  updateFileTagCacheOnRename(oldPath: string, newPath: string): void {
    const cached = this.fileTagCache.get(oldPath);
    if (cached) {
      this.fileTagCache.delete(oldPath);
      this.fileTagCache.set(newPath, cached);
    }
  }

  private getTagsForFile(file: TFile): Set<string> {
    if (this.isNoteArchived(file)) return new Set();
    const tags = new Set<string>();
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache?.frontmatter?.tags) {
      const raw = this.parseTagInput(cache.frontmatter.tags);
      for (const tag of raw) {
        const normalized = this.normalizeTag(String(tag));
        if (normalized) tags.add(normalized);
      }
    }
    if (cache?.tags) {
      for (const tagRef of cache.tags) {
        const normalized = this.normalizeTag(tagRef.tag);
        if (normalized) tags.add(normalized);
      }
    }
    return tags;
  }

  isNoteArchived(file: TFile): boolean {
    const archiveTag = this.normalizeTag(
      this.settings?.archiveTag || "#archive"
    );
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter;

    if (frontmatter?.tags) {
      const tags = this.parseTagInput(frontmatter.tags);
      if (tags.includes(archiveTag)) {
        return true;
      }
    }

    const allTags = cache?.tags || [];
    for (const tagRef of allTags) {
      if (this.normalizeTag(tagRef.tag) === archiveTag) {
        return true;
      }
    }

    return false;
  }

  getActiveTagsOnly(): Set<string> {
    const allFiles = this.app.vault.getMarkdownFiles();
    const activeTagCounts = new Map<string, number>();

    for (const file of allFiles) {
      if (this.isNoteArchived(file)) continue;

      const cache = this.app.metadataCache.getFileCache(file);
      const fileTags = cache?.tags || [];
      const frontmatterTags = cache?.frontmatter?.tags;

      const seenInFile = new Set<string>();

      for (const tagRef of fileTags) {
        seenInFile.add(this.normalizeTag(tagRef.tag));
      }

      if (frontmatterTags) {
        const tags = this.parseTagInput(frontmatterTags);
        for (const tag of tags) {
          seenInFile.add(tag);
        }
      }

      for (const tag of seenInFile) {
        activeTagCounts.set(tag, (activeTagCounts.get(tag) || 0) + 1);
      }
    }

    return new Set(activeTagCounts.keys());
  }

  getFilesWithTag(tag: string): TFile[] {
    const normalized = this.normalizeTag(tag);
    const files: TFile[] = [];
    const allFiles = this.app.vault.getMarkdownFiles();
    for (const file of allFiles) {
      if (this.isNoteArchived(file)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;
      const fmTags = cache.frontmatter?.tags || [];
      const fmTagsArray = this.parseTagInput(fmTags);
      const hasFmTag = fmTagsArray.some(
        (t: string) => this.normalizeTag(String(t)) === normalized
      );
      const inlineTags = cache.tags || [];
      const hasInlineTag = inlineTags.some(
        (t: any) => this.normalizeTag(t.tag) === normalized
      );
      if (hasFmTag || hasInlineTag) files.push(file);
    }
    return files;
  }

  async handleTagCanvasFileChange(file: any): Promise<void> {
    if (!(file instanceof TFile)) return;
    if (file.extension !== "md") return;
    this.fileTagCache.set(file.path, this.getTagsForFile(file));
  }

  async handleTagCanvasFileDelete(file: any): Promise<void> {
    if (!(file instanceof TFile)) return;
    this.fileTagCache.delete(file.path);
  }

  handleRenameForTagNotes(file: TFile, oldPath: string): void {
    void file;
    void oldPath;
  }

  parseCanvasData(raw: string): any | null {
    if (!raw) return null;
    try {
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return null;
      if (!Array.isArray(data.nodes)) data.nodes = [];
      if (!Array.isArray(data.edges)) data.edges = [];
      return data;
    } catch {
      return null;
    }
  }

  serializeCanvasData(data: any): string {
    const safe =
      data && typeof data === "object" ? data : { nodes: [], edges: [] };
    if (!Array.isArray(safe.nodes)) safe.nodes = [];
    if (!Array.isArray(safe.edges)) safe.edges = [];
    return JSON.stringify(safe, null, 2);
  }

  async moveTagNotesToFolder(oldPathRaw: string, newPathRaw: string): Promise<void> {
    void oldPathRaw;
    void newPathRaw;
  }

  scheduleTagNoteSync(): void {
    // Disabled by design.
  }

  async syncTagNotes(): Promise<void> {
    // Disabled by design.
  }

  async normalizeTagsAcrossVault(): Promise<void> {
    const { Notice } = require("obsidian");
    const files = this.app.vault.getMarkdownFiles();
    let frontmatterUpdated = 0;
    let inlineUpdated = 0;

    new Notice(`Normalizing tags across ${files.length} files...`);

    for (const file of files) {
      let fmModified = false;
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        if (!fm.tags) return;
        const rawTokens = (Array.isArray(fm.tags) ? fm.tags : [fm.tags])
          .flatMap((value: any) => String(value).split(/[\s,]+/))
          .filter(Boolean);
        const normalized = rawTokens
          .map((value: any) => this.normalizeTag(String(value)))
          .filter(Boolean);
        const unique = Array.from(new Set(normalized));
        const same =
          rawTokens.length === unique.length &&
          rawTokens.every(
            (value: any, index: number) =>
              this.normalizeTag(String(value)) === unique[index]
          );
        if (!same) fmModified = true;
        if (unique.length > 0) {
          fm.tags = unique;
        } else {
          delete fm.tags;
        }
      });
      if (fmModified) frontmatterUpdated++;

      const content = await this.app.vault.read(file);
      const normalizedContent = content.replace(
        /(^|[^\w/])#+([\w/-]+)/g,
        (_match, prefix, tag) => `${prefix}#${this.normalizeTag(tag)}`
      );
      if (normalizedContent !== content) {
        await this.app.vault.modify(file, normalizedContent);
        inlineUpdated++;
      }
    }

    this.primeFileTagCache();
    new Notice(
      `Tag normalization complete. Frontmatter updated: ${frontmatterUpdated}, inline updated: ${inlineUpdated}`
    );
  }

  async openTagCanvasForTag(tag: string): Promise<boolean> {
    void tag;
    return false;
  }

  destroy(): void {
    this.fileTagCache.clear();
  }
}
