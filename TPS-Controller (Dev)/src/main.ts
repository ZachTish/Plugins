import { Plugin, Notice, TFile, WorkspaceLeaf, moment } from "obsidian";
import { DeviceRoleManager, DeviceRole } from "./device-role-manager";
import { TPSControllerSettings, DEFAULT_CONTROLLER_SETTINGS } from "./types";
import { AutoCreateService } from "./services/auto-create-service";
import { ExternalCalendarService } from "./services/external-calendar-service";
import { ReminderEngine, PendingNotification } from "./services/reminder-engine";
import { SyncRequestService } from "./services/sync-request-service";
import { SyncConflictWatcher } from "./services/sync-conflict-watcher";
import { TPSControllerSettingTab } from "./settings-tab";
import * as logger from "./logger";
import { getPluginById, isPluginEnabled } from "./core";
import { NotificationView, NOTIFICATION_VIEW_TYPE } from "./views/notification-view";
import { OverdueItemsModal } from "./modals/overdue-modal";
import type { OverdueItem } from "./types";
import { OverdueService } from "./services/overdue-service";
import { CalendarAutomationService } from "./services/calendar-automation";
import { CompanionAutomationService } from "./services/companion-automation";
import { migrateSettingsFromPlugins } from "./services/migration-service";

// ============================================================================
// Plugin API Types
// ============================================================================

interface CalendarPluginAPI {
    getSettings?(): any;
}

interface MessagerPluginAPI {
    sendNotification?(title: string, body: string, file?: TFile): Promise<void>;
    sendMessage?(text: string, file?: TFile, title?: string): Promise<void>;
}

interface CompanionPluginAPI {
    applyRulesToAllFiles?(silent?: boolean): Promise<void>;
    applyRulesToFile?(file: TFile): Promise<void>;
}

interface GcmPluginAPI {
    bulkEditService?: { checkMissingRecurrences?: () => Promise<void> };
}

// ============================================================================
// Controller Plugin
// ============================================================================

export default class TPSControllerPlugin extends Plugin {
    settings: TPSControllerSettings;
    deviceRoleManager: DeviceRoleManager;
    private statusBarEl: HTMLElement;

    // Core services
    private autoCreateService: AutoCreateService;
    private externalCalendarService: ExternalCalendarService;
    private reminderEngine: ReminderEngine;
    private syncRequestService: SyncRequestService;
    private syncConflictWatcher: SyncConflictWatcher;

    // Feature services
    private overdueService: OverdueService;
    private calendarAutomation: CalendarAutomationService;
    private companionAutomation: CompanionAutomationService;

    // Reminder interval
    private reminderIntervalId: number | null = null;

    async onload() {
        logger.log(" TPS-Controller loading...");
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

        this.statusBarEl = this.addStatusBarItem();
        this.deviceRoleManager = new DeviceRoleManager(this.app, (role) => this.onRoleChanged(role));
        this.updateStatusBar(this.deviceRoleManager.role);

        // Core services
        this.autoCreateService = new AutoCreateService(this.app);
        this.externalCalendarService = new ExternalCalendarService();
        this.reminderEngine = new ReminderEngine(this.app);
        this.syncRequestService = new SyncRequestService(this.app, this.manifest.dir);
        this.syncConflictWatcher = new SyncConflictWatcher(this.app);

        // Feature services
        this.overdueService = new OverdueService(this.app, () => this.settings);
        this.calendarAutomation = new CalendarAutomationService(
            this.app,
            this.autoCreateService,
            this.externalCalendarService,
            () => this.settings,
            () => this.getCalendarPlugin(),
            () => this.runRecurrenceMaintenanceTick()
        );
        this.companionAutomation = new CompanionAutomationService(
            () => this.settings,
            () => this.getCompanionPlugin(),
            () => this.deviceRoleManager.isController()
        );

        // Commands
        this.addCommand({ id: "set-device-role-controller", name: "Set as Controller (Automation Source)", callback: () => { this.deviceRoleManager.setRole("controller"); new Notice("Device set to CONTROLLER."); } });
        this.addCommand({ id: "set-device-role-user", name: "Set as Replica (Passive)", callback: () => { this.deviceRoleManager.setRole("user"); new Notice("Device set to REPLICA."); } });
        this.addCommand({ id: "force-calendar-sync", name: "Force Calendar Sync Now", callback: () => { if (this.deviceRoleManager.isController()) void this.calendarAutomation.runSync(true); else void this.requestSync(["calendar"]); } });
        this.addCommand({ id: "review-calendar-sync-quarantine", name: "Review Calendar Sync Quarantine", callback: () => { void this.calendarAutomation.reviewQuarantine(); } });
        this.addCommand({ id: "force-reminder-check", name: "Run Reminder Check Now", callback: () => { if (this.deviceRoleManager.isController()) void this.runReminderCheck(); else void this.requestSync(["reminders"]); } });
        this.addCommand({ id: "open-notifications", name: "View Notifications", callback: () => { void this.overdueService.openNotificationModal(); } });
        this.addCommand({ id: "open-overdue-items", name: "View Overdue Items (Modal)", callback: () => { new OverdueItemsModal(this.app, this).open(); } });
        this.addCommand({ id: "force-companion-scan", name: "Run Companion Vault Scan Now", callback: () => { if (this.deviceRoleManager.isController()) void this.companionAutomation.runScan(); else void this.requestSync(["companion"]); } });

        // View + Ribbon
        this.registerView(NOTIFICATION_VIEW_TYPE, (leaf) => new NotificationView(leaf, this));
        this.addRibbonIcon('bell', 'View Notifications', () => { void this.overdueService.openNotificationModal(); });

        // API
        (this as any).api = {
            isController: (): boolean => this.deviceRoleManager.isController(),
            getRole: (): DeviceRole => this.deviceRoleManager.role,
            getSettings: (): TPSControllerSettings => this.settings,
            getReminders: () => this.settings.reminders || [],
            getOverdueItems: () => this.getOverdueItems(),
            snoozeFile: (file: TFile, minutes: number) => this.snoozeFile(file, minutes),
        };
        (window as any).TPS = { controller: (this as any).api };

        this.addSettingTab(new TPSControllerSettingTab(this.app, this));

        if (this.deviceRoleManager.isController()) {
            this.enterControllerMode();
        } else {
            void this.requestSync(["calendar", "companion"]);
        }

        logger.log(" TPS-Controller loaded");
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
        if (!this.settings._migratedFromPlugins) {
            await migrateSettingsFromPlugins(this.app, this.settings, () => this.saveSettings());
        }
        this.sanitizeFrontmatterKeySettings();
        logger.setLoggingEnabled(this.settings.enableLogging);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        logger.setLoggingEnabled(this.settings.enableLogging);
    }

