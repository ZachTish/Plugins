import {
  PluginSettingTab,
  Setting,
  App,
  TFile,
  FuzzySuggestModal,
  Modal,
} from "obsidian";
import type AutoBaseEmbedPlugin from "./main";
import type { BaseEmbedRule, BaseEmbedConditions, EmbedRuleKind } from "./settings-model";
import { createTPSSettingsGroup } from "./utils/settings-layout";

const DEFAULT_DATAVIEWJS_CODE = [
  'const current = dv.current();',
  'dv.paragraph(`Viewing ${current.file.name}`);',
].join('\n');

const createCollapsibleSection = (
  parent: HTMLElement,
  title: string,
  description?: string,
  defaultOpen = false,
): HTMLElement => {
  const details = parent.createEl('details', { cls: 'tps-collapsible-section' });
  if (defaultOpen) {
    details.setAttr('open', 'true');
  }

  const summary = details.createEl('summary', { cls: 'tps-collapsible-section-summary' });
  summary.createSpan({ cls: 'tps-collapsible-section-title', text: title });

  if (description) {
    details.createEl('p', {
      cls: 'tps-collapsible-section-description',
      text: description,
    });
  }

  return details.createDiv({ cls: 'tps-collapsible-section-content' });
};

class BaseFileSuggestModal extends FuzzySuggestModal<TFile> {
  onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Select a .base file...");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((file) => file.extension === "base");
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.onChoose(item);
  }
}

class TextInputModal extends Modal {
  private value: string;
  private onSubmit: (value: string) => void;
  private title: string;
  private placeholder: string;

  constructor(app: App, title: string, placeholder: string, initialValue: string, onSubmit: (value: string) => void) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.value = initialValue;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });

    const input = contentEl.createEl("input", { type: "text" });
    input.placeholder = this.placeholder;
    input.value = this.value;
    input.style.width = "100%";
    input.style.marginBottom = "12px";
    input.addEventListener("input", () => {
      this.value = input.value;
    });

    const actions = contentEl.createDiv({ cls: "tps-auto-base-embed-actions" });
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.justifyContent = "flex-end";

    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = actions.createEl("button", { text: "Add", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      if (this.value.trim()) {
        this.onSubmit(this.value.trim());
      }
      this.close();
    });

    input.focus();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (this.value.trim()) {
          this.onSubmit(this.value.trim());
        }
        this.close();
      }
    });
  }
}

class KeyValueModal extends Modal {
  private propKey = "";
  private propValue = "";
  private onSubmit: (key: string, value: string) => void;

  constructor(app: App, onSubmit: (key: string, value: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Add property condition" });

    const keyInput = contentEl.createEl("input", { type: "text", placeholder: "Property key (e.g., status)" });
    keyInput.style.width = "100%";
    keyInput.style.marginBottom = "8px";
    keyInput.addEventListener("input", () => {
      this.propKey = keyInput.value;
    });

    const valueInput = contentEl.createEl("input", { type: "text", placeholder: "Value (e.g., active)" });
    valueInput.style.width = "100%";
    valueInput.style.marginBottom = "12px";
    valueInput.addEventListener("input", () => {
      this.propValue = valueInput.value;
    });

    const actions = contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.justifyContent = "flex-end";

    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = actions.createEl("button", { text: "Add", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      if (this.propKey.trim() && this.propValue.trim()) {
        this.onSubmit(this.propKey.trim(), this.propValue.trim());
      }
      this.close();
    });

    keyInput.focus();
  }
}

export class AutoBaseEmbedSettingTab extends PluginSettingTab {
  plugin: AutoBaseEmbedPlugin;
  private expandedRules: Set<string> = new Set();
  private settingsViewState = new Map<string, boolean>();
  private settingsScrollTop = 0;
  private hasRenderedSettings = false;

