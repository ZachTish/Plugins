/**
 * Notifier Feature Module
 * Handles push notifications via ntfy.sh
 */

import { TPSPlugin } from '../../main';
import { NotifierSettings } from '../../types';
import * as logger from '../../logger';

export class NotifierFeature {
    private plugin: TPSPlugin;
    private settings: NotifierSettings;

    constructor() {
        // Initialize
    }

    async onload(plugin: TPSPlugin): Promise<void> {
        this.plugin = plugin;
        this.settings = plugin.settings.features.notifier;

        logger.info('[NotifierFeature] Loading notifier feature');

        // Check if feature is enabled
        if (!this.settings.enabled) {
            logger.info('[NotifierFeature] Notifier feature disabled, skipping');
            return;
        }

        // Register commands
        this.registerCommands();

        // Initialize ntfy client
        this.initializeNtfyClient();

        logger.info('[NotifierFeature] Notifier feature loaded');
    }

    async onunload(): Promise<void> {
        logger.info('[NotifierFeature] Unloading notifier feature');
        // Cleanup will be implemented when we migrate the notifier service
    }

    private registerCommands(): void {
        // Test notification
        this.plugin.addCommand({
            id: 'tps-send-test-notification',
            name: 'TPS: Send test notification',
            callback: async () => {
                await this.sendTestNotification();
            }
        });

        logger.debug('[NotifierFeature] Commands registered');
    }

    private initializeNtfyClient(): void {
        // TODO: Implement ntfy.sh client initialization
        // This will be implemented when we migrate from TPS-Notifier
        logger.debug('[NotifierFeature] ntfy client initialized');
    }

    private async sendTestNotification(): Promise<void> {
        if (!this.settings.ntfy.serverUrl || !this.settings.ntfy.topic) {
            new Notice('TPS: Please configure ntfy server URL and topic in settings');
            return;
        }

        logger.info('[NotifierFeature] Sending test notification');

        try {
            // TODO: Implement actual notification sending
            new Notice(`TPS: Test notification sent to ${this.settings.ntfy.topic}`);
        } catch (error) {
            logger.error('[NotifierFeature] Error sending test notification:', error);
            new Notice('TPS: Failed to send test notification');
        }
    }

    // Public API methods
    async sendNotification(title: string, message: string): Promise<void> {
        // TODO: Implement notification sending
        logger.debug(`[NotifierFeature] Notification: ${title} - ${message}`);
    }
}
