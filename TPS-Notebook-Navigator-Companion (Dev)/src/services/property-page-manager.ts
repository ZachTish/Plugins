import { App, TFile, normalizePath } from "obsidian";
import { NotebookNavigatorCompanionSettings, TagPageFileType } from "../types";

export class PropertyPageManager {
  constructor(
    private readonly app: App,
    private readonly getSettings: () => NotebookNavigatorCompanionSettings,
  ) {}

  getKnownProperties(): string[] {
    const pluginManager = (this.app as any)?.plugins;
    const gcm = pluginManager?.getPlugin?.("tps-global-context-menu") ?? pluginManager?.plugins?.["tps-global-context-menu"];
    const properties = Array.isArray((gcm as any)?.settings?.properties) ? (gcm as any).settings.properties : [];
    return properties
      .map((property: any) => String(property?.key || property?.id || "").trim())
      .filter(Boolean)
      .sort((a: string, b: string) => a.localeCompare(b));
  }

  getPropertyPagePath(propertyKey: string): string {
    return this.getPropertyPagePathForType(propertyKey, this.getSettings().propertyPageFileType);
  }

  getPropertyPagePathForType(propertyKey: string, type: TagPageFileType): string {
    const settings = this.getSettings();
    const safeName = this.getCanonicalPropertyPageKey(propertyKey).replace(/[\\:*?"<>|]/g, "-");
    const folder = String(settings.propertyPageFolder || "").trim().replace(/^\/+|\/+$/g, "");
    const fileName = `${safeName}.${this.getPageExtension(type)}`;
    return folder ? normalizePath(`${folder}/${fileName}`) : normalizePath(fileName);
  }

  getPropertyPageFile(propertyKey: string): TFile | null {
    for (const type of this.getSupportedTypes()) {
      const file = this.app.vault.getFileByPath(this.getPropertyPagePathForType(propertyKey, type));
      if (file instanceof TFile) return file;
    }
    return null;
  }

  hasPropertyPage(propertyKey: string): boolean {
    return this.getPropertyPageFile(propertyKey) instanceof TFile;
  }

  getExistingPropertyPagePath(propertyKey: string): string {
    return this.getPropertyPageFile(propertyKey)?.path ?? "";
  }

  async ensurePropertyPage(propertyKey: string): Promise<TFile | null> {
    const existing = this.getPropertyPageFile(propertyKey);
    if (existing) return existing;
    if (!this.getSettings().createPropertyPageOnOpen) return null;
    const type = this.getSettings().propertyPageFileType;
    const path = this.getPropertyPagePathForType(propertyKey, type);
    await this.ensureParentFolders(path);
    await this.app.vault.create(path, this.getInitialContent(type));
    return this.getPropertyPageFile(propertyKey);
  }

  async createPropertyPage(propertyKey: string, typeOverride?: TagPageFileType): Promise<TFile | null> {
    const existing = this.getPropertyPageFile(propertyKey);
    if (existing) return existing;
    const type = typeOverride ?? this.getSettings().propertyPageFileType;
    const path = this.getPropertyPagePathForType(propertyKey, type);
    await this.ensureParentFolders(path);
    await this.app.vault.create(path, this.getInitialContent(type));
    return this.getPropertyPageFile(propertyKey);
  }

  private getCanonicalPropertyPageKey(propertyKey: string): string {
    return String(propertyKey || "").trim() || "Property";
  }

  private getInitialContent(type: TagPageFileType): string {
    if (type === "canvas") return JSON.stringify({ nodes: [], edges: [] }, null, 2);
    if (type === "base") return ["model:", "  version: 1", "  kind: Table", "  columns: []", "pluginVersion: 1.0.0", "views: []", ""].join("\n");
    return "";
  }

  private getPageExtension(type: TagPageFileType): string {
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
      if (this.app.vault.getFileByPath(current)) throw new Error(`Cannot create folder "${current}" because a file exists at that path.`);
      await this.app.vault.createFolder(current);
    }
  }
}
