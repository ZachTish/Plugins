import { App, TFile, FileView } from "obsidian";
import { NotebookNavigatorCompanionSettings } from "./types";

/**
 * Manages the runtime CSS override for Notebook Navigator icon colors,
 * and applies per-file color styles to the active editor view.
 *
 * Extracted from main.ts to keep the main class under 500 lines.
 */
export class StyleService {
    private runtimeStyleEl: HTMLStyleElement | null = null;
    private static readonly RUNTIME_STYLE_ID = "tps-nn-companion-runtime-style";

    constructor(
        private app: App,
        private getSettings: () => NotebookNavigatorCompanionSettings,
    ) {}

    /** Inject / update the global CSS variable for task-checkbox icon color. */
    applyNavigatorSystemIconColorOverride(): void {
        const color = this.normalizeCssColorValue(this.getSettings().noteCheckboxIconColor);
        if (!color) {
            if (this.runtimeStyleEl) {
                this.runtimeStyleEl.remove();
                this.runtimeStyleEl = null;
            }
            return;
        }

        if (!this.runtimeStyleEl) {
            this.runtimeStyleEl = document.createElement("style");
            this.runtimeStyleEl.id = StyleService.RUNTIME_STYLE_ID;
            document.head.appendChild(this.runtimeStyleEl);
        }

        this.runtimeStyleEl.textContent = `
      body {
        --nn-theme-file-task-icon-color: ${color};
      }
      /* Apply the dynamic color to various icon containers in the inline title area */
      .inline-title-icon,
      .view-header-icon,
      .obsidian-icon-folder-icon {
        color: var(--nn-active-file-color, inherit) !important;
      }
    `;
    }

    /** Apply the file's color frontmatter to the active editor container via CSS variable. */
    updateActiveViewStyle(file: TFile): void {
        const activeLeaf = this.app.workspace.activeLeaf;
        if (!activeLeaf || !(activeLeaf.view instanceof FileView)) return;

        const activeFile = activeLeaf.view.file;
        if (!(activeFile instanceof TFile) || activeFile.path !== file.path) return;

        const cache = this.app.metadataCache.getFileCache(file);
        const frontmatter = cache?.frontmatter;

        // Resolve color: iconColor > configured color field > "color"
        let color = this.getFrontmatterValue(frontmatter || {}, "iconColor");
        if (!color) {
            color = this.getFrontmatterValue(frontmatter || {}, this.getSettings().frontmatterColorField);
        }
        if (!color) {
            color = this.getFrontmatterValue(frontmatter || {}, "color");
        }

        const container = activeLeaf.view.containerEl;
        if (color && typeof color === "string") {
            const safeColor = this.normalizeCssColorValue(color);
            if (safeColor) {
                container.style.setProperty("--nn-active-file-color", safeColor);
                return;
            }
        }
        container.style.removeProperty("--nn-active-file-color");
    }

    /** Remove the runtime style element on plugin unload. */
    dispose(): void {
        if (this.runtimeStyleEl) {
            this.runtimeStyleEl.remove();
            this.runtimeStyleEl = null;
        }
    }

    private normalizeCssColorValue(value: string): string {
        return String(value ?? "")
            .replace(/[;\n\r{}<>]/g, "")
            .trim();
    }

    private getFrontmatterValue(frontmatter: Record<string, unknown>, key: string): unknown {
        if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
            return frontmatter[key];
        }
        const normalizedTarget = key.toLowerCase();
        for (const [existingKey, value] of Object.entries(frontmatter)) {
            if (existingKey.toLowerCase() === normalizedTarget) {
                return value;
            }
        }
        return undefined;
    }
}
