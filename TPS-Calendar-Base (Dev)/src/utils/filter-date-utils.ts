/**
 * Pure utility functions for parsing and evaluating filter date expressions.
 * Extracted from CalendarView to keep the class lean.
 */

export function isLowerBoundOperator(operator: string): boolean {
  const op = String(operator || "").toLowerCase().replace(/\s+/g, "");
  return op.includes(">") || op.includes("after") || op.includes("greater");
}

export function isUpperBoundOperator(operator: string): boolean {
  const op = String(operator || "").toLowerCase().replace(/\s+/g, "");
  return op.includes("<") || op.includes("before") || op.includes("less");
}

export function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function normalizeFilterValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = normalizeFilterValue(item);
      if (normalized !== null) return normalized;
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidateKeys = [
      "value", "text", "raw", "expression", "expr",
      "query", "code", "source", "literal",
    ];
    for (const key of candidateKeys) {
      if (!(key in record)) continue;
      const normalized = normalizeFilterValue(record[key]);
      if (normalized !== null) return normalized;
    }
  }
  return null;
}

export function parseRelativeDurationMs(expression: string): number | null {
  let normalized = expression.trim();
  if (!normalized) return null;

  const durationFnMatch = normalized.match(/^(duration|date)\((.+)\)$/i);
  if (durationFnMatch) {
    normalized = durationFnMatch[2].trim();
  }
  normalized = stripOuterQuotes(normalized);
  if (!normalized) return null;

  const match = normalized.match(
    /^(-?\d+(?:\.\d+)?)\s*(day|days|d|week|weeks|w|month|months|mo|hour|hours|hr|hrs|minute|minutes|min|mins)$/i
  );
  if (!match) return null;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;

  const unit = match[2].toLowerCase();
  const unitMs =
    unit === "day" || unit === "days" || unit === "d"
      ? 24 * 60 * 60 * 1000
      : unit === "week" || unit === "weeks" || unit === "w"
        ? 7 * 24 * 60 * 60 * 1000
        : unit === "month" || unit === "months" || unit === "mo"
          ? 30 * 24 * 60 * 60 * 1000
          : unit === "hour" || unit === "hours" || unit === "hr" || unit === "hrs"
            ? 60 * 60 * 1000
            : 60 * 1000;

  return amount * unitMs;
}

export function resolveFilterDateAtom(expression: string): Date | null {
  const lowered = expression.toLowerCase();
  if (lowered === "today()") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  }
  if (lowered === "now()") {
    return new Date();
  }

  const dateFnMatch = expression.match(/^date\((.+)\)$/i);
  if (dateFnMatch) {
    const inner = stripOuterQuotes(dateFnMatch[1].trim());
    if (!inner) return null;
    const relativeMs = parseRelativeDurationMs(inner);
    if (relativeMs !== null) {
      const base = new Date();
      base.setHours(0, 0, 0, 0);
      base.setTime(base.getTime() + relativeMs);
      return base;
    }
    const parsedDate = new Date(inner);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
  }

  const absoluteDate = new Date(expression);
  if (!Number.isNaN(absoluteDate.getTime())) {
    return absoluteDate;
  }
  return null;
}

export function resolveFilterDateExpression(value: unknown): Date | null {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const normalized = normalizeFilterValue(value);
  if (!normalized) return null;

  const expression = stripOuterQuotes(normalized.trim());
  if (!expression) return null;

  const direct = resolveFilterDateAtom(expression);
  if (direct) return direct;

  const arithmeticMatch = expression.match(/^(.+?)\s*([+-])\s*(.+)$/);
  if (!arithmeticMatch) return null;

  const [, leftExpr, op, rightExpr] = arithmeticMatch;
  const baseDate = resolveFilterDateExpression(leftExpr.trim());
  const durationMs = parseRelativeDurationMs(rightExpr.trim());
  if (!baseDate || durationMs === null) return null;

  const result = new Date(baseDate.getTime());
  result.setTime(result.getTime() + (op === "+" ? durationMs : -durationMs));
  return result;
}

export function getAutoRangeViewDayCount(diffDays: number): number {
  if (diffDays <= 1) return 1;
  if (diffDays <= 3) return 3;
  if (diffDays <= 4) return 4;
  if (diffDays <= 5) return 5;
  if (diffDays <= 7) return 7;
  return 30;
}
