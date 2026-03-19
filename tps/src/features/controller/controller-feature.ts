/**
 * Controller Feature Module
 * Orchestrates device role management, calendar sync, and reminders
 */

import { Notice } from 'obsidian';
import TPSPlugin from '../../main';
import { ControllerSettings, DEFAULT_TPS_SETTINGS } from '../../types';
import { DeviceRoleManager } from '../../core/device-role-manager';
import * as logger from '../../logger';
import { ExternalCalendarService } from '../../services/calendar/external-calendar-service';
import { ICalParserService } from '../../services/calendar/ical-parser-service';
import { AutoCreateService } from '../../services/templates/auto-create-service';
import { ExternalCalendarDuplicateCleanupService } from '../../services/calendar/external-calendar-duplicate-cleanup-service';
import { SyncConflictWatcher } from '../../services/sync/sync-conflict-watcher';
import { SyncRequestService } from '../../services/sync/sync-request-service';

export class ControllerFeature {
    private plugin: TPSPlugin;
    private settings: ControllerSettings;

    // Services
    deviceRoleManager: DeviceRoleManager;
    externalCalendarService?: ExternalCalendarService;
    icalParserService?: ICalParserService;
    autoCreateService?: AutoCreateService;
    duplicateCleanupService?: ExternalCalendarDuplicateCleanupService;
    syncConflictWatcher?: SyncConflictWatcher;
    syncRequestService?: SyncRequestService;

    // Intervals
    private syncInterval?: number;
    private reminderInterval?: number;

    constructor(plugin?: TPSPlugin) {
        this.deviceRoleManager = new DeviceRoleManager((plugin?.app as any) ?? null);
        if (plugin) { this.plugin = plugin; this.settings = plugin.settings.features.controller; }
    }

    async onload(plugin: TPSPlugin): Promise<void> {
        this.plugin = plugin;
        this.settings = plugin.settings.features.controller;

        logger.info('[ControllerFeature] Loading controller feature');

        // Check if feature is enabled
        if (!this.isControllerDevice()) {
            logger.info('[ControllerFeature] Not a controller device, skipping background services');
            return;
        }

        // Initialize services
        this.initializeServices();

        // Register commands
        this.registerCommands();

        // Start background services
        this.startBackgroundServices();

        logger.info('[ControllerFeature] Controller feature loaded');
    }

    async onunload(): Promise<void> {
        logger.info('[ControllerFeature] Unloading controller feature');

        // Stop intervals
        if (this.syncInterval) {
            window.clearInterval(this.syncInterval);
        }
        if (this.reminderInterval) {
            window.clearInterval(this.reminderInterval);
        }

        // Unload services
        if (this.syncConflictWatcher) {
            (this.syncConflictWatcher as any).stop?.();
        }
        if (this.syncRequestService) {
            // no teardown needed
        }

        logger.info('[ControllerFeature] Controller feature unloaded');
    }

    private isControllerDevice(): boolean {
        const role = this.settings.deviceRole;
        return role === 'controller' || role === 'standalone';
    }

    private initializeServices(): void {
        // Calendar services
        this.icalParserService = new ICalParserService();
        this.externalCalendarService = new ExternalCalendarService();

        // Auto-create service
        this.autoCreateService = new AutoCreateService(this.plugin.app);
        this.duplicateCleanupService = new ExternalCalendarDuplicateCleanupService(this.plugin.app, () => this.settings);

        // Sync services
        this.syncConflictWatcher = new SyncConflictWatcher(this.plugin.app);
        const pluginDir = (this.plugin as any).manifest?.dir ?? '';
        this.syncRequestService = new SyncRequestService(this.plugin.app, pluginDir);

        logger.info('[ControllerFeature] Services initialized');
    }

    private registerCommands(): void {
        // Sync external calendars
        this.plugin.addCommand({
            id: 'tps-sync-external-calendars',
            name: 'TPS: Sync external calendars',
            callback: async () => {
                if (!this.externalCalendarService) return;
                await this.syncExternalCalendars();
            }
        });

        this.plugin.addCommand({
            id: 'tps-clean-duplicate-external-calendar-notes',
            name: 'TPS: Clean duplicate external calendar notes',
            callback: async () => {
                if (!this.duplicateCleanupService) return;
                const result = await this.duplicateCleanupService.run();
                new Notice(`TPS calendar duplicate cleanup: archived ${result.archivedCount}, skipped ${result.skippedWithContent} with body content, found ${result.groupsFound} duplicate groups.`);
            }
        });

        // Toggle device role
        this.plugin.addCommand({
            id: 'tps-toggle-device-role',
            name: 'TPS: Toggle device role (Controller/User)',
            callback: () => {
                this.toggleDeviceRole();
            }
        });

        logger.debug('[ControllerFeature] Commands registered');
    }

    private startBackgroundServices(): void {
        // External calendar sync
        if (this.settings.syncIntervalMinutes > 0) {
            const syncIntervalMs = this.settings.syncIntervalMinutes * 60 * 1000;
            this.syncInterval = window.setInterval(() => {
                this.syncExternalCalendars();
            }, syncIntervalMs);

            logger.info(`[ControllerFeature] Calendar sync interval: ${this.settings.syncIntervalMinutes} minutes`);
        }

        // Reminder polling
        if (this.settings.enableReminders && this.settings.pollMinutes > 0) {
            const reminderIntervalMs = this.settings.pollMinutes * 60 * 1000;
            this.reminderInterval = window.setInterval(() => {
                this.evaluateReminders();
            }, reminderIntervalMs);

            logger.info(`[ControllerFeature] Reminder poll interval: ${this.settings.pollMinutes} minutes`);
        }

        // Start sync conflict watcher
        if (this.syncConflictWatcher) {
            (this.syncConflictWatcher as any).start?.();
        }

        // sync request service has no start method
    }

    private async syncExternalCalendars(): Promise<void> {
        if (!this.externalCalendarService) return;

        logger.info('[ControllerFeature] Syncing external calendars');

        try {
            for (const calendar of this.settings.externalCalendars) {
                if (!calendar.enabled) continue;

                logger.debug(`[ControllerFeature] Syncing calendar: ${calendar.id}`);

                const events = await this.externalCalendarService.fetchEvents(
                    calendar.url,
                    undefined,
                    undefined,
                    this.settings.canceledStatusValue !== 'show'
                );

                logger.debug(`[ControllerFeature] Fetched ${events.length} events from ${calendar.id}`);
            }

            logger.info('[ControllerFeature] External calendars synced');
        } catch (error) {
            logger.error('[ControllerFeature] Error syncing calendars:', error);
        }
    }

    private async evaluateReminders(): Promise<void> {
        // TODO: Implement reminder evaluation
        // This will be implemented when we migrate the reminder engine
        logger.debug('[ControllerFeature] Evaluating reminders');
    }

    private toggleDeviceRole(): void {
        const currentRole = this.settings.deviceRole;
        const newRole = currentRole === 'controller' ? 'user' : 'controller';

        this.settings.deviceRole = newRole;
        this.plugin.saveSettings();

        logger.info(`[ControllerFeature] Device role changed: ${currentRole} → ${newRole}`);

        // Reload the plugin to apply changes
        // (In production, we might want to gracefully restart services instead)
        new Notice(`TPS: Device role changed to ${newRole}. Reload Obsidian to apply.`);
    }

    // Public API methods
    getRole() {
        return this.settings.deviceRole;
    }

    async syncCalendars() {
        return this.syncExternalCalendars();
    }
}
