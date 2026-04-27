import { App, TFile, normalizePath, setIcon } from "obsidian";
import { Logger } from "./logger";
import { RuleEngine } from "./rule-engine";
import { MetadataManager } from "./metadata-manager";
import { FrontmatterWriteExclusionService } from "./frontmatter-write-exclusion-service";
import {
    NotebookNavigatorCompanionSettings,
    RuleEvaluationContext,
    RuleCondition,
    RuleConditionSource,
    RelationshipLineageNode,
} from "../types";

/**
 * Handles per-file rule evaluation and frontmatter mutation for icon, color,
 * sort key, and hide-tag outputs.  Also builds the `RuleEvaluationContext`
 * used by the rule engine and the settings preview.
 *
 * Extracted from main.ts to keep the main class under 500 lines.
 */
export class RuleApplicationService {
    private bulkAppliedRuleReasons = new Set(["create", "startup-scan", "startup-auto", "bulk-scan", "bulk-apply"]);
    private pendingAppliedRuleSummary = new Map<string, number>();
    private appliedRuleSummaryTimer: number | null = null;

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
        options: { reason: string; force?: boolean; bypassCreationGrace?: boolean },
    ): Promise<boolean> {
        const settings = this.getSettings();
        if (!settings.enabled) return false;

        if (!this.isMarkdownFile(file)) return false;
        if (this.exclusionService.shouldIgnore(file, {
            bypassCreationGrace: options.bypassCreationGrace,
        })) return false;

        if (!options.force && this.metadataManager.shouldIgnoreFileEvent(file.path)) return false;
        if (this.shouldSkipAfterFreshGcmWrite(file.path, options.reason)) return false;

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

            if (settings.writeBasesIconFields) {
                const resolvedIcon = desiredIcon !== undefined
                    ? desiredIcon
                    : this.readFrontmatterString(mutableFrontmatter, iconField);
                const resolvedColor = desiredColor !== undefined
                    ? desiredColor
                    : this.readFrontmatterString(mutableFrontmatter, colorField);
                const basesIcon = this.composeBasesIconValues(resolvedIcon, resolvedColor);
                changed = this.applyFrontmatterMutation(mutableFrontmatter, settings.basesIconMarkdownField, basesIcon.markdown) || changed;
                changed = this.applyFrontmatterMutation(mutableFrontmatter, settings.basesIconUriField, basesIcon.uri) || changed;
            } else {
                // If Bases helper fields are disabled, actively clear legacy keys so they stop reappearing.
                const markdownField = String(settings.basesIconMarkdownField || "").trim() || "iconDisplay";
                const uriField = String(settings.basesIconUriField || "").trim() || "iconDisplayUri";
                changed = this.applyFrontmatterMutation(mutableFrontmatter, markdownField, null) || changed;
                changed = this.applyFrontmatterMutation(mutableFrontmatter, uriField, null) || changed;
            }

            if (desiredSortKey !== undefined) {
                changed = this.applyFrontmatterMutation(mutableFrontmatter, settings.smartSort.field, desiredSortKey) || changed;
            }

            if (this.applyTagMutations(mutableFrontmatter, hideChanges)) {
                changed = true;
            }

            if (changed) {
                if (this.shouldBatchAppliedRuleLog(options.reason)) {
                    this.enqueueAppliedRuleSummary(options.reason);
                } else {
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
            }

            return changed;
        });
    }

    private shouldBatchAppliedRuleLog(reason: string): boolean {
        return this.bulkAppliedRuleReasons.has(reason);
    }

    private enqueueAppliedRuleSummary(reason: string): void {
        this.pendingAppliedRuleSummary.set(reason, (this.pendingAppliedRuleSummary.get(reason) ?? 0) + 1);
        if (this.appliedRuleSummaryTimer !== null) {
            return;
        }

        this.appliedRuleSummaryTimer = window.setTimeout(() => {
            for (const [queuedReason, count] of this.pendingAppliedRuleSummary.entries()) {
                this.logger.debug("Applied rules to files", {
                    reason: queuedReason,
                    count,
                });
            }

            this.pendingAppliedRuleSummary.clear();
            this.appliedRuleSummaryTimer = null;
        }, 250);
    }

    buildRuleContext(
        file: TFile,
        frontmatterOverride: Record<string, unknown> | null | undefined,
        includeBacklinks = true,
        includeParent = true,
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

        const context: RuleEvaluationContext = {
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

        if (this.getSettings().smartSort.relationshipGrouping === "children-under-parent") {
            context.relationshipLineage = this.buildRelationshipLineage(file, frontmatter);
        }

        if (includeParent) {
            const lineageParent = context.relationshipLineage?.length && context.relationshipLineage.length > 1
                ? context.relationshipLineage[context.relationshipLineage.length - 2]
                : null;
            if (lineageParent) {
                context.parent = {
                    file: lineageParent.file,
                    frontmatter: lineageParent.frontmatter,
                    tags: lineageParent.tags,
                };
            } else {
                const parent = this.resolveParentContext(file, frontmatter);
                if (parent) {
                    context.parent = parent;
                }
            }
        }

        return context;
    }

    // ── Private helpers ────────────────────────────────────────────────────

    private async buildRuleContextWithBody(
        file: TFile,
        frontmatterOverride: Record<string, unknown> | null | undefined,
        options?: { includeBody?: boolean; includeBacklinks?: boolean; includeParent?: boolean },
    ): Promise<RuleEvaluationContext> {
        const includeBody = options?.includeBody ?? true;
        const includeBacklinks = options?.includeBacklinks ?? true;
        const includeParent = options?.includeParent ?? true;
        const context = this.buildRuleContext(file, frontmatterOverride, includeBacklinks, includeParent);

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

    private readFrontmatterString(frontmatter: Record<string, unknown>, key: string): string | null {
        const value = this.getFrontmatterValue(frontmatter, key);
        if (typeof value !== "string") return null;
        const trimmed = value.trim();
        return trimmed || null;
    }

    private composeBasesIconValues(
        iconValue: string | null | undefined,
        colorValue: string | null | undefined,
    ): { markdown: string | null | undefined; uri: string | null | undefined } {
        if (iconValue === undefined) {
            return { markdown: undefined, uri: undefined };
        }
        if (iconValue === null || !String(iconValue).trim()) {
            return { markdown: null, uri: null };
        }

        const iconId = this.normalizeLucideIconId(iconValue);
        if (!iconId) {
            return { markdown: null, uri: null };
        }

        const iconContainer = document.createElement("span");
        try {
            setIcon(iconContainer, iconId);
        } catch (_error) {
            return { markdown: null, uri: null };
        }

        const svg = iconContainer.querySelector("svg");
        if (!svg) {
            return { markdown: null, uri: null };
        }

        svg.setAttribute("width", "18");
        svg.setAttribute("height", "18");
        svg.setAttribute("viewBox", svg.getAttribute("viewBox") || "0 0 24 24");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke-width", svg.getAttribute("stroke-width") || "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");

        const safeColor = this.normalizeCssColorForSvg(colorValue ?? "");
        if (safeColor) {
            svg.setAttribute("stroke", safeColor);
        } else {
            svg.setAttribute("stroke", "currentColor");
        }

        const encodedSvg = encodeURIComponent(svg.outerHTML);
        const uri = `data:image/svg+xml;utf8,${encodedSvg}`;
        return {
            uri,
            markdown: `![](${uri})`,
        };
    }

    private normalizeLucideIconId(rawValue: string): string {
        const value = String(rawValue || "").trim();
        if (!value) return "";
        if (value.startsWith("lucide:")) return value.slice("lucide:".length).trim();
        if (value.startsWith("lucide-")) return value.slice("lucide-".length).trim();
        return value;
    }

    private normalizeCssColorForSvg(rawValue: string): string | null {
        const value = String(rawValue || "").trim();
        if (!value) return null;
        if (/[<>{}\n\r;]/.test(value)) return null;
        try {
            if (typeof CSS !== "undefined" && CSS.supports("color", value)) {
                return value;
            }
        } catch (_error) {
            // no-op fallback below
        }
        return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? value : null;
    }

    private applyFrontmatterMutation(
        mutableFrontmatter: Record<string, unknown>,
        key: string,
        desiredValue: string | null | undefined,
    ): boolean {
        if (this.isProtectedKey(key)) {
            this.logger.warn("Skipping mutation on protected calendar identity key", { key });
            return false;
        }

        if (desiredValue !== null && !this.metadataManager.validateFrontmatterValue(key, desiredValue)) {
            this.logger.warn("Skipping frontmatter mutation due to validation failure", { key, value: desiredValue });
            return false;
        }

        const normalizedTarget = key.trim().toLowerCase();
        const matchingKeys = Object.keys(mutableFrontmatter).filter(
            (existingKey) => existingKey.trim().toLowerCase() === normalizedTarget,
        );
        const exactKey = matchingKeys.find((existingKey) => existingKey === key) ?? null;
        const preferredExistingKey = exactKey ?? matchingKeys[0] ?? null;
        const previousCanonicalValue = String(mutableFrontmatter[key] ?? "");
        const preferredExistingValue = preferredExistingKey
            ? mutableFrontmatter[preferredExistingKey]
            : undefined;

        if (desiredValue === null && matchingKeys.length === 0) {
            return false;
        }
        if (
            desiredValue !== undefined &&
            desiredValue !== null &&
            matchingKeys.length === 1 &&
            matchingKeys[0] === key &&
            previousCanonicalValue === desiredValue
        ) {
            return false;
        }
        if (desiredValue === undefined && matchingKeys.length === 0) {
            return false;
        }
        if (desiredValue === undefined && matchingKeys.length === 1 && matchingKeys[0] === key) {
            return false;
        }

        if (desiredValue === null) {
            if (matchingKeys.length === 0) return false;
            for (const existingKey of matchingKeys) {
                delete mutableFrontmatter[existingKey];
            }
            return true;
        }

        const finalValue = desiredValue !== undefined
            ? desiredValue
            : (() => {
                if (preferredExistingValue === undefined) return undefined;
                const existingValue = preferredExistingValue;
                return typeof existingValue === "string" ? existingValue : String(existingValue ?? "");
            })();

        if (finalValue === undefined) {
            if (matchingKeys.length <= 1) return false;
            const keepKey = preferredExistingKey ?? key;
            const keepValue = preferredExistingValue;
            for (const existingKey of matchingKeys) {
                if (existingKey === keepKey) continue;
                delete mutableFrontmatter[existingKey];
            }
            if (preferredExistingKey && preferredExistingKey !== keepKey) {
                delete mutableFrontmatter[preferredExistingKey];
                mutableFrontmatter[keepKey] = keepValue as unknown;
            }
            return true;
        }

        if (matchingKeys.length === 0) {
            mutableFrontmatter[key] = finalValue;
            return true;
        }

        if (matchingKeys.length === 1) {
            const onlyKey = matchingKeys[0];
            const previousValue = typeof mutableFrontmatter[onlyKey] === "string"
                ? String(mutableFrontmatter[onlyKey] ?? "")
                : String(mutableFrontmatter[onlyKey] ?? "");
            if (onlyKey === key && previousValue === finalValue) {
                return false;
            }
            mutableFrontmatter[onlyKey] = finalValue;
            return previousValue !== finalValue;
        }

        const keepKey = preferredExistingKey ?? key;
        let changed = false;
        for (const existingKey of matchingKeys) {
            if (existingKey === keepKey) continue;
            delete mutableFrontmatter[existingKey];
            changed = true;
        }
        const previousValue = typeof mutableFrontmatter[keepKey] === "string"
            ? String(mutableFrontmatter[keepKey] ?? "")
            : String(mutableFrontmatter[keepKey] ?? "");
        mutableFrontmatter[keepKey] = finalValue;
        return changed || previousValue !== finalValue;
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

    private getRuleContextRequirements(): { includeBody: boolean; includeBacklinks: boolean; includeParent: boolean } {
        return {
            includeBody: this.settingsUseConditionSource("body"),
            includeBacklinks: this.settingsUseConditionSource("backlink"),
            includeParent: this.settingsUseParentConditionSources(),
        };
    }

    private settingsUseParentConditionSources(): boolean {
        const parentSources = new Set<RuleConditionSource>([
            "parent-frontmatter",
            "parent-tag",
            "parent-name",
            "parent-path",
        ]);

        const settings = this.getSettings();
        const usesParent = (conditions: RuleCondition[] | undefined): boolean => {
            if (!Array.isArray(conditions) || conditions.length === 0) return false;
            return conditions.some((condition) => parentSources.has(condition.source));
        };

        for (const rule of settings.rules) {
            if (rule.enabled && usesParent(rule.conditions)) return true;
        }
        for (const hideRule of settings.hideRules) {
            if (hideRule.enabled && usesParent(hideRule.conditions)) return true;
        }
        if (settings.smartSort.enabled) {
            for (const bucket of settings.smartSort.buckets) {
                if (!bucket.enabled) continue;
                if (usesParent(bucket.conditions)) return true;
                if (Array.isArray(bucket.conditionGroups)) {
                    for (const group of bucket.conditionGroups) {
                        if (usesParent(group.conditions)) return true;
                    }
                }
                if (bucket.sortCriteria.some((criteria) => parentSources.has(criteria.source))) {
                    return true;
                }
            }
        }

        return false;
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

    private resolveParentContext(
        file: TFile,
        frontmatter: Record<string, unknown> | null,
    ): RuleEvaluationContext["parent"] | undefined {
        const parentFile = this.resolveParentFile(file, frontmatter);
        if (!parentFile) return undefined;

        const parentFrontmatter = this.toFrontmatterRecord(this.app.metadataCache.getFileCache(parentFile)?.frontmatter);
        return {
            file: {
                path: parentFile.path,
                name: parentFile.name,
                basename: parentFile.basename,
                extension: parentFile.extension,
            },
            frontmatter: parentFrontmatter,
            tags: this.collectTagsFromCache(parentFile, parentFrontmatter),
        };
    }

    private resolveParentFile(file: TFile, frontmatter: Record<string, unknown> | null): TFile | null {
        if (!frontmatter) return null;

        const keys = this.getConfiguredParentLinkKeys();

        for (const key of keys) {
            const raw = this.getFrontmatterValue(frontmatter, key);
            const candidates = this.collectParentLinkCandidates(raw);
            for (const candidate of candidates) {
                const resolved = this.resolveLinkTargetToFile(candidate, file.path);
                if (resolved && resolved.path !== file.path) {
                    return resolved;
                }
            }
        }

        return null;
    }

    private buildRelationshipLineage(
        file: TFile,
        frontmatter: Record<string, unknown> | null,
    ): RelationshipLineageNode[] {
        const lineage: RelationshipLineageNode[] = [];
        const visited = new Set<string>();

        let currentFile: TFile | null = file;
        let currentFrontmatter = frontmatter;
        let depth = 0;

        while (currentFile && depth < 12) {
            if (visited.has(currentFile.path)) {
                break;
            }
            visited.add(currentFile.path);

            lineage.push(this.createRelationshipLineageNode(currentFile, currentFrontmatter));

            const parentFile = this.resolveParentFile(currentFile, currentFrontmatter);
            if (!parentFile || parentFile.path === currentFile.path) {
                break;
            }

            currentFile = parentFile;
            currentFrontmatter = this.toFrontmatterRecord(this.app.metadataCache.getFileCache(parentFile)?.frontmatter);
            depth += 1;
        }

        return lineage.reverse();
    }

    private createRelationshipLineageNode(
        file: TFile,
        frontmatter: Record<string, unknown> | null,
    ): RelationshipLineageNode {
        return {
            file: {
                path: file.path,
                name: file.name,
                basename: file.basename,
                extension: file.extension,
            },
            frontmatter,
            tags: this.collectTagsFromCache(file, frontmatter),
        };
    }

    private getConfiguredParentLinkKeys(): string[] {
        const configured = this.getSettings().upstreamLinkKeys || [];
        const pluginsRegistry = (this.app as any)?.plugins;
        const tpsPlugin =
            pluginsRegistry?.getPlugin?.("tps") ||
            pluginsRegistry?.plugins?.["tps"] ||
            pluginsRegistry?.getPlugin?.("tps-global-context-menu") ||
            pluginsRegistry?.plugins?.["tps-global-context-menu"] ||
            pluginsRegistry?.plugins?.["TPS-Global-Context-Menu (Dev)"];
        const gcmParentKey = (tpsPlugin as any)?.settings?.parentLinkFrontmatterKey;

        return Array.from(new Set([
            ...configured,
            gcmParentKey,
            "childOf",
            "parent",
        ].map((key) => String(key || "").trim()).filter(Boolean)));
    }

    private shouldSkipAfterFreshGcmWrite(path: string, reason: string): boolean {
        if (reason !== "metadata-change" && reason !== "modify-save" && reason !== "rename") {
            return false;
        }

        const pluginsRegistry = (this.app as any)?.plugins;
        const gcm =
            pluginsRegistry?.getPlugin?.("tps-global-context-menu") ||
            pluginsRegistry?.plugins?.["tps-global-context-menu"] ||
            pluginsRegistry?.plugins?.["TPS-Global-Context-Menu (Dev)"];
        const frontmatterApi = (gcm as any)?.api?.frontmatter;

        try {
            if (typeof frontmatterApi?.isWriteInProgress === "function" && frontmatterApi.isWriteInProgress(path)) {
                this.logger.debug("Skipping Companion auto-apply during TPS GCM write", { path, reason });
                return true;
            }
            if (typeof frontmatterApi?.wasRecentlyWritten === "function" && frontmatterApi.wasRecentlyWritten(path)) {
                this.logger.debug("Skipping Companion auto-apply immediately after TPS GCM write", { path, reason });
                return true;
            }
        } catch (error) {
            this.logger.debug("Fresh TPS GCM write check failed", { path, reason, error });
        }

        return false;
    }

    private collectParentLinkCandidates(raw: unknown): string[] {
        const output: string[] = [];
        const seen = new Set<string>();

        const add = (value: string): void => {
            const normalized = this.normalizeLinkTarget(value);
            if (!normalized) return;
            const key = normalized.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            output.push(normalized);
        };

        const walk = (value: unknown): void => {
            if (value == null) return;
            if (Array.isArray(value)) {
                for (const item of value) walk(item);
                return;
            }
            if (typeof value === "object") {
                for (const item of Object.values(value as Record<string, unknown>)) walk(item);
                return;
            }
            const text = String(value).trim();
            if (!text) return;
            const extracted = this.extractLinkTargetsFromText(text, true);
            if (extracted.length === 0) add(text);
            else extracted.forEach(add);
        };

        walk(raw);
        return output;
    }

    private extractLinkTargetsFromText(text: string, allowWhole = false): string[] {
        const result: string[] = [];
        const seen = new Set<string>();
        const push = (value: string): void => {
            const normalized = this.normalizeLinkTarget(value);
            if (!normalized) return;
            const key = normalized.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            result.push(normalized);
        };

        const wiki = /!?\[\[([^[\]]+)]]/g;
        let wikiMatch: RegExpExecArray | null;
        while ((wikiMatch = wiki.exec(text)) !== null) {
            push(wikiMatch[1]);
        }

        for (const mdTarget of this.extractMarkdownLinkTargets(text)) {
            push(mdTarget);
        }

        if (allowWhole && result.length === 0) {
            push(text);
        }

        return result;
    }

    private extractMarkdownLinkTargets(text: string): string[] {
        const targets: string[] = [];
        let i = 0;
        while (i < text.length) {
            const open = text.indexOf("[", i);
            if (open === -1) break;
            let close = open + 1;
            let escaped = false;
            while (close < text.length) {
                const ch = text[close];
                if (!escaped && ch === "]") break;
                escaped = !escaped && ch === "\\";
                close += 1;
            }
            if (close >= text.length || text[close + 1] !== "(") {
                i = close + 1;
                continue;
            }

            let cursor = close + 2;
            let depth = 1;
            let inAngles = false;
            escaped = false;
            while (cursor < text.length) {
                const ch = text[cursor];
                if (!escaped) {
                    if (ch === "<") inAngles = true;
                    else if (ch === ">") inAngles = false;
                    else if (!inAngles && ch === "(") depth += 1;
                    else if (!inAngles && ch === ")") {
                        depth -= 1;
                        if (depth === 0) break;
                    }
                }
                escaped = !escaped && ch === "\\";
                cursor += 1;
            }
            if (depth === 0 && cursor < text.length) {
                const target = text.slice(close + 2, cursor).trim();
                if (target) targets.push(target);
                i = cursor + 1;
            } else {
                i = close + 1;
            }
        }
        return targets;
    }

    private normalizeLinkTarget(raw: string): string | null {
        let value = String(raw || "").trim();
        if (!value) return null;
        if (value.startsWith("<") && value.endsWith(">")) {
            value = value.slice(1, -1).trim();
        }
        if (!value) return null;
        if (value.includes("|")) {
            value = value.split("|")[0].trim();
        }
        if (value.includes("#")) {
            value = value.split("#")[0].trim();
        }
        value = value.replace(/^\.\/+/, "").trim();
        if (!value) return null;
        try {
            value = decodeURI(value);
        } catch (_error) {
            // Keep original value if URI decode fails.
        }
        return value || null;
    }

    private resolveLinkTargetToFile(target: string, sourcePath: string): TFile | null {
        const normalized = this.normalizeLinkTarget(target);
        if (!normalized) return null;

        const rawPath = normalized;
        const noMd = rawPath.replace(/\.md$/i, "");
        const linkResolved =
            this.app.metadataCache.getFirstLinkpathDest(rawPath, sourcePath) ||
            this.app.metadataCache.getFirstLinkpathDest(noMd, sourcePath);
        if (linkResolved instanceof TFile) {
            return linkResolved;
        }

        const abs = normalizePath(rawPath);
        const direct = this.app.vault.getAbstractFileByPath(abs);
        if (direct instanceof TFile) {
            return direct;
        }

        const withMd = abs.endsWith(".md") ? abs : `${abs}.md`;
        const directMd = this.app.vault.getAbstractFileByPath(withMd);
        if (directMd instanceof TFile) {
            return directMd;
        }

        return null;
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
            this.setFrontmatterValueCaseInsensitive(mutableFrontmatter, "tags", Array.from(initialSet));
            return true;
        }
       return false;
   }

    private setFrontmatterValueCaseInsensitive(
        frontmatter: Record<string, unknown>,
        key: string,
        value: unknown,
    ): boolean {
        const normalizedKey = key.trim().toLowerCase();
        const matchingKeys = Object.keys(frontmatter).filter(
            (existingKey) => existingKey.trim().toLowerCase() === normalizedKey,
        );

        if (matchingKeys.length === 0) {
            frontmatter[key] = value;
            return true;
        }

        if (matchingKeys.length === 1) {
            const onlyKey = matchingKeys[0];
            const previousValue = frontmatter[onlyKey];
            frontmatter[onlyKey] = value;
            return previousValue !== value;
        }

        const keepKey = matchingKeys.find((existingKey) => existingKey === key) ?? matchingKeys[0];
        for (const existingKey of matchingKeys) {
            if (existingKey === keepKey) continue;
            delete frontmatter[existingKey];
        }
        frontmatter[keepKey] = value;
        return true;
    }

    private isMarkdownFile(file: TFile): boolean {
        return file instanceof TFile && file.extension === "md";
    }
}
