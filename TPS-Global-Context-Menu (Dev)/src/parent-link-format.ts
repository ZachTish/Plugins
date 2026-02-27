import { App, TFile, normalizePath } from 'obsidian';
import type { ParentLinkFormat } from './types';

export function normalizeParentLinkFormat(value: unknown): ParentLinkFormat {
  return value === 'markdown-title' ? 'markdown-title' : 'wikilink';
}

export function buildParentLinkValue(
  app: App,
  targetFile: TFile,
  sourcePath: string,
  format: ParentLinkFormat,
): string {
  const normalizedFormat = normalizeParentLinkFormat(format);
  const displayName = resolveDisplayNameForTarget(app, targetFile);
  const target = resolveLinkTargetForSource(app, targetFile, sourcePath);

  if (normalizedFormat === 'wikilink') {
    return `[[${target}|${displayName}]]`;
  }

  return `[${displayName}](${encodeLinkTarget(target)})`;
}

export function resolveLinkValueToFile(app: App, value: any, sourcePath: string): TFile | null {
  const target = extractLinkTarget(value);
  if (!target) return null;

  const withNoMd = target.replace(/\.md$/i, '');
  const viaCache =
    app.metadataCache.getFirstLinkpathDest(target, sourcePath) ||
    app.metadataCache.getFirstLinkpathDest(withNoMd, sourcePath);
  if (viaCache instanceof TFile) return viaCache;

  const normalized = normalizePath(target);
  const direct = app.vault.getAbstractFileByPath(normalized);
  if (direct instanceof TFile) return direct;

  const withMd = normalized.endsWith('.md') ? normalized : `${normalized}.md`;
  const directMd = app.vault.getAbstractFileByPath(withMd);
  if (directMd instanceof TFile) return directMd;

  return null;
}

export function linkValueMatchesFile(app: App, value: any, sourcePath: string, target: TFile): boolean {
  const resolved = resolveLinkValueToFile(app, value, sourcePath);
  if (resolved) return resolved.path === target.path;

  const targetBase = extractLinkTargetBasename(value);
  if (!targetBase) return false;
  return targetBase.toLowerCase() === target.basename.toLowerCase();
}

export function extractLinkTargetBasename(value: any): string | null {
  const target = extractLinkTarget(value);
  if (!target) return null;
  const normalized = normalizePath(target);
  const segment = normalized.split('/').pop() || normalized;
  const basename = segment.replace(/\.md$/i, '').trim();
  return basename || null;
}

export function extractLinkTarget(value: any): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const markdownMatch = raw.match(/^!?\[[^\]]*]\(([^)]+)\)$/);
  if (markdownMatch) {
    return normalizeLinkTarget(markdownMatch[1]);
  }

  const wikiMatch = raw.match(/^!?\[\[([^[\]]+)]]$/);
  if (wikiMatch) {
    return normalizeLinkTarget(wikiMatch[1]);
  }

  return normalizeLinkTarget(raw);
}

function normalizeLinkTarget(rawTarget: string): string | null {
  let target = String(rawTarget || '').trim();
  if (!target) return null;

  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  }

  if (target.includes('|')) {
    target = target.split('|')[0].trim();
  }

  if (target.includes('#')) {
    target = target.split('#')[0].trim();
  }

  if (!target) return null;

  target = target.replace(/^\.\/+/, '').trim();
  if (!target) return null;

  try {
    target = decodeURI(target);
  } catch {
    // Keep original if decode fails
  }

  return target || null;
}

function resolveDisplayNameForTarget(app: App, targetFile: TFile): string {
  const cache = app.metadataCache.getFileCache(targetFile);
  const frontmatter = (cache?.frontmatter || {}) as Record<string, any>;
  const titleKey = Object.keys(frontmatter).find((key) => key.toLowerCase() === 'title');
  const rawTitle = titleKey ? frontmatter[titleKey] : undefined;
  const preferred = typeof rawTitle === 'string' && rawTitle.trim()
    ? rawTitle.trim()
    : targetFile.basename;
  const cleaned = preferred
    .replace(/\r?\n/g, ' ')
    .replace(/[|[\]]/g, '')
    .trim();
  return cleaned || targetFile.basename;
}

function resolveLinkTargetForSource(app: App, targetFile: TFile, sourcePath: string): string {
  const generated = app.fileManager.generateMarkdownLink(
    targetFile,
    sourcePath,
    undefined,
    targetFile.basename,
  );
  const candidate = extractLinkTarget(generated)
    ?? app.metadataCache.fileToLinktext(targetFile, sourcePath, true)
    ?? targetFile.path;
  return normalizeLinkTarget(candidate) ?? normalizeLinkTarget(targetFile.path) ?? targetFile.path;
}

function encodeLinkTarget(target: string): string {
  const trimmed = String(target || '').trim();
  if (!trimmed) return trimmed;

  let decoded = trimmed;
  try {
    decoded = decodeURI(trimmed);
  } catch {
    decoded = trimmed;
  }

  return encodeURI(decoded);
}
