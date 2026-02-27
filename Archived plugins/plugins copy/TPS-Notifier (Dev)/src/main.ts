import { Notice, Plugin, TFile, moment, WorkspaceLeaf, Modal, App } from 'obsidian';
import * as logger from "./logger";
import { NotificationView, NOTIFICATION_VIEW_TYPE } from './notification-view';
import { OverdueItemsModal } from './overdue-modal';
import { TPSNotifierSettings, PropertyReminder, OverdueItem } from './types';
import { TPSNotifierSettingTab } from './settings-tab';
import {
    parseDate, parseTimeRange, parseDuration, getEffectiveEndTime,
    formatTemplate, formatRemaining, checkStopCondition,
    normalizeStatus, getStatuses, hasRequiredStatus, shouldIgnoreForReminder
} from './time-calculation-service';

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

// Types moved to types.ts

const DEFAULT_REMINDERS: PropertyReminder[] = [
    {
        id: 'scheduled-15m',
        property: 'scheduled',
        enabled: true,
        mode: 'timeblock',
        offsetMinutes: -15,
        repeatUntilComplete: false,
        repeatIntervalMinutes: 5,
        maxRepeats: -1,
        stopConditions: ['status: complete', 'status: wont-do'],
        title: 'Upcoming: {filename}',
        body: 'Starts at {time} ({remaining})',
        ignorePaths: ['System/'],
        ignoreTags: ['archive', 'template'],
        ignoreStatuses: ['complete', 'wont-do', 'working'], // Added working
    },
    {
        id: 'due-15m',
        property: 'due',
        enabled: true,
        mode: 'task',
        offsetMinutes: -15,
        repeatUntilComplete: true,
        repeatIntervalMinutes: 10,
        maxRepeats: -1,
        stopConditions: ['status: complete', 'status: wont-do'],
        title: 'Due Soon: {filename}',
        body: 'Due at {time} ({remaining})',
        ignorePaths: ['System/'],
        ignoreTags: ['archive', 'template'],
        ignoreStatuses: ['complete', 'wont-do'],
    },
    {
        id: 'working-check-5m', // New rule
        property: 'scheduled',
        enabled: true,
        mode: 'timeblock',
        triggerAtEnd: true,
        offsetMinutes: 5,
        repeatUntilComplete: true,
        repeatIntervalMinutes: 30, // Nag every 30m if still working?
        maxRepeats: -1,
        stopConditions: ['status: complete', 'status: wont-do'],
        requiredStatuses: ['working'],
        title: 'Still Working? {filename}',
        body: 'Event ended 5m ago. Status is still "working".',
        ignorePaths: ['System/'],
        ignoreTags: ['archive', 'template'],
        ignoreStatuses: ['complete', 'wont-do'],
    },
];

const DEFAULT_SETTINGS: TPSNotifierSettings = {
    ntfyServer: 'https://ntfy.sh',
    ntfyTopic: '',
    ntfyPriority: 3,
    deviceRole: 'receiver',
    pollMinutes: 0.5,
    reminders: DEFAULT_REMINDERS,
    alertState: {},
    ignorePaths: ['System/'],
    ignoreTags: ['archive', 'template'],
    ignoreStatuses: ['complete', 'wont-do'],
    enableLogging: false,
    snoozeProperty: 'reminderSnooze',
    snoozeOptions: [
        { label: '15 Minutes', minutes: 15 },
        { label: '1 Hour', minutes: 60 },
        { label: '4 Hours', minutes: 240 },
        { label: '1 Day', minutes: 1440 },
    ],
    batchNotifications: true,
};

const LOCAL_STORAGE_ROLE_KEY = 'tps-notifier-device-role';

// ============================================================================
// MAIN PLUGIN CLASS
// ============================================================================

export default class TPSNotifier extends Plugin {
    settings: TPSNotifierSettings;
    intervalHandle: any = null;