    private sanitizeFrontmatterKeySettings(): void {
        const normalizeKey = (value: unknown, fallback: string): string => {
            const raw = String(value ?? "").trim();
            if (!raw) return fallback;
            return /^[A-Za-z0-9_-]+$/.test(raw) ? raw : fallback;
        };
        const s = this.settings;
        const d = DEFAULT_CONTROLLER_SETTINGS;
        s.eventIdKey = normalizeKey(s.eventIdKey, d.eventIdKey);
        s.uidKey = normalizeKey(s.uidKey, d.uidKey);
        s.titleKey = normalizeKey(s.titleKey, d.titleKey);
        s.statusKey = normalizeKey(s.statusKey, d.statusKey);
        s.previousStatusKey = normalizeKey(s.previousStatusKey, d.previousStatusKey);
        s.startProperty = normalizeKey(s.startProperty, d.startProperty);
        s.endProperty = normalizeKey(s.endProperty, d.endProperty);

        const identity = new Set([s.eventIdKey.toLowerCase(), s.uidKey.toLowerCase()]);
        const ensureNotIdentity = (v: string, fb: string) => identity.has(v.toLowerCase()) ? fb : v;
        s.titleKey = ensureNotIdentity(s.titleKey, d.titleKey);
        s.statusKey = ensureNotIdentity(s.statusKey, d.statusKey);
        s.previousStatusKey = ensureNotIdentity(s.previousStatusKey, d.previousStatusKey);
        s.startProperty = ensureNotIdentity(s.startProperty, d.startProperty);
        s.endProperty = ensureNotIdentity(s.endProperty, d.endProperty);
    }

    // ========================================================================
    // Role Management
    // ========================================================================

    private onRoleChanged(role: DeviceRole) {
        this.updateStatusBar(role);
        if (role === "controller") void this.enterControllerMode();
        else void this.exitControllerMode();
    }

    private enterControllerMode() {
        new Notice("Controller mode activated. Running background automation.", 3000);
        this.startAllAutomation();
    }

    private exitControllerMode() {
        this.stopAllAutomation();
        new Notice("User mode activated.", 3000);
    }

    private updateStatusBar(role: DeviceRole) {
        if (role === "controller") {
            this.statusBarEl.setText("TPS: Controller");
            this.statusBarEl.addClass("mod-tps-controller");
        } else {
            this.statusBarEl.setText("TPS: User");
            this.statusBarEl.removeClass("mod-tps-controller");
        }
    }

    // ========================================================================
    // Automation Control
    // ========================================================================

    private startAllAutomation() {
        void this.checkAndFulfillSyncRequests();
        this.calendarAutomation.start();
        this.startReminderLoop();
        this.companionAutomation.start();
        this.syncConflictWatcher.updateConfig(this.settings.archiveFolder, this.settings.eventIdKey);
        this.syncConflictWatcher.start();
        logger.log(" ALL AUTOMATION STARTED");
    }

    private stopAllAutomation() {
        this.calendarAutomation.stop();
        this.stopReminderLoop();
        this.companionAutomation.stop();
        this.syncConflictWatcher.stop();
    }

    // ========================================================================
    // Sync Requests
    // ========================================================================

    private async requestSync(scope: ("calendar" | "companion" | "reminders")[]) {
        await this.syncRequestService.writeRequest(scope);
        new Notice(`Sync requested (${scope.join(", ")}). Will be processed by Controller.`);
    }

