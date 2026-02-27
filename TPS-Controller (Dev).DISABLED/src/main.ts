import { Plugin, Notice, TFile } from "obsidian";
import { DeviceRoleManager, DeviceRole } from "./device-role-manager";
import { TPSControllerSettings, DEFAULT_CONTROLLER_SETTINGS, ExternalCalendarConfig } from "./types";
import { AutoCreateService, AutoCreateServiceConfig } from "./services/auto-create-service";
import { ExternalCalendarService } from "./services/external-calendar-service";
import { ReminderEngine, PendingNotification } from "./services/reminder-engine";
import { SyncRequestService } from "./sync-request-service";
import { SyncConflictWatcher } from "./services/sync-conflict-watcher";
import { normalizeCalendarUrl, normalizeCalendarTag } from "./utils";
import { TPSControllerSettingTab } from "./settings-tab";
import * as logger from "./logger";

// ============================================================================
// Plugin API Types (for cross-plugin communication)
// ============================================================================

interface CalendarPluginAPI {
    getExternalCalendarService?(): ExternalCalendarService;
    getExternalCalendarUrls?(): string[];
    getSettings?(): any;
}

interface NotifierPluginAPI {
    sendNotification?(title: string, body: string, file?: TFile): Promise<void>;
    sendMessage?(text: string, file?: TFile, title?: string): Promise<void>;
    getOverdueItems?(): Promise<any[]>;
    snoozeFile?(file: TFile, minutes: number): Promise<void>;
}

interface CompanionPluginAPI {
    applyRulesToAllFiles?(silent?: boolean): Promise<void>;
    applyRulesToFile?(file: TFile): Promise<void>;
}

interface GcmPluginAPI {
    bulkEditService?: {
        checkMissingRecurrences?: () => Promise<void>;
    };
}

// ============================================================================
// Controller Plugin
// ============================================================================

export default class TPSControllerPlugin extends Plugin {
    settings: TPSControllerSettings;
    deviceRoleManager: DeviceRoleManager;
    private statusBarEl: HTMLElement;

    // Services
    private autoCreateService: AutoCreateService;
    private externalCalendarService: ExternalCalendarService;
    private reminderEngine: ReminderEngine;
    private syncRequestService: SyncRequestService;
    private syncConflictWatcher: SyncConflictWatcher;

    // Intervals
    private calendarSyncIntervalId: number | null = null;
    private reminderIntervalId: number | null = null;
    private companionStartupTimerId: number | null = null;
    private companionSyncIntervalId: number | null = null;

