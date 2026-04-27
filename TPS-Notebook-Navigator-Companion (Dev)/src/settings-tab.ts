import { App, PluginSettingTab, Setting, TextComponent } from "obsidian";
import NotebookNavigatorCompanionPlugin from "./main";
import { DebounceMap } from "./utils/debounce";
import { BindCommittedText } from "./settings/ui-common";

const TEXT_COMMIT_DEBOUNCE_MS = 300;
const SETTINGS_STYLE_ID = "tps-nn-companion-settings-style";

const createCollapsibleSection = (
  parent: HTMLElement,
  title: string,
  description?: string,
  defaultOpen = false
): HTMLElement => {
  const details = parent.createEl("details", { cls: "tps-collapsible-section" });
  if (defaultOpen) {
    details.setAttr("open", "true");
  }

  const summary = details.createEl("summary", { cls: "tps-collapsible-section-summary" });
  summary.createSpan({ cls: "tps-collapsible-section-title", text: title });

  if (description) {
    details.createEl("p", {
      cls: "tps-collapsible-section-description",
      text: description,
    });
  }

  return details.createDiv({ cls: "tps-collapsible-section-content" });
};

const createSettingsGroup = (
  parent: HTMLElement,
  title: string,
  description?: string,
): HTMLElement => {
  const group = parent.createDiv({ cls: 'tps-settings-flat-group' });
  group.style.marginBottom = '18px';
  group.style.padding = '14px 16px';
  group.style.border = '1px solid var(--background-modifier-border)';
  group.style.borderRadius = '12px';
  group.style.background = 'var(--background-secondary)';
  group.createEl('h3', { text: title });
  if (description) {
    group.createEl('p', { text: description, cls: 'setting-item-description' });
  }
  return group;
};

export class NotebookNavigatorCompanionSettingTab extends PluginSettingTab {
  plugin: NotebookNavigatorCompanionPlugin;
  private readonly textDebouncer = new DebounceMap();
  private settingsViewState = new Map<string, boolean>();
  private settingsScrollTop = 0;
  private hasRenderedSettings = false;

  constructor(app: App, plugin: NotebookNavigatorCompanionPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    this.render();
  }

  hide(): void {
    this.textDebouncer.cancelAll();
  }

  private render(): void {
    const { containerEl } = this;
    this.captureSettingsViewState(containerEl);
    containerEl.empty();
    this.ensureSettingsStyles();

    containerEl.createEl("h2", { text: "TPS Notebook Navigator Companion" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Data steward for Notebook Navigator. Applies frontmatter icon/color plus optional computed sort key for consistent sorting/grouping."
    });

    const featuresCategory = createSettingsGroup(containerEl, 'Automation', 'Core rule application and click-driven Notebook Navigator behavior.');
    const automationCategory = createSettingsGroup(containerEl, 'Pages and Metadata', 'On-demand page creation plus higher-impact metadata integration settings.');

    this.renderGeneralSettings(featuresCategory, automationCategory);
    this.restoreSettingsViewState(containerEl);
  }

  private captureSettingsViewState(containerEl: HTMLElement): void {
    this.settingsScrollTop = containerEl.scrollTop;
    this.settingsViewState.clear();
    const detailsEls = Array.from(containerEl.querySelectorAll("details"));
    detailsEls.forEach((detailsEl, index) => {
      const details = detailsEl as HTMLDetailsElement;
      const summaryText = details.querySelector("summary")?.textContent?.trim() || "";
      this.settingsViewState.set(`${index}:${summaryText}`, details.open);
    });
  }

  private restoreSettingsViewState(containerEl: HTMLElement): void {
    const detailsEls = Array.from(containerEl.querySelectorAll("details"));
    if (!this.hasRenderedSettings) {
      detailsEls.forEach((detailsEl) => {
        const details = detailsEl as HTMLDetailsElement;
        details.removeAttribute("open");
      });
      this.hasRenderedSettings = true;
      containerEl.scrollTop = 0;
      return;
    }
    detailsEls.forEach((detailsEl, index) => {
      const details = detailsEl as HTMLDetailsElement;
      const summaryText = details.querySelector("summary")?.textContent?.trim() || "";
      const isOpen = this.settingsViewState.get(`${index}:${summaryText}`);
      if (isOpen) details.setAttr("open", "true");
      else details.removeAttribute("open");
    });
    containerEl.scrollTop = this.settingsScrollTop;
  }

