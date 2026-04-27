import { App, Notice, PluginSettingTab, Setting, debounce } from 'obsidian';
import type TPSControllerPlugin from './main';
import type { PropertyReminder, ExternalCalendarConfig } from './types';
import { normalizeCalendarUrl } from './utils';
import { renderListWithControls } from './utils/list-renderer';
import { createTPSCollapsibleSection } from './utils/settings-layout';

const createCalendarId = () => `calendar-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
const createSettingsGroup = (parent: HTMLElement, title: string, description?: string): HTMLElement => {
    const group = parent.createDiv({ cls: 'tps-settings-flat-group' });
    group.style.marginBottom = '18px';
    group.style.padding = '14px 16px';
    group.style.border = '1px solid var(--background-modifier-border)';
    group.style.borderRadius = '12px';
    group.style.background = 'var(--background-secondary)';
    group.createEl('h3', { text: title });
    if (description) {
        group.createEl('p', { text: description, cls: 'setting-item-description' });
    }
    return group;
};

export class TPSControllerSettingTab extends PluginSettingTab {
    plugin: TPSControllerPlugin;
    private settingsViewState = new Map<string, boolean>();
    private reminderRuleViewState = new Map<string, boolean>();
    private reminderRuleFilterQuery = '';
    private settingsScrollTop = 0;
    private hasRenderedSettings = false;

    constructor(app: App, plugin: TPSControllerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        this.captureSettingsViewState(containerEl);
        containerEl.empty();

        const debouncedSave = debounce(() => this.plugin.saveSettings(), 300);

        containerEl.createEl('h2', { text: 'TPS Controller' });

        const calendarsGroup = createSettingsGroup(containerEl, 'Calendars', 'Device role, external calendar sources, and sync behavior.');
        const remindersGroup = createSettingsGroup(containerEl, 'Reminders', 'Reminder evaluation, rules, snooze, and notification delivery.');
        const advancedGroup = createSettingsGroup(containerEl, 'Advanced', 'Companion automation, diagnostics, and recovery.');

        this.renderDeviceRole(calendarsGroup);
        this.renderExternalCalendarsSection(calendarsGroup);
        this.renderCalendarSyncSettings(calendarsGroup, debouncedSave);
        this.renderFrontmatterKeysSection(calendarsGroup, debouncedSave);
        this.renderReminderSection(remindersGroup, debouncedSave);
        this.renderAdvancedSection(advancedGroup, debouncedSave);
        this.renderEditorDropSection(advancedGroup, debouncedSave);

        this.restoreSettingsViewState(containerEl);
    }

    private renderDeviceRole(parent: HTMLElement): void {
        const section = createTPSCollapsibleSection(
            parent,
            'Device Role',
            'Choose whether this device runs suite-level automation or stays in normal user mode.',
            false
        );

        const roleDesc = section.createDiv({ cls: 'tps-controller-role-desc' });
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

        new Setting(section)
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
    }

    private renderExternalCalendarsSection(parent: HTMLElement): void {
        const section = createTPSCollapsibleSection(
            parent,
            'External Calendars',
            'Calendar sources and auto-create destinations.',
            false
        );
        const calendarsContainer = section.createDiv();
        this.renderExternalCalendars(calendarsContainer);

        new Setting(section)
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
                        autoCreateMode: "note",
                        autoCreateTypeFolder: "",
                        autoCreateFolder: "",
                        autoCreateTag: "",
                        autoCreateTemplate: "",
                        autoCreateTaskListPath: "",
                        autoCreateTaskListHeading: "",
                    });
                    await this.plugin.saveSettings();
                    this.renderExternalCalendars(calendarsContainer);
                }));
    }

    private renderCalendarSyncSettings(parent: HTMLElement, debouncedSave: ReturnType<typeof debounce>): void {
        const section = createTPSCollapsibleSection(
            parent,
            'Sync Settings',
            'Global sync behavior for external calendars.',
            false
        );

        new Setting(section)
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

        new Setting(section)
            .setName('Archive After Grace Cycles')
            .setDesc('Number of consecutive syncs an event must be missing or canceled before the note is archived. Set to 0 to disable automatic archival.')
            .addSlider(slider => slider
                .setLimits(0, 20, 1)
                .setValue(this.plugin.settings.orphanArchiveGraceCycles ?? 5)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.orphanArchiveGraceCycles = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(section)
            .setName('Archive Folder')
            .setDesc('Folder to move archived event notes to.')
            .addText(text => text
                .setPlaceholder('Archive')
                .setValue(this.plugin.settings.archiveFolder)
                .onChange((value) => {
                    this.plugin.settings.archiveFolder = value;
                    void debouncedSave();
                }));

        new Setting(section)
            .setName('Archive Note')
            .setDesc('Markdown note used as the archive index for synced event notes. Created automatically if missing.')
            .addText(text => text
                .setPlaceholder('Archive/Archive.md')
                .setValue(this.plugin.settings.archiveNotePath || '')
                .onChange((value) => {
                    this.plugin.settings.archiveNotePath = value.trim();
                    void debouncedSave();
                }));

        new Setting(section)
            .setName('Calendar Filter')
            .setDesc('Regex or keyword to filter out external events (e.g. "Canceled").')
            .addText(text => text
                .setPlaceholder('Canceled')
                .setValue(this.plugin.settings.externalCalendarFilter)
                .onChange((value) => {
                    this.plugin.settings.externalCalendarFilter = value;
                    void debouncedSave();
                }));

        new Setting(section)
            .setName('Backfill Days')
            .setDesc('How many days into the past to look for uncreated events. 0 = current and future only.')
            .addSlider(slider => slider
                .setLimits(0, 365, 1)
                .setValue(this.plugin.settings.syncBackfillDays ?? 0)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.syncBackfillDays = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(section)
            .setName('Canceled Status Value')
            .setDesc('The status value to set when an event is canceled.')
            .addText(text => text
                .setPlaceholder('cancelled')
                .setValue(this.plugin.settings.canceledStatusValue)
                .onChange((value) => {
                    this.plugin.settings.canceledStatusValue = value;
                    void debouncedSave();
                }));

        new Setting(section)
            .setName('Sync Now')
            .addButton(btn => btn
                .setButtonText('Sync Now')
                .setCta()
                .onClick(async () => {
                    btn.setButtonText('Syncing…');
                    btn.setDisabled(true);
                    try {
                        await this.plugin.calendarAutomation.runSync(true);
                        new Notice('Calendar sync complete.');
                    } catch (e) {
                        new Notice('Sync failed: ' + (e as Error).message);
                    }
                    btn.setButtonText('Sync Now');
                    btn.setDisabled(false);
                }));
    }

    private renderEditorDropSection(parent: HTMLElement, debouncedSave: ReturnType<typeof debounce>): void {
        const section = createTPSCollapsibleSection(
            parent,
            'Editor Drag And Drop',
            'Configure what happens when task cards are dropped onto markdown notes.',
            false
        );

        new Setting(section)
            .setName('Enable linked section drop')
            .setDesc('When enabled, dragging a calendar or kanban card into a markdown editor inserts a linked heading instead of plain text/file drop behavior.')
            .addToggle(toggle => toggle
                .setValue(!!this.plugin.settings.editorDropLinkEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.editorDropLinkEnabled = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(section)
            .setName('Heading level')
            .setDesc('Used for the {{heading}} token in the template.')
            .addDropdown(drop => drop
                .addOption('1', 'H1')
                .addOption('2', 'H2')
                .addOption('3', 'H3')
                .addOption('4', 'H4')
                .addOption('5', 'H5')
                .addOption('6', 'H6')
                .setValue(String(this.plugin.settings.editorDropLinkHeadingLevel ?? 2))
                .onChange((value) => {
                    this.plugin.settings.editorDropLinkHeadingLevel = Number(value) || 2;
                    void debouncedSave();
                }));

        new Setting(section)
            .setName('Inserted line template')
            .setDesc('Available tokens: {{heading}}, {{wikilink}}, {{link}}, {{title}}')
            .addText(text => text
                .setPlaceholder('{{heading}} {{wikilink}}')
                .setValue(this.plugin.settings.editorDropLinkTemplate || '{{heading}} {{wikilink}}')
                .onChange((value) => {
                    this.plugin.settings.editorDropLinkTemplate = value.trim() || '{{heading}} {{wikilink}}';
                    void debouncedSave();
                }));
    }

    private renderFrontmatterKeysSection(parent: HTMLElement, debouncedSave: ReturnType<typeof debounce>): void {
        const section = createTPSCollapsibleSection(
            parent,
            'Frontmatter Keys',
            'Shared calendar field names. Only change these if you use custom property names.',
            false
        );

        const fmKeys: { key: keyof typeof this.plugin.settings; label: string; placeholder: string }[] = [
            { key: 'eventIdKey', label: 'Event ID Key', placeholder: 'externalEventId' },
            { key: 'uidKey', label: 'UID Key', placeholder: 'tpsCalendarUid' },
            { key: 'titleKey', label: 'Title Key', placeholder: 'title' },
            { key: 'statusKey', label: 'Status Key', placeholder: 'status' },
            { key: 'previousStatusKey', label: 'Previous Status Key', placeholder: 'tpsCalendarPrevStatus' },
            { key: 'scheduledDateProperty', label: 'Scheduled Date Key', placeholder: 'scheduledDate' },
            { key: 'scheduledStartProperty', label: 'Scheduled Start Key', placeholder: 'scheduledStart' },
            { key: 'scheduledEndProperty', label: 'Scheduled End Key', placeholder: 'scheduledEnd' },
            { key: 'startProperty', label: 'Start Property', placeholder: 'scheduled' },
            { key: 'endProperty', label: 'Duration Property', placeholder: 'timeEstimate' },
        ];

        for (const fk of fmKeys) {
            new Setting(section)
                .setName(fk.label)
                .addText(text => text
                    .setPlaceholder(fk.placeholder)
                    .setValue(String((this.plugin.settings as any)[fk.key] || ''))
                    .onChange(async (value) => {
                        (this.plugin.settings as any)[fk.key] = value;
                        await this.plugin.saveSettings();
                    }));
        }
    }

    private renderReminderSection(parent: HTMLElement, debouncedSave: ReturnType<typeof debounce>): void {
        const section = createTPSCollapsibleSection(
            parent,
            'Reminder Engine',
            'Polling, rules, and notification delivery.',
            false
        );

        new Setting(section)
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
            section.createEl('p', {
                text: 'Reminders are disabled. Enable the master toggle to show reminder configuration.',
                cls: 'setting-item-description'
            });
            return;
        }

        new Setting(section)
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

        new Setting(section)
            .setName('Batch Notifications')
            .setDesc('Send one combined notification for multiple triggers.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.batchNotifications)
                .onChange(async (value) => {
                    this.plugin.settings.batchNotifications = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(section)
            .setName('Notification Presentation')
            .setDesc('Choose whether notifications open in the sidebar or as a popup modal.')
            .addDropdown(drop => drop
                .addOption('sidebar', 'Sidebar')
                .addOption('modal', 'Popup modal')
                .setValue(this.plugin.settings.notificationPresentationMode || 'sidebar')
                .onChange(async (value) => {
                    this.plugin.settings.notificationPresentationMode = value as 'sidebar' | 'modal';
                    await this.plugin.saveSettings();
                }));

        new Setting(section)
            .setName('Default All-Day Base Time')
            .setDesc('Time of day (HH:MM) used as the trigger base for all-day events when no per-rule override is set.')
            .addText(text => text
                .setPlaceholder('09:00')
                .setValue(this.plugin.settings.defaultAllDayBaseTime || '09:00')
                .onChange(async (value) => {
                    this.plugin.settings.defaultAllDayBaseTime = value.trim();
                    await this.plugin.saveSettings();
                }));

        const ignoreSection = createTPSCollapsibleSection(
            section,
            'Global Ignore Lists',
            'Shared filters applied before individual reminder rules.',
            false
        );

        new Setting(ignoreSection)
            .setName('Ignore Paths')
            .setDesc('Comma-separated. Supports glob wildcards (*/Templates/*) and regex (re:^System/).')
            .addText(text => text
                .setPlaceholder('System, Notes')
                .setValue((this.plugin.settings.globalIgnorePaths || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.globalIgnorePaths = value.split(',').map(s => s.trim()).filter(Boolean);
                    await this.plugin.saveSettings();
                }));

        new Setting(ignoreSection)
            .setName('Ignore Tags')
            .setDesc('Comma-separated tags to ignore.')
            .addText(text => text
                .setPlaceholder('archive, template')
                .setValue((this.plugin.settings.globalIgnoreTags || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.globalIgnoreTags = value.split(',').map(s => s.trim()).filter(Boolean);
                    await this.plugin.saveSettings();
                }));

        new Setting(ignoreSection)
            .setName('Ignore Statuses')
            .setDesc('Comma-separated status values to ignore.')
            .addText(text => text
                .setPlaceholder('complete, wont-do')
                .setValue((this.plugin.settings.globalIgnoreStatuses || []).join(', '))
                .onChange(async (value) => {
                    this.plugin.settings.globalIgnoreStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                    await this.plugin.saveSettings();
                }));

        const kanbanSection = createTPSCollapsibleSection(
            section,
            'Kanban Task Reminders',
            'How checkbox cards in Kanban board notes are interpreted for reminders.',
            false
        );

        this.renderKanbanTaskSettings(kanbanSection);

        const snoozeSection = createTPSCollapsibleSection(
            section,
            'Snooze',
            'Snooze property and quick-action presets.',
            false
        );

        new Setting(snoozeSection)
            .setName('Snooze Property')
            .setDesc('Frontmatter property name for snooze time.')
            .addText(text => text
                .setPlaceholder('reminderSnooze')
                .setValue(this.plugin.settings.snoozeProperty || 'reminderSnooze')
                .onChange((value) => {
                    this.plugin.settings.snoozeProperty = value.trim() || 'reminderSnooze';
                    void debouncedSave();
                }));

        const snoozePresetsEl = createTPSCollapsibleSection(
            snoozeSection,
            'Presets',
            'Quick snooze durations shown in the reminder UI.',
            false
        );
        this.renderSnoozeOptions(snoozePresetsEl);
        new Setting(snoozePresetsEl)
            .addButton((btn) =>
                btn.setButtonText('Add Preset').setCta().onClick(async () => {
                    if (!Array.isArray(this.plugin.settings.snoozeOptions)) this.plugin.settings.snoozeOptions = [];
                    this.plugin.settings.snoozeOptions.push({ label: '15 Minutes', minutes: 15 });
                    await this.plugin.saveSettings();
                    this.renderSnoozeOptions(snoozePresetsEl);
                }));

        const rulesContainer = section.createDiv({ cls: 'tps-controller-reminder-rules' });
        this.renderReminderRules(rulesContainer);

        new Setting(section)
            .addButton(btn => btn
                .setButtonText('Add Reminder Rule')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.reminders.push(this.createDefaultReminder());
                    await this.plugin.saveSettings();
                    this.renderReminderRules(rulesContainer);
                }))
            .addButton(btn => btn
                .setButtonText('Check Now')
                .onClick(async () => {
                    btn.setButtonText('Checking…');
                    btn.setDisabled(true);
                    try {
                        await this.plugin.runReminderCheck();
                        new Notice('Reminder check complete.');
                    } catch (e) {
                        new Notice('Reminder check failed.');
                    }
                    btn.setButtonText('Check Now');
                    btn.setDisabled(false);
                }));
    }

    private renderKanbanTaskSettings(parent: HTMLElement): void {
        const kr = this.plugin.settings.kanbanTaskReminders;

        new Setting(parent)
            .setName('Enable Task Item Targets')
            .setDesc('Evaluate individual checkbox items inside Kanban boards and task-list files as independent reminder targets.')
            .addToggle(toggle => toggle
                .setValue(!!kr.enabled)
                .onChange(async (value) => {
                    kr.enabled = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(parent)
            .setName('Include Board File Target')
            .setDesc('Also evaluate the Kanban board note frontmatter itself as a reminder target.')
            .addToggle(toggle => toggle
                .setValue(!!kr.includeBoardFileTarget)
                .onChange(async (value) => {
                    kr.includeBoardFileTarget = value;
                    await this.plugin.saveSettings();
                }));

        const parseSection = createTPSCollapsibleSection(parent, 'Parsing', 'Date and property sources for Kanban cards.', false);

        new Setting(parseSection)
            .setName('Inline Properties')
            .setDesc('Read card-level inline properties (e.g. [scheduled:: 2026-03-13 09:00]).')
            .addToggle(toggle => toggle
                .setValue(!!kr.parseInlineProperties)
                .onChange(async (value) => {
                    kr.parseInlineProperties = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(parseSection)
            .setName('Kanban Date Tokens')
            .setDesc('Read Kanban scheduling tokens (@{date} and @@{time}) as reminder trigger dates.')
            .addToggle(toggle => toggle
                .setValue(!!kr.parseKanbanDateTokens)
                .onChange(async (value) => {
                    kr.parseKanbanDateTokens = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(parseSection)
            .setName('Tasks Emoji Dates')
            .setDesc('Read Tasks-style emoji dates on cards (📅 due, ⏳ scheduled, 🛫 start).')
            .addToggle(toggle => toggle
                .setValue(!!kr.parseTasksEmojiDates)
                .onChange(async (value) => {
                    kr.parseTasksEmojiDates = value;
                    await this.plugin.saveSettings();
                }));

        const aliasesSection = createTPSCollapsibleSection(parent, 'Property Aliases', 'Custom property name mappings.', false);
        const parseCsv = (value: string): string[] =>
            value.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

        new Setting(aliasesSection)
            .setName('Scheduled Aliases')
            .setDesc('Comma-separated property names for scheduled time.')
            .addText(text => text
                .setPlaceholder('scheduled, start')
                .setValue((kr.scheduledPropertyAliases || []).join(', '))
                .onChange(async (value) => {
                    kr.scheduledPropertyAliases = parseCsv(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(aliasesSection)
            .setName('Due Aliases')
            .setDesc('Comma-separated property names for due date.')
            .addText(text => text
                .setPlaceholder('due, duedate')
                .setValue((kr.duePropertyAliases || []).join(', '))
                .onChange(async (value) => {
                    kr.duePropertyAliases = parseCsv(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(aliasesSection)
            .setName('Start Aliases')
            .setDesc('Comma-separated property names for start date.')
            .addText(text => text
                .setPlaceholder('start, startdate')
                .setValue((kr.startPropertyAliases || []).join(', '))
                .onChange(async (value) => {
                    kr.startPropertyAliases = parseCsv(value);
                    await this.plugin.saveSettings();
                }));

        const statusSection = createTPSCollapsibleSection(parent, 'Status Values', 'Status property and completion mappings.', false);

        new Setting(statusSection)
            .setName('Status Property')
            .setDesc('Inline property key used for task status writes.')
            .addText(text => text
                .setPlaceholder('status')
                .setValue(kr.statusProperty || 'status')
                .onChange(async (value) => {
                    kr.statusProperty = value.trim() || 'status';
                    await this.plugin.saveSettings();
                }));

        new Setting(statusSection)
            .setName('Complete Status')
            .setDesc('Status value written when marking a Kanban task complete.')
            .addText(text => text
                .setPlaceholder('complete')
                .setValue(kr.completeStatusValue || 'complete')
                .onChange(async (value) => {
                    kr.completeStatusValue = value.trim() || 'complete';
                    await this.plugin.saveSettings();
                }));

        new Setting(statusSection)
            .setName("Won't-Do Status")
            .setDesc("Status value written when marking a Kanban task won't-do.")
            .addText(text => text
                .setPlaceholder('wont-do')
                .setValue(kr.wontDoStatusValue || 'wont-do')
                .onChange(async (value) => {
                    kr.wontDoStatusValue = value.trim() || 'wont-do';
                    await this.plugin.saveSettings();
                }));

    }

    private renderAdvancedSection(parent: HTMLElement, debouncedSave: ReturnType<typeof debounce>): void {
        const compSection = createTPSCollapsibleSection(
            parent,
            'Companion Automation',
            'Optional integration that lets Controller trigger companion scans.',
            false
        );

        new Setting(compSection)
            .setName('Enable Controller Companion Scans')
            .setDesc('When enabled, the Controller syncs companion styling across ALL vault files every 5 minutes.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.companionStartupScanEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.companionStartupScanEnabled = value;
                    await this.plugin.saveSettings();
                    this.display();
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

        const debugSection = createTPSCollapsibleSection(
            parent,
            'Debug & Recovery',
            'Troubleshooting controls and state management.',
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

    private captureSettingsViewState(containerEl: HTMLElement): void {
        this.settingsScrollTop = containerEl.scrollTop;
        this.settingsViewState.clear();
        const detailsEls = Array.from(containerEl.querySelectorAll('details'));
        detailsEls.forEach((detailsEl, index) => {
            const details = detailsEl as HTMLDetailsElement;
            const summaryText = details.querySelector('summary')?.textContent?.trim() || '';
            const key = `${index}:${summaryText}`;
            this.settingsViewState.set(key, details.open);
        });
    }

    private restoreSettingsViewState(containerEl: HTMLElement): void {
        const detailsEls = Array.from(containerEl.querySelectorAll('details'));
        if (!this.hasRenderedSettings) {
            detailsEls.forEach((detailsEl) => {
                const details = detailsEl as HTMLDetailsElement;
                details.removeAttribute('open');
            });
            this.hasRenderedSettings = true;
            containerEl.scrollTop = 0;
            return;
        }
        detailsEls.forEach((detailsEl, index) => {
            const details = detailsEl as HTMLDetailsElement;
            const summaryText = details.querySelector('summary')?.textContent?.trim() || '';
            const key = `${index}:${summaryText}`;
            const isOpen = this.settingsViewState.get(key);
            if (isOpen) details.setAttr('open', 'true');
            else details.removeAttribute('open');
        });
        containerEl.scrollTop = this.settingsScrollTop;
    }

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
            includeUnmatchedExternalEvents: false,
        };
    }

    private renderReminderRules(container: HTMLElement): void {
        const existingRuleDetails = Array.from(
            container.querySelectorAll('details.tps-controller-reminder-rule')
        ) as HTMLDetailsElement[];
        existingRuleDetails.forEach((detailsEl) => {
            const ruleId = detailsEl.dataset.ruleId;
            if (ruleId) {
                this.reminderRuleViewState.set(ruleId, detailsEl.open);
            }
        });

        container.empty();
        const reminders = this.plugin.settings.reminders || [];

        if (reminders.length === 0) {
            const empty = container.createDiv({ cls: 'tps-empty-state' });
            empty.textContent = 'No reminder rules configured.';
            return;
        }

        const reminderToolbar = container.createDiv({ cls: 'tps-reminder-rules-toolbar' });
        const filterInput = reminderToolbar.createEl('input', {
            cls: 'tps-reminder-rules-filter',
            type: 'text',
            placeholder: 'Filter rules by label, property, folder, or status'
        });
        filterInput.value = this.reminderRuleFilterQuery;
        filterInput.addEventListener('input', () => {
            this.reminderRuleFilterQuery = filterInput.value;
            this.renderReminderRules(container);
        });

        const toolbarActions = reminderToolbar.createDiv({ cls: 'tps-reminder-rules-toolbar-actions' });
        const expandAllBtn = toolbarActions.createEl('button', { text: 'Expand All' });
        expandAllBtn.addEventListener('click', () => {
            reminders.forEach((rem, index) => {
                const ruleId = rem.id || `rule-${index}`;
                this.reminderRuleViewState.set(ruleId, true);
            });
            this.renderReminderRules(container);
        });

        const collapseAllBtn = toolbarActions.createEl('button', { text: 'Collapse All' });
        collapseAllBtn.addEventListener('click', () => {
            reminders.forEach((rem, index) => {
                const ruleId = rem.id || `rule-${index}`;
                this.reminderRuleViewState.set(ruleId, false);
            });
            this.renderReminderRules(container);
        });

        const normalizedQuery = this.reminderRuleFilterQuery.trim().toLowerCase();
        const visibleRules = reminders
            .map((rem, index) => ({ rem, index }))
            .filter(({ rem, index }) => {
                if (!normalizedQuery) return true;
                const searchBlob = [
                    rem.label,
                    rem.property,
                    (rem.requiredStatuses || []).join(' '),
                    (rem.requiredPaths || []).join(' '),
                    (rem.ignoreStatuses || []).join(' '),
                    (rem.ignoreTags || []).join(' '),
                    (rem.stopConditions || []).join(' '),
                    `rule ${index + 1}`
                ]
                    .join(' ')
                    .toLowerCase();
                return searchBlob.includes(normalizedQuery);
            });

        if (visibleRules.length === 0) {
            const emptyFiltered = container.createDiv({ cls: 'tps-empty-state' });
            emptyFiltered.textContent = 'No reminder rules match the current filter.';
            return;
        }

        visibleRules.forEach(({ rem, index }) => {
            const ruleId = rem.id || `rule-${index}`;
            const ruleEl = container.createEl('details', { cls: 'tps-controller-reminder-rule' });
            ruleEl.dataset.ruleId = ruleId;

            if (this.reminderRuleViewState.get(ruleId)) {
                ruleEl.setAttr('open', 'true');
            }
            ruleEl.addEventListener('toggle', () => {
                this.reminderRuleViewState.set(ruleId, ruleEl.open);
            });

            const ruleHeader = ruleEl.createEl('summary', { cls: 'tps-rule-summary-row' });
            const ruleSummaryMain = ruleHeader.createDiv({ cls: 'tps-rule-summary-main' });
            const labelSpan = ruleSummaryMain.createSpan({ cls: 'tps-rule-label' });
            labelSpan.textContent = `${rem.enabled ? '🟢' : '⚫'} ${rem.label || `Rule ${index + 1}`}`;
            const descSpan = ruleSummaryMain.createSpan({ cls: 'tps-rule-desc' });
            descSpan.textContent = this.buildRuleDesc(rem);

            const summaryActions = ruleHeader.createDiv({ cls: 'tps-rule-summary-actions' });
            const createHeaderAction = (label: string, tooltip: string, action: () => Promise<void>) => {
                const btn = summaryActions.createEl('button', { cls: 'tps-rule-summary-btn', text: label });
                btn.setAttr('aria-label', tooltip);
                btn.setAttr('title', tooltip);
                btn.addEventListener('click', async (evt) => {
                    evt.preventDefault();
                    evt.stopPropagation();
                    await action();
                });
            };

            createHeaderAction('↑', 'Move rule up', async () => {
                if (index === 0) return;
                [this.plugin.settings.reminders[index - 1], this.plugin.settings.reminders[index]] = [this.plugin.settings.reminders[index], this.plugin.settings.reminders[index - 1]];
                await this.plugin.saveSettings();
                this.renderReminderRules(container);
            });

            createHeaderAction('↓', 'Move rule down', async () => {
                if (index >= this.plugin.settings.reminders.length - 1) return;
                [this.plugin.settings.reminders[index + 1], this.plugin.settings.reminders[index]] = [this.plugin.settings.reminders[index], this.plugin.settings.reminders[index + 1]];
                await this.plugin.saveSettings();
                this.renderReminderRules(container);
            });

            createHeaderAction('⧉', 'Duplicate rule', async () => {
                const duplicated: PropertyReminder = {
                    ...rem,
                    id: `reminder-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
                    label: rem.label ? `${rem.label} Copy` : `Rule ${index + 1} Copy`,
                    stopConditions: [...(rem.stopConditions || [])],
                    ignorePaths: [...(rem.ignorePaths || [])],
                    ignoreTags: [...(rem.ignoreTags || [])],
                    ignoreStatuses: [...(rem.ignoreStatuses || [])],
                    requiredStatuses: [...(rem.requiredStatuses || [])],
                    requiredPaths: [...(rem.requiredPaths || [])],
                };
                this.plugin.settings.reminders.splice(index + 1, 0, duplicated);
                this.reminderRuleViewState.set(duplicated.id, true);
                await this.plugin.saveSettings();
                this.renderReminderRules(container);
            });

            createHeaderAction('×', 'Delete rule', async () => {
                this.plugin.settings.reminders.splice(index, 1);
                this.reminderRuleViewState.delete(ruleId);
                await this.plugin.saveSettings();
                this.renderReminderRules(container);
            });

            const ruleContent = ruleEl.createDiv({ cls: 'tps-rule-content' });

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
                .setDesc('Task fires once at trigger time. Timeblock skips firing once end time has passed.')
                .addDropdown(drop => drop
                    .addOption('task', 'Task')
                    .addOption('timeblock', 'Timeblock')
                    .setValue(rem.mode || 'task')
                    .onChange(async (value) => {
                        rem.mode = value as 'task' | 'timeblock';
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent)
                .setName('Include unmatched external events')
                .setDesc('Also evaluate external calendar events that do not have a synced local note.')
                .addToggle(toggle => toggle
                    .setValue(!!rem.includeUnmatchedExternalEvents)
                    .onChange(async (value) => {
                        rem.includeUnmatchedExternalEvents = value;
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(ruleContent)
                .setName('Trigger at End')
                .setDesc('Use the event end time as the trigger base instead of the start time.')
                .addToggle(toggle => toggle
                    .setValue(!!rem.triggerAtEnd)
                    .onChange(async (value) => {
                        rem.triggerAtEnd = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent)
                .setName('Fixed Offset (minutes)')
                .setDesc('Negative = before, positive = after. Fallback when Duration Offset is enabled but property is missing.')
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

            const durationOffsetWrapper = ruleContent.createDiv();
            durationOffsetWrapper.style.display = rem.useSmartOffset ? '' : 'none';

            new Setting(ruleContent)
                .setName('Use Duration Offset')
                .setDesc('Replace fixed offset with a duration from a frontmatter property.')
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
                .addDropdown(drop => drop
                    .addOption('add', 'After (base + duration)')
                    .addOption('subtract', 'Before (base − duration)')
                    .setValue(rem.smartOffsetOperator || 'add')
                    .onChange(async (value) => {
                        rem.smartOffsetOperator = value as any;
                        await this.plugin.saveSettings();
                    }));

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
                .setDesc('Time of day (HH:MM) for all-day events. Leave blank to use global default.')
                .addText(text => text
                    .setPlaceholder('(uses global default)')
                    .setValue(rem.allDayBaseTime || '')
                    .onChange(async (value) => {
                        rem.allDayBaseTime = value.trim();
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent).setName('Filtering').setHeading();

            new Setting(ruleContent)
                .setName('Required Statuses')
                .setDesc('Comma-separated (e.g. scheduled, in-progress).')
                .addText(text => text
                    .setValue((rem.requiredStatuses || []).join(', '))
                    .onChange(async (value) => {
                        rem.requiredStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                        descSpan.textContent = this.buildRuleDesc(rem);
                    }));

            new Setting(ruleContent)
                .setName('Required Folders')
                .setDesc('Comma-separated folder prefixes. Empty = all folders.')
                .addText(text => text
                    .setPlaceholder('Action Items, Markdown/Projects')
                    .setValue((rem.requiredPaths || []).join(', '))
                    .onChange(async (value) => {
                        rem.requiredPaths = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent)
                .setName('Ignore Paths')
                .setDesc('Supports wildcards (*/Trash/*) and regex (re:^System/).')
                .addText(text => text
                    .setValue((rem.ignorePaths || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignorePaths = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent)
                .setName('Ignore Tags')
                .addText(text => text
                    .setValue((rem.ignoreTags || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignoreTags = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent)
                .setName('Ignore Statuses')
                .addText(text => text
                    .setValue((rem.ignoreStatuses || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignoreStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            new Setting(ruleContent).setName('Repeat & Stop').setHeading();

            const repeatWrapper = ruleContent.createDiv();
            repeatWrapper.style.display = rem.repeatUntilComplete ? '' : 'none';

            new Setting(ruleContent)
                .setName('Repeat Until Complete')
                .setDesc('Re-send on an interval until a stop condition is met.')
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
                .setDesc('−1 = unlimited.')
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
                .setDesc('Format: "property: value". Comma-separated.')
                .addText(text => text
                    .setValue((rem.stopConditions || []).join(', '))
                    .onChange(async (value) => {
                        rem.stopConditions = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

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
        if (rem.includeUnmatchedExternalEvents) parts.push('external gaps');
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

            const delBtn = header.createEl("button", { text: "Delete" });
            delBtn.classList.add("mod-warning");
            delBtn.addEventListener("click", async () => {
                calendars.splice(index, 1);
                await save(true);
            });

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
                .setName("Sync Mode")
                .setDesc("Create one note per event, or store events as checklist items in a shared task file.")
                .addDropdown(drop => drop
                    .addOption("note", "Note per event")
                    .addOption("task-list", "Task list")
                    .setValue(calendar.autoCreateMode || "note")
                    .onChange(async (val: "note" | "task-list") => {
                        calendar.autoCreateMode = val;
                        await save(true);
                    }));

            if ((calendar.autoCreateMode || "note") === "task-list") {
                const initialTaskListPath = calendar.autoCreateTaskListPath || "";
                new Setting(acContent)
                    .setName("Task List File")
                    .setDesc("Markdown file that should receive one checklist item per imported event.")
                    .addText(t => t
                        .setValue(initialTaskListPath)
                        .setPlaceholder("Calendar/Work Events.md")
                        .onChange(async (val) => {
                            const nextPath = val.trim();
                            const oldPath = calendar.autoCreateTaskListPath || "";
                            if (nextPath === oldPath) {
                                calendar.autoCreateTaskListPath = nextPath;
                                await save();
                                return;
                            }

                            const existingCount = await this.plugin.countTaskListEntriesForCalendar(oldPath, calendar.url);
                            if (existingCount > 0) {
                                const shouldMove = confirm(
                                    'This calendar has existing synced events. Click OK to move them to the new location. Click Cancel to change the location back.'
                                );
                                if (!shouldMove) {
                                    calendar.autoCreateTaskListPath = oldPath;
                                    t.setValue(oldPath);
                                    await save();
                                    return;
                                }

                                calendar.autoCreateTaskListPath = nextPath;
                                await save();
                                const moved = await this.plugin.migrateTaskListCalendarPath(calendar.url, oldPath, nextPath);
                                new Notice(`Moved ${moved} synced item${moved === 1 ? '' : 's'} to ${nextPath || 'the new location'}.`);
                                return;
                            }

                            calendar.autoCreateTaskListPath = nextPath;
                            await save();
                        }));

                new Setting(acContent)
                    .setName("Section Heading")
                    .setDesc("Optional heading to place imported events under.")
                    .addText(t => t
                        .setValue(calendar.autoCreateTaskListHeading || "")
                        .setPlaceholder("Work Calendar")
                        .onChange(async (val) => {
                            calendar.autoCreateTaskListHeading = val.trim();
                            await save();
                        }));
            } else {
                new Setting(acContent)
                    .setName("Type Folder")
                    .setDesc("Legacy fallback. Used only when Folder is blank.")
                    .addText(t => t
                        .setValue(calendar.autoCreateTypeFolder || "")
                        .setPlaceholder("Meetings/External")
                        .onChange(async (val) => {
                            calendar.autoCreateTypeFolder = val;
                            await save();
                        }));

                new Setting(acContent)
                    .setName("Folder")
                    .setDesc("Authoritative note destination.")
                    .addText(t => t
                        .setValue(calendar.autoCreateFolder || "")
                        .setPlaceholder("Folder/Path")
                        .onChange(async (val) => {
                            calendar.autoCreateFolder = val;
                            await save();
                        }));

                new Setting(acContent)
                    .setName("Tag")
                    .addText(t => t
                        .setValue(calendar.autoCreateTag || "")
                        .setPlaceholder("#tag")
                        .onChange(async (val) => {
                            calendar.autoCreateTag = val;
                            await save();
                        }));

                new Setting(acContent)
                    .setName("Template")
                    .setDesc("Path to template file.")
                    .addText(t => t
                        .setValue(calendar.autoCreateTemplate || "")
                        .setPlaceholder("Templates/Meeting.md")
                        .onChange(async (val) => {
                            calendar.autoCreateTemplate = val;
                            await save();
                        }));
            }
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
