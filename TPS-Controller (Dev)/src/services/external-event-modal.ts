import { App, Modal, TFile, normalizePath, Notice, moment } from "obsidian";
import { ExternalCalendarEvent } from "../types";
import * as logger from "../logger";
import { formatDateTimeForFrontmatter } from "../utils";
import { createBidirectionalLink } from "./parent-child-link";
import {
  applyTemplateVars,
  buildExternalEventTemplateVars,
  type TemplateVars,
} from "../utils/template-variable-service";
import { resolveTemplateFile as resolveTemplateFilePath } from "../utils/template-resolution-service";
import { mergeTagInputs, normalizeTagValue, parseTagInput } from "../utils/tag-utils";
import { getPluginById, getErrorMessage } from "../core";
import { getDailyNoteResolver } from "../utils/daily-note-resolver";

const malformedFrontmatterWarnedPaths = new Set<string>();

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
  scheduledDateProperty: string | null = null,
  scheduledStartProperty: string | null = null,
  scheduledEndProperty: string | null = null,
  useEndDuration: boolean,
  calendarTag: string | null = null,
  parentFile?: TFile | null,
  parentLinkKey?: string,
  childLinkKey?: string,
  frontmatterKeys?: {
    eventIdKey: string;
    titleKey: string;
    scheduledDateProperty?: string;
    scheduledStartProperty?: string;
    scheduledEndProperty?: string;
  },
  existingFile?: TFile
): Promise<{ file: TFile | null; reusedExisting: boolean }> {
  // Load template (supports templater folder + relative paths)
  let templateContent = "";
  let templateFile = await resolveTemplateFromPath(app, templatePath);

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
  const titleKey = frontmatterKeys?.titleKey || "title";
  const scheduledDateKey = frontmatterKeys?.scheduledDateProperty || null;
  const scheduledStartKey = frontmatterKeys?.scheduledStartProperty || null;
  const scheduledEndKey = frontmatterKeys?.scheduledEndProperty || null;
  const durationMinutes = Math.max(
    1,
    Math.round((event.endDate.getTime() - event.startDate.getTime()) / (60 * 1000))
  );
  const startValue = event.isAllDay
    ? formatDateOnlyForFrontmatter(event.startDate)
    : formatDateTimeForFrontmatter(event.startDate);
  const endValue = event.isAllDay
    ? formatDateOnlyForFrontmatter(event.endDate)
    : formatDateTimeForFrontmatter(event.endDate);

  const frontmatter: Record<string, any> = {};
  frontmatter[titleKey] = event.title;
  frontmatter[eventIdKey] = event.id;
  frontmatter.allDay = event.isAllDay;
  frontmatter.location = event.location || "";
  frontmatter.organizer = event.organizer || "";
  if (scheduledDateKey) {
    frontmatter[scheduledDateKey] = formatDateOnlyForFrontmatter(event.startDate);
  }
  if (scheduledStartKey) {
    frontmatter[scheduledStartKey] = startValue;
  }
  if (scheduledEndKey) {
    frontmatter[scheduledEndKey] = endValue;
  }

  if (startProperty) {
    frontmatter[startProperty] = startValue;
  }

  if (endProperty) {
    if (useEndDuration) {
      // Always use minutes (e.g. 90)
      frontmatter[endProperty] = durationMinutes;
    } else {
      frontmatter[endProperty] = endValue;
    }
  }

  const bodyContent = templateContent;

  let file: TFile;
  let reusedExisting = !!existingFile;
  const gcmApi = (app as any)?.plugins?.getPlugin?.('tps-global-context-menu')?.api;
  if (existingFile) {
    file = existingFile;
    const existingContent = await app.vault.read(file);
    if (!existingContent.trim()) {
      await app.vault.modify(file, bodyContent);
    }
  } else {
    const folder = folderPath ? normalizePath(folderPath) : "";
    const safeBasename = buildExternalEventNoteBasename(app, event);
    const deterministicPath = normalizePath(`${folder}/${safeBasename}.md`);

    const existingAtPath = app.vault.getAbstractFileByPath(deterministicPath) || findFileByPathInsensitive(app, deterministicPath);
    if (existingAtPath instanceof TFile) {
      file = existingAtPath;
      reusedExisting = true;
      const existingContent = await app.vault.read(file);
      if (!existingContent.trim()) {
        await app.vault.modify(file, bodyContent);
      }
    } else {
      const normalizedEventTitle = normalizeEventTitle(event.title);
      const resolvedEventIdKey = frontmatterKeys?.eventIdKey || "externalEventId";
      if (event.id) {
        const existingByEventId = await findExistingNoteByEventId(app, event.id, resolvedEventIdKey);
        if (existingByEventId) {
          logger.log(`[CreateMeetingNote] Note already exists for "${normalizedEventTitle}" (${event.id}) — reusing ${existingByEventId.path}`);
          file = existingByEventId;
          reusedExisting = true;
        }
      }

    }

    if (!file) {
      if (folder) {
        const folderFile = app.vault.getAbstractFileByPath(folder);
        if (!folderFile) {
          try {
            await app.vault.createFolder(folder);
          } catch (e) {
            const nowExists = app.vault.getAbstractFileByPath(folder);
            if (nowExists) {
              logger.debug(`[CreateMeetingNote] Folder creation raced but folder now exists: ${folder}`);
            } else {
              logger.warn(`Failed to create folder ${folder}:`, e);
            }
          }
        }
      }

      if (!gcmApi?.createCalendarNote) {
        throw new Error('TPS Global Context Menu API unavailable for external event note creation');
      }
      const calendarTags = parseTagInput(calendarTag);
      file = await gcmApi.createCalendarNote({
        path: deterministicPath,
        initialContent: bodyContent,
        frontmatterOverrides: {
          ...frontmatter,
          folderPath: folder || '/',
          tags: calendarTags.length ? calendarTags : undefined,
        },
        parentFile: parentFile ?? null,
        dedupe: {
          exactPath: true,
          sameFolderBasename: false,
        },
      });
      reusedExisting = normalizePath(file.path) !== deterministicPath ? true : reusedExisting;
    }
  }

  // Apply identity/event frontmatter in one place so templates with existing
  // frontmatter are merged safely without duplicate YAML blocks.
  await processFrontmatterSafely(app, file, "external-event-create", (fm) => {
    const normalizedCalendarTags = parseTagInput(calendarTag);
    if (normalizedCalendarTags.length) {
      fm.tags = mergeTagInputs(fm.tags, normalizedCalendarTags);
    }
    const resolvedFolderPath = file.parent?.path || "/";
    setFrontmatterValueCaseInsensitive(fm, "folderPath", resolvedFolderPath);

    deleteFrontmatterValueCaseInsensitive(fm, titleKey);
    for (const [key, value] of Object.entries(frontmatter)) {
      if (value === undefined) continue;
      setFrontmatterValueCaseInsensitive(fm, key, value);
    }
  }, gcmApi);


  // Create the child-side parent link when a parent file is provided.
  // Stored reverse child lists are disabled when childLinkKey is empty.
  if (parentFile && parentLinkKey) {
    try {
      await createBidirectionalLink(app, file, parentFile, parentLinkKey, childLinkKey || "");
      logger.log(`[CreateMeetingNote] Created parent link: ${file.basename} -> ${parentFile.basename}`);
    } catch (error) {
      logger.error(`[CreateMeetingNote] Failed to create bidirectional link:`, error);
      // Don't fail the entire operation if linking fails
    }
  }

  const subtypeId: string | null = null;

  app.workspace.trigger('tps-file-created', file, { subtypeId });
  app.workspace.trigger('tps-calendar:file-created', file, { subtypeId });

  return { file, reusedExisting };
}

