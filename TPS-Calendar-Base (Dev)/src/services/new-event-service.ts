import {
  App,
  BasesPropertyId,
  Modal,
  TFile,
  normalizePath,
  parsePropertyId,
  FuzzySuggestModal,
  Notice,
} from "obsidian";
import * as logger from "../logger";
import { formatDateTimeForFrontmatter } from "../utils";
import { applyTemplateVars, buildTemplateVars, type TemplateVars } from "../utils/template-variable-service";
import { TypeFolderOption, TypeFolderService } from "./type-folder-service";
import { resolveTemplateFile } from "../utils/template-resolution-service";
import { mergeTagInputs, normalizeTagValue } from "../utils/tag-utils";
import { applyParentLinkToChild, buildParentLinkTarget } from "./parent-child-link";
import { getPluginById } from "../core";
import { getDailyNoteResolver } from "../../../TPS-Controller (Dev)/src/utils/daily-note-resolver";

export interface NewEventServiceConfig {
  app: App;
  startProperty?: BasesPropertyId | null;
  endProperty?: BasesPropertyId | null;
  allDayProperty?: BasesPropertyId | null;
  folderPath?: string | null;
  templatePath?: string | null;
  templateType?: string | null;
  useEndDuration?: boolean;
  defaultDuration?: number;
  defaultTitle?: string;
  additionalFrontmatter?: Record<string, any>;
  inProgressStatusValue?: string;
  // Parent-child settings
  parentLinkEnabled?: boolean;
  parentLinkKey?: string;
  childLinkKey?: string;
}

export interface NewEventCreationOptions {
  useBaseDefaults?: boolean;
  frontmatterDefaults?: Record<string, any>;
  typeFolderOverride?: string | null;
  templateOverride?: string | null;
  templateTypeOverride?: string | null;
}

export interface PreparedEventCreation {
  title: string;
  folderPath: string;
  path: string;
  templateFile: TFile | null;
  parentFile: TFile | null;
  frontmatter: Record<string, any>;
  frontmatterDefaults: Record<string, any>;
  frontmatterOverrides: Record<string, any>;
  useBaseDefaults: boolean;
  templateVars: TemplateVars;
}

const TASK_LINKED_NOTE_PROPERTY = "linkednote";

export class NewEventService {
  private config: NewEventServiceConfig;
  private modalInput: HTMLInputElement | null = null;
  private focusInterval: number | null = null;
  private createInProgress: boolean = false;
  private pendingExistingParent: TFile | null = null;
  private pendingLinkExisting: boolean = false;
  private pendingTypeFolderPath: string | null = null;
  private readonly typeFolderService: TypeFolderService;
  private readonly malformedFrontmatterWarnedPaths = new Set<string>();

  constructor(config: NewEventServiceConfig) {
    this.config = config;
    this.typeFolderService = new TypeFolderService(config.app);
  }

  updateConfig(config: NewEventServiceConfig) {
    this.config = { ...this.config, ...config };
  }

  async createEvent(
    start: Date,
    end: Date,
    frontmatterOverrides?: Record<string, any>,
    options?: NewEventCreationOptions
  ): Promise<TFile | null> {
    if (this.createInProgress) {
      return null;
    }
    this.createInProgress = true;
    try {
      const rawTitle = await this.promptForTitle(options?.typeFolderOverride);

      if (rawTitle === undefined) {
        this.pendingLinkExisting = false;
        this.pendingTypeFolderPath = null;
        return null;
      }
      if (rawTitle === "__LINK_EXISTING_CANCEL__") {
        this.pendingLinkExisting = false;
        this.pendingTypeFolderPath = null;
        return null;
      }
      const titleInput = rawTitle && rawTitle.trim() ? rawTitle.trim() : "";

      // Extract tags from title
      const { cleanTitle: extractedTitle, tags } = this.extractTags(titleInput);

      // Resolve tags (handle sub-level tags and prompt user if needed)
      const resolvedTags = await this.resolveTags(tags);
      if (resolvedTags === null) {
        // User cancelled tag selection
        return null;
      }

      // Resolve parent link (use pending existing note if selected)
      let parentFile: TFile | null = this.pendingExistingParent;
      const isLinkingExisting = !!parentFile && this.pendingLinkExisting;
      this.pendingExistingParent = null;
      // Parent is only set via explicit user actions (e.g. Link Existing Note).
      // Do not interrupt normal event creation with a parent selection modal.
      if (!isLinkingExisting) {
        parentFile = null;
      }

      this.pendingLinkExisting = false;

      let cleanTitle = extractedTitle;
      if (!cleanTitle || !cleanTitle.trim()) {
        const parentTitle = parentFile?.basename?.trim() || "";
        if (!parentTitle) {
          return null;
        }
        cleanTitle = parentTitle;
      }

      // Check if event is in the past
      let finalOverrides = frontmatterOverrides ? { ...frontmatterOverrides } : {};
      if (end < new Date()) {
        const choice = await this.promptForPastEvent();
        if (choice === "cancel") return null;
        if (choice === "complete") {
          finalOverrides.status = "complete";
          logger.log("Past event marked as complete. Overrides:", finalOverrides);
        }
      } else {
        const now = new Date();
        if (start <= now && end > now) {
          const statusValue = this.config.inProgressStatusValue || "working";
          const choice = await this.promptForInProgressEvent(statusValue);
          if (choice === "cancel") return null;
          if (choice === "in-progress") {
            finalOverrides.status = statusValue;
            logger.log("In-progress event marked as:", statusValue, "Overrides:", finalOverrides);
          }
        }
      }

      const folderPath = this.resolveFolderPath(
        this.pendingTypeFolderPath ?? options?.typeFolderOverride,
      );

      // Ensure folder exists
      await this.ensureFolderExists(folderPath);

      const path = this.buildUniquePath(folderPath, cleanTitle, start);
      const templateFile =
        await this.resolveTemplateSelection(
          options?.templateOverride ?? this.config.templatePath,
          options?.templateTypeOverride ?? this.config.templateType,
        );
      const includeAdditionalFrontmatter = !options?.useBaseDefaults;
      const frontmatter = this.buildFrontmatter(
        cleanTitle,
        start,
        end,
        resolvedTags,
        finalOverrides,
        includeAdditionalFrontmatter
      );

      if (templateFile) {
        // Pre-build template content BEFORE creating the file so it is never born blank.
        // A blank file (a) syncs to other devices as an empty stub, triggering Templater
        // folder-templates there, and (b) creates a race condition where Templater
        // and TPS both try to write to the file at the same time.
        // Instead: create with content → run Templater explicitly (ordered) → apply TPS
        // frontmatter last (additive merge). This is fully deterministic.
        const templateVars: TemplateVars = {
          title: cleanTitle,
          scheduled: frontmatter.scheduled,
          due: frontmatter.due,
          status: frontmatter.status,
          priority: frontmatter.priority,
          tags: resolvedTags,
        };
        const initialContent = await this.buildInitialContent(templateFile, path, templateVars);
        const file = await this.createFileRetrying(path, initialContent || '---\n---\n');
        logger.log(`[NewEventService] Created note: "${file.basename}" at ${file.path}`);

        // Explicitly run Templater to process any remaining <% tp.* %> tags.
        // Done BEFORE applying TPS frontmatter so Templater runs first; TPS then
        // merges its required fields on top (additive, never destructive).
        await this.runTemplaterOnFile(file);

        if (!options?.useBaseDefaults) {
          const frontmatterWithFolder = {
            ...frontmatter,
            folderPath: file.parent?.path || "/",
          };
          await this.applyEventFrontmatter(file, frontmatterWithFolder);
        }

        // Create parent link if selected
        if (parentFile) {
          await this.applyParentLink(file, parentFile);
        }

        // Trigger post-creation hooks (linter, etc.)
        await this.triggerPostCreationHooks(file);

        if (options?.useBaseDefaults) {
          const defaults = options.frontmatterDefaults ?? {};
          const overridesWithFolder = {
            ...frontmatter,
            folderPath: file.parent?.path || "/",
          };
          await this.applyFrontmatterDefaultsAndOverrides(file, defaults, overridesWithFolder);
        }

        return file;
      } else {
        // No template — create with a minimal stub so the file is never blank.
        // Blank files sync to other devices and trigger Templater folder-templates there.
        // If Templater has a folder-template for this folder it will fire via the vault
        // 'create' event and overwrite the stub — that is expected and correct.
        // TPS then applies its frontmatter additively on top.
        const file = await this.createFileRetrying(path, '---\n---\n');

        if (!options?.useBaseDefaults) {
          const frontmatterWithFolder = {
            ...frontmatter,
            folderPath: file.parent?.path || "/",
          };
          await this.applyEventFrontmatter(file, frontmatterWithFolder);
        }

        // Create parent link if selected
        if (parentFile) {
          await this.applyParentLink(file, parentFile);
        }

        // Trigger post-creation hooks (linter, etc.)
        await this.triggerPostCreationHooks(file);

        if (options?.useBaseDefaults) {
          const defaults = options.frontmatterDefaults ?? {};
          const overridesWithFolder = {
            ...frontmatter,
            folderPath: file.parent?.path || "/",
          };
          await this.applyFrontmatterDefaultsAndOverrides(file, defaults, overridesWithFolder);
        }

        return file;
      }
    } catch (error) {
      logger.error('[NewEventService] Error creating event:', error);
      throw error;
    } finally {
      this.createInProgress = false;
      this.pendingTypeFolderPath = null;
    }
  }

