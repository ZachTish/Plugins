import { Plugin, QueryController, BasesView } from 'obsidian';
import { KanbanView, KANBAN_VIEW_TYPE } from './views/KanbanView';
import { DEFAULT_SETTINGS, KanbanSettings } from './settings';
import { KanbanSettingTab } from './settings/SettingsTab';

export default class TPSKanbanPlugin extends Plugin {
  settings: KanbanSettings = DEFAULT_SETTINGS;
  private static readonly MIN_SCALE = 0.7;
  private static readonly MAX_SCALE = 1.4;

  async onload() {
    console.log('Loading TPS Kanban (Dev)');
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<KanbanSettings> || {});
    if (this.settings.kanbanTaskCardPosition !== 'top' && this.settings.kanbanTaskCardPosition !== 'bottom') {
      this.settings.kanbanTaskCardPosition = 'bottom';
    }
    this.settings.scale = this.normalizeScale(this.settings.scale);
    if (!this.settings.layoutModeByView || typeof this.settings.layoutModeByView !== 'object') {
      this.settings.layoutModeByView = {};
    }
    if (typeof this.settings.dynamicEmptyLaneWidth !== 'boolean') {
      this.settings.dynamicEmptyLaneWidth = false;
    }
    if (typeof this.settings.enableKanbanTaskCards !== 'boolean') {
      this.settings.enableKanbanTaskCards = true;
    }
    if (!this.settings.laneLabelAliasesByView || typeof this.settings.laneLabelAliasesByView !== 'object') {
      this.settings.laneLabelAliasesByView = {};
    }

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
    this.refreshKanbanViewsFromSettings();
  }

  onunload() {
    console.log('Unloading TPS Kanban (Dev)');
  }

  private normalizeScale(value: unknown): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_SETTINGS.scale;
    return Math.max(TPSKanbanPlugin.MIN_SCALE, Math.min(TPSKanbanPlugin.MAX_SCALE, numeric));
  }

  private refreshKanbanViewsFromSettings(): void {
    const scale = this.normalizeScale(this.settings.scale);
    const viewMap = this.settings.layoutModeByView || {};

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() === KANBAN_VIEW_TYPE) {
        const view = leaf.view as unknown as KanbanView;
        view.applyLayoutSettings();
      }
    });

    // Fallback for Bases-hosted kanban instances where leaf view type may not match KANBAN_VIEW_TYPE.
    document.querySelectorAll<HTMLElement>('.tps-kanban-container').forEach((el) => {
      el.style.setProperty('--tps-kanban-scale', String(scale));
      const viewId = el.dataset.kanbanViewId || '';
      const mode = viewMap[viewId] || 'board';
      el.classList.toggle('tps-kanban-container--list', mode === 'list');
    });
  }
}