    async onload() {
        logger.log("🚀 PLUGIN LOAD: Starting TPS-Controller plugin load...");
        // Load shared UI styles
        try {
            const cssPath = `${this.manifest.dir}/styles-ui.css`;
            const cssContent = await this.app.vault.adapter.read(cssPath);
            this.register(() => document.head.querySelector('style#tps-controller-ui-styles')?.remove());
            const styleEl = document.head.createEl('style', { attr: { id: 'tps-controller-ui-styles' } });
            styleEl.textContent = cssContent;
        } catch (e) {
            console.warn("[TPS-Controller] Failed to load styles-ui.css", e);
        }
        await this.loadSettings();
        logger.log(`📊 SETTINGS LOADED: pollMinutes=${this.settings.pollMinutes}, syncIntervalMinutes=${this.settings.syncIntervalMinutes}`);

        // Status Bar
        this.statusBarEl = this.addStatusBarItem();
        this.deviceRoleManager = new DeviceRoleManager(this.app, (role) => this.onRoleChanged(role));
        this.updateStatusBar(this.deviceRoleManager.role);
        logger.log(`🔑 DEVICE ROLE: ${this.deviceRoleManager.role}`);

        // Initialize services
        this.autoCreateService = new AutoCreateService(this.app);
        this.externalCalendarService = new ExternalCalendarService();
        this.reminderEngine = new ReminderEngine(this.app);
        this.syncRequestService = new SyncRequestService(this.app, this.manifest.dir);
        this.syncConflictWatcher = new SyncConflictWatcher(this.app);
        logger.log("✅ SERVICES INITIALIZED");

        // commands
        this.addCommand({
            id: "set-device-role-controller",
            name: "Set as Controller (Automation Source)",
            callback: () => {
                this.deviceRoleManager.setRole("controller");
                new Notice("Device set to CONTROLLER.");
            }
        });

        this.addCommand({
            id: "set-device-role-user",
            name: "Set as Replica (Passive)",
            callback: () => {
                this.deviceRoleManager.setRole("user");
                new Notice("Device set to REPLICA.");
            }
        });

        this.addCommand({
            id: "force-calendar-sync",
            name: "Force Calendar Sync Now",
            callback: () => {
                if (this.deviceRoleManager.isController()) {
                    void this.runCalendarSync(true);
                } else {
                    void this.requestSync(["calendar"]);
                }
            }
        });

        this.addCommand({
            id: "review-calendar-sync-quarantine",
            name: "Review Calendar Sync Quarantine",
            callback: () => {
                void this.reviewCalendarSyncQuarantine();
            }
        });

        this.addCommand({
            id: "force-reminder-check",
            name: "Run Reminder Check Now",
            callback: () => {
                if (this.deviceRoleManager.isController()) {
                    void this.runReminderCheck();
                } else {
                    void this.requestSync(["reminders"]);
                }
            }
        });

        this.addCommand({
            id: "force-companion-scan",
            name: "Run Companion Vault Scan Now",
            callback: () => {
                if (this.deviceRoleManager.isController()) {
                    void this.runCompanionScan();
                } else {
                    void this.requestSync(["companion"]);
                }
            }
        });



        // Expose API for other plugins
        (this as any).api = {
            isController: (): boolean => this.deviceRoleManager.isController(),
            getRole: (): DeviceRole => this.deviceRoleManager.role,
            getSettings: (): TPSControllerSettings => this.settings,
            getReminders: () => this.settings.reminders || [],
        };

        // Also expose on window for debugging/legacy access
        (window as any).TPS = { controller: (this as any).api };

        // Settings tab
        this.addSettingTab(new TPSControllerSettingTab(this.app, this));

        // Start automation based on role
        logger.log(`🔀 ROLE CHECK: isController=${this.deviceRoleManager.isController()}`);
        if (this.deviceRoleManager.isController()) {
            logger.log("🎮 ENTERING CONTROLLER MODE...");
            this.enterControllerMode();
        } else {
            logger.log("👤 ENTERING USER MODE...");
            // User: request a sync so the controller processes it next cycle
            void this.requestSync(["calendar", "companion"]);
            // DISABLED: Cross-sync cleanup runs on Controller only
            // Running on user devices causes race conditions where frontmatter
            // gets overwritten while multiple plugins are updating files simultaneously
            // void this.runCrossSyncCleanup();
        }

        logger.log("✅ PLUGIN LOADED SUCCESSFULLY");
    }

    async onunload() {
        this.stopAllAutomation();
        delete (this as any).api;
        delete (window as any).TPS;
    }

    // ========================================================================
    // Settings
    // ========================================================================

    async loadSettings() {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_CONTROLLER_SETTINGS, data);

        // Run migration if needed
        if (!this.settings._migratedFromPlugins) {
            await this.migrateSettingsFromPlugins();
        }

