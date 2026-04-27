import { App, ButtonComponent, Notice, Setting, TextComponent } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import type { RuleCondition, SortBucket, SortCriteria, SortFieldType, SmartSortSettings } from '../../../TPS-Notebook-Navigator-Companion (Dev)/src/types';
import {
  NOTEBOOK_NAVIGATOR_RULE_SOURCE_OPTIONS,
  createDefaultCondition,
  getConditionPlaceholder,
  getDefaultField,
  normalizeConditionSource,
  normalizeMatchMode,
  normalizeSmartOperator,
  parseMappings,
  stringifyMappings,
  getOperatorsForSource,
  usesConditionField,
  usesConditionValue,
} from './notebook-navigator-builder-common';

type SmartSortBuilderOptions = {
  app: App;
  plugin: TPSGlobalContextMenuPlugin;
  containerEl: HTMLElement;
  onStructureChange: () => void;
  onRefreshConsumers: () => Promise<void>;
};

const PRIORITY_MAPPING = 'high=001, medium=002, low=003';
const STATUS_MAPPING = 'todo=001, working=002, holding=003, complete=004, wont-do=005';
const SORT_SOURCE_OPTIONS = [
  'frontmatter',
  'parent-frontmatter',
  'name',
  'parent-name',
  'path',
  'parent-path',
  'tag',
  'parent-tag',
  'tag-note-name',
  'extension',
] as const;
const SORT_TYPE_OPTIONS: SortFieldType[] = ['date', 'status', 'priority', 'text', 'number'];

export class NotebookNavigatorSmartSortBuilder {
  private filterQuery = '';

  constructor(private readonly options: SmartSortBuilderOptions) {}

