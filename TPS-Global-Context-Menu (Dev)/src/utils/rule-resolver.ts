/**
 * Centralized rule resolution for icon, color, and tag application.
 *
 * GCM owns these rules and evaluates them locally via its own RuleEngine.
 * No external plugin dependency is required for evaluation.
 */
import { App, TFile, getAllTags } from 'obsidian';
import { deleteValueCaseInsensitive, findKeyCaseInsensitive, getPluginById, setValueCaseInsensitive } from '../core';
import { resolveLinkValueToFile } from '../handlers/parent-link-format';
import { parseTagInput, normalizeTagValue } from './tag-utils';
import { RuleEngine } from '../services/rule-engine';
import type { RuleEvaluationContext, VisualRuleResult } from '../services/rule-engine';
import * as logger from '../logger';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface RuleVisualOutput {
  icon?: { value: string };
  color?: { value: string };
}

export type { RuleEvaluationContext };

type GcmRuleHost = {
  settings?: Record<string, any>;
  frontmatterMutationService?: {
    process: (file: TFile, mutator: (frontmatter: Record<string, unknown>) => void | Promise<void>) => Promise<boolean>;
  };
};

// ─── Local Engine Instance ─────────────────────────────────────────────────

let _engine: RuleEngine | null = null;

function getEngine(app: App): RuleEngine {
  if (!_engine) {
    _engine = new RuleEngine(app);
  }
  return _engine;
}

/** Invalidates the engine cache (call on plugin reload events). */
export function invalidateRuleEngineCache(): void {
  _engine = null;
}

// ─── Context Construction ──────────────────────────────────────────────────

/**
 * Builds a rule evaluation context for a file.
 * Normalizes tags from both the metadata cache and raw frontmatter values.
 */
export function buildRuleContext(app: App, file: TFile, frontmatter: Record<string, any>): RuleEvaluationContext {
  const tags = collectNormalizedTags(app, file, frontmatter);

  return {
    file: {
      path: file.path,
      name: file.name,
      basename: file.basename,
      extension: file.extension,
    },
    frontmatter,
    tags,
  };
}

// ─── Rule Evaluation ───────────────────────────────────────────────────────

/**
 * Evaluates icon/color rules against a context using GCM's local engine.
 */
export function evaluateIconColorRules(
  app: App,
  rules: any[],
  context: RuleEvaluationContext,
): RuleVisualOutput | null {
  if (!rules || rules.length === 0) return null;

  const engine = getEngine(app);

  try {
    const result: VisualRuleResult = engine.resolveVisualOutputs(rules, context);
    if (!result) return null;

    const output: RuleVisualOutput = {};
    if (result.icon?.matched && result.icon.value) {
      output.icon = { value: result.icon.value };
    }
    if (result.color?.matched && result.color.value) {
      output.color = { value: result.color.value };
    }
    return (output.icon || output.color) ? output : null;
  } catch (error) {
    logger.warn('[TPS GCM] rule evaluation failed:', error);
    return null;
  }
}

/**
 * Evaluates icon/color rules for a file using GCM's local rule set.
 */
export function evaluateLocalRules(
  app: App,
  file: TFile,
  frontmatter: Record<string, any>,
  localRules: any[],
): RuleVisualOutput | null {
  if (!localRules || localRules.length === 0) return null;
  const context = buildRuleContext(app, file, frontmatter);
  return evaluateIconColorRules(app, localRules, context);
}

// ─── Write Exclusion ───────────────────────────────────────────────────────

/**
 * Checks whether a file is excluded from rule-driven frontmatter writes
 * based on GCM's configured exclusion patterns.
 */
export function isRuleWriteExcluded(app: App, file: TFile, exclusionPatterns?: string): boolean {
  if (!exclusionPatterns) return false;
  const patterns = exclusionPatterns.split(',').map((p) => p.trim()).filter(Boolean);
  if (patterns.length === 0) return false;

  const filePath = file.path.toLowerCase();
  for (const pattern of patterns) {
    const normalized = pattern.toLowerCase();
    if (filePath.startsWith(normalized) || filePath.includes(`/${normalized}`)) {
      return true;
    }
  }
  return false;
}

async function buildRuleContextForWrite(app: App, file: TFile, frontmatter: Record<string, any>): Promise<RuleEvaluationContext> {
  const context = buildRuleContext(app, file, frontmatter);
  context.backlinks = collectBacklinks(app, file);

  const parent = resolveParentContext(app, file, frontmatter);
  if (parent) {
    context.parent = parent;
  }

  try {
    const content = await app.vault.cachedRead(file);
    const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
    context.body = frontmatterMatch ? content.slice(frontmatterMatch[0].length) : content;
  } catch (error) {
    logger.warn('[TPS GCM] Failed reading file body for rule evaluation:', file.path, error);
  }

  return context;
}

function collectNormalizedTags(app: App, file: TFile, frontmatter: Record<string, any>): string[] {
  const cache = app.metadataCache.getFileCache(file);
  const rawTags = parseTagInput([
    ...(cache ? getAllTags(cache) || [] : []),
    frontmatter?.tags,
    frontmatter?.tag,
  ]);
  return Array.from(new Set(
    rawTags.map((tag) => normalizeTagValue(tag)).filter(Boolean),
  ));
}

function collectBacklinks(app: App, file: TFile): string[] {
  const resolvedLinks = app.metadataCache.resolvedLinks || {};
  const backlinks: string[] = [];
  for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
    if (Object.prototype.hasOwnProperty.call(links || {}, file.path)) {
      backlinks.push(sourcePath);
    }
  }
  return backlinks;
}

