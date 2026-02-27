import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type TPSNotifier from './main';

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

        // --- Snooze ---
        const snooze = createSection('Snooze', false);

        new Setting(snooze)
            .setName('Snooze Property')
            .setDesc('Frontmatter property name for snooze time (e.g., reminderSnooze, snooze)')
            .addText(text => text
                .setPlaceholder('reminderSnooze')
                .setValue(this.plugin.settings.snoozeProperty || 'reminderSnooze')
                .onChange(async (value) => {
                    this.plugin.settings.snoozeProperty = value.trim() || 'reminderSnooze';
                    await this.plugin.saveSettings();
                }));

        const snoozeDetails = snooze.createEl('details');
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

        // --- Info: Reminders managed by Controller ---
        const info = createSection('Reminders', false);
        const infoDiv = info.createDiv();
        infoDiv.style.padding = '10px';
        infoDiv.style.color = 'var(--text-muted)';
        infoDiv.innerHTML = `
            <p>Reminder rules are now managed by the <strong>TPS-Controller</strong> plugin.</p>
            <p>Open the Controller's settings to add, edit, or remove reminder rules.</p>
        `;

        // --- Debug ---
        const debug = createSection('Debug', false);

        new Setting(debug)
            .setName('Enable Logging')
            .setDesc('Log detailed info to console')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLogging)
                .onChange(async (value) => {
                    this.plugin.settings.enableLogging = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(debug)
            .setName('Send Test Notification')
            .setDesc('Send a test notification to verify connection')
            .addButton(button => button
                .setButtonText('Send Test')
                .onClick(async () => {
                    button.setButtonText('Sending...');
                    button.setDisabled(true);
                    try {
                        await this.plugin.sendMessage('Test notification from TPS Notifier', undefined, 'Test Notification');
                        new Notice('Test notification sent!');
                    } catch (e) {
                        new Notice('Failed to send test notification');
                    }
                    button.setButtonText('Send Test');
                    button.setDisabled(false);
                }));
    }

    renderSnoozeOptions(container: HTMLElement): void {
        container.empty();
        const options = this.plugin.settings.snoozeOptions || [];
        options.forEach((opt, index) => {
            const row = new Setting(container)
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
