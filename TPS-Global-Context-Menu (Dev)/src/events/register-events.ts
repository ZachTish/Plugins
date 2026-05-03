import { TFile, Platform, debounce, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { resolveLinkValueToFile } from '../handlers/parent-link-format';
import type TPSGlobalContextMenuPlugin from '../main';
import { ViewModeService } from '../services/view-mode-service';
import { RemoveHiddenSubitemsModal } from '../modals/remove-hidden-subitems-modal';
import { checkAndPromptForUnresolvedSubitems } from '../services/unresolved-subitem-modal';
import type { BodySubitemLink } from '../services/subitem-types';

/**
 * Registers all workspace and vault event listeners on the given plugin instance.
 * Extracted from `onload` to keep main.ts concise.
 *
 * Also performs the initial `ensureMenus()` call at the end.
 */
export function registerGcmEvents(plugin: TPSGlobalContextMenuPlugin): void {
    // Track the previously active file so we can update its checklist property on leaf change
    let previousActiveFile: TFile | null = null;
    // ── Native context menu injection ────────────────────────────────────────

    plugin.registerEvent(
        plugin.app.workspace.on('file-menu', (menu, file) => {
            if (plugin.settings.inlineMenuOnly) return;
            if (file instanceof TFile) {
                plugin.menuController.addToNativeMenu(menu, [file]);
            }
        }),
    );

    plugin.registerEvent(
        plugin.app.workspace.on('files-menu', (menu, files) => {
            if (plugin.settings.inlineMenuOnly) return;
            const fileList = files.filter((f: any) => f && f.path && typeof f.path === 'string') as TFile[];
            if (fileList.length > 0) {
                plugin.menuController.addToNativeMenu(menu, fileList);
            }
        }),
    );

    plugin.registerEvent(
        plugin.app.workspace.on('editor-menu', (menu, editor, info) => {
            if (plugin.settings.inlineMenuOnly) return;
            if (info && info.file instanceof TFile) {
                plugin.menuController.addToNativeMenu(menu, [info.file]);
            }
        }),
    );

    // ── Persistent inline menu management ───────────────────────────────────

    const ensureMenus = plugin.persistentMenuManager.ensureMenus.bind(plugin.persistentMenuManager);
    const throttledEnsureMenus = debounce(ensureMenus, 500, false);
    const pendingSubitemTimers = new Map<string, number>();

    // Unified subitem refresh function to consolidate multiple triggers
    const scheduleSubitemRefresh = (file: TFile | null, opts: { delay?: number } = {}) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const path = file.path;
        const delay = typeof opts.delay === 'number' ? opts.delay : 200;

        // Clear existing timer for this file
        const existing = pendingSubitemTimers.get(path);
        if (existing !== undefined) window.clearTimeout(existing);

        // Schedule unified refresh
        const timer = window.setTimeout(() => {
            pendingSubitemTimers.delete(path);
            plugin.inlineTaskSubtaskService?.ensureForAllMarkdownViews();
            plugin.linkedSubitemCheckboxService?.ensureForAllMarkdownViews();
            plugin.linkedSubitemCheckboxService?.refreshLivePreviewEditors();
        }, Math.max(0, delay));
        pendingSubitemTimers.set(path, timer);
    };

    const throttledEnsureInlineTaskControls = debounce(() => {
        plugin.inlineTaskSubtaskService?.ensureForAllMarkdownViews();
    }, 120, false);
    const throttledEnsureLinkedSubitemCheckboxes = debounce(() => {
        plugin.linkedSubitemCheckboxService?.ensureForAllMarkdownViews();
    }, 120, false);
    const debouncedLiveMarkdownParentReconcile = debounce((file: TFile, raw: string) => {
        void plugin.subitemRelationshipSyncService?.reconcileMarkdownParentText(file, raw);
    }, 250, false);
    const pendingRefreshTimers = new Map<string, number>();
    const pendingLateRefreshTimers = new Map<string, number>();

    const scheduleResponsiveMenuRefresh = (
        file: TFile,
        opts: { rebuildInlineSubitems?: boolean; delayMs?: number; lateDelayMs?: number } = {}
    ) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const path = file.path;
        const delayMs = typeof opts.delayMs === 'number' ? opts.delayMs : 200;
        const rebuild = opts.rebuildInlineSubitems === true;

        // Consolidate to a single refresh - clear both early and late timers
        const existing = pendingRefreshTimers.get(path);
        if (existing !== undefined) window.clearTimeout(existing);
        const lateExisting = pendingLateRefreshTimers.get(path);
        if (lateExisting !== undefined) window.clearTimeout(lateExisting);

        const timer = window.setTimeout(() => {
            pendingRefreshTimers.delete(path);
            pendingLateRefreshTimers.delete(path);
            plugin.persistentMenuManager.refreshMenusForFile(file, true, { rebuildInlineSubitems: rebuild });
            throttledEnsureMenus();
        }, Math.max(0, delayMs));
        pendingRefreshTimers.set(path, timer);
    };

    plugin.registerEvent(plugin.app.workspace.on('layout-change', () => {
        throttledEnsureMenus();
        throttledEnsureInlineTaskControls();
    }));

    plugin.registerEvent(
        plugin.app.workspace.on('editor-change', (editor, info) => {
            const file = (info as any)?.file;
            if (!(file instanceof TFile) || file.extension !== 'md') return;
            const active = plugin.app.workspace.getActiveFile();
            if (!(active instanceof TFile) || active.path !== file.path) return;
            const raw = typeof (editor as any)?.getValue === 'function' ? (editor as any).getValue() : null;
            if (typeof raw !== 'string') return;
            debouncedLiveMarkdownParentReconcile(file, raw);
        }),
    );

    plugin.registerEvent(
        plugin.app.workspace.on('active-leaf-change', () => {
            throttledEnsureMenus();
            throttledEnsureInlineTaskControls();
            throttledEnsureLinkedSubitemCheckboxes();
            const activePath = plugin.app.workspace.getActiveFile()?.path || null;
            for (const path of Array.from((plugin as any).viewModeSuppressedPaths as Set<string>)) {
                if (path !== activePath) {
                    (plugin as any).viewModeSuppressedPaths.delete(path);
                }
            }
            // Update checklist property for the note being left
            if (previousActiveFile && previousActiveFile instanceof TFile) {
                plugin.taskCheckboxHandler.scheduleChecklistPropertyUpdate(previousActiveFile);
            }
            previousActiveFile = plugin.app.workspace.getActiveFile() ?? null;
        }),
    );

    // Helper to check if a leaf is in live preview mode
    const isLivePreviewMode = (leaf: WorkspaceLeaf | null): boolean => {
        if (!leaf) return false;
        const view = leaf.view;
        if (!(view instanceof MarkdownView)) return false;
        const state = view.getState();
        // Live preview is mode: "source" with source: false (or undefined)
        return state.mode === 'source' && state.source !== true;
    };

    // Helper to check for subitems matching hide rules and prompt user
    const checkForHiddenSubitems = async (file: TFile) => {
        if (!plugin.settings.subitems_IgnoreRules || plugin.settings.subitems_IgnoreRules.length === 0) return;
        if (file.extension?.toLowerCase() !== 'md') return;

        const bodyLinks = await plugin.bodySubitemLinkService.scanFile(file);
        if (bodyLinks.length === 0) return;

        const viewModeService = new ViewModeService();
        const matchingLinks: BodySubitemLink[] = [];

        for (const link of bodyLinks) {
            if (!link.childFile) continue;
            
            const cache = plugin.app.metadataCache.getFileCache(link.childFile);
            const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
            
            // Build data object for condition evaluation
            const data: Record<string, unknown> = {
                ...fm,
                path: link.childFile.path,
                filePath: link.childFile.path,
            };

            // Check each rule
            for (const rule of plugin.settings.subitems_IgnoreRules) {
                const conditions = viewModeService.getRuleConditions(rule);
                const matchType = viewModeService.normalizeMatch(rule.match);
                
                if (viewModeService.evaluateConditions(matchType, conditions, data)) {
                    matchingLinks.push(link);
                    break; // Don't add the same link multiple times
                }
            }
        }

        if (matchingLinks.length === 0) return;

        // Show modal asking user if they want to remove the links
        new RemoveHiddenSubitemsModal(
            plugin.app,
            matchingLinks,
            async (linksToRemove: BodySubitemLink[]) => {
                // Remove each matching link from the parent file
                for (const link of linksToRemove) {
                    if (link.childFile) {
                        await plugin.subitemRelationshipSyncService.unlinkChildFromParent(link.childFile, file);
                    }
                }
            }
        ).open();
    };

    // Helper to insert blank line at beginning of file and position cursor
    const insertBlankLineAtBeginning = async (file: TFile) => {
        if (!plugin.settings.enableAutoInsertBlankLineOnOpen) return;
        if (file.extension !== 'md') return;

        // Get the active leaf
        const leaf = plugin.app.workspace.activeLeaf;
        if (!isLivePreviewMode(leaf)) return;

        const view = leaf?.view as MarkdownView | undefined;
        if (!view || !view.editor) return;

        // Read the file content
        const content = await plugin.app.vault.read(file);
        const lines = content.split('\n');
        
        // Check if first line is not empty
        if (lines.length > 0 && lines[0].trim() !== '') {
            // Insert blank line at beginning
            const newContent = '\n' + content;
            await plugin.app.vault.modify(file, newContent);
            
            // Position cursor at line 0 (the new blank line)
            // Use setTimeout to ensure the editor has updated
            setTimeout(() => {
                if (view.editor) {
                    view.editor.setCursor({ line: 0, ch: 0 });
                }
            }, 50);
        }
    };

    plugin.registerEvent(
        plugin.app.workspace.on('file-open', (file) => {
            ensureMenus();

            // Single unified subitem refresh call
            scheduleSubitemRefresh(file, { delay: 150 });

            if (file && Platform.isMobile) {
                setTimeout(() => {
                    plugin.persistentMenuManager.refreshMenusForFile(file);
                    scheduleSubitemRefresh(file, { delay: 0 });
                }, 500);
            }
            if (file && plugin.fileNamingService.shouldProcess(file, { bypassCreationGrace: true })) {
                setTimeout(() => {
                    void plugin.fileNamingService.processFileOnOpen(file, { bypassCreationGrace: true });
                }, 500);
            }
            // Update checklist property for the newly opened note
            if (file instanceof TFile) {
                plugin.taskCheckboxHandler.scheduleChecklistPropertyUpdate(file);
                previousActiveFile = file;
                scheduleResponsiveMenuRefresh(file, { rebuildInlineSubitems: true, delayMs: 300 });

                // ── Note-open reconciliation hooks ─────────────────────────────────
                // 0. Repair broken parent body links from childOf backlinks before any
                // other subitem reconciliation runs. This prevents transient broken
                // lines like `- [ ] [[` from stripping childOf links on open.
                void plugin.subitemRelationshipSyncService?.repairBrokenBodyLinksForParent(file);

                // 1. Ensure missing subitem body links are inserted after frontmatter
                void plugin.subitemRelationshipSyncService?.ensureBodyLinksForChild(file);

                // 2. Check for unresolved/deleted subitem links and prompt user
                // Run after a short delay to let the file fully load
                setTimeout(() => {
                    void checkAndPromptForUnresolvedSubitems(plugin, file);
                }, 800);
            }
        }),
    );

    // ── Reactive completedDate sync ──────────────────────────────────────────
    // Watches for status changes from ANY source (direct edit, bases, notification modal,
    // kanban, canvas, etc.) and ensures completedDate is always in sync.
    const debouncedCompletedDateSync = debounce((file: TFile) => {
        if (!file || file.extension !== 'md') return;

        const cache = plugin.app.metadataCache.getFileCache(file);
        const fm = (cache?.frontmatter || {}) as Record<string, any>;

        const doneStatuses = new Set<string>(
            ((plugin.settings as any).recurrenceCompletionStatuses?.length
                ? (plugin.settings as any).recurrenceCompletionStatuses
                : ['complete', 'wont-do']
            ).map((s: string) => String(s || '').trim().toLowerCase()),
        );

        const currentStatus = String(fm.status ?? '').trim().toLowerCase();
        const completedDateKey = Object.keys(fm).find((k) => k.toLowerCase() === 'completeddate');
        const hasCompletedDate = !!completedDateKey && fm[completedDateKey] != null && fm[completedDateKey] !== '';

        if (doneStatuses.has(currentStatus) && !hasCompletedDate) {
            // Write completedDate — status is done but completedDate is missing
            void plugin.app.fileManager.processFrontMatter(file, (fmw) => {
                fmw['completedDate'] = (window as any).moment
                    ? (window as any).moment().format('YYYY-MM-DD HH:mm:ss')
                    : new Date().toISOString().replace('T', ' ').slice(0, 19);
            });
        } else if (!doneStatuses.has(currentStatus) && hasCompletedDate && currentStatus) {
            // Clear completedDate — status reverted away from done
            void plugin.app.fileManager.processFrontMatter(file, (fmw) => {
                const key = Object.keys(fmw).find((k) => k.toLowerCase() === 'completeddate');
                if (key) delete fmw[key];
            });
        }
    }, 400, false);

    // ── Debounced frontmatter/filename sync ──────────────────────────────────

    const debouncedMenuRefresh = debounce((file: TFile) => {
        if (file && file.extension === 'md') {
            // Force refresh so frontmatter edits made while typing are reflected immediately.
            plugin.persistentMenuManager.refreshMenusForFile(file, true);

            const parentKey = String(plugin.settings.parentLinkFrontmatterKey || 'childOf').trim() || 'childOf';
            const fm = (plugin.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
            const fmParentKey = Object.keys(fm).find((k) => k.toLowerCase() === parentKey.toLowerCase());
            if (fmParentKey !== undefined) {
                const parentRaw = fm[fmParentKey];
                const parentValues = Array.isArray(parentRaw) ? parentRaw : [parentRaw];
                for (const pv of parentValues) {
                    const parentFile = resolveLinkValueToFile(plugin.app, pv, file.path);
                    if (parentFile instanceof TFile && parentFile.path !== file.path) {
                        plugin.persistentMenuManager.refreshMenusForFile(parentFile, true);
                    }
                }
            }
        }
    }, 350, false);

    const debouncedFilenameSync = debounce((file: TFile) => {
        if (!file || file.extension !== 'md') return;
        const active = plugin.app.workspace.getActiveFile();
        if (file !== active) return;
        if (!plugin.fileNamingService.shouldProcess(file, { bypassCreationGrace: true })) return;
        if (plugin.settings.enableAutoRename) {
            plugin.fileNamingService.updateFilenameIfNeeded(file, { bypassCreationGrace: true });
        }
        if (plugin.settings.autoSyncTitleFromFilename) {
            plugin.fileNamingService.syncTitleFromFilename(file, { bypassCreationGrace: true });
        }
    }, 1500, false);

    plugin.registerEvent(
        plugin.app.metadataCache.on('changed', (file) => {
            // Clear the title cache when metadata changes to prevent stale titles
            if (file instanceof TFile) {
                plugin.menuController.panelBuilder?.clearFileTitleCache(file.path);
            }
            debouncedMenuRefresh(file);
            debouncedFilenameSync(file);
            if (file instanceof TFile) {
                plugin.taskCheckboxHandler.scheduleChecklistPropertyUpdate(file);
                scheduleResponsiveMenuRefresh(file, { rebuildInlineSubitems: true, delayMs: 300 });
                debouncedCompletedDateSync(file);
            }
        }),
    );

    plugin.registerEvent(
        plugin.app.vault.on('modify', (file) => {
            if (!(file instanceof TFile) || file.extension !== 'md') return;
            plugin.taskCheckboxHandler.scheduleChecklistPropertyUpdate(file);
            void plugin.subitemRelationshipSyncService?.repairBrokenBodyLinksForParent(file);
            void plugin.subitemRelationshipSyncService?.reconcileMarkdownParent(file);
            if (plugin.parentLinkResolutionService.getParentsForChild(file).length > 0) {
                void plugin.linkedSubitemCheckboxService?.refreshReferencesForChild(file);
            }
            scheduleResponsiveMenuRefresh(file, { rebuildInlineSubitems: true, delayMs: 400 });
        }),
    );

    plugin.registerEvent(
        (plugin.app.workspace as any).on('tps-gcm-files-updated', (paths: string[] | undefined) => {
            if (!Array.isArray(paths) || paths.length === 0) return;
            for (const path of paths) {
                const f = plugin.app.vault.getFileByPath(path);
                if (!f) continue;
                scheduleResponsiveMenuRefresh(f, { rebuildInlineSubitems: true, delayMs: 50, lateDelayMs: 320 });
            }
        }),
    );

    // ── Vault events ─────────────────────────────────────────────────────────

    plugin.registerEvent(
        plugin.app.vault.on('create', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                setTimeout(() => {
                    plugin.fileNamingService.syncTitleFromFilename(file, {
                        force: true,
                        onlyIfMissing: true,
                        bypassCreationGrace: true,
                    });
                }, 1500);
            }
        }),
    );

    plugin.registerEvent(
        plugin.app.vault.on('rename', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                plugin.persistentMenuManager.refreshMenusForFile(file);
                setTimeout(() => {
                    plugin.fileNamingService.syncTitleFromFilename(file, {
                        force: true,
                        bypassCreationGrace: true,
                    });
                }, 150);
            }
        }),
    );

    plugin.register(() => plugin.persistentMenuManager.detach());
    plugin.register(() => plugin.menuController.detach());
    plugin.register(() => {
        for (const timer of pendingRefreshTimers.values()) window.clearTimeout(timer);
        for (const timer of pendingLateRefreshTimers.values()) window.clearTimeout(timer);
        for (const timer of pendingSubitemTimers.values()) window.clearTimeout(timer);
        pendingRefreshTimers.clear();
        pendingLateRefreshTimers.clear();
        pendingSubitemTimers.clear();
    });

    plugin.registerEvent(
        plugin.app.vault.on('delete', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                void plugin.bulkEditService.cleanupLinksForDeletedFile(file.path, file.basename);
            }
            try {
                if (document.activeElement instanceof HTMLElement) {
                    document.activeElement.blur();
                }
            } catch { /* ignore */ }
            try {
                plugin.menuController?.hideMenu?.();
            } catch { /* ignore */ }
            try {
                plugin.app.workspace.trigger('tps-gcm-delete-complete');
            } catch { /* ignore */ }
        }),
    );

    // Initial menu setup
    ensureMenus();
    plugin.inlineTaskSubtaskService?.ensureForAllMarkdownViews();
    plugin.linkedSubitemCheckboxService?.ensureForAllMarkdownViews();
}
