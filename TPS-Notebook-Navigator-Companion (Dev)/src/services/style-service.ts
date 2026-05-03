import { App, TFile, FileView } from "obsidian";

type CompanionNavigatorVisualSettings = {
  frontmatterColorField: string;
  noteCheckboxIconColor: string;
};

/**
 * Manages the runtime CSS override for Notebook Navigator icon colors,
 * and applies per-file color styles to the active editor view.
 *
 * Extracted from main.ts to keep the main class under 500 lines.
 */
export class StyleService {
    private runtimeStyleEl: HTMLStyleElement | null = null;
    private hoverStyleEl: HTMLStyleElement | null = null;
    private static readonly RUNTIME_STYLE_ID = "tps-nn-companion-runtime-style";
    private static readonly HOVER_STYLE_ID = "tps-nn-companion-hover-style";

    constructor(
        private app: App,
      private getSettings: () => CompanionNavigatorVisualSettings,
    ) {}

    /** Inject the always-on hover affordance for clickable Notebook Navigator status icons. */
    applyNavigatorStatusIconHoverGlow(): void {
        if (!this.hoverStyleEl) {
            this.hoverStyleEl = document.createElement("style");
            this.hoverStyleEl.id = StyleService.HOVER_STYLE_ID;
            document.head.appendChild(this.hoverStyleEl);
        }

        this.hoverStyleEl.textContent = `
      .view-content.notebook-navigator .nn-file[data-path] :is(.nn-file-icon, .nn-file-leading),
      .notebook-navigator .nn-file[data-path] :is(.nn-file-icon, .nn-file-leading),
      .view-content.notebook-navigator .nn-navitem[data-path][data-nav-item-type='note'] :is(.nn-navitem-icon, .nn-navitem-leading, .nn-item-icon),
      .notebook-navigator .nn-navitem[data-path][data-nav-item-type='note'] :is(.nn-navitem-icon, .nn-navitem-leading, .nn-item-icon),
      .view-content.notebook-navigator .nn-navitem[data-path][data-nav-item-type='file'] :is(.nn-navitem-icon, .nn-navitem-leading, .nn-item-icon),
      .notebook-navigator .nn-navitem[data-path][data-nav-item-type='file'] :is(.nn-navitem-icon, .nn-navitem-leading, .nn-item-icon) {
        cursor: pointer;
        transition: filter 120ms ease, box-shadow 120ms ease, transform 120ms ease, background-color 120ms ease;
      }

      .view-content.notebook-navigator .nn-file[data-path] :is(.nn-file-icon, .nn-file-leading):hover,
      .notebook-navigator .nn-file[data-path] :is(.nn-file-icon, .nn-file-leading):hover,
      .view-content.notebook-navigator .nn-navitem[data-path][data-nav-item-type='note'] :is(.nn-navitem-icon, .nn-navitem-leading, .nn-item-icon):hover,
      .notebook-navigator .nn-navitem[data-path][data-nav-item-type='note'] :is(.nn-navitem-icon, .nn-navitem-leading, .nn-item-icon):hover,
      .view-content.notebook-navigator .nn-navitem[data-path][data-nav-item-type='file'] :is(.nn-navitem-icon, .nn-navitem-leading, .nn-item-icon):hover,
      .notebook-navigator .nn-navitem[data-path][data-nav-item-type='file'] :is(.nn-navitem-icon, .nn-navitem-leading, .nn-item-icon):hover,
      .view-content.notebook-navigator .nn-file[data-path] :is(.nn-file-icon, .nn-file-leading):focus-visible,
      .notebook-navigator .nn-file[data-path] :is(.nn-file-icon, .nn-file-leading):focus-visible,
      .view-content.notebook-navigator .nn-navitem[data-path][data-nav-item-type='note'] :is(.nn-navitem-icon, .nn-navitem-leading, .nn-item-icon):focus-visible,
      .notebook-navigator .nn-navitem[data-path][data-nav-item-type='note'] :is(.nn-navitem-icon, .nn-navitem-leading, .nn-item-icon):focus-visible,
      .view-content.notebook-navigator .nn-navitem[data-path][data-nav-item-type='file'] :is(.nn-navitem-icon, .nn-navitem-leading, .nn-item-icon):focus-visible,
      .notebook-navigator .nn-navitem[data-path][data-nav-item-type='file'] :is(.nn-navitem-icon, .nn-navitem-leading, .nn-item-icon):focus-visible {
        background: color-mix(in srgb, var(--interactive-accent) 12%, transparent);
        border-radius: 6px;
        box-shadow:
          0 0 0 1px color-mix(in srgb, var(--interactive-accent) 30%, transparent),
          0 0 10px color-mix(in srgb, var(--interactive-accent) 45%, transparent);
        filter: drop-shadow(0 0 6px color-mix(in srgb, var(--interactive-accent) 60%, transparent));
        transform: translateY(-0.5px);
      }

      .notebook-navigator [data-tps-tag-page='false'] .nn-file-tag,
      .view-content.notebook-navigator [data-tps-tag-page='false'] .nn-file-tag,
      .notebook-navigator [data-tps-tag-page='false'] .nn-navitem-name,
      .view-content.notebook-navigator [data-tps-tag-page='false'] .nn-navitem-name,
      .notebook-navigator .nn-file-tag[data-tps-tag-page='false'],
      .view-content.notebook-navigator .nn-file-tag[data-tps-tag-page='false'],
      .notebook-navigator [data-tps-property-page='false'] .nn-navitem-name,
      .view-content.notebook-navigator [data-tps-property-page='false'] .nn-navitem-name,
      .notebook-navigator .nn-navitem-name[data-tps-property-page='false'] {
        cursor: default !important;
        text-decoration: none !important;
        filter: none !important;
      }

      .notebook-navigator [data-tps-tag-page='open'] .nn-file-tag,
      .view-content.notebook-navigator [data-tps-tag-page='open'] .nn-file-tag,
      .notebook-navigator [data-tps-tag-page='open'] .nn-navitem-name,
      .view-content.notebook-navigator [data-tps-tag-page='open'] .nn-navitem-name,
      .notebook-navigator .nn-file-tag[data-tps-tag-page='open'],
      .view-content.notebook-navigator .nn-file-tag[data-tps-tag-page='open'],
      .notebook-navigator [data-tps-property-page='open'] .nn-navitem-name,
      .view-content.notebook-navigator [data-tps-property-page='open'] .nn-navitem-name,
      .notebook-navigator .nn-navitem-name[data-tps-property-page='open'] {
        cursor: pointer !important;
        color: var(--link-color, var(--text-accent)) !important;
        text-decoration: underline !important;
        text-underline-offset: 0.12em;
        text-decoration-thickness: 1px;
      }
    `;
    }

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
      .notebook-navigator [data-tps-tag-page='false'] .nn-file-tag,
      .view-content.notebook-navigator [data-tps-tag-page='false'] .nn-file-tag,
      .notebook-navigator [data-tps-tag-page='false'] .nn-navitem-name,
      .view-content.notebook-navigator [data-tps-tag-page='false'] .nn-navitem-name,
      .notebook-navigator .nn-file-tag[data-tps-tag-page='false'],
      .view-content.notebook-navigator .nn-file-tag[data-tps-tag-page='false'] {
        cursor: default !important;
        text-decoration: none !important;
        filter: none !important;
      }
      .notebook-navigator [data-tps-tag-page='open'] .nn-file-tag,
      .view-content.notebook-navigator [data-tps-tag-page='open'] .nn-file-tag,
      .notebook-navigator [data-tps-tag-page='open'] .nn-navitem-name,
      .view-content.notebook-navigator [data-tps-tag-page='open'] .nn-navitem-name,
      .notebook-navigator .nn-file-tag[data-tps-tag-page='open'],
      .view-content.notebook-navigator .nn-file-tag[data-tps-tag-page='open'] {
        cursor: pointer !important;
        text-decoration: underline;
        text-underline-offset: 0.12em;
        text-decoration-thickness: 1px;
      }
      .notebook-navigator [data-tps-property-page='false'] .nn-navitem-name,
      .view-content.notebook-navigator [data-tps-property-page='false'] .nn-navitem-name,
      .notebook-navigator .nn-navitem-name[data-tps-property-page='false'] {
        cursor: default !important;
        text-decoration: none !important;
        filter: none !important;
      }
      .notebook-navigator [data-tps-property-page='open'] .nn-navitem-name,
      .view-content.notebook-navigator [data-tps-property-page='open'] .nn-navitem-name,
      .notebook-navigator .nn-navitem-name[data-tps-property-page='open'] {
        cursor: pointer !important;
        text-decoration: underline;
        text-underline-offset: 0.12em;
        text-decoration-thickness: 1px;
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
        if (this.hoverStyleEl) {
            this.hoverStyleEl.remove();
            this.hoverStyleEl = null;
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
