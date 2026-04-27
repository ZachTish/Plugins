import { TFile, type App } from 'obsidian';

export function getFileDisplayTitle(app: App, file: TFile): string {
  const frontmatter = (app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, unknown>;
  const titleKey = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === 'title');
  const title = typeof (titleKey ? frontmatter[titleKey] : undefined) === 'string'
    ? String(frontmatter[titleKey]).trim()
    : '';
  return title || file.basename;
}
