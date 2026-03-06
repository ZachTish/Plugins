import { App, TFile } from "obsidian";
import { Logger } from "./logger";
import { RuleEngine } from "./rule-engine";
import { MetadataManager } from "./metadata-manager";
import { FrontmatterWriteExclusionService } from "./frontmatter-write-exclusion-service";
import {
    NotebookNavigatorCompanionSettings,
    RuleEvaluationContext,
    RuleCondition,
    RuleConditionSource,
} from "../types";

/**
 * Handles per-file rule evaluation and frontmatter mutation for icon, color,
 * sort key, and hide-tag outputs.  Also builds the `RuleEvaluationContext`
 * used by the rule engine and the settings preview.
 *
 * Extracted from main.ts to keep the main class under 500 lines.
 */
export class RuleApplicationService {
    constructor(
        private app: App,
        private ruleEngine: RuleEngine,
        private metadataManager: MetadataManager,
        private logger: Logger,
        private getSettings: () => NotebookNavigatorCompanionSettings,
        private exclusionService: FrontmatterWriteExclusionService,
        private isProtectedKey: (key: string) => boolean,
    ) {}

    // ── Public API ─────────────────────────────────────────────────────────

    async applyRulesToFile(
        file: TFile,
        options: { reason: string; force?: boolean },
    ): Promise<boolean> {
        const settings = this.getSettings();
        if (!settings.enabled) return false;

        if (!this.isMarkdownFile(file)) return false;
        if (this.exclusionService.shouldIgnore(file)) return false;

        if (!options.force && this.metadataManager.shouldIgnoreFileEvent(file.path)) return false;

        const iconField = settings.frontmatterIconField;
        const colorField = settings.frontmatterColorField;

        const contextRequirements = this.getRuleContextRequirements();
        const contextWithBody = await this.buildRuleContextWithBody(file, undefined, contextRequirements);

        return this.metadataManager.queueFrontmatterUpdate(file, options.reason, (mutableFrontmatter) => {
            const context: RuleEvaluationContext = {
                ...contextWithBody,
                frontmatter: mutableFrontmatter,
                tags: this.collectTagsFromCache(file, mutableFrontmatter),
            };

            const visualOutputs = this.ruleEngine.resolveVisualOutputs(settings.rules, context);
            const desiredIcon = visualOutputs.icon.matched
                ? visualOutputs.icon.value
                : settings.clearIconWhenNoMatch ? null : undefined;
            const desiredColor = visualOutputs.color.matched
                ? visualOutputs.color.value
                : settings.clearColorWhenNoMatch ? null : undefined;

            const desiredSortKey = this.computeDesiredSortValue(context);
            const hideChanges = this.computeHideChanges(context);

            let changed = false;

            if (iconField.toLowerCase() === colorField.toLowerCase()) {
                const mergedVisual = desiredIcon !== undefined ? desiredIcon : desiredColor;
                changed = this.applyFrontmatterMutation(mutableFrontmatter, iconField, mergedVisual) || changed;
            } else {
                changed = this.applyFrontmatterMutation(mutableFrontmatter, iconField, desiredIcon) || changed;
                changed = this.applyFrontmatterMutation(mutableFrontmatter, colorField, desiredColor) || changed;
            }

            if (desiredSortKey !== undefined) {
                changed = this.applyFrontmatterMutation(mutableFrontmatter, settings.smartSort.field, desiredSortKey) || changed;
            }

            if (this.applyTagMutations(mutableFrontmatter, hideChanges)) {
                changed = true;
            }

            if (changed) {
                this.logger.debug("Applied rules to file", {
                    file: file.path,
                    reason: options.reason,
                    iconRule: visualOutputs.icon.ruleId,
                    colorRule: visualOutputs.color.ruleId,
                    sortField: settings.smartSort.enabled ? settings.smartSort.field : "",
                    hideAdded: hideChanges.add,
                    hideRemoved: hideChanges.remove,
                });
            }

            return changed;
        });
    }

    buildRuleContext(
        file: TFile,
        frontmatterOverride: Record<string, unknown> | null | undefined,
        includeBacklinks = true,
    ): RuleEvaluationContext {
        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = frontmatterOverride ?? this.toFrontmatterRecord(cache?.frontmatter);

        let backlinks: string[] | undefined;
        if (includeBacklinks) {
            backlinks = [];
            const resolvedLinks = this.app.metadataCache.resolvedLinks;
            if (resolvedLinks) {
                for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
                    if (Object.prototype.hasOwnProperty.call(links, file.path)) {
                        backlinks.push(sourcePath);
                    }
                }
            }
        }

