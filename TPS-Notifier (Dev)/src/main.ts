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

// Default reminders moved to TPS-Controller.

const DEFAULT_SETTINGS: TPSNotifierSettings = {
    ntfyServer: 'https://ntfy.sh',
    ntfyTopic: '',
    ntfyPriority: 3,
    enableLogging: false,
    snoozeProperty: 'reminderSnooze',
    snoozeOptions: [
        { label: '15 Minutes', minutes: 15 },
        { label: '1 Hour', minutes: 60 },
        { label: '4 Hours', minutes: 240 },
        { label: '1 Day', minutes: 1440 },
    ],
};

// ============================================================================
// MAIN PLUGIN CLASS
// ============================================================================

export default class TPSNotifier extends Plugin {
    settings: TPSNotifierSettings;

    async onload() {
        logger.log('[TPS Notifier] onload() started');
        try {
            // Load shared UI styles
            try {
                const cssPath = `${this.manifest.dir}/styles-ui.css`;
                const cssContent = await this.app.vault.adapter.read(cssPath);
                this.register(() => document.head.querySelector('style#tps-notifier-ui-styles')?.remove());
                const styleEl = document.head.createEl('style', { attr: { id: 'tps-notifier-ui-styles' } });
                styleEl.textContent = cssContent;
            } catch (e) {
                console.warn("[TPS-Notifier] Failed to load styles-ui.css", e);
            }

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

            // Expose API for Controller
            (this as any).api = {
                sendNotification: (title: string, body: string, file?: TFile) => this.sendMessage(body, file, title),
                sendMessage: (text: string, file?: TFile, title?: string) => this.sendMessage(text, file, title),
                getOverdueItems: () => this.getOverdueItems(),
                snoozeFile: (file: TFile, minutes: number) => this.snoozeFile(file, minutes),
                markFileComplete: (file: TFile) => this.markFileComplete(file),
                markFileWontDo: (file: TFile) => this.markFileWontDo(file),
            };

            // Reminder loop removed — handled by TPS-Controller.

        } catch (error) {
            logger.error('[TPS Notifier] Failed to load plugin:', error);
            new Notice('TPS Notifier failed to load. Check console.');
        }
        logger.log('[TPS Notifier] onload() completed');
    }

    onunload() {
        logger.log('[TPS Notifier] onunload()');
        delete (this as any).api;
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
        } catch (e) {
            logger.error('[TPS Notifier] Error in loadSettings:', e);
            this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
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
        const url = this.getNtfyUrl();
        if (!url) {
            new Notice('Configure ntfy server and topic first.');
            return;
        }

        const clickLink = this.buildObsidianLink(file);

        // Sanitize title to remove non-ISO-8859-1 characters (emojis, unicode, etc.)
        // HTTP headers must only contain ISO-8859-1, so we strip or replace problem characters
        const sanitizedTitle = (title || 'TPS Notifier')
            .replace(/[^\x00-\xFF]/g, ''); // Remove non-ISO-8859-1 characters

        const headers: Record<string, string> = {
            'Content-Type': 'text/plain; charset=utf-8',
            'Title': sanitizedTitle,
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
    // OVERDUE ITEMS (UI Display — stays in Notifier)
    // ========================================================================

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

        // Read reminders from Controller API (source of truth) or legacy settings
        let reminders: PropertyReminder[] = [];
        try {
            const controllerPlugin = (this.app as any).plugins.getPlugin('tps-controller');
            if (controllerPlugin?.api?.getReminders) {
                reminders = controllerPlugin.api.getReminders() || [];
            }
        } catch { /* ignore */ }
        if (!reminders.length && this.settings.reminders) {
            reminders = this.settings.reminders;
        }
        if (!reminders.length) return overdueItems;

        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            const cache = this.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter || {};

            // Check each reminder
            for (const reminder of reminders) {
                if (!reminder.enabled) continue;
                if (shouldIgnoreForReminder(file, cache, fm, reminder, this.globalIgnorePaths, this.globalIgnoreTags, this.globalIgnoreStatuses)) continue;

                // [Fix] Check Required Statuses (Inclusion Logic)
                if (!hasRequiredStatus(fm, reminder)) continue;

                // [NEW] Check Snooze
                let snoozedUntil: number | undefined;
                const snoozeVal = fm[this.settings.snoozeProperty || 'reminderSnooze'];
                if (snoozeVal) {
                    const snoozeTime = parseDate(snoozeVal);
                    if (snoozeTime && now < snoozeTime) {
                        snoozedUntil = snoozeTime;
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
                        const absMins = Math.abs(diffMins);
                        if (absMins < 60) {
                            diff = `in ${absMins} min`;
                        } else if (absMins < 1440) {
                            diff = `in ${Math.floor(absMins / 60)}h ${absMins % 60}m`;
                        } else {
                            const days = Math.floor(absMins / 1440);
                            const hours = Math.floor((absMins % 1440) / 60);
                            const mins = absMins % 60;
                            diff = `in ${days}d ${hours}h ${mins}m`;
                        }
                    } else if (diffMins < 60) {
                        diff = `${diffMins} min ago`;
                    } else if (diffMins < 1440) {
                        diff = `${Math.floor(diffMins / 60)}h ${diffMins % 60}m ago`;
                    } else {
                        const days = Math.floor(diffMins / 1440);
                        const hours = Math.floor((diffMins % 1440) / 60);
                        const mins = diffMins % 60;
                        diff = `${days}d ${hours}h ${mins}m ago`;
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
                        body: resolvedBody,
                        snoozedUntil
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

    // ========================================================================
    // SNOOZE
    // ========================================================================

    async snoozeFile(file: TFile, minutes: number) {
        let snoozeTimeStr = '';
        if (minutes > 0) {
            snoozeTimeStr = moment().add(minutes, 'minutes').format('YYYY-MM-DD HH:mm');
        }

        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            const snoozeKey = this.settings.snoozeProperty || 'reminderSnooze';
            frontmatter[snoozeKey] = snoozeTimeStr;
        });
    }

    openFile(file: TFile) {
        const leaf = this.app.workspace.getLeaf(false);
        if (leaf) {
            leaf.openFile(file);
        }
    }

    // ========================================================================
    // MARK COMPLETE / WON'T DO
    // ========================================================================

    async markFileComplete(file: TFile) {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            frontmatter.status = 'complete';
        });
    }

    async markFileWontDo(file: TFile) {
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
            frontmatter.status = 'wont-do';
        });
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
