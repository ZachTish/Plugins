import { App, Notice, TFile, TFolder, normalizePath } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import { buildBaseCompatibleParentLinkValue } from '../handlers/parent-link-format';
import { CreateSubitemModal } from '../modals/create-subitem-modal';
import { mergeNormalizedTags, parseTagInput } from '../utils/tag-utils';
import { applyRulesToFile as applyRulesToFileShared } from '../utils/rule-resolver';
import * as logger from '../logger';
import { getDailyNoteResolver } from '../../../TPS-Controller (Dev)/src/utils/daily-note-resolver';
import { generateSubitemId, getSubitemIdFromRecord, SUBITEM_ID_KEY } from '../utils/subitem-id';

export interface CreateSubitemOptions {
  seedDefaults?: boolean;
  seedParentTags?: boolean;
  seedVisualMetadata?: boolean;
  insertParentBodyLink?: boolean;
  initialFrontmatter?: Record<string, unknown>;
  preferScheduledParentForDailyNote?: boolean;
}

export async function promptAndCreateSubitemForParent(
  plugin: TPSGlobalContextMenuPlugin,
  parentFile: TFile,
  options?: CreateSubitemOptions,
): Promise<TFile | null> {
  if (parentFile.extension?.toLowerCase() !== 'md') {
    new Notice('Subitems can only be created under markdown notes.');
    return null;
  }

  const defaultFolderPath = getDefaultSubitemFolderPath(plugin, parentFile);
  const selection = await new Promise<{ title: string; folderPath: string } | null>((resolve) => {
    const modal = new CreateSubitemModal(plugin.app, getFolderPathOptions(plugin.app), defaultFolderPath, resolve);
    modal.open();
  });

  if (!selection) return null;
  return createSubitemForParentWithTitle(plugin, parentFile, selection.title, selection.folderPath, options);
}

