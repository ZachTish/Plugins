import { WorkspaceLeaf } from "obsidian";
import {
  TPSGlobalContextMenuSettings,
  ViewModeConditionOperator,
  ViewModeConditionType,
  ViewModeRule,
  ViewModeRuleCondition,
  ViewModeRuleMatch,
} from "./types";

export type NormalizedViewMode = "reading" | "preview" | "source" | "live";

export class ViewModeService {
  normalizeMode(value: unknown): NormalizedViewMode | null {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized === "reading" || normalized === "preview" || normalized === "source" || normalized === "live") {
      return normalized;
    }
    return null;
  }

  shouldIgnorePath(path: string, ignoredFoldersRaw: string | undefined): boolean {
    if (!ignoredFoldersRaw) return false;
    const ignored = ignoredFoldersRaw
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    return ignored.some((prefix) => path.startsWith(prefix));
  }

  resolveTargetMode(
    frontmatter: Record<string, unknown> | undefined,
    settings: TPSGlobalContextMenuSettings,
    derivedContext: Record<string, unknown> = {}
  ): { mode: NormalizedViewMode | null; source: "explicit" | "rule" | "none"; invalidExplicit?: string } {
    const data: Record<string, unknown> = {
      ...(frontmatter || {}),
      ...derivedContext,
    };
    if (!frontmatter && Object.keys(derivedContext).length === 0) return { mode: null, source: "none" };
    let invalidExplicit: string | undefined;

    if (settings.viewModeFrontmatterKey) {
      const explicitRaw = data[settings.viewModeFrontmatterKey];
      const explicitMode = this.normalizeMode(explicitRaw);
      const explicitValue = String(explicitRaw ?? "").trim();
      if (explicitMode) {
        return { mode: explicitMode, source: "explicit" };
      }
      if (explicitValue) {
        invalidExplicit = explicitValue;
      }
    }

    for (const rule of settings.viewModeRules || []) {
      const ruleMode = this.normalizeMode(rule.mode);
      if (!ruleMode) continue;
      if (!this.ruleMatches(rule, data)) continue;
      return { mode: ruleMode, source: "rule", invalidExplicit };
    }

    return { mode: null, source: "none", invalidExplicit };
  }

  private ruleMatches(rule: ViewModeRule, data: Record<string, unknown>): boolean {
    const conditions = this.getRuleConditions(rule);
    if (!conditions.length) return false;
    const match = this.normalizeMatch(rule.match);
    const results = conditions.map((condition) => this.conditionMatches(condition, data));
    return match === "any" ? results.some(Boolean) : results.every(Boolean);
  }

  private getRuleConditions(rule: ViewModeRule): ViewModeRuleCondition[] {
    if (Array.isArray(rule.conditions) && rule.conditions.length) {
      return rule.conditions.filter((condition) => !!condition && typeof condition === "object");
    }

    // Backward compatibility for legacy key/value rules
    const legacyKey = String(rule.key ?? "").trim();
    const legacyValue = String(rule.value ?? "").trim();
    if (!legacyKey || !legacyValue) return [];

    return [{
      type: "frontmatter",
      key: legacyKey,
      operator: "equals",
      value: legacyValue,
    }];
  }

  private normalizeMatch(match: unknown): ViewModeRuleMatch {
    return String(match ?? "").trim().toLowerCase() === "any" ? "any" : "all";
  }

  private conditionMatches(condition: ViewModeRuleCondition, data: Record<string, unknown>): boolean {
    const type = this.normalizeConditionType(condition.type);
    if (type === "path") {
      return this.matchStringCondition(
        String(data.path ?? data.filePath ?? ""),
        this.normalizeOperator(condition.operator, type),
        condition.value,
      );
    }

    if (type === "frontmatter") {
      const key = String(condition.key ?? "").trim();
      if (!key) return false;
      return this.matchStringCondition(
        data[key],
        this.normalizeOperator(condition.operator, type),
        condition.value,
      );
    }

    if (type === "scheduled") {
      const key = String(condition.key ?? "scheduled").trim() || "scheduled";
      const rawValue = data[key] ?? data.scheduled;
      return this.matchDateRelation(rawValue, this.normalizeOperator(condition.operator, type));
    }

    const dailyRelation = this.normalizeDateRelation(data.dailyNoteRelation);
    return this.matchNormalizedRelation(dailyRelation, this.normalizeOperator(condition.operator, type));
  }

  private normalizeConditionType(type: unknown): ViewModeConditionType {
    const normalized = String(type ?? "").trim().toLowerCase();
    if (normalized === "path") return "path";
    if (normalized === "scheduled") return "scheduled";
    if (normalized === "daily-note") return "daily-note";
    return "frontmatter";
  }

  private normalizeOperator(operator: unknown, type: ViewModeConditionType): ViewModeConditionOperator {
    const normalized = String(operator ?? "").trim().toLowerCase() as ViewModeConditionOperator;
    const pathOps: ViewModeConditionOperator[] = ["contains", "equals", "starts-with", "ends-with", "not-contains", "exists", "missing"];
    const frontmatterOps: ViewModeConditionOperator[] = ["equals", "contains", "not-equals", "not-contains", "exists", "missing"];
    const dateOps: ViewModeConditionOperator[] = ["past", "future", "today", "not-today", "exists", "missing"];

    if (type === "path") {
      if (pathOps.includes(normalized)) return normalized;
      return "contains";
    }
    if (type === "frontmatter") {
      if (frontmatterOps.includes(normalized)) return normalized;
      return "equals";
    }
    if (dateOps.includes(normalized)) return normalized;
    return "past";
  }

  private matchStringCondition(rawValue: unknown, operator: ViewModeConditionOperator, rawNeedle?: string): boolean {
    const leftRaw = String(rawValue ?? "").trim();
    const rightRaw = String(rawNeedle ?? "").trim();
    const left = leftRaw.toLowerCase();
    const right = rightRaw.toLowerCase();

    if (operator === "exists") return !!leftRaw;
    if (operator === "missing") return !leftRaw;
    if (!leftRaw || !rightRaw) return false;
    if (operator === "equals") return left === right;
    if (operator === "not-equals") return left !== right;
    if (operator === "starts-with") return left.startsWith(right);
    if (operator === "ends-with") return left.endsWith(right);
    if (operator === "not-contains") return !left.includes(right);
    return left.includes(right);
  }

  private matchDateRelation(rawValue: unknown, operator: ViewModeConditionOperator): boolean {
    const parsed = this.parseDate(rawValue);
    if (!parsed) {
      return operator === "missing";
    }
    if (operator === "exists") return true;

    const rawText = String(rawValue ?? "").trim();
    const hasTimeComponent = /[T\s]\d{1,2}:\d{2}/.test(rawText);
    const now = new Date();
    const parsedDay = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()).getTime();
    const nowDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

    if (operator === "today") return parsedDay === nowDay;
    if (operator === "not-today") return parsedDay !== nowDay;
    if (operator === "past") {
      if (hasTimeComponent) return parsed.getTime() < now.getTime();
      return parsedDay < nowDay;
    }
    if (operator === "future") {
      if (hasTimeComponent) return parsed.getTime() > now.getTime();
      return parsedDay > nowDay;
    }
    return false;
  }

  private matchNormalizedRelation(
    relation: "past" | "today" | "future" | "none",
    operator: ViewModeConditionOperator,
  ): boolean {
    if (operator === "exists") return relation !== "none";
    if (operator === "missing") return relation === "none";
    if (operator === "past") return relation === "past";
    if (operator === "future") return relation === "future";
    if (operator === "today") return relation === "today";
    if (operator === "not-today") return relation === "past" || relation === "future";
    return false;
  }

  private normalizeDateRelation(value: unknown): "past" | "today" | "future" | "none" {
    const relation = String(value ?? "").trim().toLowerCase();
    if (relation === "past" || relation === "today" || relation === "future") return relation;
    return "none";
  }

  private parseDate(rawValue: unknown): Date | null {
    const text = String(rawValue ?? "").trim();
    if (!text) return null;

    const momentLib = (window as any)?.moment;
    if (momentLib) {
      const parsed = momentLib(text, [
        momentLib.ISO_8601,
        "YYYY-MM-DD",
        "YYYY-MM-DD HH:mm",
        "YYYY-MM-DD HH:mm:ss",
        "MM/DD/YYYY",
        "MM/DD/YYYY HH:mm",
      ], true);
      if (parsed?.isValid?.()) {
        return parsed.toDate();
      }
      const fallback = momentLib(text);
      if (fallback?.isValid?.()) {
        return fallback.toDate();
      }
    }

    const nativeDate = new Date(text);
    return Number.isNaN(nativeDate.getTime()) ? null : nativeDate;
  }

  matchesMode(state: ReturnType<WorkspaceLeaf["getViewState"]>, targetMode: NormalizedViewMode): boolean {
    if (targetMode === "reading" || targetMode === "preview") {
      return state.state.mode === "preview";
    }
    if (targetMode === "source") {
      return state.state.mode === "source" && state.state.source === true;
    }
    return state.state.mode === "source" && state.state.source === false;
  }

  applyModeToState(
    state: ReturnType<WorkspaceLeaf["getViewState"]>,
    targetMode: NormalizedViewMode
  ): { state: ReturnType<WorkspaceLeaf["getViewState"]>; needsUpdate: boolean } {
    let needsUpdate = false;
    if (targetMode === "reading" || targetMode === "preview") {
      if (state.state.mode !== "preview") {
        state.state.mode = "preview";
        needsUpdate = true;
      }
      return { state, needsUpdate };
    }
    if (targetMode === "source") {
      if (state.state.mode !== "source" || state.state.source !== true) {
        state.state.mode = "source";
        state.state.source = true;
        needsUpdate = true;
      }
      return { state, needsUpdate };
    }
    if (state.state.mode !== "source" || state.state.source !== false) {
      state.state.mode = "source";
      state.state.source = false;
      needsUpdate = true;
    }
    return { state, needsUpdate };
  }
}
