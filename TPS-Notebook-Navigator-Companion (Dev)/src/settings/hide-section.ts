import { Menu, Setting, setIcon } from "obsidian";
import { HideRule, RuleCondition } from "../types";
import {
    createDefaultCondition,
    getConditionValuePlaceholder,
    normalizeConditionSource,
    normalizeRuleMatchMode,
    normalizeSmartOperator,
    SettingsSectionContext
} from "./ui-common";
import { getValidOperators } from "./operators";

let selectedRuleId: string | null = null;
let ruleFilterQuery = "";

export class HideSectionRenderer {
    private readonly context: SettingsSectionContext;

    constructor(context: SettingsSectionContext) {
        this.context = context;
    }

    render(container: HTMLElement): void {
        const { plugin, refresh, persistRuleChange } = this.context;
        const section = container.createDiv({ cls: "tps-nn-section" });

        section.createEl("h3", { text: "Hide Rules" });
        section.createEl("p", {
            cls: "setting-item-description",
            text: "Automatically add or remove specific tags (like '#hide') based on file criteria."
        });

        const toolbar = section.createDiv({ cls: "tps-nn-toolbar" });
        this.createActionButton(toolbar, "+ Add hide rule", async () => {
            const rule = plugin.createDefaultHideRule();
            plugin.settings.hideRules.push(rule);
            selectedRuleId = rule.id;
            await persistRuleChange(false);
            refresh();
        }, true);
        this.createActionButton(toolbar, "Apply active note", async () => {
            await plugin.applyRulesToActiveFile(true);
        });

        if (plugin.settings.hideRules.length === 0) {
            section.createEl("p", {
                cls: "setting-item-description",
                text: "No hide rules configured."
            });
            return;
        }

        const selected = this.getSelectedRule(plugin.settings.hideRules);
        if (!selected) {
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

        const visibleRules = plugin.settings.hideRules
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

    private renderRuleListItem(listPane: HTMLElement, rule: HideRule, index: number, activeId: string): void {
        const row = listPane.createEl("button", { cls: "tps-nn-list-item" });
        row.type = "button";
        if (rule.id === activeId) {
            row.addClass("is-active");
        }
        row.addEventListener("click", () => {
            selectedRuleId = rule.id;
            this.context.refresh();
        });

        const title = row.createDiv({ cls: "tps-nn-list-item-title", text: `${index + 1}. ${rule.name || "Untitled Rule"}` });
        if (!rule.enabled) {
            title.addClass("is-muted");
        }

        const actionText = rule.mode === "add" ? "Adds" : "Removes";
        const tagText = rule.tagName ? (rule.tagName.startsWith("#") ? rule.tagName : `#${rule.tagName}`) : "#???";

        row.createDiv({
            cls: "tps-nn-list-item-summary",
            text: `${actionText} ${tagText}`
        });

        row.createDiv({
            cls: "tps-nn-list-item-summary",
            text: rule.enabled ? "Enabled" : "Disabled"
        });
    }

    private renderRuleEditor(editorPane: HTMLElement, rule: HideRule, index: number): void {
        const { plugin, bindCommittedText, refresh, persistRuleChange } = this.context;
        const ruleId = rule.id;

        editorPane.createEl("h4", { text: `Editing Rule ${index + 1}` });

        const topBar = editorPane.createDiv({ cls: "tps-nn-toolbar" });
        this.createActionButton(topBar, "Previous", async () => {
            const previousIndex = Math.max(0, index - 1);
            const previous = plugin.settings.hideRules[previousIndex];
            if (!previous) {
                return;
            }
            selectedRuleId = previous.id;
            refresh();
        }, false, index === 0);
        this.createActionButton(topBar, "Next", async () => {
            const nextIndex = Math.min(plugin.settings.hideRules.length - 1, index + 1);
            const next = plugin.settings.hideRules[nextIndex];
            if (!next) {
                return;
            }
            selectedRuleId = next.id;
            refresh();
        }, false, index >= plugin.settings.hideRules.length - 1);
        this.createMenuButton(topBar, "Rule actions", (triggerEl) => {
            this.openRuleActionsMenu(triggerEl, ruleId, index);
        });

        new Setting(editorPane)
            .setName("Rule name")
            .setDesc("Descriptive name for this rule.")
            .addText((text) => {
                text.setPlaceholder("Hide archived notes");
                bindCommittedText(text, rule.name, async (value) => {
                    const live = this.getLiveRule(ruleId);
                    if (!live) {
                        return;
                    }
                    live.name = value.trim();
                }, true);
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

        new Setting(editorPane)
            .setName("Action mode")
            .setDesc("Whether to add or remove the tag when conditions match.")
            .addDropdown((dropdown) => {
                dropdown
                    .addOption("add", "Add tag")
                    .addOption("remove", "Remove tag")
                    .setValue(rule.mode)
                    .onChange(async (value) => {
                        const live = this.getLiveRule(ruleId);
                        if (!live) {
                            return;
                        }
                        live.mode = value as "add" | "remove";
                        await persistRuleChange(true);
                        refresh();
                    });
            });

        new Setting(editorPane)
            .setName("Tag name")
            .setDesc("The tag to add or remove (e.g. 'hide' or '#hide').")
            .addText((text) => {
                text.setPlaceholder("hide");
                bindCommittedText(text, rule.tagName, async (value) => {
                    const live = this.getLiveRule(ruleId);
                    if (!live) {
                        return;
                    }
                    // Remove leading # for storage, we handle it during application
                    live.tagName = value.trim().replace(/^#+/, "");
                }, false, true);
            });

        const criteriaPanel = editorPane.createEl("details", { cls: "tps-nn-sub-collapsible" });
        criteriaPanel.open = true;
        criteriaPanel.createEl("summary", { text: "Match Criteria" });
        const criteriaContent = criteriaPanel.createDiv({ cls: "tps-nn-sub-body" });

        this.renderConditionCriteria(criteriaContent, ruleId, rule);
    }

    private renderConditionCriteria(card: HTMLElement, ruleId: string, rule: HideRule): void {
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
                text: "No conditions configured (matches all files)."
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
                if (liveCondition.source !== "frontmatter") {
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

            if (condition.source === "frontmatter") {
                const fieldWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
                fieldWrap.createEl("label", { text: "Field" });
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
                        const rules = plugin.settings.hideRules;
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
                .setDisabled(index >= plugin.settings.hideRules.length - 1)
                .onClick(() => {
                    void (async () => {
                        if (index >= plugin.settings.hideRules.length - 1) return;
                        const rules = plugin.settings.hideRules;
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
                        const clone = plugin.createDefaultHideRule();
                        clone.name = live.name + " (Copy)";
                        clone.enabled = live.enabled;
                        clone.mode = live.mode;
                        clone.tagName = live.tagName;
                        clone.match = live.match;
                        clone.conditions = this.ensureRuleConditions(live).map((condition) => ({ ...condition }));
                        plugin.settings.hideRules.splice(index + 1, 0, clone);
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
                        plugin.settings.hideRules = plugin.settings.hideRules.filter((existing) => existing.id !== ruleId);
                        if (selectedRuleId === ruleId) {
                            selectedRuleId = plugin.settings.hideRules[0]?.id ?? null;
                        }
                        await persistRuleChange(false);
                        refresh();
                    })();
                });
        });

        this.showMenuBelowElement(menu, triggerEl);
    }

    private getSelectedRule(rules: HideRule[]): { id: string; rule: HideRule; index: number } | null {
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
        onOpen: (el: HTMLElement) => void
    ): HTMLButtonElement {
        const button = container.createEl("button", { cls: "clickable-icon" });
        button.type = "button";
        button.ariaLabel = label;
        setIcon(button, "more-horizontal");
        button.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            onOpen(button);
        });
        return button;
    }

    private showMenuBelowElement(menu: Menu, el: HTMLElement): void {
        const rect = el.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }

    private getLiveRule(id: string): HideRule | null {
        return this.context.plugin.settings.hideRules.find((rule) => rule.id === id) ?? null;
    }

    private ensureRuleConditions(rule: HideRule): RuleCondition[] {
        if (!rule.conditions) {
            rule.conditions = [];
        }
        return rule.conditions;
    }

    private matchesFilter(rule: HideRule, index: number, query: string): boolean {
        if (!query) {
            return true;
        }
        const target = `${index} ${rule.name} ${rule.tagName}`.toLowerCase();
        return target.includes(query);
    }
}
