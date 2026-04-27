import { Component, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";
import TPSGlobalContextMenuPlugin from "../main";
import * as logger from "../logger";
import { NormalizedViewMode, ViewModeService } from "../services/view-mode-service";
import { ViewModeRule } from "../types";

export class ViewModeManager extends Component {
    plugin: TPSGlobalContextMenuPlugin;
    private service = new ViewModeService();
    private applyingLeaves = new WeakSet<WorkspaceLeaf>();
    private lastDecisions = new WeakMap<WorkspaceLeaf, { filePath: string; mode: NormalizedViewMode; ts: number }>();
    private manualOverrides = new WeakMap<WorkspaceLeaf, { filePath: string; mode: NormalizedViewMode; ts: number }>();
    private pendingLeafChecks = new Map<WorkspaceLeaf, number>();
    private invalidModeWarnings = new Map<string, number>();

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        super();
        this.plugin = plugin;
    }

    onload() {
        this.registerEvent(this.plugin.app.workspace.on('active-leaf-change', () => {
            this.scheduleActiveLeafableCheck(this.plugin.app.workspace.activeLeaf, 0);
        }));
        this.registerEvent(this.plugin.app.workspace.on('file-open', () => {
            this.scheduleActiveLeafableCheck(this.plugin.app.workspace.activeLeaf, 0);
        }));
        this.registerEvent(this.plugin.app.workspace.on('layout-change', () => {
            this.scheduleActiveLeafableCheck(this.plugin.app.workspace.activeLeaf, 60);
        }));

        this.plugin.registerEvent(this.plugin.app.metadataCache.on('changed', (file) => {
            const leaf = this.plugin.app.workspace.activeLeaf;
            if (leaf && leaf.view instanceof MarkdownView && leaf.view.file === file) {
                this.scheduleActiveLeafableCheck(leaf, 80);
            }
        }));

        this.plugin.addCommand({
            id: 'force-view-mode-check',
            name: 'Force View Mode Check',
            editorCallback: (editor, view) => {
                const leaf = this.plugin.app.workspace.activeLeaf;
                this.handleActiveLeafable(leaf ?? null);
            }
        });

        this.plugin.app.workspace.onLayoutReady(() => {
            this.scheduleActiveLeafableCheck(this.plugin.app.workspace.activeLeaf, 0);
        });
    }

    private scheduleActiveLeafableCheck(leaf: WorkspaceLeaf | null, delayMs: number): void {
        if (!leaf) return;
        const existing = this.pendingLeafChecks.get(leaf);
        if (existing !== undefined) {
            window.clearTimeout(existing);
        }
        const timerId = window.setTimeout(() => {
            this.pendingLeafChecks.delete(leaf);
            void this.handleActiveLeafable(leaf);
        }, Math.max(0, delayMs));
        this.pendingLeafChecks.set(leaf, timerId);
    }

    async handleActiveLeafable(leaf: WorkspaceLeaf | null) {
        if (!this.plugin.settings.enableViewModeSwitching) {
            // logger.log('[TPS GCM] View Mode Switching Disabled via Settings');
            return;
        }
        if (typeof (this.plugin as any)?.shouldSkipViewModeSwitch === "function" && (this.plugin as any).shouldSkipViewModeSwitch()) {
            return;
        }

        // If no leaf passed (e.g. from file-open generic handler), try to get active leaf
        if (!leaf) {
            leaf = this.plugin.app.workspace.activeLeaf;
        }

        if (!leaf || !(leaf.view instanceof MarkdownView)) return;

        // Strict view type check to avoid interfering with custom views that inherit from MarkdownView (e.g. Kanban, Excalidraw, Feed Bases)
        if (leaf.view.getViewType() !== 'markdown') return;

        const view = leaf.view as MarkdownView;
        const file = view.file;
        if (!file) return;

        if (this.service.shouldIgnorePath(file.path, this.plugin.settings.viewModeIgnoredFolders)) {
            logger.log(`[TPS GCM] Skipping view mode check for ${file.basename} (Path ignored: ${file.path})`);
            return;
        }

        const cache = this.plugin.app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter as Record<string, unknown> | undefined;
        const resolved = this.service.resolveTargetMode(frontmatter, this.plugin.settings, {
            folderPath: file.parent?.path || "",
            path: file.path,
            filePath: file.path,
            basename: file.basename,
            filename: file.name,
            dailyNoteRelation: this.getDailyNoteRelation(file),
        });

        if (resolved.invalidExplicit) {
            const key = this.plugin.settings.viewModeFrontmatterKey || "viewmode";
            const warnKey = `${file.path}|${key}|${resolved.invalidExplicit}`;
            const lastWarnTs = this.invalidModeWarnings.get(warnKey) ?? 0;
            if (Date.now() - lastWarnTs > 60_000) {
                logger.log(`[TPS GCM] Frontmatter key '${key}' found value '${resolved.invalidExplicit}' which is not a valid mode. Ignoring.`);
                this.invalidModeWarnings.set(warnKey, Date.now());
            }
        }

        const targetMode = resolved.mode;

        if (!targetMode) return;
        if (await this.hasLinkedSubitems(file)) {
            logger.log(`[TPS GCM] Preserving current mode for ${file.basename} because linked subitems are present.`);
            logger.log('[TPS GCM] [ModeTrace] preserve-current-mode', {
                file: file.path,
                currentMode: String((leaf.getViewState() as any)?.state?.mode || ''),
                currentSourceFlag: Boolean((leaf.getViewState() as any)?.state?.source),
                targetMode,
                reason: 'linked-subitems-present',
            });
            this.schedulePostModeUiRefresh(file, targetMode);
            return;
        }
        const effectiveTargetMode = targetMode;

        // Normalize mode
        // obsidian uses 'source' (which can be live preview or actual source) and 'preview' (reading)

        const state = this.service.getViewLikeState(view);
        const currentMode = this.service.getCurrentMode(state);
        const existingOverride = this.manualOverrides.get(leaf);
        if (existingOverride && existingOverride.filePath !== file.path) {
            this.manualOverrides.delete(leaf);
        }

        let needsUpdate = false;
        const currentDecision = this.lastDecisions.get(leaf);
        const manualOverride = this.manualOverrides.get(leaf);
        if (manualOverride && manualOverride.filePath === file.path) {
            if (currentMode && currentMode !== manualOverride.mode) {
                this.manualOverrides.set(leaf, { filePath: file.path, mode: currentMode, ts: Date.now() });
            }
            logger.log('[TPS GCM] [ModeTrace] honoring-manual-override', {
                file: file.path,
                targetMode: effectiveTargetMode,
                currentMode,
                overrideMode: this.manualOverrides.get(leaf)?.mode ?? null,
            });
            return;
        }

        if (
            !this.applyingLeaves.has(leaf) &&
            currentMode &&
            currentMode !== effectiveTargetMode &&
            currentDecision?.filePath === file.path &&
            currentDecision.mode === effectiveTargetMode
        ) {
            this.manualOverrides.set(leaf, { filePath: file.path, mode: currentMode, ts: Date.now() });
            logger.log('[TPS GCM] [ModeTrace] recorded-manual-override', {
                file: file.path,
                targetMode: effectiveTargetMode,
                currentMode,
            });
            return;
        }

        if (
            currentDecision &&
            currentDecision.filePath === file.path &&
            currentDecision.mode === effectiveTargetMode &&
            Date.now() - currentDecision.ts < 1000 &&
            this.service.matchesMode(state, effectiveTargetMode)
        ) {
            return;
        }

        logger.log(`[TPS GCM] Current State for ${file.basename}: mode=${String((state as any).mode ?? (state as any)?.state?.mode ?? '')}, source=${String((state as any).source ?? (state as any)?.state?.source ?? '')}`);
        logger.log(`[TPS GCM] Target Mode: ${effectiveTargetMode}`);

        const applied = this.service.applyModeToState(state, effectiveTargetMode);
        needsUpdate = applied.needsUpdate;

        if (needsUpdate) {
            if (this.applyingLeaves.has(leaf)) return;
            logger.log(`[TPS GCM] Switching view mode for ${file.basename} to ${effectiveTargetMode}`);
            try {
                this.applyingLeaves.add(leaf);
                // specific hack for the error "RangeError: Field is not present in this state"
                // which happens when setViewState interrupts a view that is trying to save history
                // We clone the state and ensure we are attending to the latest leaf version
                const newState = JSON.parse(JSON.stringify(applied.state));
                await (view as any).setState(newState, { history: false });
                this.lastDecisions.set(leaf, { filePath: file.path, mode: effectiveTargetMode, ts: Date.now() });
                this.schedulePostModeUiRefresh(file, effectiveTargetMode);
            } catch (err) {
                logger.error(`[TPS GCM] Failed to set view state for ${file.basename}`, err);
            } finally {
                this.applyingLeaves.delete(leaf);
            }
        } else {
            this.lastDecisions.set(leaf, { filePath: file.path, mode: effectiveTargetMode, ts: Date.now() });
            this.schedulePostModeUiRefresh(file, effectiveTargetMode);
            logger.log(`[TPS GCM] No update needed.`);
        }
    }

    private schedulePostModeUiRefresh(file: TFile, mode: NormalizedViewMode): void {
        const run = (delayMs: number) => {
            const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
            if (!(activeView instanceof MarkdownView)) {
                logger.log('[TPS GCM] [ModeTrace] post-mode-refresh skipped', {
                    file: file.path,
                    targetMode: mode,
                    delayMs,
                    reason: 'no-active-markdown-view',
                });
                return;
            }
            if (activeView.file?.path !== file.path) {
                logger.log('[TPS GCM] [ModeTrace] post-mode-refresh skipped', {
                    file: file.path,
                    activeFile: activeView.file?.path ?? null,
                    targetMode: mode,
                    delayMs,
                    reason: 'active-view-file-mismatch',
                });
                return;
            }
            logger.log('[TPS GCM] [ModeTrace] post-mode-refresh running', {
                file: file.path,
                activeFile: activeView.file?.path ?? null,
                targetMode: mode,
                delayMs,
                activeMode: String((activeView.leaf.getViewState() as any)?.state?.mode || ''),
                activeSourceFlag: Boolean((activeView.leaf.getViewState() as any)?.state?.source),
            });
            this.plugin.linkedSubitemCheckboxService?.ensureForAllMarkdownViews();
            this.plugin.linkedSubitemCheckboxService?.refreshLivePreviewEditors();
        };

        window.setTimeout(() => run(0), 0);
        window.setTimeout(() => run(120), 120);
    }

    private async hasLinkedSubitems(file: TFile): Promise<boolean> {
        if (!this.plugin.settings.enableLinkedSubitemCheckboxes) return false;
        try {
            const text = await this.plugin.subitemRelationshipSyncService?.readMarkdownText(file);
            if (!text) return false;
            const matches = this.plugin.bodySubitemLinkService.scanText(file, text);
            logger.log('[TPS GCM] [ModeTrace] linked-subitem-scan', {
                file: file.path,
                matchCount: matches.length,
            });
            return matches.length > 0;
        } catch (error) {
            logger.warn(`[TPS GCM] Failed to evaluate linked subitems for mode preservation on ${file.path}`, error);
            return false;
        }
    }

    async handlePotentialFrontmatterChange(files: TFile[], updateKeys: string[]): Promise<void> {
        if (!this.plugin.settings.enableViewModeSwitching) return;
        const activeLeaf = this.plugin.app.workspace.activeLeaf;
        if (!activeLeaf || !(activeLeaf.view instanceof MarkdownView)) return;
        if (activeLeaf.view.getViewType() !== "markdown") return;
        const activeFile = activeLeaf.view.file;
        if (!activeFile) return;
        if (!files.some((f) => f.path === activeFile.path)) return;

        const touchedKeySet = new Set(updateKeys.map((k) => String(k || "").trim()));
        const ruleKeyMatch = (this.plugin.settings.viewModeRules || []).some((rule) => this.ruleTouchesUpdatedKeys(rule, touchedKeySet));
        const explicitKey = String(this.plugin.settings.viewModeFrontmatterKey || "").trim();
        if (!ruleKeyMatch && explicitKey && !touchedKeySet.has(explicitKey)) {
            return;
        }

        this.scheduleActiveLeafableCheck(activeLeaf, 30);
    }

    onunload(): void {
        for (const timerId of this.pendingLeafChecks.values()) {
            window.clearTimeout(timerId);
        }
        this.pendingLeafChecks.clear();
    }

    private ruleTouchesUpdatedKeys(rule: ViewModeRule, touchedKeys: Set<string>): boolean {
        const legacyKey = String(rule?.key ?? "").trim();
        if (legacyKey && touchedKeys.has(legacyKey)) return true;

        const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
        return conditions.some((condition) => {
            const type = String(condition?.type ?? "").trim().toLowerCase();
            if (type === "frontmatter") {
                const key = String(condition?.key ?? "").trim();
                return key ? touchedKeys.has(key) : false;
            }
            if (type === "scheduled") {
                const key = String(condition?.key ?? "scheduled").trim() || "scheduled";
                return touchedKeys.has(key);
            }
            return false;
        });
    }

    private getDailyNoteFormat(): string {
        try {
            const periodicNotes = (this.plugin.app as any)?.plugins?.getPlugin?.("periodic-notes");
            const periodicFormat = periodicNotes?.settings?.daily?.format;
            if (typeof periodicFormat === "string" && periodicFormat.trim()) {
                return periodicFormat.trim();
            }

            const internalPlugins = (this.plugin.app as any)?.internalPlugins;
            const dailyNotes = internalPlugins?.getPluginById?.("daily-notes");
            const coreFormat = dailyNotes?.instance?.options?.format;
            if (typeof coreFormat === "string" && coreFormat.trim()) {
                return coreFormat.trim();
            }
        } catch (error) {
            logger.warn("[TPS GCM] Failed to resolve daily note format for view mode rules", error);
        }
        return "YYYY-MM-DD";
    }

    private getDailyNoteRelation(file: TFile): "past" | "today" | "future" | "none" {
        const momentLib = (window as any)?.moment;
        if (!momentLib || !(file instanceof TFile)) return "none";

        const format = this.getDailyNoteFormat();
        const parsed = momentLib(file.basename, format, true);
        if (!parsed?.isValid?.()) return "none";

        const today = momentLib().startOf("day");
        const noteDay = parsed.startOf("day");
        if (noteDay.isBefore(today)) return "past";
        if (noteDay.isAfter(today)) return "future";
        return "today";
    }
}
