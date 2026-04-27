import { App, TFile, normalizePath } from "obsidian";
import { NotebookNavigatorCompanionSettings, TagPageFileType } from "../types";

const ROOT_TAG_PAGE = "__nn_tags_root__";
const UNTAGGED_TAG_PAGE = "__untagged__";

export class TagPageManager {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => NotebookNavigatorCompanionSettings,
  ) {}

  getAllTags(): string[] {
    const rawTags: Record<string, number> = (this.app.metadataCache as any).getTags?.() ?? {};
    return Object.keys(rawTags)
      .map((tag) => tag.replace(/^#/, ""))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  getTagPagePath(tag: string): string {
    return this.getTagPagePathForType(tag, this.getSettings().tagPageFileType);
  }

  getTagPagePathForType(tag: string, type: TagPageFileType): string {
    const settings = this.getSettings();
    const pageKey = this.getCanonicalTagPageKey(tag);
    const safeName = (pageKey === ROOT_TAG_PAGE ? "Tags" : pageKey).replace(/[\\:*?"<>|]/g, "-");
    const folder = String(settings.tagPageFolder || "").trim().replace(/^\/+|\/+$/g, "");
    const fileName = `${safeName}.${this.getTagPageExtension(type)}`;
    return folder ? normalizePath(`${folder}/${fileName}`) : normalizePath(fileName);
  }

  async ensureTagPage(tag: string): Promise<TFile | null> {
    const existing = this.getTagPageFile(tag);
    if (existing) return existing;

    if (!this.getSettings().createTagPageOnOpen) {
      return null;
    }

    const path = this.getTagPagePath(tag);
    await this.ensureParentFolders(path);
    await this.app.vault.create(path, this.getInitialContent(this.getSettings().tagPageFileType));
    return this.getTagPageFile(tag);
  }

  hasTagPage(tag: string): boolean {
    return this.getTagPageFile(tag) instanceof TFile;
  }

  async createTagPage(tag: string, typeOverride?: TagPageFileType): Promise<TFile | null> {
    const existing = this.getTagPageFile(tag);
    if (existing) return existing;
    const type = typeOverride ?? this.getSettings().tagPageFileType;
    const path = this.getTagPagePathForType(tag, type);
    await this.ensureParentFolders(path);
    await this.app.vault.create(path, this.getInitialContent(type));
    return this.getTagPageFile(tag);
  }

  getTagPageFile(tag: string): TFile | null {
    for (const type of this.getSupportedTypes()) {
      const file = this.app.vault.getFileByPath(this.getTagPagePathForType(tag, type));
      if (file instanceof TFile) return file;
    }
    return null;
  }

  getExistingTagPagePath(tag: string): string {
    return this.getTagPageFile(tag)?.path ?? "";
  }

  private getInitialContent(type: TagPageFileType): string {
    if (type === "canvas") {
      return JSON.stringify({ nodes: [], edges: [] }, null, 2);
    }

    if (type === "base") {
      return [
        "model:",
        "  version: 1",
        "  kind: Table",
        "  columns: []",
        "pluginVersion: 1.0.0",
        "views: []",
        "",
      ].join("\n");
    }

    return "";
  }

  private getTagPageExtension(type: TagPageFileType): string {
    if (type === "markdown") return "md";
    if (type === "base") return "base";
    return "canvas";
  }

  private getSupportedTypes(): TagPageFileType[] {
    return ["canvas", "markdown", "base"];
  }

  private async ensureParentFolders(filePath: string): Promise<void> {
    const folderPath = normalizePath(filePath).split("/").slice(0, -1).join("/");
    if (!folderPath) return;

    const parts = folderPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.app.vault.getFolderByPath(current)) continue;
      if (this.app.vault.getFileByPath(current)) {
        throw new Error(`Cannot create folder "${current}" because a file exists at that path.`);
      }
      await this.app.vault.createFolder(current);
    }
  }

  private normalizeTagInput(tag: string): string {
    return String(tag || "").replace(/^#/, "").trim().toLowerCase();
  }

  private getCanonicalTagPageKey(tag: string): string {
    const normalized = this.normalizeTagInput(tag);
    if (!normalized) return "";
    if (normalized === ROOT_TAG_PAGE) return normalized;
    if (normalized === UNTAGGED_TAG_PAGE) return normalized;
    const segments = normalized.split("/").map((part) => part.trim()).filter(Boolean);
    return segments[segments.length - 1] || normalized;
  }
}
