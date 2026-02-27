import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type TPSNotifier from './main';
import type { PropertyReminder } from './types';

const LOCAL_STORAGE_ROLE_KEY = 'tps-notifier-device-role';

export class TPSNotifierSettingTab extends PluginSettingTab {
    plugin: TPSNotifier;

    constructor(app: App, plugin: TPSNotifier) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'TPS Notifier Settings' });

        const createSection = (title: string, open = false) => {
            const details = containerEl.createEl('details', { cls: 'tps-notifier-settings-group' });
            details.style.border = '1px solid var(--background-modifier-border)';
            details.style.borderRadius = '6px';
            details.style.padding = '10px';
            details.style.marginBottom = '10px';
            if (open) details.setAttr('open', '');

            const summary = details.createEl('summary', { text: title });
            summary.style.fontWeight = 'bold';
            summary.style.cursor = 'pointer';
            summary.style.marginBottom = '10px';

            return details.createDiv({ cls: 'tps-notifier-settings-group-content' });
        };

        // --- Connection Settings ---
        const connection = createSection('Connection', true);

        new Setting(connection)
            .setName('ntfy Server')
            .setDesc('The ntfy server URL (e.g., https://ntfy.sh)')
            .addText(text => text
                .setPlaceholder('https://ntfy.sh')
                .setValue(this.plugin.settings.ntfyServer)
                .onChange(async (value) => {
                    this.plugin.settings.ntfyServer = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(connection)
            .setName('ntfy Topic')
            .setDesc('Your unique topic name')
            .addText(text => text
                .setPlaceholder('my-reminders')
                .setValue(this.plugin.settings.ntfyTopic)
                .onChange(async (value) => {
                    this.plugin.settings.ntfyTopic = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(connection)
            .setName('Priority')
            .setDesc('Notification priority (1-5)')
            .addSlider(slider => slider
                .setLimits(1, 5, 1)
                .setValue(this.plugin.settings.ntfyPriority)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.ntfyPriority = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(connection)
            .setName('Device Role')
            .setDesc('Controller sends notifications, Receiver only receives. (Saved locally for this device)')
            .addDropdown(dropdown => dropdown
                .addOption('controller', 'Controller (sends notifications)')
                .addOption('receiver', 'Receiver (no sending)')
                .setValue(this.plugin.settings.deviceRole)
                .onChange(async (value: 'controller' | 'receiver') => {
                    this.plugin.settings.deviceRole = value;
                    window.localStorage.setItem(LOCAL_STORAGE_ROLE_KEY, value);
                    await this.plugin.saveSettings();
                    this.plugin.startLoop();
                }));

        new Setting(connection)
            .setName('Check Interval (minutes)')
            .setDesc('How often to check for reminders (set to 0.5 for 30 seconds)')
            .addText(text => text
                .setValue(String(this.plugin.settings.pollMinutes))
                .onChange(async (value) => {
                    const num = parseFloat(value);
                    if (!isNaN(num) && num > 0) {
                        this.plugin.settings.pollMinutes = num;
                        await this.plugin.saveSettings();
                        this.plugin.startLoop();
                    }
                }));

        new Setting(connection)
            .setName('Batch Overdue Notifications')
            .setDesc('Group multiple overdue items into a single notification summary to reduce spam.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.batchNotifications)
                .onChange(async (value) => {
                    this.plugin.settings.batchNotifications = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(connection)
            .setName('Snooze Property')
            .setDesc('Frontmatter property name for snooze time (e.g., reminderSnooze, snooze)')
            .addText(text => text
                .setPlaceholder('reminderSnooze')
                .setValue(this.plugin.settings.snoozeProperty || 'reminderSnooze')
                .onChange(async (value) => {
                    this.plugin.settings.snoozeProperty = value.trim() || 'reminderSnooze';
                    await this.plugin.saveSettings();
                }));

        const snoozeDetails = connection.createEl('details');
        snoozeDetails.style.border = '1px solid var(--background-modifier-border)';
        snoozeDetails.style.borderRadius = '6px';
        snoozeDetails.style.padding = '8px 10px';
        snoozeDetails.style.marginBottom = '10px';
        const snoozeSummary = snoozeDetails.createEl('summary', { text: 'Snooze Presets' });
        snoozeSummary.style.fontWeight = '600';
        snoozeSummary.style.cursor = 'pointer';
        const snoozeContent = snoozeDetails.createDiv({ cls: 'tps-notifier-snooze-options' });
        snoozeContent.style.marginTop = '8px';
        this.renderSnoozeOptions(snoozeContent);
        new Setting(snoozeContent)
            .addButton((btn) =>
                btn.setButtonText('Add Preset').setCta().onClick(async () => {
                    if (!Array.isArray(this.plugin.settings.snoozeOptions)) this.plugin.settings.snoozeOptions = [];
                    this.plugin.settings.snoozeOptions.push({ label: '15 Minutes', minutes: 15 });
                    await this.plugin.saveSettings();
                    this.renderSnoozeOptions(snoozeContent);
                })
            );

        // --- Reminders ---
        const reminders = createSection('Reminders', true);

        for (const reminder of this.plugin.settings.reminders) {
            const buildFilterSummary = () => {
                const required = (reminder.requiredStatuses || []).filter(Boolean);
                const requiredDisplay = required.length > 0 ? required.join(', ') : '(none)';
                const effectiveIgnoreStatuses = (reminder.ignoreStatuses || this.plugin.settings.ignoreStatuses || []).filter(Boolean);
                const effectiveIgnoreDisplay = Array.from(new Set(effectiveIgnoreStatuses)).join(', ') || '(none)';
                return `Filters: required statuses = ${requiredDisplay} | excluded statuses = ${effectiveIgnoreDisplay}`;
            };

            const reminderDetails = reminders.createEl('details', { cls: 'reminder-settings' });
            reminderDetails.style.border = '1px solid var(--background-modifier-border)';
            reminderDetails.style.padding = '10px';
            reminderDetails.style.marginBottom = '10px';
            reminderDetails.style.borderRadius = '5px';

            const summary = reminderDetails.createEl('summary');
            summary.style.fontWeight = '600';
            summary.style.cursor = 'pointer';
            summary.style.outline = 'none';
            summary.style.display = 'flex';
            summary.style.justifyContent = 'space-between';
            summary.style.alignItems = 'center';

            const displayLabel = reminder.label?.trim() ? reminder.label.trim() : reminder.id;
            summary.createSpan({ text: `${displayLabel} (${reminder.enabled ? 'On' : 'Off'})` });

            const summaryMeta = summary.createSpan({ text: `Prop: ${reminder.property}` });
            summaryMeta.style.fontWeight = 'normal';
            summaryMeta.style.color = 'var(--text-muted)';
            summaryMeta.style.fontSize = '0.85em';
            summaryMeta.style.marginLeft = 'auto';
            summaryMeta.style.marginRight = '8px';

            const reminderDiv = reminderDetails.createDiv({ cls: 'reminder-settings-content' });
            reminderDiv.style.marginTop = '10px';
            reminderDiv.style.paddingTop = '10px';
            reminderDiv.style.borderTop = '1px solid var(--background-modifier-border)';

            const sectionTitle = (label: string) => {
                const el = reminderDiv.createEl('h4', { text: label });
                el.style.margin = '10px 0 6px';
                el.style.fontSize = '0.95em';
                el.style.color = 'var(--text-muted)';
                return el;
            };

            sectionTitle('Basics');
            new Setting(reminderDiv)
                .setName(reminder.label?.trim() ? reminder.label.trim() : reminder.id)
                .setDesc(`Property: ${reminder.property}`)
                .addToggle(toggle => toggle
                    .setValue(reminder.enabled)
                    .onChange(async (value) => {
                        reminder.enabled = value;
                        await this.plugin.saveSettings();
                    }))
                .addButton(btn => btn
                    .setIcon('copy')
                    .setTooltip('Duplicate Reminder')
                    .onClick(async () => {
                        const newReminder = JSON.parse(JSON.stringify(reminder));
                        let suffix = 1;
                        let newId = `${reminder.id}-copy`;
                        while (this.plugin.settings.reminders.some(r => r.id === newId)) {
                            newId = `${reminder.id}-copy-${suffix++}`;
                        }
                        newReminder.id = newId;

                        this.plugin.settings.reminders.push(newReminder);
                        await this.plugin.saveSettings();
                        this.display();
                    }))
                .addButton(btn => btn
                    .setIcon('trash')
                    .setTooltip('Delete Reminder')
                    .onClick(async () => {
                        if (!confirm(`Are you sure you want to delete reminder "${reminder.id}"?`)) return;
                        this.plugin.settings.reminders = this.plugin.settings.reminders.filter(r => r !== reminder);
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            new Setting(reminderDiv)
                .setName('Label')
                .setDesc('UI-only label to organize reminders')
                .addText(text => text
                    .setPlaceholder('e.g. Work, Personal, Morning')
                    .setValue(reminder.label || '')
                    .onChange(async (value) => {
                        reminder.label = value;
                        await this.plugin.saveSettings();
                        summary.setText(`${(reminder.label?.trim() || reminder.id)} (${reminder.enabled ? 'On' : 'Off'})`);
                    }));

            new Setting(reminderDiv)
                .setName('Property')
                .setDesc('Frontmatter field (e.g. "scheduled")')
                .addText(text => text
                    .setValue(reminder.property)
                    .setPlaceholder('scheduled')
                    .onChange(async (value) => {
                        const trimmed = value.trim();
                        if (trimmed) {
                            reminder.property = trimmed;
                            await this.plugin.saveSettings();
                        }
                    }));

            sectionTitle('All-Day');
            new Setting(reminderDiv)
                .setName('All-Day Filter')
                .setDesc('Filter "allDay: true" items')
                .addDropdown(dropdown => dropdown
                    .addOption('any', 'Any')
                    .addOption('true', 'All-Day Only')
                    .addOption('false', 'Timed Only')
                    .setValue(reminder.allDayFilter || 'any')
                    .onChange(async (value: any) => {
                        reminder.allDayFilter = value;
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            if (reminder.allDayFilter === 'true' || reminder.allDayFilter === 'any' || !reminder.allDayFilter) {
                new Setting(reminderDiv)
                    .setName('All-Day Base Time')
                    .setDesc('Trigger time for all-day events (HH:mm, 24h)')
                    .addText(text => text
                        .setPlaceholder('09:00')
                        .setValue(reminder.allDayBaseTime || '')
                        .onChange(async (value) => {
                            reminder.allDayBaseTime = value;
                            await this.plugin.saveSettings();
                        }));
            }

            sectionTitle('Timing');
            new Setting(reminderDiv)
                .setName('Use Smart Offset')
                .setDesc('Calculate offset dynamically (e.g. Due - Estimate)')
                .addToggle(toggle => toggle
                    .setValue(reminder.useSmartOffset || false)
                    .onChange(async (value) => {
                        reminder.useSmartOffset = value;
                        if (!reminder.smartOffsetOperator) reminder.smartOffsetOperator = 'subtract';
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            if (reminder.useSmartOffset) {
                new Setting(reminderDiv)
                    .setName('Smart Offset Property')
                    .setDesc('Duration property (e.g. "timeEstimate")')
                    .addText(text => text
                        .setValue(reminder.smartOffsetProperty || '')
                        .setPlaceholder('timeEstimate')
                        .onChange(async (value) => {
                            reminder.smartOffsetProperty = value.trim();
                            await this.plugin.saveSettings();
                        }));

                new Setting(reminderDiv)
                    .setName('Operator')
                    .addDropdown(dropdown => dropdown
                        .addOption('subtract', 'Subtract (Before)')
                        .addOption('add', 'Add (After)')
                        .setValue(reminder.smartOffsetOperator || 'subtract')
                        .onChange(async (value: any) => {
                            reminder.smartOffsetOperator = value;
                            await this.plugin.saveSettings();
                        }));
            } else {
                new Setting(reminderDiv)
                    .setName('Offset (minutes)')
                    .setDesc('e.g., -15 = 15 min before')
                    .addText(text => text
                        .setValue(String(reminder.offsetMinutes))
                        .onChange(async (value) => {
                            const num = parseInt(value);
                            if (!isNaN(num)) {
                                reminder.offsetMinutes = num;
                                await this.plugin.saveSettings();
                            }
                        }));
            }

            sectionTitle('Filters');
            const filterSummary = reminderDiv.createDiv({ cls: 'tps-notifier-filter-summary' });
            filterSummary.style.fontSize = '0.85em';
            filterSummary.style.color = 'var(--text-muted)';
            filterSummary.style.marginBottom = '8px';
            filterSummary.setText(buildFilterSummary());

            new Setting(reminderDiv)
                .setName('Required Statuses')
                .setDesc('Only notify if status is one of these (comma-sep)')
                .addTextArea(text => {
                    text
                        .setValue((reminder.requiredStatuses || []).join(', '))
                        .onChange(async (value) => {
                            reminder.requiredStatuses = value.split(',').map(s => s.trim()).filter(s => s);
                            await this.plugin.saveSettings();
                            filterSummary.setText(buildFilterSummary());
                        });
                    text.inputEl.rows = 2;
                });


            new Setting(reminderDiv)
                .setName('Ignore Rules')
                .setDesc('Paths, Tags, and Statuses to ignore')
                .addTextArea(text => {
                    text.setPlaceholder('Paths (comma-sep)')
                        .setValue((reminder.ignorePaths || []).join(', '))
                        .onChange(async (value) => {
                            reminder.ignorePaths = value.split(',').map(s => s.trim()).filter(s => s);
                            await this.plugin.saveSettings();
                        });
                })
                .addTextArea(text => {
                    text.setPlaceholder('Tags (comma-sep)')
                        .setValue((reminder.ignoreTags || []).join(', '))
                        .onChange(async (value) => {
                            reminder.ignoreTags = value.split(',').map(s => s.trim()).filter(s => s);
                            await this.plugin.saveSettings();
                        });
                })
                .addTextArea(text => {
                    text.setPlaceholder('Statuses (comma-sep)')
                        .setValue((reminder.ignoreStatuses || []).join(', '))
                        .onChange(async (value) => {
                            reminder.ignoreStatuses = value.split(',').map(s => s.trim()).filter(s => s);
                            await this.plugin.saveSettings();
                            filterSummary.setText(buildFilterSummary());
                        });
                });

            // --- Advanced Details ---
            const advancedDetails = reminderDiv.createEl('details');
            advancedDetails.style.marginTop = '10px';
            advancedDetails.style.backgroundColor = 'var(--background-primary-alt)';
            advancedDetails.style.padding = '8px';
            advancedDetails.style.borderRadius = '4px';

            const advSummary = advancedDetails.createEl('summary', { text: 'Advanced Configuration' });
            advSummary.style.cursor = 'pointer';
            advSummary.style.fontWeight = '500';
            advSummary.style.marginBottom = '8px';

            const advContent = advancedDetails.createDiv();

            const modeHelp = advContent.createDiv({ cls: 'tps-notifier-mode-help' });
            modeHelp.style.fontSize = '0.85em';
            modeHelp.style.color = 'var(--text-muted)';
            modeHelp.style.marginBottom = '8px';
            modeHelp.setText('One-shot uses the reminder\u2019s frontmatter time once, then stops. It is not a timeblock UI.');

            new Setting(advContent)
                .setName('Reminder Mode')
                .addDropdown(dropdown => dropdown
                    .addOption('task', 'Task (Repeatable)')
                    .addOption('timeblock', 'One-shot (Single Trigger)')
                    .setValue(reminder.mode || 'task')
                    .onChange(async (value: any) => {
                        reminder.mode = value;
                        if (value === 'timeblock') reminder.repeatUntilComplete = false;
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            if (!reminder.mode || reminder.mode === 'task') {
                new Setting(advContent)
                    .setName('Repeat Interval (min)')
                    .addText(text => text
                        .setValue(String(reminder.repeatIntervalMinutes))
                        .onChange(async (value) => {
                            const num = parseInt(value);
                            if (!isNaN(num) && num > 0) {
                                reminder.repeatIntervalMinutes = num;
                                await this.plugin.saveSettings();
                            }
                        }));

                new Setting(advContent)
                    .setName('Repeat Until Ignored or Required Status Removed')
                    .setDesc('Continue repeating until the note matches ignore rules or no longer has the required status.')
                    .addToggle(toggle => toggle
                        .setValue(reminder.repeatUntilComplete)
                        .onChange(async (value) => {
                            reminder.repeatUntilComplete = value;
                            await this.plugin.saveSettings();
                        }));
            }
        }

        // Add Reminder button
        new Setting(reminders)
            .setName('Add Reminder')
            .addButton(button => button
                .setButtonText('+ Add')
                .onClick(async () => {
                    const newReminder: PropertyReminder = {
                        id: `reminder-${Date.now()}`,
                        property: 'scheduled',
                        enabled: true,
                        offsetMinutes: -15,
                        repeatUntilComplete: true,
                        repeatIntervalMinutes: 5,
                        maxRepeats: -1,
                        stopConditions: ['status: complete', 'status: wont-do'],
                        title: 'Reminder: {filename}',
                        body: 'At {time} ({remaining})',
                        ignorePaths: [...(this.plugin.settings.ignorePaths || [])],
                        ignoreTags: [...(this.plugin.settings.ignoreTags || [])],
                        ignoreStatuses: [...(this.plugin.settings.ignoreStatuses || [])],
                    };
                    this.plugin.settings.reminders.push(newReminder);
                    await this.plugin.saveSettings();
                    this.display();
                }));

        // --- Debug ---
        const debug = createSection('Debug', false);

        new Setting(debug)
            .setName('Enable Logging')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLogging)
                .onChange(async (value) => {
                    this.plugin.settings.enableLogging = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(debug)
            .setName('Clear Alert History')
            .setDesc('Reset all reminder states')
            .addButton(button => button
                .setButtonText('Clear')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings.alertState = {};
                    await this.plugin.saveSettings();
                    new Notice('Alert history cleared');
                }));
    }

    private renderSnoozeOptions(container: HTMLElement): void {
        container.empty();
        if (!Array.isArray(this.plugin.settings.snoozeOptions)) {
            this.plugin.settings.snoozeOptions = [];
        }

        this.plugin.settings.snoozeOptions.forEach((opt, index) => {
            const row = container.createDiv();
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '10px';
            row.style.marginBottom = '8px';

            new Setting(row)
                .setClass('tps-notifier-no-border')
                .addText((text) =>
                    text
                        .setPlaceholder('Label')
                        .setValue(opt.label || '')
                        .onChange(async (value) => {
                            opt.label = value;
                            await this.plugin.saveSettings();
                        })
                );

            new Setting(row)
                .setClass('tps-notifier-no-border')
                .addText((text) =>
                    text
                        .setPlaceholder('Minutes')
                        .setValue(String(opt.minutes ?? ''))
                        .onChange(async (value) => {
                            const minutes = parseInt(value, 10);
                            if (isNaN(minutes) || minutes <= 0) return;
                            opt.minutes = minutes;
                            await this.plugin.saveSettings();
                        })
                );

            new Setting(row)
                .setClass('tps-notifier-no-border')
                .addButton((btn) =>
                    btn.setIcon('trash').onClick(async () => {
                        this.plugin.settings.snoozeOptions.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.renderSnoozeOptions(container);
                    })
                );
        });
    }
}