    async onload() {
        logger.log('[TPS Notifier] onload() started');
        try {
            await this.loadSettings();
            logger.log('[TPS Notifier] Settings loaded');

            // Register View
            this.registerView(NOTIFICATION_VIEW_TYPE, (leaf) => {
                logger.log('[TPS Notifier] Creating new NotificationView instance');
                return new NotificationView(leaf, this);
            });

            // Add Command to view notifications
            this.addCommand({
                id: 'open-notifications',
                name: 'View Notifications',
                callback: () => {
                    this.openNotificationModal();
                },
            });

            // Add Command to Manually Send a Notification
            this.addCommand({
                id: 'send-custom-notification',
                name: 'Send Custom Notification',
                callback: () => {
                    this.openSendNotificationModal();
                },
            });

            // Add Ribbon Icon
            this.addRibbonIcon('bell', 'View Notifications', () => {
                this.openNotificationModal();
            });

            // Add Settings Tab
            this.addSettingTab(new TPSNotifierSettingTab(this.app, this));

            // Register URL protocol handler for obsidian://tps-notifier
            this.registerObsidianProtocolHandler('tps-notifier', async (params) => {
                logger.log('[TPS Notifier] Protocol handler triggered', params);
                await this.openNotificationModal();
            });

            // Start Loop if controller
            if (this.settings.deviceRole === 'controller') {
                logger.log('[TPS Notifier] Device is controller, starting loop');
                this.startLoop();
            } else {
                logger.log('[TPS Notifier] Device is receiver, NOT starting loop');
            }
        } catch (error) {
            logger.error('[TPS Notifier] Failed to load plugin:', error);
            new Notice('TPS Notifier failed to load. Check console.');
        }
        logger.log('[TPS Notifier] onload() completed');
    }

    onunload() {
        logger.log('[TPS Notifier] onunload()');
        this.stopLoop();
    }

