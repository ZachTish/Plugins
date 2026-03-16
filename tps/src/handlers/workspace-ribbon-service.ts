import * as logger from '../logger';
import type TPSGlobalContextMenuPlugin from '../main';

/**
 * Manages ribbon buttons for each workspace saved in Obsidian's core Workspaces plugin.
 * Buttons are created when the setting is enabled and torn down if it is disabled or
 * the plugin is unloaded.
 */
export class WorkspaceRibbonService {
    private plugin: TPSGlobalContextMenuPlugin;
    private ribbonElements: HTMLElement[] = [];
    private static readonly FALLBACK_ICON = 'layout-dashboard';

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        this.plugin = plugin;
    }

    /** Returns the internal Workspaces plugin instance, or null if unavailable / disabled. */
    private getWorkspacesInstance(): any {
        const internal = (this.plugin.app as any).internalPlugins;
        if (!internal) return null;
        const wp = internal.plugins?.['workspaces'] ?? internal.getPluginById?.('workspaces');
        if (!wp) return null;
        // `enabled` may be false even if the object exists
        if (wp.enabled === false) return null;
        return wp.instance ?? null;
    }

    /**
     * Reads current workspaces and creates one ribbon icon per workspace.
     * Any existing icons are removed first.
     */
    setup(): void {
        this.teardown();

        if (!this.plugin.settings.workspaceRibbonButtons) return;

        const instance = this.getWorkspacesInstance();
        if (!instance) {
            logger.log('[TPS GCM] WorkspaceRibbonService: core Workspaces plugin not available');
            return;
        }

        const workspaces: Record<string, unknown> = instance.workspaces ?? {};
        const names = Object.keys(workspaces).sort();

        if (names.length === 0) {
            logger.log('[TPS GCM] WorkspaceRibbonService: no saved workspaces found');
            return;
        }

        logger.log(`[TPS GCM] WorkspaceRibbonService: creating ribbon buttons for ${names.length} workspace(s)`);

        for (const name of names) {
            const configuredIcon = this.resolveIconForWorkspace(name);
            const el = this.createRibbonButton(instance, name, configuredIcon);
            if (!el) continue;
            // Tag so we can identify these elements easily
            el.setAttribute('data-tps-workspace', name);
            this.ribbonElements.push(el);
        }
    }

    private resolveIconForWorkspace(workspaceName: string): string {
        const configured = this.plugin.settings.workspaceRibbonIcons?.[workspaceName];
        const iconName = typeof configured === 'string' ? configured.trim() : '';
        return iconName || WorkspaceRibbonService.FALLBACK_ICON;
    }

    private createRibbonButton(instance: any, workspaceName: string, iconName: string): HTMLElement | null {
        const clickHandler = () => {
            logger.log(`[TPS GCM] Loading workspace: ${workspaceName}`);
            instance.loadWorkspace(workspaceName);
        };

        try {
            return this.plugin.addRibbonIcon(iconName, `Load workspace: ${workspaceName}`, clickHandler);
        } catch (error) {
            logger.log('[TPS GCM] WorkspaceRibbonService: failed to render configured workspace icon; falling back', {
                workspace: workspaceName,
                icon: iconName,
                error,
            });
        }

        try {
            return this.plugin.addRibbonIcon(
                WorkspaceRibbonService.FALLBACK_ICON,
                `Load workspace: ${workspaceName}`,
                clickHandler,
            );
        } catch (error) {
            logger.log('[TPS GCM] WorkspaceRibbonService: failed to render fallback workspace icon', {
                workspace: workspaceName,
                error,
            });
            return null;
        }
    }

    /** Removes all workspace ribbon buttons created by this service. */
    teardown(): void {
        for (const el of this.ribbonElements) {
            el.remove();
        }
        this.ribbonElements = [];
    }

    /** Re-reads workspaces and rebuilds ribbon buttons. */
    refresh(): void {
        this.setup();
    }
}
