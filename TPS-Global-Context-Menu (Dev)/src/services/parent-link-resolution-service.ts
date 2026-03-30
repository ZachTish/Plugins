import { TFile, normalizePath } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import { buildParentLinkValue, resolveLinkValueToFile } from '../handlers/parent-link-format';
import type { ParentLinkKind, ResolvedParentLink } from './subitem-types';

export class ParentLinkResolutionService {
  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  getParentKey(): string {
    return String(this.plugin.settings.parentLinkFrontmatterKey || 'childOf').trim() || 'childOf';
  }

  getParentKind(file: TFile): ParentLinkKind {
    const ext = String(file.extension || '').trim().toLowerCase();
    if (ext === 'md') return 'markdown-parent';
    if (ext === 'base') return 'base-parent';
    return 'other-parent';
  }

  getAllFileTargets(): TFile[] {
    return this.plugin.app.vault.getAllLoadedFiles().filter((file): file is TFile => file instanceof TFile);
  }

  getParentsForChild(childFile: TFile): ResolvedParentLink[] {
    const frontmatter = (this.plugin.app.metadataCache.getFileCache(childFile)?.frontmatter || {}) as Record<string, unknown>;
    const key = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === this.getParentKey().toLowerCase());
    const raw = key ? frontmatter[key] : undefined;
    const results = new Map<string, ResolvedParentLink>();
    for (const file of this.resolveFilesFromFrontmatterValue(raw, childFile.path)) {
      if (file.path === childFile.path) continue;
      results.set(file.path, {
        file,
        kind: this.getParentKind(file),
        source: 'child-frontmatter',
      });
    }
    return Array.from(results.values());
  }

  hasParent(childFile: TFile, parentFile: TFile): boolean {
    return this.getParentsForChild(childFile).some((entry) => entry.file.path === parentFile.path);
  }

  async addParentToChild(childFile: TFile, parentFile: TFile): Promise<boolean> {
    const key = this.getParentKey();
    const format = this.normalizeParentLinkFormat();
    const linkValue = buildParentLinkValue(this.plugin.app, parentFile, childFile.path, format);
    let changed = false;

    await this.plugin.app.fileManager.processFrontMatter(childFile, (fm) => {
      const existingKey = Object.keys(fm).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      const raw = existingKey ? (fm as Record<string, unknown>)[existingKey] : undefined;
      const values = this.normalizeFrontmatterValues(raw);
      const existingFiles = this.resolveFilesFromFrontmatterValue(values, childFile.path);
      if (existingFiles.some((file) => file.path === parentFile.path)) return;

      values.push(linkValue);
      const deduped = this.dedupeValuesForSource(values, childFile.path);
      this.setCaseInsensitive(fm as Record<string, unknown>, key, deduped.length === 1 ? deduped[0] : deduped);
      changed = true;
    });

    return changed;
  }

  async removeParentFromChild(childFile: TFile, parentFile: TFile): Promise<boolean> {
    const key = this.getParentKey();
    let changed = false;

    await this.plugin.app.fileManager.processFrontMatter(childFile, (fm) => {
      const existingKey = Object.keys(fm).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      if (!existingKey) return;
      const raw = (fm as Record<string, unknown>)[existingKey];
      const values = this.normalizeFrontmatterValues(raw);
      const filtered = values.filter((value) => !this.valueMatchesFile(value, childFile.path, parentFile));
      if (filtered.length === values.length) return;
      changed = true;
      if (filtered.length === 0) {
        delete (fm as Record<string, unknown>)[existingKey];
      } else if (filtered.length === 1) {
        (fm as Record<string, unknown>)[existingKey] = filtered[0];
      } else {
        (fm as Record<string, unknown>)[existingKey] = filtered;
      }
    });

    return changed;
  }

  resolveFilesFromFrontmatterValue(value: unknown, sourcePath: string): TFile[] {
    const values = this.normalizeFrontmatterValues(value);
    const files = new Map<string, TFile>();
    for (const raw of values) {
      const resolved = resolveLinkValueToFile(this.plugin.app, raw, sourcePath);
      if (resolved instanceof TFile) {
        files.set(resolved.path, resolved);
      }
    }
    return Array.from(files.values());
  }

  private normalizeFrontmatterValues(value: unknown): string[] {
    const output: string[] = [];
    const visit = (current: unknown): void => {
      if (current == null) return;
      if (Array.isArray(current)) {
        current.forEach(visit);
        return;
      }
      if (typeof current === 'object') {
        Object.values(current as Record<string, unknown>).forEach(visit);
        return;
      }
      const raw = String(current || '').trim();
      if (raw) output.push(raw);
    };
    visit(value);
    return output;
  }

  private dedupeValuesForSource(values: string[], sourcePath: string): string[] {
    const exactSeen = new Set<string>();
    const fileSeen = new Set<string>();
    const deduped: string[] = [];
    for (const value of values) {
      const trimmed = String(value || '').trim();
      if (!trimmed) continue;
      const exactKey = trimmed.toLowerCase();
      const resolved = resolveLinkValueToFile(this.plugin.app, trimmed, sourcePath);
      if (resolved instanceof TFile) {
        const pathKey = normalizePath(resolved.path).toLowerCase();
        if (fileSeen.has(pathKey)) continue;
        fileSeen.add(pathKey);
      } else if (exactSeen.has(exactKey)) {
        continue;
      }
      exactSeen.add(exactKey);
      deduped.push(trimmed);
    }
    return deduped;
  }

  private valueMatchesFile(value: string, sourcePath: string, targetFile: TFile): boolean {
    const resolved = resolveLinkValueToFile(this.plugin.app, value, sourcePath);
    if (resolved instanceof TFile) {
      return normalizePath(resolved.path) === normalizePath(targetFile.path);
    }
    return normalizePath(String(value || '')) === normalizePath(targetFile.path);
  }

  private setCaseInsensitive(frontmatter: Record<string, unknown>, key: string, value: unknown): void {
    const existingKey = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (existingKey && existingKey !== key) delete frontmatter[existingKey];
    frontmatter[key] = value;
  }

  private normalizeParentLinkFormat(): 'wikilink' | 'markdown-title' {
    return this.plugin.settings.parentLinkFormat === 'markdown-title' ? 'markdown-title' : 'wikilink';
  }
}

