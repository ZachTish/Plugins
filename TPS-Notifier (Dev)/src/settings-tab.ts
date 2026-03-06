import { App, Notice, PluginSettingTab, Setting, debounce } from 'obsidian';
import type TPSMessager from './main';
import { createCollapsibleSection } from './utils/section-helpers';

export class TPSMessagerSettingTab extends PluginSettingTab {
    plugin: TPSMessager;

    constructor(app: App, plugin: TPSMessager) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        const debouncedSave = debounce(() => this.plugin.saveSettings(), 300);

        containerEl.createEl('h2', { text: 'TPS Messager Settings' });

        // --- Connection Settings ---
        const connection = createCollapsibleSection(containerEl, { title: 'Connection' });

        new Setting(connection)
            .setName('ntfy Server')
            .setDesc('The ntfy server URL (e.g., https://ntfy.sh)')
            .addText(text => text
                .setPlaceholder('https://ntfy.sh')
                .setValue(this.plugin.settings.ntfyServer)
                .onChange((value) => {
                    this.plugin.settings.ntfyServer = value;
                    void debouncedSave();
                }));

        new Setting(connection)
            .setName('ntfy Topic')
            .setDesc('Your unique topic name')
            .addText(text => text
                .setPlaceholder('my-reminders')
                .setValue(this.plugin.settings.ntfyTopic)
                .onChange((value) => {
                    this.plugin.settings.ntfyTopic = value;
                    void debouncedSave();
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

        // --- Debug ---
        const debug = createCollapsibleSection(containerEl, { title: 'Debug' });

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
                        await this.plugin.sendMessage('Test notification from TPS Messager', undefined, 'Test Notification');
                        new Notice('Test notification sent!');
                    } catch (e) {
                        new Notice('Failed to send test notification');
                    }
                    button.setButtonText('Send Test');
                    button.setDisabled(false);
                }));
    }
}
