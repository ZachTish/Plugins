import { App, Modal, TFile, normalizePath, Notice } from "obsidian";
import { ExternalCalendarEvent } from "./types";
import * as logger from "./logger";
import { formatDateTimeForFrontmatter } from "./utils";
import { createBidirectionalLink } from "./parent-child-link";
import {
  applyTemplateVars,
  buildExternalEventTemplateVars,
  type TemplateVars,
} from "./services/template-variable-service";
import { resolveTemplateFile as resolveTemplateFilePath } from "./services/template-resolution-service";
import { mergeTagInputs, normalizeTagValue } from "./services/tag-utils";

export class ExternalEventModal extends Modal {
  private event: ExternalCalendarEvent;
  private onCreateNote: (event: ExternalCalendarEvent) => Promise<void>;
  private onHide?: (event: ExternalCalendarEvent) => Promise<void>;

  constructor(
    app: App,
    event: ExternalCalendarEvent,
    onCreateNote: (event: ExternalCalendarEvent) => Promise<void>,
    onHide?: (event: ExternalCalendarEvent) => Promise<void>
  ) {
    super(app);
    this.event = event;
    this.onCreateNote = onCreateNote;
    this.onHide = onHide;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("external-event-modal");

    // Title
    contentEl.createEl("h2", { text: this.event.title });

    // Details container
    const detailsEl = contentEl.createDiv({ cls: "external-event-details" });

    // Time
    const timeEl = detailsEl.createDiv({ cls: "external-event-field" });
    timeEl.createEl("strong", { text: "When: " });
    timeEl.createSpan({
      text: this.formatEventTime(this.event.startDate, this.event.endDate, this.event.isAllDay),
    });

    // Location
    if (this.event.location) {
      const locationEl = detailsEl.createDiv({ cls: "external-event-field" });
      locationEl.createEl("strong", { text: "Location: " });
      locationEl.createSpan({ text: this.event.location });
    }

    // Organizer
    if (this.event.organizer) {
      const organizerEl = detailsEl.createDiv({ cls: "external-event-field" });
      organizerEl.createEl("strong", { text: "Organizer: " });
      organizerEl.createSpan({ text: this.event.organizer });
    }

    // Attendees
    if (this.event.attendees && this.event.attendees.length > 0) {
      const attendeesEl = detailsEl.createDiv({ cls: "external-event-field" });
      attendeesEl.createEl("strong", { text: "Attendees: " });
      attendeesEl.createSpan({ text: this.event.attendees.join(", ") });
    }

    // Description
    if (this.event.description) {
      const descEl = detailsEl.createDiv({ cls: "external-event-field" });
      descEl.createEl("strong", { text: "Description: " });
      const descText = detailsEl.createDiv({ cls: "external-event-description" });
      descText.setText(this.event.description);
    }

    // URL
    if (this.event.url) {
      const urlEl = detailsEl.createDiv({ cls: "external-event-field" });
      urlEl.createEl("strong", { text: "Link: " });
      const link = urlEl.createEl("a", {
        text: this.event.url,
        href: this.event.url,
      });
      link.setAttr("target", "_blank");
    }

    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
    buttonContainer.style.marginTop = "20px";
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "10px";
    buttonContainer.style.justifyContent = "flex-end";

    if (this.onHide) {
      const hideBtn = buttonContainer.createEl("button", {
        text: "Hide Event",
      });
      hideBtn.addEventListener("click", async () => {
        if (this.onHide) {
          await this.onHide(this.event);
          this.close();
        }
      });
    }

    const createNoteBtn = buttonContainer.createEl("button", {
      text: "Create Meeting Note",
      cls: "mod-cta",
    });
    createNoteBtn.addEventListener("click", async () => {
      await this.onCreateNote(this.event);
      this.close();
    });

    const closeBtn = buttonContainer.createEl("button", {
      text: "Close",
    });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }

  private formatEventTime(start: Date, end: Date, isAllDay: boolean): string {
    const dateOptions: Intl.DateTimeFormatOptions = {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    };

    const timeOptions: Intl.DateTimeFormatOptions = {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    };

    if (isAllDay) {
      return new Intl.DateTimeFormat(undefined, dateOptions).format(start);
    }

    const dateStr = new Intl.DateTimeFormat(undefined, dateOptions).format(start);
    const startTime = new Intl.DateTimeFormat(undefined, timeOptions).format(start);
    const endTime = new Intl.DateTimeFormat(undefined, timeOptions).format(end);

    return `${dateStr}, ${startTime} - ${endTime}`;
  }
}

