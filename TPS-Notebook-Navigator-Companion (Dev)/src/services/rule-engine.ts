import { App, TFile } from "obsidian";
import {
  HideRule,
  IconColorRule,
  RuleCondition,
  RuleConditionSource,
  RuleEvaluationContext,
  SmartRuleOperator,
  SmartSortSettings,
  SortSegmentRule,
  SortValueMapping,
  SortBucket,
  SortCriteria,
  ConditionGroup
} from "../types";

export interface RuleFieldResult {
  matched: boolean;
  value: string;
  ruleId: string | null;
}

export interface VisualRuleResult {
  icon: RuleFieldResult;
  color: RuleFieldResult;
}

export class RuleEngine {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  private static readonly MS_PER_DAY = 24 * 60 * 60 * 1000;
  private static readonly DATE_SORT_FIELDS = new Set([
    "scheduled",
    "due",
    "date",
    "start",
    "startdate",
    "end",
    "enddate",
    "deadline",
    "created",
    "datecreated",
    "modified",
    "datemodified",
    "updated",
    "dateupdated"
  ]);

  resolveVisualOutputs(rules: IconColorRule[], context: RuleEvaluationContext): VisualRuleResult {
    const icon: RuleFieldResult = { matched: false, value: "", ruleId: null };
    const color: RuleFieldResult = { matched: false, value: "", ruleId: null };

    for (const rule of rules) {
      if (!rule.enabled) {
        continue;
      }
      if (!this.matchesRule(rule, context)) {
        continue;
      }

      if (!icon.matched) {
        const iconValue = String(rule.icon || "").trim();
        if (iconValue) {
          icon.matched = true;
          icon.value = iconValue;
          icon.ruleId = rule.id;
        }
      }

      if (!color.matched) {
        const colorValue = String(rule.color || "").trim();
        if (colorValue) {
          color.matched = true;
          color.value = colorValue;
          color.ruleId = rule.id;
        }
      }

      if (icon.matched && color.matched) {
        break;
      }
    }

    return { icon, color };
  }

  composeSortKey(settings: SmartSortSettings, context: RuleEvaluationContext): string {
    const separator = String(settings.separator || "").trim() || "_";
    const parts: string[] = [];

    // Find the first matching bucket
    let matchedBucket: SortBucket | null = null;
    let bucketIndex = -1;

    for (let i = 0; i < settings.buckets.length; i++) {
      const bucket = settings.buckets[i];
      if (!bucket.enabled) {
        continue;
      }
      if (this.matchesBucket(bucket, context)) {
        matchedBucket = bucket;
        bucketIndex = i;
        break;
      }
    }

    // Add bucket index as the first part (zero-padded to 3 digits)
    // For A-Z sorting: lower index = higher priority = lower sort value = appears first
    // Example: Bucket 0 (highest priority) → "000" (sorts to top in A-Z)
    //          Bucket 12 (lowest priority) → "012" (sorts to bottom in A-Z)
    if (matchedBucket) {
      parts.push(String(bucketIndex).padStart(3, "0"));

      // Apply sort criteria from the matched bucket
      for (const criteria of matchedBucket.sortCriteria) {
        const rawValue = this.getSortCriteriaValue(criteria, context);
        const normalizedValue = this.normalizeSortKeyPart(rawValue, separator);
        if (normalizedValue) {
          parts.push(normalizedValue);
        }
      }
    } else {
      // No bucket matched - use a high bucket number to sort unmatched items last
      parts.push("999");
    }

    if (settings.appendBasename) {
      const basenamePart = this.normalizeSortKeyPart(context.file.basename, separator);
      if (basenamePart) {
        parts.push(basenamePart);
      }
    }

    const finalSortKey = parts.join(separator);

    // Debug logging to help diagnose sort issues
    // Debug logging removed to prevent console spam
    // if (matchedBucket) {
    //   console.log(`[Sort] ${context.file.name} → Bucket ${bucketIndex} "${matchedBucket.name}" → ${finalSortKey}`);
    // } else {
    //   console.log(`[Sort] ${context.file.name} → NO MATCH → ${finalSortKey}`);
    // }

    return finalSortKey;
  }

