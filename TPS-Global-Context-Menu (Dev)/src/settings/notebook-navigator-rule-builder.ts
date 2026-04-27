import { App, ButtonComponent, Modal, Notice, Setting, TextComponent, getIconIds, setIcon } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import type { IconColorRule, RuleCondition, RuleConditionSource, RuleMatchMode, RuleOperator, SmartRuleOperator } from '../../../TPS-Notebook-Navigator-Companion (Dev)/src/types';

type RuleEditorMode = 'simple' | 'conditions';

type RuleBuilderOptions = {
  app: App;
  plugin: TPSGlobalContextMenuPlugin;
  containerEl: HTMLElement;
  onStructureChange: () => void;
  onRefreshConsumers: () => Promise<void>;
};

const RULE_SOURCE_OPTIONS: Array<{ value: RuleConditionSource; label: string }> = [
  { value: 'frontmatter', label: 'Frontmatter' },
  { value: 'path', label: 'Folder path' },
  { value: 'extension', label: 'Extension' },
  { value: 'name', label: 'Note name' },
  { value: 'tag', label: 'Tag' },
  { value: 'tag-note-name', label: 'Tag note name' },
  { value: 'body', label: 'Body text' },
  { value: 'backlink', label: 'Backlink' },
  { value: 'date-created', label: 'Created date' },
  { value: 'date-modified', label: 'Modified date' },
  { value: 'parent-frontmatter', label: 'Parent frontmatter' },
  { value: 'parent-tag', label: 'Parent tag' },
  { value: 'parent-name', label: 'Parent name' },
  { value: 'parent-path', label: 'Parent path' },
];

const SIMPLE_OPERATORS: RuleOperator[] = ['is', '!is', 'contains', '!contains', 'exists', '!exists'];

const QUICK_ICON_OPTIONS = [
  'check-square-2',
  'clipboard-list',
  'clipboard-check',
  'clipboard-x',
  'triangle-alert',
  'archive',
  'calendar',
  'clock-3',
  'folder',
  'file-text',
];

const QUICK_COLORS = ['#4caf50', '#478fee', '#e49320', '#d34f56', '#8656ae', '#2f482e', '#a0a5b8', ''];

export class NotebookNavigatorRuleBuilder {
  private filterQuery = '';

  constructor(private readonly options: RuleBuilderOptions) {}

