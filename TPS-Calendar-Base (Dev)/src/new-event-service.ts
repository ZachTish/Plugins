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
import * as logger from "./logger";
import { formatDateTimeForFrontmatter } from "./utils";
import { applyTemplateVars, buildTemplateVars, type TemplateVars } from "./services/template-variable-service";
import { TypeFolderOption, TypeFolderService } from "./services/type-folder-service";
import { resolveTemplateFile } from "./services/template-resolution-service";
import { mergeTagInputs, normalizeTagValue } from "./services/tag-utils";
import { applyParentLinkToChild } from "./parent-child-link";

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
      const rawTitle = await this.promptForTitle();

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
        cleanTitle =
          parentFile?.basename ||
          this.config.defaultTitle?.trim() ||
          "Untitled";
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
        const file = await this.config.app.vault.create(path, "");
        await this.delay(300);
        const processed = await this.processTemplate(templateFile, file, {
          title: cleanTitle,
          scheduled: frontmatter.scheduled,
          due: frontmatter.due,
          status: frontmatter.status,
          priority: frontmatter.priority,
          tags: resolvedTags,
        });
        if (processed != null) {
          await this.config.app.vault.modify(file, processed);
        } else {
          try {
            const raw = await this.config.app.vault.read(templateFile);
            await this.config.app.vault.modify(file, raw);
          } catch (err) {
            logger.warn("[Weekly Calendar] Failed to load template", err);
          }
        }

        // Templater's global "Trigger on new file creation" handles <% tp.* %>
        // directives automatically — no explicit call needed.

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
        // No template - create empty file and apply frontmatter via processFrontMatter.
        const file = await this.config.app.vault.create(path, "");
        await this.delay(300);

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

      await this.config.app.vault.createFolder(folderPath);
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

  private async promptForTitle(): Promise<string | undefined> {
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
            finish(input.value.trim() || undefined);
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
          typeValue = typeRow.createSpan({
            text: service.pendingTypeFolderPath ? service.pendingTypeFolderPath : "Default",
          });
          const clearTypeBtn = typeRow.createEl("button", { text: "Clear", type: "button" });
          clearTypeBtn.addEventListener("click", (evt) => {
            evt.preventDefault();
            evt.stopPropagation();
            service.pendingTypeFolderPath = null;
            if (typeValue) typeValue.textContent = "Default";
          });
          const buttons = form.createDiv({ cls: "modal-button-container" });
          const createBtn = buttons.createEl("button", { text: "Create", cls: "mod-cta", type: "button" });
          createBtn.addEventListener("click", () => {
            finish(input.value);
          });

          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              finish(input.value);
            }
          });

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
              if (typeValue) typeValue.textContent = selected.path;
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
          // Fallback: Use the "lint file" command which requires the file to be open
          const commands = (this.config.app as any).commands?.commands;
          if (commands) {
            const lintFileCmd = commands['obsidian-linter:lint-file'];
            if (lintFileCmd?.callback) {
              // Need to open the file first for the linter command to work
              const leaf = this.config.app.workspace.getLeaf(false);
              await leaf.openFile(file);
              await new Promise(resolve => setTimeout(resolve, 50));
              lintFileCmd.callback();
              logger.log('[NewEventService] Triggered obsidian-linter:lint-file command');
            }
          }
        }
      }

      const subtypeId = null;

      // Trigger custom events that other plugins can listen to.
      this.config.app.workspace.trigger('tps-file-created', file, { subtypeId });
      this.config.app.workspace.trigger('tps-calendar:file-created', file, { subtypeId });

    } catch (error) {
      logger.warn('[NewEventService] Error triggering post-creation hooks:', error);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

    const firstClose = normalized.indexOf("\n---\n", bomOffset + 4);
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

  private async loadTemplate(path?: string | null): Promise<string | null> {
    if (!path) return null;
    try {
      const file = this.config.app.vault.getAbstractFileByPath(
        normalizePath(path),
      );
      if (file && file instanceof TFile) {
        return await this.config.app.vault.read(file);
      }
    } catch (error) {
      logger.warn("[Weekly Calendar] Failed to load template", error);
    }
    return null;
  }

  private async processTemplate(templateFile: TFile, targetFile: TFile, extraVars: TemplateVars = {}): Promise<string | null> {
    try {
      const raw = await this.config.app.vault.read(templateFile);
      return applyTemplateVars(raw, buildTemplateVars(targetFile, extraVars));
    } catch (e) {
      logger.error("[Weekly Calendar] Template processing failed", e);
      new Notice(`⚠️ Calendar Base: Error processing template "${templateFile.basename}".\n${e instanceof Error ? e.message : String(e)}`);
      return null;
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

  private buildUniquePath(folderPath: string, title: string, date: Date): string {
    const strippedTitle = title
      .replace(/\s+\d{4}-\d{2}-\d{2}(?:\s+\d+)?$/g, "")
      .replace(/^\d{4}-\d{2}-\d{2}\s+/g, "")
      .trim();

    const sanitizedTitle = strippedTitle
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Build date suffix
    const dateSuffix = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
      2,
      "0",
    )}-${String(date.getDate()).padStart(2, "0")}`;

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
