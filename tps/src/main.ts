/**
 * TPS - Unified Productivity Suite
 * Main plugin entry point
 */

import { Plugin, Notice } from 'obsidian';
import { TPSSettings, DEFAULT_TPS_SETTINGS } from './types';
import { setLoggingEnabled } from './logger';
import { PLUGIN_NAME, PLUGIN_VERSION } from './constants';
import { ControllerFeature } from './features/controller/controller-feature';
import { ContextMenuFeature } from './features/context-menu/context-menu-feature';
import { CalendarFeature } from './features/calendar/calendar-feature';
import { NavigatorFeature } from './features/notebook-navigator/navigator-feature';
import { NotifierFeature } from './features/notifier/notifier-feature';
import { KanbanFeature } from './features/kanban/kanban-feature';
import { AutoEmbedFeature } from './features/auto-embed/auto-embed-feature';
import { MigrationService } from './services/automation/migration-service';

export default class TPSPlugin extends Plugin {
    settings: TPSSettings;
    api: TPSAPI;
    [key: string]: any;

    // Features
    features = {
        controller: new ControllerFeature(),
        contextMenu: new ContextMenuFeature(),
        calendar: new CalendarFeature(),
        navigator: new NavigatorFeature(),
        notifier: new NotifierFeature(),
        kanban: new KanbanFeature(),
        autoEmbed: new AutoEmbedFeature(),
    };

    async onload() {
        console.log(`${PLUGIN_NAME} v${PLUGIN_VERSION} loading`);

        // Load settings
        await this.loadSettings();

        // Configure logging
        setLoggingEnabled(this.settings.debug.enableLogging);

        // Migration: Check if we need to migrate from old plugins
        if (!this.settings._migratedFromPlugins) {
            await this.migrateSettings();
        }

        // Initialize features
        try {
            await this.features.controller.onload(this);
            await this.features.contextMenu.onload(this);
            await this.features.calendar.onload(this);
            await this.features.navigator.onload(this);
            await this.features.notifier.onload(this);
            await this.features.kanban.onload(this);
            await this.features.autoEmbed.onload(this);
        } catch (error) {
            console.error('Error loading features:', error);
        }

        // Expose public API
        this.api = new TPSAPI(this, this.features);

        console.log(`${PLUGIN_NAME} v${PLUGIN_VERSION} loaded`);
    }

    onunload() {
        console.log(`${PLUGIN_NAME} v${PLUGIN_VERSION} unloading`);

        // Cleanup features
        this.features.controller.onunload();
        this.features.contextMenu.onunload();
        this.features.calendar.onunload();
        this.features.navigator.onunload();
        this.features.notifier.onunload();
        this.features.kanban.onunload();
        this.features.autoEmbed.onunload();
    }

    async loadSettings() {
        const saved = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_TPS_SETTINGS, saved);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async migrateSettings() {
        // Migration from old plugins
        const migrationService = new MigrationService(this);
        await migrationService.migrateSettings();

        console.log('TPS: Settings migration complete');
    }
}

/**
 * Public API for third-party plugins
 */
class TPSAPI {
    version: string = PLUGIN_VERSION;

    constructor(
        private plugin: TPSPlugin,
        private features: {
            controller: ControllerFeature;
            contextMenu: ContextMenuFeature;
            calendar: CalendarFeature;
            navigator: NavigatorFeature;
            notifier: NotifierFeature;
            kanban: KanbanFeature;
            autoEmbed: AutoEmbedFeature;
        }
    ) {}

    // Controller API
    getRole() {
        return this.features.controller.getRole();
    }

    async syncCalendars() {
        return this.features.controller.syncCalendars();
    }

    // Calendar API
    getEventsInRange(rangeStart: Date, rangeEnd: Date) {
        return this.features.calendar.getEventsInRange(rangeStart, rangeEnd);
    }

    async refreshCalendar() {
        return this.features.calendar.refresh();
    }

    // Context Menu API
    showMenu(file: any) {
        return this.features.contextMenu.showMenu(file);
    }

    updateInlinePanels(file: any) {
        return this.features.contextMenu.updateInlinePanels(file);
    }

    // Notifier API
    async sendNotification(title: string, message: string) {
        return this.features.notifier.sendNotification(title, message);
    }

    // General settings
    getSettings() {
        return this.plugin.settings as Readonly<TPSSettings>;
    }

    // More API methods will be added as we implement features
}