  render(): void {
    const { containerEl } = this.options;
    containerEl.empty();

    containerEl.createEl('h4', { text: 'Smart Sort' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Build smart sort buckets visually. Buckets are checked top-to-bottom and the first match wins.',
    });

    const preview = this.getSmartSortPreview();
    if (preview) {
      containerEl.createDiv({
        cls: 'tps-gcm-rule-card-preview',
        text: `Active note key preview: ${preview}`,
      });
    }

    this.renderSettingsBlock(containerEl, this.getSettings());

    const toolbar = containerEl.createDiv({ cls: 'tps-gcm-rule-builder-toolbar' });
    const filterInput = toolbar.createEl('input', {
      cls: 'tps-gcm-rule-builder-filter',
      attr: { type: 'search', placeholder: 'Filter sort buckets...' },
    });
    filterInput.value = this.filterQuery;
    filterInput.addEventListener('input', () => {
      this.filterQuery = filterInput.value.trim().toLowerCase();
      this.render();
    });

    new ButtonComponent(toolbar)
      .setButtonText('Add Bucket')
      .setCta()
      .onClick(async () => {
        this.getBuckets().push(this.createDefaultBucket());
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

    const visibleBuckets = this.getBuckets()
      .map((bucket, index) => ({ bucket, index }))
      .filter(({ bucket, index }) => this.matchesFilter(bucket, index + 1, this.filterQuery));

    if (visibleBuckets.length === 0) {
      containerEl.createEl('p', {
        cls: 'setting-item-description',
        text: this.getBuckets().length === 0 ? 'No sort buckets configured.' : 'No sort buckets match the current filter.',
      });
      return;
    }

    const listEl = containerEl.createDiv({ cls: 'tps-gcm-rule-builder-list' });
    visibleBuckets.forEach(({ bucket, index }) => this.renderBucketCard(listEl, bucket, index));
  }

  private renderSettingsBlock(parent: HTMLElement, settings: SmartSortSettings): void {
    const block = parent.createDiv({ cls: 'tps-gcm-settings-block' });
    new Setting(block)
      .setName('Enable smart sort key')
      .setDesc('Write a computed sort key to frontmatter.')
      .addToggle((toggle) => toggle.setValue(settings.enabled).onChange(async (value) => {
        settings.enabled = value;
        await this.persist(false);
      }));

    new Setting(block)
      .setName('Sort key field')
      .setDesc('Frontmatter key used for the generated sort key.')
      .addText((text) => {
        text.setPlaceholder('navigator_sort');
        text.setValue(settings.field || 'navigator_sort');
        this.bindText(text, async (value) => {
          settings.field = value.trim().replace(/\s+/g, '') || 'navigator_sort';
        });
      });

    new Setting(block)
      .setName('Segment separator')
      .setDesc('Delimiter used between sort segments.')
      .addText((text) => {
        text.setPlaceholder('_');
        text.setValue(settings.separator || '_');
        this.bindText(text, async (value) => {
          settings.separator = value.trim().slice(0, 3) || '_';
        });
      });

    new Setting(block)
      .setName('Append basename')
      .setDesc('Append note basename as the last segment.')
      .addToggle((toggle) => toggle.setValue(settings.appendBasename).onChange(async (value) => {
        settings.appendBasename = value;
        await this.persist(false);
      }));

    new Setting(block)
      .setName('Relationship grouping')
      .setDesc('Optionally keep child notes grouped under their parent sort prefix.')
      .addDropdown((dropdown) => dropdown
        .addOption('none', 'None')
        .addOption('children-under-parent', 'Children under parent')
        .setValue(settings.relationshipGrouping)
        .onChange(async (value) => {
          settings.relationshipGrouping = value === 'children-under-parent' ? 'children-under-parent' : 'none';
          await this.persist(false);
        }));

    new Setting(block)
      .setName('Clear key when no bucket matches')
      .setDesc('Remove the sort field when no bucket produces a key.')
      .addToggle((toggle) => toggle.setValue(settings.clearWhenNoMatch).onChange(async (value) => {
        settings.clearWhenNoMatch = value;
        await this.persist(false);
      }));
  }

  private renderBucketCard(parent: HTMLElement, bucket: SortBucket, index: number): void {
    const details = parent.createEl('details', { cls: 'tps-gcm-rule-card' });
    if (index === 0 || !this.filterQuery) details.open = true;

    const summary = details.createEl('summary', { cls: 'tps-gcm-rule-card-summary' });
    summary.createSpan({ cls: 'tps-gcm-rule-chip', text: String(index + 1) });
    const text = summary.createDiv({ cls: 'tps-gcm-rule-card-summary-text' });
    const title = text.createDiv({ cls: 'tps-gcm-rule-card-summary-title' });
    const meta = text.createDiv({ cls: 'tps-gcm-rule-card-summary-meta' });
    const syncSummary = () => {
      title.setText(String(bucket.name || '').trim() || `Bucket ${index + 1}`);
      meta.setText(`${bucket.enabled ? 'Enabled' : 'Disabled'} - ${this.getConditionSummary(bucket.conditions, bucket.match)} - ${this.getCriteriaSummary(bucket.sortCriteria)}`);
    };
    syncSummary();

    const body = details.createDiv({ cls: 'tps-gcm-rule-card-body' });
    new Setting(body)
      .setName('Bucket name')
      .setDesc('Label for this sort bucket.')
      .addText((textInput) => {
        textInput.setPlaceholder('Working notes');
        textInput.setValue(bucket.name || '');
        this.bindText(textInput, async (value) => {
          bucket.name = value.trim();
          syncSummary();
        });
      });

    new Setting(body)
      .setName('Enabled')
      .addToggle((toggle) => toggle.setValue(bucket.enabled !== false).onChange(async (value) => {
        bucket.enabled = value;
        syncSummary();
        await this.persist(false);
      }));

    const conditionsSection = body.createDiv({ cls: 'tps-gcm-rule-card-section' });
    conditionsSection.createEl('h5', { text: 'Bucket Match Criteria' });
    new Setting(conditionsSection)
      .setName('Condition match mode')
      .addDropdown((dropdown) => dropdown
        .addOption('all', 'All conditions')
        .addOption('any', 'Any condition')
        .setValue(normalizeMatchMode(bucket.match))
        .onChange(async (value) => {
          bucket.match = normalizeMatchMode(value);
          syncSummary();
          await this.persist(false);
        }));
    this.renderConditionList(conditionsSection, bucket, syncSummary);

    const criteriaSection = body.createDiv({ cls: 'tps-gcm-rule-card-section' });
    criteriaSection.createEl('h5', { text: 'Sort Criteria' });
    this.renderCriteriaList(criteriaSection, bucket, syncSummary);

    const actions = body.createDiv({ cls: 'tps-gcm-rule-actions' });
    this.createActionButton(actions, 'Up', index <= 0, async () => {
      this.moveBucket(index, index - 1);
      await this.persist(true);
    });
    this.createActionButton(actions, 'Down', index >= this.getBuckets().length - 1, async () => {
      this.moveBucket(index, index + 1);
      await this.persist(true);
    });
    this.createActionButton(actions, 'Duplicate', false, async () => {
      this.getBuckets().splice(index + 1, 0, this.cloneBucket(bucket));
      await this.persist(true);
    });
    this.createActionButton(actions, 'Delete', false, async () => {
      this.getBuckets().splice(index, 1);
      await this.persist(true);
    });
  }

  private renderConditionList(parent: HTMLElement, bucket: SortBucket, syncSummary: () => void): void {
    const conditions = this.ensureConditions(bucket);
    const list = parent.createDiv({ cls: 'tps-gcm-condition-list' });

    if (conditions.length === 0) {
      list.createEl('p', {
        cls: 'setting-item-description',
        text: 'No conditions configured. This bucket matches all notes.',
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
          if (!usesConditionValue(condition.operator)) condition.value = '';
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
          if (!usesConditionValue(condition.operator)) condition.value = '';
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
          this.ensureConditions(bucket).splice(index, 1);
          syncSummary();
          await this.persist(true);
        }));
    });

    new Setting(parent)
      .addButton((button) => button
        .setButtonText('Add condition')
        .onClick(async () => {
          this.ensureConditions(bucket).push(createDefaultCondition());
          syncSummary();
          await this.persist(true);
        }));
  }

