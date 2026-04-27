import { App, TFile, normalizePath } from 'obsidian';
import TPSGlobalContextMenuPlugin from '../main';
import { mergeNormalizedTags, parseTagInput } from '../utils/tag-utils';

type AddParentLinkInput = {
  childFile: TFile;
  parentKey: string;
  parentLink: string;
};

type AddChildLinkInput = {
  parentFile: TFile;
  childKey: string;
  childLink: string;
  childFile: TFile;
  tagsToAdd?: string[];
};

type RemoveBidirectionalLinkInput = {
  childFile: TFile;
  parentFile: TFile;
  parentKey: string;
  childKey: string;
};

type RemoveDetachedChildLinkInput = {
  parentFile: TFile;
  childKey: string;
  childBasename: string;
};

export class ParentChildMutationService {
  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  async addParentLink(input: AddParentLinkInput): Promise<boolean> {
    return this.plugin.calendarNoteMutationService.applyFrontmatterMutation({
      file: input.childFile,
      folderPath: input.childFile.parent?.path || '/',
      transform: (fm) => {
        setFrontmatterValueCaseInsensitive(fm, input.parentKey, input.parentLink);
      },
    });
  }

  async addChildLink(input: AddChildLinkInput): Promise<boolean> {
    return this.plugin.calendarNoteMutationService.applyFrontmatterMutation({
      file: input.parentFile,
      folderPath: input.parentFile.parent?.path || '/',
      transform: (fm) => {
        const existingRaw = getFrontmatterValueCaseInsensitive(fm, input.childKey);
        let children: string[] = [];
        if (Array.isArray(existingRaw)) children = existingRaw.map(String);
        else if (typeof existingRaw === 'string' && existingRaw.trim()) children = [existingRaw];

        if (!children.some((existing) => linkReferencesFile(this.plugin.app, existing, input.parentFile.path, input.childFile))) {
          children.push(input.childLink);
          setFrontmatterValueCaseInsensitive(fm, input.childKey, children);
        }

        if ((input.tagsToAdd || []).length) {
          const mergedTags = mergeNormalizedTags(getFrontmatterValueCaseInsensitive(fm, 'tags'), input.tagsToAdd || []);
          const existingTags = parseTagInput(getFrontmatterValueCaseInsensitive(fm, 'tags'));
          const unchanged = existingTags.length === mergedTags.length && existingTags.every((tag, index) => tag === mergedTags[index]);
          if (!unchanged) {
            setFrontmatterValueCaseInsensitive(fm, 'tags', mergedTags);
          }
        }
      },
    });
  }

  async removeBidirectionalLink(input: RemoveBidirectionalLinkInput): Promise<void> {
    await this.plugin.calendarNoteMutationService.applyFrontmatterMutation({
      file: input.childFile,
      folderPath: input.childFile.parent?.path || '/',
      transform: (fm) => {
        deleteFrontmatterValueCaseInsensitive(fm, input.parentKey);
      },
    });

    await this.plugin.calendarNoteMutationService.applyFrontmatterMutation({
      file: input.parentFile,
      folderPath: input.parentFile.parent?.path || '/',
      transform: (fm) => {
        const existingRaw = getFrontmatterValueCaseInsensitive(fm, input.childKey);
        if (Array.isArray(existingRaw)) {
          const filtered = existingRaw.filter((link: unknown) => !linkReferencesFile(this.plugin.app, link, input.parentFile.path, input.childFile));
          if (filtered.length > 0) setFrontmatterValueCaseInsensitive(fm, input.childKey, filtered);
          else deleteFrontmatterValueCaseInsensitive(fm, input.childKey);
          return;
        }

        if (linkReferencesFile(this.plugin.app, existingRaw, input.parentFile.path, input.childFile)) {
          deleteFrontmatterValueCaseInsensitive(fm, input.childKey);
        }
      },
    });
  }

