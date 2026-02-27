
import { Modal, Setting, Notice, setIcon, getIconIds, App } from "obsidian";
import * as logger from "./logger";
import { IconPickerModal, RuleBuilderRenderer } from "./visual-builder";
import { normalizeBuilderDefinition } from "./normalizers";

export class FilterEditModal extends Modal {
    plugin: any;
    original: any;
    onSave: any;
    filter: any;
    lastValidationMessage: any;
    ruleDomMap: any;
    groupDomMap: any;
    autoFocusName: any;
    _nameFocusQueued: any;
    errorMessageEl: any;
    rulesHost: any;
    assignedSort: any;
    assignedHide: any;

    static createFilterId() {
        return `filter-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    constructor(e: App, t: any, n: any, r: any) {
        super(e);
        (this.plugin = t),
            (this.original = n),
            (this.onSave = r),
            (this.filter = n
                ? JSON.parse(JSON.stringify(n))
                : {
                    id: FilterEditModal.createFilterId(),
                    name: "",
                    icon: "filter",
                    match: "all",
                    rules: [],
                }),
            (this.lastValidationMessage = ""),
            (this.ruleDomMap = new Map()),
            (this.groupDomMap = new Map()),
            (this.autoFocusName = !this.original),
            (this._nameFocusQueued = !1);

        Array.isArray(this.filter.rules) || (this.filter.rules = []),
            !this.original &&
            this.filter.rules.length === 0 &&
            this.filter.rules.push(this.createEmptyCondition());

        // Load current profile assignments
        this.assignedSort = this.plugin.getAssignedProfileId("sort", { filterId: this.filter.id });
        this.assignedHide = this.plugin.getAssignedProfileId("hide", { filterId: this.filter.id });
    }
    static ensureStyles() {
        if (document.getElementById("explorer2-filter-style")) return;
        let e = document.createElement("style");
        ((e.id = "explorer2-filter-style"),
            (e.textContent = `
.explorer2-filter-hint { margin-bottom: 12px; color: var(--text-muted); }
.explorer2-filter-card { border: 1px solid var(--background-modifier-border); border-radius: 10px; padding: 12px; margin-bottom: 12px; background: var(--background-secondary); display: flex; flex-direction: column; gap: 6px; }
.explorer2-filter-card h4 { margin: 0; }
.explorer2-filter-meta { font-size: 12px; color: var(--text-muted); }
.explorer2-filter-buttons { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.explorer2-filter-buttons button { flex: 0 0 auto; }
.explorer2-filter-buttons button:disabled { opacity: 0.6; cursor: not-allowed; }
.explorer2-filter-rules { display: flex; flex-direction: column; gap: 12px; }
.explorer2-filter-rule-group { border: 1px solid var(--background-modifier-border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; background: var(--background-secondary); }
.explorer2-filter-group-header { display: flex; align-items: center; gap: 8px; justify-content: space-between; flex-wrap: wrap; }
.explorer2-filter-group-header select { min-width: 160px; }
.explorer2-filter-group-body { display: flex; flex-direction: column; gap: 8px; }
.explorer2-filter-empty { font-style: italic; color: var(--text-muted); margin: 0; }
.explorer2-filter-group-controls { display: flex; gap: 8px; flex-wrap: wrap; }
.explorer2-filter-group-controls button { flex: 0 0 auto; }
.explorer2-filter-condition {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 10px;
  align-items: stretch;
  border-radius: var(--radius-m);
  padding: 12px;
  background: var(--background-secondary);
}
.explorer2-filter-condition.no-field {
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}
.explorer2-filter-condition select,
.explorer2-filter-condition input,
.explorer2-filter-condition textarea {
  width: 100%;
  min-width: 0;
}
.explorer2-filter-condition textarea {
  resize: vertical;
  min-height: 36px;
}
.explorer2-filter-select { width: 100%; }
.explorer2-filter-input { width: 100%; }
.explorer2-filter-condition-actions {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  width: 100%;
  flex-wrap: wrap;
}
.explorer2-filter-condition.no-field .explorer2-filter-input-field { display: none; }
.explorer2-filter-builder-host {
  min-height: 220px;
  max-height: min(70vh, 520px);
  overflow: auto;
  padding-right: 4px;
  box-sizing: border-box;
}
@media (max-width: 720px) {
  .explorer2-filter-condition {
    grid-template-columns: 1fr;
  }
  .explorer2-filter-condition-actions {
    justify-content: flex-start;
  }
}
.explorer2-filter-error { color: #ff6b6b; margin-bottom: 12px; display: none; }
.explorer2-filter-condition.is-invalid { box-shadow: 0 0 0 1px #ff6b6b; border-radius: 8px; }
.explorer2-filter-condition.is-invalid input,
.explorer2-filter-condition.is-invalid select { border-color: #ff6b6b; }
.explorer2-filter-rule-group.is-invalid { border-color: #ff6b6b; box-shadow: 0 0 0 1px rgba(255,107,107,0.2); }
.explorer2-danger { background: #c92a2a; color: #fff; border: none; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.explorer2-danger:hover { filter: brightness(0.95); }
.explorer2-filter-footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.explorer2-filter-label { font-weight: 600; }
.mod-ghost { background: var(--background-modifier-hover); color: var(--text-muted); border: none; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
.mod-ghost:hover { color: var(--text-normal); }
`),
            document.head.appendChild(e));
    }
    onOpen() {
        (this.titleEl.setText(this.original ? "Edit Filter" : "Create Filter"),
            FilterEditModal.ensureStyles(),
            this.render());
    }
    render() {
        let { contentEl: e } = this;
        e.empty();

        e.createEl("p", {
            text: "Combine rules on frontmatter, tags, folders, or dates. Use groups to mix AND/OR logic.",
            cls: "explorer2-filter-hint",
        });

        this.errorMessageEl = e.createEl("div", { cls: "explorer2-filter-error" });
        if (this.lastValidationMessage) {
            this.errorMessageEl.textContent = this.lastValidationMessage;
            this.errorMessageEl.style.display = "block";
        } else {
            this.errorMessageEl.style.display = "none";
        }

        new Setting(e).setName("Name").addText((l) => {
            l.setPlaceholder("My Filter")
                .setValue(this.filter.name || "")
                .onChange((o) => (this.filter.name = o.trim()));
            if (this.autoFocusName && !this._nameFocusQueued) {
                this._nameFocusQueued = true;
                window.setTimeout(() => { try { l.inputEl?.focus(); } catch { } }, 0);
                this.autoFocusName = false;
            }
        });

        new Setting(e)
            .setName("Sort Profile")
            .setDesc("Choose a sort profile for this filter.")
            .addDropdown((d: any) => {
                d.addOption("", "Default");
                const profiles = Object.values(this.plugin.getStyleProfiles("sort") || {}) as any[];
                profiles.forEach(p => d.addOption(p.id, p.name || p.id));
                d.setValue(this.assignedSort || "");
                d.onChange((v: any) => { this.assignedSort = v; });
            });

        new Setting(e)
            .setName("Hide Profile")
            .setDesc("Choose a hide profile for this filter.")
            .addDropdown((d: any) => {
                d.addOption("", "Default");
                const profiles = Object.values(this.plugin.getStyleProfiles("hide") || {}) as any[];
                profiles.forEach(p => d.addOption(p.id, p.name || p.id));
                d.setValue(this.assignedHide || "");
                d.onChange((v: any) => { this.assignedHide = v; });
            });

        // Icon picker
        const iconSetting = new Setting(e)
            .setName("Icon")
            .setDesc("Icon displayed next to the filter name.");
        const controlEl = iconSetting.controlEl;
        controlEl.empty();
        controlEl.addClass("explorer2-icon-setting");
        const preview = controlEl.createDiv({ cls: "explorer2-icon-preview-large" });
        const updatePreview = () => {
            preview.empty();
            if (this.filter.icon) {
                try { setIcon(preview, this.filter.icon); } catch { preview.textContent = "?"; }
            }
        };
        updatePreview();
        const textInput = controlEl.createEl("input", {
            type: "text",
            cls: "explorer2-filter-input",
            placeholder: "filter",
            value: this.filter.icon || "",
        });
        textInput.style.flex = "1";
        textInput.addEventListener("input", (evt) => {
            this.filter.icon = (evt.target as HTMLInputElement).value.trim();
            updatePreview();
        });
        const chooseBtn = controlEl.createEl("button", { cls: "mod-cta", text: "Choose" });
        chooseBtn.addEventListener("click", () => {
            new IconPickerModal(this.app, (selectedIcon: any) => {
                this.filter.icon = selectedIcon;
                textInput.value = selectedIcon;
                updatePreview();
            }).open();
        });

        new Setting(e)
            .setName("Return type")
            .setDesc("Choose whether to display files.")
            .addDropdown((dd) => {
                dd.addOption("files", "Files (Standard)");
                dd.setValue(this.filter.returnType || "files");
                dd.onChange((val) => { this.filter.returnType = val; });
            });

        new Setting(e).setName("Match rules").addDropdown((l) =>
            l.addOption("all", "All conditions")
                .addOption("any", "Any condition")
                .setValue((this.filter.match || "all").toLowerCase() === "any" ? "any" : "all")
                .onChange((o) => (this.filter.match = o))
        );

        // Note Creation Settings
        if (!this.filter.defaultFrontmatter) this.filter.defaultFrontmatter = {};
        e.createEl("h4", { text: "Note Creation Settings" });
        const fmContainer = e.createDiv({ cls: "explorer2-default-fm-container" });
        fmContainer.style.display = "flex";
        fmContainer.style.flexDirection = "column";
        fmContainer.style.gap = "8px";
        fmContainer.style.marginBottom = "12px";

        const folderRow = fmContainer.createDiv({ cls: "explorer2-default-fm-row" });
        folderRow.style.display = "flex";
        folderRow.style.alignItems = "center";
        folderRow.style.gap = "8px";
        folderRow.createEl("label", { text: "Target Folder" }).style.minWidth = "100px";
        const folderInput = folderRow.createEl("input", { type: "text", cls: "explorer2-filter-input" });
        folderInput.style.flex = "1";
        folderInput.value = this.filter.defaultFrontmatter._targetFolder || "";
        folderInput.placeholder = "Folder to create notes in (e.g., Projects/Active)";
        folderInput.addEventListener("input", () => {
            if (folderInput.value.trim()) this.filter.defaultFrontmatter._targetFolder = folderInput.value.trim();
            else delete this.filter.defaultFrontmatter._targetFolder;
        });

        const templateRow = fmContainer.createDiv({ cls: "explorer2-default-fm-row" });
        templateRow.style.display = "flex";
        templateRow.style.alignItems = "center";
        templateRow.style.gap = "8px";
        templateRow.createEl("label", { text: "Template Path" }).style.minWidth = "100px";
        const templateInput = templateRow.createEl("input", { type: "text", cls: "explorer2-filter-input" });
        templateInput.style.flex = "1";
        templateInput.value = this.filter.defaultFrontmatter._templatePath || "";
        templateInput.placeholder = "Path to template file OR folder of templates";
        templateInput.addEventListener("input", () => {
            if (templateInput.value.trim()) this.filter.defaultFrontmatter._templatePath = templateInput.value.trim();
            else delete this.filter.defaultFrontmatter._templatePath;
        });

        // Rules Section
        e.createEl("h4", { text: "Rules" });
        this.rulesHost = e.createDiv({ cls: "explorer2-filter-rules" });
        this.renderRules();



        let footer = e.createDiv({ cls: "explorer2-filter-footer" });
        let saveBtn = footer.createEl("button", { cls: "mod-cta", text: "Save" });
        saveBtn.addEventListener("click", () => {
            if (!this.filter.name?.trim()) {
                new Notice("Filter name is required");
                return;
            }
            this.clearValidationMarkers();
            let l = this.validateFilterStructure();
            if (!l.ok) {
                this.lastValidationMessage = l.message || "Fix the highlighted rules.";
                this.errorMessageEl.textContent = this.lastValidationMessage;
                this.errorMessageEl.style.display = "block";
                this.applyValidationMarkers(l);
                new Notice(this.lastValidationMessage);
                return;
            }
            this.lastValidationMessage = "";
            this.errorMessageEl.style.display = "none";
            this.filter.id || (this.filter.id = FilterEditModal.createFilterId());
            this.saveAssignments();



            this.onSave(JSON.parse(JSON.stringify(this.filter)));
            this.close();
        });

        let cancelBtn = footer.createEl("button", { text: "Cancel" });
        cancelBtn.addEventListener("click", () => this.close());
    }

    saveAssignments() {
        this.plugin.setStyleAssignment("filters", this.filter.id, "sort", this.assignedSort);
        this.plugin.setStyleAssignment("filters", this.filter.id, "hide", this.assignedHide);
    }

    renderRules() {
        (this.rulesHost.empty(),
            (this.ruleDomMap = new Map()),
            (this.groupDomMap = new Map()));
        let e = this.rulesHost.createDiv({ cls: "explorer2-filter-rule-group" });
        this.renderRuleGroup(e, this.filter, !0);
    }
    renderRuleGroup(e: any, t: any, n = !1) {
        this.groupDomMap.set(t, e);
        let r = e.createDiv({ cls: "explorer2-filter-group-header" }),
            a = r.createDiv({ text: n ? "Root logic" : "Group logic" });
        a.className = "explorer2-filter-label";
        let s = r.createEl("select", { cls: "explorer2-filter-select" });
        if (
            ([
                ["all", "All conditions"],
                ["any", "Any condition"],
            ].forEach(([h, b]) => {
                let F = s.createEl("option");
                ((F.value = h), (F.text = b));
            }),
                (s.value = (t.match || "all").toLowerCase() === "any" ? "any" : "all"),
                s.addEventListener("change", (h: any) => {
                    t.match = h.target.value;
                }),
                !n)
        ) {
            let h = r.createEl("button", { cls: "explorer2-danger" });
            ((h.textContent = "Remove group"),
                h.addEventListener("click", () => {
                    (this.removeGroup(this.filter, t), this.renderRules());
                }));
        }
        let l = Array.isArray(t.rules) ? t.rules : (t.rules = []),
            o = e.createDiv({ cls: "explorer2-filter-group-body" });
        (l.length ||
            o.createEl("p", {
                text: "No rules in this group yet.",
                cls: "explorer2-filter-empty",
            }),
            l.forEach((h: any) => {
                if (h.type === "group") {
                    let b = o.createDiv({ cls: "explorer2-filter-rule-group" });
                    this.renderRuleGroup(b, h, !1);
                } else this.renderConditionRow(o, t, h);
            }));
        let c = e.createDiv({ cls: "explorer2-filter-group-controls" }),
            i = c.createEl("button", { cls: "mod-cta" });
        ((i.textContent = "Add condition"),
            i.addEventListener("click", () => {
                (l.push(this.createEmptyCondition()), this.renderRules());
            }));
        let f = c.createEl("button", { cls: "mod-ghost" });
        ((f.textContent = "Add group"),
            f.addEventListener("click", () => {
                (l.push({ type: "group", match: "all", rules: [] }),
                    this.renderRules());
            }));
    }
    renderConditionRow(e: any, t: any, n: any) {
        let r = e.createDiv({ cls: "explorer2-filter-condition" });
        this.ruleDomMap.set(n, r);
        let a = r.createEl("select", { cls: "explorer2-filter-select" }),
            allOptions = [
                ["frontmatter", "Frontmatter", ["file"]],
                ["tag", "Tag", ["file"]],
                ["folder", "Folder", ["file", "folder"]],
                ["folder-filter", "Folder contains filter", ["file", "folder"]],
                ["path", "Path", ["file", "folder"]],
                ["date", "Date", ["file"]],
                ["body", "Body content", ["file"]],
                ["foldername", "Folder Name", ["file", "folder"]],
                ["note-count", "Note Count", ["folder"]],
                ["created", "Created time", ["file", "folder"]],
                ["modified", "Modified time", ["file", "folder"]],
                ["backlinks", "Backlinks", ["file"]],
                ["embeds", "Embeds", ["file"]],
            ],
            s = allOptions.filter(opt => {
                // Filter modals are primarily for File filters, so show all file-compatible sources
                const contexts = opt[2] as string[];
                return contexts.includes("file") || contexts.includes("folder"); // Show folder options too as they can apply to file's parent
            }).map(opt => [opt[0], opt[1]]),
            l = (n.source || "").toLowerCase();
        if (l && !s.some(([w]) => w === l)) {
            let w = n.source.replace(/^\w/, (g: string) => g.toUpperCase());
            s.splice(3, 0, [l, w]);
        }
        (s.forEach(([w, g]) => {
            let x = a.createEl("option");
            ((x.value = w as string), (x.text = g as string));
        }),
            (a.value = (n.source || "frontmatter").toLowerCase()));
        let o = r.createEl("input", {
            cls: "explorer2-filter-input explorer2-filter-input-field",
        }),
            c = r.createEl("select", { cls: "explorer2-filter-select" }),
            i = r.createEl("input", {
                cls: "explorer2-filter-input explorer2-filter-input-value",
            }),
            filterSelect = r.createEl("select", {
                cls: "explorer2-filter-select",
            }) as HTMLSelectElement;
        filterSelect.style.display = "none";
        filterSelect.disabled = true;
        const f = () => {
            o.placeholder = this.getFieldPlaceholder(a.value);
        },
            h = () => {
                i.placeholder = this.getValuePlaceholder(a.value, c.value);
            },
            b = () => {
                const w = (a.value || "").toLowerCase(),
                    g = (c.value || "").toLowerCase();
                if (w === "folder-filter") {
                    i.disabled = true;
                    return;
                }
                const x = !(
                    ["backlinks", "embeds"].includes(w) &&
                    ["exists", "!exists"].includes(g)
                );
                if (!x) {
                    (i.value = ""), (n.value = "");
                }
                i.disabled = !x;
            },
            F = () => {
                c.empty();
                let w = this.getOperatorsForSource(a.value);
                w.forEach(({ value: x, label: T }) => {
                    let L = c.createEl("option");
                    ((L.value = x), (L.text = T));
                });
                let g = w.some((x) => x.value === n.operator)
                    ? n.operator
                    : w[0].value;
                c.value = g;
                n.operator = g;
                h();
            },
            updateFolderFilterSelection = () => {
                const source = (a.value || "").toLowerCase();
                const isFolderFilter = source === "folder-filter";
                filterSelect.style.display = isFolderFilter ? "" : "none";
                filterSelect.disabled = !isFolderFilter;
                if (!isFolderFilter) return;
                const existingId =
                    n.filterId ||
                    (Array.isArray(n.value) ? n.value[0] : n.value) ||
                    "";
                if (
                    existingId &&
                    Array.from(filterSelect.options).some((opt) => opt.value === existingId)
                ) {
                    filterSelect.value = existingId;
                    n.filterId = existingId;
                    n.value = existingId;
                } else {
                    filterSelect.value = "";
                    n.filterId = "";
                    n.value = "";
                }
            },
            refreshFilterOptions = () => {
                filterSelect.empty();
                const placeholder = filterSelect.createEl("option") as HTMLOptionElement;
                (placeholder.value = ""), (placeholder.textContent = "Select a filter");
                const filters = this.plugin.getFilterDefinitions();
                filters.forEach((filter: any) => {
                    const opt = filterSelect.createEl("option") as HTMLOptionElement;
                    (opt.value = filter.id), (opt.textContent = filter.name);
                });
                updateFolderFilterSelection();
            };
        filterSelect.addEventListener("change", (evt) => {
            const chosen =
                ((evt.target as HTMLSelectElement)?.value ?? "") || "";
            if (chosen) {
                n.filterId = chosen;
                n.value = chosen;
            } else {
                n.filterId = "";
                n.value = "";
            }
        });
        refreshFilterOptions();
        (F(),
            f(),
            h(),
            b(),
            (o.value = n.field || ""),
            (i.value = Array.isArray(n.value)
                ? n.value.join(", ")
                : n.value != null
                    ? String(n.value)
                    : ""));
        let d = () => {
            let w = (a.value || "frontmatter").toLowerCase(),
                g = w === "frontmatter" || w === "date" || w === "backlinks",
                isFolderFilter = w === "folder-filter";
            const showField = g && !isFolderFilter;
            r.classList.toggle("no-field", !showField);
            (o.style.display = showField ? "" : "none"),
                (o.disabled = !showField),
                showField ||
                (["folder", "path"].includes(w) &&
                    n.field &&
                    (!n.value || (Array.isArray(n.value) && n.value.length === 0)) &&
                    ((n.value = n.field),
                        (i.value = Array.isArray(n.value)
                            ? n.value.join(", ")
                            : String(n.value))),
                    (o.value = ""),
                    (n.field = ""));
            (c.style.display = isFolderFilter ? "none" : ""),
                (c.disabled = isFolderFilter),
                (i.style.display = isFolderFilter ? "none" : "");
            if (isFolderFilter) i.disabled = true;
            updateFolderFilterSelection();
        };
        (d(),
            a.addEventListener("change", (w: any) => {
                ((n.source = w.target.value),
                    !["date", "created", "modified"].includes(n.source) &&
                    ["before", "after", "on", "!on", ">=", "<="].includes(
                        n.operator,
                    ) &&
                    (n.operator = "is"),
                    F(),
                    f(),
                    h(),
                    b(),
                    d());
            }),
            o.addEventListener("input", (w: any) => {
                n.field = w.target.value.trim();
            }),
            c.addEventListener("change", (w: any) => {
                ((n.operator = w.target.value), h(), b());
            }),
            i.addEventListener("input", (w: any) => {
                let g = w.target.value,
                    x = g.includes(",")
                        ? g
                            .split(",")
                            .map((T: string) => T.trim())
                            .filter(Boolean)
                        : g.trim();
                n.value = x;
            }));
        let m = r.createEl("button", { cls: "explorer2-danger" });
        ((m.textContent = "Remove"),
            m.addEventListener("click", () => {
                let w = t.rules || [],
                    g = w.indexOf(n);
                g !== -1 && (w.splice(g, 1), this.renderRules());
            }));
    }
    getFieldPlaceholder(e: any) {
        switch ((e || "frontmatter").toLowerCase()) {
            case "tag":
                return "#project";
            case "folder":
                return "";
            case "path":
                return "";
            case "date":
                return "scheduled";
            case "backlinks":
                return "parent";
            default:
                return "status";
        }
    }
    getValuePlaceholder(e: any, t: any) {
        let n = (e || "frontmatter").toLowerCase();
        return n === "date" || n === "created" || n === "modified"
            ? t === "matches"
                ? "YYYY-MM-DD"
                : "today +1 week"
            : n === "tag"
                ? "project"
                : n === "folder" || n === "path"
                    ? "01 Action Items"
                    : n === "backlinks" || n === "embeds"
                        ? ""
                        : t === "matches"
                            ? "regex"
                            : "value";
    }
    clearValidationMarkers() {
        if (this.ruleDomMap)
            for (let e of this.ruleDomMap.values())
                e.classList.remove("is-invalid");
        if (this.groupDomMap)
            for (let e of this.groupDomMap.values())
                e.classList.remove("is-invalid");
    }
    applyValidationMarkers(e: any) {
        (e.invalidRules &&
            this.ruleDomMap &&
            e.invalidRules.forEach((t: any) => {
                let n = this.ruleDomMap.get(t);
                n && n.classList.add("is-invalid");
            }),
            e.invalidGroups &&
            this.groupDomMap &&
            e.invalidGroups.forEach((t: any) => {
                let n = this.groupDomMap.get(t);
                n && n.classList.add("is-invalid");
            }));
    }
    validateFilterStructure() {
        let e = new Set(),
            t = new Set(),
            n = !1,
            r = (o: any) => {
                let c = (o.operator || "").toLowerCase();
                return !["exists", "!exists"].includes(c);
            },
            a = (o: any) => {
                let c = Array.isArray(o.rules) ? o.rules : [];
                (c.length || t.add(o),
                    c.forEach((i: any) => {
                        if (i.type === "group") a(i);
                        else {
                            n = !0;
                            let f = (i.source || "frontmatter").toLowerCase();
                            if (
                                ((f === "frontmatter" || f === "date") &&
                                    !i.field &&
                                    e.add(i),
                                    r(i))
                            ) {
                                let b = i.value;
                                (Array.isArray(b)
                                    ? b.length > 0
                                    : b != null && String(b).trim() !== "") || e.add(i);
                            }
                        }
                    }));
            };
        (a(this.filter), n || t.add(this.filter));
        let s = e.size === 0 && t.size === 0,
            l = [];
        return (
            t.size && l.push("Each group needs at least one rule."),
            e.size && l.push("Fill in all highlighted fields."),
            { ok: s, invalidRules: e, invalidGroups: t, message: l.join(" ") || "" }
        );
    }
    getOperatorsForSource(e: any) {
        e = (e || "").toLowerCase();
        let t = [
            { value: "is", label: "is" },
            { value: "!is", label: "is not" },
            { value: "contains", label: "contains" },
            { value: "!contains", label: "does not contain" },
            { value: "starts", label: "starts with" },
            { value: "ends", label: "ends with" },
            { value: "matches", label: "matches regex" },
            { value: "exists", label: "exists" },
            { value: "!exists", label: "missing" },
        ];
        return e === "date"
            ? [
                { value: "before", label: "before" },
                { value: "after", label: "after" },
                { value: "on", label: "on" },
                { value: "!on", label: "not on" },
                { value: ">=", label: "on or after" },
                { value: "<=", label: "on or before" },
                { value: "exists", label: "exists" },
                { value: "!exists", label: "missing" },
            ]
            : e === "created" || e === "modified"
                ? [
                    { value: "before", label: "before" },
                    { value: "after", label: "after" },
                    { value: "on", label: "on" },
                    { value: "!on", label: "not on" },
                    { value: ">=", label: "on or after" },
                    { value: "<=", label: "on or before" },
                    { value: "exists", label: "exists" },
                    { value: "!exists", label: "missing" },
                ]
                : e === "backlinks"
                    ? [
                        { value: "exists", label: "has backlinks" },
                        { value: "!exists", label: "no backlinks" },
                    ]
                    : e === "embeds"
                        ? [
                            { value: "exists", label: "contains embeds" },
                            { value: "!exists", label: "no embeds" },
                        ]
                        : e === "tag"
                            ? [
                                { value: "is", label: "is" },
                                { value: "!is", label: "is not" },
                                { value: "contains", label: "contains" },
                                { value: "!contains", label: "does not contain" },
                            ]
                            : e === "note-count"
                                ? [
                                    { value: ">", label: "greater than" },
                                    { value: "<", label: "less than" },
                                    { value: "equals", label: "equals" },
                                    { value: "notequals", label: "not equals" },
                                    { value: ">=", label: "greater or equal" },
                                    { value: "<=", label: "less or equal" },
                                ]
                                : t;
    }
    createEmptyCondition() {
        return {
            type: "condition",
            source: "frontmatter",
            field: "status",
            operator: "is",
            value: "",
        };
    }
    removeGroup(root: any, target: any) {
        if (root === target) return false;
        if (root.rules) {
            const idx = root.rules.indexOf(target);
            if (idx !== -1) {
                root.rules.splice(idx, 1);
                return true;
            }
            for (const child of root.rules) {
                if (child.type === "group") {
                    if (this.removeGroup(child, target)) return true;
                }
            }
        }
        return false;
    }

}
