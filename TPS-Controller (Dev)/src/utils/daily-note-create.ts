import { App, TFile, normalizePath } from "obsidian";
import * as logger from "../logger";
import { getDailyNoteResolver } from "./daily-note-resolver";
import { applyTemplateVars, buildTemplateVars } from "./template-variable-service";
import { resolveTemplateFile } from "./template-resolution-service";

export async function ensureDailyNoteFile(
  app: App,
  date: Date,
  options?: { formatOverride?: string | null },
): Promise<TFile | null> {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;

  const resolver = getDailyNoteResolver(app, {
    formatOverride: options?.formatOverride ?? null,
  });
  const path = normalizePath(resolver.buildPath(date, "md"));
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) return existing;

  const slashIndex = path.lastIndexOf("/");
  const folderPath = slashIndex >= 0 ? path.slice(0, slashIndex) : "";
  if (folderPath) {
    await ensureFolderPath(app, folderPath);
  }

  const initialContent = await buildDailyNoteInitialContent(app, path, date, resolver.template || "");

  let created: TFile | null = null;
  try {
    created = await app.vault.create(path, initialContent);
  } catch (error: any) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("already exists")) {
      const live = app.vault.getAbstractFileByPath(path);
      if (live instanceof TFile) {
        created = live;
      }
    }
    if (!created) throw error;
  }

  await runTemplaterOnFile(app, created);
  return created;
}

async function buildDailyNoteInitialContent(app: App, path: string, date: Date, templatePath: string): Promise<string> {
  const basename = path.replace(/^.*\//, "").replace(/\.md$/i, "");
  const folderPath = path.includes("/") ? path.replace(/\/[^/]+$/, "") : "";
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);

  const vars = buildTemplateVars(null, {
    title: basename,
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    time: "00:00:00",
    datetime: midnight.toISOString(),
    timestamp: String(midnight.getTime()),
    file_name: `${basename}.md`,
    file_basename: basename,
    file_path: path,
    file_folder: folderPath,
  });

  const resolvedTemplate = resolveTemplateFile(app, String(templatePath || "").trim(), {
    allowBasenameMatchInTemplaterRoot: true,
    warnOnAmbiguousBasename: true,
  });
  if (resolvedTemplate instanceof TFile) {
    try {
      const raw = await app.vault.read(resolvedTemplate);
      return applyTemplateVars(raw, vars);
    } catch (error) {
      logger.warn("[DailyNoteCreate] Failed reading daily note template", {
        path,
        template: resolvedTemplate.path,
        error,
      });
    }
  }

  return `---\ntitle: ${basename}\ntags: [dailynote]\n---\n\n`;
}

async function runTemplaterOnFile(app: App, file: TFile): Promise<void> {
  const templater = (app as any)?.plugins?.getPlugin?.("templater-obsidian")
    ?? (app as any)?.plugins?.plugins?.["templater-obsidian"];
  if (!templater?.templater) return;
  try {
    await templater.templater.overwrite_file_commands(file, false);
  } catch (error) {
    logger.warn("[DailyNoteCreate] Templater failed during daily note create", {
      file: file.path,
      error,
    });
  }
}

async function ensureFolderPath(app: App, path: string): Promise<void> {
  const clean = normalizePath(path).trim();
  if (!clean) return;
  const parts = clean.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}