  render(): void {
    const { containerEl } = this.options;
    containerEl.empty();

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Build first-match icon/color rules visually. Use simple mode for one property check or advanced mode for mixed conditions.',
    });

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
        this.getRules().push(this.createDefaultRule());
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
        text: this.getRules().length === 0 ? 'No icon/color rules configured.' : 'No rules match the current filter.',
      });
      return;
    }

    const listEl = containerEl.createDiv({ cls: 'tps-gcm-rule-builder-list' });
    visibleRules.forEach(({ rule, index }) => this.renderRuleCard(listEl, rule, index));
  }

  private renderRuleCard(parent: HTMLElement, rule: IconColorRule, index: number): void {
    const details = parent.createEl('details', { cls: 'tps-gcm-rule-card' });
    if (index === 0 || !this.filterQuery) {
      details.open = true;
    }

    const summary = details.createEl('summary', { cls: 'tps-gcm-rule-card-summary' });
    const iconPreview = summary.createSpan({ cls: 'tps-gcm-rule-card-summary-icon' });
    this.renderIconPreview(iconPreview, rule.icon, rule.color);

    const summaryText = summary.createDiv({ cls: 'tps-gcm-rule-card-summary-text' });
    const titleEl = summaryText.createDiv({ cls: 'tps-gcm-rule-card-summary-title' });
    const metaEl = summaryText.createDiv({ cls: 'tps-gcm-rule-card-summary-meta' });
    const syncSummary = () => {
      titleEl.setText(String(rule.name || '').trim() || `Rule ${index + 1}`);
      metaEl.setText(`${rule.enabled ? 'Enabled' : 'Disabled'} - ${this.getRuleSummary(rule)}`);
    };
    syncSummary();

    const body = details.createDiv({ cls: 'tps-gcm-rule-card-body' });

    const previewState = this.getActiveRulePreview(rule);
    if (previewState) {
      body.createDiv({
        cls: 'tps-gcm-rule-card-preview',
        text: previewState,
      });
    }

    new Setting(body)
      .setName('Display name')
      .setDesc('Optional label shown in the rule list.')
      .addText((text) => {
        text.setPlaceholder('Working items');
        text.setValue(rule.name || '');
        this.bindText(text, async (value) => {
          rule.name = value.trim();
          syncSummary();
        });
      });

    new Setting(body)
      .setName('Enabled')
      .setDesc('Disable the rule without deleting it.')
      .addToggle((toggle) => toggle.setValue(rule.enabled !== false).onChange(async (value) => {
        rule.enabled = value;
        syncSummary();
        await this.persist(false);
      }));

    const editorMode = this.getEditorMode(rule);
    new Setting(body)
      .setName('Rule editor mode')
      .setDesc('Simple mode is one property check. Advanced mode supports mixed condition sources.')
      .addDropdown((dropdown) => dropdown
        .addOption('simple', 'Simple')
        .addOption('conditions', 'Advanced conditions')
        .setValue(editorMode)
        .onChange(async (value: RuleEditorMode) => {
          if (value === 'conditions') {
            this.convertRuleToConditionMode(rule);
          } else {
            this.convertRuleToSimpleMode(rule);
          }
          await this.persist(true);
        }));

    const criteriaSection = body.createDiv({ cls: 'tps-gcm-rule-card-section' });
    criteriaSection.createEl('h5', { text: 'Match Criteria' });
    if (this.getEditorMode(rule) === 'conditions') {
      this.renderConditionEditor(criteriaSection, rule, syncSummary);
    } else {
      this.renderSimpleEditor(criteriaSection, rule, syncSummary);
    }

    const outputsSection = body.createDiv({ cls: 'tps-gcm-rule-card-section' });
    outputsSection.createEl('h5', { text: 'Outputs' });
    this.renderOutputsEditor(outputsSection, rule, iconPreview, syncSummary);

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

  private renderSimpleEditor(parent: HTMLElement, rule: IconColorRule, syncSummary: () => void): void {
    new Setting(parent)
      .setName('Frontmatter property')
      .setDesc('Use `folderpath` to match against the note folder path.')
      .addText((text) => {
        text.setPlaceholder('status');
        text.setValue(rule.property || '');
        this.bindText(text, async (value) => {
          rule.property = value.trim();
          syncSummary();
        });
      });

    new Setting(parent)
      .setName('Operator')
      .addDropdown((dropdown) => {
        SIMPLE_OPERATORS.forEach((operator) => dropdown.addOption(operator, operator));
        dropdown.setValue(this.normalizeSimpleOperator(rule.operator)).onChange(async (value) => {
          rule.operator = this.normalizeSimpleOperator(value);
          syncSummary();
          await this.persist(false);
          this.render();
        });
      });

    new Setting(parent)
      .setName('Value')
      .setDesc('Unused for `exists` and `!exists`.')
      .addText((text) => {
        text.setPlaceholder('working');
        text.setValue(rule.value || '');
        text.setDisabled(rule.operator === 'exists' || rule.operator === '!exists');
        this.bindText(text, async (value) => {
          rule.value = value;
          syncSummary();
        });
      });

    new Setting(parent)
      .setName('Path prefix filter')
      .setDesc('Optional folder prefix that must also match.')
      .addText((text) => {
        text.setPlaceholder('Projects/Active');
        text.setValue(rule.pathPrefix || '');
        this.bindText(text, async (value) => {
          rule.pathPrefix = value.trim();
        });
      });
  }

  private renderConditionEditor(parent: HTMLElement, rule: IconColorRule, syncSummary: () => void): void {
    new Setting(parent)
      .setName('Condition match mode')
      .setDesc('Choose whether all conditions must match or any one condition can match.')
      .addDropdown((dropdown) => dropdown
        .addOption('all', 'All conditions')
        .addOption('any', 'Any condition')
        .setValue(this.normalizeMatchMode(rule.match))
        .onChange(async (value: RuleMatchMode) => {
          rule.match = this.normalizeMatchMode(value);
          syncSummary();
          await this.persist(false);
        }));

    const conditions = this.ensureConditions(rule);
    const list = parent.createDiv({ cls: 'tps-gcm-condition-list' });

    if (conditions.length === 0) {
      list.createEl('p', {
        cls: 'setting-item-description',
        text: 'No conditions yet. Add one below.',
      });
    }

    conditions.forEach((condition, conditionIndex) => {
      const row = list.createDiv({ cls: 'tps-gcm-condition-row' });
      const sourceSetting = new Setting(row).setClass('tps-gcm-no-border');
      sourceSetting.setName('Source');
      sourceSetting.addDropdown((dropdown) => {
        RULE_SOURCE_OPTIONS.forEach((option) => dropdown.addOption(option.value, option.label));
        dropdown.setValue(this.normalizeConditionSource(condition.source)).onChange(async (value) => {
          condition.source = this.normalizeConditionSource(value);
          if (!this.usesConditionField(condition.source)) {
            condition.field = '';
          } else if (!String(condition.field || '').trim()) {
            condition.field = this.getDefaultField(condition.source);
          }
          condition.operator = this.normalizeSmartOperator(this.getDefaultOperator(condition.source));
          if (!this.usesConditionValue(condition.operator)) {
            condition.value = '';
          }
          await this.persist(true);
        });
      });

      const fieldSetting = new Setting(row).setClass('tps-gcm-no-border');
      fieldSetting.setName('Field');
      fieldSetting.addText((text) => {
        text.setPlaceholder(this.getDefaultField(condition.source));
        text.setValue(condition.field || '');
        text.setDisabled(!this.usesConditionField(condition.source));
        this.bindText(text, async (value) => {
          condition.field = value.trim();
        });
      });

      const operatorSetting = new Setting(row).setClass('tps-gcm-no-border');
      operatorSetting.setName('Operator');
      operatorSetting.addDropdown((dropdown) => {
        this.getOperatorsForSource(condition.source).forEach((operator) => dropdown.addOption(operator, operator));
        dropdown.setValue(this.normalizeSmartOperator(condition.operator)).onChange(async (value) => {
          condition.operator = this.normalizeSmartOperator(value);
          if (!this.usesConditionValue(condition.operator)) {
            condition.value = '';
          }
          await this.persist(true);
        });
      });

      const valueSetting = new Setting(row).setClass('tps-gcm-no-border');
      valueSetting.setName('Value');
      valueSetting.addText((text) => {
        text.setPlaceholder(this.getConditionPlaceholder(condition));
        text.setValue(condition.value || '');
        text.setDisabled(!this.usesConditionValue(condition.operator));
        this.bindText(text, async (value) => {
          condition.value = value;
        });
      });

      const removeSetting = new Setting(row).setClass('tps-gcm-no-border');
      removeSetting.setName('');
      removeSetting.addButton((button) => button
        .setIcon('trash')
        .setTooltip(`Remove condition ${conditionIndex + 1}`)
        .onClick(async () => {
          this.ensureConditions(rule).splice(conditionIndex, 1);
          syncSummary();
          await this.persist(true);
        }));
    });

    new Setting(parent)
      .addButton((button) => button
        .setButtonText('Add condition')
        .onClick(async () => {
          this.ensureConditions(rule).push(this.createDefaultCondition());
          syncSummary();
          await this.persist(true);
        }));
  }

  private renderOutputsEditor(
    parent: HTMLElement,
    rule: IconColorRule,
    summaryIcon: HTMLElement,
    syncSummary: () => void,
  ): void {
    const preview = parent.createDiv({ cls: 'tps-gcm-output-preview' });
    const previewIcon = preview.createSpan({ cls: 'tps-gcm-output-preview-icon' });
    const previewText = preview.createSpan({ cls: 'tps-gcm-output-preview-text' });
    const syncOutputPreview = () => {
      this.renderIconPreview(previewIcon, rule.icon, rule.color);
      this.renderIconPreview(summaryIcon, rule.icon, rule.color);
      previewText.setText(rule.icon ? `${rule.icon}${rule.color ? ` - ${rule.color}` : ''}` : 'No icon output');
      syncSummary();
    };
    syncOutputPreview();

    const iconSetting = new Setting(parent)
      .setName('Icon')
      .setDesc('Pick a Lucide icon or type a custom icon id.');
    iconSetting.addButton((button) => button
      .setButtonText('Browse Icons')
      .onClick(() => {
        new RuleIconPickerModal(this.options.app, rule.icon, async (value) => {
          rule.icon = value;
          syncOutputPreview();
          await this.persist(false);
        }).open();
      }));
    iconSetting.addText((text) => {
      text.setPlaceholder('lucide:file-text');
      text.setValue(rule.icon || '');
      this.bindText(text, async (value) => {
        rule.icon = value.trim();
        syncOutputPreview();
      });
    });

    const quickIcons = parent.createDiv({ cls: 'tps-gcm-quick-icon-row' });
    QUICK_ICON_OPTIONS.forEach((iconId) => {
      const button = quickIcons.createEl('button', { cls: 'tps-gcm-quick-icon-btn' });
      button.type = 'button';
      setIcon(button, iconId);
      button.title = iconId;
      if (rule.icon === `lucide:${iconId}` || rule.icon === iconId) {
        button.addClass('is-active');
      }
      button.addEventListener('click', async () => {
        rule.icon = `lucide:${iconId}`;
        syncOutputPreview();
        await this.persist(true);
      });
    });

    const colorSetting = new Setting(parent)
      .setName('Color')
      .setDesc('CSS color, hex value, or theme variable. Leave blank for no override.');
    colorSetting.addText((text) => {
      text.setPlaceholder('#4caf50 or var(--interactive-accent)');
      text.setValue(rule.color || '');
      this.bindText(text, async (value) => {
        rule.color = value.trim();
        syncOutputPreview();
      });
    });
    colorSetting.addExtraButton((button) => button
      .setIcon('x')
      .setTooltip('Clear color')
      .onClick(async () => {
        rule.color = '';
        syncOutputPreview();
        await this.persist(true);
      }));

    const swatches = parent.createDiv({ cls: 'tps-gcm-color-swatch-row' });
    QUICK_COLORS.forEach((color) => {
      const button = swatches.createEl('button', { cls: 'tps-gcm-color-swatch' });
      button.type = 'button';
      button.title = color || 'No color';
      if (color) {
        button.style.backgroundColor = color;
      } else {
        button.addClass('is-empty');
        button.setText('None');
      }
      if ((rule.color || '') === color) {
        button.addClass('is-active');
      }
      button.addEventListener('click', async () => {
        rule.color = color;
        syncOutputPreview();
        await this.persist(true);
      });
    });
  }

  private createActionButton(parent: HTMLElement, text: string, disabled: boolean, onClick: () => Promise<void>): void {
    const button = new ButtonComponent(parent)
      .setButtonText(text)
      .setDisabled(disabled)
      .onClick(async () => {
        if (disabled) return;
        await onClick();
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

  private async persist(structureChanged: boolean): Promise<void> {
    await this.options.plugin.saveSettings();
    await this.options.onRefreshConsumers();
    if (structureChanged) {
      this.options.onStructureChange();
    }
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

  private getActiveRulePreview(rule: IconColorRule): string | null {
    const companion = (this.options.app as any)?.plugins?.getPlugin?.('tps-notebook-navigator-companion')
      ?? (this.options.app as any)?.plugins?.plugins?.['tps-notebook-navigator-companion'];
    const matches = companion?.getRuleMatchForActiveFile?.(rule);
    if (matches == null) {
      return null;
    }
    return `Active note preview: ${matches ? 'matches' : 'does not match'}.`;
  }

  private getRules(): IconColorRule[] {
    if (!Array.isArray(this.options.plugin.settings.notebookNavigatorRules)) {
      this.options.plugin.settings.notebookNavigatorRules = [];
    }
    return this.options.plugin.settings.notebookNavigatorRules;
  }

  private createDefaultRule(): IconColorRule {
    return {
      id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: '',
      enabled: true,
      property: 'status',
      operator: 'is',
      value: '',
      pathPrefix: '',
      icon: '',
      color: '',
      match: 'all',
      conditions: [],
    };
  }

  private cloneRule(rule: IconColorRule): IconColorRule {
    return {
      ...rule,
      id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      conditions: (rule.conditions || []).map((condition) => ({ ...condition })),
    };
  }

  private moveRule(from: number, to: number): void {
    if (to < 0 || to >= this.getRules().length || from === to) return;
    const [rule] = this.getRules().splice(from, 1);
    if (!rule) return;
    this.getRules().splice(to, 0, rule);
  }

  private getEditorMode(rule: IconColorRule): RuleEditorMode {
    return Array.isArray(rule.conditions) && rule.conditions.length > 0 ? 'conditions' : 'simple';
  }

  private convertRuleToConditionMode(rule: IconColorRule): void {
    const property = String(rule.property || '').trim();
    const conditions: RuleCondition[] = [];
    if (property) {
      conditions.push({
        source: property.toLowerCase() === 'folderpath' ? 'path' : 'frontmatter',
        field: property.toLowerCase() === 'folderpath' ? '' : property,
        operator: this.simpleToSmartOperator(rule.operator),
        value: String(rule.value || ''),
      });
    }
    if (String(rule.pathPrefix || '').trim()) {
      conditions.push({
        source: 'path',
        field: '',
        operator: 'starts',
        value: String(rule.pathPrefix || '').trim(),
      });
    }
    rule.match = 'all';
    rule.conditions = conditions;
  }

  private convertRuleToSimpleMode(rule: IconColorRule): void {
    const frontmatterCondition = (rule.conditions || []).find((condition) =>
      condition.source === 'frontmatter' || condition.source === 'path'
    );
    rule.property = 'status';
    rule.operator = 'is';
    rule.value = '';
    rule.pathPrefix = '';
    if (frontmatterCondition) {
      if (frontmatterCondition.source === 'path') {
        rule.property = 'folderpath';
      } else {
        rule.property = String(frontmatterCondition.field || '').trim() || 'status';
      }
      rule.operator = this.smartToSimpleOperator(frontmatterCondition.operator);
      rule.value = String(frontmatterCondition.value || '');
    }
    const pathPrefix = (rule.conditions || []).find((condition) =>
      condition.source === 'path' &&
      (condition.operator === 'starts' || condition.operator === 'is' || condition.operator === 'contains') &&
      String(condition.value || '').trim().length > 0
    );
    if (pathPrefix) {
      rule.pathPrefix = String(pathPrefix.value || '').trim();
    }
    rule.conditions = [];
    rule.match = 'all';
  }

  private createDefaultCondition(source: RuleConditionSource = 'frontmatter'): RuleCondition {
    return {
      source,
      field: this.usesConditionField(source) ? this.getDefaultField(source) : '',
      operator: this.getDefaultOperator(source),
      value: '',
    };
  }

  private ensureConditions(rule: IconColorRule): RuleCondition[] {
    if (!Array.isArray(rule.conditions)) {
      rule.conditions = [];
    }
    return rule.conditions;
  }

  private normalizeConditionSource(value: unknown): RuleConditionSource {
    const normalized = String(value || '').trim() as RuleConditionSource;
    return RULE_SOURCE_OPTIONS.some((option) => option.value === normalized) ? normalized : 'frontmatter';
  }

  private normalizeMatchMode(value: unknown): RuleMatchMode {
    return value === 'any' ? 'any' : 'all';
  }

  private normalizeSimpleOperator(value: unknown): RuleOperator {
    const normalized = String(value || '').trim() as RuleOperator;
    return SIMPLE_OPERATORS.includes(normalized) ? normalized : 'is';
  }

  private normalizeSmartOperator(value: unknown): SmartRuleOperator {
    const operators = this.getOperatorsForSource('frontmatter');
    const normalized = String(value || '').trim() as SmartRuleOperator;
    return operators.includes(normalized) || this.getOperatorsForSource('body').includes(normalized) ? normalized : 'is';
  }

  private getOperatorsForSource(source: RuleConditionSource): SmartRuleOperator[] {
    const base: SmartRuleOperator[] = ['is', '!is', 'contains', '!contains', 'exists', '!exists', 'is-not-empty', 'starts', '!starts'];
    const dateOps: SmartRuleOperator[] = ['within-next-days', '!within-next-days', 'is-today', '!is-today', 'is-before-today', '!is-before-today', 'is-after-today', '!is-after-today'];

    if (source === 'frontmatter' || source === 'parent-frontmatter' || source === 'date-created' || source === 'date-modified') {
      return [...base, ...dateOps];
    }
    if (source === 'name') {
      return [...base, 'is-today', '!is-today', 'is-before-today', '!is-before-today', 'is-after-today', '!is-after-today'];
    }
    if (source === 'body') {
      return [...base, 'has-open-checkboxes', '!has-open-checkboxes'];
    }
    return base;
  }

  private getDefaultField(source: RuleConditionSource): string {
    if (source === 'frontmatter') return 'status';
    if (source === 'parent-frontmatter') return 'status';
    return '';
  }

  private getDefaultOperator(source: RuleConditionSource): SmartRuleOperator {
    if (source === 'path') return 'contains';
    return 'is';
  }

  private usesConditionField(source: RuleConditionSource): boolean {
    return source === 'frontmatter' || source === 'parent-frontmatter' || source === 'backlink';
  }

  private usesConditionValue(operator: SmartRuleOperator): boolean {
    return !['exists', '!exists', 'has-open-checkboxes', '!has-open-checkboxes', 'is-today', '!is-today', 'is-before-today', '!is-before-today', 'is-after-today', '!is-after-today', 'is-not-empty'].includes(operator);
  }

  private simpleToSmartOperator(operator: RuleOperator): SmartRuleOperator {
    return operator === '!is' || operator === 'contains' || operator === '!contains' || operator === 'exists' || operator === '!exists'
      ? operator
      : 'is';
  }

  private smartToSimpleOperator(operator: SmartRuleOperator): RuleOperator {
    if (operator === 'contains' || operator === '!contains' || operator === 'exists' || operator === '!exists' || operator === '!is') {
      return operator;
    }
    return 'is';
  }

  private getConditionPlaceholder(condition: RuleCondition): string {
    if (condition.operator === 'within-next-days' || condition.operator === '!within-next-days') return '7';
    if (condition.source === 'path' || condition.source === 'parent-path') return 'Projects/Active';
    if (condition.source === 'extension') return 'md';
    if (condition.source === 'name' || condition.source === 'parent-name') return 'Daily Standup';
    if (condition.source === 'tag' || condition.source === 'parent-tag') return 'hide';
    if (condition.source === 'tag-note-name') return 'Tag page title';
    if (condition.source === 'backlink') return 'Parent Note';
    if (condition.source === 'body') return 'checkbox';
    const field = String(condition.field || '').trim().toLowerCase();
    if (field === 'status') return 'working';
    if (field === 'priority') return 'normal';
    if (field === 'scheduled' || field === 'due') return '2026-02-12 14:45:00';
    return 'value';
  }

  private renderIconPreview(container: HTMLElement, rawIcon: string, color: string): void {
    container.empty();
    container.style.color = String(color || '').trim() || 'var(--text-muted)';
    const iconId = this.normalizeIconIdForPreview(rawIcon);
    if (!iconId) {
      container.setText('—');
      return;
    }
    try {
      setIcon(container, iconId);
    } catch {
      container.setText('?');
    }
  }

  private normalizeIconIdForPreview(rawIcon: string): string {
    const icon = String(rawIcon || '').trim();
    if (!icon) return '';
    if (icon.startsWith('lucide:')) return icon.slice('lucide:'.length).trim();
    if (icon.startsWith('lucide-')) return icon.slice('lucide-'.length).trim();
    return icon;
  }

  private getRuleSummary(rule: IconColorRule): string {
    if (Array.isArray(rule.conditions) && rule.conditions.length > 0) {
      return `${rule.conditions.length} conditions (${this.normalizeMatchMode(rule.match)})`;
    }
    const property = String(rule.property || '').trim() || '(property)';
    const value = rule.operator === 'exists' || rule.operator === '!exists' ? '' : ` ${String(rule.value || '').trim()}`;
    return `${property} ${rule.operator}${value}`.trim();
  }

  private matchesFilter(rule: IconColorRule, ruleNumber: number, rawQuery: string): boolean {
    const query = String(rawQuery || '').trim().toLowerCase();
    if (!query) return true;
    const haystack = [
      `rule ${ruleNumber}`,
      String(rule.name || ''),
      this.getRuleSummary(rule),
      String(rule.icon || ''),
      String(rule.color || ''),
      rule.enabled ? 'enabled' : 'disabled',
      this.getEditorMode(rule) === 'conditions' ? 'advanced' : 'simple',
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  }
}

class RuleIconPickerModal extends Modal {
  private readonly iconIds = getIconIds().slice().sort((a, b) => a.localeCompare(b));
  private query = '';

  constructor(
    app: App,
    private readonly currentValue: string,
    private readonly onChoose: (value: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('tps-gcm-icon-picker-modal');
    this.titleEl.setText('Choose Icon');
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();

    const search = contentEl.createEl('input', {
      cls: 'tps-gcm-icon-picker-search',
      attr: { type: 'search', placeholder: 'Search icons...' },
    });
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value.trim().toLowerCase();
      this.render();
    });

    const current = contentEl.createDiv({ cls: 'tps-gcm-icon-picker-current' });
    current.createSpan({ text: 'Current:' });
    const currentPreview = current.createSpan({ cls: 'tps-gcm-icon-picker-current-preview' });
    const normalized = this.normalizeIconId(this.currentValue);
    if (normalized) {
      try {
        setIcon(currentPreview, normalized);
      } catch {
        currentPreview.setText('?');
      }
    } else {
      currentPreview.setText('—');
    }
    current.createSpan({ text: this.currentValue || '(none)' });

    const grid = contentEl.createDiv({ cls: 'tps-gcm-icon-picker-grid' });
    this.createIconButton(grid, '(none)', '', false);

    const visibleIcons = this.iconIds.filter((iconId) => !this.query || iconId.toLowerCase().includes(this.query));
    visibleIcons.forEach((iconId) => this.createIconButton(grid, iconId, `lucide:${iconId}`, true));

    const currentCustom = String(this.currentValue || '').trim();
    if (currentCustom && !currentCustom.startsWith('lucide:') && !this.iconIds.includes(currentCustom)) {
      this.createIconButton(grid, `${currentCustom} (current custom)`, currentCustom, false);
    }

    if (visibleIcons.length === 0) {
      grid.createEl('p', {
        cls: 'setting-item-description',
        text: 'No icons match the current search.',
      });
    }
  }

  private createIconButton(parent: HTMLElement, label: string, value: string, renderIcon: boolean): void {
    const button = parent.createEl('button', { cls: 'tps-gcm-icon-picker-item' });
    button.type = 'button';
    const iconEl = button.createSpan({ cls: 'tps-gcm-icon-picker-item-icon' });
    if (renderIcon) {
      try {
        setIcon(iconEl, this.normalizeIconId(value));
      } catch {
        iconEl.setText('?');
      }
    } else {
      iconEl.setText(value ? '*' : '—');
    }
    button.createSpan({ cls: 'tps-gcm-icon-picker-item-label', text: label });
    if (value === this.currentValue) {
      button.addClass('is-active');
    }
    button.addEventListener('click', async () => {
      await this.onChoose(value);
      this.close();
    });
  }

  private normalizeIconId(rawIcon: string): string {
    const icon = String(rawIcon || '').trim();
    if (icon.startsWith('lucide:')) return icon.slice('lucide:'.length).trim();
    if (icon.startsWith('lucide-')) return icon.slice('lucide-'.length).trim();
    return icon;
  }
}