  async removeDetachedChildLink(input: RemoveDetachedChildLinkInput): Promise<boolean> {
    return this.plugin.calendarNoteMutationService.applyFrontmatterMutation({
      file: input.parentFile,
      folderPath: input.parentFile.parent?.path || '/',
      transform: (fm) => {
        const existingRaw = getFrontmatterValueCaseInsensitive(fm, input.childKey);
        if (Array.isArray(existingRaw)) {
          const filtered = existingRaw.filter((link: unknown) => {
            const linkBasename = extractLinkTargetBasename(link);
            return !linkBasename || linkBasename.toLowerCase() !== input.childBasename.toLowerCase();
          });
          if (filtered.length !== existingRaw.length) {
            if (filtered.length > 0) setFrontmatterValueCaseInsensitive(fm, input.childKey, filtered);
            else deleteFrontmatterValueCaseInsensitive(fm, input.childKey);
          }
          return;
        }

        const linkBasename = extractLinkTargetBasename(existingRaw);
        if (linkBasename && linkBasename.toLowerCase() === input.childBasename.toLowerCase()) {
          deleteFrontmatterValueCaseInsensitive(fm, input.childKey);
        }
      },
    });
  }
}

function normalizeFrontmatterKey(key: string): string {
  return String(key || '').trim().toLowerCase();
}

function findFrontmatterKeyCaseInsensitive(target: Record<string, unknown>, key: string): string | null {
  const normalized = normalizeFrontmatterKey(key);
  if (!normalized) return null;
  return Object.keys(target || {}).find((candidate) => normalizeFrontmatterKey(candidate) === normalized) || null;
}

function getFrontmatterValueCaseInsensitive(target: Record<string, unknown>, key: string): unknown {
  const existing = findFrontmatterKeyCaseInsensitive(target, key);
  return existing ? target[existing] : undefined;
}

function setFrontmatterValueCaseInsensitive(target: Record<string, unknown>, key: string, value: unknown): void {
  const existing = findFrontmatterKeyCaseInsensitive(target, key);
  if (existing) {
    target[existing] = value;
    if (existing !== key && key in target) delete target[key];
    return;
  }
  target[key] = value;
}

function deleteFrontmatterValueCaseInsensitive(target: Record<string, unknown>, key: string): void {
  const existing = findFrontmatterKeyCaseInsensitive(target, key);
  if (existing) delete target[existing];
}

function extractLinkTarget(value: unknown): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const markdownMatch = raw.match(/^!?\[[^\]]*]\(([^)]+)\)$/);
  if (markdownMatch) return normalizeLinkTarget(markdownMatch[1]);
  const wikiMatch = raw.match(/^!?\[\[([^\[\]]+)]]$/);
  if (wikiMatch) return normalizeLinkTarget(wikiMatch[1]);
  return normalizeLinkTarget(raw);
}

function normalizeLinkTarget(rawTarget: string): string | null {
  let target = String(rawTarget || '').trim();
  if (!target) return null;
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  if (target.includes('|')) target = target.split('|')[0].trim();
  if (target.includes('#')) target = target.split('#')[0].trim();
  target = target.replace(/^\.\/+/,'').trim();
  if (!target) return null;
  try { target = decodeURI(target); } catch {}
  return target || null;
}

function resolveLinkToFile(app: App, value: unknown, sourcePath: string): TFile | null {
  const target = extractLinkTarget(value);
  if (!target) return null;
  const noMd = target.replace(/\.md$/i, '');
  const viaCache = app.metadataCache.getFirstLinkpathDest(target, sourcePath) || app.metadataCache.getFirstLinkpathDest(noMd, sourcePath);
  if (viaCache instanceof TFile) return viaCache;
  const normalized = normalizePath(target);
  const direct = app.vault.getAbstractFileByPath(normalized);
  if (direct instanceof TFile) return direct;
  const withMd = normalized.endsWith('.md') ? normalized : `${normalized}.md`;
  const directMd = app.vault.getAbstractFileByPath(withMd);
  return directMd instanceof TFile ? directMd : null;
}

function linkReferencesFile(app: App, value: unknown, sourcePath: string, target: TFile): boolean {
  const resolved = resolveLinkToFile(app, value, sourcePath);
  return !!resolved && resolved.path === target.path;
}

function extractLinkTargetBasename(value: unknown): string | null {
  const target = extractLinkTarget(value);
  if (!target) return null;
  const normalized = normalizePath(target);
  const segment = normalized.split('/').pop() || normalized;
  const basename = segment.replace(/\.md$/i, '').trim();
  return basename || null;
}
