import { Menu, setIcon, Setting } from "obsidian";
import { IconColorRule, RuleCondition } from "../types";
import {
  createDefaultCondition,
  getConditionValuePlaceholder,
  ICON_OPTIONS,
  isValidCssColor,
  normalizeConditionSource,
  normalizeIconIdForPreview,
  normalizeOperator,
  normalizeRuleMatchMode,
  normalizeSmartOperator,
  SettingsSectionContext,
  smartToSimpleOperator
} from "./ui-common";
import { getValidOperators } from "./operators";

let selectedRuleId: string | null = null;
let ruleFilterQuery = "";

const QUICK_COLORS = ["#4caf50", "#478fee", "#e49320", "#d34f56", "#8656ae", "#2f482e", "#a0a5b8", ""];

export class RulesSectionRenderer {
  private readonly context: SettingsSectionContext;

  constructor(context: SettingsSectionContext) {
    this.context = context;
  }

  render(container: HTMLElement): void {
    const { plugin, refresh, persistRuleChange } = this.context;
    const section = container.createDiv({ cls: "tps-nn-section" });

    section.createEl("h3", { text: "Rules" });
    section.createEl("p", {
      cls: "setting-item-description",
      text: "First match wins for icon/color. Use the left list to pick a rule; edit only one rule at a time."
    });

    const toolbar = section.createDiv({ cls: "tps-nn-toolbar" });
    this.createActionButton(toolbar, "+ Add rule", async () => {
      const rule = plugin.createDefaultRule();
      plugin.settings.rules.push(rule);
      selectedRuleId = rule.id;
      await persistRuleChange(false);
      refresh();
    }, true);
    this.createActionButton(toolbar, "Apply active note", async () => {
      await plugin.applyRulesToActiveFile(true);
    });
    this.createActionButton(toolbar, "Apply all notes", async () => {
      await plugin.applyRulesToAllFiles(true);
    });

    if (plugin.settings.rules.length === 0) {
      section.createEl("p", {
        cls: "setting-item-description",
        text: "No rules configured."
      });
      return;
    }

    const selected = this.getSelectedRule(plugin.settings.rules);
    if (!selected) {
      section.createEl("p", {
        cls: "setting-item-description",
        text: "No rule selected."
      });
      return;
    }

    const shell = section.createDiv({ cls: "tps-nn-split" });
    const listPane = shell.createDiv({ cls: "tps-nn-list-pane" });
    const editorPane = shell.createDiv({ cls: "tps-nn-editor-pane" });

    const filterRow = listPane.createDiv({ cls: "tps-nn-toolbar" });
    const filterInput = filterRow.createEl("input", {
      cls: "tps-nn-filter-input",
      attr: {
        type: "search",
        placeholder: "Filter rules..."
      }
    });
    filterInput.value = ruleFilterQuery;
    filterInput.addEventListener("input", () => {
      ruleFilterQuery = filterInput.value.trim().toLowerCase();
      refresh();
    });

    const visibleRules = plugin.settings.rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule, index }) => this.matchesFilter(rule, index + 1, ruleFilterQuery));

    if (visibleRules.length === 0) {
      listPane.createEl("p", {
        cls: "setting-item-description",
        text: "No rules match the current filter."
      });
    } else {
      visibleRules.forEach(({ rule, index }) => {
        this.renderRuleListItem(listPane, rule, index, selected.id);
      });
    }

    this.renderRuleEditor(editorPane, selected.rule, selected.index);
  }

  private renderRuleListItem(listPane: HTMLElement, rule: IconColorRule, index: number, activeId: string): void {
    const row = listPane.createEl("button", { cls: "tps-nn-list-item" });
    row.type = "button";
    if (rule.id === activeId) {
      row.addClass("is-active");
    }
    row.addEventListener("click", () => {
      selectedRuleId = rule.id;
      this.context.refresh();
    });

    const titleRow = row.createDiv({ cls: "tps-nn-list-item-title-row" });

    // Render icon preview in the pill with configured color (or gray fallback)
    const iconValue = String(rule.icon || "").trim();
    if (iconValue) {
      const iconSpan = titleRow.createSpan({ cls: "tps-nn-list-item-icon" });
      const iconId = normalizeIconIdForPreview(iconValue);
      if (iconId) {
        try {
          setIcon(iconSpan, iconId);
          const colorValue = String(rule.color || "").trim();
          iconSpan.style.color = colorValue && isValidCssColor(colorValue) ? colorValue : "var(--text-muted)";
        } catch {
          iconSpan.setText("?");
        }
      }
    }

    const displayName = String(rule.name || "").trim() || `Rule ${index + 1}`;
    const title = titleRow.createSpan({ cls: "tps-nn-list-item-title", text: displayName });
    if (!rule.enabled) {
      title.addClass("is-muted");
    }

    row.createDiv({
      cls: "tps-nn-list-item-summary",
      text: this.getRuleSummary(rule)
    });

    row.createDiv({
      cls: "tps-nn-list-item-summary",
      text: rule.enabled ? "Enabled" : "Disabled"
    });
  }

  private renderRuleEditor(editorPane: HTMLElement, rule: IconColorRule, index: number): void {
    const { plugin, bindCommittedText, refresh, persistRuleChange } = this.context;
    const ruleId = rule.id;

    const displayName = String(rule.name || "").trim() || `Rule ${index + 1}`;
    editorPane.createEl("h4", { text: `Editing: ${displayName}` });

    const topBar = editorPane.createDiv({ cls: "tps-nn-toolbar" });
    this.createActionButton(topBar, "Previous", async () => {
      const previousIndex = Math.max(0, index - 1);
      const previous = plugin.settings.rules[previousIndex];
      if (!previous) {
        return;
      }
      selectedRuleId = previous.id;
      refresh();
    }, false, index === 0);
    this.createActionButton(topBar, "Next", async () => {
      const nextIndex = Math.min(plugin.settings.rules.length - 1, index + 1);
      const next = plugin.settings.rules[nextIndex];
      if (!next) {
        return;
      }
      selectedRuleId = next.id;
      refresh();
    }, false, index >= plugin.settings.rules.length - 1);
    this.createMenuButton(topBar, "Rule actions", (triggerEl) => {
      this.openRuleActionsMenu(triggerEl, ruleId, index);
    });
    this.createMenuButton(topBar, "Icon presets", (triggerEl) => {
      this.openIconPresetMenu(triggerEl, ruleId);
    });
    this.createMenuButton(topBar, "Color presets", (triggerEl) => {
      this.openColorPresetMenu(triggerEl, ruleId);
    });

    const matchesActive = plugin.getRuleMatchForActiveFile(rule);
    editorPane.createEl("div", {
      cls: "tps-nn-callout",
      text:
        matchesActive == null
          ? "Active note preview unavailable."
          : `Active note preview: ${matchesActive ? "matches" : "does not match"}.`
    });

    new Setting(editorPane)
      .setName("Display name")
      .setDesc("Optional name shown in the rule list.")
      .addText((text) => {
        text.setPlaceholder("e.g. Working items");
        bindCommittedText(text, rule.name || "", async (value) => {
          const live = this.getLiveRule(ruleId);
          if (!live) {
            return;
          }
          live.name = value.trim();
        });
      });

    new Setting(editorPane)
      .setName("Enabled")
      .setDesc("Disable without deleting the rule.")
      .addToggle((toggle) => {
        toggle
          .setValue(rule.enabled)
          .onChange(async (value) => {
            const live = this.getLiveRule(ruleId);
            if (!live) {
              return;
            }
            live.enabled = value;
            await persistRuleChange(true);
            refresh();
          });
      });

    const usesConditionEditor = this.isConditionRule(rule);
    new Setting(editorPane)
      .setName("Rule editor mode")
      .setDesc("Simple mode is one check. Advanced mode supports mixed condition sources.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("simple", "Simple")
          .addOption("conditions", "Advanced conditions")
          .setValue(usesConditionEditor ? "conditions" : "simple")
          .onChange(async (value) => {
            const live = this.getLiveRule(ruleId);
            if (!live) {
              return;
            }
            if (value === "conditions") {
              this.convertRuleToConditionMode(live);
            } else {
              this.convertRuleToSimpleMode(live);
            }
            await persistRuleChange(false);
            refresh();
          });
      });

    const criteriaPanel = editorPane.createEl("details", { cls: "tps-nn-sub-collapsible" });
    criteriaPanel.open = true;
    criteriaPanel.createEl("summary", { text: "Match Criteria" });
    const criteriaContent = criteriaPanel.createDiv({ cls: "tps-nn-sub-body" });

    if (usesConditionEditor) {
      this.renderConditionCriteria(criteriaContent, ruleId, rule);
    } else {
      this.renderSimpleCriteria(criteriaContent, ruleId, rule);
    }

    const outputsPanel = editorPane.createEl("details", { cls: "tps-nn-sub-collapsible" });
    outputsPanel.open = true;
    outputsPanel.createEl("summary", { text: "Outputs" });
    const outputsContent = outputsPanel.createDiv({ cls: "tps-nn-sub-body" });

    const iconPreviewRow = outputsContent.createDiv({ cls: "setting-item-description" });
    iconPreviewRow.style.display = "flex";
    iconPreviewRow.style.alignItems = "center";
    iconPreviewRow.style.gap = "8px";
    const iconPreviewGlyph = iconPreviewRow.createSpan();
    iconPreviewGlyph.style.width = "18px";
    iconPreviewGlyph.style.height = "18px";
    iconPreviewGlyph.style.display = "inline-flex";
    iconPreviewGlyph.style.alignItems = "center";
    iconPreviewGlyph.style.justifyContent = "center";
    const iconPreviewText = iconPreviewRow.createSpan();

    const updateIconPreview = (rawIcon: string) => {
      const value = String(rawIcon || "").trim();
      iconPreviewGlyph.empty();
      if (!value) {
        iconPreviewGlyph.setText("—");
        iconPreviewText.setText("Icon preview: (none)");
        return;
      }
      const iconId = normalizeIconIdForPreview(value);
      if (!this.tryRenderIcon(iconPreviewGlyph, iconId)) {
        iconPreviewGlyph.setText("?");
      }
      iconPreviewText.setText(`Icon preview: ${value}`);
    };

    new Setting(outputsContent)
      .setName("Icon output")
      .setDesc("Choose from menu or type custom icon id.")
      .addDropdown((dropdown) => {
        const options = this.getIconOptions(rule.icon);
        for (const option of options) {
          dropdown.addOption(option.value, option.label);
        }
        dropdown
          .setValue(rule.icon || "")
          .onChange(async (value) => {
            const live = this.getLiveRule(ruleId);
            if (!live) {
              return;
            }
            live.icon = value.trim();
            updateIconPreview(live.icon);
            await persistRuleChange(true);
            refresh();
          });
      })
      .addText((text) => {
        text.setPlaceholder("custom (e.g. lucide:check-square-2)");
        bindCommittedText(text, rule.icon, async (value) => {
          const live = this.getLiveRule(ruleId);
          if (!live) {
            return;
          }
          live.icon = value.trim();
        }, false, true);
        text.inputEl.addEventListener("input", (event) => {
          const next = (event.target as HTMLInputElement | null)?.value ?? "";
          updateIconPreview(next);
        });
      });
    updateIconPreview(rule.icon);

    const colorPreviewRow = outputsContent.createDiv({ cls: "setting-item-description" });
    colorPreviewRow.style.display = "flex";
    colorPreviewRow.style.alignItems = "center";
    colorPreviewRow.style.gap = "8px";
    const colorSwatch = colorPreviewRow.createSpan();
    colorSwatch.style.width = "14px";
    colorSwatch.style.height = "14px";
    colorSwatch.style.borderRadius = "3px";
    colorSwatch.style.border = "1px solid var(--background-modifier-border)";
    const colorSample = colorPreviewRow.createSpan({ text: "Aa" });
    colorSample.style.fontWeight = "700";
    const colorPreviewText = colorPreviewRow.createSpan();

    const updateColorPreview = (rawColor: string) => {
      const color = String(rawColor || "").trim();
      if (!color) {
        colorSwatch.style.backgroundColor = "transparent";
        colorSample.style.color = "var(--text-normal)";
        colorPreviewText.setText("Color preview: (none)");
        return;
      }
      if (!isValidCssColor(color)) {
        colorSwatch.style.backgroundColor = "transparent";
        colorSample.style.color = "var(--text-normal)";
        colorPreviewText.setText(`Color preview: ${color} (invalid)`);
        return;
      }
      colorSwatch.style.backgroundColor = color;
      colorSample.style.color = color;
      colorPreviewText.setText(`Color preview: ${color}`);
    };

    new Setting(outputsContent)
      .setName("Color output")
      .setDesc("Pick with color picker or type any CSS color value.")
      .addColorPicker((picker) => {
        const initialPickerColor = this.toColorPickerValue(rule.color) ?? "#4caf50";
        picker
          .setValue(initialPickerColor)
          .onChange(async (value) => {
            const live = this.getLiveRule(ruleId);
            if (!live) {
              return;
            }
            live.color = value.trim();
            updateColorPreview(live.color);
            await persistRuleChange(true);
          });
      })
      .addText((text) => {
        text.setPlaceholder("#4caf50 or var(--color-green)");
        bindCommittedText(text, rule.color, async (value) => {
          const live = this.getLiveRule(ruleId);
          if (!live) {
            return;
          }
          live.color = value.trim();
          const pickerColor = this.toColorPickerValue(live.color);
          if (pickerColor) {
            // Keep picker in sync when user types a hex value.
            const pickerEl = text.inputEl.closest(".setting-item-control")?.querySelector<HTMLInputElement>("input[type='color']");
            if (pickerEl) {
              pickerEl.value = pickerColor;
            }
          }
        }, false, true);
        text.inputEl.addEventListener("input", (event) => {
          const next = (event.target as HTMLInputElement | null)?.value ?? "";
          updateColorPreview(next);
        });
      });
    updateColorPreview(rule.color);
  }

  private renderSimpleCriteria(card: HTMLElement, ruleId: string, rule: IconColorRule): void {
    const { bindCommittedText, persistRuleChange } = this.context;

    new Setting(card)
      .setName("Frontmatter property")
      .setDesc("Example: status, priority, folderPath.")
      .addText((text) => {
        text.setPlaceholder("status");
        bindCommittedText(text, rule.property, async (value) => {
          const live = this.getLiveRule(ruleId);
          if (!live) {
            return;
          }
          live.property = value.trim();
        });
      });

    new Setting(card)
      .setName("Operator")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("is", "is")
          .addOption("!is", "is not")
          .addOption("contains", "contains")
          .addOption("!contains", "does not contain")
          .addOption("exists", "exists")
          .addOption("!exists", "not exists")
          .setValue(rule.operator)
          .onChange(async (value) => {
            const live = this.getLiveRule(ruleId);
            if (!live) {
              return;
            }
            live.operator = normalizeOperator(value);
            await persistRuleChange(true);
          });
      });

    new Setting(card)
      .setName("Match value")
      .addText((text) => {
        text.setPlaceholder("complete");
        bindCommittedText(text, rule.value, async (value) => {
          const live = this.getLiveRule(ruleId);
          if (!live) {
            return;
          }
          live.value = value;
        });
      });

    new Setting(card)
      .setName("Path prefix (optional)")
      .setDesc("Only evaluate notes under this folder path prefix.")
      .addText((text) => {
        text.setPlaceholder("01 Action Items");
        bindCommittedText(text, rule.pathPrefix, async (value) => {
          const live = this.getLiveRule(ruleId);
          if (!live) {
            return;
          }
          live.pathPrefix = value;
        });
      });
  }

  private renderConditionCriteria(card: HTMLElement, ruleId: string, rule: IconColorRule): void {
    const { persistRuleChange, refresh } = this.context;
    const conditions = this.ensureRuleConditions(rule);
    rule.match = normalizeRuleMatchMode(rule.match);

    new Setting(card)
      .setName("Match mode")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("all", "All conditions")
          .addOption("any", "Any condition")
          .setValue(rule.match)
          .onChange(async (value) => {
            const live = this.getLiveRule(ruleId);
            if (!live) {
              return;
            }
            live.match = normalizeRuleMatchMode(value);
            await persistRuleChange(true);
          });
      });

    if (conditions.length === 0) {
      card.createEl("p", {
        cls: "setting-item-description",
        text: "No conditions configured yet."
      });
    }

    conditions.forEach((condition, conditionIndex) => {
      const conditionCard = card.createDiv({ cls: "tps-nn-condition-card" });
      const grid = conditionCard.createDiv({ cls: "tps-nn-condition-grid" });

      const sourceWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
      sourceWrap.createEl("label", { text: "Source" });
      const sourceSelect = sourceWrap.createEl("select");
      for (const source of ["frontmatter", "path", "extension", "name", "tag", "body", "backlink"]) {
        sourceSelect.createEl("option", { value: source, text: source });
      }
      sourceSelect.value = condition.source;
      sourceSelect.addEventListener("change", () => {
        const live = this.getLiveRule(ruleId);
        if (!live) {
          return;
        }
        const liveCondition = this.ensureRuleConditions(live)[conditionIndex];
        if (!liveCondition) {
          return;
        }
        liveCondition.source = normalizeConditionSource(sourceSelect.value);
        liveCondition.source = normalizeConditionSource(sourceSelect.value);
        if (liveCondition.source !== "frontmatter" && liveCondition.source !== "backlink") {
          liveCondition.field = "";
        }
        void persistRuleChange(false).then(() => refresh());
      });

      const operatorWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
      operatorWrap.createEl("label", { text: "Operator" });
      const operatorSelect = operatorWrap.createEl("select");
      for (const operator of getValidOperators(condition.source)) {
        operatorSelect.createEl("option", { value: operator, text: operator });
      }
      operatorSelect.value = condition.operator;
      operatorSelect.addEventListener("change", () => {
        const live = this.getLiveRule(ruleId);
        if (!live) {
          return;
        }
        const liveCondition = this.ensureRuleConditions(live)[conditionIndex];
        if (!liveCondition) {
          return;
        }
        const newOp = normalizeSmartOperator(operatorSelect.value);
        liveCondition.operator = newOp;

        // Clear value if operator is unary
        if (
          newOp === "exists" ||
          newOp === "!exists" ||
          newOp === "is-not-empty" ||
          newOp === "has-open-checkboxes" ||
          newOp === "!has-open-checkboxes" ||
          newOp === "is-today" ||
          newOp === "!is-today"
        ) {
          liveCondition.value = "";
        }

        void persistRuleChange(true).then(() => refresh());
      });

      if (condition.source === "frontmatter" || condition.source === "backlink") {
        const fieldWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
        fieldWrap.createEl("label", { text: "Field (Key)" });
        const fieldInput = fieldWrap.createEl("input", {
          attr: {
            type: "text",
            placeholder: "status"
          }
        });
        fieldInput.value = String(condition.field || "");
        fieldInput.addEventListener("blur", () => {
          const live = this.getLiveRule(ruleId);
          if (!live) {
            return;
          }
          const liveCondition = this.ensureRuleConditions(live)[conditionIndex];
          if (!liveCondition) {
            return;
          }
          liveCondition.field = fieldInput.value.trim();
          void persistRuleChange(false);
        });
      }

      const isUnary =
        condition.operator === "exists" ||
        condition.operator === "!exists" ||
        condition.operator === "is-not-empty" ||
        condition.operator === "has-open-checkboxes" ||
        condition.operator === "!has-open-checkboxes" ||
        condition.operator === "is-today" ||
        condition.operator === "!is-today";

      if (!isUnary) {
        const valueWrap = grid.createDiv({ cls: "tps-nn-condition-field tps-nn-condition-field-value" });
        valueWrap.createEl("label", { text: "Value" });
        const valueInput = valueWrap.createEl("input", {
          attr: {
            type: "text",
            placeholder: getConditionValuePlaceholder(condition)
          }
        });
        valueInput.value = String(condition.value || "");
        valueInput.addEventListener("blur", () => {
          const live = this.getLiveRule(ruleId);
          if (!live) {
            return;
          }
          const liveCondition = this.ensureRuleConditions(live)[conditionIndex];
          if (!liveCondition) {
            return;
          }
          liveCondition.value = valueInput.value;
          void persistRuleChange(false);
        });
      }

      const deleteWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
      const deleteButton = deleteWrap.createEl("button", { text: "✕", cls: "tps-nn-compact-btn mod-warning" });
      deleteButton.type = "button";
      deleteButton.style.minHeight = "30px";
      deleteButton.style.padding = "0 8px";
      deleteButton.addEventListener("click", () => {
        const live = this.getLiveRule(ruleId);
        if (!live) {
          return;
        }
        live.conditions = this.ensureRuleConditions(live).filter((_, idx) => idx !== conditionIndex);
        void persistRuleChange(false).then(() => refresh());
      });
    });

    new Setting(card)
      .setName("Add condition")
      .addButton((button) => {
        button
          .setButtonText("+ Add condition")
          .onClick(async () => {
            const live = this.getLiveRule(ruleId);
            if (!live) {
              return;
            }
            this.ensureRuleConditions(live).push(createDefaultCondition());
            await persistRuleChange(false);
            refresh();
          });
      });
  }

  private openRuleActionsMenu(triggerEl: HTMLElement, ruleId: string, index: number): void {
    const { plugin, refresh, persistRuleChange } = this.context;
    const rule = this.getLiveRule(ruleId);
    if (!rule) {
      return;
    }
    const menu = new Menu();

    menu.addItem((item) => {
      item
        .setTitle(rule.enabled ? "Disable rule" : "Enable rule")
        .setIcon(rule.enabled ? "toggle-right" : "toggle-left")
        .onClick(() => {
          void (async () => {
            const live = this.getLiveRule(ruleId);
            if (!live) {
              return;
            }
            live.enabled = !live.enabled;
            await persistRuleChange(true);
            refresh();
          })();
        });
    });
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("Move up")
        .setIcon("arrow-up")
        .setDisabled(index === 0)
        .onClick(() => {
          void (async () => {
            if (index === 0) return;
            const rules = plugin.settings.rules;
            [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]];
            await persistRuleChange(false);
            refresh();
          })();
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("Move down")
        .setIcon("arrow-down")
        .setDisabled(index >= plugin.settings.rules.length - 1)
        .onClick(() => {
          void (async () => {
            if (index >= plugin.settings.rules.length - 1) return;
            const rules = plugin.settings.rules;
            [rules[index + 1], rules[index]] = [rules[index], rules[index + 1]];
            await persistRuleChange(false);
            refresh();
          })();
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("Duplicate")
        .setIcon("copy")
        .onClick(() => {
          void (async () => {
            const live = this.getLiveRule(ruleId);
            if (!live) {
              return;
            }
            const clone = plugin.createDefaultRule();
            clone.name = live.name ? `${live.name} (copy)` : "";
            clone.enabled = live.enabled;
            clone.property = live.property;
            clone.operator = live.operator;
            clone.value = live.value;
            clone.pathPrefix = live.pathPrefix;
            clone.icon = live.icon;
            clone.color = live.color;
            clone.match = live.match;
            clone.conditions = this.ensureRuleConditions(live).map((condition) => ({ ...condition }));
            plugin.settings.rules.splice(index + 1, 0, clone);
            selectedRuleId = clone.id;
            await persistRuleChange(false);
            refresh();
          })();
        });
    });
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle("Delete")
        .setIcon("trash")
        .onClick(() => {
          void (async () => {
            plugin.settings.rules = plugin.settings.rules.filter((existing) => existing.id !== ruleId);
            if (selectedRuleId === ruleId) {
              selectedRuleId = plugin.settings.rules[0]?.id ?? null;
            }
            await persistRuleChange(false);
            refresh();
          })();
        });
    });

    this.showMenuBelowElement(menu, triggerEl);
  }

  private openIconPresetMenu(triggerEl: HTMLElement, ruleId: string): void {
    const { persistRuleChange, refresh } = this.context;
    const rule = this.getLiveRule(ruleId);
    if (!rule) {
      return;
    }
    const menu = new Menu();
    const options = this.getIconOptions(rule.icon);
    for (const option of options) {
      menu.addItem((item) => {
        item.setTitle(option.label);
        const iconId = normalizeIconIdForPreview(option.value);
        if (iconId) {
          try {
            item.setIcon(iconId);
          } catch {
            // ignore invalid icon for menu rendering
          }
        }
        item.onClick(() => {
          void (async () => {
            const live = this.getLiveRule(ruleId);
            if (!live) {
              return;
            }
            live.icon = option.value.trim();
            await persistRuleChange(true);
            refresh();
          })();
        });
      });
    }
    this.showMenuBelowElement(menu, triggerEl);
  }

  private openColorPresetMenu(triggerEl: HTMLElement, ruleId: string): void {
    const { persistRuleChange, refresh } = this.context;
    const rule = this.getLiveRule(ruleId);
    if (!rule) {
      return;
    }
    const menu = new Menu();
    for (const color of QUICK_COLORS) {
      menu.addItem((item) => {
        item.setTitle(color || "(clear color)");
        item.onClick(() => {
          void (async () => {
            const live = this.getLiveRule(ruleId);
            if (!live) {
              return;
            }
            live.color = color;
            await persistRuleChange(true);
            refresh();
          })();
        });
      });
    }
    this.showMenuBelowElement(menu, triggerEl);
  }

  private getSelectedRule(rules: IconColorRule[]): { id: string; rule: IconColorRule; index: number } | null {
    if (rules.length === 0) {
      selectedRuleId = null;
      return null;
    }
    if (!selectedRuleId || !rules.some((rule) => rule.id === selectedRuleId)) {
      selectedRuleId = rules[0].id;
    }
    const index = rules.findIndex((rule) => rule.id === selectedRuleId);
    if (index < 0) {
      return null;
    }
    return {
      id: selectedRuleId,
      rule: rules[index],
      index
    };
  }

  private createActionButton(
    container: HTMLElement,
    label: string,
    onClick: () => Promise<void>,
    isPrimary = false,
    isDisabled = false
  ): HTMLButtonElement {
    const button = container.createEl("button", { text: label });
    button.type = "button";
    button.disabled = isDisabled;
    if (isPrimary) {
      button.addClass("mod-cta");
    }
    button.addEventListener("click", () => {
      void onClick();
    });
    return button;
  }

  private createMenuButton(
    container: HTMLElement,
    label: string,
    onOpen: (triggerEl: HTMLElement) => void,
    stopPropagation = false
  ): HTMLButtonElement {
    const button = container.createEl("button", { text: label });
    button.type = "button";
    button.addEventListener("click", (event) => {
      if (stopPropagation) {
        event.preventDefault();
        event.stopPropagation();
      }
      onOpen(button);
    });
    return button;
  }

  private createBadge(container: HTMLElement, text: string): void {
    container.createSpan({
      cls: "tps-nn-badge",
      text
    });
  }

  private showMenuBelowElement(menu: Menu, triggerEl: HTMLElement): void {
    const rect = triggerEl.getBoundingClientRect();
    menu.showAtPosition({
      x: rect.left,
      y: rect.bottom + 4
    });
  }

  private getLiveRule(ruleId: string): IconColorRule | null {
    return this.context.plugin.settings.rules.find((rule) => rule.id === ruleId) ?? null;
  }

  private isConditionRule(rule: IconColorRule): boolean {
    return Array.isArray(rule.conditions) && rule.conditions.length > 0;
  }

  private ensureRuleConditions(rule: IconColorRule): RuleCondition[] {
    if (!Array.isArray(rule.conditions)) {
      rule.conditions = [];
    }
    return rule.conditions;
  }

  private convertRuleToConditionMode(rule: IconColorRule): void {
    if (this.isConditionRule(rule)) {
      rule.match = normalizeRuleMatchMode(rule.match);
      return;
    }
    const nextConditions: RuleCondition[] = [];
    const property = String(rule.property || "").trim();
    if (property) {
      nextConditions.push({
        source: "frontmatter",
        field: property,
        operator: normalizeSmartOperator(rule.operator),
        value: String(rule.value || "")
      });
    }
    const pathPrefix = String(rule.pathPrefix || "").trim();
    if (pathPrefix) {
      nextConditions.push({
        source: "path",
        field: "",
        operator: "starts",
        value: pathPrefix
      });
    }
    if (nextConditions.length === 0) {
      nextConditions.push(createDefaultCondition());
    }
    rule.conditions = nextConditions;
    rule.match = normalizeRuleMatchMode(rule.match);
  }

  private convertRuleToSimpleMode(rule: IconColorRule): void {
    const conditions = this.ensureRuleConditions(rule);
    const frontmatterCondition = conditions.find(
      (condition) => condition.source === "frontmatter" && String(condition.field || "").trim().length > 0
    );
    if (frontmatterCondition) {
      rule.property = String(frontmatterCondition.field || "").trim();
      rule.operator = smartToSimpleOperator(frontmatterCondition.operator);
      rule.value = String(frontmatterCondition.value || "");
    }
    const pathCondition = conditions.find(
      (condition) =>
        condition.source === "path" &&
        (condition.operator === "starts" || condition.operator === "is" || condition.operator === "contains") &&
        String(condition.value || "").trim().length > 0
    );
    if (pathCondition) {
      rule.pathPrefix = String(pathCondition.value || "").trim();
    }
    rule.conditions = [];
    rule.match = "all";
  }

  private getIconOptions(currentIcon: string): Array<{ value: string; label: string }> {
    const { plugin } = this.context;
    const options = new Map<string, string>();

    for (const option of ICON_OPTIONS) {
      options.set(option.value, option.label);
    }
    for (const rule of plugin.settings.rules) {
      const icon = String(rule.icon || "").trim();
      if (icon && !options.has(icon)) {
        options.set(icon, `${icon} (custom)`);
      }
    }
    const current = String(currentIcon || "").trim();
    if (current && !options.has(current)) {
      options.set(current, `${current} (current)`);
    }

    return Array.from(options.entries())
      .sort((a, b) => {
        if (a[0] === "") return -1;
        if (b[0] === "") return 1;
        return a[0].localeCompare(b[0]);
      })
      .map(([value, label]) => ({ value, label }));
  }

  private tryRenderIcon(container: HTMLElement, iconId: string): boolean {
    const id = String(iconId || "").trim();
    if (!id) {
      return false;
    }
    try {
      setIcon(container, id);
      return true;
    } catch {
      return false;
    }
  }

  private toColorPickerValue(rawColor: string): string | null {
    const color = String(rawColor || "").trim();
    if (!color) {
      return null;
    }

    const match = color.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
    if (!match) {
      return null;
    }

    const hex = match[1].toLowerCase();
    if (hex.length === 3) {
      return `#${hex.split("").map((char) => `${char}${char}`).join("")}`;
    }
    if (hex.length === 8) {
      return `#${hex.slice(0, 6)}`;
    }
    return `#${hex}`;
  }

  private getRuleSummary(rule: IconColorRule): string {
    if (this.isConditionRule(rule)) {
      const conditions = this.ensureRuleConditions(rule);
      return `${conditions.length} conditions (${rule.match})`;
    }

    const property = String(rule.property || "").trim() || "(property)";
    return `simple: ${property} ${rule.operator}`;
  }

  private matchesFilter(rule: IconColorRule, ruleNumber: number, rawQuery: string): boolean {
    const query = String(rawQuery || "").trim().toLowerCase();
    if (!query) {
      return true;
    }

    const haystack = [
      `rule ${ruleNumber}`,
      this.getRuleSummary(rule),
      rule.enabled ? "enabled" : "disabled",
      this.isConditionRule(rule) ? "advanced" : "simple",
      String(rule.icon || ""),
      String(rule.color || "")
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(query);
  }
}