        return {
            file: {
                path: file.path,
                name: file.name,
                basename: file.basename,
                extension: file.extension,
            },
            frontmatter,
            tags: this.collectTagsFromCache(file, frontmatter),
            backlinks,
        };
    }

    // ── Private helpers ────────────────────────────────────────────────────

    private async buildRuleContextWithBody(
        file: TFile,
        frontmatterOverride: Record<string, unknown> | null | undefined,
        options?: { includeBody?: boolean; includeBacklinks?: boolean },
    ): Promise<RuleEvaluationContext> {
        const includeBody = options?.includeBody ?? true;
        const includeBacklinks = options?.includeBacklinks ?? true;
        const context = this.buildRuleContext(file, frontmatterOverride, includeBacklinks);

        if (includeBody && file.extension.toLowerCase() === "md") {
            try {
                const content = await this.app.vault.cachedRead(file);
                const frontmatterEndMatch = content.match(/^---\n[\s\S]*?\n---\n/);
                if (frontmatterEndMatch) {
                    context.body = content.slice(frontmatterEndMatch[0].length);
                } else {
                    context.body = content;
                }
            } catch (error) {
                this.logger.error("Failed to read file body for rule evaluation", error, { file: file.path });
            }
        }

        return context;
    }

    private computeDesiredSortValue(context: RuleEvaluationContext): string | null | undefined {
        const smartSort = this.getSettings().smartSort;
        if (!smartSort.enabled) return undefined;

        const sortKey = this.ruleEngine.composeSortKey(smartSort, context);
        if (sortKey) return sortKey;

        return smartSort.clearWhenNoMatch ? null : undefined;
    }

    private applyFrontmatterMutation(
        mutableFrontmatter: Record<string, unknown>,
        key: string,
        desiredValue: string | null | undefined,
    ): boolean {
        if (desiredValue === undefined) return false;

        if (this.isProtectedKey(key)) {
            this.logger.warn("Skipping mutation on protected calendar identity key", { key });
            return false;
        }

        if (desiredValue !== null && !this.metadataManager.validateFrontmatterValue(key, desiredValue)) {
            this.logger.warn("Skipping frontmatter mutation due to validation failure", { key, value: desiredValue });
            return false;
        }

        const normalizedTarget = key.toLowerCase();
        let actualKey = key;
        for (const existingKey of Object.keys(mutableFrontmatter)) {
            if (existingKey.toLowerCase() === normalizedTarget) {
                actualKey = existingKey;
                break;
            }
        }

        if (desiredValue === null) {
            if (!Object.prototype.hasOwnProperty.call(mutableFrontmatter, actualKey)) return false;
            delete mutableFrontmatter[actualKey];
            return true;
        }

        const currentValue = String(mutableFrontmatter[actualKey] ?? "");
        if (currentValue === desiredValue) return false;

        mutableFrontmatter[actualKey] = desiredValue;
        return true;
    }

    private collectTagsFromCache(file: TFile, frontmatter: Record<string, unknown> | null): string[] {
        const tags = new Set<string>();
        const cacheTags = this.app.metadataCache.getFileCache(file)?.tags ?? [];
        for (const cacheTag of cacheTags) {
            const normalized = this.normalizeTag(cacheTag.tag);
            if (normalized) tags.add(normalized);
        }
        if (frontmatter) {
            const fmTags = this.getFrontmatterValue(frontmatter, "tags");
            if (Array.isArray(fmTags)) {
                for (const rawTag of fmTags) {
                    const normalized = this.normalizeTag(rawTag);
                    if (normalized) tags.add(normalized);
                }
            } else if (typeof fmTags === "string") {
                for (const rawTag of fmTags.split(/[\s,]+/)) {
                    const normalized = this.normalizeTag(rawTag);
                    if (normalized) tags.add(normalized);
                }
            }
        }
        return Array.from(tags);
    }

    private normalizeTag(rawTag: unknown): string {
        return String(rawTag ?? "").trim().replace(/^#+/, "").toLowerCase();
    }

    private toFrontmatterRecord(frontmatter: unknown): Record<string, unknown> | null {
        if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return null;
        return frontmatter as Record<string, unknown>;
    }

    private getFrontmatterValue(frontmatter: Record<string, unknown>, key: string): unknown {
        if (Object.prototype.hasOwnProperty.call(frontmatter, key)) return frontmatter[key];
        const normalizedTarget = key.toLowerCase();
        for (const [existingKey, value] of Object.entries(frontmatter)) {
            if (existingKey.toLowerCase() === normalizedTarget) return value;
        }
        return undefined;
    }

    private getRuleContextRequirements(): { includeBody: boolean; includeBacklinks: boolean } {
        return {
            includeBody: this.settingsUseConditionSource("body"),
            includeBacklinks: this.settingsUseConditionSource("backlink"),
        };
    }

    private settingsUseConditionSource(source: RuleConditionSource): boolean {
        const settings = this.getSettings();
        for (const rule of settings.rules) {
            if (rule.enabled && this.conditionsUseSource(rule.conditions, source)) return true;
        }
        for (const hideRule of settings.hideRules) {
            if (hideRule.enabled && this.conditionsUseSource(hideRule.conditions, source)) return true;
        }
        if (settings.smartSort.enabled) {
            for (const bucket of settings.smartSort.buckets) {
                if (!bucket.enabled) continue;
                if (this.conditionsUseSource(bucket.conditions, source)) return true;
                if (Array.isArray(bucket.conditionGroups)) {
                    for (const group of bucket.conditionGroups) {
                        if (this.conditionsUseSource(group.conditions, source)) return true;
                    }
                }
                if (bucket.sortCriteria.some((c) => c.source === source)) return true;
            }
        }
        return false;
    }

    private conditionsUseSource(conditions: RuleCondition[] | undefined, source: RuleConditionSource): boolean {
        if (!Array.isArray(conditions) || conditions.length === 0) return false;
        return conditions.some((condition) => condition.source === source);
    }

    private computeHideChanges(context: RuleEvaluationContext): { add: string[]; remove: string[] } {
        const toAdd = new Set<string>();
        const toRemove = new Set<string>();
        const addRuleDefined = new Set<string>();
        const addRuleMatched = new Set<string>();

        for (const rule of this.getSettings().hideRules) {
            const tag = this.normalizeTag(rule.tagName);
            if (!tag) continue;
            if (rule.mode === "add") addRuleDefined.add(tag);
            if (!rule.enabled) continue;
            if (this.ruleEngine.matchesRule(rule, context)) {
                if (rule.mode === "add") {
                    addRuleMatched.add(tag);
                    toAdd.add(tag);
                    toRemove.delete(tag);
                } else {
                    toRemove.add(tag);
                    toAdd.delete(tag);
                }
            }
        }

        if (this.getSettings().autoRemoveHiddenWhenNoMatch) {
            for (const tag of addRuleDefined) {
                if (!addRuleMatched.has(tag) && !toAdd.has(tag)) {
                    toRemove.add(tag);
                }
            }
        }

        return { add: Array.from(toAdd), remove: Array.from(toRemove) };
    }

    private applyTagMutations(
        mutableFrontmatter: Record<string, unknown>,
        changes: { add: string[]; remove: string[] },
    ): boolean {
        const rawTags = this.getFrontmatterValue(mutableFrontmatter, "tags");
        let currentTags: string[] = [];
        if (Array.isArray(rawTags)) {
            currentTags = rawTags.map((t) => this.normalizeTag(t)).filter(Boolean);
        } else if (typeof rawTags === "string") {
            currentTags = rawTags.split(/[\s,]+/).map((t) => this.normalizeTag(t)).filter(Boolean);
        }

        const initialSet = new Set(currentTags);
        let changed = false;
        for (const tag of changes.remove) {
            if (initialSet.delete(tag)) changed = true;
        }
        for (const tag of changes.add) {
            if (!initialSet.has(tag)) {
                initialSet.add(tag);
                changed = true;
            }
        }
        if (changed) {
            mutableFrontmatter["tags"] = Array.from(initialSet);
            return true;
        }
        return false;
    }

    private isMarkdownFile(file: TFile): boolean {
        return file instanceof TFile && file.extension === "md";
    }
}
