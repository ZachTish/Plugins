import { Component, MarkdownView, TFile, WorkspaceLeaf, debounce } from "obsidian";
import TPSGlobalContextMenuPlugin from "./main";
import * as logger from "./logger";
import { NormalizedViewMode, ViewModeService } from "./view-mode-service";
import { ViewModeRule } from "./types";

export class ViewModeManager extends Component {
    plugin: TPSGlobalContextMenuPlugin;
    private service = new ViewModeService();
    private applyingLeaves = new WeakSet<WorkspaceLeaf>();
    private lastDecisions = new WeakMap<WorkspaceLeaf, { filePath: string; mode: NormalizedViewMode; ts: number }>();
    private invalidModeWarnings = new Map<string, number>();

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        super();
        this.plugin = plugin;
    }

    onload() {
        // Debounce the event handler to prevent rapid firing when switching modes triggers updates
        const debouncedHandler = debounce(this.handleActiveLeafable.bind(this), 200, false);
        this.registerEvent(this.plugin.app.workspace.on('active-leaf-change', debouncedHandler));

        // Listen to metadata changes (handling race conditions where cache isn't ready on open)
        // Use longer debounce to prevent lag during typing
        const metadataDebouncedHandler = debounce((file: TFile) => {
            const leaf = this.plugin.app.workspace.activeLeaf;
            if (leaf && leaf.view instanceof MarkdownView && leaf.view.file === file) {
                debouncedHandler(leaf);
            }
        }, 350, false);

        this.plugin.registerEvent(this.plugin.app.metadataCache.on('changed', (file) => {
            metadataDebouncedHandler(file);
        }));

        this.plugin.addCommand({
            id: 'force-view-mode-check',
            name: 'Force View Mode Check',
            editorCallback: (editor, view) => {
                const leaf = this.plugin.app.workspace.activeLeaf;
                this.handleActiveLeafable(leaf ?? null);
            }
        });
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

        // Normalize mode
        // obsidian uses 'source' (which can be live preview or actual source) and 'preview' (reading)

        const state = leaf.getViewState();
        let needsUpdate = false;
        const currentDecision = this.lastDecisions.get(leaf);
        if (
            currentDecision &&
            currentDecision.filePath === file.path &&
            currentDecision.mode === targetMode &&
            Date.now() - currentDecision.ts < 1000 &&
            this.service.matchesMode(state, targetMode)
        ) {
            return;
        }

        logger.log(`[TPS GCM] Current State for ${file.basename}: mode=${state.state.mode}, source=${state.state.source}`);
        logger.log(`[TPS GCM] Target Mode: ${targetMode}`);

        const applied = this.service.applyModeToState(state, targetMode);
        needsUpdate = applied.needsUpdate;

        if (needsUpdate) {
            if (this.applyingLeaves.has(leaf)) return;
            logger.log(`[TPS GCM] Switching view mode for ${file.basename} to ${targetMode}`);
            try {
                this.applyingLeaves.add(leaf);
                // specific hack for the error "RangeError: Field is not present in this state"
                // which happens when setViewState interrupts a view that is trying to save history
                // We clone the state and ensure we are attending to the latest leaf version
                const newState = JSON.parse(JSON.stringify(applied.state));
                await leaf.setViewState(newState);
                this.lastDecisions.set(leaf, { filePath: file.path, mode: targetMode, ts: Date.now() });
            } catch (err) {
                logger.error(`[TPS GCM] Failed to set view state for ${file.basename}`, err);
            } finally {
                this.applyingLeaves.delete(leaf);
            }
        } else {
            this.lastDecisions.set(leaf, { filePath: file.path, mode: targetMode, ts: Date.now() });
            logger.log(`[TPS GCM] No update needed.`);
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

        window.setTimeout(() => {
            void this.handleActiveLeafable(activeLeaf);
        }, 30);
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
