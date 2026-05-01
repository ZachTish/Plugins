/**
 * GCM-owned rule evaluation engine for icon, color, and tag application rules.
 *
 * This is a self-contained engine that evaluates icon/color rules against a
 * file context. No external plugin dependency is required.
 */
import { App, TFile } from 'obsidian';
import { parseDateFromFilename } from '../../../TPS-Calendar-Base (Dev)/src/utils/daily-file-date';
import { getDailyNoteResolver } from '../../../TPS-Controller (Dev)/src/utils/daily-note-resolver';
import { getPluginById } from '../core';

// ─── Types ─────────────────────────────────────────────────────────────────

export type RuleOperator = 'is' | '!is' | 'contains' | '!contains' | 'exists' | '!exists';

export type SmartRuleOperator =
  | RuleOperator
  | 'is-not-empty'
  | 'starts'
  | '!starts'
  | 'within-next-days'
  | '!within-next-days'
  | 'has-open-checkboxes'
  | '!has-open-checkboxes'
  | 'is-today'
  | '!is-today'
  | 'is-before-today'
  | '!is-before-today'
  | 'is-after-today'
  | '!is-after-today';

export type RuleMatchMode = 'all' | 'any';

export type RuleConditionSource =
  | 'frontmatter'
  | 'path'
  | 'extension'
  | 'name'
  | 'tag'
  | 'tag-note-name'
  | 'body'
  | 'backlink'
  | 'date-created'
  | 'date-modified'
  | 'parent-frontmatter'
  | 'parent-tag'
  | 'parent-name'
  | 'parent-path';

export interface RuleCondition {
  source: RuleConditionSource;
  field: string;
  operator: SmartRuleOperator;
  value: string;
}

export interface IconColorRule {
  id: string;
  name: string;
  enabled: boolean;
  property: string;
  operator: RuleOperator;
  value: string;
  pathPrefix: string;
  icon: string;
  color: string;
  match: RuleMatchMode;
  conditions: RuleCondition[];
}

export interface RuleFileDescriptor {
  path: string;
  name: string;
  basename: string;
  extension: string;
}

export interface RuleEvaluationContext {
  file: RuleFileDescriptor;
  frontmatter: Record<string, unknown> | null;
  tags: string[];
  body?: string;
  backlinks?: string[];
  parent?: {
    file: RuleFileDescriptor;
    frontmatter: Record<string, unknown> | null;
    tags: string[];
  };
}

export interface RuleFieldResult {
  matched: boolean;
  value: string;
  ruleId: string | null;
}

export interface VisualRuleResult {
  icon: RuleFieldResult;
  color: RuleFieldResult;
}

// ─── Engine ────────────────────────────────────────────────────────────────

export class RuleEngine {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  // ── Public API ──

  resolveVisualOutputs(rules: IconColorRule[], context: RuleEvaluationContext): VisualRuleResult {
    const icon: RuleFieldResult = { matched: false, value: '', ruleId: null };
    const color: RuleFieldResult = { matched: false, value: '', ruleId: null };

    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (!this.matchesRule(rule, context)) continue;

      if (!icon.matched) {
        const iconValue = String(rule.icon || '').trim();
        if (iconValue) {
          icon.matched = true;
          icon.value = iconValue;
          icon.ruleId = rule.id;
        }
      }

      if (!color.matched) {
        const colorValue = String(rule.color || '').trim();
        if (colorValue) {
          color.matched = true;
          color.value = colorValue;
          color.ruleId = rule.id;
        }
      }

      if (icon.matched && color.matched) break;
    }