        this.sanitizeFrontmatterKeySettings();
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private sanitizeFrontmatterKeySettings(): void {
        const normalizeKey = (value: unknown, fallback: string): string => {
            const raw = String(value ?? "").trim();
            if (!raw) return fallback;
            return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : fallback;
        };

        this.settings.eventIdKey = normalizeKey(this.settings.eventIdKey, DEFAULT_CONTROLLER_SETTINGS.eventIdKey);
        this.settings.uidKey = normalizeKey(this.settings.uidKey, DEFAULT_CONTROLLER_SETTINGS.uidKey);
        this.settings.titleKey = normalizeKey(this.settings.titleKey, DEFAULT_CONTROLLER_SETTINGS.titleKey);
        this.settings.statusKey = normalizeKey(this.settings.statusKey, DEFAULT_CONTROLLER_SETTINGS.statusKey);
        this.settings.previousStatusKey = normalizeKey(this.settings.previousStatusKey, DEFAULT_CONTROLLER_SETTINGS.previousStatusKey);
        this.settings.startProperty = normalizeKey(this.settings.startProperty, DEFAULT_CONTROLLER_SETTINGS.startProperty);
        this.settings.endProperty = normalizeKey(this.settings.endProperty, DEFAULT_CONTROLLER_SETTINGS.endProperty);

        const identity = new Set([
            this.settings.eventIdKey.toLowerCase(),
            this.settings.uidKey.toLowerCase(),
        ]);

        const ensureNotIdentity = (value: string, fallback: string): string => (
            identity.has(value.toLowerCase()) ? fallback : value
        );

        this.settings.titleKey = ensureNotIdentity(this.settings.titleKey, DEFAULT_CONTROLLER_SETTINGS.titleKey);
        this.settings.statusKey = ensureNotIdentity(this.settings.statusKey, DEFAULT_CONTROLLER_SETTINGS.statusKey);
        this.settings.previousStatusKey = ensureNotIdentity(this.settings.previousStatusKey, DEFAULT_CONTROLLER_SETTINGS.previousStatusKey);
        this.settings.startProperty = ensureNotIdentity(this.settings.startProperty, DEFAULT_CONTROLLER_SETTINGS.startProperty);
        this.settings.endProperty = ensureNotIdentity(this.settings.endProperty, DEFAULT_CONTROLLER_SETTINGS.endProperty);
    }

    // ========================================================================
    // Role Management
    // ========================================================================

    private onRoleChanged(role: DeviceRole) {
        this.updateStatusBar(role);
        if (role === "controller") {
            void this.enterControllerMode();
        } else {
            void this.exitControllerMode();
        }
    }

    private async enterControllerMode() {
        logger.log("🎮 ENTERING CONTROLLER MODE: Controller will run background automation");
        new Notice("Controller mode activated. Running background automation.", 3000);

        // Start automation - controller runs calendar sync, reminders, and companion scans
        logger.log("🚀 STARTING AUTOMATION: Calling startAllAutomation()...");
        this.startAllAutomation();
        logger.log("✅ CONTROLLER MODE ENTERED");
    }

    private async exitControllerMode() {
        // Stop automation
        this.stopAllAutomation();

        new Notice("User mode activated.", 3000);
    }

    private updateStatusBar(role: DeviceRole) {
        if (role === "controller") {
            this.statusBarEl.setText("TPS: Controller");
            this.statusBarEl.setAttr("title", "This device runs automation tasks.");
            this.statusBarEl.addClass("mod-tps-controller");
        } else {
            this.statusBarEl.setText("TPS: User");
            this.statusBarEl.setAttr("title", "This device is in user mode (no background automation).");
            this.statusBarEl.removeClass("mod-tps-controller");
        }
    }

    // ========================================================================
    // Automation Control
    // ========================================================================

    private startAllAutomation() {
        logger.log("⚙️ START ALL AUTOMATION: Initializing all loops...");
        // Fulfill any pending user requests immediately on startup
        logger.log("🔄 Checking for pending sync requests...");
        void this.checkAndFulfillSyncRequests();
        logger.log("📅 Starting calendar sync loop...");
        this.startCalendarSync();
        logger.log("⏰ Starting reminder loop...");
        this.startReminderLoop();
        logger.log("🤝 Starting companion startup...");
        this.startCompanionStartup();
        logger.log("🔍 Starting SyncConflictWatcher...");
        this.syncConflictWatcher.updateConfig(this.settings.archiveFolder, this.settings.eventIdKey);
        this.syncConflictWatcher.start();
        logger.log("✅ ALL AUTOMATION STARTED");
    }

    private stopAllAutomation() {
        this.stopCalendarSync();
        this.stopReminderLoop();
        this.stopCompanionStartup();
        this.stopCompanionSyncInterval();
        this.syncConflictWatcher.stop();
    }

