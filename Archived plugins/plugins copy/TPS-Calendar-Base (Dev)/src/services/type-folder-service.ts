import { App, TFile, normalizePath } from "obsidian";

export interface TypeFolderOption {
  path: string;
  label: string;
  hasTypeTemplate: boolean;
}

const MAX_TYPE_FOLDER_OPTIONS = 500;

export class TypeFolderService {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  getTypeFolderOptions(): TypeFolderOption[] {
    const templateRoot = this.getTypeTemplateRoot();
    const templateBacked = this.getTemplateBackedTypeFolders(templateRoot);
    const vaultFolders = this.getVaultMarkdownFolders(templateRoot);

    const all = new Map<string, TypeFolderOption>();
    templateBacked.forEach((path) => {
      all.set(path, {
        path,
        label: path,
        hasTypeTemplate: true,
      });
    });
    vaultFolders.forEach((path) => {
      if (!all.has(path)) {
        all.set(path, {
          path,
          label: path,
          hasTypeTemplate: false,
        });
      }
    });

    return Array.from(all.values())
      .sort((a, b) => {
        if (a.hasTypeTemplate !== b.hasTypeTemplate) {
          return a.hasTypeTemplate ? -1 : 1;
        }
        return a.path.localeCompare(b.path);
      })
      .slice(0, MAX_TYPE_FOLDER_OPTIONS);
  }

  private getTypeTemplateRoot(): string | null {
    const gcmPlugin = (this.app as any)?.plugins?.plugins?.["tps-global-context-menu"];
    const configuredRoot = gcmPlugin?.settings?.typeTemplateFolderPath;
    if (typeof configuredRoot === "string" && configuredRoot.trim()) {
      return normalizePath(configuredRoot.trim());
    }
    return "System/Templates/Types";
  }

  private getTemplateBackedTypeFolders(templateRoot: string | null): Set<string> {
    const result = new Set<string>();
    if (!templateRoot) return result;
    const rootPrefix = `${templateRoot}/`;

    this.app.vault.getMarkdownFiles().forEach((file) => {
      const normalizedPath = normalizePath(file.path);
      if (!normalizedPath.startsWith(rootPrefix)) return;
      if (!normalizedPath.toLowerCase().endsWith(".md")) return;
      const relative = normalizedPath.slice(rootPrefix.length, -3).trim();
      if (!relative) return;
      result.add(normalizePath(relative));
    });

    return result;
  }

  private getVaultMarkdownFolders(templateRoot: string | null): Set<string> {
    const result = new Set<string>();
    const templatePrefix = templateRoot ? `${templateRoot}/` : null;
    const templateRootNormalized = templateRoot ? normalizePath(templateRoot) : null;

    this.app.vault.getMarkdownFiles().forEach((file: TFile) => {
      const parentPath = file.parent?.path;
      if (!parentPath || parentPath === "/") return;
      const normalizedParent = normalizePath(parentPath);
      if (templateRootNormalized && normalizedParent === templateRootNormalized) return;
      if (templatePrefix && normalizedParent.startsWith(templatePrefix)) return;
      result.add(normalizedParent);
    });

    return result;
  }
}
