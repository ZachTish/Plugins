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

const createSettingsGroup = (
    parent: HTMLElement,
    title: string,
    description?: string,
): HTMLElement => {
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

export class TPSMessagerSettingTab extends PluginSettingTab {
    plugin: TPSMessager;
    private settingsViewState = new Map<string, boolean>();
    private settingsScrollTop = 0;
    private hasRenderedSettings = false;

    constructor(app: App, plugin: TPSMessager) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        this.captureSettingsViewState(containerEl);
        containerEl.empty();

        const debouncedSave = debounce(() => this.plugin.saveSettings(), 300);

        containerEl.createEl('h2', { text: 'TPS Messager Settings' });
        containerEl.createEl('p', {
            text: 'Keep this plugin focused on transport settings. TPS Controller can use it for reminder delivery once connection is configured.',
            cls: 'setting-item-description'
        });

        const featuresCategory = createSettingsGroup(containerEl, 'Core Delivery', 'Main transport toggles and the ntfy connection used by other TPS automation.');
        const automationCategory = createSettingsGroup(containerEl, 'Connection', 'Server, topic, and delivery priority.');
        const maintenanceCategory = createSettingsGroup(containerEl, 'Diagnostics and Testing', 'Logging and manual test delivery tools.');

        const features = createCollapsibleSection(
            featuresCategory,
            'Core Features',
            'High-level toggles. Disable features here to hide lower-level configuration.',
            false
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
            automationCategory,
            'Connection',
            'Server, topic, and delivery priority. These are the settings you are most likely to change.',
            false
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
            maintenanceCategory,
            'Diagnostics & Debug',
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
                maintenanceCategory,
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
        this.restoreSettingsViewState(containerEl);
    }

    private captureSettingsViewState(containerEl: HTMLElement): void {
        this.settingsScrollTop = containerEl.scrollTop;
        this.settingsViewState.clear();
        const detailsEls = Array.from(containerEl.querySelectorAll('details'));
        detailsEls.forEach((detailsEl, index) => {
            const details = detailsEl as HTMLDetailsElement;
            const summaryText = details.querySelector('summary')?.textContent?.trim() || '';
            this.settingsViewState.set(`${index}:${summaryText}`, details.open);
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
            const isOpen = this.settingsViewState.get(`${index}:${summaryText}`);
            if (isOpen) details.setAttr('open', 'true');
            else details.removeAttribute('open');
        });
        containerEl.scrollTop = this.settingsScrollTop;
    }
}