    // ========================================================================
    // Sync Requests (Replica → Controller)
    // ========================================================================

    /** Replica: write a sync request file for the controller to pick up. */
    private async requestSync(scope: ("calendar" | "companion" | "reminders")[]) {
        await this.syncRequestService.writeRequest(scope);
        new Notice(`Sync requested (${scope.join(", ")}). Will be processed by Controller.`);
        logger.log(`Replica requested sync: ${scope.join(", ")}`);
    }

    /** Controller: check for pending sync requests and fulfill them. */
    private async checkAndFulfillSyncRequests(): Promise<void> {
        const request = await this.syncRequestService.readRequest();
        if (!request) return;

        logger.log(`Fulfilling sync request from ${request.requestedBy} at ${new Date(request.requestedAt).toISOString()}`);
        logger.log(`Requested scope: ${request.scope.join(", ")}`);

        if (request.scope.includes("calendar")) {
            await this.runCalendarSync();
        }
        if (request.scope.includes("companion")) {
            await this.runCompanionScan();
        }
        if (request.scope.includes("reminders")) {
            await this.runReminderCheck();
        }

        await this.syncRequestService.clearRequest();
    }

    // ========================================================================
    // Calendar Sync
    // ========================================================================

    private startCalendarSync() {
        logger.log("📅 START CALENDAR SYNC: Stopping existing interval (if any)...");
        this.stopCalendarSync();

        // Update auto-create service config
        logger.log("📅 Updating auto-create service config...");
        this.autoCreateService.updateConfig({
            allowAutoCreate: true,
            noLossSyncMode: this.settings.noLossSyncMode ?? true,
            eventIdKey: this.settings.eventIdKey,
            uidKey: this.settings.uidKey,
            titleKey: this.settings.titleKey,
            statusKey: this.settings.statusKey,
            previousStatusKey: this.settings.previousStatusKey,
            startProperty: this.settings.startProperty,
            endProperty: this.settings.endProperty,
            syncOnEventDelete: this.settings.syncOnEventDelete,
            archiveFolder: this.settings.archiveFolder,
            globalIgnorePaths: this.settings.globalIgnorePaths || [],
            canceledStatusValue: this.settings.canceledStatusValue,
        });

        // Run sync immediately
        logger.log("📅 Running initial calendar sync...");
        void this.runCalendarSync();

        // Set up interval (also checks for user requests each tick)
        const minutes = Math.max(1, this.settings.syncIntervalMinutes || 5);
        const intervalMs = minutes * 60 * 1000;
        logger.log(`📅 Setting up calendar sync interval: ${minutes} minutes (${intervalMs}ms)`);
        this.calendarSyncIntervalId = window.setInterval(() => {
            logger.log("⏲️ CALENDAR SYNC TICK: Interval triggered");
            void this.checkAndFulfillSyncRequests();
            void this.runCalendarSync();
        }, intervalMs);

        logger.log(`✅ Calendar sync interval set (ID: ${this.calendarSyncIntervalId})`);
    }

    private stopCalendarSync() {
        if (this.calendarSyncIntervalId !== null) {
            window.clearInterval(this.calendarSyncIntervalId);
            this.calendarSyncIntervalId = null;
        }
    }

