import { App, Notice, PluginSettingTab, Setting, debounce } from 'obsidian';
import type TPSControllerPlugin from './main';
import type { PropertyReminder, ExternalCalendarConfig } from './types';
import { normalizeCalendarUrl } from './utils';
import { createCollapsibleSection } from './utils/section-helpers';
import { renderListWithControls } from './utils/list-renderer';

const createCalendarId = () => `calendar-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

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

        // ── Device Role ─────────────────────────────────────────────
        const roleSection = createCollapsibleSection(containerEl, {
            title: 'Device Role',
            defaultOpen: false
        });

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
        const extCalSection = createCollapsibleSection(containerEl, {
            title: 'External Calendars',
            defaultOpen: false
        });
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
        const calSection = createCollapsibleSection(containerEl, {
            title: 'Calendar Sync Rules',
            defaultOpen: false
        });

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

        // Calendar Frontmatter Keys (collapsible)
        const fmDetails = calSection.createEl('details', { cls: 'tps-collapsible-subsection' });
        const fmSummary = fmDetails.createEl('summary', { text: 'Frontmatter Keys' });
        const fmContent = fmDetails.createDiv({ cls: 'tps-rule-content' });

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
        const remSection = createCollapsibleSection(containerEl, {
            title: 'Reminder Rules',
            defaultOpen: false
        });

        new Setting(remSection)
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

        new Setting(remSection)
            .setName('Batch Notifications')
            .setDesc('Send one combined notification for multiple triggers.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.batchNotifications)
                .onChange(async (value) => {
                    this.plugin.settings.batchNotifications = value;
                    await this.plugin.saveSettings();
                }));

        // Global ignore lists (collapsible)
        const ignoreDetails = remSection.createEl('details', { cls: 'tps-collapsible-subsection' });
        const ignoreSummary = ignoreDetails.createEl('summary', { text: 'Global Ignore Lists' });
        const ignoreContent = ignoreDetails.createDiv({ cls: 'tps-rule-content' });

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
        const rulesContainer = remSection.createDiv({ cls: 'tps-controller-reminder-rules' });
        this.renderReminderRules(rulesContainer);

        new Setting(remSection)
            .addButton(btn => btn
                .setButtonText('Add Reminder Rule')
                .setCta()
                .onClick(async () => {
                    this.plugin.settings.reminders.push(this.createDefaultReminder());
                    await this.plugin.saveSettings();
                    this.renderReminderRules(rulesContainer);
                }));

        new Setting(remSection)
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

        // ── Companion Scan ──────────────────────────────────────────
        const compSection = createCollapsibleSection(containerEl, {
            title: 'Companion Automation',
            defaultOpen: false
        });

        new Setting(compSection)
            .setName('Enable Controller Companion Scans')
            .setDesc('When enabled, the Controller syncs companion styling (icon/color/sort) across ALL vault files every 5 minutes. User devices only sync files they actively edit. Changes take effect on next automation cycle.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.companionStartupScanEnabled)
                .onChange(async (value) => {
                    this.plugin.settings.companionStartupScanEnabled = value;
                    await this.plugin.saveSettings();
                }));

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

        // ── Debug ───────────────────────────────────────────────────
        const debugSection = createCollapsibleSection(containerEl, {
            title: 'Debug',
            defaultOpen: false
        });

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
            const ruleEl = container.createEl('details', { cls: 'tps-controller-reminder-rule' });

            const ruleSummary = ruleEl.createEl('summary');

            const labelSpan = ruleSummary.createSpan({ cls: 'tps-rule-label' });
            const enabledDot = rem.enabled ? '🟢' : '⚫';
            labelSpan.textContent = `${enabledDot} ${rem.label || `Rule ${index + 1}`}`;

            const descSpan = ruleSummary.createSpan({ cls: 'tps-rule-desc' });
            descSpan.textContent = `${rem.property} • ${rem.offsetMinutes >= 0 ? '+' : ''}${rem.offsetMinutes}min`;

            const ruleContent = ruleEl.createDiv({ cls: 'tps-rule-content' });

            // ── General ──────────────────────────────────────
            // Label
            new Setting(ruleContent)
                .setName('Label')
                .addText(text => text
                    .setValue(rem.label || '')
                    .onChange(async (value) => {
                        rem.label = value;
                        await this.plugin.saveSettings();
                        labelSpan.textContent = `${rem.enabled ? '🟢' : '⚫'} ${value || `Rule ${index + 1}`}`;
                    }));

            // Enabled
            new Setting(ruleContent)
                .setName('Enabled')
                .addToggle(toggle => toggle
                    .setValue(rem.enabled)
                    .onChange(async (value) => {
                        rem.enabled = value;
                        await this.plugin.saveSettings();
                        labelSpan.textContent = `${value ? '🟢' : '⚫'} ${rem.label || `Rule ${index + 1}`}`;
                    }));

            // ── Trigger Settings ─────────────────────────────
            const triggerGroup = ruleContent.createEl('details');
            triggerGroup.setAttr('open', 'true');
            const triggerSummary = triggerGroup.createEl('summary', { text: 'Trigger Settings' });
            const triggerContent = triggerGroup.createDiv();

            // Property
            new Setting(triggerContent)
                .setName('Property')
                .setDesc('Frontmatter date/time property to trigger on.')
                .addText(text => text
                    .setValue(rem.property)
                    .onChange(async (value) => {
                        rem.property = value;
                        await this.plugin.saveSettings();
                    }));

            // Offset
            new Setting(triggerContent)
                .setName('Offset (minutes)')
                .setDesc('Negative = before, positive = after the property time.')
                .addText(text => text
                    .setValue(String(rem.offsetMinutes))
                    .onChange(async (value) => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num)) {
                            rem.offsetMinutes = num;
                            await this.plugin.saveSettings();
                        }
                    }));

            // Mode
            new Setting(triggerContent)
                .setName('Mode')
                .addDropdown(drop => drop
                    .addOption('task', 'Task (single trigger time)')
                    .addOption('timeblock', 'Timeblock (start–end range)')
                    .setValue(rem.mode || 'task')
                    .onChange(async (value) => {
                        rem.mode = value as 'task' | 'timeblock';
                        await this.plugin.saveSettings();
                    }));

            // All-day filter
            new Setting(triggerContent)
                .setName('All-Day Filter')
                .addDropdown(drop => drop
                    .addOption('any', 'Any')
                    .addOption('true', 'All-day only')
                    .addOption('false', 'Non-all-day only')
                    .setValue(rem.allDayFilter || 'any')
                    .onChange(async (value) => {
                        rem.allDayFilter = value as any;
                        await this.plugin.saveSettings();
                    }));

            // All-day base time
            if (rem.allDayFilter === 'true' || rem.allDayFilter === 'any') {
                new Setting(triggerContent)
                    .setName('All-Day Base Time')
                    .setDesc('Time of day to use as base for all-day events (HH:MM).')
                    .addText(text => text
                        .setPlaceholder('09:00')
                        .setValue(rem.allDayBaseTime || '')
                        .onChange(async (value) => {
                            rem.allDayBaseTime = value;
                            await this.plugin.saveSettings();
                        }));
            }

            // Smart offset
            new Setting(triggerContent)
                .setName('Use Smart Offset')
                .setDesc('Add/subtract another property value to calculate trigger time.')
                .addToggle(toggle => toggle
                    .setValue(!!rem.useSmartOffset)
                    .onChange(async (value) => {
                        rem.useSmartOffset = value;
                        await this.plugin.saveSettings();
                        this.renderReminderRules(container);
                    }));

            if (rem.useSmartOffset) {
                new Setting(triggerContent)
                    .setName('Smart Offset Property')
                    .addText(text => text
                        .setPlaceholder('timeEstimate')
                        .setValue(rem.smartOffsetProperty || '')
                        .onChange(async (value) => {
                            rem.smartOffsetProperty = value;
                            await this.plugin.saveSettings();
                        }));

                new Setting(triggerContent)
                    .setName('Smart Offset Operator')
                    .addDropdown(drop => drop
                        .addOption('add', 'Add')
                        .addOption('subtract', 'Subtract')
                        .setValue(rem.smartOffsetOperator || 'add')
                        .onChange(async (value) => {
                            rem.smartOffsetOperator = value as any;
                            await this.plugin.saveSettings();
                        }));
            }

            // ── Repeat & Stop ────────────────────────────────
            const repeatGroup = ruleContent.createEl('details');
            const repeatSummary = repeatGroup.createEl('summary');
            repeatSummary.textContent = rem.repeatUntilComplete
                ? `Repeat & Stop — every ${rem.repeatIntervalMinutes}min`
                : 'Repeat & Stop — single notification';
            const repeatContent = repeatGroup.createDiv();

            // Repeat
            new Setting(repeatContent)
                .setName('Repeat Until Complete')
                .addToggle(toggle => toggle
                    .setValue(rem.repeatUntilComplete)
                    .onChange(async (value) => {
                        rem.repeatUntilComplete = value;
                        await this.plugin.saveSettings();
                        this.renderReminderRules(container);
                    }));

            if (rem.repeatUntilComplete) {
                new Setting(repeatContent)
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
            }

            // Stop conditions
            new Setting(repeatContent)
                .setName('Stop Conditions')
                .setDesc('Comma-separated (e.g. "status: complete, status: wont-do").')
                .addText(text => text
                    .setValue((rem.stopConditions || []).join(', '))
                    .onChange(async (value) => {
                        rem.stopConditions = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            // ── Filtering ────────────────────────────────────
            const filterGroup = ruleContent.createEl('details');
            const filterSummary = filterGroup.createEl('summary', { text: 'Filtering' });
            const filterContent = filterGroup.createDiv();

            // Required statuses
            new Setting(filterContent)
                .setName('Required Statuses')
                .setDesc('Only trigger for files with one of these statuses (comma-separated).')
                .addText(text => text
                    .setValue((rem.requiredStatuses || []).join(', '))
                    .onChange(async (value) => {
                        rem.requiredStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            // Required paths (NEW)
            new Setting(filterContent)
                .setName('Required Folders')
                .setDesc('Only trigger for files inside these folders (comma-separated prefixes). Leave empty for all folders.')
                .addText(text => text
                    .setPlaceholder('Action Items, Markdown/Projects')
                    .setValue((rem.requiredPaths || []).join(', '))
                    .onChange(async (value) => {
                        rem.requiredPaths = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            // Ignore paths
            new Setting(filterContent)
                .setName('Ignore Paths')
                .setDesc('Skip matching files (comma-separated). Supports wildcards (*/Trash/*) and regex (re:^System/).')
                .addText(text => text
                    .setValue((rem.ignorePaths || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignorePaths = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            // Ignore tags
            new Setting(filterContent)
                .setName('Ignore Tags')
                .setDesc('Skip files with these tags (comma-separated).')
                .addText(text => text
                    .setValue((rem.ignoreTags || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignoreTags = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            // Ignore statuses
            new Setting(filterContent)
                .setName('Ignore Statuses')
                .setDesc('Skip files with these statuses (comma-separated).')
                .addText(text => text
                    .setValue((rem.ignoreStatuses || []).join(', '))
                    .onChange(async (value) => {
                        rem.ignoreStatuses = value.split(',').map(s => s.trim()).filter(Boolean);
                        await this.plugin.saveSettings();
                    }));

            // ── Notification ─────────────────────────────────
            const notifGroup = ruleContent.createEl('details');
            const notifSummary = notifGroup.createEl('summary', { text: 'Notification Template' });
            const notifContent = notifGroup.createDiv();

            // Title / Body templates
            new Setting(notifContent)
                .setName('Title')
                .setDesc('Supports {filename}, {time}, {remaining}.')
                .addText(text => text
                    .setValue(rem.title)
                    .onChange(async (value) => {
                        rem.title = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(notifContent)
                .setName('Body')
                .setDesc('Supports {filename}, {time}, {remaining}.')
                .addText(text => text
                    .setValue(rem.body)
                    .onChange(async (value) => {
                        rem.body = value;
                        await this.plugin.saveSettings();
                    }));

            // Delete button
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

            // Auto-Create Config (The missing piece!)
            const acDetails = card.createEl("details");
            acDetails.style.marginTop = "8px";
            acDetails.style.border = "1px solid var(--background-modifier-border)";
            acDetails.style.padding = "8px";
            acDetails.style.borderRadius = "4px";

            const acSummary = acDetails.createEl("summary", { text: "Auto-Create Settings" });
            acSummary.style.cursor = "pointer";
            acSummary.style.fontWeight = "600";

            const acContent = acDetails.createDiv();
            acContent.style.paddingTop = "8px";

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
}
