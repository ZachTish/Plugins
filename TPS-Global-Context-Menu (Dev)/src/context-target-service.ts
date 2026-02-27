import { App, TFile, TFolder, View } from 'obsidian';
import TPSGlobalContextMenuPlugin from './main';
import * as logger from "./logger";

type SelectionScope = 'notebook-navigator' | 'smart-explorer' | 'core-explorer' | 'unknown';

interface ResolveTargetOptions {
    allowActiveFileFallback?: boolean;
}

const NOTEBOOK_NAVIGATOR_SCOPE_SELECTOR =
    '.workspace-leaf-content[data-type="notebook-navigator"], .view-content.notebook-navigator';
const SMART_EXPLORER_SCOPE_SELECTOR =
    '.workspace-leaf-content[data-type="explorer2"], .workspace-leaf-content[data-type="smart-explorer"], .explorer2';
const CORE_EXPLORER_SCOPE_SELECTOR =
    '.workspace-leaf-content[data-type="file-explorer"], .nav-files-container';

export class ContextTargetService {
    plugin: TPSGlobalContextMenuPlugin;
    private lastContextTarget: HTMLElement | null = null;
    private lastContextTargetAt = 0;

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        this.plugin = plugin;
    }

    get app(): App {
        return this.plugin.app;
    }

    recordContextTarget(target: EventTarget | null): void {
        if (!(target instanceof HTMLElement)) return;
        this.lastContextTarget = target;
        this.lastContextTargetAt = Date.now();
    }

    peekRecentContextTarget(maxAgeMs = 1500): HTMLElement | null {
        return this.getRecentContextTarget(maxAgeMs);
    }

    consumeRecentContextTarget(maxAgeMs = 1500): HTMLElement | null {
        const target = this.getRecentContextTarget(maxAgeMs);
        this.lastContextTarget = null;
        this.lastContextTargetAt = 0;
        return target;
    }

    clearRecentContextTarget(): void {
        this.lastContextTarget = null;
        this.lastContextTargetAt = 0;
    }

    isNotebookNavigatorContextTarget(target: HTMLElement | null | undefined): boolean {
        if (!target) return false;
        if (target.closest(NOTEBOOK_NAVIGATOR_SCOPE_SELECTOR)) return true;
        const leafRoot = target.closest<HTMLElement>('.workspace-leaf-content');
        return leafRoot?.dataset?.type === 'notebook-navigator';
    }

    isNotebookNavigatorFileContextTarget(target: HTMLElement | null | undefined): boolean {
        if (!target || !this.isNotebookNavigatorContextTarget(target)) return false;

        const blockedControl = target.closest(
            [
                '.nn-pane-header',
                '.nn-header-actions',
                '.nn-icon-button',
                '.nn-pane-header-profile',
                '.nn-path-segment',
                '.nn-search-input-wrapper',
                '.nn-search-input-container',
                '.nn-search-input',
                '.nn-search-input-icon',
                '.nn-search-clear-button',
                '.nn-search-star-button',
                '.nn-search-help-button',
                '.nn-file-tag',
                '.nn-file-property',
                '.nn-clickable-tag',
                '.nn-navigation-calendar',
                '.nn-shortcuts-resize-handle',
                'button',
                'input',
                'select',
                'textarea',
                '[role="button"]',
                '[role="menuitem"]',
                '[role="option"]',
                '[contenteditable="true"]',
            ].join(', '),
        );
        if (blockedControl) return false;

        const fileNode = target.closest(
            '.nn-file, .nn-file-content, .nn-file-inner-content, .nn-navitem[data-nav-item-type="note"], .nn-navitem[data-nav-item-type="file"]',
        );
        if (!(fileNode instanceof HTMLElement)) return false;

        const resolvedPath = this.resolveExplorerPath(fileNode) ?? this.resolveExplorerPath(target);
        if (!resolvedPath) return false;
        const af = this.app.vault.getAbstractFileByPath(resolvedPath);
        return af instanceof TFile;
    }

    private getRecentContextTarget(maxAgeMs = 1500): HTMLElement | null {
        if (!this.lastContextTarget) return null;
        if (Date.now() - this.lastContextTargetAt > maxAgeMs) {
            this.lastContextTarget = null;
            return null;
        }
        return this.lastContextTarget;
    }

    isNativeMenuManagedTarget(target: HTMLElement | null): boolean {
        if (!target) return false;
        return !!target.closest(
            [
                NOTEBOOK_NAVIGATOR_SCOPE_SELECTOR,
                SMART_EXPLORER_SCOPE_SELECTOR,
                CORE_EXPLORER_SCOPE_SELECTOR,
                '.nav-file',
                '.nav-folder',
                '.tree-item',
                '.tree-item-self',
                '.explorer2-selected',
                '.search-result-file-title',
                '.search-result-file-match',
            ].join(', ')
        );
    }

    isManualContextInterceptTarget(target: HTMLElement | null): boolean {
        if (!target) return false;
        if (this.isNativeMenuManagedTarget(target)) return false;
        if (this.resolveEmbedTarget(target)) return true;

        // Bases/Calendar entries are not always rendered as links, but they often
        // carry a resolvable data-path for the underlying note.
        if (target.closest('.tps-calendar-entry, .bases-feed-entry, .bases-calendar-event-content')) {
            const path = this.resolveExplorerPath(target);
            if (typeof path === 'string' && path.trim().length > 0) {
                return true;
            }
        }

        const isLinkLike = !!target.closest('a.internal-link, .cm-link, [data-href], [data-linkpath], [data-file]');
        if (!isLinkLike) return false;

        return !!target.closest(
            [
                '.workspace-leaf-content[data-type="markdown"]',
                '.markdown-preview-view',
                '.markdown-source-view',
                '.cm-editor',
                '.sync-embed',
                '.sync-container',
                '.internal-embed',
                '.bases-feed-entry',
                '.tps-calendar-entry',
            ].join(', ')
        );
    }

    /**
     * Resolve the target file(s) based on the context of the event or selection.
     * Prioritizes:
     * 0. Canvas Node Selection (if valid).
     * 1. Files explicitly passed by the event (native context menu).
     * 2. Sync Embed marker near the click target (Reading Mode).
     * 3. Selected files in Explorer/Smart Explorer.
     * 4. The active leaf's file.
     */
    resolveTargets(explicitFiles?: TFile[], evt?: MouseEvent, options?: ResolveTargetOptions): TFile[] {
        const contextEl =
            evt?.target instanceof HTMLElement
                ? evt.target
                : this.getRecentContextTarget();
        const allowActiveFileFallback = options?.allowActiveFileFallback !== false;
        const contextInNotebookNavigator = this.isNotebookNavigatorContextTarget(contextEl);

        // 0. Canvas Node Selection (Priority over explicit file if clicking a node)
        if (evt) {
            const canvasFile = this.resolveCanvasTarget(evt);
            if (canvasFile) return [canvasFile];
        }

        // 1. Explicit files from native menu event
        const normalizedExplicitFiles = (explicitFiles || []).filter(
            (file): file is TFile => file instanceof TFile,
        );
        if (normalizedExplicitFiles.length > 0) {
            if (contextInNotebookNavigator && !this.isNotebookNavigatorFileContextTarget(contextEl)) {
                logger.log('[Context Target] Ignoring explicit files for non-file Notebook Navigator target');
                return [];
            }
            const expanded = this.expandSelection(normalizedExplicitFiles, contextEl);
            if (expanded.length > 0) return expanded;
            return normalizedExplicitFiles;
        }

        // 2. Click Event Target (Sync Embeds, links, explorer nodes)
        if (contextEl) {
            const embedFile = this.resolveEmbedTarget(contextEl);
            if (embedFile) return [embedFile];

            const explorerPath = this.resolveExplorerPath(contextEl);
            if (explorerPath) {
                const af = this.app.vault.getAbstractFileByPath(explorerPath);
                if (af instanceof TFolder) {
                    return [];
                }
                if (af instanceof TFile) {
                    const expanded = this.expandSelection([af], contextEl);
                    return expanded.length > 0 ? expanded : [af];
                }
            }
        }

        // 3. Active Leaf Fallback
        if (allowActiveFileFallback) {
            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) return [activeFile];
        }

        return [];
    }

    /**
     * Resolve file from Canvas Node selection.
     */
    resolveCanvasTarget(evt: MouseEvent | undefined): TFile | null {
        const view = this.app.workspace.getActiveViewOfType(View);
        logger.log('[Target Service] Checking Canvas Target. View Type:', view?.getViewType());

        if (!view || (view.getViewType() !== 'canvas' && view.getViewType() !== 'json')) return null;

        if (evt && evt.target instanceof HTMLElement) {
            const inCanvas = evt.target.closest('.canvas-wrapper') || evt.target.closest('.canvas-node');
            if (!inCanvas) {
                logger.log('[Target Service] Click target not in canvas wrapper/node.');
                return null;
            }
        }

        const canvas = (view as any).canvas;
        if (!canvas) {
            logger.log('[Target Service] No canvas object found on view.');
            return null;
        }

        const selection = canvas.selection;
        logger.log('[Target Service] Canvas Selection Size:', selection?.size);

        if (selection && selection.size === 1) {
            const node = selection.values().next().value;
            logger.log('[Target Service] Selected Node:', node);

            if (node.file instanceof TFile) {
                logger.log('[Target Service] Found node.file:', node.file.path);
                return node.file;
            }
            if (node.filePath) {
                const file = this.app.vault.getAbstractFileByPath(node.filePath);
                logger.log('[Target Service] Found node.filePath resolved:', file?.path);
                if (file instanceof TFile) return file;
            }
        }
        return null;
    }

    /**
     * Expand the selection to include multiple files if they are selected in the active context.
     */
    expandSelection(primaryFiles: TFile[], contextEl?: HTMLElement | null): TFile[] {
        if (primaryFiles.length === 0) return [];

        const uniquePrimary = this.mergeFileLists([primaryFiles]);
        const selection = this.getSelectedFiles(contextEl, uniquePrimary);

        if (selection.length <= 1) {
            return uniquePrimary;
        }

        const selectionPaths = new Set(selection.map((file) => file.path));
        const primaryInSelection = uniquePrimary.every((file) => selectionPaths.has(file.path));

        if (primaryInSelection) {
            return selection;
        }

        logger.warn('[Context Target] Selection mismatch - falling back to explicit files', {
            primary: uniquePrimary.map((file) => file.path),
            selection: selection.map((file) => file.path),
        });
        return uniquePrimary;
    }

    /**
     * Get selected files from the relevant UI scope only.
     */
    getSelectedFiles(contextEl?: HTMLElement | null, primaryFiles: TFile[] = []): TFile[] {
        const scope = this.detectSelectionScope(contextEl);
        const sourceCounts: Record<string, number> = {
            nnApi: 0,
            nnDom: 0,
            nnStorage: 0,
            nnView: 0,
            smartExplorer: 0,
            coreExplorer: 0,
        };

        let resolved: TFile[] = [];
        if (scope === 'notebook-navigator') {
            const nnApi = this.getNotebookNavigatorSelectionFromApi();
            const nnDom = this.getNotebookNavigatorSelectionFromDom(contextEl);
            const nnStorage = this.getNotebookNavigatorSelectionFromStorage();
            const nnView = this.getNotebookNavigatorSelectionFromView(contextEl);
            sourceCounts.nnApi = nnApi.length;
            sourceCounts.nnDom = nnDom.length;
            sourceCounts.nnStorage = nnStorage.length;
            sourceCounts.nnView = nnView.length;
            const liveResolved = this.mergeFileLists([nnApi, nnDom, nnView]);
            const storageResolved = this.mergeFileLists([nnStorage]);
            resolved = this.chooseNotebookNavigatorSelection(liveResolved, storageResolved, primaryFiles);
        } else if (scope === 'smart-explorer') {
            const smart = this.getSmartExplorerSelectedFiles(contextEl);
            sourceCounts.smartExplorer = smart.length;
            resolved = smart;
        } else if (scope === 'core-explorer') {
            const core = this.getCoreExplorerSelectedFiles(contextEl);
            sourceCounts.coreExplorer = core.length;
            resolved = core;
        } else {
            // Unknown scope: prefer the strongest currently visible selection source.
            const core = this.getCoreExplorerSelectedFiles();
            const smart = this.getSmartExplorerSelectedFiles();
            sourceCounts.coreExplorer = core.length;
            sourceCounts.smartExplorer = smart.length;

            const shouldTryNotebookNavigator =
                this.isNotebookNavigatorActive(contextEl) || this.hasVisibleNotebookNavigatorSelection(contextEl);
            let nnResolved: TFile[] = [];
            if (shouldTryNotebookNavigator) {
                const nnApi = this.getNotebookNavigatorSelectionFromApi();
                const nnDom = this.getNotebookNavigatorSelectionFromDom(contextEl);
                const nnStorage = this.getNotebookNavigatorSelectionFromStorage();
                const nnView = this.getNotebookNavigatorSelectionFromView(contextEl);
                sourceCounts.nnApi = nnApi.length;
                sourceCounts.nnDom = nnDom.length;
                sourceCounts.nnStorage = nnStorage.length;
                sourceCounts.nnView = nnView.length;
                const nnLive = this.mergeFileLists([nnApi, nnDom, nnView]);
                const nnStored = this.mergeFileLists([nnStorage]);
                nnResolved = this.chooseNotebookNavigatorSelection(nnLive, nnStored, primaryFiles);
            }

            if (nnResolved.length > smart.length && nnResolved.length > core.length) {
                resolved = nnResolved;
            } else if (smart.length > core.length) {
                resolved = smart;
            } else if (core.length > 0) {
                resolved = core;
            } else if (nnResolved.length > 0) {
                resolved = nnResolved;
            }
        }

        logger.log('[Context Target] getSelectedFiles resolved', {
            resolved: resolved.length,
            scope,
            sourceCounts,
        });
        if (scope === 'notebook-navigator') {
            logger.log(
                `[Context Target] NN source counts: api=${sourceCounts.nnApi} dom=${sourceCounts.nnDom} storage=${sourceCounts.nnStorage} view=${sourceCounts.nnView} -> resolved=${resolved.length} primary=${primaryFiles.length}`,
            );
        }
        return resolved;
    }

    private detectSelectionScope(contextEl?: HTMLElement | null): SelectionScope {
        if (!contextEl) return this.getActiveLeafScope();
        if (contextEl.closest(NOTEBOOK_NAVIGATOR_SCOPE_SELECTOR)) return 'notebook-navigator';
        if (contextEl.closest(SMART_EXPLORER_SCOPE_SELECTOR)) return 'smart-explorer';
        if (contextEl.closest(CORE_EXPLORER_SCOPE_SELECTOR) || contextEl.closest('.nav-file, .nav-folder, .tree-item, .tree-item-self')) {
            return 'core-explorer';
        }
        const leafRoot = contextEl.closest<HTMLElement>('.workspace-leaf-content');
        if (leafRoot?.dataset?.type === 'notebook-navigator') return 'notebook-navigator';
        if (leafRoot?.dataset?.type === 'explorer2' || leafRoot?.dataset?.type === 'smart-explorer') return 'smart-explorer';
        if (leafRoot?.dataset?.type === 'file-explorer') return 'core-explorer';
        return this.getActiveLeafScope();
    }

    private getActiveLeafScope(): SelectionScope {
        const view: any = this.app.workspace.activeLeaf?.view;
        const viewType = typeof view?.getViewType === 'function' ? view.getViewType() : '';
        if (viewType === 'notebook-navigator') return 'notebook-navigator';
        if (viewType === 'explorer2' || viewType === 'smart-explorer') return 'smart-explorer';
        if (viewType === 'file-explorer') return 'core-explorer';
        return 'unknown';
    }

    private getScopeRoot(contextEl: HTMLElement | null | undefined, scope: SelectionScope): HTMLElement | null {
        if (!contextEl) return null;
        if (scope === 'notebook-navigator') {
            return contextEl.closest(NOTEBOOK_NAVIGATOR_SCOPE_SELECTOR);
        }
        if (scope === 'smart-explorer') {
            return contextEl.closest(SMART_EXPLORER_SCOPE_SELECTOR);
        }
        if (scope === 'core-explorer') {
            return contextEl.closest(CORE_EXPLORER_SCOPE_SELECTOR) || contextEl.closest('.workspace-leaf-content');
        }
        return contextEl.closest('.workspace-leaf-content');
    }

    private mergeFileLists(lists: TFile[][]): TFile[] {
        const out = new Map<string, TFile>();
        for (const list of lists) {
            for (const file of list) {
                if (!(file instanceof TFile)) continue;
                out.set(file.path, file);
            }
        }
        return Array.from(out.values());
    }

    private pushPathToMap(out: Map<string, TFile>, rawPath: unknown): void {
        if (typeof rawPath !== 'string') return;
        const path = rawPath.trim();
        if (!path) return;

        const direct = this.app.vault.getAbstractFileByPath(path);
        if (direct instanceof TFile) {
            out.set(direct.path, direct);
            return;
        }
        const resolved = this.app.metadataCache.getFirstLinkpathDest(path, "");
        if (resolved instanceof TFile) {
            out.set(resolved.path, resolved);
        }
    }

    private resolvePathFromElement(el: HTMLElement): string | null {
        const datasetCandidates = [
            el.dataset.path,
            (el.dataset as any).filePath,
            (el.dataset as any).filepath,
            el.dataset.linkpath,
            el.dataset.href,
            el.dataset.file,
        ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

        const nested = el.querySelector<HTMLElement>('[data-path], [data-file-path], [data-filepath], [data-linkpath], [data-href], [data-file]');
        if (nested) {
            datasetCandidates.push(
                nested.dataset.path || "",
                (nested.dataset as any).filePath || "",
                (nested.dataset as any).filepath || "",
                nested.dataset.linkpath || "",
                nested.dataset.href || "",
                nested.dataset.file || "",
            );
        }

        for (const raw of datasetCandidates) {
            const candidate = String(raw || '').trim();
            if (!candidate) continue;
            const byPath = this.app.vault.getAbstractFileByPath(candidate);
            if (byPath instanceof TFile) return byPath.path;
            const byLink = this.app.metadataCache.getFirstLinkpathDest(candidate, "");
            if (byLink instanceof TFile) return byLink.path;
        }

        return null;
    }

    private getNotebookNavigatorSelectionFromDom(contextEl?: HTMLElement | null): TFile[] {
        const out = new Map<string, TFile>();
        const scopeRoot = this.getScopeRoot(contextEl, 'notebook-navigator');
        const root: ParentNode = scopeRoot ?? document;

        const nodes = Array.from(
            root.querySelectorAll<HTMLElement>(
                '.nn-file.nn-selected, ' +
                '.nn-file.is-selected, ' +
                '.nn-navitem.nn-selected, ' +
                '.nn-selected, ' +
                '.nn-context-menu-active, ' +
                '.nn-file[aria-selected="true"], ' +
                '.nn-navitem[aria-selected="true"], ' +
                '[data-path][aria-selected="true"]'
            ),
        );

        for (const node of nodes) {
            if (node.getClientRects().length === 0) continue;
            const resolvedPath = this.resolvePathFromElement(node);
            this.pushPathToMap(out, resolvedPath);
        }

        return Array.from(out.values());
    }

    private getSmartExplorerSelectedFiles(contextEl?: HTMLElement | null): TFile[] {
        const out = new Map<string, TFile>();
        const scopeRoot = this.getScopeRoot(contextEl, 'smart-explorer');
        const root: ParentNode = scopeRoot ?? document;

        const nodes = Array.from(
            root.querySelectorAll<HTMLElement>(
                '.explorer2-selected[data-path], ' +
                '.workspace-leaf-content[data-type="explorer2"] .is-selected[data-path], ' +
                '.workspace-leaf-content[data-type="smart-explorer"] .is-selected[data-path]'
            ),
        );

        for (const node of nodes) {
            if (node.getClientRects().length === 0) continue;
            this.pushPathToMap(out, node.dataset.path || node.getAttribute('data-path'));
        }

        return Array.from(out.values());
    }

    private getCoreExplorerSelectedFiles(contextEl?: HTMLElement | null): TFile[] {
        const out = new Map<string, TFile>();
        const scopeRoot = this.getScopeRoot(contextEl, 'core-explorer');
        const root: ParentNode = scopeRoot ?? document;

        const nodes = Array.from(
            root.querySelectorAll<HTMLElement>(
                '.nav-file.is-selected[data-path], ' +
                '.tree-item-self.is-selected[data-path], ' +
                '.tree-item.is-selected[data-path], ' +
                '.workspace-leaf-content[data-type="file-explorer"] .is-selected[data-path]'
            ),
        );

        for (const node of nodes) {
            if (node.getClientRects().length === 0) continue;
            this.pushPathToMap(out, node.dataset.path || node.getAttribute('data-path'));
        }

        return Array.from(out.values());
    }

    private isNotebookNavigatorActive(contextEl?: HTMLElement | null): boolean {
        if (contextEl && contextEl.closest(NOTEBOOK_NAVIGATOR_SCOPE_SELECTOR)) {
            return true;
        }
        const view: any = this.app.workspace.activeLeaf?.view;
        if (!!view && typeof view.getViewType === 'function' && view.getViewType() === 'notebook-navigator') {
            return true;
        }
        return this.hasVisibleNotebookNavigatorSelection(contextEl);
    }

    private hasVisibleNotebookNavigatorSelection(contextEl?: HTMLElement | null): boolean {
        const scopeRoot = this.getScopeRoot(contextEl, 'notebook-navigator');
        const root: ParentNode = scopeRoot ?? document;
        const nodes = Array.from(
            root.querySelectorAll<HTMLElement>(
                '.nn-file.nn-selected, .nn-file.is-selected, .nn-navitem.nn-selected, .nn-selected, .nn-context-menu-active, [data-path][aria-selected="true"]',
            ),
        );
        return nodes.some((node) => node.getClientRects().length > 0);
    }

    private chooseNotebookNavigatorSelection(
        liveSelection: TFile[],
        storageSelection: TFile[],
        primaryFiles: TFile[],
    ): TFile[] {
        const primaryPaths = new Set(primaryFiles.map((file) => file.path));
        const containsPrimary = (selection: TFile[]): boolean => {
            if (primaryPaths.size === 0) return true;
            const paths = new Set(selection.map((file) => file.path));
            for (const path of primaryPaths) {
                if (!paths.has(path)) return false;
            }
            return true;
        };

        const live = this.mergeFileLists([liveSelection]);
        const stored = this.mergeFileLists([storageSelection]);
        const liveHasPrimary = containsPrimary(live);
        const storedHasPrimary = containsPrimary(stored);

        if (live.length === 0 && stored.length === 0) return [];
        if (live.length === 0) return storedHasPrimary ? stored : [];
        if (stored.length === 0) return liveHasPrimary ? live : [];

        if (!liveHasPrimary && storedHasPrimary) return stored;
        if (liveHasPrimary && !storedHasPrimary) return live;
        if (!liveHasPrimary && !storedHasPrimary) return [];

        const overlap = this.selectionOverlapRatio(live, stored);
        if (stored.length > live.length && overlap >= 0.8) {
            return this.mergeFileLists([live, stored]);
        }
        return live;
    }

    private selectionOverlapRatio(a: TFile[], b: TFile[]): number {
        if (a.length === 0 || b.length === 0) return 0;
        const aPaths = new Set(a.map((file) => file.path));
        const bPaths = new Set(b.map((file) => file.path));
        let intersection = 0;
        for (const path of aPaths) {
            if (bPaths.has(path)) intersection += 1;
        }
        return intersection / Math.min(aPaths.size, bPaths.size);
    }

    private getNotebookNavigatorSelectionFromStorage(): TFile[] {
        const out = new Map<string, TFile>();
        const collect = (value: unknown) => {
            if (!value) return;
            if (typeof value === 'string') {
                this.pushPathToMap(out, value);
                return;
            }
            if (Array.isArray(value)) {
                value.forEach((entry) => collect(entry));
                return;
            }
            if (value instanceof Set) {
                value.forEach((entry) => collect(entry));
                return;
            }
            if (value instanceof Map) {
                value.forEach((entry, key) => {
                    collect(key);
                    collect(entry);
                });
                return;
            }
            if (typeof value === 'object') {
                const v = value as Record<string, unknown>;
                this.pushPathToMap(out, v.path);
                this.pushPathToMap(out, v.file);
                this.pushPathToMap(out, v.filePath);
                this.pushPathToMap(out, v.filepath);
                this.pushPathToMap(out, v.value);
                this.pushPathToMap(out, v.id);
                if (Array.isArray(v.items)) collect(v.items);
                if (Array.isArray(v.files)) collect(v.files);
                if (Array.isArray(v.paths)) collect(v.paths);
                if (Array.isArray(v.selected)) collect(v.selected);
                if (Array.isArray(v.selectedFiles)) collect(v.selectedFiles);
                if (Array.isArray(v.values)) collect(v.values);
            }
        };

        const readStorageKey = (key: string) => {
            let raw: string | null = null;
            try {
                raw = window.localStorage.getItem(key);
            } catch {
                return;
            }
            if (!raw || !raw.trim()) return;

            const trimmed = raw.trim();
            if (!trimmed) return;

            try {
                collect(JSON.parse(trimmed));
            } catch {
                trimmed
                    .split(/[\n,]/g)
                    .map((entry) => entry.trim())
                    .filter(Boolean)
                    .forEach((entry) => this.pushPathToMap(out, entry));
            }
        };

        readStorageKey('notebook-navigator-selected-files');
        readStorageKey('Notebook-Navigator-selected-files');
        readStorageKey('notebook-navigator-selected-file');
        readStorageKey('Notebook-Navigator-selected-file');

        return Array.from(out.values());
    }

    private getNotebookNavigatorSelectionFromApi(): TFile[] {
        const out = new Map<string, TFile>();
        const pushFile = (file: unknown) => {
            if (file instanceof TFile) {
                out.set(file.path, file);
            }
        };
        const collect = (value: unknown, depth = 0) => {
            if (depth > 4 || !value) return;
            pushFile(value);
            if (typeof value === 'string') {
                this.pushPathToMap(out, value);
                return;
            }
            if (Array.isArray(value)) {
                value.forEach((entry) => collect(entry, depth + 1));
                return;
            }
            if (value instanceof Set) {
                value.forEach((entry) => collect(entry, depth + 1));
                return;
            }
            if (value instanceof Map) {
                value.forEach((entry, key) => {
                    collect(key, depth + 1);
                    collect(entry, depth + 1);
                });
                return;
            }
            if (typeof value === 'object') {
                const obj = value as Record<string, unknown>;
                this.pushPathToMap(out, obj.path);
                this.pushPathToMap(out, obj.filePath);
                this.pushPathToMap(out, obj.filepath);
                this.pushPathToMap(out, obj.file);
                this.pushPathToMap(out, obj.id);
                collect(obj.selectedFiles, depth + 1);
                collect(obj.selectedFile, depth + 1);
                collect(obj.files, depth + 1);
                collect(obj.paths, depth + 1);
                collect(obj.selection, depth + 1);
                collect(obj.state, depth + 1);
                collect(obj.selectionState, depth + 1);
                collect(obj.current, depth + 1);
                collect(obj.currentState, depth + 1);
                collect(obj.focused, depth + 1);
                collect(obj.primaryFile, depth + 1);
            }
        };

        const pluginsApi: any = (this.app as any)?.plugins;
        const notebookNavigator: any =
            pluginsApi?.plugins?.['notebook-navigator'] ??
            pluginsApi?.getPlugin?.('notebook-navigator');
        const selectionApi: any =
            notebookNavigator?.api?.selection ??
            notebookNavigator?.instance?.api?.selection ??
            notebookNavigator?.plugin?.api?.selection;
        if (!selectionApi) return [];

        const tryCall = (methodName: string) => {
            const fn = selectionApi?.[methodName];
            if (typeof fn !== 'function') return;
            try {
                collect(fn.call(selectionApi), 0);
            } catch {
                // Best effort.
            }
        };

        tryCall('getSelectedFiles');
        tryCall('getFileState');
        tryCall('getSelectionState');
        tryCall('getState');
        tryCall('getSelection');
        tryCall('getNavItem');
        tryCall('getSelectedFile');
        tryCall('getCurrent');
        tryCall('getCurrentState');

        collect(selectionApi.selectedFiles, 0);
        collect(selectionApi.selectedFile, 0);
        collect(selectionApi.state, 0);
        collect(selectionApi.selection, 0);
        collect(selectionApi.selectionState, 0);
        collect(selectionApi.current, 0);
        collect(selectionApi.currentState, 0);
        collect(selectionApi.files, 0);
        collect(selectionApi.focused, 0);
        collect(selectionApi.primaryFile, 0);

        return Array.from(out.values());
    }

    private resolveNotebookNavigatorView(contextEl?: HTMLElement | null): any {
        const leaves = this.app.workspace.getLeavesOfType('notebook-navigator');
        if (!leaves.length) return null;

        const scopeRoot = this.getScopeRoot(contextEl, 'notebook-navigator');
        if (scopeRoot) {
            for (const leaf of leaves) {
                const view: any = (leaf as any)?.view;
                const containerEl: HTMLElement | undefined = view?.containerEl;
                const contentEl: HTMLElement | undefined = view?.contentEl;
                if ((containerEl && containerEl.contains(scopeRoot)) || (contentEl && contentEl.contains(scopeRoot))) {
                    return view;
                }
            }
        }

        const activeView: any = this.app.workspace.activeLeaf?.view;
        if (activeView && typeof activeView.getViewType === 'function' && activeView.getViewType() === 'notebook-navigator') {
            return activeView;
        }

        return (leaves[0] as any)?.view ?? null;
    }

    private getNotebookNavigatorSelectionFromView(contextEl?: HTMLElement | null): TFile[] {
        const out = new Map<string, TFile>();
        const pushFile = (value: unknown) => {
            if (value instanceof TFile) {
                out.set(value.path, value);
            }
        };

        const view: any = this.resolveNotebookNavigatorView(contextEl);
        if (!view || typeof view.getViewType !== 'function' || view.getViewType() !== 'notebook-navigator') {
            return [];
        }

        const visited = new Set<any>();
        const queue: Array<{ value: any; depth: number; keyHint: string }> = [{ value: view, depth: 0, keyHint: 'root' }];
        const maxDepth = 4;
        const maxNodes = 2000;
        let scanned = 0;
        const likelySelectionKey = /(select|selected|selection|multi|highlight|context|active)/i;

        while (queue.length > 0 && scanned < maxNodes) {
            const current = queue.shift();
            if (!current) continue;
            const { value, depth, keyHint } = current;
            scanned += 1;

            if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
            if (visited.has(value)) continue;
            visited.add(value);

            pushFile(value);
            if (typeof value === 'string') {
                this.pushPathToMap(out, value);
                continue;
            }

            if (Array.isArray(value)) {
                if (depth < maxDepth) {
                    value.forEach((entry) => queue.push({ value: entry, depth: depth + 1, keyHint }));
                }
                continue;
            }

            if (value instanceof Set) {
                if (depth < maxDepth) {
                    value.forEach((entry: any) => queue.push({ value: entry, depth: depth + 1, keyHint }));
                }
                continue;
            }

            if (value instanceof Map) {
                if (depth < maxDepth) {
                    value.forEach((entry: any, key: any) => {
                        if (likelySelectionKey.test(String(key ?? '')) || likelySelectionKey.test(keyHint)) {
                            queue.push({ value: entry, depth: depth + 1, keyHint: String(key) });
                        }
                    });
                }
                continue;
            }

            if (depth >= maxDepth) continue;

            const keys = Object.keys(value);
            for (const key of keys) {
                let child: any;
                try {
                    child = value[key];
                } catch {
                    continue;
                }

                if (child instanceof TFile) {
                    out.set(child.path, child);
                    continue;
                }
                if (typeof child === 'string') {
                    if (likelySelectionKey.test(key) || key.toLowerCase().includes('path')) {
                        this.pushPathToMap(out, child);
                    }
                    continue;
                }
                if (likelySelectionKey.test(key) || depth <= 1) {
                    queue.push({ value: child, depth: depth + 1, keyHint: key });
                }
            }
        }

        return Array.from(out.values());
    }

    /**
     * Generic method to resolve a file from a DOM element.
     * Looks for:
     * 1. 'data-path' attribute on the element or ancestors.
     * 2. 'data-href' on internal links.
     * 3. 'data-file'/'data-linkpath' attributes.
     */
    resolveExplorerPath(target: HTMLElement): string | null {
        const item = target.closest(
            '.nav-file, .nav-folder, .tree-item, .tree-item-self, .tps-calendar-entry, .bases-feed-entry, .nn-file, .nn-navitem, .nn-path-segment, [data-path]',
        );

        if (item instanceof HTMLElement && item.dataset.path) {
            return item.dataset.path;
        }

        const link = target.closest('a.internal-link');
        if (link instanceof HTMLElement && link.dataset.href) {
            const resolved = this.app.metadataCache.getFirstLinkpathDest(link.dataset.href, "");
            if (resolved instanceof TFile) return resolved.path;
        }

        const dataHref = target.closest('[data-href]');
        if (dataHref instanceof HTMLElement && dataHref.dataset.href) {
            const resolved = this.app.metadataCache.getFirstLinkpathDest(dataHref.dataset.href, "");
            if (resolved instanceof TFile) return resolved.path;
        }

        const dataLinkPath = target.closest('[data-linkpath]');
        if (dataLinkPath instanceof HTMLElement && dataLinkPath.dataset.linkpath) {
            const resolved = this.app.metadataCache.getFirstLinkpathDest(dataLinkPath.dataset.linkpath, "");
            if (resolved instanceof TFile) return resolved.path;
        }

        const dataFile = target.closest('[data-file]');
        if (dataFile instanceof HTMLElement && dataFile.dataset.file) {
            const resolved = this.app.metadataCache.getFirstLinkpathDest(dataFile.dataset.file, "");
            if (resolved instanceof TFile) return resolved.path;
        }

        return null;
    }

    /**
     * Attempt to resolve a file from a Sync Embed click target in Reading Mode.
     */
    resolveEmbedTarget(target: HTMLElement): TFile | null {
        const container = target.closest('.block-language-sync, .cm-embed-block, .sync-embed, .sync-container');
        if (!container) return null;

        let markerSpan: HTMLElement | null = null;

        let prev = container.previousElementSibling;
        for (let i = 0; i < 3 && prev && !markerSpan; i++) {
            if (prev instanceof HTMLElement && prev.dataset?.calendarEmbed) {
                markerSpan = prev;
                break;
            }
            const innerSpan = prev.querySelector?.('span[data-calendar-embed]');
            if (innerSpan instanceof HTMLElement) {
                markerSpan = innerSpan;
                break;
            }
            prev = prev.previousElementSibling;
        }

        if (!markerSpan && container.parentElement) {
            const allMarkers = container.parentElement.querySelectorAll('span[data-calendar-embed]');
            for (const marker of Array.from(allMarkers)) {
                if (!(marker instanceof HTMLElement)) continue;
                const markerIndex = Array.from(container.parentElement.children).indexOf(
                    marker.closest('.markdown-preview-sizer > *') || marker,
                );
                const containerIndex = Array.from(container.parentElement.children).indexOf(container);
                if (markerIndex !== -1 && containerIndex !== -1 && markerIndex < containerIndex) {
                    if (markerIndex === containerIndex - 1 || markerIndex === containerIndex - 2) {
                        markerSpan = marker;
                        break;
                    }
                }
            }
        }

        if (!markerSpan?.dataset.calendarEmbed) return null;
        const path = markerSpan.dataset.calendarEmbed;
        const file = this.app.vault.getAbstractFileByPath(path.endsWith('.md') ? path : `${path}.md`);
        return file instanceof TFile ? file : null;
    }
}