export function buildExternalEventNoteBasename(app: App, event: ExternalCalendarEvent): string {
  const normalizedEventTitle = normalizeEventTitle(event.title || "Untitled Event");
  const sanitizedTitle = sanitizeFileName(normalizedEventTitle) || "Untitled Event";
  const preferredDateFormat = getDailyNoteResolver(app).displayFormat;
  const dateSuffix = sanitizeFileName(moment(event.startDate).format(preferredDateFormat));
  const timeSuffix = buildScheduledTimeSuffix(event.startDate);
  const titleAlreadyHasDate = titleContainsDateToken(normalizedEventTitle, event.startDate, preferredDateFormat);
  const titleAlreadyHasTime = timeSuffix && normalizedEventTitle.toLowerCase().includes(timeSuffix.toLowerCase());
  const basenameWithDate = titleAlreadyHasDate || !dateSuffix
    ? sanitizedTitle
    : `${sanitizedTitle} ${dateSuffix}`;
  const rawBasename = timeSuffix && !titleAlreadyHasTime ? `${basenameWithDate} ${timeSuffix}` : basenameWithDate;
  return sanitizePathSegment(app, rawBasename);
}

/**
 * Explicitly invoke Templater's "Replace templates in file" on a newly-created
 * file so <% tp.* %> expressions are evaluated in-place.
 * Safe no-op when Templater is not installed.
 *
 * Uses overwrite_file_commands(file, false) — same code path as "Replace templates
 * in the active file" but works on any file object without an active editor view.
 */
