import { TFile } from "obsidian";

export type TemplateVars = Record<string, unknown>;

function pad(num: number): string {
  return String(num).padStart(2, "0");
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function flattenObject(prefix: string, value: unknown, out: TemplateVars): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(source)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    out[nextKey] = nested;
    flattenObject(nextKey, nested, out);
  }
}

export function buildTemplateVars(targetFile: TFile | null, extra: TemplateVars = {}): TemplateVars {
  const now = new Date();
  const base: TemplateVars = {
    title: targetFile?.basename ?? "",
    date: formatDate(now),
    time: formatTime(now),
    datetime: now.toISOString(),
    timestamp: String(now.getTime()),
    file_name: targetFile?.name ?? "",
    file_basename: targetFile?.basename ?? "",
    file_path: targetFile?.path ?? "",
    file_folder: targetFile ? targetFile.path.replace(/\/[^/]+$/, "") : "",
  };

  const merged: TemplateVars = { ...base, ...extra };
  flattenObject("", merged, merged);
  return merged;
}

export function applyTemplateVars(content: string, vars: TemplateVars): string {
  return content.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token: string) => {
    const value = vars[token];
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  });
}
