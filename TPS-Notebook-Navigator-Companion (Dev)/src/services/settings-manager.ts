import {
  createDefaultSortSegment,
  createDefaultSortCriteria,
  createSortBucketId,
  DEFAULT_SETTINGS,
  HideRule,
  IconColorRule,
  NotebookNavigatorCompanionSettings,
  RuleCondition,
  RuleConditionSource,
  RuleMatchMode,
  RuleOperator,
  SmartRuleOperator,
  SmartSortSettings,
  SortSegmentRule,
  SortValueMapping,
  SortBucket,
  SortCriteria,
  SortFieldType,
  createRuleId,
  createSortSegmentId
} from "../types";
import { Logger } from "./logger";

interface PluginDataHost {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export class SettingsManager {
  private readonly host: PluginDataHost;
  private readonly logger: Logger;
  private static readonly PROTECTED_FRONTMATTER_KEYS = new Set(["externaleventid", "tpscalendaruid"]);

  constructor(host: PluginDataHost, logger: Logger) {
    this.host = host;
    this.logger = logger;
  }

  async loadSettings(): Promise<NotebookNavigatorCompanionSettings> {
    let loadedData: unknown = null;
    try {
      loadedData = await this.host.loadData();
    } catch (error) {
      this.logger.error("Failed to load plugin settings via loadData", error);
    }

    return this.sanitizeSettings(loadedData);
  }

  async saveSettings(settings: NotebookNavigatorCompanionSettings): Promise<NotebookNavigatorCompanionSettings> {
    const sanitized = this.sanitizeSettings(settings);

    try {
      await this.host.saveData(sanitized);
    } catch (error) {
      this.logger.error("Failed to save plugin settings via saveData", error);
      throw error;
    }

    return sanitized;
  }

  sanitizeSettings(raw: unknown): NotebookNavigatorCompanionSettings {
    const record = asRecord(raw);

    const smartSortRecord = asRecord(record.smartSort);
    const hasLegacySortRules = Array.isArray(record.sortRules);
    const migratedSmartSort = {
      ...smartSortRecord,
      segments: Array.isArray(smartSortRecord.segments)
        ? smartSortRecord.segments
        : hasLegacySortRules
          ? record.sortRules
          : smartSortRecord.segments
    };

    return {
      enabled: asBoolean(record.enabled, DEFAULT_SETTINGS.enabled),
      autoApplyOnFileOpen: asBoolean(record.autoApplyOnFileOpen, DEFAULT_SETTINGS.autoApplyOnFileOpen),
      autoApplyOnMetadataChange: asBoolean(record.autoApplyOnMetadataChange, DEFAULT_SETTINGS.autoApplyOnMetadataChange),
      applyOnStartup: asBoolean(record.applyOnStartup, DEFAULT_SETTINGS.applyOnStartup),
      startupDelayMs: asNumber(record.startupDelayMs, DEFAULT_SETTINGS.startupDelayMs, 0, 30000),
      metadataDebounceMs: asNumber(record.metadataDebounceMs, DEFAULT_SETTINGS.metadataDebounceMs, 0, 5000),
      syncTitleFromFilename: asBoolean(record.syncTitleFromFilename, DEFAULT_SETTINGS.syncTitleFromFilename),
      syncFilenameFromTitle: asBoolean(record.syncFilenameFromTitle, DEFAULT_SETTINGS.syncFilenameFromTitle),
      frontmatterIconField: this.normalizeSafeFrontmatterField(
        record.frontmatterIconField,
        DEFAULT_SETTINGS.frontmatterIconField
      ),
      frontmatterColorField: this.normalizeSafeFrontmatterField(
        record.frontmatterColorField,
        DEFAULT_SETTINGS.frontmatterColorField
      ),
      upstreamLinkKeys: normalizeStringsArray(record.upstreamLinkKeys, DEFAULT_SETTINGS.upstreamLinkKeys),
      frontmatterWriteExclusions: normalizeMultilineString(
        record.frontmatterWriteExclusions,
        DEFAULT_SETTINGS.frontmatterWriteExclusions
      ),
      noteCheckboxIconColor: normalizeOptionalString(record.noteCheckboxIconColor),
      clearIconWhenNoMatch: asBoolean(record.clearIconWhenNoMatch, DEFAULT_SETTINGS.clearIconWhenNoMatch),
      clearColorWhenNoMatch: asBoolean(record.clearColorWhenNoMatch, DEFAULT_SETTINGS.clearColorWhenNoMatch),
      debugLogging: asBoolean(record.debugLogging, DEFAULT_SETTINGS.debugLogging),
      rules: this.sanitizeRules(record.rules),
      smartSort: this.sanitizeSmartSort(migratedSmartSort),
      hideRules: this.sanitizeHideRules(record.hideRules)
    };
  }