    private async checkAndFulfillSyncRequests(): Promise<void> {
        const request = await this.syncRequestService.readRequest();
        if (!request) return;
        logger.log(`Fulfilling sync request: ${request.scope.join(", ")}`);
        if (request.scope.includes("calendar")) await this.calendarAutomation.runSync();
        if (request.scope.includes("companion")) await this.companionAutomation.runScan();
        if (request.scope.includes("reminders")) await this.runReminderCheck();
        await this.syncRequestService.clearRequest();
    }

    // ========================================================================
    // Reminder Loop
    // ========================================================================

    private startReminderLoop() {
        this.stopReminderLoop();
        void this.runReminderCheck();
        const ms = Math.max(30000, this.settings.pollMinutes * 60 * 1000);
        this.reminderIntervalId = window.setInterval(() => { void this.runReminderCheck(); }, ms);
    }

    private stopReminderLoop() {
        if (this.reminderIntervalId !== null) {
            window.clearInterval(this.reminderIntervalId);
            this.reminderIntervalId = null;
        }
    }

    private async runReminderCheck(): Promise<void> {
        const result = await this.reminderEngine.evaluateReminders(this.settings);
        if (result.stateChanged) await this.saveSettings();
        if (!result.notifications.length) return;

        const notifier = this.getMessagerPlugin();
        if (!notifier) { logger.warn(" Messager plugin not found."); return; }
        const sendFn = notifier.sendNotification || notifier.sendMessage;
        if (!sendFn) { logger.warn(" Notifier plugin has no send API."); return; }

        if (this.settings.batchNotifications && result.notifications.length > 1) {
            const count = result.notifications.length;
            const items = result.notifications.slice(0, 8);
            let body = items.map((p: PendingNotification) => ` ${p.title}`).join('\n');
            if (count > 8) body += `\n...and ${count - 8} more`;
            if (notifier.sendNotification) await notifier.sendNotification(`${count} Overdue Items`, body, undefined);
            else if (notifier.sendMessage) await notifier.sendMessage(body, undefined, `${count} Overdue Items`);
        } else {
            for (const p of result.notifications) {
                if (notifier.sendNotification) await notifier.sendNotification(p.title, p.body, p.file);
                else if (notifier.sendMessage) await notifier.sendMessage(p.body, p.file, p.title);
            }
        }
    }

    // ========================================================================
    // Overdue Items (delegates to OverdueService)
    // ========================================================================

    async openNotificationModal(): Promise<void> { return this.overdueService.openNotificationModal(); }
    async getOverdueItems(): Promise<OverdueItem[]> { return this.overdueService.getOverdueItems(); }
    async snoozeFile(file: TFile, minutes: number): Promise<void> { return this.overdueService.snoozeFile(file, minutes); }
    openFile(file: TFile): void { this.overdueService.openFile(file); }
    async markFileComplete(file: TFile): Promise<void> { return this.overdueService.markFileComplete(file); }
    async markFileWontDo(file: TFile): Promise<void> { return this.overdueService.markFileWontDo(file); }

    // ========================================================================
    // Plugin API Lookups
    // ========================================================================

    private getCalendarPlugin(): CalendarPluginAPI | null {
        const plugin = getPluginById(this.app, "tps-calendar-base")
                    || getPluginById(this.app, "TPS-Calendar-Base (Dev)");
        return (plugin as any)?.api || null;
    }

    private getMessagerPlugin(): MessagerPluginAPI | null {
        const plugin = getPluginById(this.app, "tps-messager") 
                    || getPluginById(this.app, "tps-notifier")
                    || getPluginById(this.app, "TPS-Notifier (Dev)");
        return (plugin as any)?.api || plugin || null;
    }

    private getCompanionPlugin(): CompanionPluginAPI | null {
        const enabled = isPluginEnabled(this.app, "tps-notebook-navigator-companion")
                     || isPluginEnabled(this.app, "TPS-Notebook-Navigator-Companion (Dev)");
        if (!enabled) return null;
        const plugin = getPluginById(this.app, "tps-notebook-navigator-companion")
                    || getPluginById(this.app, "TPS-Notebook-Navigator-Companion (Dev)");
        return (plugin as any)?.api || plugin || null;
    }

    private getGcmPlugin(): GcmPluginAPI | null {
        const enabled = isPluginEnabled(this.app, "tps-global-context-menu")
                     || isPluginEnabled(this.app, "TPS-Global-Context-Menu (Dev)");
        if (!enabled) return null;
        const plugin = getPluginById(this.app, "tps-global-context-menu")
                    || getPluginById(this.app, "TPS-Global-Context-Menu (Dev)");
        return ((plugin as any)?.api || plugin || null) as GcmPluginAPI | null;
    }

    private async runRecurrenceMaintenanceTick(): Promise<void> {
        if (!this.deviceRoleManager.isController()) return;
        const gcm = this.getGcmPlugin();
        const checkMissing = gcm?.bulkEditService?.checkMissingRecurrences;
        if (typeof checkMissing !== "function") return;
        try {
            await checkMissing.call(gcm.bulkEditService);
        } catch (error) {
            logger.error(" Recurrence maintenance tick failed", error);
        }
    }
}