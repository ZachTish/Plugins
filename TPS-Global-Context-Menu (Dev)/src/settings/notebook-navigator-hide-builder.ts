import { App, ButtonComponent, Notice, Setting, TextComponent } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import type { HideRule, RuleCondition } from '../../../TPS-Notebook-Navigator-Companion (Dev)/src/types';
import {
  NOTEBOOK_NAVIGATOR_RULE_SOURCE_OPTIONS,
  createDefaultCondition,
  getConditionPlaceholder,
  getDefaultField,
  getOperatorsForSource,
  normalizeConditionSource,
  normalizeMatchMode,
  normalizeSmartOperator,
  usesConditionField,
  usesConditionValue,
} from './notebook-navigator-builder-common';

type HideBuilderOptions = {
  app: App;
  plugin: TPSGlobalContextMenuPlugin;
  containerEl: HTMLElement;
  onStructureChange: () => void;
  onRefreshConsumers: () => Promise<void>;
};

export class NotebookNavigatorHideBuilder {
  private filterQuery = '';

  constructor(private readonly options: HideBuilderOptions) {}

  render(): void {
    const { containerEl } = this.options;
    containerEl.empty();

    containerEl.createEl('h4', { text: 'Apply/remove tags based on rules' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Automatically add or remove tags based on matching note conditions.',
    });

    new Setting(containerEl)
      .setName('Auto-remove hide tag when no rule matches')
      .setDesc('If an add-mode hide rule no longer matches, remove the tag automatically.')
      .addToggle((toggle) => toggle
        .setValue(this.options.plugin.settings.notebookNavigatorAutoRemoveHiddenWhenNoMatch !== false)
        .onChange(async (value) => {
          this.options.plugin.settings.notebookNavigatorAutoRemoveHiddenWhenNoMatch = value;
          await this.persist(false);
        }));

    const toolbar = containerEl.createDiv({ cls: 'tps-gcm-rule-builder-toolbar' });
    const filterInput = toolbar.createEl('input', {
      cls: 'tps-gcm-rule-builder-filter',
      attr: { type: 'search', placeholder: 'Filter rules...' },
    });
    filterInput.value = this.filterQuery;
    filterInput.addEventListener('input', () => {
      this.filterQuery = filterInput.value.trim().toLowerCase();
      this.render();
    });

    new ButtonComponent(toolbar)
      .setButtonText('Add Rule')
      .setCta()
      .onClick(async () => {
        this.getRules().push(this.createDefaultHideRule());
        await this.persist(true);
      });

    new ButtonComponent(toolbar)
      .setButtonText('Apply Active Note')
      .onClick(async () => {
        await this.applyCompanionMethod('applyRulesToActiveFile', false);
      });

    new ButtonComponent(toolbar)
      .setButtonText('Apply All Notes')
      .onClick(async () => {
        await this.applyCompanionMethod('applyRulesToAllFiles', false);
      });

    const visibleRules = this.getRules()
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule, index }) => this.matchesFilter(rule, index + 1, this.filterQuery));

    if (visibleRules.length === 0) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: this.getRules().length === 0 ? 'No rules configured.' : 'No rules match the current filter.',
      });
      return;
    }

    const listEl = containerEl.createDiv({ cls: 'tps-gcm-rule-builder-list' });
    visibleRules.forEach(({ rule, index }) => this.renderRuleCard(listEl, rule, index));
  }

  private renderRuleCard(parent: HTMLElement, rule: HideRule, index: number): void {
    const details = parent.createEl('details', { cls: 'tps-gcm-rule-card' });
    if (index === 0 || !this.filterQuery) details.open = true;

    const summary = details.createEl('summary', { cls: 'tps-gcm-rule-card-summary' });
    const badge = summary.createSpan({ cls: 'tps-gcm-rule-chip' });
    badge.setText(rule.mode === 'add' ? '+' : '-');
    const text = summary.createDiv({ cls: 'tps-gcm-rule-card-summary-text' });
    const title = text.createDiv({ cls: 'tps-gcm-rule-card-summary-title' });
    const meta = text.createDiv({ cls: 'tps-gcm-rule-card-summary-meta' });
    const syncSummary = () => {
      title.setText(String(rule.name || '').trim() || `Rule ${index + 1}`);
      meta.setText(`${rule.enabled ? 'Enabled' : 'Disabled'} - ${rule.mode === 'add' ? 'add' : 'remove'} #${this.normalizeTagName(rule.tagName) || 'hide'} - ${this.getConditionSummary(rule.conditions, rule.match)}`);
    };
    syncSummary();

    const body = details.createDiv({ cls: 'tps-gcm-rule-card-body' });

    new Setting(body)
      .setName('Rule name')
      .setDesc('Label for this rule.')
      .addText((textInput) => {
        textInput.setPlaceholder('Hide archived notes');
        textInput.setValue(rule.name || '');
        this.bindText(textInput, async (value) => {
          rule.name = value.trim();
          syncSummary();
        });
      });

    new Setting(body)
      .setName('Enabled')
      .addToggle((toggle) => toggle.setValue(rule.enabled !== false).onChange(async (value) => {
        rule.enabled = value;
        syncSummary();
        await this.persist(false);
      }));

    new Setting(body)
      .setName('Action')
      .setDesc('Add or remove the tag when this rule matches.')
      .addDropdown((dropdown) => dropdown
        .addOption('add', 'Add tag')
        .addOption('remove', 'Remove tag')
        .setValue(rule.mode)
        .onChange(async (value) => {
          rule.mode = value === 'remove' ? 'remove' : 'add';
          syncSummary();
          await this.persist(false);
        }));

    new Setting(body)
      .setName('Tag name')
      .setDesc('Store without `#`; the UI normalizes it automatically.')
      .addText((textInput) => {
        textInput.setPlaceholder('hide');
        textInput.setValue(this.normalizeTagName(rule.tagName));
        this.bindText(textInput, async (value) => {
          rule.tagName = this.normalizeTagName(value);
          syncSummary();
        });
      });

    const criteriaSection = body.createDiv({ cls: 'tps-gcm-rule-card-section' });
    criteriaSection.createEl('h5', { text: 'Match Criteria' });
    new Setting(criteriaSection)
      .setName('Condition match mode')
      .setDesc('Choose whether all conditions must match or any condition can match.')
      .addDropdown((dropdown) => dropdown
        .addOption('all', 'All conditions')
        .addOption('any', 'Any condition')
        .setValue(normalizeMatchMode(rule.match))
        .onChange(async (value) => {
          rule.match = normalizeMatchMode(value);
          syncSummary();
          await this.persist(false);
        }));

    this.renderConditionList(criteriaSection, rule, syncSummary);

    const actions = body.createDiv({ cls: 'tps-gcm-rule-actions' });
    this.createActionButton(actions, 'Up', index <= 0, async () => {
      this.moveRule(index, index - 1);
      await this.persist(true);
    });
    this.createActionButton(actions, 'Down', index >= this.getRules().length - 1, async () => {
      this.moveRule(index, index + 1);
      await this.persist(true);
    });
    this.createActionButton(actions, 'Duplicate', false, async () => {
      this.getRules().splice(index + 1, 0, this.cloneRule(rule));
      await this.persist(true);
    });
    this.createActionButton(actions, 'Delete', false, async () => {
      this.getRules().splice(index, 1);
      await this.persist(true);
    });
  }

  private renderConditionList(parent: HTMLElement, rule: HideRule, syncSummary: () => void): void {
    const conditions = this.ensureConditions(rule);
    const list = parent.createDiv({ cls: 'tps-gcm-condition-list' });

    if (conditions.length === 0) {
      list.createEl('p', {
        cls: 'setting-item-description',
        text: 'No conditions configured. This rule matches all notes.',
      });
    }

    conditions.forEach((condition, index) => {
      const row = list.createDiv({ cls: 'tps-gcm-condition-row' });

      new Setting(row).setClass('tps-gcm-no-border').setName('Source').addDropdown((dropdown) => {
        NOTEBOOK_NAVIGATOR_RULE_SOURCE_OPTIONS.forEach((option) => dropdown.addOption(option.value, option.label));
        dropdown.setValue(normalizeConditionSource(condition.source)).onChange(async (value) => {
          condition.source = normalizeConditionSource(value);
          if (!usesConditionField(condition.source)) {
            condition.field = '';
          } else if (!String(condition.field || '').trim()) {
            condition.field = getDefaultField(condition.source);
          }
          condition.operator = normalizeSmartOperator(condition.source, condition.operator);
          if (!usesConditionValue(condition.operator)) {
            condition.value = '';
          }
          await this.persist(true);
        });
      });

      new Setting(row).setClass('tps-gcm-no-border').setName('Field').addText((textInput) => {
        textInput.setPlaceholder(getDefaultField(condition.source));
        textInput.setValue(condition.field || '');
        textInput.setDisabled(!usesConditionField(condition.source));
        this.bindText(textInput, async (value) => {
          condition.field = value.trim();
        });
      });

      new Setting(row).setClass('tps-gcm-no-border').setName('Operator').addDropdown((dropdown) => {
        getOperatorsForSource(condition.source).forEach((operator) => dropdown.addOption(operator, operator));
        dropdown.setValue(normalizeSmartOperator(condition.source, condition.operator)).onChange(async (value) => {
          condition.operator = normalizeSmartOperator(condition.source, value);
          if (!usesConditionValue(condition.operator)) {
            condition.value = '';
          }
          await this.persist(true);
        });
      });

      new Setting(row).setClass('tps-gcm-no-border').setName('Value').addText((textInput) => {
        textInput.setPlaceholder(getConditionPlaceholder(condition));
        textInput.setValue(condition.value || '');
        textInput.setDisabled(!usesConditionValue(condition.operator));
        this.bindText(textInput, async (value) => {
          condition.value = value;
        });
      });

      new Setting(row).setClass('tps-gcm-no-border').setName('').addButton((button) => button
        .setIcon('trash')
        .setTooltip(`Remove condition ${index + 1}`)
        .onClick(async () => {
          this.ensureConditions(rule).splice(index, 1);
          syncSummary();
          await this.persist(true);
        }));
    });

    new Setting(parent)
      .addButton((button) => button
        .setButtonText('Add condition')
        .onClick(async () => {
          this.ensureConditions(rule).push(createDefaultCondition());
          syncSummary();
          await this.persist(true);
        }));
  }

  private createActionButton(parent: HTMLElement, text: string, disabled: boolean, onClick: () => Promise<void>): void {
    const button = new ButtonComponent(parent)
      .setButtonText(text)
      .setDisabled(disabled)
      .onClick(async () => {
        if (!disabled) await onClick();
      });
    button.buttonEl.addClass('tps-gcm-rule-action-btn');
  }

  private bindText(text: TextComponent, commit: (value: string) => Promise<void>): void {
    let value = text.getValue();
    text.onChange((next) => {
      value = next;
    });
    const save = async () => {
      await commit(value);
      await this.persist(false);
    };
    text.inputEl.addEventListener('blur', () => {
      void save();
    });
    text.inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        text.inputEl.blur();
      }
    });
  }

  private ensureConditions(rule: HideRule): RuleCondition[] {
    if (!Array.isArray(rule.conditions)) rule.conditions = [];
    return rule.conditions;
  }

  private normalizeTagName(value: string): string {
    return String(value || '').trim().replace(/^#+/, '');
  }

  private getConditionSummary(conditions: RuleCondition[], match: unknown): string {
    const count = Array.isArray(conditions) ? conditions.length : 0;
    return count === 0 ? 'matches all notes' : `${count} condition${count === 1 ? '' : 's'} (${normalizeMatchMode(match)})`;
  }

  private createDefaultHideRule(): HideRule {
    return {
      id: `tag-rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: '',
      enabled: true,
      match: 'all',
      conditions: [],
      mode: 'add',
      tagName: 'hide',
    };
  }

  private cloneRule(rule: HideRule): HideRule {
    return {
      ...rule,
      id: `tag-rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      conditions: (rule.conditions || []).map((condition) => ({ ...condition })),
    };
  }

  private moveRule(from: number, to: number): void {
    if (to < 0 || to >= this.getRules().length || from === to) return;
    const [rule] = this.getRules().splice(from, 1);
    if (!rule) return;
    this.getRules().splice(to, 0, rule);
  }

  private getRules(): HideRule[] {
    if (!Array.isArray(this.options.plugin.settings.notebookNavigatorHideRules)) {
      this.options.plugin.settings.notebookNavigatorHideRules = [];
    }
    return this.options.plugin.settings.notebookNavigatorHideRules;
  }

  private async persist(structureChanged: boolean): Promise<void> {
    await this.options.plugin.saveSettings();
    await this.options.onRefreshConsumers();
    if (structureChanged) this.options.onStructureChange();
  }

  private async applyCompanionMethod(method: 'applyRulesToActiveFile' | 'applyRulesToAllFiles', silent: boolean): Promise<void> {
    const companion = (this.options.app as any)?.plugins?.getPlugin?.('tps-notebook-navigator-companion')
      ?? (this.options.app as any)?.plugins?.plugins?.['tps-notebook-navigator-companion'];
    if (!companion?.[method]) {
      new Notice('Notebook Navigator Companion is not available.');
      return;
    }
    await companion[method](silent);
  }

  private matchesFilter(rule: HideRule, ruleNumber: number, rawQuery: string): boolean {
    const query = String(rawQuery || '').trim().toLowerCase();
    if (!query) return true;
    const haystack = [
      `rule ${ruleNumber}`,
      String(rule.name || ''),
      String(rule.tagName || ''),
      rule.mode,
      rule.enabled ? 'enabled' : 'disabled',
      this.getConditionSummary(rule.conditions || [], rule.match),
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  }
}
