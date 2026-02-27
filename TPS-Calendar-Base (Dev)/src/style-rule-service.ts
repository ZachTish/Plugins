/**
 * Calendar style rule constants, normalization, evaluation, and legacy migration.
 * Extracted from main.ts to keep the plugin entry point focused on lifecycle.
 */

import {
  CalendarStyleRule,
  CalendarStyleCondition,
  CalendarField,
  CalendarOperator,
  CalendarStyleMatch,
} from "./types";
import {
  DEFAULT_PRIORITY_COLOR_MAP,
  DEFAULT_STATUS_STYLE_MAP,
} from "./utils";

// --- Constants ---

export const PRIORITY_KEYS = ["low", "normal", "medium", "high"];
export const STATUS_KEYS = ["open", "complete", "wont-do", "working", "blocked"];

export const CALENDAR_OPERATORS: CalendarOperator[] = [
  "is",
  "!is",
  "contains",
  "!contains",
  "starts",
  "!starts",
  "ends",
  "!ends",
  "exists",
  "!exists",
];

export const DEFAULT_MATCH: CalendarStyleMatch = "all";

export const createDefaultCondition = (): CalendarStyleCondition => ({
  field: "status",
  operator: "is",
  value: "",
});

// --- Normalization ---

export const normalizeStoredRule = (rule: any): CalendarStyleRule => ({
  id:
    typeof rule?.id === "string"
      ? rule.id
      : `rule-${Math.random().toString(36).slice(2, 8)}`,
  label: rule?.label || "",
  active: rule?.active !== false,
  match: rule?.match || DEFAULT_MATCH,
  conditions:
    rule?.conditions && Array.isArray(rule.conditions) && rule.conditions.length
      ? rule.conditions.map((condition: any) => ({
        field:
          condition?.field === "priority" ? "priority" : ("status" as CalendarField),
        operator:
          condition?.operator && CALENDAR_OPERATORS.includes(condition.operator)
            ? condition.operator
            : "is",
        value: condition?.value ? String(condition.value) : "",
      }))
      : [createDefaultCondition()],
  color: rule?.color || "",
  textStyle: rule?.textStyle || "",
});

// --- Evaluation ---

export const evaluateCondition = (
  data: Record<string, any>,
  condition: CalendarStyleCondition,
): boolean => {
  const field = condition.field;
  const value = data[field] !== undefined ? String(data[field]) : ""; // Graceful fallback

  const normalizedValue = (value || "").toLowerCase();
  const normalizedTarget = (condition.value || "").toLowerCase();
  switch (condition.operator) {
    case "is":
      return normalizedValue === normalizedTarget;
    case "!is":
      return normalizedValue !== normalizedTarget;
    case "contains":
      return normalizedValue.includes(normalizedTarget);
    case "!contains":
      return !normalizedValue.includes(normalizedTarget);
    case "starts":
      return normalizedValue.startsWith(normalizedTarget);
    case "!starts":
      return !normalizedValue.startsWith(normalizedTarget);
    case "ends":
      return normalizedValue.endsWith(normalizedTarget);
    case "!ends":
      return !normalizedValue.endsWith(normalizedTarget);
    case "exists":
      return normalizedValue.length > 0;
    case "!exists":
      return normalizedValue.length === 0;
    default:
      return false;
  }
};

export const ruleHasMeaning = (rule: CalendarStyleRule): boolean => {
  const hasCondition = rule.conditions.some((condition) => {
    if (["exists", "!exists"].includes(condition.operator)) return true;
    return Boolean(condition.value?.trim());
  });
  const hasStyle = Boolean(rule.color?.trim()) || Boolean(rule.textStyle?.trim());
  return hasCondition || hasStyle;
};

// --- Legacy migration builders ---

export const buildLegacyColorRules = (stored: any = {}): CalendarStyleRule[] => {
  const storedPriorityColors = stored?.priorityColors ?? stored?.priorityColorMap ?? {};
  const priorityColorMap: Record<string, string> = {
    ...DEFAULT_PRIORITY_COLOR_MAP,
    ...Object.fromEntries(
      Object.entries(storedPriorityColors).map(([key, value]) => [
        key.toLowerCase(),
        String(value || "").trim(),
      ]),
    ),
  };

  return PRIORITY_KEYS.map((priority) => ({
    id: `priority-${priority}`,
    label: `Priority: ${priority}`,
    active: true,
    match: DEFAULT_MATCH,
    conditions: [
      {
        field: "priority" as CalendarField,
        operator: "is" as CalendarOperator,
        value: priority,
      },
    ],
    color: priorityColorMap[priority] ?? DEFAULT_PRIORITY_COLOR_MAP[priority] ?? "",
  }));
};

export const buildLegacyTextRules = (stored: any = {}): CalendarStyleRule[] => {
  const storedStatusStyles = stored?.statusStyles ?? stored?.statusStyleMap ?? {};
  const statusStyleMap: Record<string, string> = {
    ...DEFAULT_STATUS_STYLE_MAP,
    ...Object.fromEntries(
      Object.entries(storedStatusStyles).map(([key, value]) => [
        key.toLowerCase(),
        String(value || "").trim() || "normal",
      ]),
    ),
  };

  const statusSet = Array.from(
    new Set([...STATUS_KEYS, ...Object.keys(statusStyleMap)]),
  );

  return statusSet.map((status) => ({
    id: `status-${status}`,
    label: `Status: ${status}`,
    active: true,
    match: DEFAULT_MATCH,
    conditions: [
      {
        field: "status" as CalendarField,
        operator: "is" as CalendarOperator,
        value: status,
      },
    ],
    textStyle: statusStyleMap[status] ?? "normal",
  }));
};

// --- Style override matching ---

export function findStyleOverride(
  colorRules: CalendarStyleRule[] | undefined | null,
  textRules: CalendarStyleRule[] | undefined | null,
  calendarStyleRules: CalendarStyleRule[] | undefined | null,
  data: Record<string, any>,
): { color: string; textStyle: string } | null {

  const findMatch = (rules: CalendarStyleRule[] | undefined | null) => {
    if (!rules?.length) return null;
    for (const rule of rules) {
      if (rule.active === false) continue;
      const conditions = rule.conditions || [];
      if (!conditions.length) continue;
      const conditionResults = conditions.map((condition) => {
        return evaluateCondition(data, condition);
      });
      const matchMode = rule.match || DEFAULT_MATCH;
      const matches =
        matchMode === "any"
          ? conditionResults.some((result) => result)
          : conditionResults.every((result) => result);
      if (matches) return rule;
    }
    return null;
  };

  const colorMatch = findMatch(colorRules);
  const textMatch = findMatch(textRules);
  const legacyMatch = findMatch(calendarStyleRules);

  const color = colorMatch?.color || legacyMatch?.color || "";
  const textStyle = textMatch?.textStyle || legacyMatch?.textStyle || "";
  if (color || textStyle) {
    return { color, textStyle };
  }
  return null;
}
