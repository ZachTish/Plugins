/**
 * Auto Embed Feature Module
 * Automatically embeds a Base at the bottom of notes
 */

import TPSPlugin from '../../main';
import { AutoEmbedSettings } from '../../types';
import * as logger from '../../logger';

export class AutoEmbedFeature {
    private plugin: TPSPlugin;
    private settings: AutoEmbedSettings;
    private processor?: (content: string) => string;

    constructor() {
        // Initialize
    }

    async onload(plugin: TPSPlugin): Promise<void> {
        this.plugin = plugin;
        this.settings = plugin.settings.features.autoEmbed;

        logger.info('[AutoEmbedFeature] Loading auto-embed feature');

        // Check if feature is enabled
        if (!this.settings.enabled) {
            logger.info('[AutoEmbedFeature] Auto-embed feature disabled, skipping');
            return;
        }

        if (!this.settings.baseFile) {
            logger.warn('[AutoEmbedFeature] No base file configured, skipping');
            return;
        }

        // Register markdown post processor
        this.registerPostProcessor();

        logger.info('[AutoEmbedFeature] Auto-embed feature loaded');
    }

    async onunload(): Promise<void> {
        logger.info('[AutoEmbedFeature] Unloading auto-embed feature');
        // Cleanup is automatic via Plugin.register()
    }

    private registerPostProcessor(): void {
        this.plugin.registerMarkdownPostProcessor((el, ctx) => {
            if (!this.settings.enabled) return;

            const file = this.plugin.app.metadataCache.getFirstLinkpathDest('', ctx.sourcePath);
            if (!file) return;

            // Check if file should be excluded
            if (this.shouldExcludeFile(file.path)) {
                return;
            }

            // Check if base is already embedded
            if (this.isBaseAlreadyEmbedded(el)) {
                return;
            }

            // Append base embed
            this.appendBaseEmbed(el);
        });

        logger.debug('[AutoEmbedFeature] Post-processor registered');
    }

    private shouldExcludeFile(filePath: string): boolean {
        return this.settings.excludePaths.some(path => filePath.includes(path));
    }

    private isBaseAlreadyEmbedded(el: HTMLElement): boolean {
        // Check if the base file is already linked/embedded in the content
        const links = el.querySelectorAll('a.internal-link, span.internal-embed');
        return Array.from(links).some(link =>
            link.textContent?.includes(this.settings.baseFile) ||
            link.getAttribute('data-href')?.includes(this.settings.baseFile)
        );
    }

    private appendBaseEmbed(el: HTMLElement): void {
        // Create embed element
        const embedDiv = el.createEl('div', {
            cls: 'tps-auto-embed',
            attr: {
                'data-base-file': this.settings.baseFile
            }
        });

        // Create the embed link
        const embedLink = embedDiv.createEl('a', {
            cls: 'internal-embed',
            text: `![[${this.settings.baseFile}]]`,
            attr: {
                'data-href': this.settings.baseFile,
                'href': this.settings.baseFile,
                'target': '_blank',
                'rel': 'noopener'
            }
        });

        // Position: top or bottom
        if (this.settings.embedPosition === 'top') {
            el.prepend(embedDiv);
        } else {
            el.appendChild(embedDiv);
        }

        logger.debug(`[AutoEmbedFeature] Appended base embed: ${this.settings.baseFile}`);
    }

    // Public API methods
    updateBaseFile(baseFile: string): void {
        this.settings.baseFile = baseFile;
        this.plugin.saveSettings();
        logger.info(`[AutoEmbedFeature] Base file updated: ${baseFile}`);
    }
}