  private sanitizeHideRules(rawRules: unknown): HideRule[] {
    if (!Array.isArray(rawRules)) {
      return [];
    }

    const sanitized: HideRule[] = [];

    for (const rawRule of rawRules) {
      const record = asRecord(rawRule);
      const match = this.normalizeMatchMode(record.match);
      const conditions = this.sanitizeConditions(record.conditions);

      sanitized.push({
        id: normalizeString(record.id, `hide-rule-${Date.now()}`),
        name: normalizeString(record.name, ""),
        enabled: asBoolean(record.enabled, true),
        match,
        conditions,
        mode: record.mode === "remove" ? "remove" : "add",
        tagName: normalizeString(record.tagName, "hide")
      });
    }

    return sanitized;
  }

  private sanitizeRules(rawRules: unknown): IconColorRule[] {
    if (!Array.isArray(rawRules)) {
      return [];
    }

    const sanitized: IconColorRule[] = [];

    for (const rawRule of rawRules) {
      const record = asRecord(rawRule);
      const match = this.normalizeMatchMode(record.match);
      const conditions = this.sanitizeConditions(record.conditions);

      sanitized.push({
        id: normalizeString(record.id, createRuleId()),
        name: normalizeOptionalString(record.name),
        enabled: asBoolean(record.enabled, true),
        property: normalizeString(record.property, ""),
        operator: this.normalizeRuleOperator(record.operator),
        value: normalizeString(record.value, ""),
        pathPrefix: normalizePathPrefix(normalizeString(record.pathPrefix, "")),
        icon: normalizeString(record.icon, ""),
        color: normalizeString(record.color, ""),
        match,
        conditions
      });
    }

    return sanitized;
  }

  private sanitizeConditions(rawConditions: unknown): RuleCondition[] {
    if (!Array.isArray(rawConditions)) {
      return [];
    }

    const conditions: RuleCondition[] = [];

    for (const rawCondition of rawConditions) {
      const record = asRecord(rawCondition);
      const source = this.normalizeConditionSource(record.source);
      const operator = this.normalizeSmartOperator(record.operator);
      if (!source || !operator) {
        continue;
      }

      const condition: RuleCondition = {
        source,
        field: normalizeString(record.field, ""),
        operator,
        value: normalizeString(record.value, "")
      };

      conditions.push(condition);
    }

    return conditions;
  }

  private sanitizeSmartSort(rawSort: unknown): SmartSortSettings {
    const record = asRecord(rawSort);

    // Support both legacy segments and new buckets
    const buckets = this.sanitizeSortBuckets(record.buckets ?? record.segments);

    return {
      enabled: asBoolean(record.enabled, DEFAULT_SETTINGS.smartSort.enabled),
      field: this.normalizeSafeFrontmatterField(record.field, DEFAULT_SETTINGS.smartSort.field),
      separator: normalizeSeparator(record.separator, DEFAULT_SETTINGS.smartSort.separator),
      appendBasename: asBoolean(record.appendBasename, DEFAULT_SETTINGS.smartSort.appendBasename),
      clearWhenNoMatch: asBoolean(record.clearWhenNoMatch, DEFAULT_SETTINGS.smartSort.clearWhenNoMatch),
      buckets
    };
  }

