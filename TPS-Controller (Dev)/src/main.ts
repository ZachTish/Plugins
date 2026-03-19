import { Plugin, Notice, Platform, TFile, WorkspaceLeaf, moment, normalizePath } from "obsidian";
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
import type { AlertState, OverdueItem } from "./types";
import { OverdueService } from "./services/overdue-service";
import { CalendarAutomationService } from "./services/calendar-automation";
import { CompanionAutomationService } from "./services/companion-automation";
import { migrateSettingsFromPlugins } from "./services/migration-service";
import { ExternalCalendarDuplicateCleanupService } from "./services/external-calendar-duplicate-cleanup-service";

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
    settings?: Record<string, any>;
    bulkEditService?: {
        checkMissingRecurrences?: () => Promise<void>;
        reconcileParentChildLinksForParent?: (parentFile: TFile) => Promise<number>;
        ensureParentSelfLinkForParent?: (parentFile: TFile) => Promise<boolean>;
    };
}

// ============================================================================
// Controller Plugin
// ============================================================================

export default class TPSControllerPlugin extends Plugin {
    settings: TPSControllerSettings;
    deviceRoleManager: DeviceRoleManager;
    private statusBarEl: HTMLElement;
    private readonly reminderStateSaveCooldownMs = 5 * 60 * 1000;
    private reminderStateNextSaveAt = 0;
    private reminderStateFlushTimer: number | null = null;
    private reminderStateSaveDirty = false;

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
    private externalCalendarDuplicateCleanup: ExternalCalendarDuplicateCleanupService;

    // Reminder interval
    private reminderIntervalId: number | null = null;
    private syncRequestIntervalId: number | null = null;
    private parentChildMaintenanceIntervalId: number | null = null;
    private parentChildBootstrapIntervalId: number | null = null;
    private parentChildStartupResolvedHandled = false;
    private parentChildMaintenanceActivated = false;

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
        this.externalCalendarDuplicateCleanup = new ExternalCalendarDuplicateCleanupService(this.app, () => this.settings);

