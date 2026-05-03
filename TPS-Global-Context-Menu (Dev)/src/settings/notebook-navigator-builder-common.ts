import type { RuleCondition, RuleConditionSource, RuleMatchMode, SmartRuleOperator, SortValueMapping } from '../types';

export const NOTEBOOK_NAVIGATOR_RULE_SOURCE_OPTIONS: Array<{ value: RuleConditionSource; label: string }> = [
  { value: 'frontmatter', label: 'Frontmatter' },
  { value: 'path', label: 'Actual file path' },
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
  { value: 'parent-path', label: 'Actual parent file path' },
];

export const NOTEBOOK_NAVIGATOR_FOLDERPATH_GUIDANCE =
  'Use Frontmatter + field folderPath for notebook location rules in a root-vault layout. Actual file path only checks the real folder on disk.';

export function normalizeConditionSource(value: unknown): RuleConditionSource {
  const normalized = String(value || '').trim() as RuleConditionSource;
  return NOTEBOOK_NAVIGATOR_RULE_SOURCE_OPTIONS.some((option) => option.value === normalized) ? normalized : 'frontmatter';
}

export function normalizeMatchMode(value: unknown): RuleMatchMode {
  return value === 'any' ? 'any' : 'all';
}

export function getOperatorsForSource(source: RuleConditionSource): SmartRuleOperator[] {
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

export function normalizeSmartOperator(source: RuleConditionSource, value: unknown): SmartRuleOperator {
  const normalized = String(value || '').trim() as SmartRuleOperator;
  return getOperatorsForSource(source).includes(normalized) ? normalized : 'is';
}

export function usesConditionField(source: RuleConditionSource): boolean {
  return source === 'frontmatter' || source === 'parent-frontmatter' || source === 'backlink';
}

export function usesConditionValue(operator: SmartRuleOperator): boolean {
  return !['exists', '!exists', 'is-not-empty', 'has-open-checkboxes', '!has-open-checkboxes', 'is-today', '!is-today', 'is-before-today', '!is-before-today', 'is-after-today', '!is-after-today'].includes(operator);
}

export function getDefaultField(source: RuleConditionSource): string {
  if (source === 'frontmatter' || source === 'parent-frontmatter') return 'status';
  if (source === 'backlink') return 'parent';
  return '';
}

export function getDefaultOperator(source: RuleConditionSource): SmartRuleOperator {
  if (source === 'path' || source === 'parent-path') return 'contains';
  return 'is';
}

export function createDefaultCondition(source: RuleConditionSource = 'frontmatter'): RuleCondition {
  return {
    source,
    field: usesConditionField(source) ? getDefaultField(source) : '',
    operator: getDefaultOperator(source),
    value: '',
  };
}

export function getConditionPlaceholder(condition: RuleCondition): string {
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

export function stringifyMappings(mappings: SortValueMapping[]): string {
  return (mappings || []).map((mapping) => `${mapping.input}=${mapping.output}`).join(', ');
}

export function parseMappings(raw: string): SortValueMapping[] {
  return String(raw || '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .flatMap((pair) => {
      const separator = pair.includes('=') ? '=' : pair.includes(':') ? ':' : '';
      if (!separator) return [];
      const [input, output] = pair.split(separator);
      const normalizedInput = String(input || '').trim();
      const normalizedOutput = String(output || '').trim();
      if (!normalizedInput || !normalizedOutput) return [];
      return [{ input: normalizedInput, output: normalizedOutput }];
    });
}