    private async runCalendarSync(force = false): Promise<void> {
        logger.log(`📅 RUN CALENDAR SYNC: Starting (force=${force})...`);

        // Get Calendar URLs - try querying Calendar plugin first, fallback to own settings
        // 1. Prefer Controller's settings
        let calendars: ExternalCalendarConfig[] = this.settings.externalCalendars || [];
        logger.log(`📅 Found ${calendars.length} calendars in Controller settings`);

        // 2. Fallback to Calendar Plugin if Controller has none (legacy/transition)
        let usedFallback = false;
        let calendarPlugin: CalendarPluginAPI | null = null;

        if (!calendars.length) {
            logger.log("📅 No calendars in Controller settings, checking Calendar plugin...");
            calendarPlugin = this.getCalendarPlugin();
            if (calendarPlugin) {
                const calSettings = calendarPlugin.getSettings?.();
                if (calSettings?.externalCalendars?.length) {
                    calendars = calSettings.externalCalendars;
                    usedFallback = true;
                    logger.log(`📅 Using ${calendars.length} external calendars from Calendar Plugin (legacy fallback).`);
                }
            }
        }

        const urls: string[] = Array.from(new Set(
            calendars
                .filter((c) => c.enabled !== false)
                .map((c) => normalizeCalendarUrl(c.url))
                .filter(Boolean)
        ));

        logger.log(`📅 Enabled calendar URLs: ${urls.length}`);

        const calendarConfigs: Record<string, any> = Object.fromEntries(
            calendars
                .filter((c) => c.url)
                .map((c) => [
                    normalizeCalendarUrl(c.url),
                    {
                        typeFolder: c.autoCreateTypeFolder || "",
                        folder: c.autoCreateFolder || "",
                        tag: normalizeCalendarTag(c.autoCreateTag || ""),
                        template: c.autoCreateTemplate || "",
                        autoCreateEnabled: c.autoCreateEnabled !== false,
                    },
                ]),
        );

        if (!urls.length) {
            logger.log("⚠️ No calendar URLs configured, skipping sync.");
            return;
        }

        // Always use Controller's own ExternalCalendarService for sync.
        // The Calendar Base's service is for the calendar UI — sharing it
        // causes cache/state inconsistencies that destabilize event IDs.
        const service = this.externalCalendarService;

        logger.log(`📅 Updating auto-create config for manual/sync execution...`);
        this.autoCreateService.updateConfig({
            allowAutoCreate: true,
            noLossSyncMode: this.settings.noLossSyncMode ?? true,
            eventIdKey: this.settings.eventIdKey,
            uidKey: this.settings.uidKey,
            titleKey: this.settings.titleKey,
            statusKey: this.settings.statusKey,
            previousStatusKey: this.settings.previousStatusKey,
            startProperty: this.settings.startProperty,
            endProperty: this.settings.endProperty,
            syncOnEventDelete: this.settings.syncOnEventDelete,
            archiveFolder: this.settings.archiveFolder,
            globalIgnorePaths: this.settings.globalIgnorePaths || [],
            canceledStatusValue: this.settings.canceledStatusValue,
        });

        logger.log(`📅 Calling autoCreateService.checkAndCreateMeetingNotes() with ${urls.length} URLs...`);
        await this.autoCreateService.checkAndCreateMeetingNotes(
            service,
            urls,
            this.settings.externalCalendarFilter,
            calendarConfigs,
            force
        );

        await this.runRecurrenceMaintenanceTick();
        logger.log("✅ CALENDAR SYNC COMPLETED");
    }

    private async reviewCalendarSyncQuarantine(): Promise<void> {
        const candidates = await this.autoCreateService.getOrphanCandidateFiles();
        if (!candidates.length) {
            new Notice("No calendar quarantine candidates found.");
            return;
        }

        const first = candidates[0];
        const leaf = this.app.workspace.getLeaf(false);
        if (leaf) {
            await leaf.openFile(first, { active: true });
        }

        logger.log(`[Calendar Sync] Quarantine review: ${candidates.length} candidate notes`);
        new Notice(`Calendar quarantine: ${candidates.length} candidate notes. Opened: ${first.basename}`);
    }

    // ========================================================================
    // Reminder Loop
    // ========================================================================

    private startReminderLoop() {
        logger.log("⏰ START REMINDER LOOP: Stopping existing interval (if any)...");
        this.stopReminderLoop();
        logger.log("⏰ Starting reminder check loop...");

        // Run immediately
        logger.log("⏰ Running initial reminder check...");
        void this.runReminderCheck();

        // Set up interval
        const ms = Math.max(30000, this.settings.pollMinutes * 60 * 1000);
        logger.log(`⏰ Setting up reminder interval: ${this.settings.pollMinutes} minutes (${ms}ms)`);
        this.reminderIntervalId = window.setInterval(() => {
            logger.log("⏲️ REMINDER TICK: Interval triggered");
            void this.runReminderCheck();
        }, ms);

        logger.log(`✅ Reminder check interval set (ID: ${this.reminderIntervalId})`);
    }