        // Commands
        this.addCommand({ id: "set-device-role-controller", name: "Set as Controller (Automation Source)", callback: () => { this.deviceRoleManager.setRole("controller"); new Notice("Device set to CONTROLLER."); } });
        this.addCommand({ id: "set-device-role-user", name: "Set as Replica (Passive)", callback: () => { this.deviceRoleManager.setRole("user"); new Notice("Device set to REPLICA."); } });
        this.addCommand({ id: "force-calendar-sync", name: "Force Calendar Sync Now", callback: () => { if (this.deviceRoleManager.isController()) void this.calendarAutomation.runSync(true); else void this.requestSync(["calendar"]); } });
        this.addCommand({
            id: "cleanup-duplicate-external-calendar-notes",
            name: "Clean Duplicate External Calendar Notes",
            callback: async () => {
                const result = await this.externalCalendarDuplicateCleanup.run();
                new Notice(`Calendar duplicate cleanup: archived ${result.archivedCount}, skipped ${result.skippedWithContent} with body content, found ${result.groupsFound} duplicate groups.`);
            },
        });
        this.addCommand({ id: "review-calendar-sync-quarantine", name: "Review Calendar Sync Quarantine", callback: () => { void this.calendarAutomation.reviewQuarantine(); } });
        this.addCommand({ id: "force-reminder-check", name: "Run Reminder Check Now", callback: () => { if (this.deviceRoleManager.isController()) void this.runReminderCheck(); else void this.requestSync(["reminders"]); } });
        this.addCommand({ id: "open-notifications", name: "View Notifications", callback: () => { void this.overdueService.openNotificationModal(); } });
        this.addCommand({ id: "open-overdue-items", name: "View Overdue Items (Modal)", callback: () => { new OverdueItemsModal(this.app, this).open(); } });
        this.addCommand({ id: "force-companion-scan", name: "Run Companion Vault Scan Now", callback: () => { if (this.deviceRoleManager.isController()) void this.companionAutomation.runScan(); else void this.requestSync(["companion"]); } });
        this.addCommand({
            id: "force-parent-child-reconcile",
            name: "Run Parent/Child Link Reconcile Now",
            callback: () => {
                if (this.deviceRoleManager.isController()) {
                    void this.runParentChildMaintenanceTick();
                } else {
                    new Notice("Parent/child reconcile runs on the Controller device.");
                }
            },
        });

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
            if (!Platform.isMobile) {
                void this.requestSync(["calendar", "companion"]);
            } else {
                logger.log("Skipping automatic startup sync request on mobile replica.");
            }
        }

        // Ensure parent/child reconciliation runs once after initial metadata indexing on vault load.
        this.registerEvent(
            this.app.metadataCache.on("resolved", () => {
                if (!this.deviceRoleManager.isController()) return;
                if (this.parentChildStartupResolvedHandled) return;
                this.parentChildStartupResolvedHandled = true;
                void this.runParentChildMaintenanceTick();
            })
        );

        logger.log(" TPS-Controller loaded");
    }

    async onunload() {
        this.stopAllAutomation();
        await this.flushReminderStateNow();
        this.stopReminderStateFlushTimer();
        delete (this as any).api;
        delete (window as any).TPS;
    }

    // ========================================================================
    // Settings
    // ========================================================================

    async loadSettings() {
        const data = await this.loadData();
        this.settings = {
            ...DEFAULT_CONTROLLER_SETTINGS,
            ...(data || {}),
            kanbanTaskReminders: {
                ...DEFAULT_CONTROLLER_SETTINGS.kanbanTaskReminders,
                ...((data || {}).kanbanTaskReminders || {}),
            },
        };
        if (!this.settings._migratedFromPlugins) {
            await migrateSettingsFromPlugins(this.app, this.settings, () => this.saveSettings());
        }
        const localAlertState = this.loadAlertStateFromLocalStorage();
        if (this.hasAlertStateEntries(localAlertState)) {
            this.settings.alertState = localAlertState;
        } else if (this.hasAlertStateEntries(this.settings.alertState)) {
            this.persistAlertStateToLocalStorage(this.settings.alertState);
        } else {
            this.settings.alertState = {};
        }
        this.sanitizeFrontmatterKeySettings();
        logger.setLoggingEnabled(this.settings.enableLogging);
    }

    async saveSettings() {
        this.persistAlertStateToLocalStorage(this.settings.alertState);
        await this.saveData({
            ...this.settings,
            alertState: {},
        });
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

        // Kanban reminder sub-settings
        s.kanbanTaskReminders.statusProperty = normalizeKey(
            s.kanbanTaskReminders.statusProperty,
            d.kanbanTaskReminders.statusProperty,
        );
        const normalizeList = (value: unknown, fallback: string[]): string[] => {
            const arr = Array.isArray(value) ? value : fallback;
            const cleaned = arr
                .map((v) => String(v ?? "").trim().toLowerCase())
                .filter(Boolean);
            return cleaned.length ? Array.from(new Set(cleaned)) : [...fallback];
        };
        s.kanbanTaskReminders.scheduledPropertyAliases = normalizeList(
            s.kanbanTaskReminders.scheduledPropertyAliases,
            d.kanbanTaskReminders.scheduledPropertyAliases,
        );
        s.kanbanTaskReminders.duePropertyAliases = normalizeList(
            s.kanbanTaskReminders.duePropertyAliases,
            d.kanbanTaskReminders.duePropertyAliases,
        );
        s.kanbanTaskReminders.startPropertyAliases = normalizeList(
            s.kanbanTaskReminders.startPropertyAliases,
            d.kanbanTaskReminders.startPropertyAliases,
        );
        s.kanbanTaskReminders.completeStatusValue = this.normalizeStatusValue(
            s.kanbanTaskReminders.completeStatusValue,
            d.kanbanTaskReminders.completeStatusValue,
        );
        s.kanbanTaskReminders.wontDoStatusValue = this.normalizeStatusValue(
            s.kanbanTaskReminders.wontDoStatusValue,
            d.kanbanTaskReminders.wontDoStatusValue,
        );
    }

    private normalizeStatusValue(value: unknown, fallback: string): string {
        const raw = String(value ?? "").trim().toLowerCase();
        return raw || fallback;
    }

    // ========================================================================
    // Role Management
    // ========================================================================

    private onRoleChanged(role: DeviceRole) {
        this.updateStatusBar(role);
        this.parentChildStartupResolvedHandled = false;
        this.parentChildMaintenanceActivated = false;
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
        this.startSyncRequestLoop();
        this.calendarAutomation.start();
        this.startReminderLoop();
        this.startParentChildMaintenanceLoop();
        this.companionAutomation.start();
        this.syncConflictWatcher.updateConfig(this.settings.archiveFolder, this.settings.eventIdKey);
        this.syncConflictWatcher.start();
        logger.log(" ALL AUTOMATION STARTED");
    }

    private stopAllAutomation() {
        this.calendarAutomation.stop();
        this.stopSyncRequestLoop();
        this.stopReminderLoop();
        this.stopParentChildMaintenanceLoop();
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

    private startSyncRequestLoop() {
        this.stopSyncRequestLoop();
        // Keep request fulfillment responsive for user-device manual sync commands.
        this.syncRequestIntervalId = window.setInterval(() => {
            void this.checkAndFulfillSyncRequests();
        }, 4000);
    }

    private stopSyncRequestLoop() {
        if (this.syncRequestIntervalId !== null) {
            window.clearInterval(this.syncRequestIntervalId);
            this.syncRequestIntervalId = null;
        }
    }

    // ========================================================================
    // Reminder Loop
    // ========================================================================

    private startReminderLoop() {
        this.stopReminderLoop();
        if (!this.settings.enableReminders) return;
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

    private startParentChildMaintenanceLoop() {
        this.stopParentChildMaintenanceLoop();
        void this.runParentChildMaintenanceTick();
        this.parentChildBootstrapIntervalId = window.setInterval(() => {
            if (this.parentChildMaintenanceActivated) {
                this.stopParentChildBootstrapLoop();
                return;
            }
            void this.runParentChildMaintenanceTick();
        }, 15000);
        const minutes = Math.max(1, this.settings.syncIntervalMinutes || 5);
        const intervalMs = minutes * 60 * 1000;
        this.parentChildMaintenanceIntervalId = window.setInterval(() => {
            void this.runParentChildMaintenanceTick();
        }, intervalMs);
    }

    private stopParentChildMaintenanceLoop() {
        this.stopParentChildBootstrapLoop();
        if (this.parentChildMaintenanceIntervalId !== null) {
            window.clearInterval(this.parentChildMaintenanceIntervalId);
            this.parentChildMaintenanceIntervalId = null;
        }
    }

    private stopParentChildBootstrapLoop() {
        if (this.parentChildBootstrapIntervalId !== null) {
            window.clearInterval(this.parentChildBootstrapIntervalId);
            this.parentChildBootstrapIntervalId = null;
        }
    }

    private async runReminderCheck(): Promise<void> {
        if (!this.settings.enableReminders) return;
        const result = await this.reminderEngine.evaluateReminders(this.settings);
        if (result.stateChanged) this.scheduleReminderStateSave();
        if (!result.notifications.length) return;

        const notifier = this.getMessagerPlugin();
        if (!notifier) { logger.warn(" Messager plugin not found."); return; }
        if (!notifier.sendNotification && !notifier.sendMessage) {
            logger.warn(" Notifier plugin has no send API.");
            return;
        }

        const allDayNotifications = result.notifications.filter((n) => n.isAllDay);
        const nonAllDayNotifications = result.notifications.filter((n) => !n.isAllDay);

        if (this.settings.batchNotifications && nonAllDayNotifications.length > 1) {
            const count = nonAllDayNotifications.length;
            const items = nonAllDayNotifications.slice(0, 8);
            let body = items.map((p: PendingNotification) => ` ${p.title}`).join('\n');
            if (count > 8) body += `\n...and ${count - 8} more`;
            if (notifier.sendNotification) await notifier.sendNotification(`${count} Overdue Items`, body, undefined);
            else if (notifier.sendMessage) await notifier.sendMessage(body, undefined, `${count} Overdue Items`);
        } else {
            for (const p of nonAllDayNotifications) {
                if (notifier.sendNotification) await notifier.sendNotification(p.title, p.body, p.file);
                else if (notifier.sendMessage) await notifier.sendMessage(p.body, p.file, p.title);
            }
        }

        // All-day reminders are always sent individually to avoid hiding them in grouped batch payloads.
        for (const p of allDayNotifications) {
            if (notifier.sendNotification) await notifier.sendNotification(p.title, p.body, p.file);
            else if (notifier.sendMessage) await notifier.sendMessage(p.body, p.file, p.title);
        }
    }

    private scheduleReminderStateSave(): void {
        this.reminderStateSaveDirty = true;
        const now = Date.now();
        if (now >= this.reminderStateNextSaveAt) {
            void this.flushReminderStateNow();
            return;
        }

        if (this.reminderStateFlushTimer !== null) {
            return;
        }

        const delay = Math.max(50, this.reminderStateNextSaveAt - now);
        this.reminderStateFlushTimer = window.setTimeout(() => {
            this.reminderStateFlushTimer = null;
            void this.flushReminderStateNow();
        }, delay);
    }

    private async flushReminderStateNow(): Promise<void> {
        if (!this.reminderStateSaveDirty) return;
        this.reminderStateSaveDirty = false;
        this.reminderStateNextSaveAt = Date.now() + this.reminderStateSaveCooldownMs;
        this.persistAlertStateToLocalStorage(this.settings.alertState);
    }

    private stopReminderStateFlushTimer(): void {
        if (this.reminderStateFlushTimer !== null) {
            window.clearTimeout(this.reminderStateFlushTimer);
            this.reminderStateFlushTimer = null;
        }
    }

    private getAlertStateStorageKey(): string {
        return `tps-controller-alert-state-${this.app.vault.getName()}`;
    }

    private hasAlertStateEntries(state: AlertState | null | undefined): boolean {
        return !!state && Object.keys(state).length > 0;
    }

    private loadAlertStateFromLocalStorage(): AlertState {
        try {
            const raw = window.localStorage.getItem(this.getAlertStateStorageKey());
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
            return parsed as AlertState;
        } catch (error) {
            logger.warn("Failed to read local reminder alert state; resetting state.", error);
            return {};
        }
    }

    private persistAlertStateToLocalStorage(state: AlertState): void {
        try {
            window.localStorage.setItem(this.getAlertStateStorageKey(), JSON.stringify(state || {}));
        } catch (error) {
            logger.warn("Failed to persist local reminder alert state.", error);
        }
    }

    // ========================================================================
    // Overdue Items (delegates to OverdueService)
    // ========================================================================

    async openNotificationModal(): Promise<void> { return this.overdueService.openNotificationModal(); }
    async getOverdueItems(): Promise<OverdueItem[]> { return this.overdueService.getOverdueItems(); }
    async snoozeFile(file: TFile, minutes: number): Promise<void> { return this.overdueService.snoozeFile(file, minutes); }
    async snoozeOverdueItem(item: OverdueItem, minutes: number): Promise<void> { return this.overdueService.snoozeItem(item, minutes); }
    openFile(file: TFile): void { this.overdueService.openFile(file); }
    async markFileComplete(file: TFile): Promise<void> { return this.overdueService.markFileComplete(file); }
    async markFileWontDo(file: TFile): Promise<void> { return this.overdueService.markFileWontDo(file); }
    async markOverdueItemComplete(item: OverdueItem): Promise<void> { return this.overdueService.markItemComplete(item); }
    async markOverdueItemWontDo(item: OverdueItem): Promise<void> { return this.overdueService.markItemWontDo(item); }

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
        const plugin = (getPluginById(this.app, "tps-global-context-menu")
                    || getPluginById(this.app, "TPS-Global-Context-Menu (Dev)")) as any;
        if (!plugin) return null;
        const api = plugin.api || {};
        return {
            settings: plugin.settings ?? api.settings,
            bulkEditService: plugin.bulkEditService ?? api.bulkEditService,
        } as GcmPluginAPI;
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

    private async runParentChildMaintenanceTick(): Promise<void> {
        if (!this.deviceRoleManager.isController()) return;

        const gcm = this.getGcmPlugin();
        const reconcile = gcm?.bulkEditService?.reconcileParentChildLinksForParent;
        const ensureSelfLink = gcm?.bulkEditService?.ensureParentSelfLinkForParent;
        if (typeof reconcile !== "function" && typeof ensureSelfLink !== "function") return;
        this.parentChildMaintenanceActivated = true;

        const parentKey = String(gcm?.settings?.parentLinkFrontmatterKey || "childOf").trim() || "childOf";
        const childKey = String(gcm?.settings?.childLinkFrontmatterKey || "parentOf").trim() || "parentOf";

        const parentCandidates = new Map<string, TFile>();
        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            const frontmatter = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
            if (!frontmatter || typeof frontmatter !== "object") continue;

            if (this.hasFrontmatterKeyCaseInsensitive(frontmatter, childKey)) {
                parentCandidates.set(file.path, file);
            }

            const parentRaw = this.getFrontmatterValueCaseInsensitive(frontmatter, parentKey);
            for (const target of this.extractLinkTargetsFromAny(parentRaw)) {
                const parentFile = this.resolveLinkTargetToFile(target, file.path);
                if (parentFile) {
                    parentCandidates.set(parentFile.path, parentFile);
                }
            }
        }

        if (!parentCandidates.size) return;

        let totalUpdates = 0;
        for (const parentFile of parentCandidates.values()) {
            try {
                if (typeof reconcile === "function") {
                    const updated = await reconcile.call(gcm?.bulkEditService, parentFile);
                    if (typeof updated === "number") {
                        totalUpdates += updated;
                    }
                }
                if (typeof ensureSelfLink === "function") {
                    const selfUpdated = await ensureSelfLink.call(gcm?.bulkEditService, parentFile);
                    if (selfUpdated) {
                        totalUpdates += 1;
                    }
                }
            } catch (error) {
                logger.warn(` Parent/child maintenance failed for ${parentFile.path}`, error);
            }
        }

        if (totalUpdates > 0) {
            logger.log(` Parent/child maintenance applied ${totalUpdates} update(s) across ${parentCandidates.size} parent notes.`);
        }
    }

    private hasFrontmatterKeyCaseInsensitive(frontmatter: Record<string, any>, key: string): boolean {
        const normalized = String(key || "").trim().toLowerCase();
        if (!normalized) return false;
        return Object.keys(frontmatter || {}).some((candidate) => candidate.toLowerCase() === normalized);
    }

    private getFrontmatterValueCaseInsensitive(frontmatter: Record<string, any>, key: string): any {
        const normalized = String(key || "").trim().toLowerCase();
        if (!normalized) return undefined;
        const match = Object.keys(frontmatter || {}).find((candidate) => candidate.toLowerCase() === normalized);
        return match ? frontmatter[match] : undefined;
    }

    private extractLinkTargetsFromAny(value: any): string[] {
        const output = new Set<string>();
        const visited = new Set<any>();

        const consume = (candidate: any): void => {
            if (candidate == null) return;
            if (Array.isArray(candidate)) {
                if (visited.has(candidate)) return;
                visited.add(candidate);
                candidate.forEach((entry) => consume(entry));
                return;
            }
            if (typeof candidate === "object") {
                if (visited.has(candidate)) return;
                visited.add(candidate);
                Object.values(candidate).forEach((entry) => consume(entry));
                return;
            }
            if (typeof candidate !== "string" && typeof candidate !== "number" && typeof candidate !== "boolean") {
                return;
            }

            const text = String(candidate).trim();
            if (!text) return;
            for (const target of this.extractLinkTargetsFromText(text)) {
                output.add(target);
            }
        };

        consume(value);
        return Array.from(output.values());
    }

    private extractLinkTargetsFromText(rawText: string): string[] {
        const text = String(rawText || "").trim();
        if (!text) return [];
        const targets = new Set<string>();

        const add = (rawTarget: string) => {
            const normalized = this.normalizeLinkTarget(rawTarget);
            if (normalized) targets.add(normalized);
        };

        const wikiPattern = /!?\[\[([^[\]]+)\]\]/g;
        let wikiMatch: RegExpExecArray | null = null;
        while ((wikiMatch = wikiPattern.exec(text)) !== null) {
            add(wikiMatch[1]);
        }

        const markdownPattern = /!?\[[^\]]*]\(([^)]+)\)/g;
        let markdownMatch: RegExpExecArray | null = null;
        while ((markdownMatch = markdownPattern.exec(text)) !== null) {
            add(markdownMatch[1]);
        }

        if (targets.size === 0) {
            add(text);
        }

        return Array.from(targets.values());
    }

    private normalizeLinkTarget(rawTarget: string): string {
        let target = String(rawTarget || "").trim();
        if (!target) return "";

        if (target.startsWith("<") && target.endsWith(">")) {
            target = target.slice(1, -1).trim();
        }

        target = target.replace(/^['"]|['"]$/g, "").trim();

        const pipeIndex = target.indexOf("|");
        if (pipeIndex >= 0) {
            target = target.slice(0, pipeIndex).trim();
        }

        const hashIndex = target.indexOf("#");
        if (hashIndex >= 0) {
            target = target.slice(0, hashIndex).trim();
        }

        if (!target) return "";

        try {
            target = decodeURIComponent(target);
        } catch {
            // Keep raw value when malformed URI segments are present.
        }

        return target.replace(/^\/+/, "").trim();
    }

    private resolveLinkTargetToFile(rawTarget: string, sourcePath: string): TFile | null {
        const target = this.normalizeLinkTarget(rawTarget);
        if (!target) return null;

        const viaCache =
            this.app.metadataCache.getFirstLinkpathDest(target, sourcePath)
            || this.app.metadataCache.getFirstLinkpathDest(target.replace(/\.md$/i, ""), sourcePath);
        if (viaCache instanceof TFile) return viaCache;

        const normalized = normalizePath(target);
        const direct = this.app.vault.getAbstractFileByPath(normalized);
        if (direct instanceof TFile) return direct;

        if (!normalized.endsWith(".md")) {
            const withMd = this.app.vault.getAbstractFileByPath(`${normalized}.md`);
            if (withMd instanceof TFile) return withMd;
        }

        return null;
    }
}