  async prepareEventCreation(
    start: Date,
    end: Date,
    frontmatterOverrides?: Record<string, any>,
    options?: NewEventCreationOptions,
  ): Promise<PreparedEventCreation | null> {
    const rawTitle = await this.promptForTitle(options?.typeFolderOverride);

    if (rawTitle === undefined || rawTitle === "__LINK_EXISTING_CANCEL__") {
      this.pendingLinkExisting = false;
      this.pendingTypeFolderPath = null;
      return null;
    }

    const titleInput = rawTitle && rawTitle.trim() ? rawTitle.trim() : "";
    const { cleanTitle: extractedTitle, tags } = this.extractTags(titleInput);
    const resolvedTags = await this.resolveTags(tags);
    if (resolvedTags === null) return null;

    let parentFile: TFile | null = this.pendingExistingParent;
    const isLinkingExisting = !!parentFile && this.pendingLinkExisting;
    this.pendingExistingParent = null;
    if (!isLinkingExisting) {
      parentFile = null;
    }
    this.pendingLinkExisting = false;

    let cleanTitle = extractedTitle;
    if (!cleanTitle || !cleanTitle.trim()) {
      const parentTitle = parentFile?.basename?.trim() || "";
      if (!parentTitle) {
        this.pendingTypeFolderPath = null;
        return null;
      }
      cleanTitle = parentTitle;
    }

    let finalOverrides = frontmatterOverrides ? { ...frontmatterOverrides } : {};
    if (end < new Date()) {
      const choice = await this.promptForPastEvent();
      if (choice === "cancel") {
        this.pendingTypeFolderPath = null;
        return null;
      }
      if (choice === "complete") {
        finalOverrides.status = "complete";
      }
    } else {
      const now = new Date();
      if (start <= now && end > now) {
        const statusValue = this.config.inProgressStatusValue || "working";
        const choice = await this.promptForInProgressEvent(statusValue);
        if (choice === "cancel") {
          this.pendingTypeFolderPath = null;
          return null;
        }
        if (choice === "in-progress") {
          finalOverrides.status = statusValue;
        }
      }
    }

    const folderPath = this.resolveFolderPath(
      this.pendingTypeFolderPath ?? options?.typeFolderOverride,
    );
    await this.ensureFolderExists(folderPath);

    const path = this.buildUniquePath(folderPath, cleanTitle, start);
    const templateFile = await this.resolveTemplateSelection(
      options?.templateOverride ?? this.config.templatePath,
      options?.templateTypeOverride ?? this.config.templateType,
    );
    const includeAdditionalFrontmatter = !options?.useBaseDefaults;
    const frontmatter = this.buildFrontmatter(
      cleanTitle,
      start,
      end,
      resolvedTags,
      finalOverrides,
      includeAdditionalFrontmatter,
    );
    const defaults = options?.frontmatterDefaults ?? {};
    const overridesWithFolder = {
      ...frontmatter,
      folderPath,
    };

    const templateVars: TemplateVars = {
      title: cleanTitle,
      scheduled: frontmatter.scheduled,
      due: frontmatter.due,
      status: frontmatter.status,
      priority: frontmatter.priority,
      tags: resolvedTags,
    };

    this.pendingTypeFolderPath = null;

    return {
      title: cleanTitle,
      folderPath,
      path,
      templateFile,
      parentFile,
      frontmatter,
      frontmatterDefaults: defaults,
      frontmatterOverrides: overridesWithFolder,
      useBaseDefaults: !!options?.useBaseDefaults,
      templateVars,
    };
  }

