import { App, PluginSettingTab, Setting } from 'obsidian';
import TPSKanbanPlugin from '../main';

export class KanbanSettingTab extends PluginSettingTab {
  plugin: TPSKanbanPlugin;
  constructor(app: App, plugin: TPSKanbanPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'TPS Kanban settings' });
    containerEl.createEl('p', {
      text: "Lanes are defined by the Group By setting in each base view. Use the base's toolbar to configure grouping and sorting.",
      cls: 'setting-item-description',
    });

    new Setting(containerEl).setName('Card styling').setHeading();

    new Setting(containerEl)
      .setName('Icon property')
      .setDesc('Frontmatter key whose value is a Lucide icon name to display on each card (e.g. icon).')
      .addText(text => text
        .setPlaceholder('icon')
        .setValue(this.plugin.settings.iconKey)
        .onChange(async value => {
          this.plugin.settings.iconKey = value.trim() || 'icon';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Color property')
      .setDesc('Frontmatter key whose value is a CSS color (hex, rgb, named) to use as the card accent (e.g. color).')
      .addText(text => text
        .setPlaceholder('color')
        .setValue(this.plugin.settings.colorKey)
        .onChange(async value => {
          this.plugin.settings.colorKey = value.trim() || 'color';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName('Lane order').setHeading();

    new Setting(containerEl)
      .setName('Ungrouped lane position')
      .setDesc('Where to place cards that have no group-by value.')
      .addDropdown(drop => drop
        .addOption('first', 'First')
        .addOption('last', 'Last')
        .setValue(this.plugin.settings.ungroupedPosition)
        .onChange(async value => {
          this.plugin.settings.ungroupedPosition = value as 'first' | 'last';
          await this.plugin.saveSettings();
        }));
  }
}
