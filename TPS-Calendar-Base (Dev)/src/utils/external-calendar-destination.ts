import { normalizePath } from "obsidian";
import type { ExternalCalendarConfig } from "../types";

function normalizeDestinationPath(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  const normalized = normalizePath(value).replace(/^\/+|\/+$/g, "").trim();
  if (!normalized || normalized === "." || normalized === "/") return "";
  return normalized;
}

export function resolveExternalCalendarNoteTargetFolder(
  calendar: ExternalCalendarConfig | null | undefined,
): string {
  const explicitFolder = normalizeDestinationPath(calendar?.autoCreateFolder);
  if (explicitFolder) return explicitFolder;
  return normalizeDestinationPath(calendar?.autoCreateTypeFolder);
}

export function getExternalCalendarConfigWarning(
  calendar: ExternalCalendarConfig | null | undefined,
): string | null {
  const typeFolder = normalizeDestinationPath(calendar?.autoCreateTypeFolder);
  const folder = normalizeDestinationPath(calendar?.autoCreateFolder);
  if (!typeFolder || !folder || typeFolder === folder) return null;
  return `Calendar "${calendar?.id || "unknown"}" has both Type Folder ("${typeFolder}") and Folder ("${folder}") configured. Folder will be used as the destination.`;
}
