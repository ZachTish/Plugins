import { normalizePath } from "obsidian";

export interface DailyNotePathOptions {
  formatOverride?: string | null;
  folderOverride?: string | null;
  templateOverride?: string | null;
}

export interface DailyNoteResolver {
  source: "core" | "periodic" | "fallback";
  rawFormat: string;
  displayFormat: string;
  folder: string;
  template: string;
  formatDateKey: (date: Date) => string;
  formatFilename: (date: Date) => string;
  parseFilenameToDateKey: (basename: string) => string | null;
  buildPath: (date: Date, extension?: string) => string;
  isDailyNoteBasename: (basename: string) => boolean;
}

const FALLBACK_FORMAT = "YYYY-MM-DD";
const COMMON_DATE_FORMATS = [
  "dddd, MMMM Do YYYY",
  "ddd, MMMM Do YYYY",
  "dddd, MMM Do YYYY",
  "ddd, MMM D YYYY",
  "dddd, MMMM D YYYY",
  "MMMM D, YYYY",
  "MMM D, YYYY",
  "YYYY-MM-DD",
  "YYYY_MM_DD",
  "YYYYMMDD",
];

let resolverCache = new WeakMap<object, Map<string, DailyNoteResolver>>();

function getMoment(): any | null {
  return (window as any)?.moment ?? null;
}

function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function readBaseConfig(app: any): {
  source: "core" | "periodic" | "fallback";
  rawFormat: string;
  folder: string;
  template: string;
} {
  try {
    const periodicNotes = (app as any)?.plugins?.getPlugin?.("periodic-notes");
    if (periodicNotes?.settings?.daily) {
      return {
        source: "periodic",
        rawFormat: String(periodicNotes.settings.daily.format || FALLBACK_FORMAT).trim() || FALLBACK_FORMAT,
        folder: String(periodicNotes.settings.daily.folder || "").trim(),
        template: String(periodicNotes.settings.daily.template || "").trim(),
      };
    }
  } catch {
    // Ignore plugin lookup failures.
  }

  try {
    const dailyNotes =
      (app as any)?.internalPlugins?.getPluginById?.("daily-notes") ??
      (app as any)?.internalPlugins?.plugins?.["daily-notes"];
    const options = dailyNotes?.instance?.options ?? dailyNotes?.options;
    if (options) {
      return {
        source: "core",
        rawFormat: String(options.format || FALLBACK_FORMAT).trim() || FALLBACK_FORMAT,
        folder: String(options.folder || "").trim(),
        template: String(options.template || "").trim(),
      };
    }
  } catch {
    // Ignore plugin lookup failures.
  }

  return {
    source: "fallback",
    rawFormat: FALLBACK_FORMAT,
    folder: "",
    template: "",
  };
}

function buildCandidateFormats(rawFormat: string, preferredFormat?: string | null): string[] {
  const formats: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed || formats.includes(trimmed)) return;
    formats.push(trimmed);
  };

  push(preferredFormat ?? "");
  push(rawFormat);
  for (const format of COMMON_DATE_FORMATS) push(format);
  return formats;
}

function inferDisplayFormat(app: any, rawFormat: string, folder: string, preferredFormat?: string | null): string {
  const m = getMoment();
  if (!m) return String(preferredFormat || rawFormat || FALLBACK_FORMAT).trim() || FALLBACK_FORMAT;

  const normalizedFolder = normalizePath(String(folder || "").trim()).replace(/\\/g, "/");
  const formats = buildCandidateFormats(rawFormat, preferredFormat);

  const candidates = app.vault.getFiles().filter((file: any) => {
    if (file.extension !== "md") return false;
    if (!normalizedFolder) return true;
    const parentPath = normalizePath(file.parent?.path || "").replace(/\\/g, "/");
    return parentPath === normalizedFolder;
  });

  for (const file of candidates) {
    for (const format of formats) {
      const parsed = m(file.basename, [format], true);
      if (parsed?.isValid?.()) return format;
    }
  }

  return String(preferredFormat || rawFormat || FALLBACK_FORMAT).trim() || FALLBACK_FORMAT;
}

function parseDateKeyFromFilename(basename: string, displayFormat: string, rawFormat: string): string | null {
  const text = String(basename || "").trim();
  if (!text) return null;

  const m = getMoment();
  if (!m) return null;

  const whole = m(text, buildCandidateFormats(rawFormat, displayFormat), true);
  if (whole?.isValid?.()) return whole.format("YYYY-MM-DD");

  const tokenMatch = text.match(/(\d{4}[-_/]\d{2}[-_/]\d{2}|\d{8})$/);
  if (!tokenMatch) return null;

  const token = m(tokenMatch[1], ["YYYY-MM-DD", "YYYY_MM_DD", "YYYYMMDD"], true);
  return token?.isValid?.() ? token.format("YYYY-MM-DD") : null;
}

export function getDailyNoteResolver(app: any, options?: DailyNotePathOptions): DailyNoteResolver {
  const base = readBaseConfig(app);
  const rawFormat = String(options?.formatOverride ?? base.rawFormat ?? FALLBACK_FORMAT).trim() || FALLBACK_FORMAT;
  const folder = String(options?.folderOverride ?? base.folder ?? "").trim();
  const template = String(options?.templateOverride ?? base.template ?? "").trim();
  const cacheKey = JSON.stringify({
    source: base.source,
    rawFormat,
    folder,
    template,
    preferred: options?.formatOverride ?? null,
  });

  let appCache = resolverCache.get(app);
  if (!appCache) {
    appCache = new Map<string, DailyNoteResolver>();
    resolverCache.set(app, appCache);
  }

  const cached = appCache.get(cacheKey);
  if (cached) return cached;

  const displayFormat = inferDisplayFormat(app, base.rawFormat, folder, options?.formatOverride ?? null);
  const m = getMoment();
  const resolver: DailyNoteResolver = {
    source: base.source,
    rawFormat,
    displayFormat,
    folder,
    template,
    formatDateKey(date: Date): string {
      return toDateKey(date);
    },
    formatFilename(date: Date): string {
      if (m) {
        const parsed = m(date);
        if (parsed?.isValid?.()) return parsed.format(displayFormat);
      }
      return toDateKey(date);
    },
    parseFilenameToDateKey(basename: string): string | null {
      return parseDateKeyFromFilename(basename, displayFormat, rawFormat);
    },
    buildPath(date: Date, extension = "md"): string {
      const ext = String(extension || "md").replace(/^\./, "");
      const fileName = `${this.formatFilename(date)}.${ext}`;
      return folder ? normalizePath(`${folder}/${fileName}`) : normalizePath(fileName);
    },
    isDailyNoteBasename(basename: string): boolean {
      return this.parseFilenameToDateKey(basename) !== null;
    },
  };

  appCache.set(cacheKey, resolver);
  return resolver;
}

export function clearDailyNoteResolverCache(app?: object): void {
  if (app) {
    resolverCache.delete(app);
    return;
  }
  resolverCache = new WeakMap<object, Map<string, DailyNoteResolver>>();
}
