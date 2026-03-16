/**
 * Settings Migration Service
 * Migrates settings from old TPS plugins to unified format
 */

import { TPSPlugin } from '../../main';
import { TPSSettings } from '../../types';
import * as logger from '../../logger';

export class MigrationService {
    private plugin: TPSPlugin;

    constructor(plugin: TPSPlugin) {
        this.plugin = plugin;
    }

    async migrateSettings(): Promise<boolean> {
        logger.info('[MigrationService] Starting settings migration');

        let migrated = false;
        let errors: string[] = [];

        // Migrate from each old plugin
        try {
            if (await this.migrateFromController()) {
                migrated = true;
                logger.info('[MigrationService] Migrated Controller settings');
            }
        } catch (error) {
            const msg = 'Error migrating Controller settings';
            logger.error(`[MigrationService] ${msg}:`, error);
            errors.push(msg);
        }

        try {
            if (await this.migrateFromContextMenu()) {
                migrated = true;
                logger.info('[MigrationService] Migrated Context Menu settings');
            }
        } catch (error) {
            const msg = 'Error migrating Context Menu settings';
            logger.error(`[MigrationService] ${msg}:`, error);
            errors.push(msg);
        }

        try {
            if (await this.migrateFromCalendar()) {
                migrated = true;
                logger.info('[MigrationService] Migrated Calendar settings');
            }
        } catch (error) {
            const msg = 'Error migrating Calendar settings';
            logger.error(`[MigrationService] ${msg}:`, error);
            errors.push(msg);
        }

        try {
            if (await this.migrateFromNavigator()) {
                migrated = true;
                logger.info('[MigrationService] Migrated Navigator settings');
            }
        } catch (error) {
            const msg = 'Error migrating Navigator settings';
            logger.error(`[MigrationService] ${msg}:`, error);
            errors.push(msg);
        }

        try {
            if (await this.migrateFromNotifier()) {
                migrated = true;
                logger.info('[MigrationService] Migrated Notifier settings');
            }
        } catch (error) {
            const msg = 'Error migrating Notifier settings';
            logger.error(`[MigrationService] ${msg}:`, error);
            errors.push(msg);
        }

        try {
            if (await this.migrateFromKanban()) {
                migrated = true;
                logger.info('[MigrationService] Migrated Kanban settings');
            }
        } catch (error) {
            const msg = 'Error migrating Kanban settings';
            logger.error(`[MigrationService] ${msg}:`, error);
            errors.push(msg);
        }

        try {
            if (await this.migrateFromAutoEmbed()) {
                migrated = true;
                logger.info('[MigrationService] Migrated Auto Embed settings');
            }
        } catch (error) {
            const msg = 'Error migrating Auto Embed settings';
            logger.error(`[MigrationService] ${msg}:`, error);
            errors.push(msg);
        }

        // Mark migration as complete
        this.plugin.settings._migratedFromPlugins = true;
        await this.plugin.saveSettings();

        if (errors.length > 0) {
            logger.warn(`[MigrationService] Migration completed with ${errors.length} errors:`, errors);
        } else {
            logger.info('[MigrationService] Migration completed successfully');
        }

        return migrated;
    }

    private async migrateFromController(): Promise<boolean> {
        const oldData = await this.loadOldPluginData('tps-controller');
        if (!oldData) return false;

        // Migrate controller settings
        if (oldData.deviceRole) {
            this.plugin.settings.features.controller.deviceRole = oldData.deviceRole;
        }
        if (oldData.syncIntervalMinutes !== undefined) {
            this.plugin.settings.features.controller.syncIntervalMinutes = oldData.syncIntervalMinutes;
        }
        if (oldData.externalCalendars) {
            this.plugin.settings.features.controller.externalCalendars = oldData.externalCalendars;
        }
        if (oldData.reminders) {
            this.plugin.settings.features.controller.reminders = oldData.reminders;
        }

        return true;
    }

    private async migrateFromContextMenu(): Promise<boolean> {
        const oldData = await this.loadOldPluginData('tps-global-context-menu');
        if (!oldData) return false;

        // Migrate context menu settings
        // TODO: Map old GCM settings to new structure
        this.plugin.settings.features.contextMenu.enabled = true;

        return true;
    }

    private async migrateFromCalendar(): Promise<boolean> {
        const oldData = await this.loadOldPluginData('tps-calendar-base');
        if (!oldData) return false;

        // Migrate calendar settings
        // TODO: Map old Calendar settings to new structure
        this.plugin.settings.features.calendar.enabled = true;

        return true;
    }

    private async migrateFromNavigator(): Promise<boolean> {
        const oldData = await this.loadOldPluginData('tps-notebook-navigator-companion');
        if (!oldData) return false;

        // Migrate navigator settings
        // TODO: Map old NN settings to new structure
        this.plugin.settings.features.navigator.enabled = true;

        return true;
    }

    private async migrateFromNotifier(): Promise<boolean> {
        const oldData = await this.loadOldPluginData('tps-notifier');
        if (!oldData) return false;

        // Migrate notifier settings
        if (oldData.serverUrl) {
            this.plugin.settings.features.notifier.ntfy.serverUrl = oldData.serverUrl;
        }
        if (oldData.topic) {
            this.plugin.settings.features.notifier.ntfy.topic = oldData.topic;
        }

        this.plugin.settings.features.notifier.enabled = !!(oldData.serverUrl && oldData.topic);

        return true;
    }

    private async migrateFromKanban(): Promise<boolean> {
        const oldData = await this.loadOldPluginData('tps-kanban');
        if (!oldData) return false;

        // Migrate kanban settings
        // TODO: Map old Kanban settings to new structure
        this.plugin.settings.features.kanban.enabled = true;

        return true;
    }

    private async migrateFromAutoEmbed(): Promise<boolean> {
        const oldData = await this.loadOldPluginData('tps-auto-base-embed');
        if (!oldData) return false;

        // Migrate auto embed settings
        if (oldData.baseFile) {
            this.plugin.settings.features.autoEmbed.baseFile = oldData.baseFile;
        }
        if (oldData.embedPosition) {
            this.plugin.settings.features.autoEmbed.embedPosition = oldData.embedPosition;
        }

        this.plugin.settings.features.autoEmbed.enabled = !!oldData.baseFile;

        return true;
    }

    private async loadOldPluginData(pluginId: string): Promise<any | null> {
        try {
            // Try to read data.json from old plugin directory
            const oldPluginPath = `.obsidian/plugins/${pluginId}/data.json`;
            const adapter = this.plugin.app.vault.adapter;

            if (await adapter.exists(oldPluginPath)) {
                const data = await adapter.read(oldPluginPath);
                return JSON.parse(data);
            }

            return null;
        } catch (error) {
            logger.debug(`[MigrationService] Could not load data for ${pluginId}:`, error);
            return null;
        }
    }
}
