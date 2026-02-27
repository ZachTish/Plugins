
import { PluginSettingTab, Setting, App } from "obsidian";
import { VisualBuilderModal, StyleProfileModal } from "./visual-builder";
import { FilterEditModal } from "./filter-edit-modal";
import { BasesFilterEditModal } from "./bases-filter-edit-modal";

export class TPSExplorerSettingsTab extends PluginSettingTab {
    plugin: any;

    constructor(app: App, plugin: any) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        let { containerEl: e } = this;
        e.empty();
        this.plugin.ensureServiceBuilders();

        e.createEl("h2", { text: "Explorer 2 Settings" });

        const createSection = (title: string, open = false) => {
            const details = e.createEl('details', { cls: 'explorer2-settings-group' });
            if (open) details.setAttr('open', '');
            details.createEl('summary', { text: title });
            return details.createDiv({ cls: 'explorer2-settings-group-content' });
        };

        const styleServices = [
            { type: "sort", label: "Sort" },
            { type: "hide", label: "Hide" },
        ];

        // --- General Section ---
        const general = createSection("General", true);

        new Setting(general)
            .setName("Hide inline-tag items when line is crossed out")
            .setDesc("When enabled, notes with inline tags on a crossed-out line are hidden from the Tags section.")
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings?.hideInlineTagCrossedOut !== false)
                    .onChange(async (value) => {
                        this.plugin.settings.hideInlineTagCrossedOut = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshAllExplorer2();
                    });
            });

        new Setting(general)
            .setName("Hide inline-tag items when checkbox is checked")
            .setDesc("When enabled, inline-tag lines with a checked task box are hidden from the Tags section.")
            .addToggle((toggle) => {
                toggle
                    .setValue(this.plugin.settings?.hideInlineTagChecked !== false)
                    .onChange(async (value) => {
                        this.plugin.settings.hideInlineTagChecked = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshAllExplorer2();
                    });
            });

        // --- Visual Styling Section ---
        const visual = createSection("Visual Styling", false);

        visual.createEl("p", { cls: "setting-item-description", text: "Customize icons, colors, and text styles based on rules." });

        new Setting(visual)
            .setName("File styles")
            .setDesc("Rules for file icons, colors, and text.")
            .addButton((btn) => btn
                .setButtonText("Manage file rules")
                .onClick(() => {
                    new VisualBuilderModal(this.app, this.plugin, {
                        scope: "file",
                        title: "File Style Rules",
                        description: "Define icon, color, and text rules for files."
                    }).open();
                }));

        new Setting(visual)
            .setName("Folder styles")
            .setDesc("Rules for folder icons, colors, and text.")
            .addButton((btn) => btn
                .setButtonText("Manage folder rules")
                .onClick(() => {
                    new VisualBuilderModal(this.app, this.plugin, {
                        scope: "folder",
                        title: "Folder Style Rules",
                        description: "Define icon, color, and text rules for folders."
                    }).open();
                }));

        visual.createEl("hr", { cls: "explorer2-setting-separator" });
        this.renderProfileManager(visual, styleServices);

        // --- Filters & Views Section ---
        const logic = createSection("Filters & Views", false);
        logic.createEl("p", { cls: "setting-item-description", text: "Manage automated filters and view assignments." });

        logic.createEl("h4", { text: "Manual Filters", cls: "explorer2-setting-subheading" });
        logic.createEl("p", { cls: "setting-item-description", text: "Custom filters with manual rules. Click Edit to modify filter rules." });

        const smartFiltersContainer = logic.createDiv({ cls: "explorer2-smart-filters-container" });

        const smartFilters = Array.isArray(this.plugin.settings.filters)
            ? this.plugin.settings.filters
            : [];

        if (smartFilters.length === 0) {
            smartFiltersContainer.createEl("p", { text: "No Manual filters configured yet.", cls: "explorer2-text-muted" });
        } else {
            smartFilters.forEach((filter: any, index: number) => {
                const card = smartFiltersContainer.createDiv({ cls: "explorer2-smart-filter-card" });

                let desc = filter.rules?.length
                    ? `${filter.rules.length} rule(s)`
                    : "No rules";
                if (filter.defaultFrontmatter?._templatePath) {
                    desc += ` • Template configured`;
                }

                new Setting(card)
                    .setName(filter.name || filter.id || `Filter ${index + 1}`)
                    .setDesc(desc)
                    .addExtraButton((btn) =>
                        btn.setIcon("pencil")
                            .setTooltip("Edit")
                            .onClick(() => {
                                new FilterEditModal(this.app, this.plugin, filter, async (updatedFilter: any) => {
                                    if (!updatedFilter) return;
                                    this.plugin.settings.filters[index] = updatedFilter;
                                    await this.plugin.saveSettings();
                                    this.plugin.markFilterDefinitionsDirty();
                                    this.plugin.refreshAllExplorer2();
                                    this.display();
                                }).open();
                            })
                    )
                    .addExtraButton((btn) =>
                        btn.setIcon("copy")
                            .setTooltip("Duplicate")
                            .onClick(async () => {
                                const newFilter = JSON.parse(JSON.stringify(filter));
                                let suffix = 1;
                                let newId = `${filter.id}-copy`;
                                const existingIds = this.plugin.settings.filters.map((f: any) => f.id);
                                while (existingIds.includes(newId)) {
                                    newId = `${filter.id}-copy-${suffix++}`;
                                }
                                newFilter.id = newId;
                                newFilter.name = `${filter.name} (Copy)`;
                                this.plugin.settings.filters.splice(index + 1, 0, newFilter);
                                await this.plugin.saveSettings();
                                this.plugin.markFilterDefinitionsDirty();
                                this.plugin.refreshAllExplorer2();
                                this.display();
                            })
                    )
                    .addExtraButton((btn) =>
                        btn.setIcon("arrow-up")
                            .setTooltip("Move up")
                            .setDisabled(index === 0)
                            .onClick(async () => {
                                if (index === 0) return;
                                const filters = this.plugin.settings.filters || [];
                                const [moved] = filters.splice(index, 1);
                                filters.splice(index - 1, 0, moved);
                                await this.plugin.saveSettings();
                                this.plugin.markFilterDefinitionsDirty();
                                this.plugin.refreshAllExplorer2();
                                this.display();
                            })
                    )
                    .addExtraButton((btn) =>
                        btn.setIcon("arrow-down")
                            .setTooltip("Move down")
                            .setDisabled(index === smartFilters.length - 1)
                            .onClick(async () => {
                                if (index >= smartFilters.length - 1) return;
                                const filters = this.plugin.settings.filters || [];
                                const [moved] = filters.splice(index, 1);
                                filters.splice(index + 1, 0, moved);
                                await this.plugin.saveSettings();
                                this.plugin.markFilterDefinitionsDirty();
                                this.plugin.refreshAllExplorer2();
                                this.display();
                            })
                    )
                    .addExtraButton((btn) =>
                        btn.setIcon("trash")
                            .setTooltip("Delete")
                            .onClick(async () => {
                                if (!confirm(`Delete filter "${filter.name || filter.id}"?`)) return;
                                this.plugin.settings.filters.splice(index, 1);
                                await this.plugin.saveSettings();
                                this.plugin.markFilterDefinitionsDirty();
                                this.plugin.refreshAllExplorer2();
                                this.display();
                            })
                    );
            });
        }

        new Setting(logic)
            .addButton((btn) => {
                btn.setButtonText("Add Manual Filter")
                    .onClick(() => {
                        new FilterEditModal(this.app, this.plugin, null, async (newFilter: any) => {
                            if (!newFilter) return;
                            if (!Array.isArray(this.plugin.settings.filters)) {
                                this.plugin.settings.filters = [];
                            }
                            this.plugin.settings.filters.push(newFilter);
                            await this.plugin.saveSettings();
                            this.plugin.markFilterDefinitionsDirty();
                            this.plugin.refreshAllExplorer2();
                            this.display();
                        }).open();
                    });
            });

        logic.createEl("h4", { text: "Bases Filters", cls: "explorer2-setting-subheading" });
        logic.createEl("p", { cls: "setting-item-description", text: "Filters derived from Bases files. These automatically sync with the Bases configuration." });

        const basesFiltersContainer = logic.createDiv({ cls: "explorer2-bases-filters-container" });

        const basesFilters = Array.isArray(this.plugin.settings.basesFilters)
            ? this.plugin.settings.basesFilters
            : [];

        if (basesFilters.length === 0) {
            basesFiltersContainer.createEl("p", { text: "No Bases filters configured yet.", cls: "explorer2-text-muted" });
        } else {
            basesFilters.forEach((bf: any, index: number) => {
                const card = basesFiltersContainer.createDiv({ cls: "explorer2-bases-filter-card" });
                let desc = `Path: ${bf.basePath || "(not set)"}`;
                if (bf.templatePath) {
                    desc += ` • Template: ${bf.templatePath}`;
                }

                new Setting(card)
                    .setName(bf.name || bf.basePath || `Bases Filter ${index + 1}`)
                    .setDesc(desc)
                    .addExtraButton((btn) =>
                        btn.setIcon("pencil")
                            .setTooltip("Edit")
                            .onClick(() => {
                                new BasesFilterEditModal(this.app, this.plugin, bf, async (updatedFilter: any) => {
                                    if (!updatedFilter) return;
                                    this.plugin.settings.basesFilters[index] = updatedFilter;
                                    await this.plugin.saveSettings();
                                    this.plugin.markFilterDefinitionsDirty();
                                    this.plugin.refreshAllExplorer2();
                                    this.display();
                                }).open();
                            })
                    )
                    .addExtraButton((btn) =>
                        btn.setIcon("trash")
                            .setTooltip("Delete")
                            .onClick(async () => {
                                if (!confirm(`Delete Bases filter "${bf.name || bf.basePath}"?`)) return;
                                this.plugin.settings.basesFilters.splice(index, 1);
                                await this.plugin.saveSettings();
                                this.plugin.markFilterDefinitionsDirty();
                                this.plugin.refreshAllExplorer2();
                                this.display();
                            })
                    );
            });
        }

        new Setting(logic)
            .addButton((btn) => {
                btn.setButtonText("Add Bases Filter")
                    .onClick(() => {
                        new BasesFilterEditModal(this.app, this.plugin, null, async (newFilter: any) => {
                            if (!newFilter) return;
                            if (!Array.isArray(this.plugin.settings.basesFilters)) {
                                this.plugin.settings.basesFilters = [];
                            }
                            this.plugin.settings.basesFilters.push(newFilter);
                            await this.plugin.saveSettings();
                            this.plugin.markFilterDefinitionsDirty();
                            this.plugin.refreshAllExplorer2();
                            this.display();
                        }).open();
                    });
            });

        logic.createEl("hr", { cls: "explorer2-setting-separator" });
        logic.createEl("h4", { text: "Section Assignments" });

        const renderAssignmentCard = (title: string, desc: string, contextName: string, sectionKey: string | null = null) => {
            const card = logic.createDiv({ cls: "explorer2-section-builder-card" });
            const header = card.createDiv({ cls: "explorer2-section-card-header" });
            header.createEl("h4", { text: title });
            if (desc) header.createEl("p", { text: desc });

            const body = card.createDiv({ cls: "explorer2-section-card-body" });

            styleServices.forEach((service) => {
                let currentId;
                if (contextName === "default") {
                    currentId = this.plugin.getAssignedProfileId(service.type, {});
                } else if (contextName === "sections" && sectionKey) {
                    currentId = this.plugin.getAssignedProfileId(service.type, { sectionKey });
                }

                new Setting(body)
                    .setName(`${service.label} profile`)
                    .setDesc(`Choose a profile to apply to this section.`)
                    .addDropdown((dd) => {
                        if (contextName === "default") {
                            dd.addOption("", "None");
                        } else {
                            dd.addOption("", "Default (system and complete)");
                        }

                        const profs = this.plugin.getStyleProfiles(service.type);
                        if (profs) {
                            Object.values(profs).forEach((p: any) => {
                                dd.addOption(p.id, p.name || "Unnamed Profile");
                            });
                        }
                        dd.setValue(currentId || "");
                        dd.onChange(async (val) => {
                            if (contextName === "default") {
                                this.plugin.setStyleAssignment("default", "default", service.type, val);
                            } else if (contextName === "sections" && sectionKey) {
                                this.plugin.setStyleAssignment("sections", sectionKey, service.type, val);
                            }
                            await this.plugin.savePluginState();
                        });
                    });
            });
        }

        renderAssignmentCard("Tags Section", "Rules for the tags view.", "sections", "tags");
        renderAssignmentCard("Types Section", "Rules for the file types view.", "sections", "types");

        const advanced = createSection("Advanced");

        new Setting(advanced)
            .setName("Folder Exclusions")
            .setDesc("One path per line. Files in these folders will be ignored.")
            .addTextArea((n) => {
                n.setPlaceholder("System/Templates\nArchive")
                    .setValue(this.plugin.settings?.folderExclusions || "")
                n.onChange(async (r) => {
                    this.plugin.settings.folderExclusions = r;
                    await this.plugin.saveSettings();
                });
                n.inputEl.rows = 4;
            });

        new Setting(advanced)
            .setName("Enable Debug Logging")
            .setDesc("Logs detailed info to console.")
            .addToggle((t) => {
                t.setValue(this.plugin.settings.enableDebugLogging)
                    .onChange(async (val) => {
                        this.plugin.settings.enableDebugLogging = val;
                        await this.plugin.savePluginState();
                    });
            });
    }

    renderProfileManager(e: HTMLElement, styleServices: any[]) {
        const getProfileOptions = (type: string) => {
            const profiles = Object.values(this.plugin.getStyleProfiles(type) || {}) as any[];
            return profiles.sort((a, b) => {
                const orderA = typeof a.order === 'number' ? a.order : 9999;
                const orderB = typeof b.order === 'number' ? b.order : 9999;
                if (orderA !== orderB) return orderA - orderB;
                return (a.name || a.id).localeCompare(b.name || b.id);
            });
        };

        const openProfileModal = (type: string, profileId = null, onSave = null) => {
            new StyleProfileModal(this.app, this.plugin, {
                type,
                profileId,
                onSave,
            }).open();
        };

        const moveProfile = async (type: string, profile: any, dir: number) => {
            this.plugin.ensureServiceBuilders();
            const profilesObj = this.plugin.settings.serviceConfig?.styleProfiles?.[type];
            if (!profilesObj) return;

            const profiles = Object.values(profilesObj) as any[];
            profiles.sort((a, b) => {
                const orderA = typeof a.order === 'number' ? a.order : 9999;
                const orderB = typeof b.order === 'number' ? b.order : 9999;
                return orderA - orderB;
            });

            const idx = profiles.findIndex(p => p.id === profile.id);
            if (idx === -1) return;
            const targetIdx = idx + dir;
            if (targetIdx < 0 || targetIdx >= profiles.length) return;

            [profiles[idx], profiles[targetIdx]] = [profiles[targetIdx], profiles[idx]];
            profiles.forEach((p, i) => {
                p.order = i;
                if (profilesObj[p.id]) profilesObj[p.id].order = i;
            });

            await this.plugin.savePluginState();
            this.plugin.refreshAllExplorer2();
            this.display();
        };

        const deleteProfile = async (type: string, profileId: string) => {
            this.plugin.ensureServiceBuilders();
            const profilesObj = this.plugin.settings.serviceConfig?.styleProfiles?.[type];
            if (!profilesObj || !profilesObj[profileId]) return;

            const profileName = profilesObj[profileId].name || profileId;
            if (!confirm(`Delete profile "${profileName}"?`)) return;

            this.plugin.deleteStyleProfile(type, profileId);
            await this.plugin.savePluginState();
            this.plugin.refreshAllExplorer2();
            this.display();
        };

        e.createEl("h3", { text: "Manage Profiles" });
        styleServices.forEach((service) => {
            let card = e.createDiv({ cls: "explorer2-section-builder-card" });
            card.createEl("h4", { text: `${service.label} Profiles` });

            new Setting(card)
                .setDesc(`Create, edit, or delete ${service.label.toLowerCase()} profiles.`)
                .addButton((btn) => {
                    btn.setButtonText(`New ${service.label} Profile`)
                        .setCta()
                        .onClick(() => {
                            openProfileModal(service.type, null, async () => {
                                this.plugin.refreshAllExplorer2();
                                this.display();
                            });
                        });
                });

            const profiles = getProfileOptions(service.type);
            if (profiles.length === 0) {
                card.createEl("p", { text: "No profiles created yet.", cls: "explorer2-text-muted" });
            } else {
                profiles.forEach((profile, idx) => {
                    const currentDefaultId = this.plugin.getAssignedProfileId(service.type, {});
                    const isDefault = currentDefaultId === profile.id;

                    const s = new Setting(card)
                        .setName(profile.name || profile.id);

                    s.addToggle(toggle => {
                        toggle.setValue(isDefault)
                            .setTooltip(isDefault ? "This is the default profile" : "Set as default")
                            .onChange(async (value) => {
                                if (value) {
                                    this.plugin.setStyleAssignment("default", "default", service.type, profile.id);
                                } else {
                                    this.plugin.setStyleAssignment("default", "default", service.type, "");
                                }
                                await this.plugin.savePluginState();
                                this.plugin.refreshAllExplorer2();
                                this.display();
                            });
                    });

                    s.addExtraButton(btn => {
                        btn.setIcon("arrow-up").setTooltip("Move Up").setDisabled(idx === 0).onClick(() => moveProfile(service.type, profile, -1));
                    });
                    s.addExtraButton(btn => {
                        btn.setIcon("arrow-down").setTooltip("Move Down").setDisabled(idx === profiles.length - 1).onClick(() => moveProfile(service.type, profile, 1));
                    });

                    s.addExtraButton((btn) =>
                        btn.setIcon("pencil").setTooltip("Edit").onClick(() => {
                            openProfileModal(service.type, profile.id, async () => {
                                this.plugin.refreshAllExplorer2();
                                this.display();
                            });
                        })
                    );

                    s.addExtraButton((btn) =>
                        btn.setIcon("copy").setTooltip("Duplicate Profile").onClick(async () => {
                            const newProfile = JSON.parse(JSON.stringify(profile));
                            let suffix = 1;
                            let newId = `${profile.id}-copy`;
                            const existingProfiles = this.plugin.settings.serviceConfig?.styleProfiles?.[service.type] || {};
                            while (existingProfiles[newId]) {
                                newId = `${profile.id}-copy-${suffix++}`;
                            }
                            newProfile.id = newId;
                            newProfile.name = `${profile.name} (Copy)`;
                            if (!this.plugin.settings.serviceConfig.styleProfiles[service.type]) {
                                this.plugin.settings.serviceConfig.styleProfiles[service.type] = {};
                            }
                            this.plugin.settings.serviceConfig.styleProfiles[service.type][newId] = newProfile;
                            await this.plugin.savePluginState();
                            this.plugin.refreshAllExplorer2();
                            this.display();
                        })
                    );

                    s.addExtraButton((btn) =>
                        btn.setIcon("trash").setTooltip("Delete Profile").onClick(async () => {
                            await deleteProfile(service.type, profile.id);
                        })
                    );
                });
            }
        });
    }
}