    async openNotificationModal() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(NOTIFICATION_VIEW_TYPE);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                leaf = rightLeaf;
                await leaf.setViewState({ type: NOTIFICATION_VIEW_TYPE, active: true });
            } else {
                logger.error('[TPS Notifier] Failed to get right leaf');
            }
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        } else {
            logger.error('[TPS Notifier] leaf is null, cannot reveal');
        }
    }

    async loadSettings() {
        try {
            const data = await this.loadData();
            this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

            if (this.settings.enableLogging) {
                logger.setLoggingEnabled(true);
            }

            // Check local storage for device-specific role override
            try {
                const localRole = window.localStorage.getItem(LOCAL_STORAGE_ROLE_KEY);
                if (localRole === 'controller' || localRole === 'receiver') {
                    this.settings.deviceRole = localRole;
                    this.log(`Device role overridden by local storage: ${localRole}`);
                }
            } catch (e) { /* ignore */ }

            // Ensure reminders array exists and is a COPY
            const isFreshInstall = !data || !Array.isArray((data as any).reminders);
            if (!this.settings.reminders || !Array.isArray(this.settings.reminders)) {
                this.settings.reminders = JSON.parse(JSON.stringify(DEFAULT_REMINDERS));
            }
            if (!Array.isArray(this.settings.snoozeOptions) || this.settings.snoozeOptions.length === 0) {
                this.settings.snoozeOptions = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.snoozeOptions));
            }

            // Only add the default Working Check rule on fresh installs.
            // If a user deletes it, we should not re-add it.
            if (isFreshInstall) {
                const hasWorkingRule = this.settings.reminders.some(r => r.id && r.id.startsWith('working-check'));
                if (!hasWorkingRule) {
                    const defaultWorking = DEFAULT_REMINDERS.find(r => r.id === 'working-check-5m');
                    if (defaultWorking) {
                        this.settings.reminders.push(JSON.parse(JSON.stringify(defaultWorking)));
                        this.log('Added default Working Check reminder rule');
                    }
                }
            }

            // MIGRATION: Scheduled Rule
            const scheduledRule = this.settings.reminders.find(r => r.id === 'scheduled-15m');
            if (scheduledRule) {
                scheduledRule.ignoreStatuses = scheduledRule.ignoreStatuses || [];
                if (!scheduledRule.ignoreStatuses.includes('working')) {
                    scheduledRule.ignoreStatuses.push('working');
                }
            }

            // MIGRATION: Legacy Ignore Rules
            const legacyIgnorePaths = Array.isArray(this.settings.ignorePaths) ? this.settings.ignorePaths : [];
            const legacyIgnoreTags = Array.isArray(this.settings.ignoreTags) ? this.settings.ignoreTags : [];
            const legacyIgnoreStatuses = Array.isArray(this.settings.ignoreStatuses) ? this.settings.ignoreStatuses : [];

            for (const reminder of this.settings.reminders) {
                if (!Array.isArray(reminder.ignorePaths)) reminder.ignorePaths = [...legacyIgnorePaths];
                if (!Array.isArray(reminder.ignoreTags)) reminder.ignoreTags = [...legacyIgnoreTags];
                if (!Array.isArray(reminder.ignoreStatuses)) reminder.ignoreStatuses = [...legacyIgnoreStatuses];
            }
        } catch (e) {
            logger.error('[TPS Notifier] Error in loadSettings:', e);
            this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            this.settings.reminders = JSON.parse(JSON.stringify(DEFAULT_REMINDERS));
        }
    }

    async saveSettings() {
        logger.setLoggingEnabled(this.settings.enableLogging);
        await this.saveData(this.settings);
    }

    log(message: string, ...args: any[]) {
        logger.log(`[TPS Notifier] ${message}`, ...args);
    }

    // ========================================================================
    // NOTIFICATION SENDING
    // ========================================================================

    buildObsidianLink(file?: TFile): string {
        if (!file) return '';
        const vaultName = encodeURIComponent(this.app.vault.getName());
        const filePath = encodeURIComponent(file.path);
        // Use custom protocol to handle missing files/sync delay
        return `obsidian://tps-notifier?vault=${vaultName}&file=${filePath}`;
    }

    getNtfyUrl(): string | null {
        const base = (this.settings.ntfyServer || '').replace(/\/+$/, '');
        const topic = (this.settings.ntfyTopic || '').trim();
        if (!base || !topic) return null;
        return `${base}/${topic}`;
    }

    async sendMessage(text: string, file?: TFile, title?: string) {
        if (this.settings.deviceRole !== 'controller') {
            this.log('Skipping send - device is receiver');
            return;
        }

        const url = this.getNtfyUrl();
        if (!url) {
            new Notice('Configure ntfy server and topic first.');
            return;
        }

        const clickLink = this.buildObsidianLink(file);
        const headers: Record<string, string> = {
            'Content-Type': 'text/plain; charset=utf-8',
            'Title': title || 'TPS Notifier',
            'Priority': String(this.settings.ntfyPriority || 3),
            'Markdown': 'yes',
        };

        if (clickLink) {
            headers['Click'] = clickLink;
        }

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: text || '(empty message)',
            });

            if (response.ok) {
                this.log(`Notification sent: ${title}`);
            } else {
                const err = await response.text();
                logger.error('[TPS Notifier] Ntfy error:', err);
            }
        } catch (error) {
            logger.error('[TPS Notifier] Failed to send notification:', error);
        }
    }

    // ========================================================================
    // REMINDER LOOP
    // ========================================================================

    startLoop() {
        this.stopLoop();
        if (this.settings.deviceRole !== 'controller') return;

        this.log('Starting reminder check loop...');

        // Run immediately
        this.runReminders({ ignoreHistory: false });

        // Set up interval
        const ms = Math.max(30000, this.settings.pollMinutes * 60 * 1000);
        this.intervalHandle = setInterval(() => {
            this.runReminders({ ignoreHistory: false });
        }, ms);

        this.log(`Check interval: ${ms}ms`);
    }

    stopLoop() {
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
    }

    // ========================================================================
    // CORE REMINDER LOGIC
    // ========================================================================

    private get globalIgnorePaths(): string[] {
        return Array.isArray(this.settings.ignorePaths) ? this.settings.ignorePaths : [];
    }
    private get globalIgnoreTags(): string[] {
        return Array.isArray(this.settings.ignoreTags) ? this.settings.ignoreTags : [];
    }
    private get globalIgnoreStatuses(): string[] {
        return Array.isArray(this.settings.ignoreStatuses) ? this.settings.ignoreStatuses : [];
    }

    async getOverdueItems(): Promise<OverdueItem[]> {
        const now = Date.now();
        const overdueItems: OverdueItem[] = [];

        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter || {};

            // Check each reminder
            for (const reminder of this.settings.reminders) {
                if (!reminder.enabled) continue;
                if (shouldIgnoreForReminder(file, cache, fm, reminder, this.globalIgnorePaths, this.globalIgnoreTags, this.globalIgnoreStatuses)) continue;

                // [Fix] Check Required Statuses (Inclusion Logic)
                if (!hasRequiredStatus(fm, reminder)) continue;

                // [NEW] Check Snooze
                const snoozeVal = fm[this.settings.snoozeProperty || 'reminderSnooze'];
                if (snoozeVal) {
                    const snoozeTime = parseDate(snoozeVal);
                    if (snoozeTime && now < snoozeTime) {
                        continue;
                    }
                }

                const propertyValue = fm[reminder.property];

                // Use parseTimeRange to get Start and optional End
                const { start: propertyTime, end: rangeEndTime } = parseTimeRange(propertyValue);
                if (!propertyTime) continue;

                // Determine effective End Time
                const effectiveEndTime = getEffectiveEndTime(propertyTime, rangeEndTime, fm);

                // Check Timeblock Expiration
                // If triggerAtEnd is set, we ignore expiration here because the trigger base IS the end time.
                if (reminder.mode === 'timeblock' && effectiveEndTime && !reminder.triggerAtEnd) {
                    if (now > effectiveEndTime) {
                        // Event is over. Do not notify.
                        continue;
                    }
                }

                // Check if any stop condition is met
                const stopped = reminder.stopConditions.some(cond => checkStopCondition(fm, cond));
                if (stopped) continue;

                // [NEW] All-Day Base Time Logic
                // Moved up so finalTriggerBase is ready for trigger check and templates
                let finalTriggerBase = propertyTime;

                // If triggerAtEnd, override finalTriggerBase with effectiveEndTime
                if (reminder.triggerAtEnd && effectiveEndTime) {
                    finalTriggerBase = effectiveEndTime;
                }

                const isAllDaySafe = fm['allDay'] === true || String(fm['allDay']).toLowerCase() === 'true';

                if (isAllDaySafe && reminder.allDayBaseTime) {
                    const match = reminder.allDayBaseTime.match(/^(\d{1,2}):(\d{2})$/);
                    if (match) {
                        const [_, h, m] = match;
                        finalTriggerBase = moment(finalTriggerBase).set({
                            hour: parseInt(h, 10),
                            minute: parseInt(m, 10),
                            second: 0,
                            millisecond: 0
                        }).valueOf();
                    }
                }

                // Calculate trigger time
                let offsetMs = reminder.offsetMinutes * 60 * 1000;
                if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                    const offsetVal = fm[reminder.smartOffsetProperty];
                    const durationMins = parseDuration(offsetVal);
                    const smartMs = durationMins * 60 * 1000;
                    if (reminder.smartOffsetOperator === 'add') {
                        offsetMs = smartMs;
                    } else {
                        offsetMs = -smartMs;
                    }
                }

                const triggerTime = finalTriggerBase + offsetMs;

                // Is it past trigger time? It's overdue
                if (now >= triggerTime) {
                    const diffMs = now - finalTriggerBase;
                    const diffMins = Math.floor(diffMs / 60000);
                    let diff = '';
                    if (diffMins < 0) {
                        diff = `in ${Math.abs(diffMins)} min`;
                    } else if (diffMins < 60) {
                        diff = `${diffMins} min ago`;
                    } else {
                        diff = `${Math.floor(diffMins / 60)}h ${diffMins % 60}m ago`;
                    }

                    // Title and Body Template Resolution
                    const vars: Record<string, string> = {
                        filename: file.basename,
                        time: moment(finalTriggerBase).format('HH:mm'),
                        remaining: diff,
                        duration: fm['duration'] || '',
                    };

                    const resolvedTitle = formatTemplate(reminder.title, vars);
                    const resolvedBody = formatTemplate(reminder.body, vars);

                    overdueItems.push({
                        file,
                        reminder,
                        propertyTime: finalTriggerBase,
                        diff,
                        id: reminder.id,
                        title: resolvedTitle,
                        body: resolvedBody
                    });
                }
            }
        }

        // Sort by time (most overdue first)
        overdueItems.sort((a, b) => a.propertyTime - b.propertyTime);

        // Deduplicate per file + property (collapse multiple rules matching the same event)
        const seenKeys = new Set<string>();
        const deduplicatedItems: OverdueItem[] = [];
        for (const item of overdueItems) {
            // [Fix] Deduplicate by file path only.
            // If a file matches multiple rules, we only show the first one (most overdue).
            const key = item.file.path;
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                deduplicatedItems.push(item);
            }
        }

        return deduplicatedItems;
    }

    async listOverdueItems() {
        new OverdueItemsModal(this.app, this).open();
    }

    async snoozeFile(file: TFile, minutes: number) {
        let snoozeTimeStr = '';
        if (minutes > 0) {
            snoozeTimeStr = moment().add(minutes, 'minutes').format('YYYY-MM-DD HH:mm');
        }

        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            const snoozeKey = this.settings.snoozeProperty || 'reminderSnooze';
            frontmatter[snoozeKey] = snoozeTimeStr;
        });

        for (const rId in this.settings.alertState[file.path] || {}) {
            if (this.settings.alertState[file.path][rId]) {
                this.settings.alertState[file.path][rId].triggered = false;
                this.settings.alertState[file.path][rId].repeatCount = 0;
            }
        }
        await this.saveSettings();
    }

    openFile(file: TFile) {
        const leaf = this.app.workspace.getLeaf(false);
        if (leaf) {
            leaf.openFile(file);
        }
    }

    async runReminders(opts: { ignoreHistory?: boolean } = {}): Promise<number> {
        const { ignoreHistory = false } = opts;
        const now = Date.now();
        let notificationCount = 0;

        if (this.settings.deviceRole !== 'controller') {
            return 0;
        }

        this.log('Running reminder check...');

        const files = this.app.vault.getMarkdownFiles();
        if (this.settings.enableLogging) {
            this.log(`[RunReminders] Checking ${files.length} files...`);
        }
        const alertState = this.settings.alertState;
        let stateChanged = false;

        // [New] Batch Collection
        const pendingNotifications: { title: string, body: string, file: TFile }[] = [];

        for (const file of files) {
            try {
                const cache = this.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter || {};

                // Initialize state for this file
                if (!alertState[file.path]) {
                    alertState[file.path] = {};
                }

                // Process each enabled reminder
                for (const reminder of this.settings.reminders) {
                    if (!reminder.enabled) continue;
                    if (shouldIgnoreForReminder(file, cache, fm, reminder, this.globalIgnorePaths, this.globalIgnoreTags, this.globalIgnoreStatuses)) {
                        // if (this.settings.enableLogging) this.log(`[RunReminders] Ignoring ${file.basename} for ${reminder.id}`);
                        continue;
                    }

                    // Get the property value
                    const propValue = fm[reminder.property];

                    // Use parseTimeRange to get Start and optional End
                    const { start: propTime, end: rangeEndTime } = parseTimeRange(propValue);
                    if (!propTime) continue;

                    // [New] Check Required Statuses (Inclusion Logic)
                    if (!hasRequiredStatus(fm, reminder)) continue;

                    // Calculate trigger time
                    let offsetMs = reminder.offsetMinutes * 60 * 1000;

                    // Determine effective End Time
                    const effectiveEndTime = getEffectiveEndTime(propTime, rangeEndTime, fm);

                    // Check Timeblock Expiration (Only if triggerAtEnd is NOT true, otherwise we WANT to trigger at end)
                    // If triggerAtEnd is true, we trigger relative to End.
                    // If mode=timeblock and NOT triggerAtEnd, we expire if now > End.
                    if (reminder.mode === 'timeblock' && !reminder.triggerAtEnd && effectiveEndTime) {
                        if (now > effectiveEndTime) {
                            continue;
                        }
                    }

                    // [NEW] All-Day Base Time Logic
                    // (Warning: this might conflict if we gathered propertyTime from parseTimeRange which keeps the time)
                    // parseTimeRange returns start, which should include time if present.
                    // Re-applying logic:
                    let finalTriggerBase = propTime;

                    // Override base if triggerAtEnd is true
                    if (reminder.triggerAtEnd) {
                        if (!effectiveEndTime) continue; // Cannot trigger at end if no end
                        finalTriggerBase = effectiveEndTime;
                    }

                    const isAllDaySafe = fm['allDay'] === true || String(fm['allDay']).toLowerCase() === 'true';

                    if (!reminder.triggerAtEnd && isAllDaySafe && reminder.allDayBaseTime) {
                        const match = reminder.allDayBaseTime.match(/^(\d{1,2}):(\d{2})$/);
                        if (match) {
                            const [_, h, m] = match;
                            finalTriggerBase = moment(finalTriggerBase).set({
                                hour: parseInt(h, 10),
                                minute: parseInt(m, 10),
                                second: 0,
                                millisecond: 0
                            }).valueOf();
                        }
                    }


                    // [New] Smart Offset Logic
                    if (reminder.useSmartOffset && reminder.smartOffsetProperty) {
                        const offsetVal = fm[reminder.smartOffsetProperty];
                        const durationMins = parseDuration(offsetVal);
                        // If parsing failed (0), effectively 0 offset or fallback? 
                        // Let's assume 0 is valid or it means "no offset".

                        const smartMs = durationMins * 60 * 1000;
                        if (reminder.smartOffsetOperator === 'add') {
                            offsetMs = smartMs;
                        } else {
                            offsetMs = -smartMs; // Default to subtract (e.g. Due - Estimate)
                        }
                    }

                    const triggerTime = finalTriggerBase + offsetMs;

                    // Initialize state for this reminder
                    if (!alertState[file.path][reminder.id]) {
                        alertState[file.path][reminder.id] = {
                            triggered: false,
                            repeatCount: 0,
                            lastSent: undefined
                        };
                    }

                    const state = alertState[file.path][reminder.id];

                    // [NEW] Check Snooze
                    // User can define configurable snooze frontmatter key with a valid date/time
                    const snoozeVal = fm[this.settings.snoozeProperty || 'reminderSnooze'];
                    if (snoozeVal) {
                        const snoozeTime = parseDate(snoozeVal);
                        // If valid snooze time and we are BEFORE it, skip
                        if (snoozeTime && now < snoozeTime) {
                            continue;
                        }
                    }

                    // [NEW] All-Day Filter
                    if (reminder.allDayFilter && reminder.allDayFilter !== 'any') {
                        // isAllDaySafe is already calculated above
                        if (reminder.allDayFilter === 'true' && !isAllDaySafe) {
                            if (this.settings.enableLogging) this.log(`[RunReminders] Skipping ${file.basename} (Rule: ${reminder.id}) - Not All-Day`);
                            continue;
                        }
                        if (reminder.allDayFilter === 'false' && isAllDaySafe) {
                            if (this.settings.enableLogging) this.log(`[RunReminders] Skipping ${file.basename} (Rule: ${reminder.id}) - Is All-Day`);
                            continue;
                        }
                    }

                    // [NEW] Check if event is currently ongoing (for working status)
                    // If status is "working" and we have an end time, only trigger if current time > end time
                    // This prevents constant pinging DURING the event, allowing it to start AFTER the event ends
                    if (effectiveEndTime) {
                        const currentStatuses = getStatuses(fm);
                        const isWorking = currentStatuses.includes('working');

                        // If status is working and we're before the end time, skip this reminder
                        // UNLESS it's a reminder that specifically requires "working" status (like the 5-min before ping)
                        if (isWorking && now < effectiveEndTime) {
                            const requiresWorking = reminder.requiredStatuses?.some(s =>
                                normalizeStatus(s) === 'working'
                            );
                            // Skip if this reminder doesn't specifically require working status
                            if (!requiresWorking) {
                                continue;
                            }
                        }
                    }

                    // Check stop conditions
                    const shouldStop = reminder.stopConditions.some(cond =>
                        checkStopCondition(fm, cond)
                    );

                    if (shouldStop) {
                        // Reset state when stop condition is met
                        if (state.triggered) {
                            state.triggered = false;
                            state.repeatCount = 0;
                            state.lastSent = undefined;
                            stateChanged = true;
                        }
                        continue;
                    }

                    // Check if we should trigger
                    const pastTriggerTime = now >= triggerTime;

                    if (!pastTriggerTime) {
                        // [Fix] If the event was moved to the future (rescheduled), reset the trigger state
                        if (state.triggered) {
                            state.triggered = false;
                            state.repeatCount = 0;
                            stateChanged = true;
                        }
                        // if (this.settings.enableLogging) {
                        //    const diff = Math.round((triggerTime - now) / 1000 / 60);
                        //    this.log(`[RunReminders] Not time yet for ${file.basename} (Rule: ${reminder.id}). Trigger in ${diff}m.`);
                        // }
                        continue; // Not time yet
                    }

                    // Check if we should send a notification
                    let shouldNotify = false;

                    if (!state.triggered || ignoreHistory) {
                        // First trigger

                        // [NEW] Staleness Check for One-Shot Reminders
                        if (reminder.mode === 'timeblock') {
                            const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
                            if (now - triggerTime > STALE_THRESHOLD_MS) {
                                if (this.settings.enableLogging) {
                                    this.log(`[RunReminders] Skipping stale one-shot for ${file.basename} (${reminder.id}). Triggered ${(now - triggerTime) / 60000} min ago.`);
                                }
                                // Mark as triggered so we don't check again, but DON'T notify
                                state.triggered = true;
                                state.repeatCount = 0;
                                stateChanged = true;
                                continue;
                            }
                        }

                        shouldNotify = true;
                        state.triggered = true;
                        state.repeatCount = 0;
                        stateChanged = true;
                    } else if (reminder.repeatUntilComplete && (!reminder.mode || reminder.mode === 'task') && state.triggered) {
                        // Stop repeating if required status is no longer present
                        if (!hasRequiredStatus(fm, reminder)) {
                            continue;
                        }
                        // Check for repeat
                        const repeatMs = reminder.repeatIntervalMinutes * 60 * 1000;
                        const timeSinceLastSent = state.lastSent ? (now - state.lastSent) : Infinity;

                        if (timeSinceLastSent >= repeatMs) {
                            // Check max repeats
                            if (reminder.maxRepeats === -1 || state.repeatCount < reminder.maxRepeats) {
                                shouldNotify = true;
                                state.repeatCount++;
                                stateChanged = true;
                            }
                        }
                    }

                    if (shouldNotify) {
                        // Build notification
                        const remaining = formatRemaining(propTime - now);
                        const timeStr = moment(propTime).format('h:mm A');

                        let displayName = file.basename;
                        if (!/^\d{4}-\d{2}-\d{2}$/.test(displayName)) {
                            displayName = displayName.replace(/ \d{4}-\d{2}-\d{2}$/, '');
                        }

                        const title = formatTemplate(reminder.title, {
                            filename: displayName,
                            time: timeStr,
                            remaining: remaining
                        });

                        const body = formatTemplate(reminder.body, {
                            filename: displayName,
                            time: timeStr,
                            remaining: remaining
                        });

                        // [NEW] Add to batch queue instead of sending immediately
                        pendingNotifications.push({ title, body, file });
                        state.lastSent = now;
                        stateChanged = true;

                        // [Fix] Break after first trigger for this file to prevent redundancy
                        break;
                    }
                }

            } catch (err) {
                logger.error(`[TPS Notifier] Error processing reminders for ${file.path}:`, err);
            }
        }

        // [New] Batch Processing
        if (pendingNotifications.length > 0) {
            if (this.settings.batchNotifications && pendingNotifications.length > 1) {
                // Batch Encapsulation
                const count = pendingNotifications.length;
                const batchTitle = `${count} Overdue Items`;

                // Construct a summary body
                // Limit to first 5-10 items to avoid huge messages
                const limit = 8;
                const items = pendingNotifications.slice(0, limit);
                let batchBody = items.map(p => `• ${p.title}`).join('\n');

                if (count > limit) {
                    batchBody += `\n...and ${count - limit} more`;
                }

                await this.sendMessage(batchBody, undefined, batchTitle);
                notificationCount += 1; // Count as 1 sent message
                if (this.settings.enableLogging) {
                    this.log(`[RunReminders] Batched ${count} notifications.`);
                }
            } else {
                // Send individually
                for (const p of pendingNotifications) {
                    await this.sendMessage(p.body, p.file, p.title);
                    notificationCount++;
                }
            }
        }

        if (stateChanged) {
            await this.saveSettings();
        }

        return notificationCount;
    }

    // Manually Trigger Notification Modal
    openSendNotificationModal() {
        const modal = new (class extends Modal {
            title = '';
            body = '';
            plugin: TPSNotifier;

            constructor(app: App, plugin: TPSNotifier) {
                super(app);
                this.plugin = plugin;
            }

            onOpen() {
                const { contentEl } = this;
                contentEl.empty();
                contentEl.createEl('h2', { text: 'Send Custom Notification' });

                const container = contentEl.createDiv();
                container.style.display = 'flex';
                container.style.flexDirection = 'column';
                container.style.gap = '10px';

                // Title Input
                const titleBlock = container.createDiv();
                titleBlock.createEl('label', { text: 'Title', cls: 'tps-notifier-label' });
                const titleInput = titleBlock.createEl('input', { type: 'text', placeholder: 'Notification Title' });
                titleInput.style.width = '100%';
                titleInput.addEventListener('input', (e) => this.title = (e.target as HTMLInputElement).value);

                // Body Input
                const bodyBlock = container.createDiv();
                bodyBlock.createEl('label', { text: 'Message', cls: 'tps-notifier-label' });
                const bodyInput = bodyBlock.createEl('textarea', { placeholder: 'Message Body' });
                bodyInput.style.width = '100%';
                bodyInput.rows = 4;
                bodyInput.addEventListener('input', (e) => this.body = (e.target as HTMLTextAreaElement).value);

                // Buttons
                const btnContainer = container.createDiv();
                btnContainer.style.display = 'flex';
                btnContainer.style.justifyContent = 'flex-end';
                btnContainer.style.marginTop = '15px';
                btnContainer.style.gap = '10px';

                const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
                cancelBtn.addEventListener('click', () => this.close());

                const sendBtn = btnContainer.createEl('button', { text: 'Send', cls: 'mod-cta' });
                sendBtn.addEventListener('click', async () => {
                    if (!this.title && !this.body) {
                        new Notice('Please provide a title or message body.');
                        return;
                    }
                    await this.plugin.sendMessage(this.body, undefined, this.title);
                    new Notice('Notification Sent');
                    this.close();
                });
            }

            onClose() {
                this.contentEl.empty();
            }
        })(this.app, this);

        modal.open();
    }

}
