import {
  PluginSettingTab,
  Setting,
  App,
  TFile,
  FuzzySuggestModal,
  Modal,
} from "obsidian";
import type AutoBaseEmbedPlugin from "./main";
import type { BaseEmbedRule, BaseEmbedConditions } from "./main";

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

  constructor(app: App, plugin: AutoBaseEmbedPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "TPS Auto Base Embed" });

    const createMainCategory = (title: string, defaultOpen = true): HTMLElement => {
      const details = containerEl.createEl('details', { cls: 'tps-settings-main-category' });
      if (defaultOpen) details.setAttr('open', 'true');
      const summary = details.createEl('summary', { cls: 'tps-settings-main-summary' });
      summary.createEl('h3', { text: title });
      return details.createDiv({ cls: 'tps-settings-main-content' });
    };

    const featuresCategory = createMainCategory('Features');

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

    new Setting(featuresCategory)
      .setName("Render mode")
      .setDesc("Choose between the current floating overlay and a virtual inline embed rendered inside the note view.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("floating", "Floating overlay")
          .addOption("inline", "Inline virtual embed")
          .setValue(this.plugin.settings.renderMode)
          .onChange(async (value: "floating" | "inline") => {
            this.plugin.settings.renderMode = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.renderMode === "inline") {
      new Setting(featuresCategory)
        .setName("Inline placement")
        .setDesc("Choose where the inline embed is inserted in markdown notes.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("after-title", "After title")
            .addOption("after-content", "After content")
            .setValue(this.plugin.settings.inlinePlacement)
            .onChange(async (value: "after-title" | "after-content") => {
              this.plugin.settings.inlinePlacement = value;
              await this.plugin.saveSettings();
            })
        );
    }

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

    const rulesCategory = createMainCategory('Rules');
    rulesCategory.createEl("p", {
      text: "Define which bases to embed and under what conditions. Rules are evaluated in order; all matching rules will be embedded.",
      cls: "setting-item-description"
    });

    const rulesContainer = rulesCategory.createDiv({ cls: "tps-auto-base-embed-rules" });
    this.renderRules(rulesContainer);

    new Setting(rulesCategory)
      .setName("Add new rule")
      .addButton((button) =>
        button
          .setButtonText("+ Add Rule")
          .setCta()
          .onClick(() => {
            new BaseFileSuggestModal(this.app, async (file) => {
              const newRule: BaseEmbedRule = {
                id: `rule-${Date.now()}`,
                basePath: file.path,
                enabled: true,
                conditions: {},
              };
              this.plugin.settings.rules.push(newRule);
              this.expandedRules.add(newRule.id);
              await this.plugin.saveSettings();
              this.display();
            }).open();
          })
      );

    new Setting(containerEl)
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

    containerEl.createEl("p", {
      text: "Note: the Base is rendered using the current note as the source path, so filters like this.file.name resolve correctly.",
      cls: "setting-item-description",
    });
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
      pathEl.textContent = rule.basePath.split("/").pop() || rule.basePath;
      pathEl.title = rule.basePath;

      const summary = this.getConditionSummary(rule.conditions);
      if (summary) {
        const summaryEl = header.createDiv({ cls: "tps-auto-base-embed-rule-summary" });
        summaryEl.textContent = summary;
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
    new Setting(container)
      .setName("Base file")
      .addText((text) =>
        text
          .setValue(rule.basePath)
          .onChange(async (value) => {
            rule.basePath = value;
            await this.plugin.saveSettings();
          })
      )
      .addButton((btn) =>
        btn.setButtonText("Browse").onClick(() => {
          new BaseFileSuggestModal(this.app, async (file) => {
            rule.basePath = file.path;
            await this.plugin.saveSettings();
            this.display();
          }).open();
        })
      );

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

    this.renderListCondition(container, rule, "folders", "Include folders", "Only embed if note is in one of these folders", "Folder path (e.g., Projects/)");
    this.renderListCondition(container, rule, "excludeFolders", "Exclude folders", "Don't embed if note is in one of these folders", "Folder path");
    this.renderListCondition(container, rule, "tags", "Include tags", "Only embed if note has one of these tags", "Tag (e.g., project)");
    this.renderListCondition(container, rule, "excludeTags", "Exclude tags", "Don't embed if note has one of these tags", "Tag (e.g., archive)");
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

  private renderListCondition(
    container: HTMLElement,
    rule: BaseEmbedRule,
    key: "folders" | "excludeFolders" | "tags" | "excludeTags",
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
    if (conditions.tags?.length) {
      parts.push(`tags: ${conditions.tags.join(", ")}`);
    }
    if (conditions.excludeTags?.length) {
      parts.push(`not tags: ${conditions.excludeTags.join(", ")}`);
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
}
