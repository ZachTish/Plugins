
import { App, Modal, Setting, setIcon, Notice } from "obsidian";
import { CalendarStyleRule, CalendarStyleCondition, CalendarField, CalendarOperator, CalendarStyleMatch } from "./types";

type StyleBuilderMode = "color" | "text" | "both";

export class CalendarStyleBuilderModal extends Modal {
    private rule: CalendarStyleRule;
    private onSave: (rule: CalendarStyleRule) => void;
    private container: HTMLElement;
    private mode: StyleBuilderMode;
    private activeTab: StyleBuilderMode;

    constructor(
        app: App,
        rule: CalendarStyleRule,
        onSave: (rule: CalendarStyleRule) => void,
        opts: { mode?: StyleBuilderMode } = {},
    ) {
        super(app);
        this.rule = JSON.parse(JSON.stringify(rule)); // Deep copy
        this.onSave = onSave;
        this.mode = opts.mode || "both";
        this.activeTab = this.mode === "text" ? "text" : "color";
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("calendar-style-builder-modal");

        // Add some basic CSS for the modal if not present
        this.addStyles();

        this.titleEl.setText(`Edit Rule: ${this.rule.label}`);

        this.container = contentEl.createDiv({ cls: "calendar-builder-container" });
        this.render();
    }

    private addStyles() {
        // Inject styling dynamically to ensure it matches the requested aesthetic
        const styleId = "calendar-builder-styles";
        if (!document.getElementById(styleId)) {
            const style = document.createElement("style");
            style.id = styleId;
            style.textContent = `
            .calendar-builder-container {
                display: flex;
                flex-direction: column;
                gap: 20px;
                padding-bottom: 20px;
            }
            .calendar-builder-section {
                border: 1px solid var(--background-modifier-border);
                border-radius: 8px;
                padding: 16px;
                background-color: var(--background-primary);
            }
            .calendar-builder-section-title {
                font-weight: 600;
                margin-bottom: 12px;
                color: var(--text-muted);
                text-transform: uppercase;
                font-size: 0.75em;
                letter-spacing: 0.05em;
            }
            .calendar-condition-row {
                display: flex;
                gap: 8px;
                align-items: center;
                margin-bottom: 8px;
                background: var(--background-secondary);
                padding: 8px;
                border-radius: 6px;
                border: 1px solid var(--background-modifier-border);
            }
            .calendar-condition-row select,
            .calendar-condition-row input {
                background: var(--background-primary);
            }
            .calendar-visual-preview {
                height: 40px;
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: bold;
                margin-top: 10px;
                border: 1px solid var(--background-modifier-border);
            }
            .calendar-style-toggles {
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
            }
            .calendar-style-btn {
                padding: 6px 12px;
                border-radius: 4px;
                border: 1px solid var(--background-modifier-border);
                cursor: pointer;
                background: var(--background-primary);
                transition: all 0.2s ease;
            }
            .calendar-style-btn:hover {
                background: var(--background-modifier-hover);
            }
            .calendar-style-btn.is-active {
                background: var(--interactive-accent);
                color: var(--text-on-accent);
                border-color: var(--interactive-accent);
            }
        `;
            document.head.appendChild(style);
        }
    }