    private stopReminderLoop() {
        if (this.reminderIntervalId !== null) {
            window.clearInterval(this.reminderIntervalId);
            this.reminderIntervalId = null;
        }
    }

    private async runReminderCheck(): Promise<void> {
        logger.log("⏰ RUN REMINDER CHECK: Starting...");

        const result = await this.reminderEngine.evaluateReminders(this.settings);
        logger.log(`⏰ Reminder check completed: ${result.notifications.length} notifications, stateChanged=${result.stateChanged}`);

        if (result.stateChanged) {
            logger.log("⏰ Saving settings (state changed)...");
            await this.saveSettings();
        }

        if (result.notifications.length === 0) {
            logger.log("⏰ No notifications to send");
            return;
        }

        // Dispatch via Notifier plugin API
        logger.log("⏰ Looking up Notifier plugin...");
        const notifier = this.getNotifierPlugin();
        if (!notifier) {
            logger.warn("⚠️ Notifier plugin not found. Cannot dispatch notifications.");
            return;
        }

        const sendFn = notifier.sendNotification || notifier.sendMessage;
        if (!sendFn) {
            logger.warn("⚠️ Notifier plugin has no sendNotification/sendMessage API.");
            return;
        }

        logger.log(`⏰ Dispatching ${result.notifications.length} notification(s)...`);

        if (this.settings.batchNotifications && result.notifications.length > 1) {
            // Batch
            const count = result.notifications.length;
            const batchTitle = `${count} Overdue Items`;
            const limit = 8;
            const items = result.notifications.slice(0, limit);
            let batchBody = items.map(p => `• ${p.title}`).join('\n');
            if (count > limit) {
                batchBody += `\n...and ${count - limit} more`;
            }
            logger.log(`⏰ Sending batched notification: ${count} items`);
            if (notifier.sendNotification) {
                await notifier.sendNotification(batchTitle, batchBody, undefined);
            } else if (notifier.sendMessage) {
                await notifier.sendMessage(batchBody, undefined, batchTitle);
            }
        } else {
            // Send individually
            logger.log(`⏰ Sending ${result.notifications.length} individual notification(s)`);
            for (const p of result.notifications) {
                if (notifier.sendNotification) {
                    await notifier.sendNotification(p.title, p.body, p.file);
                } else if (notifier.sendMessage) {
                    await notifier.sendMessage(p.body, p.file, p.title);
                }
            }
        }
        logger.log("✅ REMINDER CHECK COMPLETED");
    }

    // ========================================================================
    // Companion Automation
    // ========================================================================

    private startCompanionStartup() {
        logger.log("🤝 START COMPANION STARTUP: Checking if enabled...");
        this.stopCompanionStartup();
        if (!this.settings.companionStartupScanEnabled) {
            logger.log("🤝 Companion startup scan DISABLED in settings");
            return;
        }

        const delay = Math.max(500, this.settings.companionStartupDelayMs);
        logger.log(`🤝 Scheduling companion startup scan after ${delay}ms delay...`);
        this.companionStartupTimerId = window.setTimeout(() => {
            logger.log("🤝 Companion startup timer triggered");
            void this.runCompanionScan();
            // After initial scan, start recurring interval
            this.startCompanionSyncInterval();
        }, delay);
        logger.log(`✅ Companion startup timer set (ID: ${this.companionStartupTimerId})`);
    }

    private stopCompanionStartup() {
        if (this.companionStartupTimerId !== null) {
            window.clearTimeout(this.companionStartupTimerId);
            this.companionStartupTimerId = null;
        }
    }

