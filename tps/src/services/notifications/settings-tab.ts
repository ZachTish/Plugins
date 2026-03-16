import { App, Notice, PluginSettingTab, Setting, debounce } from 'obsidian';
import type TPSMessager from './main';

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
        containerEl.createEl('p', {
            text: 'Keep this plugin focused on transport settings. TPS Controller can use it for reminder delivery once connection is configured.',
            cls: 'setting-item-description'
        });

        const createMainCategory = (title: 'Features' | 'Rules' | 'Interaction' | 'UI Display'): HTMLElement => {
            const category = containerEl.createDiv({ cls: 'tps-settings-main-category' });
            category.createEl('h3', { text: title });
            return category.createDiv({ cls: 'tps-settings-main-content' });
        };

        const featuresCategory = createMainCategory('Features');
        const rulesCategory = createMainCategory('Rules');
        const interactionCategory = createMainCategory('Interaction');
        const uiDisplayCategory = createMainCategory('UI Display');

        const features = createCollapsibleSection(
            featuresCategory,
            'Core Features',
            'High-level toggles. Disable features here to hide lower-level configuration.',
            true
        );

        new Setting(features)
            .setName('Enable delivery transport')
            .setDesc('Master toggle for outbound notification delivery.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enabled ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.enabled = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(features)
            .setName('Enable manual composer command')
            .setDesc('Registers the “Send Custom Notification” command in the command palette.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableManualComposer ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.enableManualComposer = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        const connection = createCollapsibleSection(
            rulesCategory,
            'Connection',
            'Server, topic, and delivery priority. These are the settings you are most likely to change.',
            true
        );

        if (this.plugin.settings.enabled ?? true) {
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
        } else {
            connection.createEl('p', {
                text: 'Delivery transport is disabled. Enable it above to configure server/topic settings.',
                cls: 'setting-item-description'
            });
        }

        const diagnostics = createCollapsibleSection(
            uiDisplayCategory,
            'Diagnostics',
            'Optional tools for verifying delivery and troubleshooting.',
            false
        );

        new Setting(diagnostics)
            .setName('Enable Logging')
            .setDesc('Log detailed info to console')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLogging)
                .onChange(async (value) => {
                    this.plugin.settings.enableLogging = value;
                    await this.plugin.saveSettings();
                }));

        if ((this.plugin.settings.enabled ?? true) && (this.plugin.settings.enableManualComposer ?? true)) {
            const composer = createCollapsibleSection(
                interactionCategory,
                'Manual Composer',
                'Command and test payload tooling for manual sends.',
                false
            );

            new Setting(composer)
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
}
