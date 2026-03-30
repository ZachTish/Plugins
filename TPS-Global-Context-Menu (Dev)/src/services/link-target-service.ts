import { App, TFile, normalizePath } from 'obsidian';

export function parseLinksFromFrontmatterValue(app: App, value: unknown, sourcePath: string): TFile[] {
  const output = new Map<string, TFile>();
  const visitedObjects = new Set<unknown>();

  const consume = (candidate: unknown) => {
    if (candidate === null || candidate === undefined) return;
    if (Array.isArray(candidate)) {
      if (visitedObjects.has(candidate)) return;
      visitedObjects.add(candidate);
      candidate.forEach((entry) => consume(entry));
      return;
    }

    if (typeof candidate === 'object') {
      if (visitedObjects.has(candidate)) return;
      visitedObjects.add(candidate);
      Object.values(candidate).forEach((entry) => consume(entry));
      return;
    }

    if (typeof candidate === 'string') {
      const targets = extractLinkTargetsFromText(candidate, true);
      targets.forEach((target) => {
        const resolved = resolveLinkTargetToFile(app, target, sourcePath);
        if (resolved) output.set(resolved.path, resolved);
      });
      return;
    }

    if (typeof candidate === 'number' || typeof candidate === 'boolean') {
      const resolved = resolveLinkTargetToFile(app, String(candidate), sourcePath);
      if (resolved) output.set(resolved.path, resolved);
    }
  };

  consume(value);
  return Array.from(output.values());
}

export function extractLinkTargetsFromText(rawText: string, allowBareValue: boolean = false): string[] {
  const text = String(rawText || '').trim();
  if (!text) return [];

  const targets: string[] = [];
  const seen = new Set<string>();
  const push = (rawTarget: string) => {
    const normalized = normalizeLinkTarget(rawTarget);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(normalized);
  };

  let matchedStructuredLink = false;

  const wikiPattern = /!?\[\[([^[\]]+)\]\]/g;
  let wikiMatch: RegExpExecArray | null = null;
  while ((wikiMatch = wikiPattern.exec(text)) !== null) {
    matchedStructuredLink = true;
    push(wikiMatch[1]);
  }

  const markdownPattern = /!?\[[^\]]*]\(([^)]+)\)/g;
  let markdownMatch: RegExpExecArray | null = null;
  while ((markdownMatch = markdownPattern.exec(text)) !== null) {
    matchedStructuredLink = true;
    push(markdownMatch[1]);
  }

  if (allowBareValue && !matchedStructuredLink) {
    text.split(/[\n,;]/).forEach((chunk) => push(chunk));
  }

  return targets;
}

export function normalizeLinkTarget(rawTarget: string): string {
  let target = String(rawTarget || '').trim();
  if (!target) return '';

  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  }

  target = target.replace(/^!/, '').trim();
  target = target.replace(/^['"]|['"]$/g, '').trim();

  const pipeIndex = target.indexOf('|');
  if (pipeIndex >= 0) {
    target = target.slice(0, pipeIndex).trim();
  }

  const hashIndex = target.indexOf('#');
  if (hashIndex >= 0) {
    target = target.slice(0, hashIndex).trim();
  }

  if (!target) return '';

  try {
    target = decodeURIComponent(target);
  } catch {
    // Keep raw target when it is not URI encoded.
  }

  return target;
}

export function resolveLinkTargetToFile(app: App, rawTarget: string, sourcePath: string): TFile | null {
  const target = normalizeLinkTarget(rawTarget);
  if (!target || isLikelyExternalLink(target)) return null;

  const resolved = app.metadataCache.getFirstLinkpathDest(target, sourcePath);
  if (resolved instanceof TFile) return resolved;

  const normalized = normalizePath(target.replace(/^\/+/, ''));
  const direct = app.vault.getAbstractFileByPath(normalized);
  if (direct instanceof TFile) return direct;

  if (!/\.[a-z0-9]+$/i.test(normalized)) {
    const withMd = app.vault.getAbstractFileByPath(`${normalized}.md`);
    if (withMd instanceof TFile) return withMd;
  }

  return null;
}

export function isLikelyExternalLink(value: string): boolean {
  return /^(https?:|mailto:|tel:|file:|data:)/i.test(String(value || '').trim());
}
