import { Component, TFile, WorkspaceLeaf } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import * as logger from '../logger';

/**
 * CanvasSplitHandler
 *
 * Safety mode: this handler is intentionally inert to avoid sidebar-related
 * crashes while we isolate root cause.
 */
export class CanvasSplitHandler extends Component {
    private plugin: TPSGlobalContextMenuPlugin;

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        super();
        this.plugin = plugin;
    }

    onload(): void {
        logger.log('[TPS GCM] CanvasSplitHandler loaded (safety mode: disabled)');
    }

    onunload(): void {
        logger.log('[TPS GCM] CanvasSplitHandler unloaded');
    }

    getPreferredMarkdownLeafForNewNote(_file?: TFile): WorkspaceLeaf | null {
        return null;
    }
}