  private normalizeSafeFrontmatterField(value: unknown, fallback: string): string {
    const normalized = normalizeFrontmatterField(value, fallback);
    if (!SettingsManager.PROTECTED_FRONTMATTER_KEYS.has(normalized.toLowerCase())) {
      return normalized;
    }
    this.logger.warn("Blocked protected frontmatter field in settings; falling back to default", {
      requested: normalized,
      fallback
    });
    return fallback;
  }

  private sanitizeSortSegments(rawSegments: unknown): SortSegmentRule[] {
    if (!Array.isArray(rawSegments)) {
      return [];
    }

    const segments: SortSegmentRule[] = [];

    for (const rawSegment of rawSegments) {
      const record = asRecord(rawSegment);
      const source = this.normalizeConditionSource(record.source) ?? createDefaultSortSegment().source;
      const match = this.normalizeMatchMode(record.match);
      const conditions = this.sanitizeConditions(record.conditions);

      segments.push({
        id: normalizeString(record.id, createSortSegmentId()),
        enabled: asBoolean(record.enabled, true),
        source,
        field: normalizeString(record.field, source === "frontmatter" ? "status" : ""),
        fallback: normalizeString(record.fallback, ""),
        mappings: this.sanitizeValueMappings(record.mappings ?? record.map),
        match,
        conditions
      });
    }

    return segments;
  }

  private sanitizeSortBuckets(rawBuckets: unknown): SortBucket[] {
    if (!Array.isArray(rawBuckets)) {
      return [];
    }

    const buckets: SortBucket[] = [];

    for (const rawBucket of rawBuckets) {
      const record = asRecord(rawBucket);

      // Check if this is a legacy segment being migrated
      const isLegacySegment = record.fallback !== undefined && record.sortCriteria === undefined;

      if (isLegacySegment) {
        // Migrate legacy segment to bucket format
        const match = this.normalizeMatchMode(record.match);
        const conditions = this.sanitizeConditions(record.conditions);
        const source = this.normalizeConditionSource(record.source) ?? "frontmatter";
        const field = normalizeString(record.field, "");

        const sortCriteria: SortCriteria[] = [{
          source,
          field,
          type: this.inferFieldType(field),
          direction: "asc",
          mappings: this.sanitizeValueMappings(record.mappings ?? record.map),
          missingValuePlacement: record.fallback ? "last" : "last"
        }];

        buckets.push({
          id: normalizeString(record.id, createSortBucketId()),
          enabled: asBoolean(record.enabled, true),
          name: `Migrated: ${field || "Unnamed"}`,
          match,
          conditions,
          sortCriteria
        });
      } else {
        // Handle new bucket format
        const match = this.normalizeMatchMode(record.match);
        const conditions = this.sanitizeConditions(record.conditions);
        const sortCriteria = this.sanitizeSortCriteria(record.sortCriteria);

        buckets.push({
          id: normalizeString(record.id, createSortBucketId()),
          enabled: asBoolean(record.enabled, true),
          name: normalizeString(record.name, "Unnamed Bucket"),
          match,
          conditions,
          sortCriteria
        });
      }
    }

    return buckets;
  }

  private sanitizeSortCriteria(rawCriteria: unknown): SortCriteria[] {
    if (!Array.isArray(rawCriteria)) {
      return [];
    }

    const criteria: SortCriteria[] = [];

    for (const rawCriterion of rawCriteria) {
      const record = asRecord(rawCriterion);
      const source = this.normalizeConditionSource(record.source) ?? "frontmatter";
      const field = normalizeString(record.field, "");
      const type = this.normalizeFieldType(record.type);

      criteria.push({
        source,
        field,
        type,
        direction: record.direction === "desc" ? "desc" : "asc",
        mappings: this.sanitizeValueMappings(record.mappings),
        missingValuePlacement: record.missingValuePlacement === "first" ? "first" : "last"
      });
    }

    return criteria;
  }