  private matchesBucket(bucket: SortBucket, context: RuleEvaluationContext): boolean {
    const hasConditions = Array.isArray(bucket.conditions) && bucket.conditions.length > 0;
    const hasGroups = Array.isArray(bucket.conditionGroups) && bucket.conditionGroups.length > 0;

    // If no conditions or groups, match everything
    if (!hasConditions && !hasGroups) {
      return true;
    }

    // Evaluate flat conditions
    const flatConditionsMatch = hasConditions
      ? this.matchesConditionGroup(bucket.conditions, bucket.match, context)
      : (bucket.match === "all"); // If no flat conditions, treat as true for "all", false for "any"

    // Evaluate condition groups
    const groupResults = hasGroups
      ? bucket.conditionGroups!.map(group =>
        this.matchesConditionGroup(group.conditions, group.match, context)
      )
      : [];

    // Combine flat conditions and groups based on bucket's match mode
    if (bucket.match === "all") {
      // All conditions AND all groups must match
      return flatConditionsMatch && (groupResults.length === 0 || groupResults.every(r => r));
    } else {
      // Any condition OR any group must match
      const anyGroupMatches = groupResults.some(r => r);
      return (hasConditions && flatConditionsMatch) || anyGroupMatches;
    }
  }

  private getSortCriteriaValue(criteria: SortCriteria, context: RuleEvaluationContext): string {
    const values = this.getValuesForConditionSource(criteria.source, context, criteria.field);
    const first = values.find((value) => String(value || "").trim().length > 0) ?? "";

    // Apply mappings first
    const mapped = this.applyMapping(first, criteria.mappings);
    if (mapped) {
      return criteria.direction === "desc" ? this.invertSortValue(mapped) : mapped;
    }

    // Handle date type
    if (criteria.type === "date") {
      const normalizedDateValue = this.normalizeDateSortValue(criteria, first);
      if (normalizedDateValue) {
        return criteria.direction === "desc" ? this.invertSortValue(normalizedDateValue) : normalizedDateValue;
      }

      // Try to extract date from basename if this is a date field
      if (this.isDateCriteria(criteria)) {
        const basenameDateValue = this.normalizeDateSortValue(criteria, context.file.basename);
        if (basenameDateValue) {
          return criteria.direction === "desc" ? this.invertSortValue(basenameDateValue) : basenameDateValue;
        }
      }

      // Use missing value placement
      const missingValue = criteria.missingValuePlacement === "first" ? "0000-00-00" : "9999-12-31";
      return criteria.direction === "desc" ? this.invertSortValue(missingValue) : missingValue;
    }

    // Handle other types
    if (first) {
      // If sorting by update/modified time, prevent infinite write loops by using day precision only
      if (
        criteria.source === "date-modified" ||
        (criteria.source === "frontmatter" &&
          criteria.field &&
          (criteria.field.toLowerCase().includes("modified") ||
            criteria.field.toLowerCase().includes("updated")))
      ) {
        const truncated = first.substring(0, 10);
        return criteria.direction === "desc" ? this.invertSortValue(truncated) : truncated;
      }

      return criteria.direction === "desc" ? this.invertSortValue(first) : first;
    }

    // Missing value handling
    const missingValue = criteria.missingValuePlacement === "first" ? "000" : "999";
    return criteria.direction === "desc" ? this.invertSortValue(missingValue) : missingValue;
  }

  private isDateCriteria(criteria: SortCriteria): boolean {
    if (criteria.source !== "frontmatter") {
      return false;
    }
    const field = String(criteria.field || "").trim().toLowerCase();
    return RuleEngine.DATE_SORT_FIELDS.has(field) || criteria.type === "date";
  }

  private invertSortValue(value: string): string {
    // For descending sort, we need to invert the string so it sorts in reverse
    // For dates and numbers, we can use character code inversion
    return value.split("").map(char => {
      const code = char.charCodeAt(0);
      if (code >= 48 && code <= 57) { // 0-9
        return String.fromCharCode(105 - code); // Invert digits
      }
      return char;
    }).join("");
  }