export async function createSubitemForParentWithTitle(
  plugin: TPSGlobalContextMenuPlugin,
  parentFile: TFile,
  title: string,
  folderPathSelection?: string,
  options?: CreateSubitemOptions,
): Promise<TFile | null> {
  const cleanedTitle = sanitizeSubitemTitle(title);
  if (!cleanedTitle) {
    new Notice('Subitem title cannot be empty.');
    return null;
  }
  if (isMalformedSubitemTitle(cleanedTitle)) {
    new Notice('Subitem title looks malformed. Repair the parent checklist line first.');
    return null;
  }

  const folderInput = String(folderPathSelection ?? getDefaultSubitemFolderPath(plugin, parentFile) ?? '/').trim() || '/';
  const folderPath = folderInput === '/' ? '' : normalizePath(folderInput);
  if (folderPath) {
    await ensureFolderPath(plugin.app, folderPath);
  }

  const targetPath = getUniqueMarkdownPath(plugin.app, folderPath, cleanedTitle);
  const escapedTitle = cleanedTitle.replace(/"/g, '\\"');
  const parentLinkKey = plugin.parentLinkResolutionService.getParentKey();
  const parentLinkValue = buildBaseCompatibleParentLinkValue(
    plugin.app,
    parentFile,
    targetPath,
  ).replace(/"/g, '\\"');
  const seedDefaults = options?.seedDefaults ?? true;
  const initialFrontmatter = options?.initialFrontmatter || {};
  if (!getSubitemIdFromRecord(initialFrontmatter)) {
    initialFrontmatter[SUBITEM_ID_KEY] = generateSubitemId();
  }
  // Default to no parent-tag inheritance. This is safer, matches TaskNotes-style
  // conversion behavior, and avoids accidental propagation of context tags such
  // as `dailynote` onto child notes.
  const seedParentTags = options?.seedParentTags ?? false;
  const seedVisualMetadata = options?.seedVisualMetadata ?? plugin.settings.seedNewSubitemVisualMetadata;
  const defaultStatus = seedDefaults
    ? String(plugin.settings.defaultNewSubitemStatus || '').trim().replace(/"/g, '\\"')
    : '';
  const defaultPriority = seedDefaults
    ? String(plugin.settings.defaultNewSubitemPriority || '').trim().replace(/"/g, '\\"')
    : '';

  let isDailyNoteParent = false;
  let dailyNoteDateStr = '';
  if (plugin.fileNamingService.isDateOnlyBasename(parentFile.basename)) {
      isDailyNoteParent = true;
      dailyNoteDateStr = getDailyNoteResolver(plugin.app, {
          formatOverride: (plugin as any)?.settings?.dailyNoteDateFormat,
      }).parseFilenameToDateKey(parentFile.basename) || '';
  }
  const preferScheduledParentForDailyNote = !!options?.preferScheduledParentForDailyNote;
  const useScheduledParentForDailyNote = preferScheduledParentForDailyNote && isDailyNoteParent && !!dailyNoteDateStr;

  const frontmatterLines = [
    '---',
    `title: "${escapedTitle}"`,
  ];
  if (!useScheduledParentForDailyNote) {
    frontmatterLines.push(`${parentLinkKey}: "${parentLinkValue}"`);
  }
  if (isDailyNoteParent && dailyNoteDateStr && !hasFrontmatterKeyCI(initialFrontmatter, 'scheduled')) {
      frontmatterLines.push(`scheduled: "${dailyNoteDateStr}"`);
      // When scheduled is explicitly set to today/daily note date,
      // we don't necessarily need to add default status to avoid duplication,
      // but let's keep the user's defaults working:
  }
  if (defaultStatus && !hasFrontmatterKeyCI(initialFrontmatter, 'status')) {
    frontmatterLines.push(`status: "${defaultStatus}"`);
  }
  if (defaultPriority && !hasFrontmatterKeyCI(initialFrontmatter, 'priority')) {
    frontmatterLines.push(`priority: "${defaultPriority}"`);
  }
  if (plugin.settings.autoSaveFolderPath) {
    frontmatterLines.push(`folderPath: "${(folderPath || '/').replace(/"/g, '\\"')}"`);
  }
  if (seedVisualMetadata) {
    const iconDefaults = resolveNewSubitemIconDefaults(plugin.app, parentFile, folderPath);
    if (iconDefaults.icon) {
      frontmatterLines.push(`icon: "${iconDefaults.icon.replace(/"/g, '\\"')}"`);
    }
    if (iconDefaults.iconColor) {
      const escapedColor = iconDefaults.iconColor.replace(/"/g, '\\"');
      frontmatterLines.push(`iconColor: "${escapedColor}"`);
      // Use color as an alias for iconColor to support both fields
      frontmatterLines.push(`color: "${escapedColor}"`);
    }
  }

  const parentCache = plugin.app.metadataCache.getFileCache(parentFile);
  const parentFrontmatter = (parentCache?.frontmatter || {}) as Record<string, any>;
  
  // DIAGNOSTIC: Log frontmatter state BEFORE adding inherited lines
  const beforeInheritedKeys = new Set(
    frontmatterLines
      .map((line) => line.split(':')[0]?.trim().toLowerCase())
      .filter((key): key is string => Boolean(key)),
  );
  const initialLines = collectExplicitFrontmatterLines(initialFrontmatter, beforeInheritedKeys);
  frontmatterLines.push(...initialLines);
  for (const line of initialLines) {
    const key = line.split(':')[0]?.trim().toLowerCase();
    if (key) beforeInheritedKeys.add(key);
  }
  const inheritedLines = collectInheritedParentFrontmatterLines(parentFrontmatter, beforeInheritedKeys);
  logger.log('[TPS GCM] [DIAG] createSubitem frontmatter BEFORE inherited:', {
    title: cleanedTitle,
    lineCount: frontmatterLines.length,
    keysSoFar: Array.from(beforeInheritedKeys),
    inheritedLines,
    inheritedLineCount: inheritedLines.length,
    parentFrontmatterKeys: Object.keys(parentFrontmatter),
  });
  frontmatterLines.push(...inheritedLines);
  const parentTags = seedParentTags
    ? filterIgnoredSubitemTags(plugin, parseTagInput([parentFrontmatter.tags, parentFrontmatter.tag]))
    : [];
  if (seedParentTags && parentTags.length > 0) {
    const serializedTags = parentTags.map((tag) => `"${tag.replace(/"/g, '\\"')}"`).join(', ');
    frontmatterLines.push(`tags: [${serializedTags}]`);
  }

  const generatedFrontmatterContent = [...frontmatterLines, '---'].join('\n');
  const generatedFrontmatterKeys = frontmatterLines
    .filter((line) => line !== '---' && line.includes(':'))
    .map((line) => line.split(':')[0]?.trim())
    .filter((key): key is string => Boolean(key));
  const duplicateGeneratedFrontmatterKeys = Array.from(
    generatedFrontmatterKeys.reduce((acc, key) => {
      acc.set(key, (acc.get(key) || 0) + 1);
      return acc;
    }, new Map<string, number>()).entries(),
  )
    .filter(([, count]) => count > 1)
    .map(([key, count]) => ({ key, count }));

  logger.log('[TPS GCM] [DIAG] createSubitem generated frontmatter', {
    title: cleanedTitle,
    parentFile: parentFile.path,
    targetPath,
    isDailyNoteParent,
    dailyNoteDateStr,
    seedDefaults,
    seedParentTags,
    seedVisualMetadata,
    generatedFrontmatterKeys,
    duplicateGeneratedFrontmatterKeys,
    generatedFrontmatterContent,
  });

  frontmatterLines.push('---', '');
  const initialContent = `${frontmatterLines.join('\n')}\n`;

  let created: TFile;
  try {
    created = await plugin.app.vault.create(targetPath, initialContent);
  } catch (error) {
    logger.error('[TPS GCM] Failed creating subitem:', error);
    new Notice('Failed to create subitem.');
    return null;
  }

  try {
    const hasStatus = frontmatterLines.some((l) => l.trim().toLowerCase().startsWith('status:'));
    if (options?.insertParentBodyLink !== false) {
      await plugin.subitemRelationshipSyncService.insertBodyLink(parentFile, created, hasStatus ? '[ ]' : null);
    }
  } catch (error) {
    logger.error('[TPS GCM] Failed linking new subitem to parent:', error);
    new Notice('Created subitem, but failed to link to parent.');
  }

  if (plugin.settings.applyCompanionRulesOnSubitemCreate) {
    await applyRulesToNewFile(plugin, created);
  }

  if (seedParentTags && parentTags.length > 0) {
    await mergeParentTagsIntoSubitem(plugin, created, parentTags);
  }

  if (!useScheduledParentForDailyNote) {
    await plugin.parentLinkResolutionService.addParentToChild(created, parentFile);
  }

  new Notice(`Created subitem: ${created.basename}`);
  return created;
}

export function getDefaultSubitemFolderPath(plugin: TPSGlobalContextMenuPlugin, parentFile: TFile): string {
  return plugin.settings.defaultSubitemsPath || parentFile.parent?.path || '/';
}

export function getFolderPathOptions(app: App): string[] {
  const paths = new Set<string>(['/']);
  const folders = app.vault.getAllLoadedFiles().filter((item): item is TFolder => item instanceof TFolder);
  folders.forEach((folder) => paths.add(folder.path || '/'));
  return Array.from(paths.values()).sort((a, b) => {
    if (a === '/') return -1;
    if (b === '/') return 1;
    return a.localeCompare(b);
  });
}

export function sanitizeSubitemTitle(rawTitle: string): string {
  return String(rawTitle || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMalformedSubitemTitle(title: string): boolean {
  const normalized = String(title || '').trim();
  if (!normalized) return false;
  return /^\[\[+$/.test(normalized);
}

export function getUniqueMarkdownPath(app: App, folderPath: string, basename: string): string {
  const prefix = folderPath ? `${folderPath}/` : '';
  let counter = 1;
  let candidate = normalizePath(`${prefix}${basename}.md`);
  while (app.vault.getAbstractFileByPath(candidate)) {
    counter += 1;
    candidate = normalizePath(`${prefix}${basename} ${counter}.md`);
  }
  return candidate;
}

async function ensureFolderPath(app: App, path: string): Promise<void> {
  const clean = normalizePath(path).trim();
  if (!clean) return;
  const segments = clean.split('/').filter(Boolean);
  let current = '';
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

export async function applyRulesToNewFile(plugin: TPSGlobalContextMenuPlugin, file: TFile): Promise<void> {
  await applyRulesToFileShared(plugin.app, file, 'gcm-subitem-create');
}

async function mergeParentTagsIntoSubitem(plugin: TPSGlobalContextMenuPlugin, file: TFile, parentTags: string[]): Promise<void> {
  if (parentTags.length === 0) return;

  await new Promise((resolve) => setTimeout(resolve, 100));

  try {
    const app = plugin.app;
    const cache = app.metadataCache.getFileCache(file);
    const currentFrontmatter = (cache?.frontmatter || {}) as Record<string, any>;
    const currentTags = parseTagInput([currentFrontmatter.tags, currentFrontmatter.tag]);
    const mergedTags = mergeNormalizedTags(parentTags, currentTags);
    const currentTagsStr = JSON.stringify([...currentTags].sort());
    const mergedTagsStr = JSON.stringify([...mergedTags].sort());

    if (currentTagsStr !== mergedTagsStr) {
      await plugin.frontmatterMutationService.process(file, (fm) => {
        setFrontmatterValueCaseInsensitive(fm as Record<string, any>, 'tags', mergedTags);
      });
    }
  } catch (error) {
    logger.warn('[TPS GCM] Failed merging parent tags into subitem:', file.path, error);
  }
}

function resolveNewSubitemIconDefaults(app: App, parentFile: TFile, folderPath: string): { icon: string; iconColor: string } {
  const fromParent = resolveIconDefaultsFromFile(app, parentFile);
  const fromFolder = resolveIconDefaultsFromFolder(app, folderPath);
  return {
    icon: fromParent.icon || fromFolder.icon,
    iconColor: fromParent.iconColor || fromFolder.iconColor,
  };
}

function resolveIconDefaultsFromFile(app: App, file: TFile): { icon: string; iconColor: string } {
  const cache = app.metadataCache.getFileCache(file);
  const fm = (cache?.frontmatter || {}) as Record<string, any>;
  const icon = readFrontmatterStringCaseInsensitive(fm, ['icon']);
  const iconColor = readFrontmatterStringCaseInsensitive(fm, ['iconColor', 'color', 'accentColor', 'accent']);
  return { icon, iconColor };
}

function resolveIconDefaultsFromFolder(app: App, folderPath: string): { icon: string; iconColor: string } {
  const normalizedFolder = normalizePath((folderPath || '').trim());
  const folderFiles = app.vault.getMarkdownFiles().filter((file) => (file.parent?.path || '') === normalizedFolder);
  const iconCounts = new Map<string, number>();
  const colorCounts = new Map<string, number>();

  for (const file of folderFiles) {
    const { icon, iconColor } = resolveIconDefaultsFromFile(app, file);
    if (icon) iconCounts.set(icon, (iconCounts.get(icon) || 0) + 1);
    if (iconColor) colorCounts.set(iconColor, (colorCounts.get(iconColor) || 0) + 1);
  }

  const pickMostCommon = (counts: Map<string, number>): string => {
    let best = '';
    let bestCount = -1;
    for (const [value, count] of counts.entries()) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  };

  return {
    icon: pickMostCommon(iconCounts),
    iconColor: pickMostCommon(colorCounts),
  };
}

function readFrontmatterStringCaseInsensitive(frontmatter: Record<string, any> | null | undefined, keys: string[]): string {
  if (!frontmatter || typeof frontmatter !== 'object') return '';
  for (const key of keys) {
    const value = getFrontmatterValueCaseInsensitive(frontmatter, key);
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}

function getFrontmatterValueCaseInsensitive(frontmatter: Record<string, any> | null | undefined, key: string): any {
  if (!frontmatter || !key) return undefined;
  if (key in frontmatter) return frontmatter[key];
  const lowerKey = key.toLowerCase();
  const match = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === lowerKey);
  return match ? frontmatter[match] : undefined;
}

function setFrontmatterValueCaseInsensitive(frontmatter: Record<string, any>, key: string, value: any): void {
  if (!frontmatter || typeof frontmatter !== 'object') return;
  if (key in frontmatter) {
    frontmatter[key] = value;
    return;
  }
  const lowerKey = key.toLowerCase();
  const existingKey = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === lowerKey);
  frontmatter[existingKey ?? key] = value;
}

function filterIgnoredSubitemTags(plugin: TPSGlobalContextMenuPlugin, tags: string[]): string[] {
  const ignored = new Set(
    (plugin.settings.ignoredSubitemTags || [])
      .map((tag) => String(tag || '').trim().replace(/^#/, '').toLowerCase())
      .filter(Boolean),
  );
  if (ignored.size === 0) return tags;
  return tags.filter((tag) => !ignored.has(String(tag || '').trim().replace(/^#/, '').toLowerCase()));
}

function collectInheritedParentFrontmatterLines(
  frontmatter: Record<string, any> | null | undefined,
  existingKeys: Iterable<string> = [],
): string[] {
  if (!frontmatter || typeof frontmatter !== 'object') return [];
  const inheritedKeys = ['scheduled', 'due', 'date', 'start', 'end', 'allDay'];
  const lines: string[] = [];
  const seen = new Set(
    Array.from(existingKeys)
      .map((key) => String(key || '').trim().toLowerCase())
      .filter(Boolean),
  );
  for (const key of inheritedKeys) {
    const normalizedKey = key.toLowerCase();
    if (seen.has(normalizedKey)) continue;
    const value = getFrontmatterValueCaseInsensitive(frontmatter, key);
    const serialized = serializeSimpleYamlValue(value);
    if (!serialized) continue;
    lines.push(`${key}: ${serialized}`);
    seen.add(normalizedKey);
  }
  logger.log('[TPS GCM] [DIAG] collectInheritedParentFrontmatterLines result', {
    inheritedKeys,
    existingKeys: Array.from(seen.values()),
    parentFrontmatterKeys: Object.keys(frontmatter),
    lines,
  });
  return lines;
}

function collectExplicitFrontmatterLines(
  frontmatter: Record<string, unknown> | null | undefined,
  existingKeys: Iterable<string> = [],
): string[] {
  if (!frontmatter || typeof frontmatter !== 'object') return [];
  const lines: string[] = [];
  const seen = new Set(
    Array.from(existingKeys)
      .map((key) => String(key || '').trim().toLowerCase())
      .filter(Boolean),
  );

  for (const [rawKey, value] of Object.entries(frontmatter)) {
    const key = String(rawKey || '').trim();
    const normalizedKey = key.toLowerCase();
    if (!key || seen.has(normalizedKey) || normalizedKey === 'title') continue;
    const serialized = serializeSimpleYamlValue(value);
    if (!serialized) continue;
    lines.push(`${key}: ${serialized}`);
    seen.add(normalizedKey);
  }
  return lines;
}

function hasFrontmatterKeyCI(frontmatter: Record<string, unknown> | null | undefined, key: string): boolean {
  if (!frontmatter || typeof frontmatter !== 'object') return false;
  const normalized = String(key || '').trim().toLowerCase();
  if (!normalized) return false;
  return Object.keys(frontmatter).some((candidate) => String(candidate || '').trim().toLowerCase() === normalized);
}

function serializeSimpleYamlValue(value: any): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    return `"${trimmed.replace(/"/g, '\\"')}"`;
  }
  return '';
}