export async function createMeetingNoteFromExternalEvent(
  app: App,
  event: ExternalCalendarEvent,
  templatePath: string | null,
  folderPath: string | null,
  startProperty: string | null,
  endProperty: string | null,
  useEndDuration: boolean,
  calendarTag: string | null = null,
  parentFile?: TFile | null,
  parentLinkKey?: string,
  childLinkKey?: string,
  frontmatterKeys?: {
    eventIdKey: string;
    uidKey: string;
    titleKey: string;
    statusKey: string;
  },
  existingFile?: TFile
): Promise<TFile | null> {
  // Load template (supports templater folder + relative paths)
  let templateContent = "";
  let templateFile = await resolveTemplateFromPath(app, templatePath);

  // Fallback: If no explicit template is provided, check Templater folder templates
  if (!templateFile && !templatePath) {
    templateFile = await resolveTemplaterFolderTemplate(app, folderPath);
    if (templateFile) {
      logger.log(`[CreateMeetingNote] Using Templater folder template: ${templateFile.path}`);
    }
  }

  if (templateFile) {
    const templateVars = buildExternalEventTemplateVars(null, {
      id: event.id,
      uid: event.uid,
      title: event.title,
      description: event.description,
      location: event.location,
      organizer: event.organizer,
      attendees: event.attendees,
      url: event.url,
      startISO: event.startDate.toISOString(),
      endISO: event.endDate.toISOString(),
    });
    const processed = await processTemplate(app, templateFile, templateVars);
    if (processed != null) {
      templateContent = processed;
    } else {
      templateContent = await app.vault.read(templateFile);
    }
  }

  // Build frontmatter object for fields we need to set
  // Default to hardcoded values if keys are not provided (backward compatibility / safety)
  const eventIdKey = frontmatterKeys?.eventIdKey || "externalEventId";
  const uidKey = frontmatterKeys?.uidKey; // No default fallback
  const titleKey = frontmatterKeys?.titleKey || "title";
  const statusKey = frontmatterKeys?.statusKey || "status";

  const frontmatter: Record<string, any> = {};
  frontmatter[titleKey] = event.title;
  frontmatter[eventIdKey] = event.id;

  if (uidKey) {
    frontmatter[uidKey] = event.uid;
  }

  if (event.endDate.getTime() < Date.now()) {
    frontmatter[statusKey] = "complete";
  }

  if (startProperty) {
    frontmatter[startProperty] = formatDateTimeForFrontmatter(event.startDate);
  }

  if (endProperty) {
    if (useEndDuration) {
      const durationMinutes = Math.round(
        (event.endDate.getTime() - event.startDate.getTime()) / (60 * 1000)
      );
      // Always use minutes (e.g. 90)
      frontmatter[endProperty] = durationMinutes;
    } else {
      frontmatter[endProperty] = formatDateTimeForFrontmatter(event.endDate);
    }
  }

  // Build note content (body only, frontmatter handled separately)
  let noteContent = templateContent;

  if (!templateContent) {
    // Default content if no template
    noteContent = `# ${event.title}\n\n`;
    if (event.description) {
      noteContent += `## Description\n${event.description}\n\n`;
    }
    if (event.attendees && event.attendees.length > 0) {
      noteContent += `## Attendees\n${event.attendees.map((a: string) => `- ${a}`).join("\n")}\n\n`;
    }
    noteContent += `## Notes\n\n`;
  }

  let file: TFile;

  if (existingFile) {
    // Overwrite existing file
    file = existingFile;
    await app.vault.modify(file, noteContent);
  } else {
    // Determine file path
    const folder = folderPath ? normalizePath(folderPath) : "";

    // Ensure folder exists
    if (folder) {
      const folderFile = app.vault.getAbstractFileByPath(folder);
      if (!folderFile) {
        try {
          await app.vault.createFolder(folder);
        } catch (e) {
          logger.error(`Failed to create folder ${folder}:`, e);
          // Fallback to root if folder creation fails
        }
      }
    }

    const sanitizedTitle = event.title
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const dateSuffix = `${event.startDate.getFullYear()}-${String(
      event.startDate.getMonth() + 1
    ).padStart(2, "0")}-${String(event.startDate.getDate()).padStart(2, "0")}`;

    let path = normalizePath(`${folder}/${sanitizedTitle} ${dateSuffix}.md`);
    let counter = 1;
    while (app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${folder}/${sanitizedTitle} ${dateSuffix} ${counter}.md`);
      counter++;
    }

    // Create the file with template content first (preserves original formatting)
    file = await app.vault.create(path, noteContent);
  }

  // Use processFrontMatter to add fields while preserving template formatting
  await app.fileManager.processFrontMatter(file, (fm) => {
    // Handle tags merging if calendarTag is specified
    const normalizedCalendarTag = normalizeTagValue(calendarTag);
    if (normalizedCalendarTag) {
      fm.tags = mergeTagInputs(fm.tags, normalizedCalendarTag);
    }

    // Delete template's title first to ensure ours takes precedence.
    deleteFrontmatterValueCaseInsensitive(fm, titleKey);
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value === undefined) continue;
      setFrontmatterValueCaseInsensitive(fm, key, value);
    }
  });

  // Invoke Templater plugin to process <% tp.* %> commands in the file
  if (templateFile) {
    const templater = (app as any)?.plugins?.plugins?.["templater-obsidian"];
    if (templater?.templater) {
      try {
        // overwrite_file_commands reads the file, processes all Templater
        // commands in-place, and writes the result back to the file.
        await templater.templater.overwrite_file_commands(file);
        logger.log(`[CreateMeetingNote] Templater processing complete for: ${file.basename}`);
      } catch (e) {
        logger.warn(`[CreateMeetingNote] Templater processing failed for "${file.basename}":`, e);
      }
    }
  }

  // Create bidirectional link if parent file is provided
  if (parentFile && parentLinkKey && childLinkKey) {
    try {
      await createBidirectionalLink(app, file, parentFile, parentLinkKey, childLinkKey);
      logger.log(`[CreateMeetingNote] Created bidirectional link: ${file.basename} ↔ ${parentFile.basename}`);
    } catch (error) {
      logger.error(`[CreateMeetingNote] Failed to create bidirectional link:`, error);
      // Don't fail the entire operation if linking fails
    }
  }

  const gcmPlugin = (app as any)?.plugins?.plugins?.['tps-global-context-menu'];
  const subtypeId = null;

  if (gcmPlugin && typeof gcmPlugin.applyTypeProfileForFile === 'function') {
    await gcmPlugin.applyTypeProfileForFile(file, {
      subtypeId,
      source: 'external-event-create',
    });
  }

  app.workspace.trigger('tps-file-created', file, { subtypeId });
  app.workspace.trigger('tps-calendar:file-created', file, { subtypeId });

  return file;
}

async function resolveTemplateFromPath(app: App, path: string | null): Promise<TFile | null> {
  return resolveTemplateFilePath(app, path, {
    allowBasenameMatchInTemplaterRoot: true,
    warnOnAmbiguousBasename: true,
  });
}

async function resolveTemplaterFolderTemplate(app: App, folderPath: string | null): Promise<TFile | null> {
  const templater = (app as any)?.plugins?.plugins?.["templater-obsidian"];
  if (!templater) return null;

  const templates = templater.settings?.folder_templates;
  if (!Array.isArray(templates) || templates.length === 0) return null;

  const targetFolder = folderPath ? normalizePath(folderPath) : "/";

  // Sort by length desc to match most specific folder first
  // Shape: { folder: string, template: string }
  const sorted = [...templates].sort((a, b) => b.folder.length - a.folder.length);

  const match = sorted.find(t => {
    const f = normalizePath(t.folder);
    return targetFolder === f || targetFolder.startsWith(`${f}/`);
  });

  if (match) {
    return resolveTemplateFromPath(app, match.template);
  }

  return null;
}

async function processTemplate(app: App, templateFile: TFile, vars: TemplateVars = {}): Promise<string | null> {
  try {
    const raw = await app.vault.read(templateFile);
    return applyTemplateVars(raw, vars);
  } catch (e) {
    logger.error("[ExternalEvent] Template processing failed", e);
    new Notice(`⚠️ Calendar Base: Error processing template "${templateFile.basename}".\n${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

function normalizeKey(key: string): string {
  return String(key || "").trim().toLowerCase();
}

function setFrontmatterValueCaseInsensitive(
  target: Record<string, any>,
  key: string,
  value: any,
): void {
  const normalized = normalizeKey(key);
  const existingKey = Object.keys(target).find((candidate) => normalizeKey(candidate) === normalized);
  target[existingKey || key] = value;
  if (existingKey && existingKey !== key && key in target) {
    delete target[key];
  }
}

function deleteFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string): void {
  const normalized = normalizeKey(key);
  Object.keys(target)
    .filter((candidate) => normalizeKey(candidate) === normalized)
    .forEach((candidate) => delete target[candidate]);
}
