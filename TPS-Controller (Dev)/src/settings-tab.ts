import { App, Notice, PluginSettingTab, Setting, debounce } from 'obsidian';
import type TPSControllerPlugin from './main';
import type { PropertyReminder, ExternalCalendarConfig } from './types';
import { normalizeCalendarUrl } from './utils';
import { renderListWithControls } from './utils/list-renderer';

const createCalendarId = () => `calendar-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
const createCollapsibleSection = (
    parent: HTMLElement,
    title: string,
    description?: string,
    defaultOpen = false
): HTMLElement => {
    const details = parent.createEl('details', { cls: 'tps-collapsible-section' });
    if (defaultOpen) {
        details.setAttr('open', 'true');
    }

    const summary = details.createEl('summary', { cls: 'tps-collapsible-section-summary' });
    summary.createSpan({ cls: 'tps-collapsible-section-title', text: title });

    if (description) {
        details.createEl('p', {
            cls: 'tps-collapsible-section-description',
            text: description
        });
    }

    return details.createDiv({ cls: 'tps-collapsible-section-content' });
};

// ============================================================================
// Controller Settings Tab
// ============================================================================

export class TPSControllerSettingTab extends PluginSettingTab {
    plugin: TPSControllerPlugin;

    constructor(app: App, plugin: TPSControllerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        const debouncedSave = debounce(() => this.plugin.saveSettings(), 300);

        containerEl.createEl('h2', { text: 'TPS Controller Settings' });
        containerEl.createEl('p', {
            text: 'This is the suite-level owner for background automation, calendar sync, reminders, and shared calendar field mappings. Other TPS plugins should stay focused on UI and local interaction.',
            cls: 'setting-item-description'
        });

        const createMainCategory = (title: 'Features' | 'Rules' | 'Interaction' | 'UI Display', defaultOpen = true): HTMLElement => {
            const details = containerEl.createEl('details', { cls: 'tps-settings-main-category' });
            if (defaultOpen) details.setAttr('open', 'true');
            const summary = details.createEl('summary', { cls: 'tps-settings-main-summary' });
            summary.createEl('h3', { text: title });
            return details.createDiv({ cls: 'tps-settings-main-content' });
        };

        const featuresCategory = createMainCategory('Features');
        const rulesCategory = createMainCategory('Rules');
        const interactionCategory = createMainCategory('Interaction');
        const uiDisplayCategory = createMainCategory('UI Display');

        // ── Device Role ─────────────────────────────────────────────
        const roleSection = createCollapsibleSection(
            interactionCategory,
            'Device Role',
            'Choose whether this device runs suite-level automation or stays in normal user mode.',
            true
        );

        const roleDesc = roleSection.createDiv({ cls: 'tps-controller-role-desc' });
        const updateRoleDesc = (role: string) => {
            const isCtrl = role === 'controller';
            roleDesc.innerHTML = `
                <strong>Current Role:</strong>
                <span class="${isCtrl ? 'tps-role-controller' : 'tps-role-user'}">
                    ${isCtrl ? '🟢 Controller (Background Automation)' : '⚪ User (Normal Use)'}
                </span>
                <br><small class="tps-role-hint">
                    ${isCtrl ? 'This device runs all automation (calendar sync, reminders, companion scan). UI is locked down.' : 'This device is in normal user mode — no automation runs.'}
                </small>
            `;
        };
        const currentRole = this.plugin.deviceRoleManager?.role || 'user';
        updateRoleDesc(currentRole);

        new Setting(roleSection)
            .setName('Set Device Role')
            .addDropdown(drop => drop
                .addOption('controller', 'Controller (Background Automation)')
                .addOption('user', 'User (Normal Use)')
                .setValue(currentRole)
                .onChange(async (value) => {
                    this.plugin.deviceRoleManager.setRole(value as any);
                    updateRoleDesc(value);
                    new Notice(`Device set to ${value === 'controller' ? 'CONTROLLER' : 'USER'} mode.`);
                }));

        // ── External Calendars ─────────────────────────────────────
        const extCalSection = createCollapsibleSection(
            featuresCategory,
            'External Calendars',
            'Calendar sources and auto-create destinations. These are the controller settings most users will change first.',
            true
        );
        const calendarsContainer = extCalSection.createDiv();
        this.renderExternalCalendars(calendarsContainer);

        new Setting(extCalSection)
            .setName('Add New Calendar')
            .setDesc('Add an external iCal feed (Google, Outlook, etc).')
            .addButton((btn) => btn
                .setIcon('plus')
                .setButtonText('Add Calendar')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.externalCalendars.push({
                        id: createCalendarId(),
                        url: "",
                        color: "#3b82f6",
                        enabled: true,
                        autoCreateEnabled: true,
                        autoCreateTypeFolder: "",
                        autoCreateFolder: "",
                        autoCreateTag: "",
                        autoCreateTemplate: ""
                    });
                    await this.plugin.saveSettings();
                    this.renderExternalCalendars(calendarsContainer);
                }));

        // ── Calendar Sync Rules ────────────────────────────────────
        const calSection = createCollapsibleSection(
            rulesCategory,
            'Calendar Sync Rules',
            'Global sync behavior for external calendars.',
            true
        );

        new Setting(calSection)
            .setName('Sync Interval (minutes)')
            .setDesc('How often to sync external calendars.')
            .addSlider(slider => slider
                .setLimits(1, 60, 1)
                .setValue(this.plugin.settings.syncIntervalMinutes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.syncIntervalMinutes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(calSection)
            .setName('No-Loss Sync Mode')
            .setDesc('Prevents inferred deletes from remote absence. Orphans are quarantined for manual review; explicit cancellations can archive.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.noLossSyncMode ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.noLossSyncMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(calSection)
            .setName('On Event Deletion')
            .setDesc('What to do when an external event is removed from the feed. In No-Loss mode, "Delete note" is treated as archive-safe behavior.')
            .addDropdown(drop => drop
                .addOption('nothing', 'Do nothing')
                .addOption('archive', 'Move to archive folder')
                .addOption('delete', 'Delete note')
                .setValue(this.plugin.settings.syncOnEventDelete)
                .onChange(async (value) => {
                    this.plugin.settings.syncOnEventDelete = value as any;
                    await this.plugin.saveSettings();
                }));

        new Setting(calSection)
            .setName('Archive Folder')
            .setDesc('Folder to move archived event notes to.')
            .addText(text => text
                .setPlaceholder('System/Archive')
                .setValue(this.plugin.settings.archiveFolder)
                .onChange((value) => {
                    this.plugin.settings.archiveFolder = value;
                    void debouncedSave();
                }));

        new Setting(calSection)
            .setName('Calendar Filter')
            .setDesc('Regex or keyword to filter out external events (e.g. "Canceled").')
            .addText(text => text
                .setPlaceholder('Canceled')
                .setValue(this.plugin.settings.externalCalendarFilter)
                .onChange((value) => {
                    this.plugin.settings.externalCalendarFilter = value;
                    void debouncedSave();
                }));

        new Setting(calSection)
            .setName('Canceled Status Value')
            .setDesc('The status value to set when an event is canceled.')
            .addText(text => text
                .setPlaceholder('cancelled')
                .setValue(this.plugin.settings.canceledStatusValue)
                .onChange((value) => {
                    this.plugin.settings.canceledStatusValue = value;
                    void debouncedSave();
                }));

        const fmContent = createCollapsibleSection(
            calSection,
            'Frontmatter Keys',
            'All shared calendar field names are grouped together here.',
            true
        );

        const fmKeys: { key: keyof typeof this.plugin.settings; label: string; placeholder: string }[] = [
            { key: 'eventIdKey', label: 'Event ID Key', placeholder: 'externalEventId' },
            { key: 'uidKey', label: 'UID Key', placeholder: 'tpsCalendarUid' },
            { key: 'titleKey', label: 'Title Key', placeholder: 'title' },
            { key: 'statusKey', label: 'Status Key', placeholder: 'status' },
            { key: 'previousStatusKey', label: 'Previous Status Key', placeholder: 'tpsCalendarPrevStatus' },
            { key: 'startProperty', label: 'Start Property', placeholder: 'scheduled' },
            { key: 'endProperty', label: 'Duration Property', placeholder: 'timeEstimate' },
        ];

        for (const fk of fmKeys) {
            new Setting(fmContent)
                .setName(fk.label)
                .addText(text => text
                    .setPlaceholder(fk.placeholder)
                    .setValue(String((this.plugin.settings as any)[fk.key] || ''))
                    .onChange(async (value) => {
                        (this.plugin.settings as any)[fk.key] = value;
                        await this.plugin.saveSettings();
                    }));
        }

        new Setting(calSection)
            .setName('Force Calendar Sync')
            .setDesc('Run a calendar sync immediately.')
            .addButton(btn => btn
                .setButtonText('Sync Now')
                .setCta()
                .onClick(async () => {
                    btn.setButtonText('Syncing…');
                    btn.setDisabled(true);
                    try {
                        await (this.plugin as any).runCalendarSync(true);
                        new Notice('Calendar sync complete.');
                    } catch (e) {
                        new Notice('Sync failed: ' + (e as Error).message);
                    }
                    btn.setButtonText('Sync Now');
                    btn.setDisabled(false);
                }));

        // ── Reminder Rules ──────────────────────────────────────────
        const remSection = createCollapsibleSection(
            rulesCategory,
            'Reminder Rules',
            'Polling, ignore lists, and per-rule reminders.',
            true
        );

        const reminderConfigContent = remSection.createDiv({ cls: 'tps-reminder-config-content' });

        new Setting(remSection)
            .setName('Enable Reminders')
            .setDesc('Master toggle for reminder evaluation and notifications.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableReminders ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.enableReminders = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        if (!(this.plugin.settings.enableReminders ?? true)) {
            remSection.createEl('p', {
                text: 'Reminders are disabled. Enable the master toggle to show reminder configuration.',
                cls: 'setting-item-description'
            });
        } else {

        new Setting(reminderConfigContent)
            .setName('Check Interval (minutes)')
            .setDesc('How often to evaluate reminder rules.')
            .addSlider(slider => slider
                .setLimits(0.25, 10, 0.25)
                .setValue(this.plugin.settings.pollMinutes)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.pollMinutes = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(reminderConfigContent)
            .setName('Batch Notifications')
            .setDesc('Send one combined notification for multiple triggers.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.batchNotifications)
                .onChange(async (value) => {
                    this.plugin.settings.batchNotifications = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(reminderConfigContent)
            .setName('Default All-Day Base Time')
            .setDesc('Time of day (HH:MM) used as the trigger base for all-day events when a reminder has no per-rule "All-Day Base Time" set. Without this, all-day events default to midnight and notifications fire at the start of the day.')
            .addText(text => text
                .setPlaceholder('09:00')
                .setValue(this.plugin.settings.defaultAllDayBaseTime || '09:00')
                .onChange(async (value) => {
                    this.plugin.settings.defaultAllDayBaseTime = value.trim();
                    await this.plugin.saveSettings();
                }));

        const kanbanReminderContent = createCollapsibleSection(
            reminderConfigContent,
            'Kanban Task Reminders',
            'Configure how checkbox cards in Kanban board notes are interpreted for reminders and overdue actions.',
            false
        );

        new Setting(kanbanReminderContent)
            .setName('Enable Kanban Task Targets')
            .setDesc('When enabled, reminder rules evaluate checkbox card lines inside Kanban board files as independent reminder targets.')
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.kanbanTaskReminders.enabled)
                .onChange(async (value) => {
                    this.plugin.settings.kanbanTaskReminders.enabled = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(kanbanReminderContent)
            .setName('Include Board File Target')
            .setDesc('Also evaluate the Kanban board note frontmatter itself as a reminder target. Disable for strictly card-level reminders.')
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.kanbanTaskReminders.includeBoardFileTarget)
                .onChange(async (value) => {
                    this.plugin.settings.kanbanTaskReminders.includeBoardFileTarget = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(kanbanReminderContent)
            .setName('Parse Inline Properties')
            .setDesc('Read card-level inline properties (e.g. [scheduled:: 2026-03-13 09:00]).')
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.kanbanTaskReminders.parseInlineProperties)
                .onChange(async (value) => {
                    this.plugin.settings.kanbanTaskReminders.parseInlineProperties = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(kanbanReminderContent)
            .setName('Parse Kanban Date Tokens')
            .setDesc('Read Kanban scheduling tokens (@{date} and @@{time}) as reminder trigger dates.')
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.kanbanTaskReminders.parseKanbanDateTokens)
                .onChange(async (value) => {
                    this.plugin.settings.kanbanTaskReminders.parseKanbanDateTokens = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(kanbanReminderContent)
            .setName('Parse Tasks Emoji Dates')
            .setDesc('Read Tasks-style emoji dates on cards (📅 due, ⏳ scheduled, 🛫 start).')
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.kanbanTaskReminders.parseTasksEmojiDates)
                .onChange(async (value) => {
                    this.plugin.settings.kanbanTaskReminders.parseTasksEmojiDates = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(kanbanReminderContent)
            .setName('Status Property Key')
            .setDesc('Inline property key used for task status writes and status filtering on Kanban task cards.')
            .addText(text => text
                .setPlaceholder('status')
                .setValue(this.plugin.settings.kanbanTaskReminders.statusProperty || 'status')
                .onChange(async (value) => {
                    this.plugin.settings.kanbanTaskReminders.statusProperty = value.trim() || 'status';
                    await this.plugin.saveSettings();
                }));

        new Setting(kanbanReminderContent)
            .setName('Complete Status Value')
            .setDesc('Status value written when marking a Kanban task reminder complete.')
            .addText(text => text
                .setPlaceholder('complete')
                .setValue(this.plugin.settings.kanbanTaskReminders.completeStatusValue || 'complete')
                .onChange(async (value) => {
                    this.plugin.settings.kanbanTaskReminders.completeStatusValue = value.trim() || 'complete';
                    await this.plugin.saveSettings();
                }));

        new Setting(kanbanReminderContent)
            .setName("Won't-Do Status Value")
            .setDesc("Status value written when marking a Kanban task reminder won't-do.")
            .addText(text => text
                .setPlaceholder('wont-do')
                .setValue(this.plugin.settings.kanbanTaskReminders.wontDoStatusValue || 'wont-do')
                .onChange(async (value) => {
                    this.plugin.settings.kanbanTaskReminders.wontDoStatusValue = value.trim() || 'wont-do';
                    await this.plugin.saveSettings();
                }));

        const parseCsv = (value: string): string[] =>
            value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

        new Setting(kanbanReminderContent)
            .setName('Scheduled Property Aliases')
            .setDesc('Comma-separated property names that should map to scheduled time parsing for Kanban cards.')
            .addText(text => text
                .setPlaceholder('scheduled, start')
                .setValue((this.plugin.settings.kanbanTaskReminders.scheduledPropertyAliases || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.kanbanTaskReminders.scheduledPropertyAliases = parseCsv(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(kanbanReminderContent)
            .setName('Due Property Aliases')
            .setDesc('Comma-separated property names that should map to due-date parsing for Kanban cards.')
            .addText(text => text
                .setPlaceholder('due, duedate')
                .setValue((this.plugin.settings.kanbanTaskReminders.duePropertyAliases || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.kanbanTaskReminders.duePropertyAliases = parseCsv(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(kanbanReminderContent)
            .setName('Start Property Aliases')
            .setDesc('Comma-separated property names that should map to start-date parsing for Kanban cards.')
            .addText(text => text
                .setPlaceholder('start, startdate')
                .setValue((this.plugin.settings.kanbanTaskReminders.startPropertyAliases || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.kanbanTaskReminders.startPropertyAliases = parseCsv(value);
                    await this.plugin.saveSettings();
                }));

        const ignoreContent = createCollapsibleSection(
            reminderConfigContent,
            'Global Ignore Lists',
            'Shared filters applied before individual reminder rules.',
            false
        );

        new Setting(ignoreContent)
            .setName('Ignore Paths')
            .setDesc('Comma-separated ignore paths. Supports glob wildcards (*/Templates/*) and regex (re:^System/).')
            .addText(text => text
                .setPlaceholder('System, Notes')
                .setValue((this.plugin.settings.globalIgnorePaths || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.globalIgnorePaths = value.split(',').map(s => s.trim()).filter(Boolean);
                    await this.plugin.saveSettings();
                }));

        new Setting(ignoreContent)
            .setName('Ignore Tags')
            .setDesc('Comma-separated tags to ignore.')
            .addText(text => text
                .setPlaceholder('archive, template')
                .setValue((this.plugin.settings.globalIgnoreTags || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.globalIgnoreTags = value.split(',').map(s => s.trim()).filter(Boolean);
                    await this.plugin.saveSettings();
                }));

        new Setting(ignoreContent)
            .setName('Ignore Statuses')
            .setDesc('Comma-separated status values to ignore.')
            .addText(text => text
                .setPlaceholder('complete, wont-do')
                .setValue((this.plugin.settings.globalIgnoreStatuses || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.globalIgnoreStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                    await this.plugin.saveSettings();
                }));

        // Individual reminder rules
        const rulesContainer = reminderConfigContent.createDiv({ cls: 'tps-controller-reminder-rules' });
        this.renderReminderRules(rulesContainer);

        new Setting(reminderConfigContent)
            .addButton(btn => btn
                .setButtonText('Add Reminder Rule')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.reminders.push(this.createDefaultReminder());
                    await this.plugin.saveSettings();
                    this.renderReminderRules(rulesContainer);
                }));

        new Setting(reminderConfigContent)
            .setName('Run Reminder Check')
            .setDesc('Evaluate all reminder rules now.')
            .addButton(btn => btn
                .setButtonText('Check Now')
                .onClick(async () => {
                    btn.setButtonText('Checking…');
                    btn.setDisabled(true);
                    try {
                        await (this.plugin as any).runReminderCheck();
                        new Notice('Reminder check complete.');
                    } catch (e) {
                        new Notice('Reminder check failed.');
                    }
                    btn.setButtonText('Check Now');
                    btn.setDisabled(false);
                }));
        }

        // ── Snooze ─────────────────────────────────────────────────
        const snoozeSection = createCollapsibleSection(
            rulesCategory,
            'Snooze',
            'Reminder snooze field configuration and presets.',
            false
        );

        new Setting(snoozeSection)
            .setName('Snooze Property')
            .setDesc('Frontmatter property name for snooze time (e.g., reminderSnooze)')
            .addText(text => text
                .setPlaceholder('reminderSnooze')
                .setValue(this.plugin.settings.snoozeProperty || 'reminderSnooze')
                .onChange((value) => {
                    this.plugin.settings.snoozeProperty = value.trim() || 'reminderSnooze';
                    void debouncedSave();
                }));

        const snoozePresetsEl = createCollapsibleSection(
            snoozeSection,
            'Snooze Presets',
            'Quick snooze durations shown in the reminder UI.',
            true
        );
        this.renderSnoozeOptions(snoozePresetsEl);
        new Setting(snoozePresetsEl)
            .addButton((btn) =>
                btn.setButtonText('Add Preset').setCta().onClick(async () => {
                    if (!Array.isArray(this.plugin.settings.snoozeOptions)) this.plugin.settings.snoozeOptions = [];
                    this.plugin.settings.snoozeOptions.push({ label: '15 Minutes', minutes: 15 });
                    await this.plugin.saveSettings();
                    this.renderSnoozeOptions(snoozePresetsEl);
                })
            );

        // ── Companion Scan ──────────────────────────────────────────
        const compSection = createCollapsibleSection(
            featuresCategory,
            'Companion Automation',
            'Optional integration that lets Controller trigger companion scans.',
            false
        );

        new Setting(compSection)
            .setName('Enable Controller Companion Scans')
            .setDesc('When enabled, the Controller syncs companion styling (icon/color/sort) across ALL vault files every 5 minutes. User devices only sync files they actively edit. Changes take effect on next automation cycle.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.companionStartupScanEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.companionStartupScanEnabled = value;
                    await this.plugin.saveSettings();
                }));

        if (this.plugin.settings.companionStartupScanEnabled) {
            new Setting(compSection)
                .setName('Startup Delay (ms)')
                .setDesc('Delay before the startup vault scan begins.')
                .addText(text => text
                    .setPlaceholder('800')
                    .setValue(String(this.plugin.settings.companionStartupDelayMs))
                    .onChange(async (value) => {
                        const parsed = parseInt(value, 10);
                        if (!isNaN(parsed) && parsed >= 0) {
                            this.plugin.settings.companionStartupDelayMs = Math.min(parsed, 30000);
                            await this.plugin.saveSettings();
                        }
                    }));

            new Setting(compSection)
                .setName('Run Companion Scan')
                .setDesc('Trigger a companion vault scan now.')
                .addButton(btn => btn
                    .setButtonText('Scan Now')
                    .onClick(async () => {
                        btn.setButtonText('Scanning…');
                        btn.setDisabled(true);
                        try {
                            await (this.plugin as any).runCompanionScan();
                            new Notice('Companion scan complete.');
                        } catch (e) {
                            new Notice('Companion scan failed.');
                        }
                        btn.setButtonText('Scan Now');
                        btn.setDisabled(false);
                    }));
        }

        // ── Debug ───────────────────────────────────────────────────
        const debugSection = createCollapsibleSection(
            uiDisplayCategory,
            'Debug',
            'Low-frequency troubleshooting controls.',
            false
        );

        new Setting(debugSection)
            .setName('Enable Logging')
            .setDesc('Print detailed logs to console.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLogging)
                .onChange(async (value) => {
                    this.plugin.settings.enableLogging = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(debugSection)
            .setName('Reset Alert State')
            .setDesc('Clear all stored alert tracking (will re-trigger all reminders).')
            .addButton(btn => btn
                .setButtonText('Reset')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings.alertState = {};
                    await this.plugin.saveSettings();
                    new Notice('Alert state cleared.');
                }));
    }

    // ========================================================================
    // Helpers
    // ========================================================================


    private createDefaultReminder(): PropertyReminder {
        return {
            id: `reminder-${Date.now()}`,
            label: 'New Reminder',
            property: 'scheduled',
            enabled: true,
            offsetMinutes: -15,
            repeatUntilComplete: false,
            repeatIntervalMinutes: 5,
            maxRepeats: -1,
            stopConditions: ['status: complete', 'status: wont-do'],
            title: 'Reminder: {filename}',
            body: 'At {time} ({remaining})',
            ignorePaths: [],
            ignoreTags: [],
            ignoreStatuses: [],
            allDayFilter: 'any',
        };
    }

    private renderReminderRules(container: HTMLElement): void {
        container.empty();
        const reminders = this.plugin.settings.reminders || [];

        if (reminders.length === 0) {
            const empty = container.createDiv({ cls: 'tps-empty-state' });
            empty.textContent = 'No reminder rules configured.';
            return;
        }

        reminders.forEach((rem, index) => {
            const ruleEl = container.createDiv({ cls: 'tps-controller-reminder-rule' });
            const ruleHeader = ruleEl.createDiv({ cls: 'tps-rule-summary-row' });
            const labelSpan = ruleHeader.createSpan({ cls: 'tps-rule-label' });
            labelSpan.textContent = `${rem.enabled ? '🟢' : '⚫'} ${rem.label || `Rule ${index + 1}`}`;
            const descSpan = ruleHeader.createSpan({ cls: 'tps-rule-desc' });
            descSpan.textContent = this.buildRuleDesc(rem);

            const ruleContent = ruleEl.createDiv({ cls: 'tps-rule-content' });

            // ── General ──────────────────────────────────────────────────────
            new Setting(ruleContent).setName('General').setHeading();

            new Setting(ruleContent)
                .setName('Label')
                .addText(text => text
                    .setValue(rem.label || '')
                    .onChange(async (value) => {
                        rem.label = value;
                        await this.plugin.saveSettings();
                        labelSpan.textContent = `${rem.enabled ? '🟢' : '⚫'} ${value || `Rule ${index + 1}`}`;
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(ruleContent)
                .setName('Enabled')
                .addToggle(toggle => toggle
                    .setValue(rem.enabled)
                    .onChange(async (value) => {
                        rem.enabled = value;
                        await this.plugin.saveSettings();
                        labelSpan.textContent = `${value ? '🟢' : '⚫'} ${rem.label || `Rule ${index + 1}`}`;
                    }));

            // ── Trigger ──────────────────────────────────────────────────────
            new Setting(ruleContent).setName('Trigger').setHeading();

            new Setting(ruleContent)
                .setName('Property')
                .setDesc('Frontmatter date/time property to trigger on.')
                .addText(text => text
                    .setValue(rem.property)
                    .onChange(async (value) => {
                        rem.property = value;
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(ruleContent)
                .setName('Mode')
                .setDesc('Task fires once at the trigger time. Timeblock skips firing once the event end time has passed.')
                .addDropdown(drop => drop
                    .addOption('task', 'Task')
                    .addOption('timeblock', 'Timeblock')
                    .setValue(rem.mode || 'task')
                    .onChange(async (value) => {
                        rem.mode = value as 'task' | 'timeblock';
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent)
                .setName('Trigger at End')
                .setDesc('Use the event end time (start + duration) as the trigger base instead of the start time.')
                .addToggle(toggle => toggle
                    .setValue(!!rem.triggerAtEnd)
                    .onChange(async (value) => {
                        rem.triggerAtEnd = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent)
                .setName('Fixed Offset (minutes)')
                .setDesc('Applied after the trigger base. Negative = before, positive = after. Used as fallback when Duration Offset is enabled but the property is missing or unparseable.')
                .addText(text => text
                    .setValue(String(rem.offsetMinutes))
                    .onChange(async (value) => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num)) {
                            rem.offsetMinutes = num;
                            await this.plugin.saveSettings();
                            descSpan.textContent = this.buildRuleDesc(rem);
                        }
                    }));

            // Duration offset — shown/hidden without full re-render
            const durationOffsetWrapper = ruleContent.createDiv();
            durationOffsetWrapper.style.display = rem.useSmartOffset ? '' : 'none';

            new Setting(ruleContent)
                .setName('Use Duration Offset')
                .setDesc('Replace the fixed offset with a duration read from a frontmatter property (e.g. timeEstimate: "30m"). Falls back to Fixed Offset if the property is missing.')
                .addToggle(toggle => toggle
                    .setValue(!!rem.useSmartOffset)
                    .onChange(async (value) => {
                        rem.useSmartOffset = value;
                        durationOffsetWrapper.style.display = value ? '' : 'none';
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(durationOffsetWrapper)
                .setName('Duration Property')
                .setDesc('Frontmatter property containing the duration value (e.g. timeEstimate).')
                .addText(text => text
                    .setPlaceholder('timeEstimate')
                    .setValue(rem.smartOffsetProperty || '')
                    .onChange(async (value) => {
                        rem.smartOffsetProperty = value;
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(durationOffsetWrapper)
                .setName('Direction')
                .setDesc('"After" fires duration-time after the trigger base. "Before" fires duration-time before.')
                .addDropdown(drop => drop
                    .addOption('add', 'After (base + duration)')
                    .addOption('subtract', 'Before (base − duration)')
                    .setValue(rem.smartOffsetOperator || 'add')
                    .onChange(async (value) => {
                        rem.smartOffsetOperator = value as any;
                        await this.plugin.saveSettings();
                    }));

            // ── All-Day Events ───────────────────────────────────────────────
            new Setting(ruleContent).setName('All-Day Events').setHeading();

            new Setting(ruleContent)
                .setName('All-Day Filter')
                .setDesc('Restrict this rule to all-day or timed events only.')
                .addDropdown(drop => drop
                    .addOption('any', 'Any')
                    .addOption('true', 'All-day events only')
                    .addOption('false', 'Timed events only')
                    .setValue(rem.allDayFilter || 'any')
                    .onChange(async (value) => {
                        rem.allDayFilter = value as any;
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent)
                .setName('All-Day Base Time')
                .setDesc('Time of day (HH:MM) used as the trigger base for all-day events. Leave blank to use the global default.')
                .addText(text => text
                    .setPlaceholder('(uses global default)')
                    .setValue(rem.allDayBaseTime || '')
                    .onChange(async (value) => {
                        rem.allDayBaseTime = value.trim();
                        await this.plugin.saveSettings();
                    }));

            // ── Filtering ────────────────────────────────────────────────────
            new Setting(ruleContent).setName('Filtering').setHeading();

            new Setting(ruleContent)
                .setName('Required Statuses')
                .setDesc('Only trigger for files with one of these statuses. Comma-separated (e.g. scheduled, in-progress).')
                .addText(text => text
                    .setValue((rem.requiredStatuses || []).join(', '))
                    .onChange(async (value) => {
                        rem.requiredStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(ruleContent)
                .setName('Required Folders')
                .setDesc('Only trigger for files inside these folders. Comma-separated prefixes. Empty = all folders.')
                .addText(text => text
                    .setPlaceholder('Action Items, Markdown/Projects')
                    .setValue((rem.requiredPaths || []).join(', '))
                    .onChange(async (value) => {
                        rem.requiredPaths = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent)
                .setName('Ignore Paths')
                .setDesc('Skip matching files. Comma-separated. Supports wildcards (*/Trash/*) and regex (re:^System/).')
                .addText(text => text
                    .setValue((rem.ignorePaths || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignorePaths = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent)
                .setName('Ignore Tags')
                .setDesc('Skip files with these tags. Comma-separated.')
                .addText(text => text
                    .setValue((rem.ignoreTags || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignoreTags = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent)
                .setName('Ignore Statuses')
                .setDesc('Skip files with these statuses. Comma-separated.')
                .addText(text => text
                    .setValue((rem.ignoreStatuses || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignoreStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            // ── Repeat & Stop ────────────────────────────────────────────────
            new Setting(ruleContent).setName('Repeat & Stop').setHeading();

            // Repeat interval/maxRepeats — shown/hidden without full re-render
            const repeatWrapper = ruleContent.createDiv();
            repeatWrapper.style.display = rem.repeatUntilComplete ? '' : 'none';

            new Setting(ruleContent)
                .setName('Repeat Until Complete')
                .setDesc('Re-send the notification on an interval until a stop condition is met.')
                .addToggle(toggle => toggle
                    .setValue(rem.repeatUntilComplete)
                    .onChange(async (value) => {
                        rem.repeatUntilComplete = value;
                        repeatWrapper.style.display = value ? '' : 'none';
                        await this.plugin.saveSettings();
                    }));

            new Setting(repeatWrapper)
                .setName('Repeat Interval (minutes)')
                .addText(text => text
                    .setValue(String(rem.repeatIntervalMinutes))
                    .onChange(async (value) => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && num > 0) {
                            rem.repeatIntervalMinutes = num;
                            await this.plugin.saveSettings();
                        }
                    }));

            new Setting(repeatWrapper)
                .setName('Max Repeats')
                .setDesc('Maximum number of repeat notifications. −1 = unlimited.')
                .addText(text => text
                    .setValue(String(rem.maxRepeats ?? -1))
                    .onChange(async (value) => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num) && (num === -1 || num > 0)) {
                            rem.maxRepeats = num;
                            await this.plugin.saveSettings();
                        }
                    }));

            new Setting(ruleContent)
                .setName('Stop Conditions')
                .setDesc('Stop repeating when any condition matches. Format: "property: value" (e.g. status: complete). Comma-separated.')
                .addText(text => text
                    .setValue((rem.stopConditions || []).join(', '))
                    .onChange(async (value) => {
                        rem.stopConditions = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            // ── Notification ────────────────────────────────────────────────
            new Setting(ruleContent).setName('Notification').setHeading();

            new Setting(ruleContent)
                .setName('Title')
                .setDesc('Supports {filename}, {time}, {remaining}.')
                .addText(text => text
                    .setValue(rem.title)
                    .onChange(async (value) => {
                        rem.title = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent)
                .setName('Body')
                .setDesc('Supports {filename}, {time}, {remaining}.')
                .addText(text => text
                    .setValue(rem.body)
                    .onChange(async (value) => {
                        rem.body = value;
                        await this.plugin.saveSettings();
                    }));

            // ── Actions ──────────────────────────────────────────────────────
            new Setting(ruleContent)
                .addButton(btn => btn
                    .setButtonText('Delete Rule')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.reminders.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.renderReminderRules(container);
                    }));
        });
    }

    private buildRuleDesc(rem: PropertyReminder): string {
        const parts: string[] = [rem.property];
        if (rem.useSmartOffset && rem.smartOffsetProperty) {
            const dir = rem.smartOffsetOperator === 'subtract' ? '−' : '+';
            parts.push(`${dir}${rem.smartOffsetProperty}`);
        } else {
            parts.push(`${rem.offsetMinutes >= 0 ? '+' : ''}${rem.offsetMinutes}min`);
        }
        if (rem.requiredStatuses?.length) parts.push(rem.requiredStatuses.join('/'));
        if (rem.triggerAtEnd) parts.push('at end');
        if (rem.mode && rem.mode !== 'task') parts.push(rem.mode);
        return parts.join(' • ');
    }


    private renderExternalCalendars(container: HTMLElement) {
        container.empty();
        const calendars = this.plugin.settings.externalCalendars || [];

        if (!calendars.length) {
            const empty = container.createEl("p", { text: "No external calendars added." });
            empty.style.color = "var(--text-muted)";
            empty.style.marginBottom = "12px";
            return;
        }

        const save = async (rerender = false) => {
            await this.plugin.saveSettings();
            if (rerender) this.renderExternalCalendars(container);
        };

        calendars.forEach((calendar, index) => {
            const card = container.createDiv();
            card.style.border = "1px solid var(--background-modifier-border)";
            card.style.borderRadius = "8px";
            card.style.padding = "12px";
            card.style.marginBottom = "12px";
            card.style.background = "var(--background-primary-alt)";

            const header = card.createDiv();
            header.style.display = "flex";
            header.style.alignItems = "center";
            header.style.gap = "10px";
            header.style.marginBottom = "10px";

            // Title / Toggle
            const toggle = header.createEl("input", { type: "checkbox" });
            toggle.checked = calendar.enabled !== false;
            toggle.addEventListener("change", async () => {
                calendar.enabled = toggle.checked;
                await save();
            });

            const title = header.createEl("strong", {
                text: calendar.url ? `Calendar ${index + 1}` : "New Calendar"
            });
            title.style.flex = "1";

            // Move Up/Down?
            const move = (from: number, to: number) => {
                const temp = calendars[from];
                calendars[from] = calendars[to];
                calendars[to] = temp;
            };

            const upBtn = header.createEl("button", { text: "↑" });
            upBtn.disabled = index === 0;
            upBtn.addEventListener("click", async () => {
                if (index === 0) return;
                move(index, index - 1);
                await save(true);
            });

            const downBtn = header.createEl("button", { text: "↓" });
            downBtn.disabled = index === calendars.length - 1;
            downBtn.addEventListener("click", async () => {
                if (index >= calendars.length - 1) return;
                move(index, index + 1);
                await save(true);
            });

            // Delete
            const delBtn = header.createEl("button", { text: "Delete" });
            delBtn.classList.add("mod-warning");
            delBtn.addEventListener("click", async () => {
                calendars.splice(index, 1);
                await save(true);
            });

            // Fields
            new Setting(card)
                .setName("iCal URL")
                .addText(text => text
                    .setPlaceholder("https://...")
                    .setValue(calendar.url)
                    .onChange(async (val) => {
                        calendar.url = val.trim();
                        await save();
                    }));

            new Setting(card)
                .setName("Color")
                .addColorPicker(picker => picker
                    .setValue(calendar.color || "#3b82f6")
                    .onChange(async (val) => {
                        calendar.color = val;
                        await save();
                    }));

            const acContent = card.createDiv();
            acContent.style.marginTop = "8px";
            acContent.style.border = "1px solid var(--background-modifier-border)";
            acContent.style.padding = "8px";
            acContent.style.borderRadius = "4px";
            acContent.createEl("h5", { text: "Auto-Create Settings" });

            new Setting(acContent)
                .setName("Enable Auto-Create")
                .addToggle(t => t
                    .setValue(calendar.autoCreateEnabled !== false)
                    .onChange(async (val) => {
                        calendar.autoCreateEnabled = val;
                        await save();
                    }));

            new Setting(acContent)
                .setName("Type Folder")
                .setDesc("High-level folder categorization (optional).")
                .addText(t => t
                    .setValue(calendar.autoCreateTypeFolder || "")
                    .setPlaceholder("Meetings/External")
                    .onChange(async (val) => {
                        calendar.autoCreateTypeFolder = val;
                        await save();
                    }));

            new Setting(acContent)
                .setName("Folder")
                .setDesc("Where to create notes (e.g. 01 Action Items/Meetings)")
                .addText(t => t
                    .setValue(calendar.autoCreateFolder || "")
                    .setPlaceholder("Folder/Path")
                    .onChange(async (val) => {
                        calendar.autoCreateFolder = val;
                        await save();
                    }));

            new Setting(acContent)
                .setName("Tag")
                .setDesc("Tag to append (e.g. #meeting)")
                .addText(t => t
                    .setValue(calendar.autoCreateTag || "")
                    .setPlaceholder("#tag")
                    .onChange(async (val) => {
                        calendar.autoCreateTag = val;
                        await save();
                    }));

            new Setting(acContent)
                .setName("Template")
                .setDesc("Path to template file")
                .addText(t => t
                    .setValue(calendar.autoCreateTemplate || "")
                    .setPlaceholder("Templates/Meeting.md")
                    .onChange(async (val) => {
                        calendar.autoCreateTemplate = val;
                        await save();
                    }));
        });
    }

    renderSnoozeOptions(container: HTMLElement): void {
        container.empty();
        const options = this.plugin.settings.snoozeOptions || [];
        options.forEach((opt, index) => {
            new Setting(container)
                .setName(`Preset ${index + 1}`)
                .addText(text => text
                    .setPlaceholder('Label')
                    .setValue(opt.label)
                    .onChange(async (value) => {
                        opt.label = value;
                        await this.plugin.saveSettings();
                    }))
                .addText(text => text
                    .setPlaceholder('Minutes')
                    .setValue(String(opt.minutes))
                    .onChange(async (value) => {
                        const num = parseInt(value);
                        if (!isNaN(num) && num > 0) {
                            opt.minutes = num;
                            await this.plugin.saveSettings();
                        }
                    }))
                .addExtraButton(btn =>
                    btn.setIcon('trash').setTooltip('Remove').onClick(async () => {
                        options.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.renderSnoozeOptions(container);
                    }));
        });
    }
}
