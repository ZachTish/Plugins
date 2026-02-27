import { App, TFile, TFolder, WorkspaceLeaf, View } from 'obsidian';
import TPSGlobalContextMenuPlugin from './main';
import * as logger from "./logger";

export class ContextTargetService {
    plugin: TPSGlobalContextMenuPlugin;

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        this.plugin = plugin;
    }

    get app(): App {
        return this.plugin.app;
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
    resolveTargets(explicitFiles?: TFile[], evt?: MouseEvent): TFile[] {
        // 0. Canvas Node Selection (Priority over explicit file if clicking a node)
        // If we are in a canvas and have a node selected, we usually want the node's context, not the canvas file.
        if (evt) {
            const canvasFile = this.resolveCanvasTarget(evt);
            if (canvasFile) return [canvasFile];
        }

        // 1. Explicit files from native menu event
        if (explicitFiles && explicitFiles.length > 0) {
            // Check if we should expand this to a multi-selection
            const expanded = this.expandSelection(explicitFiles);
            if (expanded.length > 0) return expanded;
            return explicitFiles;
        }

        // 3. Click Event Target (Sync Embeds, etc.)
        if (evt && evt.target instanceof HTMLElement) {
            // Check for Sync Embeds
            const embedFile = this.resolveEmbedTarget(evt.target);
            if (embedFile) return [embedFile];

            // Check for Explorer Items (Native or Smart Explorer)
            // This is critical for Strict Mode where native events are suppressed
            const explorerPath = this.resolveExplorerPath(evt.target);
            if (explorerPath) {
                const af = this.app.vault.getAbstractFileByPath(explorerPath);
                if (af instanceof TFolder) {
                    return [];
                }
                if (af instanceof TFile) {
                    return [af];
                }
            }
        }

        // 4. Active Leaf Fallback
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) return [activeFile];

        return [];
    }

    /**
     * Resolve file from Canvas Node selection.
     */
    resolveCanvasTarget(evt: MouseEvent | undefined): TFile | null {
        // Check if active view is Canvas
        const view = this.app.workspace.getActiveViewOfType(View);
        logger.log('[Target Service] Checking Canvas Target. View Type:', view?.getViewType());

        if (!view || (view.getViewType() !== 'canvas' && view.getViewType() !== 'json')) return null;

        // Check if target is actually inside the canvas (and not just the tab header)
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

        // Get selection
        const selection = canvas.selection; // Set<CanvasNode>
        logger.log('[Target Service] Canvas Selection Size:', selection?.size);

        if (selection && selection.size === 1) {
            const node = selection.values().next().value;
            logger.log('[Target Service] Selected Node:', node);

            // Check for file node
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
     * Expand the selection to include multiple files if they are selected in the explorer.
     * This logic consolidates Smart Explorer and Core Explorer multi-select.
     */
    expandSelection(primaryFiles: TFile[]): TFile[] {
        if (primaryFiles.length === 0) return [];

        const selection = this.getSelectedFiles();

        // No multi-selection in DOM - just return primary files
        if (selection.length === 0) {
            return primaryFiles;
        }

        // Check if ALL primary files are in the current DOM selection
        // This ensures that if user shift-clicked a NEW file not in the selection,
        // we don't accidentally include stale selection items
        const primaryPaths = new Set(primaryFiles.map(f => f.path));
        const selectionPaths = new Set(selection.map(f => f.path));

        // Check if primary files and selection overlap
        const primaryInSelection = primaryFiles.every(f => selectionPaths.has(f.path));

        if (primaryInSelection) {
            // User right-clicked on something that's part of the selection - use the full selection
            return selection;
        }

        // Check if any primary file overlaps with selection (partial overlap)
        const hasOverlap = primaryFiles.some(f => selectionPaths.has(f.path));

        if (hasOverlap) {
            // Partial overlap means the selection is likely stale (e.g., mobile long-press
            // on a file that was part of an old selection). Trust only the primary files.
            logger.log('[Context Target] Partial overlap detected - using primary files only', {
                primary: Array.from(primaryPaths),
                selection: Array.from(selectionPaths)
            });
            return primaryFiles;
        }

        // No overlap - user clicked outside the selection, trust primary files only
        // This handles the shift-click new range scenario where old selection is still in DOM
        logger.log('[Context Target] No overlap with DOM selection - using explicit files', {
            primary: Array.from(primaryPaths),
            selection: Array.from(selectionPaths)
        });
        return primaryFiles;
    }

    /**
     * Get all currently selected files from supported explorers.
     */
    getSelectedFiles(): TFile[] {
        const out: Map<string, TFile> = new Map();
        const push = (f: TFile | null | undefined) => {
            if (f && f.path) out.set(f.path, f);
        };

        // Notebook Navigator selection
        const notebookNavigatorNodes = Array.from(document.querySelectorAll<HTMLElement>('.nn-file.nn-selected[data-path]'));
        notebookNavigatorNodes.forEach((el) => {
            const p = el.dataset.path;
            if (!p) return;
            const af = this.app.vault.getAbstractFileByPath(p);
            if (af instanceof TFile) push(af);
        });

        // Explorer 2 (Smart Explorer) selection
        const explorerNodes = Array.from(document.querySelectorAll<HTMLElement>('.explorer2-selected[data-path]'));
        explorerNodes.forEach((el) => {
            const p = el.dataset.path;
            if (!p) return;
            const af = this.app.vault.getAbstractFileByPath(p);
            if (af instanceof TFile) push(af);
        });

        // Core explorer multi-select (nav-file is-selected)
        const coreNodes = Array.from(document.querySelectorAll<HTMLElement>('.workspace-leaf-content .nav-file.is-selected[data-path]'));
        coreNodes.forEach((el) => {
            const p = el.dataset.path;
            if (!p) return;
            const af = this.app.vault.getAbstractFileByPath(p);
            if (af instanceof TFile) push(af);
        });

        return Array.from(out.values());
    }

    /**
     * Generic method to resolve a file from a DOM element.
     * Looks for:
     * 1. 'data-path' attribute on the element or ancestors (Generic/Smart Explorer/Calendar).
     * 2. 'data-href' on 'a.internal-link' (Obsidian internal links).
     * 3. 'data-file' (Search results/Backlinks often use this).
     */
    resolveExplorerPath(target: HTMLElement): string | null {
        // 1. Traverse up for data-path (Most common/Standardized)
        // We look for any element with data-path, or specific container classes
        const item = target.closest(
            '.nav-file, .nav-folder, .tree-item, .tree-item-self, .tps-calendar-entry, .bases-feed-entry, .nn-file, .nn-navitem, .nn-path-segment, [data-path]'
        );

        if (item instanceof HTMLElement && item.dataset.path) {
            return item.dataset.path;
        }

        // 2. Check for Internal Links (data-href)
        const link = target.closest('a.internal-link');
        if (link instanceof HTMLElement && link.dataset.href) {
            const path = link.dataset.href;
            // Internal links might be relative or absolute, best effort resolve
            // We can use metadataCache to help resolve if needed, but getAbstractFileByPath works for full paths
            // For simple filenames, we might need 'getFirstLinkpathDest' logic
            const resolved = this.app.metadataCache.getFirstLinkpathDest(path, "");
            if (resolved instanceof TFile) return resolved.path;
        }

        // 2b. Bases tables often use data-href on non-anchor elements
        const dataHref = target.closest('[data-href]');
        if (dataHref instanceof HTMLElement && dataHref.dataset.href) {
            const resolved = this.app.metadataCache.getFirstLinkpathDest(dataHref.dataset.href, "");
            if (resolved instanceof TFile) return resolved.path;
        }

        // 2c. Some embedded bases and list views use data-linkpath / data-file
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

        // 3. Search Results / Backlinks (often use data-file or structure)
        const searchItem = target.closest('.search-result-file-title, .search-result-file-match');
        if (searchItem) {
            // Search results usually put the path in the title element's text or a generic container
            // Let's assume standard Obsidian behavior or look for adjacent data
            // Actually, Obsidian search results usually have data-path on the .tree-item-self ancestor if using new tree
            // If this failed step 1, it might be the old style.
            // Fallback for some views: look for text content matching a file? Risky.
            // Let's stick to attributes for now.
        }

        return null;
    }

    /**
     * Attempt to resolve a file from a Sync Embed click target in Reading Mode.
     * Ported from main.ts.
     */
    resolveEmbedTarget(target: HTMLElement): TFile | null {
        // Check if we are potentially inside a sync embed or adjacent to one
        // We look for the marker <span> that TPS-Calendar-Base inserts

        let container = target.closest('.block-language-sync, .cm-embed-block, .sync-embed, .sync-container');

        if (container) {
            let markerSpan: HTMLElement | null = null;

            // 1. Direct Previous Sibling Check
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

            // 2. Parent Context Check (covering edge cases in Reading Mode)
            if (!markerSpan && container.parentElement) {
                const allMarkers = container.parentElement.querySelectorAll('span[data-calendar-embed]');
                for (const marker of Array.from(allMarkers)) {
                    if (marker instanceof HTMLElement) {
                        const markerIndex = Array.from(container.parentElement.children).indexOf(marker.closest('.markdown-preview-sizer > *') || marker);
                        const containerIndex = Array.from(container.parentElement.children).indexOf(container);
                        if (markerIndex !== -1 && containerIndex !== -1 && markerIndex < containerIndex) {
                            if (markerIndex === containerIndex - 1 || markerIndex === containerIndex - 2) {
                                markerSpan = marker;
                                break;
                            }
                        }
                    }
                }
            }

            if (markerSpan && markerSpan.dataset.calendarEmbed) {
                const path = markerSpan.dataset.calendarEmbed;
                const file = this.app.vault.getAbstractFileByPath(path.endsWith('.md') ? path : path + '.md');
                if (file instanceof TFile) {
                    return file;
                }
            }
        }
        return null;
    }
}
