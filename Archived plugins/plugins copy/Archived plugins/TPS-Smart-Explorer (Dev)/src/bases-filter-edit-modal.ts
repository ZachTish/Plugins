
import { Modal, Setting, Notice, normalizePath, App } from "obsidian";

export class BasesFilterEditModal extends Modal {
    plugin: any;
    basesFilter: any;
    onSave: any;
    noteCreationEl: any;

    static createBasesFilterId() {
        return `bases-filter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    constructor(app: App, plugin: any, existing: any, onSave: any) {
        super(app);
        this.plugin = plugin;
        this.onSave = onSave;
        this.basesFilter = existing
            ? JSON.parse(JSON.stringify(existing))
            : {
                id: BasesFilterEditModal.createBasesFilterId(),
                name: "",
                basePath: "",
                icon: "database",
                hideProfileId: "",
                templatePath: "",
                targetFolder: "",
            };
    }

    onOpen() {
        this.titleEl.setText(this.basesFilter.id ? "Edit Bases Filter" : "Add Bases Filter");
        this.render();
    }

    render() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("p", {
            text: "Link a Bases file to create a filter that automatically uses its filter configuration.",
            cls: "setting-item-description"
        });

        new Setting(contentEl)
            .setName("Bases file path")
            .setDesc("Path to the .base file in your vault (e.g., 'My Bases/Tasks.base')")
            .addText((text) => {
                text.setPlaceholder("path/to/your.base")
                    .setValue(this.basesFilter.basePath || "")
                    .onChange((value) => {
                        this.basesFilter.basePath = value.trim();
                        // Auto-update name if not manually set
                        if (!this.basesFilter.name && value) {
                            const baseName = value.split("/").pop()?.replace(/\.base$/i, "") || "";
                            this.basesFilter.name = baseName;
                        }
                    });
                text.inputEl.style.width = "100%";
            });

        new Setting(contentEl)
            .setName("Display name")
            .setDesc("Name shown in the Explorer sidebar (defaults to file basename)")
            .addText((text) => {
                text.setPlaceholder("Filter name")
                    .setValue(this.basesFilter.name || "")
                    .onChange((value) => {
                        this.basesFilter.name = value.trim();
                    });
            });

        new Setting(contentEl)
            .setName("Icon")
            .setDesc("Icon shown in the sidebar")
            .addText((text) => {
                text.setPlaceholder("database")
                    .setValue(this.basesFilter.icon || "database")
                    .onChange((value) => {
                        this.basesFilter.icon = value.trim() || "database";
                    });
            });

        new Setting(contentEl)
            .setName("Hide profile")
            .setDesc("Select a profile to control which items are hidden in this filter")
            .addDropdown((dd) => {
                dd.addOption("", "No hide profile");
                const hideProfiles = this.plugin.getStyleProfiles("hide");
                if (hideProfiles) {
                    Object.values(hideProfiles).forEach((p: any) => {
                        dd.addOption(p.id, p.name || "Unnamed Profile");
                    });
                }
                dd.setValue(this.basesFilter.hideProfileId || "");
                dd.onChange((value) => {
                    this.basesFilter.hideProfileId = value;
                });
            });

        // Separator for creation options
        contentEl.createEl("h4", { text: "Quick Add", cls: "setting-item-heading" });
        contentEl.createEl("p", {
            text: "Configure how the + button works for this filter.",
            cls: "setting-item-description"
        });

        // Initialize creation mode if not set
        if (!this.basesFilter.creationMode) {
            this.basesFilter.creationMode = this.basesFilter.templatePath ? "note" : "none";
        }

        // Creation Mode Toggle
        new Setting(contentEl)
            .setName("Creation mode")
            .setDesc("Choose whether to create new notes")
            .addDropdown((dd) => {
                dd.addOption("none", "Disabled (no + button)");
                dd.addOption("note", "Create new note");
                dd.setValue(this.basesFilter.creationMode || "none");
                dd.onChange((value) => {
                    this.basesFilter.creationMode = value;
                    this.updateCreationModeVisibility();
                });
            });

        // Note creation settings container
        this.noteCreationEl = contentEl.createDiv({ cls: "explorer2-note-creation-settings" });

        new Setting(this.noteCreationEl)
            .setName("Template path")
            .setDesc("Path to the template file for creating new notes")
            .addText((text) => {
                text.setPlaceholder("path/to/template.md")
                    .setValue(this.basesFilter.templatePath || "")
                    .onChange((value) => {
                        this.basesFilter.templatePath = value.trim();
                    });
                text.inputEl.style.width = "100%";
            });

        new Setting(this.noteCreationEl)
            .setName("Target folder")
            .setDesc("Folder where new notes will be created (defaults to vault root)")
            .addText((text) => {
                text.setPlaceholder("path/to/folder")
                    .setValue(this.basesFilter.targetFolder || "")
                    .onChange((value) => {
                        this.basesFilter.targetFolder = value.trim();
                    });
                text.inputEl.style.width = "100%";
            });


        // Initialize visibility
        this.updateCreationModeVisibility();

        // Action buttons
        const actions = contentEl.createDiv({ cls: "modal-button-row" });
        actions.style.marginTop = "20px";
        actions.style.display = "flex";
        actions.style.justifyContent = "flex-end";
        actions.style.gap = "10px";

        const cancelBtn = actions.createEl("button", { text: "Cancel" });
        cancelBtn.addEventListener("click", () => this.close());

        const saveBtn = actions.createEl("button", { text: "Save", cls: "mod-cta" });
        saveBtn.addEventListener("click", async () => {
            if (!this.basesFilter.basePath) {
                new Notice("Please enter a Bases file path");
                return;
            }

            // Validate the bases file exists
            const normalizedPath = normalizePath(this.basesFilter.basePath);
            const file = this.app.vault.getAbstractFileByPath(normalizedPath);
            if (!file) {
                new Notice(`Bases file not found: ${this.basesFilter.basePath}`);
                return;
            }

            // Set name from basename if not provided
            if (!this.basesFilter.name) {
                this.basesFilter.name = normalizedPath.split("/").pop()?.replace(/\.base$/i, "") || "Unnamed";
            }

            if (typeof this.onSave === "function") {
                await this.onSave(this.basesFilter);
            }
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }

    updateCreationModeVisibility() {
        const mode = this.basesFilter.creationMode || "none";
        if (this.noteCreationEl) {
            this.noteCreationEl.style.display = mode === "note" ? "" : "none";
        }
    }

}