  private normalizeFieldType(value: unknown): SortFieldType {
    if (
      value === "date" ||
      value === "status" ||
      value === "priority" ||
      value === "text" ||
      value === "number"
    ) {
      return value;
    }
    return "text";
  }

  private inferFieldType(field: string): SortFieldType {
    const lower = field.toLowerCase();
    if (lower.includes("date") || lower === "scheduled" || lower === "due" || lower === "deadline") {
      return "date";
    }
    if (lower === "status") {
      return "status";
    }
    if (lower === "priority") {
      return "priority";
    }
    return "text";
  }

  private sanitizeValueMappings(rawMappings: unknown): SortValueMapping[] {
    if (Array.isArray(rawMappings)) {
      const mappings: SortValueMapping[] = [];
      for (const rawMapping of rawMappings) {
        const record = asRecord(rawMapping);
        const input = normalizeString(record.input, "");
        const output = normalizeString(record.output, "");
        if (!input || !output) {
          continue;
        }
        mappings.push({ input, output });
      }
      return mappings;
    }

    if (typeof rawMappings === "string") {
      const mappings: SortValueMapping[] = [];
      const pairs = rawMappings.split(",");
      for (const pair of pairs) {
        const trimmed = pair.trim();
        if (!trimmed) {
          continue;
        }

        const separator = trimmed.includes("=") ? "=" : trimmed.includes(":") ? ":" : "";
        if (!separator) {
          continue;
        }

        const [rawInput, rawOutput] = trimmed.split(separator);
        const input = String(rawInput || "").trim();
        const output = String(rawOutput || "").trim();
        if (!input || !output) {
          continue;
        }

        mappings.push({ input, output });
      }
      return mappings;
    }

    const mappingRecord = asRecord(rawMappings);
    return Object.entries(mappingRecord)
      .map(([input, output]) => ({
        input: String(input || "").trim(),
        output: String(output ?? "").trim()
      }))
      .filter((mapping) => mapping.input.length > 0 && mapping.output.length > 0);
  }

  private normalizeRuleOperator(value: unknown): RuleOperator {
    if (
      value === "is" ||
      value === "!is" ||
      value === "contains" ||
      value === "!contains" ||
      value === "exists" ||
      value === "!exists"
    ) {
      return value;
    }
    return "is";
  }

  private normalizeSmartOperator(value: unknown): SmartRuleOperator | null {
    if (
      value === "is" ||
      value === "contains" ||
      value === "exists" ||
      value === "!is" ||
      value === "!contains" ||
      value === "!exists" ||
      value === "is-not-empty" ||
      value === "starts" ||
      value === "!starts" ||
      value === "within-next-days" ||
      value === "!within-next-days" ||
      value === "has-open-checkboxes" ||
      value === "!has-open-checkboxes" ||
      value === "is-today" ||
      value === "!is-today" ||
      value === "is-before-today" ||
      value === "!is-before-today" ||
      value === "is-after-today" ||
      value === "!is-after-today"
    ) {
      return value;
    }
    return null;
  }

  private normalizeConditionSource(value: unknown): RuleConditionSource | null {
    if (
      value === "frontmatter" ||
      value === "path" ||
      value === "extension" ||
      value === "name" ||
      value === "tag" ||
      value === "body" ||
      value === "backlink" ||
      value === "date-created" ||
      value === "date-modified"
    ) {
      return value;
    }
    return null;
  }

  private normalizeMatchMode(value: unknown): RuleMatchMode {
    return value === "any" ? "any" : "all";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

function normalizeString(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function normalizeFrontmatterField(value: unknown, fallback: string): string {
  const normalized = normalizeString(value, fallback);
  return normalized.replace(/\s+/g, "");
}

function normalizeOptionalString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeMultilineString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function normalizeSeparator(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.slice(0, 3);
}

function normalizePathPrefix(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function normalizeStringsArray(value: unknown, fallback: string[]): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[\n,]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return fallback;
}
