import { App, Modal, Setting } from 'obsidian';
import TPSGlobalContextMenuPlugin from './main';
import { CustomProperty, CustomPropertyProfile, ViewModeConditionType, ViewModeConditionOperator } from './types';

export class PropertyProfilesModal extends Modal {
    private plugin: TPSGlobalContextMenuPlugin;
    private property: CustomProperty;
    private onSave: () => void;

    constructor(app: App, plugin: TPSGlobalContextMenuPlugin, property: CustomProperty, onSave: () => void) {
        super(app);
        this.plugin = plugin;
        this.property = property;
        this.onSave = onSave;
    }

    onOpen() {
        this.display();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        this.onSave();
    }

    display() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: `Profiles for: ${this.property.label}` });
        contentEl.createEl('p', { text: 'Create conditional profiles to hide this property or change its options.' });

        if (!Array.isArray(this.property.profiles)) {
            this.property.profiles = [];
        }

        new Setting(contentEl)
            .addButton(btn => btn
                .setButtonText("Add Profile")
                .setCta()
                .onClick(async () => {
                    this.property.profiles!.push({
                        id: Date.now().toString(),
                        name: "New Profile",
                        match: "all",
                        conditions: [{ type: "path", operator: "contains", value: "" }]
                    });
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        this.property.profiles!.forEach((profile, index) => {
            const card = contentEl.createDiv();
            card.style.border = "1px solid var(--background-modifier-border)";
            card.style.padding = "10px";
            card.style.marginTop = "10px";
            card.style.borderRadius = "8px";

            const headerSetting = new Setting(card)
                .setName(`Profile: ${profile.name}`)
                .addText(text => text
                    .setValue(profile.name)
                    .setPlaceholder("Profile Name")
                    .onChange(async v => {
                        profile.name = v;
                        await this.plugin.saveSettings();
                    }))
                .addExtraButton(btn => btn
                    .setIcon("trash")
                    .setTooltip("Delete Profile")
                    .onClick(async () => {
                        this.property.profiles!.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            new Setting(card)
                .setName("Hide property entirely")
                .setDesc("When this profile matches, the property will be hidden everywhere.")
                .addToggle(toggle => toggle
                    .setValue(!!profile.hidden)
                    .onChange(async v => {
                        profile.hidden = v;
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            if (!profile.hidden) {
                if (this.property.type === 'selector') {
                    new Setting(card)
                        .setName("Override options")
                        .setDesc("Comma-separated list of selector options for this profile.")
                        .addText(text => {
                            text.setPlaceholder("Options (comma separated)")
                            text.setValue((profile.options || []).join(", "))
                            text.onChange(async v => {
                                profile.options = v.split(",").map(s => s.trim()).filter(Boolean);
                                await this.plugin.saveSettings();
                            });
                            text.inputEl.style.width = "200px";
                        });
                }

                new Setting(card)
                    .setName("Visibility overrides")
                    .setDesc("Override where this property appears when profile matches.")
                    .addToggle(toggle => toggle
                        .setTooltip("Show on inline menu")
                        .setValue(profile.showInCollapsed !== false)
                        .onChange(async v => {
                            profile.showInCollapsed = v;
                            await this.plugin.saveSettings();
                        }))
                    .addToggle(toggle => toggle
                        .setTooltip("Show in context menu")
                        .setValue(profile.showInContextMenu !== false)
                        .onChange(async v => {
                            profile.showInContextMenu = v;
                            await this.plugin.saveSettings();
                        }));
            }

            new Setting(card)
                .setName("Condition Match Mode")
                .addDropdown(drop => drop
                    .addOption("all", "Match all (AND)")
                    .addOption("any", "Match any (OR)")
                    .setValue(profile.match || "all")
                    .onChange(async v => {
                        profile.match = v as "all" | "any";
                        await this.plugin.saveSettings();
                    }))
                .addButton(btn => btn
                    .setButtonText("Add Condition")
                    .onClick(async () => {
                        profile.conditions = profile.conditions || [];
                        profile.conditions.push({ type: "path", operator: "contains", value: "" });
                        await this.plugin.saveSettings();
                        this.display();
                    }));

            const conditions = profile.conditions || [];
            conditions.forEach((condition, conditionIndex) => {
                // Ensure operator has a valid default for its type
                const isPath = condition.type === "path";
                const validPathOps = ["contains", "equals", "starts-with", "ends-with", "not-contains"];
                const validFmOps = ["equals", "contains", "not-equals", "not-contains", "exists", "missing", "is-empty"];
                const validOps = isPath ? validPathOps : validFmOps;
                if (!condition.operator || !validOps.includes(condition.operator)) {
                    condition.operator = isPath ? "contains" : "equals";
                }

                const condRow = card.createDiv();
                condRow.style.display = "flex";
                condRow.style.gap = "8px";
                condRow.style.alignItems = "center";
                condRow.style.marginTop = "8px";
                condRow.style.flexWrap = "wrap";

                new Setting(condRow).setClass("tps-gcm-no-border")
                    .addDropdown(drop => drop
                        .addOption("path", "Path")
                        .addOption("frontmatter", "Frontmatter")
                        .setValue(condition.type || "path")
                        .onChange(async v => {
                            condition.type = v as ViewModeConditionType;
                            if (v === "path") condition.operator = "contains";
                            if (v === "frontmatter") condition.operator = "equals";
                            await this.plugin.saveSettings();
                            this.display();
                        }));

                if (!isPath) {
                    new Setting(condRow).setClass("tps-gcm-no-border")
                        .addText(text => text
                            .setPlaceholder("Key")
                            .setValue(condition.key || "")
                            .onChange(async v => {
                                condition.key = v;
                                await this.plugin.saveSettings();
                            }));
                }

                new Setting(condRow).setClass("tps-gcm-no-border")
                    .addDropdown(drop => {
                        validOps.forEach(o => drop.addOption(o, o));
                        drop.setValue(condition.operator!)
                            .onChange(async v => {
                                condition.operator = v as ViewModeConditionOperator;
                                await this.plugin.saveSettings();
                                this.display();
                            });
                    });

                if (condition.operator !== "exists" && condition.operator !== "missing" && condition.operator !== "is-empty") {
                    new Setting(condRow).setClass("tps-gcm-no-border")
                        .addText(text => text
                            .setPlaceholder("Value")
                            .setValue(condition.value || "")
                            .onChange(async v => {
                                condition.value = v;
                                await this.plugin.saveSettings();
                            }));
                }

                new Setting(condRow).setClass("tps-gcm-no-border")
                    .addExtraButton(btn => btn
                        .setIcon("x")
                        .onClick(async () => {
                            profile.conditions!.splice(conditionIndex, 1);
                            await this.plugin.saveSettings();
                            this.display();
                        }));
            });
        });
    }
}