async function resolveTemplateFromPath(app: App, path: string | null): Promise<TFile | null> {
  return resolveTemplateFilePath(app, path, {
    allowBasenameMatchInTemplaterRoot: true,
    warnOnAmbiguousBasename: true,
  });
}

async function processTemplate(app: App, templateFile: TFile, vars: TemplateVars = {}): Promise<string | null> {
  try {
    const raw = await app.vault.read(templateFile);
    return applyTemplateVars(raw, vars);
  } catch (e) {
    logger.error("[ExternalEvent] Template processing failed", e);
    new Notice(`⚠️ Calendar Base: Error processing template "${templateFile.basename}".\n${getErrorMessage(e)}`);
    return null;
  }
}

function normalizeKey(key: string): string {
  return String(key || "").trim().toLowerCase();
}

function normalizeEventTitle(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeFileName(value: string): string {
  return normalizeEventTitle(value)
    .replace(/[\\/:*?"<>|\x00-\x1F\x7F]/g, "")
    .trim();
}

function buildScheduledTimeSuffix(date: Date | null | undefined): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";

  const hours = date.getHours();
  const minutes = date.getMinutes();
  if (hours === 0 && minutes === 0) return "";

  return moment(date).format("h.mma").toLowerCase();
}

function formatDateOnlyForFrontmatter(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function titleContainsDateToken(title: string, date: Date, preferredFormat: string): boolean {
  const normalizedTitle = normalizeEventTitle(title);
  if (!normalizedTitle) return false;

  const m = moment;
  const ymd = m(date).format("YYYY-MM-DD");
  const titleLower = normalizedTitle.toLowerCase();

  const candidateFormats = [
    preferredFormat,
    "YYYY-MM-DD",
    "dddd, MMMM Do YYYY",
    "ddd, MMMM Do YYYY",
    "dddd, MMM Do YYYY",
    "ddd, MMM D YYYY",
    "MMMM D, YYYY",
    "MMM D, YYYY",
  ];

  for (const fmt of candidateFormats) {
    const formatted = m(date).format(fmt);
    if (formatted && titleLower.includes(formatted.toLowerCase())) {
      return true;
    }
  }

  const parsed = m(
    normalizedTitle,
    [...candidateFormats],
    true,
  );
  if (!parsed.isValid()) return false;
  return parsed.format("YYYY-MM-DD") === ymd;
}

async function findExistingNoteByEventId(app: App, eventId: string, eventIdKey: string): Promise<TFile | null> {
  if (!eventId) return null;
  const targetId = String(eventId).trim();
  const keyLower = eventIdKey.toLowerCase();

  for (const file of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) continue;
    const storedId = Object.entries(fm).find(([k]) => k.toLowerCase() === keyLower)?.[1];
    if (storedId == null) continue;
    if (String(storedId).trim() !== targetId) continue;
    return file;
  }

  return null;
}

function findFrontmatterValueCaseInsensitive(frontmatter: Record<string, any>, keyLower: string): any {
  for (const [key, value] of Object.entries(frontmatter || {})) {
    if (String(key || "").trim().toLowerCase() === keyLower) {
      return value;
    }
  }
  return undefined;
}

function extractRawFrontmatter(content: string): string | null {
  const match = String(content || "").match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? match[1] : null;
}

function findRawFrontmatterValue(frontmatterBody: string, keyLower: string): string | null {
  const lines = String(frontmatterBody || "").replace(/\r\n/g, "\n").split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("-")) continue;
    const sep = line.indexOf(":");
    if (sep <= 0) continue;

    const key = line.slice(0, sep).trim().replace(/^['"]|['"]$/g, "").toLowerCase();
    if (key !== keyLower) continue;

    return line.slice(sep + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return null;
}

function doesFrontmatterDateMatchDay(value: unknown, dayTarget: string): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10) === dayTarget;
  }
  if (/^\d{8}$/.test(raw)) {
    const normalized = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    return normalized === dayTarget;
  }
  return false;
}

function isTimedDate(date: Date | null | undefined): boolean {
  return !!date && date instanceof Date && !Number.isNaN(date.getTime()) && (date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0);
}

function doesFrontmatterDateMatchExactStart(value: unknown, startDate: Date): boolean {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  return raw === formatDateTimeForFrontmatter(startDate);
}

function findFileByPathInsensitive(app: App, path: string): TFile | null {
  const target = normalizePath(path).toLowerCase();
  for (const markdownFile of app.vault.getMarkdownFiles()) {
    if (normalizePath(markdownFile.path).toLowerCase() === target) {
      return markdownFile;
    }
  }
  return null;
}

function sanitizePathSegment(app: App, segment: string): string {
  const raw = String(segment || "").trim();
  if (!raw) return "Untitled";
  // @ts-ignore Internal adapter API used by Obsidian itself
  const fsSanitize = (app.vault.adapter as any)?.fs?.sanitize;
  if (typeof fsSanitize === "function") {
    const sanitized = String(fsSanitize(raw) || "").trim();
    if (sanitized) return sanitized;
  }
  return raw.replace(/[\\/:*?"<>|]/g, "").trim() || "Untitled";
}

function setFrontmatterValueCaseInsensitive(
  target: Record<string, any>,
  key: string,
  value: any,
): void {
  const normalized = normalizeKey(key);
  if (!normalized) return;
  for (const candidate of Object.keys(target || {})) {
    if (normalizeKey(candidate) === normalized) {
      delete target[candidate];
    }
  }
  target[key] = value;
}

function deleteFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string): void {
  const normalized = normalizeKey(key);
  if (!normalized) return;
  Object.keys(target || {})
    .filter((candidate) => normalizeKey(candidate) === normalized)
    .forEach((candidate) => delete target[candidate]);
}

async function processFrontmatterSafely(
  app: App,
  file: TFile,
  reason: string,
  mutate: (fm: Record<string, any>) => void,
  gcmApi?: any,
): Promise<boolean> {
  if (gcmApi?.processFrontmatter) {
    try {
      await gcmApi.processFrontmatter(file, () => {});
    } catch {
      // drain — wait for in-progress GCM serialized writes to complete
    }
  }

  const safety = await canMutateFrontmatterSafely(app, file);
  if (!safety.safe) {
    if (!malformedFrontmatterWarnedPaths.has(file.path)) {
      malformedFrontmatterWarnedPaths.add(file.path);
      new Notice(`Skipped frontmatter update for "${file.basename}" (${safety.reason}).`);
    }
    logger.warn(`[ExternalEvent] Skipping frontmatter mutation (${reason})`, {
      file: file.path,
      reason: safety.reason,
    });
    return false;
  }

  try {
    const writeFn = gcmApi?.processFrontmatter
      ? (cb: (fm: any) => void) => gcmApi.processFrontmatter(file, cb, { userInitiated: true })
      : (cb: (fm: any) => void) => app.fileManager.processFrontMatter(file, cb);
    await writeFn((frontmatter: any) => {
      mutate((frontmatter ?? {}) as Record<string, any>);
    });
    return true;
  } catch (error) {
    logger.warn(`[ExternalEvent] Frontmatter mutation failed (${reason})`, {
      file: file.path,
      error,
    });
    return false;
  }
}

async function canMutateFrontmatterSafely(
  app: App,
  file: TFile,
): Promise<{ safe: boolean; reason?: string }> {
  let content = "";
  try {
    content = await app.vault.cachedRead(file);
  } catch (error) {
    logger.warn("[ExternalEvent] Failed reading file for frontmatter safety check", {
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
