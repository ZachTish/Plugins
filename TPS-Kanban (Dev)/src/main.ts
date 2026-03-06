import { Plugin, QueryController, BasesView } from 'obsidian';
import { KanbanView, KANBAN_VIEW_TYPE } from './views/KanbanView';
import { DEFAULT_SETTINGS, KanbanSettings } from './settings';
import { KanbanSettingTab } from './settings/SettingsTab';

export default class TPSKanbanPlugin extends Plugin {
  settings: KanbanSettings = DEFAULT_SETTINGS;

  async onload() {
    console.log('Loading TPS Kanban (Dev)');
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<KanbanSettings> || {});

    this.registerBasesView(KANBAN_VIEW_TYPE, {
      name: 'Kanban',
      icon: 'columns',
      factory: (controller: QueryController, containerEl: HTMLElement): BasesView =>
        new KanbanView(controller, containerEl, this),
    });

    this.addSettingTab(new KanbanSettingTab(this.app, this));
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    console.log('Unloading TPS Kanban (Dev)');
  }
}
