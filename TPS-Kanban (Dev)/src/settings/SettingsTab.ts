import { App, PluginSettingTab, Setting } from 'obsidian';
import TPSKanbanPlugin from '../main';

const createCollapsibleSection = (
  parent: HTMLElement,
  title: string,
  description?: string,
  defaultOpen = false,
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
      text: description,
    });
  }

  return details.createDiv({ cls: 'tps-collapsible-section-content' });
};

export class KanbanSettingTab extends PluginSettingTab {
  plugin: TPSKanbanPlugin;
  private settingsViewState = new Map<string, boolean>();
  private settingsScrollTop = 0;
  private hasRenderedSettings = false;
  constructor(app: App, plugin: TPSKanbanPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    this.captureSettingsViewState(containerEl);
    containerEl.empty();
    containerEl.createEl('h2', { text: 'TPS Kanban settings' });
    containerEl.createEl('p', {
      text: "Lanes are defined by the Group By setting in each base view. Use the base's toolbar to configure grouping and sorting.",
      cls: 'setting-item-description',
    });

    const cardFields = createCollapsibleSection(
      containerEl,
      'Card Frontmatter Keys',
      'Keys used to pull visual metadata from each card note.',
      false,
    );

    new Setting(cardFields)
      .setName('Icon property')
      .setDesc('Frontmatter key whose value is a Lucide icon name to display on each card (e.g. icon).')
      .addText(text => text
        .setPlaceholder('icon')
        .setValue(this.plugin.settings.iconKey)
        .onChange(async value => {
          this.plugin.settings.iconKey = value.trim() || 'icon';
          await this.plugin.saveSettings();
        }));

    new Setting(cardFields)
      .setName('Color property')
      .setDesc('Frontmatter key whose value is a CSS color (hex, rgb, named) to use as the card accent (e.g. color).')
      .addText(text => text
        .setPlaceholder('color')
        .setValue(this.plugin.settings.colorKey)
        .onChange(async value => {
          this.plugin.settings.colorKey = value.trim() || 'color';
          await this.plugin.saveSettings();
        }));

    new Setting(cardFields)
      .setName('Frontmatter color applies to')
      .setDesc('Choose whether the frontmatter color affects card accents, icons, both, or neither.')
      .addDropdown(drop => drop
        .addOption('both', 'Card + icon')
        .addOption('card', 'Card only')
        .addOption('icon', 'Icon only')
        .addOption('off', 'Off')
        .setValue(this.plugin.settings.frontmatterColorTarget || 'both')
        .onChange(async value => {
          this.plugin.settings.frontmatterColorTarget = value as 'card' | 'icon' | 'both' | 'off';
          await this.plugin.saveSettings();
        }));

    const laneOrder = createCollapsibleSection(
      containerEl,
      'Lane Behavior',
      'Optional sorting behavior for cards that do not have a group-by value.',
      false,
    );

    new Setting(laneOrder)
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

    new Setting(laneOrder)
      .setName('Kanban task cards position')
      .setDesc('For Kanban board files, show checkbox task cards above or below the note-level card.')
      .addDropdown(drop => drop
        .addOption('bottom', 'Below note cards')
        .addOption('top', 'Above note cards')
        .setValue(this.plugin.settings.kanbanTaskCardPosition || 'bottom')
        .onChange(async value => {
          this.plugin.settings.kanbanTaskCardPosition = value as 'top' | 'bottom';
          await this.plugin.saveSettings();
        }));

    new Setting(laneOrder)
      .setName('Kanban scale')
      .setDesc('Scale board sizing from 70% to 140%.')
      .addSlider((slider) => {
        slider
          .setLimits(70, 140, 5)
          .setDynamicTooltip()
          .setValue(Math.round((this.plugin.settings.scale || 1) * 100))
          .onChange(async (value) => {
            this.plugin.settings.scale = value / 100;
            await this.plugin.saveSettings();
          });
      })
      .addExtraButton((btn) => {
        btn
          .setIcon('reset')
          .setTooltip('Reset to 100%')
          .onClick(async () => {
            this.plugin.settings.scale = 1;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(laneOrder)
      .setName('Dynamic empty lane width')
      .setDesc('In board mode, shrink columns that have no cards.')
      .addToggle((toggle) => {
        toggle
          .setValue(!!this.plugin.settings.dynamicEmptyLaneWidth)
          .onChange(async (value) => {
            this.plugin.settings.dynamicEmptyLaneWidth = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(laneOrder)
      .setName('Kanban line task cards')
      .setDesc('Show/hide task-level cards parsed from kanban board note checkboxes.')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableKanbanTaskCards !== false)
          .onChange(async (value) => {
            this.plugin.settings.enableKanbanTaskCards = value;
            await this.plugin.saveSettings();
          });
      });

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
        (detailsEl as HTMLDetailsElement).removeAttribute('open');
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