  private renderCriteriaList(parent: HTMLElement, bucket: SortBucket, syncSummary: () => void): void {
    const criteria = this.ensureCriteria(bucket);
    const list = parent.createDiv({ cls: 'tps-gcm-criteria-list' });

    if (criteria.length === 0) {
      list.createEl('p', {
        cls: 'setting-item-description',
        text: 'No sort criteria configured. Matching notes will fall back to basename ordering.',
      });
    }

    criteria.forEach((criterion, index) => {
      const card = list.createDiv({ cls: 'tps-gcm-criterion-card' });
      card.createEl('div', { cls: 'tps-gcm-criterion-title', text: `Criterion ${index + 1}` });

      const row = card.createDiv({ cls: 'tps-gcm-condition-row' });
      new Setting(row).setClass('tps-gcm-no-border').setName('Source').addDropdown((dropdown) => {
        SORT_SOURCE_OPTIONS.forEach((source) => dropdown.addOption(source, source));
        dropdown.setValue(this.normalizeSortSource(criterion.source)).onChange(async (value) => {
          criterion.source = this.normalizeSortSource(value);
          if (criterion.source !== 'frontmatter' && criterion.source !== 'parent-frontmatter') {
            criterion.field = '';
          }
          await this.persist(true);
        });
      });

      new Setting(row).setClass('tps-gcm-no-border').setName('Field').addText((textInput) => {
        textInput.setPlaceholder('scheduled');
        textInput.setValue(criterion.field || '');
        textInput.setDisabled(!(criterion.source === 'frontmatter' || criterion.source === 'parent-frontmatter'));
        this.bindText(textInput, async (value) => {
          criterion.field = value.trim();
        });
      });

      new Setting(row).setClass('tps-gcm-no-border').setName('Type').addDropdown((dropdown) => {
        SORT_TYPE_OPTIONS.forEach((type) => dropdown.addOption(type, type));
        dropdown.setValue(this.normalizeSortType(criterion.type)).setDisabled(!(criterion.source === 'frontmatter' || criterion.source === 'parent-frontmatter')).onChange(async (value) => {
          criterion.type = this.normalizeSortType(value);
          await this.persist(false);
        });
      });

      new Setting(row).setClass('tps-gcm-no-border').setName('Direction').addDropdown((dropdown) => dropdown
        .addOption('asc', 'Ascending')
        .addOption('desc', 'Descending')
        .setValue(criterion.direction)
        .onChange(async (value) => {
          criterion.direction = value === 'desc' ? 'desc' : 'asc';
          await this.persist(false);
        }));

      new Setting(row).setClass('tps-gcm-no-border').setName('Missing').addDropdown((dropdown) => dropdown
        .addOption('last', 'Sort last')
        .addOption('first', 'Sort first')
        .setValue(criterion.missingValuePlacement)
        .onChange(async (value) => {
          criterion.missingValuePlacement = value === 'first' ? 'first' : 'last';
          await this.persist(false);
        }));

      new Setting(card)
        .setName('Value mappings')
        .setDesc('Optional mappings like `high=001, medium=002`.')
        .addText((textInput) => {
          textInput.setPlaceholder('high=001, medium=002, low=003');
          textInput.setValue(stringifyMappings(criterion.mappings));
          this.bindText(textInput, async (value) => {
            criterion.mappings = parseMappings(value);
          });
        });

      if (criterion.type === 'priority' || criterion.type === 'status') {
        const presets = card.createDiv({ cls: 'tps-gcm-rule-actions' });
        if (criterion.type === 'priority') {
          this.createActionButton(presets, 'Priority Preset', false, async () => {
            criterion.mappings = parseMappings(PRIORITY_MAPPING);
            await this.persist(true);
          });
        }
        if (criterion.type === 'status') {
          this.createActionButton(presets, 'Status Preset', false, async () => {
            criterion.mappings = parseMappings(STATUS_MAPPING);
            await this.persist(true);
          });
        }
      }

      const actions = card.createDiv({ cls: 'tps-gcm-rule-actions' });
      this.createActionButton(actions, 'Up', index <= 0, async () => {
        this.moveCriterion(criteria, index, index - 1);
        await this.persist(true);
      });
      this.createActionButton(actions, 'Down', index >= criteria.length - 1, async () => {
        this.moveCriterion(criteria, index, index + 1);
        await this.persist(true);
      });
      this.createActionButton(actions, 'Delete', false, async () => {
        this.ensureCriteria(bucket).splice(index, 1);
        syncSummary();
        await this.persist(true);
      });
    });

    new Setting(parent)
      .addButton((button) => button
        .setButtonText('Add sort criterion')
        .onClick(async () => {
          this.ensureCriteria(bucket).push(this.createDefaultCriterion());
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

  private getSettings(): SmartSortSettings {
    if (!this.options.plugin.settings.notebookNavigatorSmartSort) {
      this.options.plugin.settings.notebookNavigatorSmartSort = {
        enabled: false,
        field: 'navigator_sort',
        separator: '_',
        appendBasename: true,
        relationshipGrouping: 'none',
        clearWhenNoMatch: false,
        buckets: [],
      };
    }
    return this.options.plugin.settings.notebookNavigatorSmartSort;
  }

  private getBuckets(): SortBucket[] {
    if (!Array.isArray(this.getSettings().buckets)) {
      this.getSettings().buckets = [];
    }
    return this.getSettings().buckets;
  }

  private ensureConditions(bucket: SortBucket): RuleCondition[] {
    if (!Array.isArray(bucket.conditions)) bucket.conditions = [];
    return bucket.conditions;
  }

  private ensureCriteria(bucket: SortBucket): SortCriteria[] {
    if (!Array.isArray(bucket.sortCriteria)) bucket.sortCriteria = [];
    return bucket.sortCriteria;
  }

  private createDefaultBucket(): SortBucket {
    return {
      id: `bucket-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      enabled: true,
      name: '',
      match: 'all',
      conditions: [],
      sortCriteria: [],
    };
  }

  private createDefaultCriterion(): SortCriteria {
    return {
      source: 'frontmatter',
      field: 'priority',
      type: 'priority',
      direction: 'asc',
      mappings: [],
      missingValuePlacement: 'last',
    };
  }

  private cloneBucket(bucket: SortBucket): SortBucket {
    return {
      ...bucket,
      id: `bucket-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      conditions: (bucket.conditions || []).map((condition) => ({ ...condition })),
      sortCriteria: (bucket.sortCriteria || []).map((criterion) => ({
        ...criterion,
        mappings: (criterion.mappings || []).map((mapping) => ({ ...mapping })),
      })),
    };
  }

  private moveBucket(from: number, to: number): void {
    if (to < 0 || to >= this.getBuckets().length || from === to) return;
    const [bucket] = this.getBuckets().splice(from, 1);
    if (!bucket) return;
    this.getBuckets().splice(to, 0, bucket);
  }

  private moveCriterion(criteria: SortCriteria[], from: number, to: number): void {
    if (to < 0 || to >= criteria.length || from === to) return;
    const [criterion] = criteria.splice(from, 1);
    if (!criterion) return;
    criteria.splice(to, 0, criterion);
  }

  private normalizeSortSource(value: unknown): SortCriteria['source'] {
    const normalized = String(value || '').trim() as SortCriteria['source'];
    return SORT_SOURCE_OPTIONS.includes(normalized as (typeof SORT_SOURCE_OPTIONS)[number]) ? normalized : 'frontmatter';
  }

  private normalizeSortType(value: unknown): SortFieldType {
    const normalized = String(value || '').trim() as SortFieldType;
    return SORT_TYPE_OPTIONS.includes(normalized) ? normalized : 'text';
  }

  private getConditionSummary(conditions: RuleCondition[], match: unknown): string {
    const count = Array.isArray(conditions) ? conditions.length : 0;
    return count === 0 ? 'matches all notes' : `${count} condition${count === 1 ? '' : 's'} (${normalizeMatchMode(match)})`;
  }

  private getCriteriaSummary(criteria: SortCriteria[]): string {
    const count = Array.isArray(criteria) ? criteria.length : 0;
    return count === 0 ? 'basename fallback only' : `${count} sort criterion${count === 1 ? '' : 'criteria'}`;
  }

  private getSmartSortPreview(): string | null {
    const companion = (this.options.app as any)?.plugins?.getPlugin?.('tps-notebook-navigator-companion')
      ?? (this.options.app as any)?.plugins?.plugins?.['tps-notebook-navigator-companion'];
    return companion?.getSmartSortPreviewForActiveFile?.() ?? null;
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

  private matchesFilter(bucket: SortBucket, bucketNumber: number, rawQuery: string): boolean {
    const query = String(rawQuery || '').trim().toLowerCase();
    if (!query) return true;
    const haystack = [
      `bucket ${bucketNumber}`,
      String(bucket.name || ''),
      bucket.enabled ? 'enabled' : 'disabled',
      this.getConditionSummary(bucket.conditions || [], bucket.match),
      this.getCriteriaSummary(bucket.sortCriteria || []),
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  }
}
