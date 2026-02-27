import { App, PluginSettingTab, Setting } from 'obsidian';
import TPSCanvasNotesPlugin from './main';

export interface TPSCanvasNotesSettings {
  enabled: boolean;
  dailyNotesOnly: boolean;
  showInsertionZones: 'always' | 'hover' | 'drag-only';
  defaultExtractFolder: string;
}

export const DEFAULT_SETTINGS: TPSCanvasNotesSettings = {
  enabled: true,
  dailyNotesOnly: true,
  showInsertionZones: 'hover',
  defaultExtractFolder: '' // Empty = vault default
};

export class TPSCanvasNotesSettingTab extends PluginSettingTab {
  plugin: TPSCanvasNotesPlugin;

  constructor(app: App, plugin: TPSCanvasNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'TPS Canvas Notes Settings' });

    new Setting(containerEl)
      .setName('Enable Canvas Notes')
      .setDesc('Master toggle for the canvas card interface')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          this.plugin.updateExtension();
        })
      );

    new Setting(containerEl)
      .setName('Daily Notes Only')
      .setDesc('Only activate canvas mode for Daily Notes (recommended)')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.dailyNotesOnly).onChange(async (value) => {
          this.plugin.settings.dailyNotesOnly = value;
          await this.plugin.saveSettings();
          this.plugin.updateExtension();
        })
      );

    new Setting(containerEl)
      .setName('Insertion Zone Visibility')
      .setDesc('When to show the clickable zones between cards')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('always', 'Always visible')
          .addOption('hover', 'Show on hover')
          .addOption('drag-only', 'Only when dragging')
          .setValue(this.plugin.settings.showInsertionZones)
          .onChange(async (value) => {
            this.plugin.settings.showInsertionZones = value as any;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Default Extract Folder')
      .setDesc('Where to save extracted notes (leave blank for vault default)')
      .addText((text) =>
        text
          .setPlaceholder('e.g., Notes/Extracted')
          .setValue(this.plugin.settings.defaultExtractFolder)
          .onChange(async (value) => {
            this.plugin.settings.defaultExtractFolder = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl('h3', { text: 'Usage Instructions' });
    containerEl.createEl('p', {
      text: 'Add --- delimiters to create cards in your daily notes. Content between delimiters becomes a draggable card.'
    });
    containerEl.createEl('p', {
      text: 'Click between cards to create new empty cards. Right-click to embed an existing note.'
    });
    containerEl.createEl('p', {
      text: 'Hover over a card to see the menu button (⋮) for extract/delete options.'
    });
  }
}
