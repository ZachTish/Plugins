import { App, getAllTags, setIcon, TFile } from 'obsidian';
import TPSGlobalContextMenuPlugin from '../main';
import { resolveCustomProperties } from '../resolve-profiles';
import { ViewModeService } from '../services/view-mode-service';
import { normalizeTagValue, parseTagInput } from '../utils/tag-utils';
import {
  buildRuleContext,
  evaluateIconColorRules,
  isRuleWriteExcluded,
  isValidCssColor,
  normalizeNotebookNavigatorIconValue,
} from '../utils/rule-resolver';
import * as logger from '../logger';
import { parseLinksFromFrontmatterValue, resolveLinkTargetToFile } from '../services/link-target-service';
import type { ResolvedParentLink } from '../services/subitem-types';

export type SubitemRelationKind = 'child' | 'attachment';

export interface SubitemRelationEntry {
  file: TFile;
  relations: Set<SubitemRelationKind>;
}

const ATTACHMENTS_FRONTMATTER_KEY = 'attachments';

export class SubitemMetadataService {
  constructor(
    private readonly plugin: TPSGlobalContextMenuPlugin,
    private readonly delegates: {
      createFileEntries: (files: TFile[]) => any[];
    },
  ) {}

  private get app(): App {
    return this.plugin.app;
  }

