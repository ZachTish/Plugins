import { Notice } from 'obsidian';
import * as logger from '../logger';
import type TPSGlobalContextMenuPlugin from '../main';

/**
 * Registers all plugin commands on the given plugin instance.
 * Extracted from `onload` to keep main.ts concise.
 */
export function registerGcmCommands(plugin: TPSGlobalContextMenuPlugin): void {
    plugin.addCommand({
        id: 'toggle-backlinks-panel',
        name: 'Toggle Backlinks panel',
        callback: () => {
            void plugin.toggleBacklinksPanel();
        },
    });

    plugin.addCommand({
        id: 'open-in-right-sidebar',
        name: 'Open active file in Right Sidebar',
        checkCallback: (checking: boolean) => {
            const file = plugin.app.workspace.getActiveFile();
            if (file) {
                if (!checking) {
                    void plugin.openFileInLeaf(
                        file,
                        'split',
                        () => plugin.app.workspace.getRightLeaf(true),
                        { revealLeaf: true },
                    );
                }
                return true;
            }
            return false;
        },
    });

    plugin.addCommand({
        id: 'open-in-left-sidebar',
        name: 'Open active file in Left Sidebar',
        checkCallback: (checking: boolean) => {
            const file = plugin.app.workspace.getActiveFile();
            if (file) {
                if (!checking) {
                    void plugin.openFileInLeaf(
                        file,
                        'split',
                        () => plugin.app.workspace.getLeftLeaf(true),
                        { revealLeaf: true },
                    );
                }
                return true;
            }
            return false;
        },
    });

    plugin.addCommand({
        id: 'repair-template-derived-titles',
        name: 'Repair template-derived titles from filenames',
        callback: async () => {
            new Notice('TPS GCM: Repairing template-derived titles...');
            try {
                const result = await plugin.fileNamingService.repairTemplateDerivedTitlesAcrossVault();
                new Notice(
                    `TPS GCM: Title repair complete. Updated ${result.updated} of ${result.scanned} scanned notes${result.failed > 0 ? ` (${result.failed} failed)` : ''}.`,
                );
            } catch (error) {
                logger.error('[TPS GCM] Failed to repair template-derived titles', error);
                new Notice('TPS GCM: Title repair failed. Check console logs.');
            }
        },
    });

    plugin.addCommand({
        id: 'toggle-inline-ui',
        name: 'Toggle inline context menu UI',
        callback: async () => {
            plugin.settings.enableInlinePersistentMenus = !plugin.settings.enableInlinePersistentMenus;
            await plugin.saveSettings();
            new Notice(
                plugin.settings.enableInlinePersistentMenus
                    ? 'TPS GCM inline UI enabled'
                    : 'TPS GCM inline UI hidden',
            );
        },
    });
}
