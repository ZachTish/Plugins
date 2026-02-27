export type RuleOperator = "is" | "!is" | "contains" | "!contains" | "exists" | "!exists";
export type SmartRuleOperator =
  | RuleOperator
  | "!is"
  | "!contains"
  | "!exists"
  | "is-not-empty"
  | "starts"
  | "!starts"
  | "within-next-days"
  | "!within-next-days"
  | "has-open-checkboxes"
  | "!has-open-checkboxes"
  | "is-today"
  | "!is-today"
  | "is-before-today"
  | "!is-before-today"
  | "is-after-today"
  | "!is-after-today";
export type RuleMatchMode = "all" | "any";
export type RuleConditionSource = "frontmatter" | "path" | "extension" | "name" | "tag" | "body" | "backlink" | "date-created" | "date-modified";

export interface RuleCondition {
  source: RuleConditionSource;
  field: string;  // For 'backlink' source, this is the frontmatter property name (e.g., "parent")
  operator: SmartRuleOperator;
  value: string;  // For 'backlink' source, this is the note name/path to check for
}

export interface IconColorRule {
  id: string;
  name: string;
  enabled: boolean;
  property: string;
  operator: RuleOperator;
  value: string;
  pathPrefix: string;
  icon: string;
  color: string;
  match: RuleMatchMode;
  conditions: RuleCondition[];
}

export interface SortValueMapping {
  input: string;
  output: string;
}

export type SortFieldType = "date" | "status" | "priority" | "text" | "number";

export interface SortCriteria {
  source: RuleConditionSource;
  field: string;
  type: SortFieldType;
  direction: "asc" | "desc";
  mappings: SortValueMapping[];
  missingValuePlacement: "first" | "last";
}

export interface ConditionGroup {
  id: string;
  match: RuleMatchMode;
  conditions: RuleCondition[];
}

export interface SortBucket {
  id: string;
  enabled: boolean;
  name: string;
  match: RuleMatchMode;
  conditions: RuleCondition[];
  conditionGroups?: ConditionGroup[];  // Optional nested groups for complex logic
  sortCriteria: SortCriteria[];
}

export interface SmartSortSettings {
  enabled: boolean;
  field: string;
  separator: string;
  appendBasename: boolean;
  clearWhenNoMatch: boolean;
  buckets: SortBucket[];
}

// Legacy types for migration
export interface SortSegmentRule {
  id: string;
  enabled: boolean;
  source: RuleConditionSource;
  field: string;
  fallback: string;
  mappings: SortValueMapping[];
  match: RuleMatchMode;
  conditions: RuleCondition[];
}

export interface HideRule {
  id: string;
  name: string;
  enabled: boolean;
  match: RuleMatchMode;
  conditions: RuleCondition[];
  mode: "add" | "remove";
  tagName: string;
}

export interface NotebookNavigatorCompanionSettings {
  enabled: boolean;
  autoApplyOnFileOpen: boolean;
  autoApplyOnMetadataChange: boolean;
  applyOnStartup: boolean;
  startupDelayMs: number;
  metadataDebounceMs: number;
  syncTitleFromFilename: boolean;
  syncFilenameFromTitle: boolean;
  frontmatterIconField: string;
  frontmatterColorField: string;
  upstreamLinkKeys: string[]; // Keys that trigger updates on the linked note when this note changes
  frontmatterWriteExclusions: string;
  noteCheckboxIconColor: string;
  clearIconWhenNoMatch: boolean;
  clearColorWhenNoMatch: boolean;
  debugLogging: boolean;
  rules: IconColorRule[];
  smartSort: SmartSortSettings;
  hideRules: HideRule[];
}

export interface RuleFileDescriptor {
  path: string;
  name: string;
  basename: string;
  extension: string;
}

export interface RuleEvaluationContext {
  file: RuleFileDescriptor;
  frontmatter: Record<string, unknown> | null;
  tags: string[];
  body?: string;
  backlinks?: string[];
}

export const DEFAULT_SETTINGS: NotebookNavigatorCompanionSettings = {
  enabled: true,
  autoApplyOnFileOpen: true,
  autoApplyOnMetadataChange: true,
  applyOnStartup: true,
  startupDelayMs: 800,
  metadataDebounceMs: 150,
  syncTitleFromFilename: false,
  syncFilenameFromTitle: false,
  frontmatterIconField: "icon",
  frontmatterColorField: "color",
  upstreamLinkKeys: ["parent"],
  frontmatterWriteExclusions: "",
  noteCheckboxIconColor: "",
  clearIconWhenNoMatch: false,
  clearColorWhenNoMatch: false,
  debugLogging: false,
  rules: [],
  smartSort: {
    enabled: false,
    field: "navigator_sort",
    separator: "_",
    appendBasename: true,
    clearWhenNoMatch: false,
    buckets: []
  },
  hideRules: []
};

const RULE_ID_PREFIX = "rule";
const SORT_SEGMENT_ID_PREFIX = "sort-segment";

export function createRuleId(): string {
  return `${RULE_ID_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createSortSegmentId(): string {
  return `${SORT_SEGMENT_ID_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createDefaultRule(): IconColorRule {
  return {
    id: createRuleId(),
    name: "",
    enabled: true,
    property: "status",
    operator: "is",
    value: "",
    pathPrefix: "",
    icon: "",
    color: "",
    match: "all",
    conditions: []
  };
}

export function createSortBucketId(): string {
  return `bucket-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createSortCriteriaId(): string {
  return `criteria-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createDefaultSortCriteria(): SortCriteria {
  return {
    source: "frontmatter",
    field: "priority",
    type: "priority",
    direction: "asc",
    mappings: [],
    missingValuePlacement: "last"
  };
}

export function createDefaultSortBucket(): SortBucket {
  return {
    id: createSortBucketId(),
    enabled: true,
    name: "New Bucket",
    match: "all",
    conditions: [],
    sortCriteria: []
  };
}

export function createDefaultSortSegment(): SortSegmentRule {
  return {
    id: createSortSegmentId(),
    enabled: true,
    source: "frontmatter",
    field: "priority",
    fallback: "",
    mappings: [],
    match: "all",
    conditions: []
  };
}

export function createConditionGroupId(): string {
  return `group-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createDefaultConditionGroup(): ConditionGroup {
  return {
    id: createConditionGroupId(),
    match: "all",
    conditions: []
  };
}