    return { icon, color };
  }

  matchesRule(rule: IconColorRule, context: RuleEvaluationContext): boolean {
    const prefix = rule.pathPrefix || '';
    if (!this.matchesPathPrefix(context.file.path, prefix)) {
      return false;
    }

    if (Array.isArray(rule.conditions) && rule.conditions.length > 0) {
      return this.matchesConditionGroup(rule.conditions, rule.match, context);
    }

    if (!rule.property) return false;
    const property = String(rule.property || '').trim();
    if (!property) return false;

    if (property.toLowerCase() === 'folderpath') {
      const pathValues = this.getValuesForConditionSource('path', context, '');
      return this.matchesValues(pathValues, rule.operator, rule.value, false);
    }

    if (rule.operator === 'exists') {
      return this.hasFrontmatterKey(context.frontmatter, property);
    }

    const values = this.toComparableValues(this.getFrontmatterValue(context.frontmatter, property));
    return this.matchesValues(values, rule.operator, rule.value, true);
  }

  // ── Condition Matching ──

  private matchesConditionGroup(conditions: RuleCondition[], matchMode: RuleMatchMode, context: RuleEvaluationContext): boolean {
    if (conditions.length === 0) return false;

    if (matchMode === 'any') {
      return conditions.some((c) => this.matchesCondition(c, context));
    }
    return conditions.every((c) => this.matchesCondition(c, context));
  }

  private matchesCondition(condition: RuleCondition, context: RuleEvaluationContext): boolean {
    const operator = this.normalizeSmartOperator(condition.operator);
    if (!operator) return false;

    const source = condition.source;

    if (source === 'frontmatter') {
      const field = String(condition.field || '').trim();
      if (!field) return false;

      if (field.toLowerCase() === 'folderpath') {
        const folderValues = this.getValuesForConditionSource('path', context, '');
        return this.matchesValues(folderValues, operator, condition.value, false);
      }

      if ((operator === 'exists' || operator === '!exists') && !String(condition.value || '').trim()) {
        const hasField = this.hasFrontmatterKey(context.frontmatter, field);
        return operator === 'exists' ? hasField : !hasField;
      }

      if (operator === 'is-not-empty') {
        const values = this.getValuesForConditionSource('frontmatter', context, field);
        return values.length > 0 && values.some((v) => String(v || '').trim().length > 0);
      }

      const values = this.getValuesForConditionSource('frontmatter', context, field);
      return this.matchesValues(values, operator, condition.value, true);
    }

    if (source === 'parent-frontmatter') {
      const field = String(condition.field || '').trim();
      if (!field) return false;

      if (field.toLowerCase() === 'folderpath') {
        const folderValues = this.getValuesForConditionSource('parent-path', context, '');
        return this.matchesValues(folderValues, operator, condition.value, false);
      }

      if ((operator === 'exists' || operator === '!exists') && !String(condition.value || '').trim()) {
        const hasField = this.hasFrontmatterKey(context.parent?.frontmatter ?? null, field);
        return operator === 'exists' ? hasField : !hasField;
      }

      if (operator === 'is-not-empty') {
        const values = this.getValuesForConditionSource('parent-frontmatter', context, field);
        return values.length > 0 && values.some((v) => String(v || '').trim().length > 0);
      }

      const values = this.getValuesForConditionSource('parent-frontmatter', context, field);
      return this.matchesValues(values, operator, condition.value, true);
    }

    const values = this.getValuesForConditionSource(source, context, condition.field);
    const trimTarget = source !== 'path' && source !== 'parent-path';
    return this.matchesValues(values, operator, condition.value, trimTarget);
  }

  // ── Value Extraction ──

  private getValuesForConditionSource(source: RuleConditionSource, context: RuleEvaluationContext, field: string): string[] {
    if (source === 'path') {
      const folderPath = this.getFolderPath(context.file.path);
      return folderPath ? [folderPath] : [];
    }

    if (source === 'extension') {
      const ext = String(context.file.extension || '').trim();
      return ext ? [ext] : [];
    }

    if (source === 'name') {
      const values = new Set<string>();
      const fileName = String(context.file.name || '').trim();
      const basename = String(context.file.basename || '').trim();
      if (fileName) values.add(fileName);
      if (basename) values.add(basename);
      return Array.from(values);
    }

    if (source === 'tag') {
      return this.collectTags(context);
    }

    if (source === 'tag-note-name') {
      const noteNameTag = this.normalizeTag(context.file.basename || context.file.name || '');
      if (!noteNameTag) return [];
      const tags = new Set(this.collectTags(context).map((t) => this.normalizeTag(t)));
      return tags.has(noteNameTag) ? [noteNameTag] : [];
    }

    if (source === 'parent-tag') {
      return Array.isArray(context.parent?.tags) ? context.parent!.tags : [];
    }

    if (source === 'body') {
      return context.body ? [context.body] : [];
    }

    if (source === 'parent-name') {
      const parentFile = context.parent?.file;
      if (!parentFile) return [];
      const values = new Set<string>();
      const fileName = String(parentFile.name || '').trim();
      const basename = String(parentFile.basename || '').trim();
      if (fileName) values.add(fileName);
      if (basename) values.add(basename);
      return Array.from(values);
    }

    if (source === 'parent-path') {
      const parentPath = String(context.parent?.file?.path || '').trim();
      if (!parentPath) return [];
      const folderPath = this.getFolderPath(parentPath);
      return folderPath ? [folderPath] : [];
    }

    if (source === 'backlink') {
      const allBacklinks = context.backlinks || [];
      const targetField = (field || '').trim();

      if (!targetField) {
        const values = new Set<string>();
        for (const path of allBacklinks) {
          values.add(path);
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) values.add(file.basename);
        }
        return Array.from(values);
      }

      const validPaths = allBacklinks.filter((sourcePath) => {
        const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
        if (!(sourceFile instanceof TFile)) return false;
        const cache = this.app.metadataCache.getFileCache(sourceFile);
        if (!cache?.frontmatterLinks) return false;
        return cache.frontmatterLinks.some((link) => {
          if (!link.key || link.key.toLowerCase() !== targetField.toLowerCase()) return false;
          const dest = this.app.metadataCache.getFirstLinkpathDest(link.link, sourcePath);
          return dest && dest.path === context.file.path;
        });
      });

      const values = new Set<string>();
      for (const path of validPaths) {
        values.add(path);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) values.add(file.basename);
      }
      return Array.from(values);
    }

    if (source === 'date-created') {
      // @ts-ignore
      return [window.moment((context.file as any).stat?.ctime ?? 0).format()];
    }

    if (source === 'date-modified') {
      // @ts-ignore
      return [window.moment((context.file as any).stat?.mtime ?? 0).format()];
    }

    if (source === 'parent-frontmatter') {
      const key = String(field || '').trim();
      if (!key) return [];
      if (key.toLowerCase() === 'folderpath') {
        return this.getValuesForConditionSource('parent-path', context, '');
      }
      const directParentValues = this.toComparableValues(this.getFrontmatterValue(context.parent?.frontmatter ?? null, key));
      if (directParentValues.length > 0) return directParentValues;
      const parentFile = context.parent?.file;
      if (parentFile) {
        const normalizedField = key.toLowerCase();
        if (['scheduled', 'date', 'day'].includes(normalizedField)) {
          const derived = this.getDailyNoteDateKeyFromFile(parentFile);
          return derived ? [derived] : [];
        }
      }
      return [];
    }

    // Default: frontmatter source
    const key = String(field || '').trim();
    if (!key) return [];

    if (key.toLowerCase() === 'folderpath') {
      return this.getValuesForConditionSource('path', context, '');
    }

    const directValues = this.toComparableValues(this.getFrontmatterValue(context.frontmatter, key));
    if (directValues.length > 0) return directValues;

    return this.getDerivedDateFieldValues(context, key);
  }

  // ── Value Matching ──

  private matchesValues(values: string[], operator: SmartRuleOperator, rawTarget: string, trimTarget: boolean): boolean {
    const trimmedValues = values.map((v) => String(v ?? '').trim()).filter(Boolean);
    const trimmedTarget = trimTarget ? String(rawTarget ?? '').trim() : String(rawTarget ?? '');

    if (operator === 'within-next-days' || operator === '!within-next-days') {
      return this.matchesWithinNextDays(trimmedValues, trimmedTarget, operator === '!within-next-days');
    }

    if (operator === 'has-open-checkboxes' || operator === '!has-open-checkboxes') {
      const gcm = getPluginById(this.app, 'tps-global-context-menu') as any;
      const gcmHasOpen = gcm?.api?.hasOpenCheckboxes;
      let hasOpen: boolean;
      if (gcmHasOpen) {
        hasOpen = gcmHasOpen(trimmedValues.join('\n'));
      } else {
        hasOpen = trimmedValues.some((value) => /^\s*(?:[-*+]|\d+\.)\s*\[ \]/.test(value));
      }
      return operator === 'has-open-checkboxes' ? hasOpen : !hasOpen;
    }

    if (operator === 'is-today' || operator === '!is-today') {
      // @ts-ignore
      const today = window.moment().startOf('day');
      const isToday = trimmedValues.some((value) => {
        const m = this.parseComparableDate(value);
        return !!m && m.isSame(today, 'day');
      });
      return operator === 'is-today' ? isToday : !isToday;
    }

    if (operator === 'is-before-today' || operator === '!is-before-today') {
      // @ts-ignore
      const today = window.moment().startOf('day');
      const isBefore = trimmedValues.some((value) => {
        const m = this.parseComparableDate(value);
        return !!m && m.isBefore(today, 'day');
      });
      return operator === 'is-before-today' ? isBefore : !isBefore;
    }

    if (operator === 'is-after-today' || operator === '!is-after-today') {
      // @ts-ignore
      const today = window.moment().startOf('day');
      const isAfter = trimmedValues.some((value) => {
        const m = this.parseComparableDate(value);
        return !!m && m.isAfter(today, 'day');
      });
      return operator === 'is-after-today' ? isAfter : !isAfter;
    }

    if (operator === 'is-not-empty') {
      return trimmedValues.length > 0 && trimmedValues.some((v) => v.length > 0);
    }

    const normalizedValues = trimmedValues.map((v) => v.toLowerCase());
    const target = trimmedTarget.toLowerCase();

    if (operator === 'exists') {
      if (!target) return normalizedValues.length > 0;
      return normalizedValues.some((v) => v.includes(target));
    }

    if (operator === '!exists') {
      if (!target) return normalizedValues.length === 0;
      return normalizedValues.every((v) => !v.includes(target));
    }

    if (!target) return false;

    if (operator === 'is') return normalizedValues.some((v) => v === target);
    if (operator === '!is') return normalizedValues.every((v) => v !== target);
    if (operator === 'contains') return normalizedValues.some((v) => v.includes(target));
    if (operator === '!contains') return normalizedValues.every((v) => !v.includes(target));
    if (operator === 'starts') return normalizedValues.some((v) => v.startsWith(target));
    if (operator === '!starts') return normalizedValues.every((v) => !v.startsWith(target));

    return false;
  }

  // ── Helpers ──

  private matchesPathPrefix(filePath: string, pathPrefix: string): boolean {
    const normalizedPrefix = normalizePath(pathPrefix);
    if (!normalizedPrefix) return true;
    const folderPath = this.getFolderPath(filePath);
    if (!folderPath) return false;
    return folderPath === normalizedPrefix || folderPath.startsWith(`${normalizedPrefix}/`);
  }

  private getFolderPath(filePath: string): string {
    const normalizedPath = normalizePath(filePath);
    const slashIndex = normalizedPath.lastIndexOf('/');
    return slashIndex < 0 ? '' : normalizedPath.slice(0, slashIndex);
  }

  private hasFrontmatterKey(frontmatter: Record<string, unknown> | null, key: string): boolean {
    if (!frontmatter) return false;
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) return true;
    const normalizedTarget = key.toLowerCase();
    return Object.keys(frontmatter).some((k) => k.toLowerCase() === normalizedTarget);
  }

  private getFrontmatterValue(frontmatter: Record<string, unknown> | null, key: string): unknown {
    if (!frontmatter) return undefined;
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) return frontmatter[key];
    const normalizedTarget = key.toLowerCase();
    for (const [existingKey, value] of Object.entries(frontmatter)) {
      if (existingKey.toLowerCase() === normalizedTarget) return value;
    }
    return undefined;
  }

  private collectTags(context: RuleEvaluationContext): string[] {
    const tags = new Set<string>();
    for (const rawTag of context.tags) {
      const normalized = this.normalizeTag(rawTag);
      if (normalized) tags.add(normalized);
    }
    const frontmatterTags = this.getFrontmatterValue(context.frontmatter, 'tags');
    if (Array.isArray(frontmatterTags)) {
      for (const rawTag of frontmatterTags) {
        const normalized = this.normalizeTag(rawTag);
        if (normalized) tags.add(normalized);
      }
    } else if (typeof frontmatterTags === 'string') {
      for (const rawTag of frontmatterTags.split(/[\s,]+/)) {
        const normalized = this.normalizeTag(rawTag);
        if (normalized) tags.add(normalized);
      }
    }
    return Array.from(tags);
  }

  private normalizeTag(raw: unknown): string {
    const value = String(raw ?? '').trim();
    if (!value) return '';
    return value.replace(/^#+/, '').toLowerCase();
  }

  private toComparableValues(value: unknown): string[] {
    if (value === null || value === undefined) return [];
    if (Array.isArray(value)) return value.flatMap((item) => this.toComparableValues(item));
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed ? [trimmed] : [];
    }
    if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      const localDay = new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
      // @ts-ignore
      return [window.moment(localDay).format('YYYY-MM-DD')];
    }
    try { return [JSON.stringify(value)]; } catch { return [String(value)]; }
  }

  private getDailyNoteDateKeyFromFile(file: { basename: string }): string | null {
    try {
      return getDailyNoteResolver(this.app).parseFilenameToDateKey(file.basename);
    } catch {
      return null;
    }
  }

  private getDerivedDateFieldValues(context: RuleEvaluationContext, field: string): string[] {
    const normalizedField = String(field || '').trim().toLowerCase();
    if (!['scheduled', 'date', 'day'].includes(normalizedField)) return [];
    const derived = this.getDailyNoteDateKeyFromFile(context.file);
    return derived ? [derived] : [];
  }

  private getDailyNoteDateFormat(): string | undefined {
    return getDailyNoteResolver(this.app).displayFormat;
  }

  private parseComparableDate(value: string): any | null {
    const text = String(value ?? '').trim();
    if (!text) return null;

    const userFormat = this.getDailyNoteDateFormat();

    try {
      const fromFilename = parseDateFromFilename(text, userFormat);
      if (fromFilename && fromFilename.isValid && fromFilename.isValid()) return fromFilename;
    } catch { /* fall through */ }

    // @ts-ignore
    const m = window.moment(text, [
      // @ts-ignore
      window.moment.ISO_8601,
      ...(userFormat ? [userFormat] : []),
      'YYYY-MM-DD',
      'YYYY-MM-DD HH:mm',
      'YYYY-MM-DD HH:mm:ss',
      'YYYY-MM-DDTHH:mm:ss',
      'YYYY/MM/DD HH:mm:ss',
      'YYYY/MM/DD HH:mm',
      'YYYY/MM/DD',
    ], true);

    return m.isValid() ? m : null;
  }

  private matchesWithinNextDays(values: string[], rawTarget: string, negated: boolean): boolean {
    const days = this.parseDayCount(rawTarget);
    if (days == null) return false;

    // @ts-ignore
    const today = window.moment().startOf('day');
    // @ts-ignore
    const limit = window.moment().add(days, 'days').endOf('day');

    const matched = values.some((value) => {
      const m = this.parseComparableDate(value);
      if (!m) return false;
      return m.isSameOrAfter(today) && m.isSameOrBefore(limit);
    });

    return negated ? !matched : matched;
  }

  private parseDayCount(raw: string): number | null {
    const text = String(raw || '').trim();
    if (!text) return null;
    const match = text.match(/^-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const parsed = Number.parseFloat(match[0]);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, parsed);
  }

  private normalizeSmartOperator(operator: string): SmartRuleOperator | null {
    const valid: Set<string> = new Set([
      'is', '!is', 'contains', '!contains', 'exists', '!exists',
      'is-not-empty', 'starts', '!starts',
      'within-next-days', '!within-next-days',
      'has-open-checkboxes', '!has-open-checkboxes',
      'is-today', '!is-today',
      'is-before-today', '!is-before-today',
      'is-after-today', '!is-after-today',
    ]);
    return valid.has(operator) ? (operator as SmartRuleOperator) : null;
  }
}

// ── Utility ──

function normalizePath(path: string): string {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}