  matchesRule(rule: IconColorRule | HideRule, context: RuleEvaluationContext): boolean {
    if (Array.isArray(rule.conditions) && rule.conditions.length > 0) {
      return this.matchesConditionGroup(rule.conditions, rule.match, context);
    }

    if (!("property" in rule) || !rule.property) {
      return false;
    }
    const property = String(rule.property || "").trim();
    if (!property) {
      return false;
    }

    if (!this.matchesPathPrefix(context.file.path, rule.pathPrefix)) {
      return false;
    }

    if (property.toLowerCase() === "folderpath") {
      const pathValues = this.getValuesForConditionSource("path", context, "");
      return this.matchesValues(pathValues, rule.operator, rule.value, false);
    }

    if (rule.operator === "exists") {
      return this.hasFrontmatterKey(context.frontmatter, property);
    }

    const values = this.toComparableValues(this.getFrontmatterValue(context.frontmatter, property));
    return this.matchesValues(values, rule.operator, rule.value, true);
  }

  getFolderPath(filePath: string): string {
    const normalizedPath = normalizePath(filePath);
    const slashIndex = normalizedPath.lastIndexOf("/");
    if (slashIndex < 0) {
      return "";
    }
    return normalizedPath.slice(0, slashIndex);
  }

  getValuesForConditionSource(source: RuleConditionSource, context: RuleEvaluationContext, field: string): string[] {
    if (source === "path") {
      const folderPath = this.getFolderPath(context.file.path);
      return folderPath ? [folderPath] : [];
    }

    if (source === "extension") {
      const extension = String(context.file.extension || "").trim();
      return extension ? [extension] : [];
    }

    if (source === "name") {
      const values = new Set<string>();
      const fileName = String(context.file.name || "").trim();
      const basename = String(context.file.basename || "").trim();
      if (fileName) {
        values.add(fileName);
      }
      if (basename) {
        values.add(basename);
      }
      return Array.from(values);
    }

    if (source === "tag") {
      return this.collectTags(context);
    }

    if (source === "body") {
      // Return the note body content if available
      return context.body ? [context.body] : [];
    }

    if (source === "backlink") {
      const allBacklinks = context.backlinks || [];
      const targetField = (field || "").trim();

      if (!targetField) {
        // Return all backlinks (paths + basenames) if no field specified
        const values = new Set<string>();
        for (const path of allBacklinks) {
          values.add(path);
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            values.add(file.basename);
          }
        }
        return Array.from(values);
      }

      // Filter backlinks to only include those that link via the specified frontmatter property
      const validPaths = allBacklinks.filter(sourcePath => {
        const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
        if (!(sourceFile instanceof TFile)) {
          return false;
        }

        const cache = this.app.metadataCache.getFileCache(sourceFile);
        if (!cache?.frontmatterLinks) {
          return false;
        }

        return cache.frontmatterLinks.some(link => {
          // Check if this link belongs to the target property
          if (!link.key || link.key.toLowerCase() !== targetField.toLowerCase()) {
            return false;
          }

          // Check if the link points to our current file
          const dest = this.app.metadataCache.getFirstLinkpathDest(link.link, sourcePath);
          const isMatch = dest && dest.path === context.file.path;

          return isMatch;
        });
      });

      // Return both full paths AND basenames to allow easier matching
      // e.g. "Folder/My Note.md" -> ["Folder/My Note.md", "My Note"]
      const values = new Set<string>();
      for (const path of validPaths) {
        values.add(path);
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          values.add(file.basename);
        }
      }