    private render() {
        this.container.empty();

        // --- General Info Section ---
        const generalSection = this.container.createDiv({ cls: "calendar-builder-section" });
        generalSection.createDiv({ cls: "calendar-builder-section-title", text: "General" });

        new Setting(generalSection)
            .setName("Rule Label")
            .addText(text => text
                .setValue(this.rule.label)
                .setPlaceholder("e.g. High Priority")
                .onChange(v => {
                    this.rule.label = v;
                    this.titleEl.setText(`Edit Rule: ${v}`);
                }));

        new Setting(generalSection)
            .setName("Active")
            .addToggle(toggle => toggle
                .setValue(this.rule.active !== false)
                .onChange(v => this.rule.active = v));

        // --- Conditions Section ---
        const conditionsSection = this.container.createDiv({ cls: "calendar-builder-section" });
        conditionsSection.createDiv({ cls: "calendar-builder-section-title", text: "Conditions" });

        const logicRow = conditionsSection.createDiv({ cls: "calendar-condition-logic" });
        logicRow.style.marginBottom = "10px";
        logicRow.createSpan({ text: "Match " });
        const matchSelect = logicRow.createEl("select", { cls: "dropdown" });
        ["all", "any"].forEach(opt => {
            const o = matchSelect.createEl("option", { value: opt, text: opt });
            if (this.rule.match === opt) o.selected = true;
        });
        matchSelect.addEventListener("change", () => {
            this.rule.match = matchSelect.value as CalendarStyleMatch;
        });
        logicRow.createSpan({ text: " of the following:" });

        const conditionsList = conditionsSection.createDiv();
        this.renderConditions(conditionsList);

        const addBtn = conditionsSection.createEl("button", { text: "+ Add Condition", cls: "mod-cta" });
        addBtn.style.marginTop = "10px";
        addBtn.addEventListener("click", () => {
            this.rule.conditions.push({ field: "status", operator: "is", value: "" });
            this.renderConditions(conditionsList);
        });

        // --- Visuals Section ---
        const visualsSection = this.container.createDiv({ cls: "calendar-builder-section" });
        visualsSection.createDiv({ cls: "calendar-builder-section-title", text: "Visual Style" });

        const allowColor = this.mode !== "text";
        const allowText = this.mode !== "color";

        if (allowColor && allowText) {
            const tabContainer = visualsSection.createDiv();
            tabContainer.style.display = "flex";
            tabContainer.style.gap = "0";
            tabContainer.style.marginBottom = "12px";
            tabContainer.style.borderBottom = "1px solid var(--background-modifier-border)";

            const tabs: { id: StyleBuilderMode; label: string }[] = [
                { id: "color", label: "Color" },
                { id: "text", label: "Text" },
            ];
            tabs.forEach((tab) => {
                const isActive = this.activeTab === tab.id;
                const tabEl = tabContainer.createDiv({ text: tab.label });
                tabEl.style.padding = "8px 14px";
                tabEl.style.cursor = "pointer";
                tabEl.style.fontWeight = isActive ? "600" : "500";
                tabEl.style.color = isActive ? "var(--text-normal)" : "var(--text-muted)";
                tabEl.style.borderBottom = isActive ? "2px solid var(--interactive-accent)" : "2px solid transparent";
                tabEl.addEventListener("click", () => {
                    if (this.activeTab === tab.id) return;
                    this.activeTab = tab.id;
                    this.render();
                });
            });
        }

        const showColor = allowColor && this.activeTab === "color";
        const showText = allowText && this.activeTab === "text";

        if (showColor) {
            new Setting(visualsSection)
                .setName("Background Color")
                .addColorPicker(picker => picker
                    .setValue(this.rule.color || "#ffffff")
                    .onChange(v => {
                        this.rule.color = v;
                        this.updatePreview(previewBox);
                    }));
        } else if (!allowColor) {
            this.rule.color = "";
        }

        let currentStyles = new Set(
            (this.rule.textStyle || "")
                .split(",")
                .map(s => s.trim().toLowerCase())
                .filter(Boolean),
        );

        if (showText) {
            const styleContainer = visualsSection.createDiv();
            styleContainer.style.marginBottom = "15px";
            styleContainer.createDiv({ text: "Text Styles:", attr: { style: "margin-bottom: 8px; font-weight: 500;" } });

            const toggles = styleContainer.createDiv({ cls: "calendar-style-toggles" });
            const styles = [
                { id: "bold", label: "Bold" },
                { id: "italic", label: "Italic" },
                { id: "strikethrough", label: "Strike" },
                { id: "line-through", label: "Line-through" },
                { id: "underline", label: "Underline" }
            ];

            styles.forEach(s => {
                const btn = toggles.createDiv({ cls: `calendar-style-btn ${currentStyles.has(s.id) ? 'is-active' : ''}`, text: s.label });
                btn.addEventListener("click", () => {
                    if (currentStyles.has(s.id)) currentStyles.delete(s.id);
                    else currentStyles.add(s.id);

                    this.rule.textStyle = Array.from(currentStyles).join(", ");
                    if (currentStyles.has(s.id)) btn.classList.add("is-active");
                    else btn.classList.remove("is-active");
                    this.updatePreview(previewBox);
                });
            });

            new Setting(visualsSection)
                .setName("Custom CSS Classes")
                .setDesc("Comma separated")
                .addText(text => text
                    .setValue(Array.from(currentStyles).filter(s => !styles.find(st => st.id === s)).join(", "))
                    .onChange(v => {
                        const customs = v.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
                        const presetIds = new Set(styles.map(s => s.id));
                        const newSet = new Set(Array.from(currentStyles).filter(s => presetIds.has(s)));
                        customs.forEach(c => newSet.add(c));
                        currentStyles.clear();
                        newSet.forEach(s => currentStyles.add(s));
                        this.rule.textStyle = Array.from(currentStyles).join(", ");
                        this.updatePreview(previewBox);
                    }));
        } else if (!allowText) {
            this.rule.textStyle = "";
        }

        // Live Preview
        visualsSection.createDiv({ text: "Preview:", attr: { style: "margin-top: 10px; font-weight: 500;" } });
        const previewBox = visualsSection.createDiv({ cls: "calendar-visual-preview", text: "Event Title" });
        this.updatePreview(previewBox);

        // --- Footer Buttons ---
        const footer = this.container.createDiv();
        footer.style.display = "flex";
        footer.style.justifyContent = "flex-end";
        footer.style.gap = "10px";
        footer.style.marginTop = "20px";

        const cancelBtn = footer.createEl("button", { text: "Cancel" });
        cancelBtn.addEventListener("click", () => this.close());

        const saveBtn = footer.createEl("button", { text: "Save Rule", cls: "mod-cta" });
        saveBtn.addEventListener("click", () => {
            // Ensure mode constraints before save
            if (this.mode === "color") this.rule.textStyle = "";
            if (this.mode === "text") this.rule.color = "";
            this.onSave(this.rule);
            this.close();
        });
    }