  constructor(app: App, plugin: AutoBaseEmbedPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    this.captureSettingsViewState(containerEl);
    containerEl.empty();

    containerEl.createEl("h2", { text: "TPS Auto Base Embed" });

    const featuresCategory = createCollapsibleSection(containerEl, 'Essentials', 'The core switches you are most likely to change when setting up or troubleshooting embeds.', true);
    const matchingRulesCategory = createCollapsibleSection(containerEl, 'Rules', 'Which bases embed into which files, plus exclusions and matching logic.', false);

    new Setting(featuresCategory)
      .setName("Enable auto base embed")
      .setDesc("Render conditional Base embeds in matching notes.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enabled)
          .onChange(async (value) => {
            this.plugin.settings.enabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(featuresCategory)
      .setName("Enable in canvas files")
      .setDesc("Also render matching Base embeds when a .canvas file is open. Folder and path rules work best here because canvas files do not expose markdown frontmatter.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableCanvasEmbeds)
          .onChange(async (value) => {
            this.plugin.settings.enableCanvasEmbeds = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(featuresCategory)
      .setName("Enable on note cards within canvas")
      .setDesc("Inject Base embeds directly onto note cards displayed inside canvas files. Rules are evaluated against each card's note file and appear as a floating bar at the bottom of each card.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableCanvasNodeEmbeds)
          .onChange(async (value) => {
            this.plugin.settings.enableCanvasNodeEmbeds = value;
            await this.plugin.saveSettings();
          })
      );

    featuresCategory.createEl("p", {
      text: "Render placement is configured per rule, so different bases can appear after the title, after the content, or as a hovering overlay in the same note.",
      cls: "setting-item-description",
    });

    new Setting(featuresCategory)
      .setName("Default expansion state")
      .setDesc("Whether embedded bases start expanded or collapsed.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.defaultExpanded)
          .onChange(async (value) => {
            this.plugin.settings.defaultExpanded = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(featuresCategory)
      .setName("Accordion mode")
      .setDesc("Automatically collapse other bases when expanding one.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.accordionMode)
          .onChange(async (value) => {
            this.plugin.settings.accordionMode = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(featuresCategory)
      .setName("Always expanded (no collapse header)")
      .setDesc("Remove the collapse header entirely. Bases are always embedded and expanded with no way to collapse them.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.alwaysExpanded)
          .onChange(async (value) => {
            this.plugin.settings.alwaysExpanded = value;
            await this.plugin.saveSettings();
          })
      );

    matchingRulesCategory.createEl("p", {
      text: "Define which bases to embed and under what conditions. Rules are evaluated in order; all matching rules will be embedded.",
      cls: "setting-item-description"
    });

    const rulesContainer = matchingRulesCategory.createDiv({ cls: "tps-auto-base-embed-rules" });
    this.renderRules(rulesContainer);

    new Setting(matchingRulesCategory)
      .setName("Add new rule")
      .addButton((button) =>
        button
          .setButtonText("+ Add Base Rule")
          .setCta()
          .onClick(() => {
            new BaseFileSuggestModal(this.app, async (file) => {
              const newRule: BaseEmbedRule = {
                id: `rule-${Date.now()}`,
                kind: 'base',
                basePath: file.path,
                dataviewjsCode: '',
                enabled: true,
                conditions: {},
                renderPlacement: this.plugin.settings.renderMode === "inline"
                  ? this.plugin.settings.inlinePlacement
                  : "floating",
              };
              this.plugin.settings.rules.push(newRule);
              this.expandedRules.add(newRule.id);
              await this.plugin.saveSettings();
              this.display();
            }).open();
          })
      )
      .addButton((button) =>
        button
          .setButtonText("+ Add DataviewJS Rule")
          .onClick(async () => {
            const newRule: BaseEmbedRule = {
              id: `rule-${Date.now()}`,
              kind: 'dataviewjs',
              basePath: '',
              dataviewjsCode: DEFAULT_DATAVIEWJS_CODE,
              enabled: true,
              conditions: {},
              renderPlacement: this.plugin.settings.renderMode === 'inline'
                ? this.plugin.settings.inlinePlacement
                : 'floating',
            };
            this.plugin.settings.rules.push(newRule);
            this.expandedRules.add(newRule.id);
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(matchingRulesCategory)
      .setName("Exclude files")
      .setDesc("Comma or newline separated file paths to never embed in.")
      .addTextArea((text) =>
        text
          .setPlaceholder("Templates/Template.md")
          .setValue(this.plugin.settings.excludeFiles)
          .onChange(async (value) => {
            this.plugin.settings.excludeFiles = value;
            await this.plugin.saveSettings();
          })
      );

    matchingRulesCategory.createEl("p", {
      text: "Note: the Base is rendered using the current note as the source path, so filters like this.file.name resolve correctly.",
      cls: "setting-item-description",
    });

    const debugCategory = createTPSSettingsGroup(containerEl, 'Debug', 'Troubleshooting output for this plugin only.');

    new Setting(debugCategory)
      .setName("Debug logging")
      .setDesc("Enable TPS Auto Base Embed console messages for scroll, reuse, mount, and fallback diagnostics.")
      .addToggle((toggle) =>
        toggle
          .setValue(!!this.plugin.settings.debugLogging)
          .onChange(async (value) => {
            this.plugin.settings.debugLogging = value;
            await this.plugin.saveSettings();
          })
      );

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

  private renderRules(container: HTMLElement): void {
    container.empty();
    const rules = this.plugin.settings.rules;

    if (rules.length === 0) {
      container.createEl("p", { text: "No rules configured. Click 'Add Rule' to get started.", cls: "setting-item-description" });
      return;
    }

    for (const rule of rules) {
      const ruleEl = container.createDiv({ cls: "tps-auto-base-embed-rule" });
      const isExpanded = this.expandedRules.has(rule.id);

      const header = ruleEl.createDiv({ cls: "tps-auto-base-embed-rule-header" });

      const toggleContainer = header.createDiv({ cls: "tps-auto-base-embed-rule-toggle" });
      const toggle = toggleContainer.createEl("input", { type: "checkbox" });
      toggle.checked = rule.enabled;
      toggle.addEventListener("change", async (e) => {
        e.stopPropagation();
        rule.enabled = toggle.checked;
        await this.plugin.saveSettings();
      });

      const pathEl = header.createDiv({ cls: "tps-auto-base-embed-rule-path" });
      pathEl.textContent = this.getRuleTitle(rule);
      pathEl.title = this.getRuleTitleTooltip(rule);

      const summary = this.getConditionSummary(rule.conditions);
      if (summary) {
        const summaryEl = header.createDiv({ cls: "tps-auto-base-embed-rule-summary" });
        summaryEl.textContent = `${this.getRuleKindSummary(rule)} ${this.getRenderPlacementSummary(rule)} ${summary}`;
      } else {
        const summaryEl = header.createDiv({ cls: "tps-auto-base-embed-rule-summary" });
        summaryEl.textContent = `${this.getRuleKindSummary(rule)} ${this.getRenderPlacementSummary(rule)}`;
      }

      const actions = header.createDiv({ cls: "tps-auto-base-embed-rule-actions" });

      const expandBtn = actions.createEl("button");
      expandBtn.textContent = isExpanded ? "▼" : "▶";
      expandBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.expandedRules.has(rule.id)) {
          this.expandedRules.delete(rule.id);
        } else {
          this.expandedRules.add(rule.id);
        }
        this.display();
      });

      const deleteBtn = actions.createEl("button");
      deleteBtn.textContent = "✕";
      deleteBtn.title = "Delete rule";
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        this.plugin.settings.rules = this.plugin.settings.rules.filter((r) => r.id !== rule.id);
        await this.plugin.saveSettings();
        this.display();
      });

      header.addEventListener("click", () => {
        if (this.expandedRules.has(rule.id)) {
          this.expandedRules.delete(rule.id);
        } else {
          this.expandedRules.add(rule.id);
        }
        this.display();
      });

      const body = ruleEl.createDiv({ cls: `tps-auto-base-embed-rule-body ${isExpanded ? "" : "hidden"}` });
      if (isExpanded) {
        this.renderConditions(body, rule);
      }
    }
  }

  private renderConditions(container: HTMLElement, rule: BaseEmbedRule): void {
    this.renderRuleSourceSettings(container, rule);

    new Setting(container)
      .setName("Initial state")
      .setDesc("Override global default for this rule.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("default", "Global Default")
          .addOption("expanded", "Always Expanded")
          .addOption("collapsed", "Always Collapsed")
          .setValue(rule.initialState || "default")
          .onChange(async (value: "default" | "expanded" | "collapsed") => {
            rule.initialState = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(container)
      .setName("Render placement")
      .setDesc("Choose where this specific base embed appears when the rule matches.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("floating", "Hovering overlay")
          .addOption("after-title", "After title")
          .addOption("after-content", "After content")
          .setValue(rule.renderPlacement || "floating")
          .onChange(async (value: "floating" | "after-title" | "after-content") => {
            rule.renderPlacement = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    this.renderListCondition(container, rule, "folders", "Include folders", "Only embed if note is in one of these folders", "Folder path (e.g., Projects/)");
    this.renderListCondition(container, rule, "excludeFolders", "Exclude folders", "Don't embed if note is in one of these folders", "Folder path");
    this.renderListCondition(container, rule, "paths", "Include paths", "Only embed if note path matches one of these patterns (supports re:, name:, and * wildcard).", "Pattern (e.g., Markdown/Action Items/*)");
    this.renderListCondition(container, rule, "excludePaths", "Exclude paths", "Skip embed when note path matches one of these patterns (supports re:, name:, and * wildcard).", "Pattern (e.g., re:^Templates/)");
    this.renderListCondition(container, rule, "tags", "Include tags", "Only embed if note has one of these tags", "Tag (e.g., project)");
    this.renderListCondition(container, rule, "excludeTags", "Exclude tags", "Don't embed if note has one of these tags", "Tag (e.g., archive)");
    this.renderListCondition(container, rule, "requiredStatuses", "Required statuses", "Only embed when frontmatter status matches one of these values.", "Status (e.g., working)");
    this.renderListCondition(container, rule, "ignoreStatuses", "Ignore statuses", "Skip embed when frontmatter status matches one of these values.", "Status (e.g., complete)");
    new Setting(container)
      .setName("Require tag matching note name")
      .setDesc("Only embed if the note has a tag exactly matching the note name (case-insensitive).")
      .addToggle((toggle) =>
        toggle
          .setValue(!!rule.conditions.requireTagMatchingNoteName)
          .onChange(async (value) => {
            if (value) {
              rule.conditions.requireTagMatchingNoteName = true;
            } else {
              delete rule.conditions.requireTagMatchingNoteName;
            }
            await this.plugin.saveSettings();
          })
      );
    new Setting(container)
      .setName("Exclude tag matching note name")
      .setDesc("Skip embed when the note has a tag exactly matching the note name (case-insensitive).")
      .addToggle((toggle) =>
        toggle
          .setValue(!!rule.conditions.excludeTagMatchingNoteName)
          .onChange(async (value) => {
            if (value) {
              rule.conditions.excludeTagMatchingNoteName = true;
            } else {
              delete rule.conditions.excludeTagMatchingNoteName;
            }
            await this.plugin.saveSettings();
          })
      );

    new Setting(container)
      .setName("Require property")
      .setDesc("Only embed if the note has this frontmatter property (non-empty)")
      .addText((text) =>
        text
          .setPlaceholder("e.g., scheduled")
          .setValue(rule.conditions.requireProperty || "")
          .onChange(async (value) => {
            rule.conditions.requireProperty = value.trim() || undefined;
            await this.plugin.saveSettings();
          })
      );
    new Setting(container)
      .setName("Require property empty")
      .setDesc("Only embed if this frontmatter property is empty or missing.")
      .addText((text) =>
        text
          .setPlaceholder("e.g., scheduled")
          .setValue(rule.conditions.requirePropertyEmpty || "")
          .onChange(async (value) => {
            rule.conditions.requirePropertyEmpty = value.trim() || undefined;
            await this.plugin.saveSettings();
          })
      );

    this.renderKeyValueCondition(container, rule, "propertyEquals", "Property equals", "Embed only if property equals a specific value");
    this.renderKeyValueCondition(container, rule, "propertyNotEquals", "Property not equals", "Don't embed if property equals this value");
  }

  private renderRuleSourceSettings(container: HTMLElement, rule: BaseEmbedRule): void {
    new Setting(container)
      .setName('Embed content')
      .setDesc('Choose whether this rule renders a Bases file or a DataviewJS code block.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('base', 'Base file')
          .addOption('dataviewjs', 'DataviewJS code block')
          .setValue(this.getRuleKind(rule))
          .onChange(async (value: EmbedRuleKind) => {
            rule.kind = value;
            if (value === 'base' && typeof rule.basePath !== 'string') {
              rule.basePath = '';
            }
            if (value === 'dataviewjs' && !String(rule.dataviewjsCode || '').trim()) {
              rule.dataviewjsCode = DEFAULT_DATAVIEWJS_CODE;
            }
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.getRuleKind(rule) === 'dataviewjs') {
      this.renderDataviewRuleSettings(container, rule);
      return;
    }

    this.renderBaseRuleSettings(container, rule);
  }

  private renderBaseRuleSettings(container: HTMLElement, rule: BaseEmbedRule): void {
    new Setting(container)
      .setName('Base file')
      .addText((text) =>
        text
          .setValue(rule.basePath)
          .onChange(async (value) => {
            rule.basePath = value;
            await this.plugin.saveSettings();
          })
      )
      .addButton((btn) =>
        btn.setButtonText('Browse').onClick(() => {
          new BaseFileSuggestModal(this.app, async (file) => {
            rule.basePath = file.path;
            await this.plugin.saveSettings();
            this.display();
          }).open();
        })
      );
  }

  private renderDataviewRuleSettings(container: HTMLElement, rule: BaseEmbedRule): void {
    new Setting(container)
      .setName('DataviewJS code')
      .setDesc('This content is rendered as a fenced dataviewjs block in the matched note context.')
      .addTextArea((text) => {
        text
          .setPlaceholder('const current = dv.current();\ndv.paragraph(current.file.name);')
          .setValue(String(rule.dataviewjsCode || ''))
          .onChange(async (value) => {
            rule.dataviewjsCode = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 10;
        text.inputEl.style.width = '100%';
        text.inputEl.style.fontFamily = 'var(--font-monospace)';
      });
  }

  private renderListCondition(
    container: HTMLElement,
    rule: BaseEmbedRule,
    key: "folders" | "excludeFolders" | "paths" | "excludePaths" | "tags" | "excludeTags" | "requiredStatuses" | "ignoreStatuses",
    name: string,
    desc: string,
    placeholder: string
  ): void {
    const group = container.createDiv({ cls: "tps-auto-base-embed-condition-group" });
    group.createEl("h4", { text: name });
    group.createEl("p", { text: desc, cls: "setting-item-description" });

    const list = group.createDiv({ cls: "tps-auto-base-embed-condition-list" });
    const values = rule.conditions[key] || [];

    for (const value of values) {
      const tag = list.createDiv({ cls: "tps-auto-base-embed-tag" });
      tag.createSpan({ text: value });
      const removeBtn = tag.createEl("button", { text: "×" });
      removeBtn.addEventListener("click", async () => {
        rule.conditions[key] = (rule.conditions[key] || []).filter((v) => v !== value);
        if (rule.conditions[key]?.length === 0) delete rule.conditions[key];
        await this.plugin.saveSettings();
        this.display();
      });
    }

    const addBtn = list.createEl("button", { text: "+ Add", cls: "tps-auto-base-embed-add-btn" });
    addBtn.addEventListener("click", () => {
      new TextInputModal(this.app, `Add ${name.toLowerCase()}`, placeholder, "", async (value) => {
        if (!rule.conditions[key]) rule.conditions[key] = [];
        if (!rule.conditions[key]!.includes(value)) {
          rule.conditions[key]!.push(value);
          await this.plugin.saveSettings();
          this.display();
        }
      }).open();
    });
  }

  private renderKeyValueCondition(
    container: HTMLElement,
    rule: BaseEmbedRule,
    key: "propertyEquals" | "propertyNotEquals",
    name: string,
    desc: string
  ): void {
    const group = container.createDiv({ cls: "tps-auto-base-embed-condition-group" });
    group.createEl("h4", { text: name });
    group.createEl("p", { text: desc, cls: "setting-item-description" });

    const list = group.createDiv({ cls: "tps-auto-base-embed-condition-list" });
    const values = rule.conditions[key] || [];

    for (const { key: propKey, value: propValue } of values) {
      const tag = list.createDiv({ cls: "tps-auto-base-embed-tag" });
      tag.createSpan({ text: `${propKey} = ${propValue}` });
      const removeBtn = tag.createEl("button", { text: "×" });
      removeBtn.addEventListener("click", async () => {
        rule.conditions[key] = (rule.conditions[key] || []).filter(
          (v) => !(v.key === propKey && v.value === propValue)
        );
        if (rule.conditions[key]?.length === 0) delete rule.conditions[key];
        await this.plugin.saveSettings();
        this.display();
      });
    }

    const addBtn = list.createEl("button", { text: "+ Add", cls: "tps-auto-base-embed-add-btn" });
    addBtn.addEventListener("click", () => {
      new KeyValueModal(this.app, async (propKey, propValue) => {
        if (!rule.conditions[key]) rule.conditions[key] = [];
        rule.conditions[key]!.push({ key: propKey, value: propValue });
        await this.plugin.saveSettings();
        this.display();
      }).open();
    });
  }

  private getConditionSummary(conditions: BaseEmbedConditions): string {
    const parts: string[] = [];
    if (conditions.folders?.length) {
      parts.push(`in: ${conditions.folders.join(", ")}`);
    }
    if (conditions.excludeFolders?.length) {
      parts.push(`not in: ${conditions.excludeFolders.join(", ")}`);
    }
    if (conditions.paths?.length) {
      parts.push(`path: ${conditions.paths.join(", ")}`);
    }
    if (conditions.excludePaths?.length) {
      parts.push(`not path: ${conditions.excludePaths.join(", ")}`);
    }
    if (conditions.tags?.length) {
      parts.push(`tags: ${conditions.tags.join(", ")}`);
    }
    if (conditions.excludeTags?.length) {
      parts.push(`not tags: ${conditions.excludeTags.join(", ")}`);
    }
    if (conditions.requiredStatuses?.length) {
      parts.push(`status: ${conditions.requiredStatuses.join(", ")}`);
    }
    if (conditions.ignoreStatuses?.length) {
      parts.push(`not status: ${conditions.ignoreStatuses.join(", ")}`);
    }
    if (conditions.requireTagMatchingNoteName) {
      parts.push(`tag=note-name`);
    }
    if (conditions.excludeTagMatchingNoteName) {
      parts.push(`not tag=note-name`);
    }
    if (conditions.requireProperty) {
      parts.push(`has: ${conditions.requireProperty}`);
    }
    if (conditions.requirePropertyEmpty) {
      parts.push(`empty: ${conditions.requirePropertyEmpty}`);
    }
    if (conditions.propertyEquals?.length) {
      parts.push(conditions.propertyEquals.map((p) => `${p.key}=${p.value}`).join(", "));
    }
    if (conditions.propertyNotEquals?.length) {
      parts.push(conditions.propertyNotEquals.map((p) => `${p.key}≠${p.value}`).join(", "));
    }
    return parts.length > 0 ? `(${parts.join("; ")})` : "";
  }

  private getRenderPlacementSummary(rule: BaseEmbedRule): string {
    switch (rule.renderPlacement || "floating") {
      case "after-title":
        return "after title";
      case "after-content":
        return "after content";
      default:
        return "hovering";
    }
  }

  private getRuleKind(rule: BaseEmbedRule): EmbedRuleKind {
    return rule.kind === 'dataviewjs' ? 'dataviewjs' : 'base';
  }

  private getRuleKindSummary(rule: BaseEmbedRule): string {
    return this.getRuleKind(rule) === 'dataviewjs' ? 'dataviewjs' : 'base';
  }

  private getRuleTitle(rule: BaseEmbedRule): string {
    if (this.getRuleKind(rule) === 'dataviewjs') {
      const firstMeaningfulLine = String(rule.dataviewjsCode || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      return firstMeaningfulLine ? `DataviewJS: ${firstMeaningfulLine}` : 'DataviewJS';
    }
    return rule.basePath.split('/').pop() || rule.basePath;
  }

  private getRuleTitleTooltip(rule: BaseEmbedRule): string {
    if (this.getRuleKind(rule) === 'dataviewjs') {
      return String(rule.dataviewjsCode || '').trim() || 'DataviewJS rule';
    }
    return rule.basePath;
  }
}
