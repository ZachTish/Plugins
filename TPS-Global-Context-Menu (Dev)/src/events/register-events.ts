import { TFile, Platform, debounce } from 'obsidian';
import { resolveLinkValueToFile } from '../handlers/parent-link-format';
import type TPSGlobalContextMenuPlugin from '../main';

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

    plugin.registerEvent(plugin.app.workspace.on('layout-change', throttledEnsureMenus));

    plugin.registerEvent(
        plugin.app.workspace.on('active-leaf-change', () => {
            throttledEnsureMenus();
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

    plugin.registerEvent(
        plugin.app.workspace.on('file-open', (file) => {
            ensureMenus();
            if (file && Platform.isMobile) {
                setTimeout(() => {
                    plugin.persistentMenuManager.refreshMenusForFile(file);
                }, 500);
            }
            if (file && plugin.fileNamingService.shouldProcess(file)) {
                setTimeout(() => {
                    plugin.fileNamingService.processFileOnOpen(file);
                }, 500);
            }
            // Update checklist property for the newly opened note
            if (file instanceof TFile) {
                plugin.taskCheckboxHandler.scheduleChecklistPropertyUpdate(file);
                previousActiveFile = file;
            }
        }),
    );

    // ── Debounced frontmatter/filename sync ──────────────────────────────────

    const debouncedMenuRefresh = debounce((file: TFile) => {
        if (file && file.extension === 'md') {
            plugin.persistentMenuManager.refreshMenusForFile(file);

            const parentKey = String(plugin.settings.parentLinkFrontmatterKey || 'childOf').trim() || 'childOf';
            const fm = (plugin.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
            const fmParentKey = Object.keys(fm).find((k) => k.toLowerCase() === parentKey.toLowerCase());
            if (fmParentKey !== undefined) {
                const parentRaw = fm[fmParentKey];
                const parentValues = Array.isArray(parentRaw) ? parentRaw : [parentRaw];
                for (const pv of parentValues) {
                    const parentFile = resolveLinkValueToFile(plugin.app, pv, file.path);
                    if (parentFile instanceof TFile && parentFile.path !== file.path) {
                        plugin.persistentMenuManager.refreshMenusForFile(parentFile);
                    }
                }
            }
        }
    }, 2000, false);

    const debouncedFilenameSync = debounce((file: TFile) => {
        if (!file || file.extension !== 'md') return;
        const active = plugin.app.workspace.getActiveFile();
        if (file !== active) return;
        if (!plugin.fileNamingService.shouldProcess(file)) return;
        if (plugin.settings.enableAutoRename) {
            plugin.fileNamingService.updateFilenameIfNeeded(file);
        }
        if (plugin.settings.autoSyncTitleFromFilename) {
            plugin.fileNamingService.syncTitleFromFilename(file);
        }
    }, 1500, false);

    plugin.registerEvent(
        plugin.app.metadataCache.on('changed', (file) => {
            debouncedMenuRefresh(file);
            debouncedFilenameSync(file);
        }),
    );

    // ── Vault events ─────────────────────────────────────────────────────────

    plugin.registerEvent(
        plugin.app.vault.on('rename', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                plugin.persistentMenuManager.refreshMenusForFile(file);
                setTimeout(() => {
                    plugin.fileNamingService.syncTitleFromFilename(file);
                }, 150);
            }
        }),
    );

    plugin.register(() => plugin.persistentMenuManager.detach());
    plugin.register(() => plugin.menuController.detach());

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
}