  getFrontmatterValueCaseInsensitive(
    frontmatter: Record<string, any> | null | undefined,
    key: string
  ): any {
    if (!frontmatter || typeof frontmatter !== 'object') return undefined;
    const normalized = String(key || '').trim().toLowerCase();
    if (!normalized) return undefined;
    const match = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === normalized);
    return match ? frontmatter[match] : undefined;
  }

  setFrontmatterValueCaseInsensitive(
    frontmatter: Record<string, any>,
    key: string,
    value: any
  ): void {
    const normalized = String(key || '').trim().toLowerCase();
    if (!normalized) return;
    for (const candidate of Object.keys(frontmatter || {})) {
      if (candidate.toLowerCase() === normalized) {
        delete frontmatter[candidate];
      }
    }
    frontmatter[key] = value;
  }

  getResolvedFrontmatter(file: TFile, fallback: Record<string, any>): Record<string, any> {
    const cacheFm = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
    return { ...fallback, ...cacheFm };
  }

  buildParentToChildrenIndex(): Map<string, TFile[]> {
    const index = new Map<string, TFile[]>();

    const addToIndex = (parentPath: string, childFile: TFile) => {
      if (parentPath === childFile.path) return;
      const bucket = index.get(parentPath) || [];
      if (!bucket.some((child) => child.path === childFile.path)) {
        bucket.push(childFile);
      }
      index.set(parentPath, bucket);
    };

    for (const file of this.app.vault.getMarkdownFiles()) {
      for (const parent of this.plugin.parentLinkResolutionService.getParentsForChild(file)) {
        addToIndex(parent.file.path, file);
      }
    }

    return index;
  }

  async collectDirectSubitemRelations(
    file: TFile,
    parentIndex: Map<string, TFile[]>
  ): Promise<Map<string, SubitemRelationEntry>> {
    const map = new Map<string, SubitemRelationEntry>();

    const addRelation = (target: TFile, relation: SubitemRelationKind) => {
      if (!(target instanceof TFile)) return;
      if (target.path === file.path) return;
      const key = target.path;
      const current = map.get(key);
      if (current) {
        current.relations.add(relation);
        return;
      }
      map.set(key, { file: target, relations: new Set([relation]) });
    };

    const bodyLinkedChildren = file.extension?.toLowerCase() === 'md'
      ? await this.plugin.bodySubitemLinkService.scanFile(file)
      : [];
    if (bodyLinkedChildren.length > 0) {
      bodyLinkedChildren.forEach((entry) => addRelation(entry.childFile, 'child'));
    } else if (file.extension?.toLowerCase() === 'md') {
      const linkedChildren = parentIndex.get(file.path) || [];
      linkedChildren.forEach((child) => addRelation(child, 'child'));
    }

    const attachmentFiles = await this.resolveAttachmentFilesFromFrontmatter(file);
    attachmentFiles.forEach((attachment) => addRelation(attachment, 'attachment'));

    return map;
  }

  async resolveAttachmentFilesFromFrontmatter(file: TFile): Promise<TFile[]> {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter || {}) as Record<string, any>;
    const collected = new Map<string, TFile>();

    const frontmatterAttachments = parseLinksFromFrontmatterValue(
      this.app,
      this.getFrontmatterValueCaseInsensitive(fm, ATTACHMENTS_FRONTMATTER_KEY),
      file.path
    );
    frontmatterAttachments.forEach((attachment) => {
      if (attachment.path !== file.path) {
        collected.set(attachment.path, attachment);
      }
    });

    const inlineEmbeds = await this.resolveInlineEmbedAttachments(file);
    inlineEmbeds.forEach((attachment) => {
      if (attachment.path !== file.path) {
        collected.set(attachment.path, attachment);
      }
    });

    return Array.from(collected.values());
  }

  resolveParentsForChild(file: TFile): ResolvedParentLink[] {
    return this.plugin.parentLinkResolutionService.getParentsForChild(file);
  }

  async resolveInlineEmbedAttachments(file: TFile): Promise<TFile[]> {
    const resolved = new Map<string, TFile>();
    const pushTarget = (rawTarget: string) => {
      const targetFile = resolveLinkTargetToFile(this.app, rawTarget, file.path);
      if (!targetFile || targetFile.path === file.path) return;
      resolved.set(targetFile.path, targetFile);
    };

    const cache = this.app.metadataCache.getFileCache(file) as any;
    const embeds = Array.isArray(cache?.embeds) ? cache.embeds : [];
    embeds.forEach((embed: any) => {
      if (typeof embed?.link === 'string' && embed.link.trim()) {
        pushTarget(embed.link);
      }
    });

    if (resolved.size > 0) {
      return Array.from(resolved.values());
    }

    try {
      const raw = await this.app.vault.cachedRead(file);
      const patterns = [/!\[\[([^\]]+)\]\]/g, /!\[[^\]]*]\(([^)]+)\)/g];
      for (const pattern of patterns) {
        let match: RegExpExecArray | null = null;
        while ((match = pattern.exec(raw)) !== null) {
          const candidate = match[1];
          if (candidate) pushTarget(candidate);
        }
      }
    } catch (error) {
      logger.warn('[TPS GCM] Failed to parse inline embeds for', file.path, error);
    }

    return Array.from(resolved.values());
  }

  getTaskIdentityForFile(file: TFile) {
    const entry = this.delegates.createFileEntries([file])[0];
    const frontmatter = this.getResolvedFrontmatter(file, (entry?.frontmatter || {}) as Record<string, any>);
    const statusProperty = this.getStatusPropertyKeyForFile(file, entry);
    const statusValue = this.getFrontmatterValueCaseInsensitive(frontmatter, statusProperty);
    const identityFrontmatter = statusValue === undefined
      ? frontmatter
      : { ...frontmatter, [statusProperty]: statusValue };

    return this.plugin.taskIdentityService.identify(file, identityFrontmatter, {
      statusProperty,
      completionStatuses: this.plugin.settings.parentCompletionStatuses?.length
        ? this.plugin.settings.parentCompletionStatuses
        : undefined,
    });
  }

  getStatusPropertyKeyForFile(file: TFile, existingEntry?: any): string {
    const entry = existingEntry ?? this.delegates.createFileEntries([file])[0];
    const properties = resolveCustomProperties(this.plugin.settings.properties || [], entry ? [entry] : [], new ViewModeService());
    const statusProp = properties.find((property) => property.id === 'status' || property.key === 'status');
    return String(statusProp?.key || 'status').trim() || 'status';
  }

  createSubitemIcon(iconEl: HTMLElement, file: TFile, frontmatter: Record<string, any>): void {
    const iconValue = this.resolveFrontmatterIcon(file, frontmatter);
    const color = this.resolveFrontmatterColor(frontmatter, file);
    if (color) {
      iconEl.style.color = color;
    } else {
      iconEl.style.removeProperty('color');
    }

    if (!iconValue) {
      const rendered = this.trySetIcon(iconEl, [
        file.extension?.toLowerCase() === 'md' ? 'file-text' : 'paperclip',
        'file',
        'document',
        'circle',
      ]);
      if (!rendered) this.ensureSubitemIconVisible(iconEl);
      return;
    }

    if (/[\u2600-\u27BF\u{1F300}-\u{1FAFF}]/u.test(iconValue)) {
      iconEl.textContent = iconValue;
      iconEl.classList.add('tps-gcm-subitem-icon--emoji');
      return;
    }

    try {
      const rendered = this.trySetIcon(iconEl, [
        iconValue,
        'file-text',
        'file',
        'document',
        'circle',
      ]);
      if (!rendered) this.ensureSubitemIconVisible(iconEl);
    } catch {
      iconEl.textContent = iconValue.charAt(0).toUpperCase();
      iconEl.classList.add('tps-gcm-subitem-icon--emoji');
    }
  }

  private normalizeIconId(id: string): string {
    return normalizeNotebookNavigatorIconValue(id);
  }

  private trySetIcon(iconEl: HTMLElement, candidates: string[]): boolean {
    const unique = Array.from(new Set(
      candidates.map((candidate) => this.normalizeIconId(String(candidate || '').trim())).filter(Boolean)
    ));
    for (const id of unique) {
      try {
        iconEl.innerHTML = '';
        iconEl.classList.remove('tps-gcm-subitem-icon--emoji');
        setIcon(iconEl, id);
        if (iconEl.querySelector('svg')) return true;
      } catch {
        // continue to next icon id
      }
    }
    return false;
  }

  private resolveFrontmatterIcon(file: TFile, frontmatter: Record<string, any>): string {
    const pickString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
    const fromIconField = normalizeNotebookNavigatorIconValue(pickString(frontmatter?.icon), { keepLucidePrefix: true });
    if (fromIconField) return fromIconField;

    const configuredIconField = pickString(this.plugin.settings.notebookNavigatorIconField);
    if (configuredIconField) {
      const configuredValue = normalizeNotebookNavigatorIconValue(
        pickString(this.getFrontmatterValueCaseInsensitive(frontmatter, configuredIconField)),
        { keepLucidePrefix: true },
      );
      if (configuredValue) return configuredValue;
    }

    if (this.isRuleWriteExcludedForFile(file)) {
      return '';
    }

    const localRules = this.plugin.settings.notebookNavigatorRules;
    if (!localRules || localRules.length === 0) return '';

    const context = buildRuleContext(this.app, file, frontmatter);
    const visual = evaluateIconColorRules(this.app, localRules, context);
    return normalizeNotebookNavigatorIconValue(pickString(visual?.icon?.value), { keepLucidePrefix: true });
  }

  private ensureSubitemIconVisible(iconEl: HTMLElement): void {
    const hasSvg = !!iconEl.querySelector('svg');
    const hasText = String(iconEl.textContent || '').trim().length > 0;
    if (hasSvg || hasText) return;
    iconEl.textContent = '•';
    iconEl.classList.add('tps-gcm-subitem-icon--emoji');
  }

  private resolveFrontmatterColor(frontmatter: Record<string, any>, file?: TFile): string {
    const candidates = ['iconColor', 'color', 'accentColor', 'accent'];
    for (const key of candidates) {
      const raw = frontmatter?.[key];
      if (typeof raw !== 'string') continue;
      const value = raw.trim();
      if (!value) continue;
      if (this.isValidCssColor(value)) {
        return value;
      }
    }

    if (file && !this.isRuleWriteExcludedForFile(file)) {
      const ruleColor = this.resolveRuleColor(file, frontmatter);
      if (ruleColor) {
        return ruleColor;
      }
    }
    return '';
  }

  private isRuleWriteExcludedForFile(file: TFile): boolean {
    return isRuleWriteExcluded(this.app, file, this.plugin.settings.notebookNavigatorFrontmatterWriteExclusions);
  }

  private isValidCssColor(value: string): boolean {
    return isValidCssColor(value);
  }

  private resolveRuleColor(file: TFile, frontmatter: Record<string, any>): string {
    const rules = this.plugin.settings.notebookNavigatorRules;
    if (!rules || rules.length === 0) return '';

    const context = buildRuleContext(this.app, file, frontmatter);
    const visual = evaluateIconColorRules(this.app, rules, context);
    const color = String(visual?.color?.value || '').trim();
    return isValidCssColor(color) ? color : '';
  }
}
