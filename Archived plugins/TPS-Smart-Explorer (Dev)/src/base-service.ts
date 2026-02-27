/**
 * Base Service
 *
 * Legacy tag/type base view generation is intentionally disabled.
 */

import { normalizePath } from "obsidian";
import type ExplorerPlugin from "./main";

export class BaseService {
  private plugin: ExplorerPlugin;

  constructor(plugin: ExplorerPlugin) {
    this.plugin = plugin;
  }

  get app() {
    return this.plugin.app;
  }

  shouldUseTypesBaseViews(): boolean {
    return false;
  }

  shouldUsePerTagBaseFiles(): boolean {
    return false;
  }

  normalizeVaultPath(rawPath: string): string {
    const trimmed = (rawPath || "").trim();
    if (!trimmed) return "";
    const adapter = this.app.vault.adapter as any;
    const basePath = adapter?.basePath;
    if (basePath && trimmed.startsWith(basePath)) {
      const relative = trimmed.slice(basePath.length).replace(/^\/+/, "");
      return normalizePath(relative);
    }
    return normalizePath(trimmed);
  }

  filtersContainTagRule(filters: any, tagRule: string): boolean {
    if (!filters) return false;
    if (typeof filters === "string") {
      return (
        filters.includes(tagRule) ||
        filters.includes(tagRule.replace(/"/g, "'"))
      );
    }
    if (Array.isArray(filters)) {
      return filters.some((entry) =>
        this.filtersContainTagRule(entry, tagRule)
      );
    }
    if (typeof filters === "object") {
      return Object.values(filters).some((entry) =>
        this.filtersContainTagRule(entry, tagRule)
      );
    }
    return false;
  }

  buildTagBaseFilePath(tag: string): string | null {
    void tag;
    return null;
  }

  buildFolderBaseFilePath(folderPath: string): string | null {
    void folderPath;
    return null;
  }

  destroy(): void {
    // No resources to release.
  }
}