    private startCompanionSyncInterval() {
        logger.log("🤝 START COMPANION SYNC INTERVAL: Stopping existing interval (if any)...");
        this.stopCompanionSyncInterval();

        // Use same interval as calendar sync (5 minutes default)
        const minutes = Math.max(1, this.settings.syncIntervalMinutes || 5);
        const intervalMs = minutes * 60 * 1000;
        logger.log(`🤝 Setting up companion scan interval: ${minutes} minutes (${intervalMs}ms)`);
        this.companionSyncIntervalId = window.setInterval(() => {
            logger.log("⏲️ COMPANION TICK: Interval triggered");
            void this.runCompanionScan();
        }, intervalMs);

        logger.log(`✅ Companion scan interval set (ID: ${this.companionSyncIntervalId})`);
    }

    private stopCompanionSyncInterval() {
        if (this.companionSyncIntervalId !== null) {
            window.clearInterval(this.companionSyncIntervalId);
            this.companionSyncIntervalId = null;
        }
    }

    private async runCompanionScan(): Promise<void> {
        logger.log("🤝 COMPANION SCAN: Starting companion scan...");

        // Only run if we're actually the controller
        if (!this.deviceRoleManager.isController()) {
            logger.log("🤝 Skipping companion scan (not controller)");
            return;
        }

        const companion = this.getCompanionPlugin();
        if (!companion) {
            logger.log("🤝 Companion plugin not found, skipping vault scan.");
            return;
        }

        if (!companion.applyRulesToAllFiles) {
            logger.warn("⚠️ Companion plugin API missing applyRulesToAllFiles method");
            return;
        }

        try {
            logger.log("🤝 Running companion vault scan (silent mode)...");
            const changedCount = await companion.applyRulesToAllFiles(true); // silent=true
            logger.log(`✅ COMPANION SCAN COMPLETED: ${changedCount} files updated`);
        } catch (error) {
            logger.error("❌ Companion scan failed", error);
            // Don't throw - just log and continue
        }
    }



    // ========================================================================
    // Plugin API Lookups
    // ========================================================================

    private getCalendarPlugin(): CalendarPluginAPI | null {
        const plugin = (this.app as any).plugins?.getPlugin?.("tps-calendar-base");
        return plugin?.api || null;
    }

    private getNotifierPlugin(): NotifierPluginAPI | null {
        const plugin = (this.app as any).plugins?.getPlugin?.("tps-notifier");
        // Try API first, then fall back to plugin itself (for sendMessage)
        return plugin?.api || plugin || null;
    }

    private getCompanionPlugin(): CompanionPluginAPI | null {
        if (!this.isPluginEnabled("tps-notebook-navigator-companion")) {
            return null;
        }
        const plugin = (this.app as any).plugins?.getPlugin?.("tps-notebook-navigator-companion");
        return plugin?.api || plugin || null;
    }

    private getGcmPlugin(): GcmPluginAPI | null {
        if (!this.isPluginEnabled("tps-global-context-menu")) {
            return null;
        }
        const plugin = (this.app as any).plugins?.getPlugin?.("tps-global-context-menu");
        return (plugin?.api || plugin || null) as GcmPluginAPI | null;
    }

    private isPluginEnabled(pluginId: string): boolean {
        const manager = (this.app as any).plugins;
        const enabledPlugins = manager?.enabledPlugins;

        if (enabledPlugins instanceof Set) {
            return enabledPlugins.has(pluginId);
        }

        if (Array.isArray(enabledPlugins)) {
            return enabledPlugins.includes(pluginId);
        }

        const plugin = manager?.getPlugin?.(pluginId);
        return !!plugin;
    }

    private async runRecurrenceMaintenanceTick(): Promise<void> {
        if (!this.deviceRoleManager.isController()) return;

        const gcm = this.getGcmPlugin();
        const checkMissing = gcm?.bulkEditService?.checkMissingRecurrences;
        if (typeof checkMissing !== "function") {
            logger.log("🔁 Recurrence maintenance skipped (GCM not available)");
            return;
        }

        try {
            logger.log("🔁 Running recurrence maintenance tick...");
            await checkMissing.call(gcm.bulkEditService);
            logger.log("✅ Recurrence maintenance tick completed");
        } catch (error) {
            logger.error("❌ Recurrence maintenance tick failed", error);
        }
    }