    private renderConditions(container: HTMLElement) {
        container.empty();
        this.rule.conditions.forEach((cond, idx) => {
            const row = container.createDiv({ cls: "calendar-condition-row" });

            // Field Wrapper
            const fieldContainer = row.createDiv({ cls: "calendar-condition-field-group" });
            fieldContainer.style.display = "flex";
            fieldContainer.style.gap = "8px";
            fieldContainer.style.alignItems = "center";

            // Field Select
            const fieldSelect = fieldContainer.createEl("select", { cls: "dropdown" });
            const isCustom = !["status", "priority"].includes(cond.field);

            ["status", "priority", "custom"].forEach(f => {
                const text = f === "custom" ? "Property" : f.charAt(0).toUpperCase() + f.slice(1);
                const opt = fieldSelect.createEl("option", { value: f, text: text });
                if (f === "custom" ? isCustom : cond.field === f) opt.selected = true;
            });

            fieldSelect.addEventListener("change", () => {
                const val = fieldSelect.value;
                if (val === "custom") {
                    if (["status", "priority"].includes(cond.field)) {
                        cond.field = ""; // Reset if switching from preset
                    }
                    this.renderConditions(container);
                } else {
                    cond.field = val as CalendarField;
                    this.renderConditions(container);
                }
            });

            // Custom Field Input
            if (isCustom) {
                const customInput = fieldContainer.createEl("input", { type: "text", cls: "condition-custom-field" });
                customInput.value = cond.field;
                customInput.placeholder = "Property name";
                customInput.style.width = "120px";
                customInput.addEventListener("change", () => {
                    cond.field = customInput.value;
                });
            }

            // Operator
            const operatorSelect = row.createEl("select", { cls: "dropdown" });
            const ops: { v: CalendarOperator, l: string }[] = [
                { v: "is", l: "is" }, { v: "!is", l: "is not" },
                { v: "contains", l: "contains" }, { v: "!contains", l: "does not contain" },
                { v: "starts", l: "starts with" }, { v: "exists", l: "exists" }, { v: "!exists", l: "is missing" }
            ];
            ops.forEach(op => {
                const opt = operatorSelect.createEl("option", { value: op.v, text: op.l });
                if (cond.operator === op.v) opt.selected = true;
            });
            operatorSelect.addEventListener("change", () => {
                cond.operator = operatorSelect.value as CalendarOperator;
                this.renderConditions(container); // Re-render to update input state
            });

            // Value
            const valueInput = row.createEl("input", { type: "text", cls: "condition-value" });
            valueInput.value = cond.value || "";
            valueInput.placeholder = "Value";
            valueInput.style.flex = "1";
            valueInput.disabled = ["exists", "!exists"].includes(cond.operator);
            valueInput.addEventListener("change", () => cond.value = valueInput.value);

            // Remove
            const removeBtn = row.createEl("button", { cls: "explorer2-icon-button" });
            removeBtn.innerHTML = "×";
            removeBtn.style.color = "var(--text-muted)";
            removeBtn.style.cursor = "pointer";
            removeBtn.style.border = "none";
            removeBtn.style.background = "transparent";
            removeBtn.style.fontSize = "18px";
            removeBtn.addEventListener("click", () => {
                this.rule.conditions.splice(idx, 1);
                this.renderConditions(container);
            });
        });
    }

    private updatePreview(el: HTMLElement) {
        el.style.backgroundColor = this.mode === "text" ? "var(--background-secondary)" : (this.rule.color || "var(--background-secondary)");
        el.style.color = "var(--text-normal)"; // Default text color unless implicit

        const styles = (this.mode === "color" ? "" : this.rule.textStyle || "").split(",").map(s => s.trim().toLowerCase());

        el.style.fontWeight = styles.includes("bold") ? "bold" : "normal";
        el.style.fontStyle = styles.includes("italic") ? "italic" : "normal";
        el.style.textDecoration = [
            styles.includes("strikethrough") || styles.includes("line-through") ? "line-through" : "",
            styles.includes("underline") ? "underline" : ""
        ].filter(Boolean).join(" ");

        if (styles.includes("faded")) el.style.opacity = "0.7";
        else el.style.opacity = "1";
    }
}
