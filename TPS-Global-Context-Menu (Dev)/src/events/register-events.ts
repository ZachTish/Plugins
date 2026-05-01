import { TFile, Platform, debounce, MarkdownView, WorkspaceLeaf } from 'obsidian';
import { getDailyNoteResolver } from '../../../TPS-Controller (Dev)/src/utils/daily-note-resolver';
import { resolveLinkValueToFile } from '../handlers/parent-link-format';
import { getPluginById } from '../core';
import type TPSGlobalContextMenuPlugin from '../main';
import { ViewModeService } from '../services/view-mode-service';
import { RemoveHiddenSubitemsModal } from '../modals/remove-hidden-subitems-modal';
import { checkAndPromptForUnresolvedSubitems } from '../services/unresolved-subitem-modal';
import type { BodySubitemLink } from '../services/subitem-types';
import { applyRulesToFile as applyNotebookNavigatorRulesToFile } from '../utils/rule-resolver';
import * as logger from '../logger';

/**
 * Registers all workspace and vault event listeners on the given plugin instance.
 * Extracted from `onload` to keep main.ts concise.
 *
 * Also performs the initial `ensureMenus()` call at the end.
 */
export function registerGcmEvents(plugin: TPSGlobalContextMenuPlugin): void {
    const eventLogger = logger.createScoped('EventFlow');
    const shouldSuppressNotebookNavigatorStatusIconContextMenu = (file: TFile | null): boolean => {
        if (!(file instanceof TFile) || file.extension !== 'md') return false;

        const companion: any =
            getPluginById(plugin.app, 'tps-notebook-navigator-companion') ??
            (plugin.app as any)?.plugins?.plugins?.['tps-notebook-navigator-companion'];

        return Boolean(
            companion?.shouldSuppressNotebookNavigatorStatusIconContextMenu?.(file.path) ||
            companion?.api?.shouldSuppressNotebookNavigatorStatusIconContextMenu?.(file.path),
        );
    };

    // Track the previously active file so we can update its checklist property on leaf change
    let previousActiveFile: TFile | null = null;
    // ── Native context menu injection ────────────────────────────────────────

    plugin.registerEvent(
        plugin.app.workspace.on('file-menu', (menu, file) => {
            if (plugin.settings.inlineMenuOnly) return;
            if (file instanceof TFile) {
                if (shouldSuppressNotebookNavigatorStatusIconContextMenu(file)) return;
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

                const cursor = typeof (editor as any)?.getCursor === 'function'
                    ? (editor as any).getCursor()
                    : null;
                const lineNumber = typeof cursor?.line === 'number' ? cursor.line : -1;
                const lineText = lineNumber >= 0 && typeof (editor as any)?.getLine === 'function'
                    ? String((editor as any).getLine(lineNumber) || '')
                    : '';
                const resolver = getDailyNoteResolver(plugin.app, {
                    formatOverride: (plugin as any)?.settings?.dailyNoteDateFormat,
                });
                const todayDailyNotePath = resolver?.buildPath?.(new Date(), 'md');
                const isTodayDailyNote = typeof todayDailyNotePath === 'string' && todayDailyNotePath === info.file.path;

                if (isTodayDailyNote && lineNumber >= 0 && lineText.trim().length === 0) {
                    menu.addSeparator();
                    menu.addItem((item) => {
                        item.setTitle('Start Time Tracking Here')
                            .setIcon('timer')
                            .onClick(() => {
                                const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
                                if (!(view instanceof MarkdownView) || view.file?.path !== info.file.path) return;
                                void plugin.timeTrackingService.startFromDailyNoteEmptyLine(info.file, view, lineNumber);
                            });
                    });
                }
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
        if (existing !== undefined) {
            window.clearTimeout(existing);
            eventLogger.debug('Coalesced pending subitem refresh', { path, delay });
        }

        eventLogger.debug('Scheduled subitem refresh', {
            path,
            delay,
            activeFile: plugin.app.workspace.getActiveFile()?.path ?? null,
        });

        // Schedule unified refresh
        const timer = window.setTimeout(() => {
            pendingSubitemTimers.delete(path);
            eventLogger.debug('Executing subitem refresh', { path });
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
    const pendingNotebookRuleTimers = new Map<string, number>();
    const NOTEBOOK_RULE_RETRY_WINDOW_MS = 75_000;
    const NOTEBOOK_RULE_SYNC_RETRY_DELAY_MS = 1000;
    const NOTEBOOK_RULE_GUARD_RETRY_DELAY_MS = 1200;
    const NOTEBOOK_RULE_FILE_OPEN_MIN_DELAY_MS = 300;
    const NOTEBOOK_RULE_POST_WRITE_BUFFER_MS = 120;

    const getNotebookRuleRetryRemainingMs = (retryUntil: number): number => Math.max(0, retryUntil - Date.now());

    const rescheduleNotebookRuleApply = (
        file: TFile,
        reason: string,
        attempt: number,
        retryUntil: number,
        delay: number,
        cause: 'sync' | 'frontmatter-guard',
    ) => {
        const remainingMs = getNotebookRuleRetryRemainingMs(retryUntil);
        if (remainingMs <= 0) {
            eventLogger.warn(
                cause === 'sync'
                    ? 'Dropped notebook rule apply after sync retries exhausted'
                    : 'Dropped notebook rule apply after frontmatter guard retries exhausted',
                {
                    path: file.path,
                    reason,
                    attempt,
                    cause,
                },
            );
            return;
        }

        scheduleNotebookRuleApply(
            file,
            reason,
            Math.min(delay, remainingMs),
            attempt + 1,
            retryUntil,
        );
    };

    const scheduleNotebookRuleApply = (
        file: TFile | null,
        reason: string,
        delay = 250,
        attempt = 0,
        retryUntil = Date.now() + NOTEBOOK_RULE_RETRY_WINDOW_MS,
    ) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const path = file.path;
        const existing = pendingNotebookRuleTimers.get(path);
        if (existing !== undefined) {
            window.clearTimeout(existing);
            eventLogger.debug('Coalesced pending notebook rule apply', { path, reason, delay, attempt });
        }

        eventLogger.debug('Scheduled notebook rule apply', { path, reason, delay, attempt });

        const timer = window.setTimeout(() => {
            pendingNotebookRuleTimers.delete(path);
            if (!plugin.isInitialSyncSettled()) {
                const remainingMs = getNotebookRuleRetryRemainingMs(retryUntil);
                eventLogger.debug('Deferred notebook rule apply until initial sync settles', {
                    path,
                    reason,
                    attempt,
                    remainingMs,
                });
                rescheduleNotebookRuleApply(file, reason, attempt, retryUntil, NOTEBOOK_RULE_SYNC_RETRY_DELAY_MS, 'sync');
                return;
            }
            const wasRecentlyWritten = plugin.frontmatterMutationService.wasRecentlyWritten(path);
            const writeInProgress = plugin.frontmatterMutationService.isWriteInProgress(path);
            if (wasRecentlyWritten || writeInProgress) {
                const remainingMs = getNotebookRuleRetryRemainingMs(retryUntil);
                eventLogger.debug('Deferred notebook rule apply due to frontmatter mutation guard', {
                    path,
                    reason,
                    attempt,
                    wasRecentlyWritten,
                    writeInProgress,
                    remainingMs,
                });
                rescheduleNotebookRuleApply(file, reason, attempt, retryUntil, NOTEBOOK_RULE_GUARD_RETRY_DELAY_MS, 'frontmatter-guard');
                return;
            }
            eventLogger.debug('Executing notebook rule apply', { path, reason, attempt });
            void Promise.resolve()
                .then(() => applyNotebookNavigatorRulesToFile(plugin.app, file, reason))
                .catch((error) => logger.error('[TPS GCM] Notebook rule apply failed', { path, reason, attempt, error }));
        }, Math.max(0, delay));

        pendingNotebookRuleTimers.set(path, timer);
    };

    const scheduleFileOpenNotebookRuleApply = (file: TFile) => {
        void Promise.resolve()
            .then(async () => {
                const scheduledWasNormalized = await plugin.dailyNoteNavManager.syncScheduledFrontmatterOnOpen(file);
                const recentWriteRemainingMs = plugin.frontmatterMutationService.getRecentWriteRemainingMs(file.path);
                const delay = Math.max(
                    NOTEBOOK_RULE_FILE_OPEN_MIN_DELAY_MS,
                    recentWriteRemainingMs > 0 ? recentWriteRemainingMs + NOTEBOOK_RULE_POST_WRITE_BUFFER_MS : 0,
                );

                eventLogger.debug('Queued notebook rule apply after file-open normalization', {
                    path: file.path,
                    scheduledWasNormalized,
                    recentWriteRemainingMs,
                    delay,
                });

                scheduleNotebookRuleApply(file, 'file-open', delay);
            })
            .catch((error) => logger.error('[TPS GCM] Failed preparing file-open notebook rule apply', { path: file.path, error }));
    };
    const pendingRecurrenceAdvanceTimers = new Map<string, number>();
    const pendingRefreshTimers = new Map<string, number>();
    const pendingLateRefreshTimers = new Map<string, number>();
    const pendingFileOpenGuardTimers = new Map<string, number[]>();

    const clearFileOpenGuardTimers = (path: string) => {
        const timers = pendingFileOpenGuardTimers.get(path) || [];
        for (const timer of timers) window.clearTimeout(timer);
        pendingFileOpenGuardTimers.delete(path);
        if (timers.length > 0) {
            eventLogger.debug('Cleared pending file-open guard timers', { path, count: timers.length });
        }
    };

    const scheduleFileOpenGuard = (file: TFile, delayMs: number, task: () => Promise<void> | void) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const path = file.path;
        eventLogger.debug('Scheduled file-open guard task', { path, delayMs });
        const timer = window.setTimeout(() => {
            const active = plugin.app.workspace.getActiveFile();
            if (!(active instanceof TFile) || active.path !== path) {
                eventLogger.debug('Skipped file-open guard because file is no longer active', {
                    path,
                    activePath: active instanceof TFile ? active.path : null,
                });
                return;
            }
            const live = plugin.app.vault.getAbstractFileByPath(path);
            if (!(live instanceof TFile) || live.extension !== 'md') {
                eventLogger.debug('Skipped file-open guard because live file could not be resolved', { path });
                return;
            }
            if (!plugin.isInitialSyncSettled()) {
                eventLogger.debug('Deferred file-open guard because initial sync is unsettled', { path, delayMs });
                scheduleFileOpenGuard(live, 1000, task);
                return;
            }
            eventLogger.debug('Executing file-open guard task', { path, delayMs });
            void Promise.resolve()
                .then(() => task())
                .catch((error) => logger.error('[TPS GCM] File-open guard task failed', { path, delayMs, error }));
        }, Math.max(0, delayMs));
        const timers = pendingFileOpenGuardTimers.get(path) || [];
        timers.push(timer);
        pendingFileOpenGuardTimers.set(path, timers);
    };

    const scheduleRecurringAdvanceCheck = (file: TFile | null, delay = 400) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const path = file.path;
        const existing = pendingRecurrenceAdvanceTimers.get(path);
        if (existing !== undefined) {
            window.clearTimeout(existing);
            eventLogger.debug('Coalesced pending recurrence advance check', { path, delay });
        }

        eventLogger.debug('Scheduled recurrence advance check', { path, delay });

        const timer = window.setTimeout(() => {
            pendingRecurrenceAdvanceTimers.delete(path);
            eventLogger.debug('Executing recurrence advance check', { path });
            void Promise.resolve()
                .then(() => plugin.bulkEditService.advanceRecurringInstanceIfPastDue(file))
                .catch((error) => logger.error('[TPS GCM] Recurrence advance check failed', { path, error }));
        }, Math.max(0, delay));
        pendingRecurrenceAdvanceTimers.set(path, timer);
    };

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
        if (existing !== undefined) {
            window.clearTimeout(existing);
        }
        const lateExisting = pendingLateRefreshTimers.get(path);
        if (lateExisting !== undefined) {
            window.clearTimeout(lateExisting);
        }
        if (existing !== undefined || lateExisting !== undefined) {
            eventLogger.debug('Coalesced pending responsive menu refresh', {
                path,
                delayMs,
                rebuild,
                hadPrimaryTimer: existing !== undefined,
                hadLateTimer: lateExisting !== undefined,
            });
        }

        eventLogger.debug('Scheduled responsive menu refresh', { path, delayMs, rebuild });

        const timer = window.setTimeout(() => {
            pendingRefreshTimers.delete(path);
            pendingLateRefreshTimers.delete(path);
            eventLogger.debug('Executing responsive menu refresh', { path, rebuild });
            plugin.persistentMenuManager.refreshMenusForFile(file, true, { rebuildInlineSubitems: rebuild });
            throttledEnsureMenus();
        }, Math.max(0, delayMs));
        pendingRefreshTimers.set(path, timer);
    };

    const refreshOpenNoteUiImmediately = (file: TFile, opts: { rebuildInlineSubitems?: boolean } = {}) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const activeFile = plugin.app.workspace.getActiveFile();
        if (!(activeFile instanceof TFile) || activeFile.path !== file.path) return;

        plugin.menuController.panelBuilder?.clearFileTitleCache(file.path);
        plugin.persistentMenuManager.refreshMenusForFile(file, true, {
            rebuildInlineSubitems: opts.rebuildInlineSubitems !== false,
        });
        plugin.inlineTaskSubtaskService?.ensureForAllMarkdownViews();
        plugin.linkedSubitemCheckboxService?.ensureForAllMarkdownViews();
        plugin.linkedSubitemCheckboxService?.refreshLivePreviewEditors();
    };

    plugin.registerEvent(plugin.app.workspace.on('layout-change', () => {
        if (!plugin.isInitialSyncSettled()) return;
        throttledEnsureMenus();
        throttledEnsureInlineTaskControls();
        throttledEnsureLinkedSubitemCheckboxes();
        plugin.linkedSubitemCheckboxService?.refreshLivePreviewEditors();
    }));

    plugin.registerEvent(
        plugin.app.workspace.on('active-leaf-change', () => {
            if (!plugin.isInitialSyncSettled()) return;
            throttledEnsureMenus();
            throttledEnsureInlineTaskControls();
            throttledEnsureLinkedSubitemCheckboxes();
            const activeFile = plugin.app.workspace.getActiveFile();
            for (const path of Array.from(pendingFileOpenGuardTimers.keys())) {
                if (!(activeFile instanceof TFile) || path !== activeFile.path) {
                    clearFileOpenGuardTimers(path);
                }
            }
            const activePath = plugin.app.workspace.getActiveFile()?.path || null;
            for (const path of Array.from((plugin as any).viewModeSuppressedPaths as Set<string>)) {
                if (path !== activePath) {
                    (plugin as any).viewModeSuppressedPaths.delete(path);
                }
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
            if (file instanceof TFile) {
                eventLogger.debug('Observed file-open event', {
                    path: file.path,
                    initialSyncSettled: plugin.isInitialSyncSettled(),
                });
            }
            ensureMenus();

            // Sync `scheduled` frontmatter to the daily note's filename-date before the
            // sync gate. The value is derived from the filename (not vault sync state),
            // the write is idempotent, and it passes { userInitiated: true } internally so
            // it is never blocked by the 20-second settlement window.
            if (file instanceof TFile) {
                previousActiveFile = file;
                refreshOpenNoteUiImmediately(file, { rebuildInlineSubitems: true });
                scheduleResponsiveMenuRefresh(file, { rebuildInlineSubitems: true, delayMs: 120 });
                scheduleFileOpenNotebookRuleApply(file);
            }

            if (!plugin.isInitialSyncSettled()) {
                if (file instanceof TFile) {
                    eventLogger.debug('Skipping post-open guards until initial sync settles', { path: file.path });
                }
                return;
            }

            // Single unified subitem refresh call
            scheduleSubitemRefresh(file, { delay: 150 });
            scheduleRecurringAdvanceCheck(file, 900);

            if (file && Platform.isMobile) {
                setTimeout(() => {
                    plugin.persistentMenuManager.refreshMenusForFile(file);
                    scheduleSubitemRefresh(file, { delay: 0 });
                }, 500);
            }
            if (file instanceof TFile) {
                // ── Note-open reconciliation hooks ─────────────────────────────────
                // 0. Repair broken parent body links from childOf backlinks before any
                // other subitem reconciliation runs. This prevents transient broken
                // lines like `- [ ] [[` from stripping childOf links on open.
                // Keep note-open reconciliation non-destructive beyond broken-link repair;
                // rewriting valid body links here causes vault-wide metadata churn.
                void plugin.subitemRelationshipSyncService?.repairBrokenBodyLinksForParent(file);

                // Run file naming normalization (tags, folder path, title sync) for the
                // opened note. Gated by individual feature flags inside the service.
                void plugin.fileNamingService.processFileOnOpen(file, { bypassCreationGrace: true });

                // 1. Check for unresolved/deleted subitem links and prompt user
                scheduleFileOpenGuard(file, 250, async () => {
                    await checkAndPromptForUnresolvedSubitems(plugin, file);
                });

                // 2. Prompt for parent/body relationship mismatches one by one.
                scheduleFileOpenGuard(file, 1500, async () => {
                    await plugin.subitemRelationshipGuardService?.handleFileOpen(file);
                });

                // 3. Prompt for scheduled note / daily-note embed mismatches.
                if (plugin.settings.enableScheduledLinkGuard && plugin.settings.enableAutoPopulateDailyNotes !== false) {
                    scheduleFileOpenGuard(file, 2000, async () => {
                        await plugin.scheduledLinkGuardService?.handleFileOpen(file);
                    });
                }

            }
        }),
    );

    // ── Reactive completedDate sync ──────────────────────────────────────────
    // Watches for status changes from ANY source (direct edit, bases, notification modal,
    // kanban, canvas, etc.) and ensures completedDate is always in sync.
    const debouncedCompletedDateSync = debounce((file: TFile) => {
        if (!file || file.extension !== 'md') return;
        if (plugin.frontmatterMutationService.wasRecentlyWritten(file.path) || plugin.frontmatterMutationService.isWriteInProgress(file.path)) {
            eventLogger.debug('Skipped completedDate sync due to frontmatter mutation guard', { file: file.path });
            return;
        }

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
            eventLogger.debug('Writing completedDate because status is terminal without completedDate', {
                file: file.path,
                status: currentStatus,
            });
            // Write completedDate — status is done but completedDate is missing
            void plugin.frontmatterMutationService.process(file, (fmw) => {
                fmw['completedDate'] = (window as any).moment
                    ? (window as any).moment().format('YYYY-MM-DD HH:mm:ss')
                    : new Date().toISOString().replace('T', ' ').slice(0, 19);
            });
        } else if (!doneStatuses.has(currentStatus) && hasCompletedDate && currentStatus) {
            eventLogger.debug('Clearing completedDate because status is no longer terminal', {
                file: file.path,
                status: currentStatus,
            });
            // Clear completedDate — status reverted away from done
            void plugin.frontmatterMutationService.process(file, (fmw) => {
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
            if (!plugin.isInitialSyncSettled()) {
                return;
            }
            // Clear the title cache when metadata changes to prevent stale titles
            if (file instanceof TFile) {
                plugin.menuController.panelBuilder?.clearFileTitleCache(file.path);
                refreshOpenNoteUiImmediately(file, { rebuildInlineSubitems: true });
            }
            debouncedMenuRefresh(file);
            debouncedFilenameSync(file);
            if (file instanceof TFile) {
                scheduleResponsiveMenuRefresh(file, { rebuildInlineSubitems: true, delayMs: 80 });
                debouncedCompletedDateSync(file);
                scheduleRecurringAdvanceCheck(file, 1200);
                scheduleNotebookRuleApply(file, 'metadata-change', 260);
            }
        }),
    );

    plugin.registerEvent(
        plugin.app.vault.on('modify', (file) => {
            if (!(file instanceof TFile) || file.extension !== 'md') return;
            if (!plugin.isInitialSyncSettled()) return;
            void plugin.subitemRelationshipSyncService?.repairBrokenBodyLinksForParent(file);
            if (plugin.parentLinkResolutionService.getParentsForChild(file).length > 0) {
                void plugin.linkedSubitemCheckboxService?.refreshReferencesForChild(file);
            }
            refreshOpenNoteUiImmediately(file, { rebuildInlineSubitems: true });
            scheduleResponsiveMenuRefresh(file, { rebuildInlineSubitems: true, delayMs: 120 });
            scheduleNotebookRuleApply(file, 'modify-save', 260);
        }),
    );

    plugin.registerEvent(
        (plugin.app.workspace as any).on('tps-gcm-files-updated', (paths: string[] | undefined) => {
            if (!Array.isArray(paths) || paths.length === 0) return;
            eventLogger.debug('Observed tps-gcm-files-updated event', { count: paths.length, sample: paths.slice(0, 5) });
            for (const path of paths) {
                const f = plugin.app.vault.getFileByPath(path);
                if (!f) continue;
                scheduleResponsiveMenuRefresh(f, { rebuildInlineSubitems: true, delayMs: 50, lateDelayMs: 320 });
            }
        }),
    );

    // ── Vault events ─────────────────────────────────────────────────────────

    plugin.registerEvent(
        plugin.app.vault.on('rename', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                plugin.persistentMenuManager.refreshMenusForFile(file);
                scheduleNotebookRuleApply(file, 'rename', 220);
                setTimeout(() => {
                    plugin.fileNamingService.syncTitleFromFilename(file);
                }, 150);
                if (plugin.settings.enableAutoRename) {
                    setTimeout(() => {
                        plugin.fileNamingService.updateFilenameIfNeeded(file, { bypassCreationGrace: true });
                    }, 600);
                }
            }
        }),
    );

    plugin.registerEvent(
        plugin.app.vault.on('create', (file) => {
            if (!(file instanceof TFile) || file.extension !== 'md') return;
            scheduleNotebookRuleApply(file, 'create', 2200);
        }),
    );

    plugin.app.workspace.onLayoutReady(() => {
        const activeFile = plugin.app.workspace.getActiveFile();
        if (activeFile instanceof TFile) {
            refreshOpenNoteUiImmediately(activeFile, { rebuildInlineSubitems: true });
            scheduleResponsiveMenuRefresh(activeFile, { rebuildInlineSubitems: true, delayMs: 120 });
        }
    });

    plugin.register(() => plugin.persistentMenuManager.detach());
    plugin.register(() => plugin.menuController.detach());
    plugin.register(() => {
        for (const timer of pendingRefreshTimers.values()) window.clearTimeout(timer);
        for (const timer of pendingLateRefreshTimers.values()) window.clearTimeout(timer);
        for (const timer of pendingRecurrenceAdvanceTimers.values()) window.clearTimeout(timer);
        for (const timer of pendingSubitemTimers.values()) window.clearTimeout(timer);
        for (const timer of pendingNotebookRuleTimers.values()) window.clearTimeout(timer);
        for (const timers of pendingFileOpenGuardTimers.values()) {
            for (const timer of timers) window.clearTimeout(timer);
        }
        pendingRefreshTimers.clear();
        pendingLateRefreshTimers.clear();
        pendingRecurrenceAdvanceTimers.clear();
        pendingSubitemTimers.clear();
        pendingNotebookRuleTimers.clear();
        pendingFileOpenGuardTimers.clear();
    });

    plugin.registerEvent(
        plugin.app.vault.on('delete', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                void (async () => {
                    await plugin.bulkEditService.cleanupLinksForDeletedFile(file.path, file.basename);
                    const activeFile = plugin.app.workspace.getActiveFile();
                    if (activeFile instanceof TFile && activeFile.extension === 'md') {
                        refreshOpenNoteUiImmediately(activeFile, { rebuildInlineSubitems: true });
                        scheduleSubitemRefresh(activeFile, { delay: 40 });
                    }
                    plugin.inlineTaskSubtaskService?.ensureForAllMarkdownViews();
                    plugin.linkedSubitemCheckboxService?.ensureForAllMarkdownViews();
                    plugin.linkedSubitemCheckboxService?.refreshLivePreviewEditors();
                })();
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
