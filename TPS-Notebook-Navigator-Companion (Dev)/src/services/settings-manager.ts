import { DEFAULT_SETTINGS, NotebookNavigatorCompanionSettings } from "../types";
import { Logger } from "./logger";

interface PluginDataHost {
  loadData(): Promise<unknown>;
  saveData(data: unknown): Promise<void>;
}

export class SettingsManager {
  private readonly host: PluginDataHost;
  private readonly logger: Logger;

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

    const sanitized = this.sanitizeSettings(loadedData);

    if (this.shouldPruneLegacyNotebookRuleSettings(loadedData)) {
      try {
        await this.host.saveData(sanitized);
      } catch (error) {
        this.logger.error("Failed to prune migrated notebook rule settings during load", error);
      }
    }

    return sanitized;
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

    return {
      metadataDebounceMs: asNumber(record.metadataDebounceMs, DEFAULT_SETTINGS.metadataDebounceMs, 0, 5000),
      syncTitleFromFilename: asBoolean(record.syncTitleFromFilename, DEFAULT_SETTINGS.syncTitleFromFilename),
      syncFilenameFromTitle: asBoolean(record.syncFilenameFromTitle, DEFAULT_SETTINGS.syncFilenameFromTitle),
      statusClickFlow: normalizeStringsArray(record.statusClickFlow, DEFAULT_SETTINGS.statusClickFlow),
      tagPageFolder: normalizeOptionalString(record.tagPageFolder),
      tagPageFileType: this.normalizeTagPageFileType(record.tagPageFileType, DEFAULT_SETTINGS.tagPageFileType),
      createTagPageOnOpen: asBoolean(record.createTagPageOnOpen, DEFAULT_SETTINGS.createTagPageOnOpen),
      propertyPageFolder: normalizeOptionalString(record.propertyPageFolder),
      propertyPageFileType: this.normalizeTagPageFileType(record.propertyPageFileType, DEFAULT_SETTINGS.propertyPageFileType),
      createPropertyPageOnOpen: asBoolean(record.createPropertyPageOnOpen, DEFAULT_SETTINGS.createPropertyPageOnOpen),
      upstreamLinkKeys: normalizeStringsArray(record.upstreamLinkKeys, DEFAULT_SETTINGS.upstreamLinkKeys),
      frontmatterWriteExclusions: normalizeMultilineString(
        record.frontmatterWriteExclusions,
        DEFAULT_SETTINGS.frontmatterWriteExclusions
      ),
      debugLogging: asBoolean(record.debugLogging, DEFAULT_SETTINGS.debugLogging)
    };
  }

  private shouldPruneLegacyNotebookRuleSettings(raw: unknown): boolean {
    const record = asRecord(raw);
    if (Object.keys(record).length === 0) {
      return false;
    }

    const legacyKeys = [
      'frontmatterIconField',
      'frontmatterColorField',
      'writeBasesIconFields',
      'basesIconMarkdownField',
      'basesIconUriField',
      'noteCheckboxIconColor',
      'clearIconWhenNoMatch',
      'clearColorWhenNoMatch',
      'rules',
      'autoRemoveHiddenWhenNoMatch',
      'smartSort',
      'hideRules',
      'sortRules',
      'enabled',
      'autoApplyOnFileOpen',
      'autoApplyOnMetadataChange',
      'applyOnStartup',
      'startupDelayMs',
    ];

    return legacyKeys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
  }

  private normalizeTagPageFileType(
    value: unknown,
    fallback: "canvas" | "markdown" | "base",
  ): "canvas" | "markdown" | "base" {
    const normalized = normalizeString(value, fallback).trim().toLowerCase();
    if (normalized === "canvas") return "canvas";
    if (normalized === "base") return "base";
    if (normalized === "markdown" || normalized === "md") return "markdown";
    return fallback;
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