  async createTask(
    start: Date,
    end: Date,
    targetFilePath: string,
    frontmatterOverrides?: Record<string, any>,
    options?: NewEventCreationOptions,
  ): Promise<TFile | null> {
    if (this.createInProgress) {
      return null;
    }
    this.createInProgress = true;
    try {
      const rawTitle = await this.promptForTitle(options?.typeFolderOverride);
      if (rawTitle === undefined || rawTitle === "__LINK_EXISTING_CANCEL__") {
        this.pendingTypeFolderPath = null;
        this.pendingLinkExisting = false;
        return null;
      }

      const titleInput = rawTitle && rawTitle.trim() ? rawTitle.trim() : "";
      const { cleanTitle: extractedTitle, tags } = this.extractTags(titleInput);
      const resolvedTags = await this.resolveTags(tags);
      if (resolvedTags === null) return null;

      let parentFile: TFile | null = this.pendingExistingParent;
      const isLinkingExisting = !!parentFile && this.pendingLinkExisting;
      this.pendingExistingParent = null;
      if (!isLinkingExisting) {
        parentFile = null;
      }
      this.pendingLinkExisting = false;

      const finalOverrides = frontmatterOverrides ? { ...frontmatterOverrides } : {};
      const defaults = options?.frontmatterDefaults ?? {};

      const mergedTagInputs = mergeTagInputs(
        mergeTagInputs(defaults.tags, finalOverrides.tags),
        resolvedTags,
      );
      const mergedTags = mergedTagInputs.map((tag) => normalizeTagValue(tag)).filter(Boolean);

      const cleanTitle = extractedTitle?.trim() || parentFile?.basename?.trim() || "Untitled";
      const taskTargetPath = isLinkingExisting && parentFile ? parentFile.path : targetFilePath;
      const targetFile = await this.ensureTaskTargetFile(taskTargetPath);
      const linkedNoteValue = null;
      const taskLine = this.buildTaskLine(
        cleanTitle,
        start,
        end,
        mergedTags,
        defaults,
        finalOverrides,
        linkedNoteValue,
      );
      const existing = await this.config.app.vault.cachedRead(targetFile);
      const nextContent = this.insertLineAtTopOfBody(existing, taskLine);
      await this.config.app.vault.modify(targetFile, nextContent);
      return targetFile;
    } catch (error) {
      logger.error('[NewEventService] Error creating task:', error);
      throw error;
    } finally {
      this.createInProgress = false;
      this.pendingExistingParent = null;
      this.pendingTypeFolderPath = null;
      this.pendingLinkExisting = false;
    }
  }