  private renderGeneralSettings(featuresContainer: HTMLElement, automationContainer: HTMLElement): void {
    const automationSection = createCollapsibleSection(
      featuresContainer,
      "Core Automation",
      "Companion should own notebook visual rule application. Higher-impact metadata behaviors live in Advanced."
    );

    new Setting(automationSection)
      .setName("Enable automation")
      .setDesc("Apply configured rules to markdown files.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enabled)
          .onChange(async (value) => {
            this.plugin.settings.enabled = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

    const automationConfig = automationSection.createDiv({ cls: "tps-companion-automation-config" });
    automationConfig.style.display = this.plugin.settings.enabled ? "" : "none";

    new Setting(automationConfig)
      .setName("Auto-apply on file open")
      .setDesc("Evaluate and apply rules when a file becomes active.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoApplyOnFileOpen)
          .onChange(async (value) => {
            this.plugin.settings.autoApplyOnFileOpen = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(automationConfig)
      .setName("Auto-apply on metadata change")
      .setDesc("Evaluate and apply rules after frontmatter changes.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.autoApplyOnMetadataChange)
          .onChange(async (value) => {
            this.plugin.settings.autoApplyOnMetadataChange = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(automationConfig)
      .setName("Startup vault scan")
      .setDesc("Startup scanning is now managed by the TPS-Controller plugin.")
      .setDisabled(true);

    new Setting(automationConfig)
      .setName("Metadata debounce (ms)")
      .setDesc("Debounce for metadata-change events before re-applying rules.")
      .addText((text) => {
        text.setPlaceholder("350");
        this.bindCommittedText(text, String(this.plugin.settings.metadataDebounceMs), async (value) => {
          const parsed = Number.parseInt(value, 10);
          this.plugin.settings.metadataDebounceMs = Number.isFinite(parsed)
            ? Math.max(0, Math.min(parsed, 5000))
            : 350;
        });
      });

    new Setting(automationConfig)
      .setName("Manual apply")
      .setDesc("Apply rules immediately.")
      .addButton((button) => {
        button
          .setButtonText("Active file")
          .onClick(async () => {
            await this.plugin.applyRulesToActiveFile(true);
          });
      })
      .addButton((button) => {
        button
          .setButtonText("All markdown files")
          .onClick(async () => {
            await this.plugin.applyRulesToAllFiles(true);
          });
      });

    const statusFlowSection = createCollapsibleSection(
      automationContainer,
      "Status Click Flow",
      "Configure how clicking the Notebook Navigator status icon advances frontmatter status. Leave blank to keep Navigator's default cycle. Values not listed here are left unchanged.",
      false
    );

    new Setting(statusFlowSection)
      .setName("Status click flow")
      .setDesc("Comma or newline separated values, in order. Example: complete, todo")
      .addText((text) => {
        text.setPlaceholder("complete, todo");
        this.bindCommittedText(text, this.plugin.settings.statusClickFlow.join(", "), async (value) => {
          this.plugin.settings.statusClickFlow = value
            .split(/[\n,]+/)
            .map((entry) => entry.trim())
            .filter(Boolean);
        });
      });

    const tagPagesSection = createCollapsibleSection(
      automationContainer,
      "Tag Pages",
      "Open a tag page when you click a tag in Notebook Navigator or a graph view. Companion only opens or creates the page on demand — it does not auto-sync tag content.",
      false
    );

    new Setting(tagPagesSection)
      .setName("Tag page folder")
      .setDesc("Vault-relative folder where tag pages are stored. Leave blank to store them at the vault root.")
      .addText((text) => {
        text.setPlaceholder("Tag Pages or blank for root");
        this.bindCommittedText(text, this.plugin.settings.tagPageFolder, async (value) => {
          this.plugin.settings.tagPageFolder = value.trim().replace(/^\/+|\/+$/g, "");
        });
      });

    new Setting(tagPagesSection)
      .setName("Tag page file type")
      .setDesc("Choose the file type created for missing tag pages.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("canvas", "Canvas")
          .addOption("markdown", "Markdown")
          .addOption("base", "Base")
          .setValue(this.plugin.settings.tagPageFileType)
          .onChange(async (value) => {
            if (value === "canvas" || value === "markdown" || value === "base") {
              this.plugin.settings.tagPageFileType = value;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(tagPagesSection)
      .setName("Create missing tag pages on open")
      .setDesc("If enabled, clicking a tag creates the page if it doesn't exist yet.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.createTagPageOnOpen)
          .onChange(async (value) => {
            this.plugin.settings.createTagPageOnOpen = value;
            await this.plugin.saveSettings();
          });
      });

    const propertyPagesSection = createCollapsibleSection(
      automationContainer,
      "Property Pages",
      "Open or create a page for Notebook Navigator properties on demand. Companion only opens or creates the page on demand — it does not auto-sync property content.",
      false
    );

    new Setting(propertyPagesSection)
      .setName("Property page folder")
      .setDesc("Vault-relative folder where property pages are stored. Leave blank to store them at the vault root.")
      .addText((text) => {
        text.setPlaceholder("Property Pages or blank for root");
        this.bindCommittedText(text, this.plugin.settings.propertyPageFolder, async (value) => {
          this.plugin.settings.propertyPageFolder = value.trim().replace(/^\/+|\/+$/g, "");
        });
      });

    new Setting(propertyPagesSection)
      .setName("Property page default file type")
      .setDesc("Default file type used for automatic property page creation.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("canvas", "Canvas")
          .addOption("markdown", "Markdown")
          .addOption("base", "Base")
          .setValue(this.plugin.settings.propertyPageFileType)
          .onChange(async (value) => {
            if (value === "canvas" || value === "markdown" || value === "base") {
              this.plugin.settings.propertyPageFileType = value;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(propertyPagesSection)
      .setName("Create missing property pages on open")
      .setDesc("If enabled, clicking a property creates the page if it doesn't exist yet.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.createPropertyPageOnOpen)
          .onChange(async (value) => {
            this.plugin.settings.createPropertyPageOnOpen = value;
            await this.plugin.saveSettings();
          });
      });

    const advancedSection = createCollapsibleSection(
      automationContainer,
      "Advanced Metadata",
      "These are higher-impact write paths and integration settings. Change them only if you need Companion to own metadata beyond icon/color rules."
    );

    new Setting(advancedSection)
      .setName("Upstream link keys")
      .setDesc("Comma-separated list of frontmatter keys (e.g. 'parent, project') that should trigger updates on the linked note when modified.")
      .addText((text) => {
        text.setPlaceholder("parent");
        this.bindCommittedText(
          text,
          this.plugin.settings.upstreamLinkKeys.join(", "),
          async (value) => {
            this.plugin.settings.upstreamLinkKeys = value
              .split(/[\n,]+/)
              .map((k) => k.trim())
              .filter(Boolean);
          },
          false,
          false
        );
      });

    new Setting(advancedSection)
      .setName("Debug logging")
      .setDesc("Emit verbose diagnostics to Developer Console.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
          });
      });

  }

  private async persistRuleChange(applyActive = false): Promise<void> {
    await this.plugin.saveSettings();
    if (applyActive) {
      await this.plugin.applyRulesToActiveFile(false);
    }
  }

  private bindCommittedText: BindCommittedText = (
    text: TextComponent,
    initialValue: string,
    commit: (value: string) => Promise<void>,
    refreshOnCommit = false,
    applyToActiveFileOnCommit = false
  ) => {
    let committedValue = initialValue ?? "";
    let draftValue = committedValue;

    const commitNow = async () => {
      if (draftValue === committedValue) {
        return;
      }

      await commit(draftValue);
      committedValue = draftValue;
      await this.plugin.saveSettings();

      if (applyToActiveFileOnCommit) {
        await this.plugin.applyRulesToActiveFile(false);
      }

      if (refreshOnCommit) {
        this.render();
      }
    };

    text.setValue(committedValue);

    const commitKey = `text:${Math.random().toString(36).slice(2, 9)}`;

    text.onChange((value) => {
      draftValue = value;
      this.textDebouncer.schedule(commitKey, TEXT_COMMIT_DEBOUNCE_MS, async () => {
        await commitNow();
      });
    });

    text.inputEl.addEventListener("blur", () => {
      this.textDebouncer.cancel(commitKey);
      void commitNow();
    });

    text.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        text.inputEl.blur();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        this.textDebouncer.cancel(commitKey);
        draftValue = committedValue;
        text.setValue(committedValue);
        text.inputEl.blur();
      }
    });
  };

  private ensureSettingsStyles(): void {
    if (document.getElementById(SETTINGS_STYLE_ID)) {
      return;
    }

    const style = document.createElement("style");
    style.id = SETTINGS_STYLE_ID;
    style.textContent = `
      .tps-nn-section {
        margin: 18px 0;
        padding: 14px;
        border: 1px solid var(--background-modifier-border);
        border-radius: 12px;
        background: color-mix(in srgb, var(--background-secondary) 60%, transparent);
      }

      .tps-nn-section > h3 {
        margin-top: 0;
      }

      .tps-nn-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 10px 0 14px;
      }

      .tps-nn-toolbar button,
      .tps-nn-inline-actions button {
        border-radius: 8px;
      }

      .tps-nn-split {
        display: grid;
        grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
        gap: 12px;
      }

      .tps-nn-list-pane {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .tps-nn-filter-input {
        width: 100%;
        min-height: 32px;
        border-radius: 8px;
        border: 1px solid var(--background-modifier-border);
        padding: 0 10px;
        background: var(--background-primary);
        color: var(--text-normal);
      }

      .tps-nn-editor-pane {
        border: 1px solid var(--background-modifier-border);
        border-radius: 10px;
        padding: 10px;
        background: color-mix(in srgb, var(--background-primary) 85%, transparent);
      }

      .tps-nn-list-item {
        width: 100%;
        border: 1px solid var(--background-modifier-border);
        border-radius: 10px;
        padding: 8px;
        background: var(--background-primary);
        text-align: left;
      }

      .tps-nn-list-item.is-active {
        border-color: var(--interactive-accent);
        box-shadow: inset 0 0 0 1px var(--interactive-accent);
      }

      .tps-nn-list-item-title-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .tps-nn-list-item-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        flex-shrink: 0;
      }

      .tps-nn-list-item-icon svg {
        width: 16px;
        height: 16px;
      }

      .tps-nn-list-item-title {
        font-weight: 700;
        color: var(--text-accent);
      }

      .tps-nn-list-item-title.is-muted {
        color: var(--text-muted);
      }

      .tps-nn-list-item-summary {
        margin-top: 3px;
        color: var(--text-muted);
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tps-nn-badge-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 8px 0;
      }

      .tps-nn-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        background: var(--background-modifier-border-hover);
        color: var(--text-muted);
      }

      .tps-nn-rule-card,
      .tps-nn-sort-card {
        border: 1px solid var(--background-modifier-border);
        border-radius: 10px;
        padding: 0;
        margin: 12px 0;
        background: var(--background-primary);
      }

      .tps-nn-collapsible {
        border-radius: 10px;
      }

      .tps-nn-collapsible summary::-webkit-details-marker {
        display: none;
      }

      .tps-nn-collapsible-summary {
        list-style: none;
        cursor: pointer;
        display: flex;
        flex-wrap: wrap;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
        padding: 10px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--background-secondary) 75%, transparent);
      }

      .tps-nn-collapsible-summary::before {
        content: "▸";
        margin-right: 6px;
        color: var(--text-faint);
      }

      .tps-nn-collapsible[open] > .tps-nn-collapsible-summary::before {
        content: "▾";
      }

      .tps-nn-collapsible-title-wrap {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 220px;
      }

      .tps-nn-collapsible-body {
        padding: 10px;
      }

      .tps-nn-rule-header,
      .tps-nn-sort-header {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: flex-start;
        margin-bottom: 8px;
      }

      .tps-nn-rule-title,
      .tps-nn-sort-title {
        margin: 0;
      }

      .tps-nn-inline-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .tps-nn-summary {
        margin: 0 0 10px;
        color: var(--text-muted);
        font-size: 12px;
      }

      .tps-nn-divider {
        margin: 10px 0;
        border-top: 1px dashed var(--background-modifier-border);
      }

      .tps-nn-subsection-title {
        margin: 6px 0;
        font-size: 13px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }

      .tps-nn-icon-choices,
      .tps-nn-color-swatches {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 8px 0 4px;
      }

      .tps-nn-icon-choice {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border-radius: 7px;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-secondary);
      }

      .tps-nn-icon-choice.is-active {
        border-color: var(--interactive-accent);
        box-shadow: inset 0 0 0 1px var(--interactive-accent);
      }

      .tps-nn-swatch {
        width: 24px;
        height: 24px;
        border-radius: 999px;
        border: 1px solid var(--background-modifier-border);
      }

      .tps-nn-swatch.is-active {
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive-accent) 60%, transparent);
      }

      .tps-nn-condition-card {
        border: 1px solid var(--background-modifier-border);
        border-radius: 8px;
        padding: 6px;
        margin: 8px 0;
        background: color-mix(in srgb, var(--background-secondary) 55%, transparent);
      }

      .tps-nn-condition-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }

      .tps-nn-compact-btn {
        min-height: 28px;
        padding: 0 10px;
        border-radius: 8px;
      }

      .tps-nn-condition-grid {
        display: grid;
        grid-template-columns: minmax(110px, 1fr) minmax(110px, 1fr) minmax(120px, 1.3fr) minmax(160px, 2fr) auto;
        gap: 8px;
        align-items: center;
      }

      .tps-nn-condition-field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }

      .tps-nn-condition-field-value {
        grid-column: auto;
      }

      .tps-nn-condition-field label {
        display: none;
      }

      .tps-nn-condition-field input,
      .tps-nn-condition-field select {
        width: 100%;
        min-height: 30px;
        border-radius: 8px;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        color: var(--text-normal);
        padding: 0 8px;
      }

      .tps-nn-sub-collapsible {
        margin: 10px 0;
        border: 1px dashed var(--background-modifier-border);
        border-radius: 8px;
      }

      .tps-nn-sub-collapsible > summary {
        cursor: pointer;
        list-style: none;
        padding: 8px;
        color: var(--text-muted);
        font-weight: 600;
      }

      .tps-nn-sub-collapsible > summary::-webkit-details-marker {
        display: none;
      }

      .tps-nn-sub-collapsible > summary::before {
        content: "+";
        margin-right: 6px;
        color: var(--text-faint);
      }

      .tps-nn-sub-collapsible[open] > summary::before {
        content: "−";
      }

      .tps-nn-sub-body {
        padding: 0 8px 8px;
      }

      .tps-nn-callout {
        margin: 10px 0;
        padding: 8px 10px;
        border-left: 3px solid var(--interactive-accent);
        background: color-mix(in srgb, var(--interactive-accent) 10%, transparent);
        border-radius: 6px;
        font-size: 12px;
        color: var(--text-muted);
      }

      @media (max-width: 900px) {
        .tps-nn-split {
          grid-template-columns: 1fr;
        }

        .tps-nn-condition-grid {
          grid-template-columns: 1fr;
        }
        
        .tps-nn-condition-field label {
          display: block;
          font-size: 11px;
          color: var(--text-muted);
        }
      }
    `;

    document.head.appendChild(style);
  }

  private toPickerHexColor(value: string): string | null {
    const normalized = String(value ?? "").trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(normalized)) {
      const expanded = normalized
        .split("")
        .map((part) => `${part}${part}`)
        .join("")
        .toLowerCase();
      return `#${expanded}`;
    }

    if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
      return `#${normalized.toLowerCase()}`;
    }

    if (/^[0-9a-fA-F]{8}$/.test(normalized)) {
      return `#${normalized.slice(0, 6).toLowerCase()}`;
    }

    return null;
  }
}