function getRuleHost(app: App): GcmRuleHost | null {
  const plugins: any = (app as any)?.plugins?.plugins;
  return (getPluginById(app, 'tps-global-context-menu') as any)
    ?? plugins?.['TPS-Global-Context-Menu (Dev)']
    ?? plugins?.['tps-global-context-menu']
    ?? null;
}

function getFrontmatterValueCaseInsensitive(frontmatter: Record<string, any> | null | undefined, key: string): unknown {
  if (!frontmatter || !key) return undefined;
  const existingKey = findKeyCaseInsensitive(frontmatter, key);
  return existingKey ? frontmatter[existingKey] : undefined;
}

function getParentLinkKeys(app: App): string[] {
  const gcm = getRuleHost(app) as any;
  return Array.from(new Set([
    String(gcm?.settings?.parentLinkFrontmatterKey || '').trim(),
    'childOf',
    'parent',
  ].filter(Boolean)));
}

function collectParentLinkCandidates(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((entry) => collectParentLinkCandidates(entry));
  }
  const value = String(raw || '').trim();
  return value ? [value] : [];
}

function resolveParentContext(app: App, file: TFile, frontmatter: Record<string, any>): RuleEvaluationContext['parent'] | undefined {
  for (const key of getParentLinkKeys(app)) {
    const raw = getFrontmatterValueCaseInsensitive(frontmatter, key);
    const candidates = collectParentLinkCandidates(raw);
    for (const candidate of candidates) {
      const parentFile = resolveLinkValueToFile(app, candidate, file.path);
      if (!(parentFile instanceof TFile) || parentFile.path === file.path) continue;
      const parentFrontmatter = (app.metadataCache.getFileCache(parentFile)?.frontmatter || {}) as Record<string, any>;
      return {
        file: {
          path: parentFile.path,
          name: parentFile.name,
          basename: parentFile.basename,
          extension: parentFile.extension,
        },
        frontmatter: parentFrontmatter,
        tags: collectNormalizedTags(app, parentFile, parentFrontmatter),
      };
    }
  }
  return undefined;
}

function applyFrontmatterMutation(frontmatter: Record<string, unknown>, key: string, desiredValue: string | null | undefined): boolean {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return false;

  const existingKey = findKeyCaseInsensitive(frontmatter, normalizedKey);
  const currentValue = existingKey ? String(frontmatter[existingKey] ?? '').trim() : '';

  if (desiredValue === undefined) {
    return false;
  }

  if (desiredValue === null) {
    if (!existingKey) return false;
    deleteValueCaseInsensitive(frontmatter, normalizedKey);
    return true;
  }

  const nextValue = String(desiredValue).trim();
  if (!nextValue) {
    if (!existingKey) return false;
    deleteValueCaseInsensitive(frontmatter, normalizedKey);
    return true;
  }

  if (existingKey && currentValue === nextValue) {
    return false;
  }

  setValueCaseInsensitive(frontmatter, normalizedKey, nextValue);
  return true;
}

// ─── Rule Application ──────────────────────────────────────────────────────

/**
 * Applies icon/color rules to a file by evaluating rules and writing results
 * through GCM's serialized frontmatter mutation service.
 */
export async function applyRulesToFile(
  app: App,
  file: TFile,
  _reason: string = 'gcm',
): Promise<void> {
  if (!(file instanceof TFile) || file.extension !== 'md') return;

  const gcm = getRuleHost(app);
  const settings = gcm?.settings;
  if (!settings || typeof gcm?.frontmatterMutationService?.process !== 'function') return;

  const rules = settings.notebookNavigatorRules;
  if (!rules || rules.length === 0) return;

  if (isRuleWriteExcluded(app, file, settings.notebookNavigatorFrontmatterWriteExclusions)) return;

  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = (cache?.frontmatter || {}) as Record<string, any>;
  const staticContext = await buildRuleContextForWrite(app, file, frontmatter);

  const iconField = String(settings.notebookNavigatorIconField || 'icon').trim() || 'icon';
  const colorField = String(settings.notebookNavigatorColorField || 'color').trim() || 'color';
  const clearIcon = settings.notebookNavigatorClearIconWhenNoMatch === true;
  const clearColor = settings.notebookNavigatorClearColorWhenNoMatch === true;

  try {
    await gcm.frontmatterMutationService.process(file, async (mutableFrontmatter: Record<string, unknown>) => {
      const context: RuleEvaluationContext = {
        ...staticContext,
        frontmatter: mutableFrontmatter,
        tags: collectNormalizedTags(app, file, mutableFrontmatter as Record<string, any>),
      };
      const visual = evaluateIconColorRules(app, rules, context);
      const desiredIcon = visual?.icon?.value
        ? String(visual.icon.value).trim()
        : clearIcon ? null : undefined;
      const desiredColor = visual?.color?.value
        ? String(visual.color.value).trim()
        : clearColor ? null : undefined;

      if (String(iconField).trim().toLowerCase() === String(colorField).trim().toLowerCase()) {
        const mergedVisual = desiredIcon !== undefined ? desiredIcon : desiredColor;
        applyFrontmatterMutation(mutableFrontmatter, iconField, mergedVisual);
        return;
      }

      applyFrontmatterMutation(mutableFrontmatter, iconField, desiredIcon);
      applyFrontmatterMutation(mutableFrontmatter, colorField, desiredColor);
    });
  } catch (error) {
    logger.warn('[TPS GCM] Failed writing rule results to frontmatter:', file.path, error);
  }
}

// ─── CSS Color Validation ──────────────────────────────────────────────────

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Returns true if the value is a usable CSS color string. */
export function isValidCssColor(value: string): boolean {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  if (normalized.startsWith('var(')) return true;
  if (HEX_COLOR_RE.test(normalized)) return true;
  if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
    return CSS.supports('color', normalized);
  }
  return false;
}