      return Array.from(values);
    }

    if (source === "date-created") {
      // @ts-ignore
      return [window.moment(context.file.stat.ctime).format()];
    }

    if (source === "date-modified") {
      // @ts-ignore
      return [window.moment(context.file.stat.mtime).format()];
    }

    const key = String(field || "").trim();
    if (!key) {
      return [];
    }

    if (key.toLowerCase() === "folderpath") {
      return this.getValuesForConditionSource("path", context, "");
    }

    return this.toComparableValues(this.getFrontmatterValue(context.frontmatter, key));
  }

  private matchesConditionGroup(conditions: RuleCondition[], matchMode: "all" | "any", context: RuleEvaluationContext): boolean {
    if (conditions.length === 0) {
      return false;
    }

    if (matchMode === "any") {
      return conditions.some((condition) => this.matchesCondition(condition, context));
    }

    return conditions.every((condition) => this.matchesCondition(condition, context));
  }

  private matchesCondition(condition: RuleCondition, context: RuleEvaluationContext): boolean {
    const operator = this.normalizeSmartOperator(condition.operator);
    if (!operator) {
      return false;
    }

    const source = condition.source;
    if (source === "frontmatter") {
      const field = String(condition.field || "").trim();
      if (!field) {
        return false;
      }

      if (field.toLowerCase() === "folderpath") {
        const folderValues = this.getValuesForConditionSource("path", context, "");
        return this.matchesValues(folderValues, operator, condition.value, false);
      }

      if ((operator === "exists" || operator === "!exists") && !String(condition.value || "").trim()) {
        const hasField = this.hasFrontmatterKey(context.frontmatter, field);
        return operator === "exists" ? hasField : !hasField;
      }

      if (operator === "is-not-empty") {
        const values = this.getValuesForConditionSource("frontmatter", context, field);
        return values.length > 0 && values.some(v => String(v || "").trim().length > 0);
      }

      const values = this.getValuesForConditionSource("frontmatter", context, field);
      return this.matchesValues(values, operator, condition.value, true);
    }

    const values = this.getValuesForConditionSource(source, context, condition.field);
    const trimTarget = source !== "path";
    return this.matchesValues(values, operator, condition.value, trimTarget);
  }

  private collectTags(context: RuleEvaluationContext): string[] {
    const tags = new Set<string>();

    for (const rawTag of context.tags) {
      const normalized = this.normalizeTag(rawTag);
      if (normalized) {
        tags.add(normalized);
      }
    }

    const frontmatterTags = this.getFrontmatterValue(context.frontmatter, "tags");
    if (Array.isArray(frontmatterTags)) {
      for (const rawTag of frontmatterTags) {
        const normalized = this.normalizeTag(rawTag);
        if (normalized) {
          tags.add(normalized);
        }
      }
    } else if (typeof frontmatterTags === "string") {
      for (const rawTag of frontmatterTags.split(/[\s,]+/)) {
        const normalized = this.normalizeTag(rawTag);
        if (normalized) {
          tags.add(normalized);
        }
      }
    }

    return Array.from(tags);
  }

  private normalizeTag(raw: unknown): string {
    const value = String(raw ?? "").trim();
    if (!value) {
      return "";
    }
    return value.replace(/^#+/, "").toLowerCase();
  }

  private matchesPathPrefix(filePath: string, pathPrefix: string): boolean {
    const normalizedPrefix = normalizePath(pathPrefix);
    if (!normalizedPrefix) {
      return true;
    }

    const folderPath = this.getFolderPath(filePath);
    if (!folderPath) {
      return false;
    }

    return folderPath === normalizedPrefix || folderPath.startsWith(`${normalizedPrefix}/`);
  }

  private hasFrontmatterKey(frontmatter: Record<string, unknown> | null, key: string): boolean {
    if (!frontmatter) {
      return false;
    }

    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      return true;
    }

    const normalizedTarget = key.toLowerCase();
    return Object.keys(frontmatter).some((existingKey) => existingKey.toLowerCase() === normalizedTarget);
  }

  private getFrontmatterValue(frontmatter: Record<string, unknown> | null, key: string): unknown {
    if (!frontmatter) {
      return undefined;
    }

    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      return frontmatter[key];
    }

    const normalizedTarget = key.toLowerCase();
    for (const [existingKey, value] of Object.entries(frontmatter)) {
      if (existingKey.toLowerCase() === normalizedTarget) {
        return value;
      }
    }

    return undefined;
  }

  private toComparableValues(value: unknown): string[] {
    if (value === null || value === undefined) {
      return [];
    }

    if (Array.isArray(value)) {
      return value.flatMap((item) => this.toComparableValues(item));
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? [trimmed] : [];
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return [String(value)];
    }

    try {
      return [JSON.stringify(value)];
    } catch {
      return [String(value)];
    }
  }

  private matchesValues(values: string[], operator: SmartRuleOperator, rawTarget: string, trimTarget: boolean): boolean {
    const trimmedValues = values
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);

    const trimmedTarget = trimTarget ? String(rawTarget ?? "").trim() : String(rawTarget ?? "");

    if (operator === "within-next-days" || operator === "!within-next-days") {
      return this.matchesWithinNextDays(trimmedValues, trimmedTarget, operator === "!within-next-days");
    }

    if (operator === "has-open-checkboxes" || operator === "!has-open-checkboxes") {
      // Check if any value (body content) contains uncompleted checkboxes
      const hasOpenCheckboxes = trimmedValues.some((value) => {
        // Match markdown checkboxes that are NOT checked: - [ ]
        const openCheckboxPattern = /^[\s]*[-*]\s+\[\s\]/m;
        return openCheckboxPattern.test(value);
      });
      return operator === "has-open-checkboxes" ? hasOpenCheckboxes : !hasOpenCheckboxes;
    }

    if (operator === "is-today" || operator === "!is-today") {
      // @ts-ignore
      const today = window.moment().startOf('day');
      // @ts-ignore
      const todayStr = today.format("YYYY-MM-DD");

      const isToday = trimmedValues.some((value) => {
        // 1. Try date parsing for structured fields
        // @ts-ignore
        const m = window.moment(value, [
          window.moment.ISO_8601,
          "YYYY-MM-DD",
          "YYYY-MM-DD HH:mm",
          "YYYY-MM-DDTHH:mm:ss",
          "YYYY/MM/DD"
        ], true);

        if (m.isValid()) {
          const same = m.isSame(today, 'day');
          return same;
        }

        // 2. Fallback to string includes (needed for filenames like "My Note 2026-02-17")
        const matches = value.includes(todayStr);
        return matches;
      });
      return operator === "is-today" ? isToday : !isToday;
    }

    if (operator === "is-before-today" || operator === "!is-before-today") {
      // @ts-ignore
      const today = window.moment().startOf('day');

      const isBefore = trimmedValues.some((value) => {
        // @ts-ignore
        const m = window.moment(value, [
          window.moment.ISO_8601,
          "YYYY-MM-DD",
          "YYYY-MM-DD HH:mm",
          "YYYY-MM-DDTHH:mm:ss",
          "YYYY/MM/DD"
        ], true);

        if (m.isValid()) {
          return m.isBefore(today, 'day');
        }
        return false;
      });
      return operator === "is-before-today" ? isBefore : !isBefore;
    }

    if (operator === "is-after-today" || operator === "!is-after-today") {
      // @ts-ignore
      const today = window.moment().startOf('day');

      const isAfter = trimmedValues.some((value) => {
        // @ts-ignore
        const m = window.moment(value, [
          window.moment.ISO_8601,
          "YYYY-MM-DD",
          "YYYY-MM-DD HH:mm",
          "YYYY-MM-DDTHH:mm:ss",
          "YYYY/MM/DD"
        ], true);

        if (m.isValid()) {
          return m.isAfter(today, 'day');
        }
        return false;
      });
      return operator === "is-after-today" ? isAfter : !isAfter;
    }

    if (operator === "is-not-empty") {
      return trimmedValues.length > 0 && trimmedValues.some(v => v.length > 0);
    }

    const normalizedValues = trimmedValues.map((value) => value.toLowerCase());
    const target = trimmedTarget.toLowerCase();

    if (operator === "exists") {
      if (!target) {
        return normalizedValues.length > 0;
      }
      return normalizedValues.some((value) => value.includes(target));
    }

    if (operator === "!exists") {
      if (!target) {
        return normalizedValues.length === 0;
      }
      return normalizedValues.every((value) => !value.includes(target));
    }

    if (!target) {
      return false;
    }

    if (operator === "is") {
      return normalizedValues.some((value) => value === target);
    }

    if (operator === "!is") {
      return normalizedValues.every((value) => value !== target);
    }

    if (operator === "contains") {
      return normalizedValues.some((value) => value.includes(target));
    }

    if (operator === "!contains") {
      return normalizedValues.every((value) => !value.includes(target));
    }

    if (operator === "starts") {
      return normalizedValues.some((value) => value.startsWith(target));
    }

    if (operator === "!starts") {
      return normalizedValues.every((value) => !value.startsWith(target));
    }

    return false;
  }

  private normalizeSmartOperator(operator: string): SmartRuleOperator | null {
    if (
      operator === "is" ||
      operator === "contains" ||
      operator === "exists" ||
      operator === "!is" ||
      operator === "!contains" ||
      operator === "!exists" ||
      operator === "is-not-empty" ||
      operator === "starts" ||
      operator === "!starts" ||
      operator === "within-next-days" ||
      operator === "!within-next-days" ||
      operator === "has-open-checkboxes" ||
      operator === "!has-open-checkboxes" ||
      operator === "is-today" ||
      operator === "!is-today" ||
      operator === "is-before-today" ||
      operator === "!is-before-today" ||
      operator === "is-after-today" ||
      operator === "!is-after-today"
    ) {
      return operator;
    }

    return null;
  }

  private matchesWithinNextDays(values: string[], rawTarget: string, negated: boolean): boolean {
    const days = this.parseDayCount(rawTarget);
    if (days == null) {
      return false;
    }

    // @ts-ignore
    const today = window.moment().startOf('day');
    // @ts-ignore
    const limit = window.moment().add(days, 'days').endOf('day');

    const matched = values.some((value) => {
      // @ts-ignore
      const m = window.moment(value, [window.moment.ISO_8601, "YYYY-MM-DD", "YYYY-MM-DD HH:mm", "YYYY/MM/DD"], false);
      if (!m.isValid()) {
        return false;
      }
      return m.isSameOrAfter(today) && m.isSameOrBefore(limit);
    });

    return negated ? !matched : matched;
  }

  private parseDayCount(raw: string): number | null {
    const text = String(raw || "").trim();
    if (!text) {
      return null;
    }

    const match = text.match(/^-?\d+(?:\.\d+)?/);
    if (!match) {
      return null;
    }

    const parsed = Number.parseFloat(match[0]);
    if (!Number.isFinite(parsed)) {
      return null;
    }

    return Math.max(0, parsed);
  }

  private parseDateLikeTimestamp(raw: string): number | null {
    const value = String(raw || "").trim();
    if (!value) {
      return null;
    }

    const unquoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
        ? value.slice(1, -1).trim()
        : value;
    if (!unquoted) {
      return null;
    }

    const asEpoch = Number(unquoted);
    if (Number.isFinite(asEpoch)) {
      if (/^\d{13}$/.test(unquoted)) {
        return asEpoch;
      }
      if (/^\d{10}$/.test(unquoted)) {
        return asEpoch * 1000;
      }
    }

    // Treat plain date-only strings as local calendar dates to avoid UTC-day drift.
    const localDateOnlyMatch = unquoted.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
    if (localDateOnlyMatch) {
      const year = Number.parseInt(localDateOnlyMatch[1], 10);
      const month = Number.parseInt(localDateOnlyMatch[2], 10);
      const day = Number.parseInt(localDateOnlyMatch[3], 10);
      if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
        return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
      }
    }

    // Treat naive datetime strings as local wall-clock time.
    const localDateTimeMatch = unquoted.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (localDateTimeMatch) {
      const year = Number.parseInt(localDateTimeMatch[1], 10);
      const month = Number.parseInt(localDateTimeMatch[2], 10);
      const day = Number.parseInt(localDateTimeMatch[3], 10);
      const hours = Number.parseInt(localDateTimeMatch[4], 10);
      const minutes = Number.parseInt(localDateTimeMatch[5], 10);
      const seconds = Number.parseInt(localDateTimeMatch[6] || "0", 10);
      if (
        Number.isFinite(year) &&
        Number.isFinite(month) &&
        Number.isFinite(day) &&
        Number.isFinite(hours) &&
        Number.isFinite(minutes) &&
        Number.isFinite(seconds)
      ) {
        return new Date(year, month - 1, day, hours, minutes, seconds, 0).getTime();
      }
    }

    const candidates = [unquoted];
    if (/^\d{4}-\d{2}-\d{2}\s+\d/.test(unquoted)) {
      candidates.push(unquoted.replace(/\s+/, "T"));
    }

    for (const candidate of candidates) {
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    return null;
  }

  private matchesSortSegment(segment: SortSegmentRule, context: RuleEvaluationContext): boolean {
    if (!Array.isArray(segment.conditions) || segment.conditions.length === 0) {
      return true;
    }
    return this.matchesConditionGroup(segment.conditions, segment.match, context);
  }

  private getSortSegmentValue(segment: SortSegmentRule, context: RuleEvaluationContext): string {
    const values = this.getValuesForConditionSource(segment.source, context, segment.field);
    const first = values.find((value) => String(value || "").trim().length > 0) ?? "";
    const mapped = this.applyMapping(first, segment.mappings);
    if (mapped) {
      return mapped;
    }

    const normalizedDateValue = this.normalizeDateSortValue(segment, first);
    if (normalizedDateValue) {
      return normalizedDateValue;
    }

    if (this.isDateFrontmatterSegment(segment)) {
      const basenameDateValue = this.normalizeDateSortValue(segment, context.file.basename);
      if (basenameDateValue) {
        return basenameDateValue;
      }
    }

    if (first) {
      return first;
    }

    const fallback = String(segment.fallback || "").trim();
    return fallback;
  }

  private applyMapping(value: string, mappings: SortValueMapping[]): string {
    const normalizedValue = String(value || "").trim().toLowerCase();
    if (!normalizedValue) {
      return "";
    }

    for (const mapping of mappings) {
      const input = String(mapping.input || "").trim().toLowerCase();
      if (!input) {
        continue;
      }
      if (input === normalizedValue) {
        return String(mapping.output || "").trim();
      }
    }

    return "";
  }

  private normalizeDateSortValue(segmentOrCriteria: SortSegmentRule | SortCriteria, rawValue: string): string {
    const value = String(rawValue || "").trim();
    if (!value) {
      return "";
    }

    // Check if it's a SortCriteria (has 'type' property) or SortSegmentRule (has 'fallback' property)
    const isCriteria = 'type' in segmentOrCriteria;
    const source = segmentOrCriteria.source;
    const field = String(segmentOrCriteria.field || "").trim().toLowerCase();

    if (source !== "frontmatter" && source !== "date-modified" && source !== "date-created") {
      return "";
    }

    const shouldParseAsDate = isCriteria
      ? (segmentOrCriteria.type === "date" || RuleEngine.DATE_SORT_FIELDS.has(field) || this.looksLikeDateValue(value))
      : (RuleEngine.DATE_SORT_FIELDS.has(field) || this.looksLikeDateValue(value));

    if (!shouldParseAsDate) {
      return "";
    }

    const timestamp = this.parseDateLikeTimestamp(value);
    if (timestamp == null) {
      return "";
    }

    const result = this.formatSortTimestamp(timestamp);

    // If sorting by update/modified time, prevent infinite write loops by using day precision only
    // Writing the sort key updates the modified time, which triggers re-evaluation, which creates a new sort key (if using seconds), which triggers write...
    if (source === "date-modified" || field.includes("modified") || field.includes("updated")) {
      return result.substring(0, 10); // YYYY-MM-DD
    }

    return result;
  }

  private isDateFrontmatterSegment(segment: SortSegmentRule): boolean {
    if (segment.source !== "frontmatter") {
      return false;
    }

    const field = String(segment.field || "").trim().toLowerCase();
    return RuleEngine.DATE_SORT_FIELDS.has(field);
  }

  private looksLikeDateValue(rawValue: string): boolean {
    const value = String(rawValue || "").trim();
    if (!value) {
      return false;
    }

    const normalized = value.replace(/^['"]|['"]$/g, "");
    return (
      /^\d{4}-\d{2}-\d{2}/.test(normalized) ||
      /^\d{4}\/\d{2}\/\d{2}/.test(normalized) ||
      /t\d{2}:\d{2}/i.test(normalized)
    );
  }

  private formatSortTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = this.pad2(date.getMonth() + 1);
    const day = this.pad2(date.getDate());
    const hours = this.pad2(date.getHours());
    const minutes = this.pad2(date.getMinutes());
    const seconds = this.pad2(date.getSeconds());
    return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
  }

  private pad2(value: number): string {
    return String(value).padStart(2, "0");
  }

  private normalizeSortKeyPart(rawPart: string, separator: string): string {
    const part = String(rawPart || "").trim();
    if (!part) {
      return "";
    }

    const separatorSafe = escapeRegExp(separator);
    const separatorPattern = new RegExp(separatorSafe, "g");

    return part
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, "-")
      .replace(separatorPattern, "-")
      .replace(/^[-_]+|[-_]+$/g, "");
  }
}

function normalizePath(path: string): string {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