  private getEditorForFile(file: TFile): any | null {
    const leaves = this.config.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view as any;
      if (view?.file?.path === file.path && view?.editor) {
        return view.editor;
      }
    }
    return null;
  }

  private extractTags(title: string): { cleanTitle: string; tags: string[] } {
    const tagRegex = /#([a-zA-Z0-9_/-]+)/g;
    const tags: string[] = [];
    let match;

    while ((match = tagRegex.exec(title)) !== null) {
      tags.push(match[1]); // Extract tag without the # symbol
    }

    // Remove tags from title
    const cleanTitle = title.replace(tagRegex, '').trim().replace(/\s+/g, ' ');

    return { cleanTitle, tags };
  }

  private getConfigPropertyName(propId: BasesPropertyId | null | undefined, fallback: string): string {
    if (!propId) return fallback;
    const parsed = parsePropertyId(propId);
    return String(parsed.name || (parsed as any).property || fallback).trim() || fallback;
  }

  private formatInlineDateValue(date: Date, includeTime: boolean): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    if (!includeTime) return `${y}-${m}-${d}`;
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }

  private buildTaskLine(
    title: string,
    start: Date,
    end: Date,
    tags: string[],
    defaults: Record<string, any>,
    overrides: Record<string, any>,
    linkedNoteValue?: string | null,
  ): string {
    const startKey = this.getConfigPropertyName(this.config.startProperty, "scheduled");
    const endKey = this.getConfigPropertyName(this.config.endProperty, "timeEstimate");
    const durationMinutes = Math.max(5, Math.round((end.getTime() - start.getTime()) / 60000));
    const isAllDay =
      start.getHours() === 0 &&
      start.getMinutes() === 0 &&
      start.getSeconds() === 0 &&
      start.getMilliseconds() === 0 &&
      end.getHours() === 0 &&
      end.getMinutes() === 0 &&
      end.getSeconds() === 0 &&
      end.getMilliseconds() === 0 &&
      (end.getTime() - start.getTime()) % (24 * 60 * 60 * 1000) === 0;

    const properties: string[] = [];
    properties.push(`[${startKey}:: ${this.formatInlineDateValue(start, !isAllDay)}]`);
    if (!isAllDay && durationMinutes > 0) {
      properties.push(`[${endKey}:: ${durationMinutes}]`);
    }

    const merged = { ...defaults, ...overrides };
    const reservedKeys = new Set([
      startKey.toLowerCase(),
      endKey.toLowerCase(),
      "status",
      "priority",
      "tags",
      "title",
      "folderpath",
      TASK_LINKED_NOTE_PROPERTY,
    ]);
    const priorityValue = merged.priority;
    const statusValue = merged.status;
    if (typeof statusValue === "string" && statusValue.trim()) {
      properties.push(`[status:: ${statusValue.trim()}]`);
    }
    if (typeof priorityValue === "string" && priorityValue.trim()) {
      properties.push(`[priority:: ${priorityValue.trim()}]`);
    }
    for (const [rawKey, rawValue] of Object.entries(merged)) {
      const key = String(rawKey || "").trim();
      if (!key || reservedKeys.has(key.toLowerCase())) continue;
      const formattedValue = this.isTaskVisualColorPropertyKey(key)
        ? this.formatTaskInlineColorPropertyValue(rawValue)
        : this.formatTaskInlinePropertyValue(rawValue);
      if (!formattedValue) continue;
      properties.push(`[${key}:: ${formattedValue}]`);
    }
    if (typeof linkedNoteValue === "string" && linkedNoteValue.trim()) {
      properties.push(`[${TASK_LINKED_NOTE_PROPERTY}:: ${linkedNoteValue.trim()}]`);
    }

    const tagSuffix = tags.length > 0
      ? ` ${tags.map((tag) => `#${normalizeTagValue(tag)}`).join(" ")}`
      : "";

    return `- [ ] ${title}${properties.length > 0 ? ` ${properties.join(" ")}` : ""}${tagSuffix}`;
  }

  private formatTaskInlinePropertyValue(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) {
      const items = value
        .map((item) => this.formatTaskInlinePropertyValue(item))
        .filter((item): item is string => !!item);
      return items.length > 0 ? items.join(", ") : null;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed || null;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return null;
  }

  private isTaskVisualColorPropertyKey(key: string): boolean {
    const normalized = String(key || "").trim().toLowerCase();
    return normalized === "color" || normalized === "iconcolor" || normalized === "icon-color";
  }

  private formatTaskInlineColorPropertyValue(value: unknown): string | null {
    const formatted = this.formatTaskInlinePropertyValue(value);
    if (!formatted) return null;

    const match = formatted.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!match) return formatted;

    const hex = match[1];
    if (hex.length === 3) {
      return hex.split("").map((char) => char + char).join("").toLowerCase();
    }

    return hex.toLowerCase();
  }

  private insertLineAtTopOfBody(content: string, line: string): string {
    const normalized = String(content || "").replace(/\r\n/g, "\n");
    if (!normalized) return `${line}\n`;

    const lines = normalized.split("\n");
    if (lines[0]?.trim() !== '---') {
      if (normalized.endsWith("\n")) {
        return `${line}\n${normalized}`;
      }
      return `${line}\n${normalized}\n`;
    }

    let frontmatterEndIndex = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]?.trim() === '---') {
        frontmatterEndIndex = i;
        break;
      }
    }

    if (frontmatterEndIndex < 0) {
      if (normalized.endsWith("\n") || normalized.length === 0) return `${normalized}${line}\n`;
      return `${normalized}\n${line}\n`;
    }

    const beforeInsert = lines.slice(0, frontmatterEndIndex + 1);
    const afterFrontmatter = lines.slice(frontmatterEndIndex + 1);
    const hasLeadingBlank = afterFrontmatter.length > 0 && afterFrontmatter[0]?.trim() === '';
    const remaining = hasLeadingBlank ? afterFrontmatter.slice(1) : afterFrontmatter;
    const resultLines = [...beforeInsert, '', line];
    if (remaining.length > 0) {
      resultLines.push('');
      resultLines.push(...remaining);
    }
    let result = resultLines.join('\n');
    if (!result.endsWith('\n')) result += '\n';
    return result;
  }

  private async ensureTaskTargetFile(targetFilePath: string): Promise<TFile> {
    const normalized = normalizePath(String(targetFilePath || "").trim());
    if (!normalized) {
      throw new Error("Task target file path is required");
    }

    const existing = this.config.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      return existing;
    }
    if (existing) {
      throw new Error(`Task target path is not a markdown file: ${normalized}`);
    }

    const folderPath = normalized.includes("/") ? normalized.substring(0, normalized.lastIndexOf("/")) : "";
    if (folderPath) {
      await this.ensureFolderExists(folderPath);
    }
    return await this.config.app.vault.create(normalized, "");
  }

  private async resolveTags(tags: string[]): Promise<string[] | null> {
    if (tags.length === 0) {
      return [];
    }

    const resolvedTags: string[] = [];

    for (const tag of tags) {
      const resolved = await this.resolveTag(tag);
      if (resolved === null) {
        // User cancelled
        return null;
      }
      resolvedTags.push(normalizeTagValue(resolved));
    }

    return resolvedTags;
  }

  private async resolveTag(tag: string): Promise<string | null> {
    // Get all tags from the vault
    const metadataCache = this.config.app.metadataCache;
    const allTags = (metadataCache as any).getTags();

    // Find matching tags (exact match or sub-level matches)
    const exactMatch = `#${tag}`;
    const subLevelMatches: string[] = [];

    for (const existingTag in allTags) {
      // Check if it's a sub-level match (e.g., #example1/test matches #test)
      if (existingTag.endsWith(`/${tag}`)) {
        subLevelMatches.push(existingTag.substring(1)); // Remove leading #
      } else if (existingTag === exactMatch) {
        // Exact match exists
        return tag;
      }
    }

    // If no sub-level matches, return the tag as-is
    if (subLevelMatches.length === 0) {
      return tag;
    }

    // If exactly one sub-level match, use it automatically
    if (subLevelMatches.length === 1) {
      return subLevelMatches[0];
    }

    // If multiple sub-level matches, prompt user to choose
    return await this.promptForTagSelection(tag, subLevelMatches);
  }

  private async promptForTagSelection(
    originalTag: string,
    matches: string[]
  ): Promise<string | null> {
    const service = this;
    return new Promise((resolve) => {
      const modal = new (class extends Modal {
        constructor(app: App) {
          super(app);
        }
        onOpen() {
          const { contentEl } = this;
          contentEl.empty();
          contentEl.createEl("h2", { text: `Select tag for #${originalTag}` });
          contentEl.createEl("p", {
            text: "Multiple matching tags found. Please select one:",
            cls: "setting-item-description",
          });

          const buttonContainer = contentEl.createDiv({ cls: "tag-selection-container" });
          buttonContainer.style.display = "flex";
          buttonContainer.style.flexDirection = "column";
          buttonContainer.style.gap = "8px";
          buttonContainer.style.marginTop = "16px";

          matches.forEach((match) => {
            const btn = buttonContainer.createEl("button", {
              text: `#${match}`,
              cls: "mod-cta",
            });
            btn.style.padding = "8px 16px";
            btn.style.textAlign = "left";
            btn.addEventListener("click", () => {
              resolve(match);
              this.close();
            });
          });

          const cancelBtn = contentEl.createEl("button", {
            text: "Cancel",
            cls: "mod-warning",
          });
          cancelBtn.style.marginTop = "16px";
          cancelBtn.addEventListener("click", () => {
            resolve(null);
            this.close();
          });

          this.onClose = () => {
            this.contentEl.empty();
          };
        }
      })(this.config.app);
      modal.open();
    });
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    if (!folderPath || folderPath === '/') return;

    const folder = this.config.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      try {
        await this.config.app.vault.createFolder(folderPath);
      } catch (e: any) {
        if (!(typeof e.message === "string" && e.message.toLowerCase().includes("already exists"))) {
          throw e;
        }
      }
    }
  }

  ensureFocus() {
    if (!this.modalInput) return;
    this.applyFocus();
  }

  private resolveFolderPath(override?: string | null): string {
    const folder = override?.trim() || this.config.folderPath?.trim();
    if (folder) {
      return normalizePath(folder);
    }
    return this.config.app.vault.getRoot().path;
  }

  private async promptForTitle(typeFolderOverride?: string | null): Promise<string | undefined> {
    const service = this;
    return new Promise((resolve) => {
      const modal = new (class extends Modal {
        constructor(app: App) {
          super(app);
        }
        onOpen() {
          const { contentEl } = this;
          contentEl.empty();
          contentEl.addClass("tps-new-event-modal");
          const form = contentEl.createDiv();
          form.setAttribute("autocomplete", "off");
          form.createEl("h2", { text: "New calendar event" });
          const input = form.createEl("input", {
            type: "text",
            attr: { autocomplete: "off", autocorrect: "off", placeholder: "Event title..." },
          });
          input.style.width = "100%";
          input.style.marginBottom = "12px";

          let resolved = false;
          let linkExistingInProgress = false;
          let typePickInProgress = false;
          let typeValue: HTMLSpanElement | null = null;
          let focusLoop: number | null = null;
          const finish = (value: string | undefined) => {
            if (resolved) return;
            resolved = true;
            if (focusLoop !== null) {
              window.clearInterval(focusLoop);
            }
            service.modalInput = null;
            resolve(value);
            this.close();
          };
          const maintain = () => {
            // Only refocus if input doesn't already have focus
            if (document.activeElement !== input) {
              service.applyFocus();
              input.focus({ preventScroll: true });
            }
          };
          this.scope.register([], "Enter", (evt) => {
            evt.preventDefault();
            if (linkExistingInProgress || typePickInProgress) return;
            const trimmed = input.value.trim();
            if (!trimmed) return;
            finish(trimmed);
          });
          this.scope.register([], "Escape", (evt) => {
            evt.preventDefault();
            if (typePickInProgress) return;
            finish(undefined);
          });
          ["keyup", "keydown", "keypress"].forEach((evtName) =>
            input.addEventListener(evtName, (evt) => evt.stopPropagation(), true),
          );
          setTimeout(maintain, 0);
          focusLoop = window.setInterval(maintain, 250);
          service.modalInput = input;
          const typeRow = form.createDiv({ cls: "tps-calendar-template-row" });
          typeRow.style.display = "flex";
          typeRow.style.alignItems = "center";
          typeRow.style.gap = "8px";
          typeRow.style.marginBottom = "10px";
          typeRow.createSpan({ text: "Type:" });
          const getTypeDisplay = () => {
            if (service.pendingTypeFolderPath) return service.pendingTypeFolderPath;
            if (typeFolderOverride) return `${typeFolderOverride} (from filter)`;
            return "Vault root";
          };
          typeValue = typeRow.createSpan({ text: getTypeDisplay() });
          if (!service.pendingTypeFolderPath && typeFolderOverride) {
            typeValue.style.color = "var(--text-muted)";
          }
          const clearTypeBtn = typeRow.createEl("button", { text: "Clear", type: "button" });
          clearTypeBtn.addEventListener("click", (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            service.pendingTypeFolderPath = null;
            if (typeValue) {
              typeValue.textContent = getTypeDisplay();
              typeValue.style.color = typeFolderOverride ? "var(--text-muted)" : "";
            }
          });
          const buttons = form.createDiv({ cls: "modal-button-container" });
          const createBtn = buttons.createEl("button", { text: "Create", cls: "mod-cta", type: "button" });
          const syncCreateState = () => {
            createBtn.disabled = input.value.trim().length === 0;
          };
          createBtn.disabled = true;
          input.addEventListener("input", syncCreateState);
          createBtn.addEventListener("click", () => {
            const trimmed = input.value.trim();
            if (!trimmed) return;
            finish(trimmed);
          });

          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const trimmed = input.value.trim();
              if (!trimmed) return;
              finish(trimmed);
            }
          });
          syncCreateState();

          const typeBtn = buttons.createEl("button", { text: "Type...", type: "button" });
          typeBtn.addEventListener("click", async (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            if (focusLoop !== null) {
              window.clearInterval(focusLoop);
              focusLoop = null;
            }
            typePickInProgress = true;
            const selected = await service.promptForTypeFolderSelection();
            if (selected) {
              service.pendingTypeFolderPath = selected.path;
              if (typeValue) {
                typeValue.textContent = selected.path;
                typeValue.style.color = "";
              }
            }
            typePickInProgress = false;
            setTimeout(maintain, 0);
            if (focusLoop === null) {
              focusLoop = window.setInterval(maintain, 250);
            }
          });

          // Add "Link Existing Note" button
          const linkExistingBtn = buttons.createEl("button", { text: "Link Existing Note", type: "button" });
          linkExistingBtn.addEventListener("click", async (evt) => {
            evt.preventDefault();
            evt.stopPropagation();

            // Stop the focus loop so the file picker can work
            if (focusLoop !== null) {
              window.clearInterval(focusLoop);
              focusLoop = null;
            }
            linkExistingInProgress = true;
            const typedTitle = input.value.trim();

            const selectedParent = await service.promptForExistingNote();

            if (selectedParent) {
              service.pendingExistingParent = selectedParent;
              service.pendingLinkExisting = true;
              finish(typedTitle || "");
            } else {
              service.pendingExistingParent = null;
              service.pendingLinkExisting = false;
              finish("__LINK_EXISTING_CANCEL__");
            }
          });

          buttons
            .createEl("button", { text: "Cancel", type: "button" })
            .addEventListener("click", () => finish(undefined));
          this.onClose = () => {
            if (linkExistingInProgress || typePickInProgress) {
              return;
            }
            if (!resolved) {
              finish(undefined);
            }
            this.contentEl.empty();
          };
        }
      })(this.config.app);
      modal.open();
    });
  }

  private async promptForTypeFolderSelection(): Promise<TypeFolderOption | null> {
    const options = this.typeFolderService.getTypeFolderOptions();
    if (!options.length) {
      new Notice("No type folders found.");
      return null;
    }

    return new Promise((resolve) => {
      let resolved = false;
      const modal = new (class extends FuzzySuggestModal<TypeFolderOption> {
        getItems() {
          return options;
        }
        getItemText(item: TypeFolderOption) {
          return item.hasTypeTemplate ? `${item.path} (type template)` : item.path;
        }
        onChooseItem(item: TypeFolderOption) {
          if (resolved) return;
          resolved = true;
          resolve(item);
        }
        onClose() {
          setTimeout(() => {
            if (resolved) return;
            resolved = true;
            resolve(null);
          }, 200);
        }
      })(this.config.app);
      modal.setPlaceholder("Select type (folder)");
      modal.open();
    });
  }

  private async promptForExistingNote(): Promise<TFile | null> {
    return new Promise((resolve) => {
      let resolved = false;
      const modal = new (class extends FuzzySuggestModal<TFile> {
        constructor(app: App) {
          super(app);
          this.setPlaceholder("Select existing note to link...");
        }
        getItems(): TFile[] {
          return this.app.vault.getMarkdownFiles();
        }
        getItemText(item: TFile): string {
          return item.path;
        }
        onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
          if (resolved) return;
          resolved = true;
          resolve(item);
        }
        onClose() {
          // Add small delay to avoid race condition where onClose fires before onChooseItem
          setTimeout(() => {
            if (resolved) return;
            resolved = true;
            resolve(null);
          }, 200);
        }
      })(this.config.app);
      modal.open();
    });
  }

  private async applyParentLink(file: TFile, parentFile: TFile): Promise<void> {
    const parentKey = (this.config.parentLinkKey || "parent").trim() || "parent";
    await applyParentLinkToChild(this.config.app, file, parentFile, parentKey);
  }

  private async syncFolderPathFrontmatter(file: TFile): Promise<void> {
    const folderPath = file.parent?.path || "/";
    await this.processFrontmatterSafely(file, "sync-folder-path", (fm) => {
      this.setFrontmatterValueCaseInsensitive(fm, "folderPath", folderPath);
    });
  }

  private applyFocus() {
    if (!this.modalInput) return;
    try {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
      document.body?.classList?.remove("tps-context-hidden-for-keyboard");
    } catch {
      /* ignore */
    }
  }

  /**
   * Triggers post-creation hooks for plugins like obsidian-linter
   * and TPS-Global-Context-Menu that need to process newly created files.
   */
  private async triggerPostCreationHooks(file: TFile): Promise<void> {
    // Small delay to ensure file is fully written and indexed
    await new Promise(resolve => setTimeout(resolve, 100));

    try {
      // Trigger the Obsidian Linter plugin if installed
      const linterPlugin = (this.config.app as any).plugins?.plugins?.['obsidian-linter'];
      if (linterPlugin) {
        // Try the direct lintFile API first (preferred, doesn't require opening file)
        if (typeof linterPlugin.runLinterFile === 'function') {
          await linterPlugin.runLinterFile(file);
          logger.log('[NewEventService] Ran linter via runLinterFile API');
        } else if (typeof linterPlugin.lintFile === 'function') {
          await linterPlugin.lintFile(file);
          logger.log('[NewEventService] Ran linter via lintFile API');
        } else {
          // Do not fall back to opening files just to run the linter command.
          // That path can create stray blank tabs or steal focus during event creation.
          logger.warn('[NewEventService] Skipping linter fallback because no direct file API is available');
        }
      }

    } catch (error) {
      logger.warn('[NewEventService] Error triggering post-creation hooks:', error);
    }
  }

  private async applyEventFrontmatter(file: TFile, frontmatter: Record<string, any>): Promise<void> {
    await this.processFrontmatterSafely(file, "apply-event-frontmatter", (fm) => {
      this.deleteFrontmatterValueCaseInsensitive(fm, "title");
      for (const [key, value] of Object.entries(frontmatter)) {
        if (value === undefined) continue;

        if (key === "tags") {
          fm.tags = mergeTagInputs(fm.tags, value);
          continue;
        }
        this.setFrontmatterValueCaseInsensitive(fm, key, value);
      }
    });
  }

  private async applyFrontmatterDefaultsAndOverrides(
    file: TFile,
    defaults: Record<string, any>,
    overrides: Record<string, any>,
  ): Promise<void> {
    await this.processFrontmatterSafely(file, "apply-frontmatter-defaults", (fm) => {
      for (const [key, value] of Object.entries(defaults)) {
        if (value === undefined) continue;
        if (key === "tags") continue;
        const existingKey = Object.keys(fm).find((k) => k.toLowerCase() === key.toLowerCase());
        if (existingKey) continue;
        this.setFrontmatterValueCaseInsensitive(fm, key, value);
      }

      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) continue;
        if (key === "tags") {
          fm.tags = mergeTagInputs(fm.tags, value);
          continue;
        }

        this.setFrontmatterValueCaseInsensitive(fm, key, value);
      }
    });
  }

  private async processFrontmatterSafely(
    file: TFile,
    reason: string,
    mutate: (fm: Record<string, any>) => void,
  ): Promise<boolean> {
    const safety = await this.canMutateFrontmatterSafely(file);
    if (!safety.safe) {
      if (!this.malformedFrontmatterWarnedPaths.has(file.path)) {
        this.malformedFrontmatterWarnedPaths.add(file.path);
        new Notice(`Skipped frontmatter update for "${file.basename}" (${safety.reason}).`);
      }
      logger.warn(`[NewEventService] Skipping frontmatter mutation (${reason})`, {
        file: file.path,
        reason: safety.reason,
      });
      return false;
    }

    try {
      await this.config.app.fileManager.processFrontMatter(file, (fm) => {
        mutate((fm ?? {}) as Record<string, any>);
      });
      return true;
    } catch (error) {
      logger.warn(`[NewEventService] Frontmatter mutation failed (${reason})`, {
        file: file.path,
        error,
      });
      return false;
    }
  }

  private async canMutateFrontmatterSafely(
    file: TFile,
  ): Promise<{ safe: boolean; reason?: string }> {
    const normalizedLeading = await this.normalizeDuplicateLeadingFrontmatter(file);
    if (normalizedLeading) {
      return { safe: true };
    }

    let content = "";
    try {
      content = await this.config.app.vault.cachedRead(file);
    } catch (error) {
      logger.warn("[NewEventService] Failed reading file for frontmatter safety check", {
        file: file.path,
        error,
      });
      return { safe: false, reason: "file read failed" };
    }

    const normalized = content.replace(/\r\n/g, "\n");
    const bomOffset = normalized.startsWith("\uFEFF") ? 1 : 0;
    if (!normalized.startsWith("---\n", bomOffset)) {
      return { safe: true };
    }

    // Search from bomOffset + 3 so that empty frontmatter ("---\n---\n") is handled.
    // The closing \n---\n pattern starts at the \n that terminates the opening ---.
    // Starting at +4 would skip that \n and miss the only valid closing delimiter.
    const firstClose = normalized.indexOf("\n---\n", bomOffset + 3);
    if (firstClose === -1) {
      return { safe: false, reason: "missing frontmatter closing delimiter" };
    }

    const afterFirst = normalized.slice(firstClose + "\n---\n".length);
    const trimmedAfterFirst = afterFirst.replace(/^\s*/, "");
    if (!trimmedAfterFirst.startsWith("---\n")) {
      return { safe: true };
    }

    const secondClose = trimmedAfterFirst.indexOf("\n---\n", 4);
    if (secondClose === -1) {
      return { safe: true };
    }

    const secondBody = trimmedAfterFirst.slice(4, secondClose);
    const hasYamlLikeEntry = secondBody
      .split("\n")
      .some((line) => /^[A-Za-z0-9_"'.-]+\s*:/.test(line.trim()));

    if (!hasYamlLikeEntry) {
      return { safe: true };
    }

    return { safe: false, reason: "duplicate leading frontmatter blocks detected" };
  }

  private async normalizeDuplicateLeadingFrontmatter(file: TFile): Promise<boolean> {
    let content = "";
    try {
      content = await this.config.app.vault.cachedRead(file);
    } catch {
      return false;
    }

    const normalized = content.replace(/\r\n/g, "\n");
    const bom = normalized.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body = bom ? normalized.slice(1) : normalized;
    if (!body.startsWith("---\n")) return false;

    const firstClose = body.indexOf("\n---\n", 3);
    if (firstClose === -1) return false;

    const afterFirst = body.slice(firstClose + "\n---\n".length);
    const trimmedAfterFirst = afterFirst.replace(/^\s*/, "");
    if (!trimmedAfterFirst.startsWith("---\n")) return false;

    const secondClose = trimmedAfterFirst.indexOf("\n---\n", 4);
    if (secondClose === -1) return false;

    const secondBody = trimmedAfterFirst.slice(4, secondClose);
    const hasYamlLikeEntry = secondBody
      .split("\n")
      .some((line) => /^[A-Za-z0-9_"'.-]+\s*:/.test(line.trim()));
    if (!hasYamlLikeEntry) return false;

    const firstBody = body.slice(4, firstClose);
    const trailing = trimmedAfterFirst.slice(secondClose + "\n---\n".length).replace(/^\n+/, "");
    const mergedBody = [firstBody.trimEnd(), secondBody.trim()].filter(Boolean).join("\n");
    const merged = `${bom}---\n${mergedBody}\n---\n${trailing}`;

    if (merged === normalized) return false;

    await this.config.app.vault.modify(file, merged);
    logger.log("[NewEventService] Consolidated duplicate leading frontmatter blocks", { file: file.path });
    return true;
  }

  private normalizeFrontmatterKey(key: string): string {
    return String(key || "").trim().toLowerCase();
  }

  private setFrontmatterValueCaseInsensitive(
    target: Record<string, any>,
    key: string,
    value: any,
  ): void {
    const normalized = this.normalizeFrontmatterKey(key);
    const existingKey = Object.keys(target).find(
      (candidate) => this.normalizeFrontmatterKey(candidate) === normalized,
    );
    target[existingKey || key] = value;
    if (existingKey && existingKey !== key && key in target) {
      delete target[key];
    }
  }

  private deleteFrontmatterValueCaseInsensitive(
    target: Record<string, any>,
    key: string,
  ): void {
    const normalized = this.normalizeFrontmatterKey(key);
    Object.keys(target)
      .filter((candidate) => this.normalizeFrontmatterKey(candidate) === normalized)
      .forEach((candidate) => delete target[candidate]);
  }

  private buildFrontmatter(
    title: string,
    start: Date,
    end: Date,
    tags: string[] = [],
    overrides?: Record<string, any>,
    includeAdditionalFrontmatter: boolean = true,
  ): Record<string, any> {
    const result: Record<string, any> = {
      title,
    };

    // Add tags if present
    if (tags.length > 0) {
      result.tags = mergeTagInputs([], tags);
    }

    const startField = this.noteField(this.config.startProperty);
    const endField = this.noteField(this.config.endProperty);



    // Always write start date if we have a field
    if (startField) {
      result[startField] = formatDateTimeForFrontmatter(start);
    }

    // For end field, check if we should write duration or datetime
    if (endField) {
      if (this.config.useEndDuration) {
        // Write duration in minutes as a number
        const durationMs = end.getTime() - start.getTime();
        let durationMinutes = Math.round(durationMs / (60 * 1000));

        // If it's an all-day event (exactly 24h/1440m) and we have a default duration, use it
        // This prevents all-day clicks from defaulting to 1440m time estimates
        if (this.isAllDay(start, end) && durationMinutes === 1440 && this.config.defaultDuration) {
          durationMinutes = this.config.defaultDuration;
        }

        result[endField] = durationMinutes;
      } else {
        // Write end datetime as a string
        result[endField] = formatDateTimeForFrontmatter(end);
      }
    }

    const allDayField = this.noteField(this.config.allDayProperty) ?? "allDay";
    // Write as a boolean, not a string
    result[allDayField] = this.isAllDay(start, end);

    // Merge additional frontmatter (from filter templates)
    if (includeAdditionalFrontmatter && this.config.additionalFrontmatter) {
      Object.assign(result, this.config.additionalFrontmatter);
    }

    // Merge overrides (e.g. completed status)
    if (overrides) {
      // Handle tags specially to merge instead of overwrite
      if (overrides.tags) {
        result.tags = mergeTagInputs(result.tags, overrides.tags);

        // Remove tags from overrides copy to avoid Object.assign overwriting it back
        const overridesCopy = { ...overrides };
        delete overridesCopy.tags;
        Object.assign(result, overridesCopy);
      } else {
        Object.assign(result, overrides);
      }
    }

    // Ensure title is not overwritten
    result.title = title;

    return result;
  }

  private noteField(propId?: BasesPropertyId | null): string | null {
    if (!propId) return null;
    const parsed = parsePropertyId(propId);

    if (parsed.type === "note") {
      const fieldName = parsed.name || (parsed as any).property;
      if (fieldName) {
        return fieldName;
      }
    }
    return null;
  }

  private isAllDay(start: Date, end: Date): boolean {
    return (
      start.getHours() === 0 &&
      start.getMinutes() === 0 &&
      end.getHours() === 0 &&
      end.getMinutes() === 0
    );
  }

  /**
   * Pre-build template content using all vars we know BEFORE the file is created.
   * Resolves {{vars}} placeholders. <% tp.* %> tags are left intact for Templater
   * to process via runTemplaterOnFile() after creation.
   *
   * Returns the processed string, or '' on failure (caller should use a stub).
   */
  private async buildInitialContent(
    templateFile: TFile,
    filePath: string,
    extraVars: TemplateVars = {}
  ): Promise<string> {
    try {
      const raw = await this.config.app.vault.read(templateFile);
      const basename = filePath.replace(/^.*\//, '').replace(/\.md$/i, '');
      const folderPath = filePath.includes('/') ? filePath.replace(/\/[^/]+$/, '') : '';
      const vars = buildTemplateVars(null, {
        title: basename,
        file_name: `${basename}.md`,
        file_basename: basename,
        file_path: filePath,
        file_folder: folderPath,
        ...extraVars,
      });
      return applyTemplateVars(raw, vars);
    } catch (e) {
      logger.warn('[NewEventService] Failed to pre-build template content (non-fatal):', e);
      return '';
    }
  }

  /**
   * Explicitly invoke Templater's "Replace templates in file" on a newly-created
   * file so <% tp.* %> expressions are evaluated in-place.
   * Safe no-op when Templater is not installed or the file has no Templater syntax.
   *
   * Uses overwrite_file_commands(file, false) directly — this is the same code path
   * that backs "Replace templates in the active file", but works on any file object
   * without requiring it to be the active editor view.
   */
  private async runTemplaterOnFile(file: TFile): Promise<void> {
    const templater = getPluginById(this.config.app, 'templater-obsidian') as any;
    if (!templater?.templater) return;
    try {
      await templater.templater.overwrite_file_commands(file, false);
      logger.log('[NewEventService] Templater processed:', file.path);
    } catch (e) {
      logger.warn('[NewEventService] Templater failed to process file (non-fatal):', file.path, e);
    }
  }

  private async resolveTemplateSelection(path?: string | null, templateType?: string | null): Promise<TFile | null> {
    if (!path) return null;
    const normalized = normalizePath(path).replace(/^\/+/, "");
    const direct = this.config.app.vault.getAbstractFileByPath(normalized);
    if (direct instanceof TFile) return direct;
    if (direct && (direct as any).children && templateType === "folder") {
      return await this.pickTemplateFromFolder(direct.path);
    }
    return resolveTemplateFile(this.config.app, normalized, {
      allowBasenameMatchInTemplaterRoot: true,
      warnOnAmbiguousBasename: true,
    });
  }

  private async pickTemplateFromFolder(folderPath: string): Promise<TFile | null> {
    const files = this.config.app.vault.getMarkdownFiles()
      .filter(f => f.path.startsWith(`${folderPath}/`));
    if (!files.length) return null;
    return await new Promise((resolve) => {
      new (class extends FuzzySuggestModal<TFile> {
        items: TFile[];
        onChoose: (file: TFile) => void;
        constructor(app: App, items: TFile[], onChoose: (file: TFile) => void) {
          super(app);
          this.items = items;
          this.onChoose = onChoose;
        }
        getItems() { return this.items; }
        getItemText(item: TFile) { return item.path; }
        onChooseItem(item: TFile) { this.onChoose(item); }
      })(this.config.app, files, resolve).open();
    });
  }

  /**
   * Creates a file at `initialPath`, retrying with an incremented counter suffix
   * if the path is already taken. This handles the race condition where multiple
   * CalendarView instances (e.g. multiple calendar bases embedded in a canvas)
   * pass the buildUniquePath check simultaneously and then both try to create
   * the same file.
   */
  private async createFileRetrying(initialPath: string, content: string): Promise<TFile> {
    const MAX_RETRIES = 20;
    // Strip .md and any trailing " N" counter so we can rebuild cleanly
    const withoutExt = initialPath.endsWith('.md') ? initialPath.slice(0, -3) : initialPath;
    const baseWithoutCounter = withoutExt.replace(/ \d+$/, '');

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const path = attempt === 0
        ? initialPath
        : normalizePath(`${baseWithoutCounter} ${attempt}.md`);
      try {
        return await this.config.app.vault.create(path, content);
      } catch (err: any) {
        const isExists =
          typeof err?.message === 'string' &&
          err.message.toLowerCase().includes('already exists');
        if (!isExists || attempt === MAX_RETRIES) throw err;
        logger.log(
          `[NewEventService] Path "${path}" already exists (race condition), retrying with counter ${attempt + 1}`
        );
      }
    }
    // Unreachable, but satisfies the type-checker
    throw new Error(`[NewEventService] Could not create file after ${MAX_RETRIES} retries for "${initialPath}"`);
  }

  /**
   * Format a date as a filename-safe suffix using the vault's daily-note format.
   * Infers the actual format from existing daily note filenames (Obsidian expands
   * short tokens like ddd→dddd, D→Do when creating files).
   */
  private formatDateSuffix(date: Date): string {
    const m = (window as any).moment;
    if (!m) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }
    return getDailyNoteResolver(this.config.app).formatFilename(date);
  }

  private buildUniquePath(folderPath: string, title: string, date: Date): string {
    const strippedTitle = title
      .replace(/\s+\d{4}-\d{2}-\d{2}(?:\s+\d+)?$/g, "")
      .replace(/^\d{4}-\d{2}-\d{2}\s+/g, "")
      .trim();

    const sanitizedTitle = strippedTitle
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Use the inferred daily-note date format so filenames match the rest of the vault.
    const dateSuffix = this.formatDateSuffix(date);

    const baseTitle = sanitizedTitle || "Untitled";
    const finalTitle = `${baseTitle} ${dateSuffix}`;

    // Construct path with date suffix
    let path = normalizePath(`${folderPath}/${finalTitle}.md`);

    // If file exists, add a counter
    let counter = 1;
    while (this.config.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${folderPath}/${finalTitle} ${counter}.md`);
      counter++;
    }
    return path;
  }

  private async promptForPastEvent(): Promise<"complete" | "active" | "cancel"> {
    return new Promise((resolve) => {
      const modal = new (class extends Modal {
        constructor(app: App) {
          super(app);
        }
        onOpen() {
          const { contentEl } = this;
          contentEl.empty();
          contentEl.createEl("h2", { text: "Event in Past" });
          contentEl.createEl("div", {
            text: "This event is in the past. Would you like to mark it as complete?",
            cls: "setting-item-description",
            attr: { style: "margin-bottom: 20px;" }
          });
          contentEl.createEl("div", {
            text: "(Select 'No, Active' for time blocks/logs that shouldn't be completed)",
            cls: "setting-item-description",
            attr: { style: "margin-bottom: 20px; font-style: italic; font-size: 0.9em;" }
          });

          const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
          buttonContainer.style.display = "flex";
          buttonContainer.style.justifyContent = "center";
          buttonContainer.style.gap = "10px";

          const completeBtn = buttonContainer.createEl("button", { text: "Yes, Complete", cls: "mod-cta" });
          completeBtn.addEventListener("click", () => {
            resolve("complete");
            this.close();
          });

          const activeBtn = buttonContainer.createEl("button", { text: "No, Active" });
          activeBtn.addEventListener("click", () => {
            resolve("active");
            this.close();
          });

          const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
          cancelBtn.addEventListener("click", () => {
            resolve("cancel");
            this.close();
          });

          this.onClose = () => {
            // Implicit cancel if not resolved
          };
        }

        onClose() {
          this.contentEl.empty();
          resolve("cancel");
        }
      })(this.config.app);
      modal.open();
    });
  }

  private async promptForInProgressEvent(statusValue: string): Promise<"in-progress" | "active" | "cancel"> {
    return new Promise((resolve) => {
      let resolved = false;
      const modal = new (class extends Modal {
        constructor(app: App) {
          super(app);
          this.scope.register([], "Escape", () => {
            this.close();
          });
        }
        onOpen() {
          const { contentEl } = this;
          contentEl.empty();
          contentEl.createEl("h2", { text: "Event In Progress" });
          contentEl.createEl("div", {
            text: `This event is currently in progress. Would you like to mark it as '${statusValue}'?`,
            cls: "setting-item-description",
            attr: { style: "margin-bottom: 20px;" }
          });

          const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
          buttonContainer.style.display = "flex";
          buttonContainer.style.justifyContent = "center";
          buttonContainer.style.gap = "10px";

          const inProgressBtn = buttonContainer.createEl("button", { text: `Yes, ${statusValue}`, cls: "mod-cta" });
          inProgressBtn.addEventListener("click", () => {
            if (resolved) return;
            resolved = true;
            resolve("in-progress");
            this.close();
          });

          const activeBtn = buttonContainer.createEl("button", { text: "No, Active" });
          activeBtn.addEventListener("click", () => {
            if (resolved) return;
            resolved = true;
            resolve("active");
            this.close();
          });

          const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
          cancelBtn.addEventListener("click", () => {
            if (resolved) return;
            resolved = true;
            resolve("cancel");
            this.close();
          });

          // Focus the CTA
          setTimeout(() => inProgressBtn.focus(), 50);
        }

        onClose() {
          this.contentEl.empty();
          if (resolved) return;
          resolved = true;
          resolve("cancel");
        }
      })(this.config.app);
      modal.open();
    });
  }

  public async promptForParentSelection(keyName: string): Promise<TFile | null> {
    return new Promise((resolve) => {
      let resolved = false;
      const modal = new (class extends Modal {
        constructor(app: App) {
          super(app);
        }
        onOpen() {
          const { contentEl } = this;
          contentEl.empty();
          contentEl.createEl("h2", { text: `Select parent note for '${keyName}'` });
          const input = contentEl.createEl("input", { type: "text" });
          input.placeholder = "Type to filter notes...";
          input.style.width = "100%";
          input.style.marginBottom = "10px";

          const list = contentEl.createDiv({ cls: "tps-calendar-parent-list" });
          list.style.maxHeight = "300px";
          list.style.overflowY = "auto";
          list.style.display = "flex";
          list.style.flexDirection = "column";
          list.style.gap = "6px";

          const files = this.app.vault.getMarkdownFiles();
          const render = (query: string) => {
            list.empty();
            const q = query.trim().toLowerCase();
            const matches = q
              ? files.filter((f) => f.path.toLowerCase().includes(q))
              : files;
            const limited = matches.slice(0, 200);
            for (const file of limited) {
              const row = list.createDiv({ text: file.path });
              row.style.padding = "6px 8px";
              row.style.borderRadius = "6px";
              row.style.cursor = "pointer";
              row.addEventListener("mouseenter", () => {
                row.style.background = "var(--background-modifier-hover)";
              });
              row.addEventListener("mouseleave", () => {
                row.style.background = "transparent";
              });
              row.addEventListener("click", () => {
                if (resolved) return;
                resolved = true;
                resolve(file);
                this.close();
              });
            }
            if (limited.length === 0) {
              list.createDiv({ text: "No matches" }).style.color = "var(--text-muted)";
            }
          };

          render("");
          input.addEventListener("input", () => render(input.value));
          input.focus();
        }
        onClose() {
          if (resolved) return;
          resolved = true;
          resolve(null);
        }
      })(this.config.app);

      modal.open();
    });
  }
}
