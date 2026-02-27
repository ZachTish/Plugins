import { ExternalCalendarConfig } from "./types";

const MIN_SLOT_ZOOM = 0.15;  // Minimum zoom (most condensed)
const MAX_SLOT_ZOOM = 1.5;   // Maximum zoom (most expanded)
const BASE_SLOT_HEIGHT = 60; // Base height in pixels for 30-min slot
export const MAX_CONDENSE_LEVEL = 220;

export const DEFAULT_CONDENSE_LEVEL = 80;

export const DEFAULT_PRIORITY_COLOR_MAP: Record<string, string> = {
  low: "#9ca3af",
  normal: "#60a5fa",
  medium: "#facc15",
  high: "#f87171",
};

export const DEFAULT_STATUS_STYLE_MAP: Record<string, string> = {
  open: "normal",
  complete: "strikethrough",
  completed: "strikethrough",
  "wont-do": "strikethrough",
  working: "bold",
  blocked: "italic",
};

export function parseStyleMapping(
  value: unknown,
  defaults: Record<string, string>,
): Record<string, string> {
  if (!value) {
    return { ...defaults };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const map: Record<string, string> = { ...defaults };
    for (const [key, val] of Object.entries(value as Record<string, string>)) {
      if (typeof val === "string" && val.trim()) {
        map[key.toLowerCase()] = val.trim();
      }
    }
    return map;
  }
  const raw = String(value);
  const entries = raw
    .split(/[,;\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const map: Record<string, string> = { ...defaults };
  for (const entry of entries) {
    const [key, mapped] = entry.split(":").map((text) => text.trim());
    if (!key || !mapped) continue;
    map[key.toLowerCase()] = mapped;
  }
  return map;
}

export function basesCalendarFormatTimeEstimate(minutes: number): string {
  const total = Math.max(1, Math.round(minutes));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours && mins) {
    return `${hours}h ${mins}m`;
  }
  if (hours) {
    return `${hours}h`;
  }
  return `${mins}m`;
}

export function formatDateTimeForFrontmatter(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function formatTimeRange(start?: Date | null, end?: Date | null): string {
  if (!start) return "";
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  const formatter = new Intl.DateTimeFormat(undefined, options);
  const startLabel = formatter.format(start);
  if (!end) return startLabel;
  const endLabel = formatter.format(end);
  return `${startLabel} - ${endLabel}`;
}

export function calculateSlotZoom(condenseLevel: number): number {
  const safeLevel = Math.max(0, Math.min(MAX_CONDENSE_LEVEL, condenseLevel));
  const range = MAX_SLOT_ZOOM - MIN_SLOT_ZOOM;
  return MAX_SLOT_ZOOM - (safeLevel / MAX_CONDENSE_LEVEL) * range;
}

export function calculateSlotHeightFromZoom(zoom: number): number {
  return Math.max(4, Math.round(BASE_SLOT_HEIGHT * zoom));
}

export function formatZoomLabel(condenseLevel: number): string {
  const zoom = calculateSlotZoom(condenseLevel);
  return `${zoom.toFixed(2)}x`;
}

export const normalizeCalendarUrl = (url: string | null | undefined): string => {
  if (!url) return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (trimmed.toLowerCase().startsWith("webcal://")) {
    return `https://${trimmed.slice("webcal://".length)}`;
  }
  return trimmed;
};

export const normalizeCalendarTag = (tag: string | null | undefined): string => {
  const raw = typeof tag === "string" ? tag.trim() : "";
  if (!raw) return "";
  return raw.replace(/^#+/, "").trim().toLowerCase();
};

export const normalizeExternalCalendar = (
  calendar: any,
  fallback: { color?: string } = {},
): ExternalCalendarConfig => {
  const url = normalizeCalendarUrl(
    typeof calendar?.url === "string" ? calendar.url : "",
  );
  return {
    id:
      typeof calendar?.id === "string"
        ? calendar.id
        : `calendar-${Math.random().toString(36).slice(2, 8)}`,
    url,
    color:
      typeof calendar?.color === "string"
        ? calendar.color.trim()
        : fallback.color ?? "",
    enabled: calendar?.enabled !== false,
    autoCreateEnabled: calendar?.autoCreateEnabled !== false,
    autoCreateTypeFolder:
      typeof calendar?.autoCreateTypeFolder === "string"
        ? calendar.autoCreateTypeFolder.trim()
        : "",
    autoCreateFolder:
      typeof calendar?.autoCreateFolder === "string"
        ? calendar.autoCreateFolder.trim()
        : "",
    autoCreateTag: normalizeCalendarTag(
      typeof calendar?.autoCreateTag === "string" ? calendar.autoCreateTag : "",
    ),
    autoCreateTemplate:
      typeof calendar?.autoCreateTemplate === "string"
        ? calendar.autoCreateTemplate.trim()
        : "",
  };
};