    // ========================================================================
    // Settings Migration
    // ========================================================================

    /**
     * One-time migration: Read settings from Calendar and Notifier plugins
     * and copy automation-related fields into the Controller's settings.
     */
    private async migrateSettingsFromPlugins(): Promise<void> {
        logger.log("Running first-time settings migration...");
        let migrated = false;

        try {
            // Migrate from Notifier
            const notifierPlugin = (this.app as any).plugins?.getPlugin?.("tps-notifier");
            if (notifierPlugin?.settings) {
                const ns = notifierPlugin.settings;
                if (Array.isArray(ns.reminders)) {
                    this.settings.reminders = JSON.parse(JSON.stringify(ns.reminders));
                    migrated = true;
                }
                if (typeof ns.pollMinutes === 'number') this.settings.pollMinutes = ns.pollMinutes;
                if (ns.alertState) this.settings.alertState = JSON.parse(JSON.stringify(ns.alertState));
                if (typeof ns.batchNotifications === 'boolean') this.settings.batchNotifications = ns.batchNotifications;
                if (typeof ns.snoozeProperty === 'string') this.settings.snoozeProperty = ns.snoozeProperty;
                if (Array.isArray(ns.ignorePaths)) this.settings.globalIgnorePaths = [...ns.ignorePaths];
                if (Array.isArray(ns.ignoreTags)) this.settings.globalIgnoreTags = [...ns.ignoreTags];
                if (Array.isArray(ns.ignoreStatuses)) this.settings.globalIgnoreStatuses = [...ns.ignoreStatuses];
                if (typeof ns.enableLogging === 'boolean') this.settings.enableLogging = ns.enableLogging;
                logger.log("Migrated settings from Notifier.");
            }

            // Migrate from Calendar
            const calendarPlugin = (this.app as any).plugins?.getPlugin?.("tps-calendar-base");
            if (calendarPlugin?.settings) {
                const cs = calendarPlugin.settings;
                if (typeof cs.syncIntervalMinutes === 'number') this.settings.syncIntervalMinutes = cs.syncIntervalMinutes;
                if (cs.syncOnEventDelete) this.settings.syncOnEventDelete = cs.syncOnEventDelete;
                if (typeof cs.archiveFolder === 'string') this.settings.archiveFolder = cs.archiveFolder;
                if (typeof cs.externalCalendarFilter === 'string') this.settings.externalCalendarFilter = cs.externalCalendarFilter;
                if (typeof cs.startProperty === 'string') this.settings.startProperty = cs.startProperty;
                if (typeof cs.endProperty === 'string') this.settings.endProperty = cs.endProperty;
                if (typeof cs.eventIdKey === 'string') this.settings.eventIdKey = cs.eventIdKey;
                if (typeof cs.uidKey === 'string') this.settings.uidKey = cs.uidKey;
                if (typeof cs.titleKey === 'string') this.settings.titleKey = cs.titleKey;
                if (typeof cs.statusKey === 'string') this.settings.statusKey = cs.statusKey;
                if (typeof cs.previousStatusKey === 'string') this.settings.previousStatusKey = cs.previousStatusKey;
                if (typeof cs.canceledStatusValue === 'string') this.settings.canceledStatusValue = cs.canceledStatusValue;
                if (Array.isArray(cs.externalCalendars) && cs.externalCalendars.length > 0) {
                    // Only migrate if we don't have any locally yet
                    if (!this.settings.externalCalendars || this.settings.externalCalendars.length === 0) {
                        this.settings.externalCalendars = JSON.parse(JSON.stringify(cs.externalCalendars));
                    }
                }
                migrated = true;
                logger.log("Migrated settings from Calendar.");
            }
        } catch (e) {
            logger.error("Error during settings migration:", e);
        }

        this.settings._migratedFromPlugins = true;
        await this.saveSettings();

        if (migrated) {
            logger.log("Settings migration complete.");
        } else {
            logger.log("No source plugins found for migration. Using defaults.");
        }
    }
}
