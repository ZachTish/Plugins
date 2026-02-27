
import { Modal, Setting, FuzzySuggestModal, setIcon, getIconIds, Notice, App } from "obsidian";
import * as logger from "./logger";
import { normalizeBuilderDefinition, createBuilderId, STYLE_CATEGORIES } from "./normalizers";
import { createRuleCondition, getRuleSources, getRuleOperatorsForSource, getRuleValuePlaceholder } from "./rule-helpers";

export class VisualBuilderModal extends Modal {
    plugin: any;
    declare scope: any;
    title: any;
    description: any;
    activeService: any;
    pendingBuilders: any;
    builderHost: HTMLElement | null = null;
    builder: any;

    constructor(app: App, plugin: any, options: { scope: any, title: any, description: any }) {
        super(app);
        this.plugin = plugin;
        this.scope = options.scope;
        this.title = options.title;
        this.description = options.description;
        this.activeService = "icon";
        this.pendingBuilders = new Map();
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        this.titleEl.setText(this.title);

        contentEl.createEl("p", { text: this.description, cls: "setting-item-description" });

        // Tabs
        const tabContainer = contentEl.createDiv({ cls: "explorer2-builder-tabs" });
        tabContainer.style.display = "flex";
        tabContainer.style.gap = "0";
        tabContainer.style.marginBottom = "15px";
        tabContainer.style.borderBottom = "1px solid var(--background-modifier-border)";

        ["icon", "color", "text"].forEach(service => {
            const isActive = this.activeService === service;
            const tab = tabContainer.createDiv({
                text: service.charAt(0).toUpperCase() + service.slice(1) + " Rules",
                cls: "explorer2-builder-tab"
            });
            tab.style.padding = "8px 16px";
            tab.style.cursor = "pointer";
            tab.style.fontWeight = isActive ? "bold" : "normal";
            tab.style.borderBottom = isActive ? "2px solid var(--interactive-accent)" : "2px solid transparent";
            tab.style.color = isActive ? "var(--text-normal)" : "var(--text-muted)";
            tab.style.transition = "all 0.1s ease-in-out";

            tab.addEventListener("mouseover", () => {
                if (!isActive) tab.style.color = "var(--text-normal)";
            });
            tab.addEventListener("mouseout", () => {
                if (!isActive) tab.style.color = "var(--text-muted)";
            });

            tab.addEventListener("click", () => {
                if (this.activeService === service) return;
                // Switch tab only, state is preserved in pendingBuilders
                this.activeService = service;
                this.renderBuilderContent();
                this.updateTabs(tabContainer);
            });
        });

        this.builderHost = contentEl.createDiv({ cls: "explorer2-builder-host" });
        this.renderBuilderContent();

        const btnContainer = contentEl.createDiv({ cls: "explorer2-builder-buttons" });
        btnContainer.style.display = "flex";
        btnContainer.style.justifyContent = "flex-end";
        btnContainer.style.marginTop = "20px";
        btnContainer.style.gap = "10px";

        // Save Button
        const saveBtn = btnContainer.createEl("button", { text: "Save", cls: "mod-cta" });
        saveBtn.addEventListener("click", async () => {
            await this.saveAll();
            this.close();
        });

        // Close Button (Cancel)
        const closeBtn = btnContainer.createEl("button", { text: "Close" });
        closeBtn.addEventListener("click", () => {
            this.close();
        });
    }

    updateTabs(container: HTMLElement) {
        const tabs = container.querySelectorAll(".explorer2-builder-tab");
        tabs.forEach((tab, index) => {
            const service = ["icon", "color", "text"][index];
            const isActive = this.activeService === service;
            (tab as HTMLElement).style.fontWeight = isActive ? "bold" : "normal";
            (tab as HTMLElement).style.borderBottom = isActive ? "2px solid var(--interactive-accent)" : "2px solid transparent";
            (tab as HTMLElement).style.color = isActive ? "var(--text-normal)" : "var(--text-muted)";
        });
    }

    getPendingBuilder(service: string) {
        if (!this.pendingBuilders.has(service)) {
            // Deep clone the existing settings so we don't mutate them directly
            const original = this.plugin.getBuilderDefinition(service, { scope: this.scope }) || normalizeBuilderDefinition({});
            try {
                this.pendingBuilders.set(service, JSON.parse(JSON.stringify(original)));
            } catch (e) {
                console.error("Failed to clone builder", e);
                this.pendingBuilders.set(service, normalizeBuilderDefinition({}));
            }
        }
        return this.pendingBuilders.get(service);
    }

    renderBuilderContent() {
        if (!this.builderHost) return;
        this.builderHost.empty();
        this.builder = this.getPendingBuilder(this.activeService);

        new RuleBuilderRenderer({
            app: this.app,
            container: this.builderHost,
            root: this.builder,
            serviceType: this.activeService,
            scope: this.scope,
            onRender: (builder: any) => {
                this.builder = builder;
                // Update the pending map reference just in case
                this.pendingBuilders.set(this.activeService, builder);
            },
        });
    }

    async saveAll() {
        for (const [service, builder] of this.pendingBuilders) {
            if (STYLE_CATEGORIES.includes(service)) {
                const scope = this.scope === "folder" ? "folder" : "file";
                let profileId = this.plugin.getAssignedProfileId(service, {});
                let profile = profileId ? this.plugin.getStyleProfile(service, profileId) : null;

                if (!profile) {
                    const created = this.plugin.upsertStyleProfile(service, {
                        id: `${service}-${createBuilderId()}`,
                        name: `${service} default`,
                        builder: normalizeBuilderDefinition({}),
                        folderBuilder: normalizeBuilderDefinition({}),
                    });
                    profileId = created?.id;
                    if (profileId) {
                        this.plugin.setStyleAssignment("default", "default", service, profileId);
                        profile = this.plugin.getStyleProfile(service, profileId);
                    }
                }

                if (profile) {
                    const nextProfile = {
                        ...profile,
                        builder: normalizeBuilderDefinition(profile.builder || {}),
                        folderBuilder: normalizeBuilderDefinition(profile.folderBuilder || {}),
                    };

                    if (scope === "folder") {
                        nextProfile.folderBuilder = normalizeBuilderDefinition(builder || {});
                    } else {
                        nextProfile.builder = normalizeBuilderDefinition(builder || {});
                    }
                    this.plugin.upsertStyleProfile(service, nextProfile);
                }
                continue;
            }

            // For default scope, we need to save to the default builder
            // scope is like "default", "file", "folder", etc.
            // For default, key doesn't matter, but we pass "default" for clarity
            const key = this.scope === "default" ? "default" : this.scope;
            this.plugin.setBuilderOverride(service, this.scope, key, builder);
        }
        await this.plugin.savePluginState();
        this.plugin.refreshAllExplorer2();
        new Notice("Visual styles saved");
    }

    onClose() {
        if (this.builderHost) this.builderHost.empty();
        this.pendingBuilders.clear();
    }
}

export class RuleBuilderRenderer {
    app: any;
    container: any;
    root: any;
    serviceType: any;
    scope: string | null;
    onRender: any;
    ruleDomMap: any;
    groupDomMap: any;
    expandedGroups: any;

    constructor({ app, container, root = {}, serviceType, scope = null, onRender = null }: any) {
        (this.app = app),
            (this.container = container),
            (this.root = normalizeBuilderDefinition(root)),
            (this.serviceType = serviceType),
            (this.scope = scope),
            (this.onRender = onRender),
            (this.ruleDomMap = new Map()),
            (this.groupDomMap = new Map()),
            (this.expandedGroups = new Set()),
            this.expandedGroups.add(this.root),
            this.render();
    }
    render() {
        if (!this.container) return;
        (this.container.empty(),
            (this.ruleDomMap = new Map()),
            (this.groupDomMap = new Map()));
        let wrapper = this.container.createDiv({ cls: "explorer2-filter-rule-group" });
        this.renderRuleGroup(wrapper, this.root, !0, 0);
        this.emitRender();
    }
    emitRender() {
        typeof this.onRender == "function" && this.onRender(this.root);
    }
    renderRuleGroup(e: HTMLElement, t: any, n = !1, depth = 0, groupRules: any = null, index = -1) {
        this.groupDomMap.set(t, e);
        e.dataset.depth = String(depth);
        let header = e.createDiv({ cls: "explorer2-filter-group-header" });

        let arrow = header.createDiv({ cls: "explorer2-filter-group-arrow" });
        arrow.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

        if (n) {
            let title = header.createDiv({ text: "Root Logic", cls: "explorer2-group-name-static" });
            (title as HTMLElement).style.fontWeight = "bold";
            (title as HTMLElement).style.paddingLeft = "8px";
        } else {
            let nameInput = header.createEl("input", {
                type: "text",
                cls: "explorer2-group-name-input",
                placeholder: "Group Name",
                value: t.name || ""
            });
            nameInput.addEventListener("click", (evt) => evt.stopPropagation());
            nameInput.addEventListener("change", (evt) => {
                t.name = (evt.target as HTMLInputElement).value;
            });
        }

        if (t.visualValue) {
            let miniPreview = header.createDiv({ cls: "explorer2-mini-preview" });
            if (this.serviceType === "icon") {
                setIcon(miniPreview, t.visualValue);
            } else if (this.serviceType === "color") {
                miniPreview.style.backgroundColor = t.visualValue;
            }
        }

        const spacer = header.createDiv();
        spacer.style.flex = "1";

        if (!n) {
            if (groupRules && index !== -1) {
                const moveUp = header.createEl("button", {
                    cls: "explorer2-icon-button",
                    attr: { "aria-label": "Move up" }
                });
                moveUp.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"></polyline></svg>`;
                moveUp.style.marginRight = "4px";
                moveUp.disabled = index === 0;
                moveUp.addEventListener("click", (evt) => {
                    evt.stopPropagation();
                    if (index > 0) {
                        [groupRules[index], groupRules[index - 1]] = [groupRules[index - 1], groupRules[index]];
                        this.render();
                    }
                });

                const moveDown = header.createEl("button", {
                    cls: "explorer2-icon-button",
                    attr: { "aria-label": "Move down" }
                });
                moveDown.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
                moveDown.style.marginRight = "8px";
                moveDown.disabled = index === groupRules.length - 1;
                moveDown.addEventListener("click", (evt) => {
                    evt.stopPropagation();
                    if (index < groupRules.length - 1) {
                        [groupRules[index], groupRules[index + 1]] = [groupRules[index + 1], groupRules[index]];
                        this.render();
                    }
                });
            }

            let remove = header.createEl("button", {
                cls: "explorer2-icon-button explorer2-danger-icon",
                attr: { "aria-label": "Remove group" }
            });
            remove.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
            remove.addEventListener("click", (evt) => {
                evt.stopPropagation();
                this.removeGroup(this.root, t) && this.render();
            });
        }

        let body = e.createDiv({ cls: "explorer2-filter-group-body" });

        const isExpanded = this.expandedGroups.has(t);
        if (!isExpanded) {
            arrow.classList.add("is-collapsed");
            body.classList.add("is-collapsed");
        }

        header.addEventListener("click", (evt) => {
            if ((evt.target as HTMLElement).closest("button") || (evt.target as HTMLElement).tagName === "INPUT") return;
            if (this.expandedGroups.has(t)) {
                this.expandedGroups.delete(t);
                arrow.classList.add("is-collapsed");
                body.classList.add("is-collapsed");
            } else {
                this.expandedGroups.add(t);
                arrow.classList.remove("is-collapsed");
                body.classList.remove("is-collapsed");
            }
        });

        if (["icon", "color", "text"].includes(this.serviceType)) {
            let visualSection = body.createDiv({ cls: "explorer2-section" });
            visualSection.createDiv({ cls: "explorer2-section-title", text: "Apply this style:" });

            if (this.serviceType === "icon") {
                let row = visualSection.createDiv({ cls: "explorer2-visual-row" });

                // --- Added Grouping Check ---
                const displayValuePicker = depth === 1;

                if (!displayValuePicker && n) { // n is isRoot
                    row.createEl("span", { text: "Grouping only", cls: "explorer2-text-muted" });
                } else {
                    const iconContainer = row.createDiv({ cls: "explorer2-icon-picker-container" });
                    const preview = iconContainer.createDiv({ cls: "explorer2-icon-preview" }); // Matches other builder style
                    const allIcons = getIconIds().sort();

                    // Search Input
                    const searchInput = iconContainer.createEl("input", {
                        cls: "explorer2-filter-input explorer2-filter-input-field",
                        placeholder: "Search icon...",
                        value: t.visualValue || ""
                    });

                    // Suggestions Container
                    const suggestions = iconContainer.createDiv({
                        cls: "explorer2-icon-suggestions",
                        attr: { style: "display: none;" }
                    });

                    const updatePreview = (val: string) => {
                        preview.empty();
                        if (val) {
                            try { setIcon(preview, val); }
                            catch { preview.textContent = "?"; }
                        }
                    };

                    const showSuggestions = (query: string) => {
                        suggestions.empty();
                        const lower = query.toLowerCase();
                        const matches = allIcons.filter(id => id.toLowerCase().includes(lower)).slice(0, 50);

                        if (matches.length === 0) {
                            (suggestions as HTMLElement).style.display = "none";
                            return;
                        }

                        (suggestions as HTMLElement).style.display = "block";
                        matches.forEach(id => {
                            const item = suggestions.createDiv({ cls: "explorer2-icon-suggestion-item" });
                            const iconDiv = item.createDiv({ cls: "explorer2-icon-suggestion-icon" });
                            setIcon(iconDiv, id);
                            item.createSpan({ text: id });

                            item.addEventListener("click", () => {
                                t.visualValue = id;
                                searchInput.value = id;
                                updatePreview(id);
                                (suggestions as HTMLElement).style.display = "none";
                            });
                        });
                    };

                    updatePreview(t.visualValue);

                    searchInput.addEventListener("input", (e) => {
                        const val = (e.target as HTMLInputElement).value;
                        showSuggestions(val);
                    });

                    searchInput.addEventListener("focus", () => {
                        showSuggestions(searchInput.value);
                    });

                    // Hide suggestions when clicking outside
                    document.addEventListener("click", (e) => {
                        if (!iconContainer.contains(e.target as Node)) {
                            (suggestions as HTMLElement).style.display = "none";
                        }
                    });
                }
            } else if (this.serviceType === "color") {
                let row = visualSection.createDiv({ cls: "explorer2-visual-row" });
                row.createEl("span", { text: "Color:" });
                let colorInput = row.createEl("input", {
                    type: "color",
                    cls: "explorer2-color-input"
                });
                colorInput.value = t.visualValue || "#000000";
                colorInput.addEventListener("change", (e) => {
                    t.visualValue = (e.target as HTMLInputElement).value;
                });
            } else if (this.serviceType === "text") {
                let row = visualSection.createDiv({ cls: "explorer2-visual-row" });
                // Style toggles
                const styles = [
                    { key: "bold", label: "Bold" },
                    { key: "italic", label: "Italic" },
                    { key: "strikethrough", label: "Strikethrough" },
                    { key: "uppercase", label: "UPPER" },
                    { key: "faded", label: "Faded" }
                ];

                if (!t.visualValue) t.visualValue = {};
                if (typeof t.visualValue !== 'object') t.visualValue = {};

                styles.forEach(style => {
                    const btn = row.createEl("button", { cls: "explorer2-style-toggle-btn" });
                    if (t.visualValue[style.key]) btn.classList.add("is-active");
                    btn.setText(style.label);

                    btn.addEventListener("click", () => {
                        t.visualValue[style.key] = !t.visualValue[style.key];
                        if (t.visualValue[style.key]) btn.classList.add("is-active");
                        else btn.classList.remove("is-active");
                    });
                });
            }
        }

        // Sort configuration section (only for sort service type)
        if (this.serviceType === "sort") {
            let sortSection = body.createDiv({ cls: "explorer2-section" });
            sortSection.createDiv({ cls: "explorer2-section-title", text: "Sort by:" });

            // Ensure sort array exists
            if (!t.sort || !Array.isArray(t.sort)) {
                t.sort = [{ keyType: "name", dir: "asc", key: "", customOrder: [] }];
            }

            const sortLevelsContainer = sortSection.createDiv({ cls: "explorer2-sort-levels" });

            const renderSortLevels = () => {
                sortLevelsContainer.empty();

                t.sort.forEach((sortDef: any, sortIdx: number) => {
                    const sortRow = sortLevelsContainer.createDiv({ cls: "explorer2-sort-row" });
                    sortRow.style.display = "flex";
                    sortRow.style.gap = "8px";
                    sortRow.style.alignItems = "center";
                    sortRow.style.marginBottom = "8px";
                    sortRow.style.flexWrap = "wrap";

                    if (sortIdx > 0) {
                        sortRow.createSpan({ text: "then by", cls: "explorer2-sort-then" });
                    }

                    // Sort type dropdown
                    const typeSelect = sortRow.createEl("select", { cls: "dropdown" });
                    [
                        { value: "name", label: "Name" },
                        { value: "created", label: "Created date" },
                        { value: "modified", label: "Modified date" },
                        { value: "frontmatter", label: "Frontmatter field" },
                        { value: "frontmatter-date", label: "Frontmatter Date" },
                    ].forEach(opt => {
                        const option = typeSelect.createEl("option", { value: opt.value, text: opt.label });
                        option.selected = sortDef.keyType === opt.value;
                    });
                    typeSelect.addEventListener("change", (evt) => {
                        sortDef.keyType = (evt.target as HTMLSelectElement).value;
                        if (sortDef.keyType !== "frontmatter" && sortDef.keyType !== "frontmatter-date") sortDef.key = "";
                        renderSortLevels();
                        // No need to call updateLocalDirOptions here because renderSortLevels re-runs everything
                    });

                    // Field input (only for frontmatter or frontmatter-date)
                    if (sortDef.keyType === "frontmatter" || sortDef.keyType === "frontmatter-date") {
                        const fieldInput = sortRow.createEl("input", {
                            type: "text",
                            cls: "explorer2-sort-field-input",
                            placeholder: "field name (e.g. scheduled)",
                            value: sortDef.key || ""
                        });
                        fieldInput.style.minWidth = "140px";
                        fieldInput.addEventListener("input", (evt) => {
                            sortDef.key = (evt.target as HTMLInputElement).value;
                            updateLocalDirOptions();
                        });

                        const customOrderInput = sortRow.createEl("input", {
                            type: "text",
                            cls: "explorer2-sort-field-input",
                            placeholder: "Custom order (comma separated)",
                            value: Array.isArray(sortDef.customOrder) ? sortDef.customOrder.join(", ") : ""
                        });
                        customOrderInput.style.flex = "1";
                        customOrderInput.style.minWidth = "180px";
                        customOrderInput.addEventListener("change", (evt) => {
                            const val = (evt.target as HTMLInputElement).value;
                            sortDef.customOrder = val.split(",").map(s => s.trim()).filter(Boolean);
                            updateLocalDirOptions();
                        });
                    }

                    // Direction dropdown
                    const dirSelect = sortRow.createEl("select", { cls: "dropdown" });

                    const updateLocalDirOptions = () => {
                        const currentVal = dirSelect.value || sortDef.dir || "asc";
                        dirSelect.empty();

                        let ascLabel = "Ascending";
                        let descLabel = "Descending";

                        if (sortDef.keyType === "created" || sortDef.keyType === "modified" || sortDef.keyType === "frontmatter-date") {
                            ascLabel = "Old to New";
                            descLabel = "New to Old";
                        } else if (sortDef.keyType === "frontmatter") {
                            // Check custom order first
                            if (sortDef.customOrder && sortDef.customOrder.length > 0) {
                                ascLabel = "Custom Order";
                                descLabel = "Reverse Custom Order";
                            }
                        }

                        [
                            { value: "asc", label: ascLabel },
                            { value: "desc", label: descLabel },
                        ].forEach(opt => {
                            const option = dirSelect.createEl("option", { value: opt.value, text: opt.label });
                            option.selected = currentVal === opt.value;
                        });
                    };

                    updateLocalDirOptions();

                    dirSelect.addEventListener("change", (evt) => {
                        sortDef.dir = (evt.target as HTMLSelectElement).value;
                    });

                    // Remove button (only if more than one sort level)
                    if (t.sort.length > 1) {
                        const removeBtn = sortRow.createEl("button", {
                            cls: "explorer2-icon-button explorer2-danger-icon",
                            attr: { "aria-label": "Remove sort level" }
                        });
                        removeBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
                        removeBtn.addEventListener("click", () => {
                            t.sort.splice(sortIdx, 1);
                            renderSortLevels();
                        });
                    }
                });

                // Add sort level button
                const addSortBtn = sortLevelsContainer.createEl("button", { text: "+ Add sort level", cls: "explorer2-add-sort-btn" });
                addSortBtn.style.marginTop = "4px";
                addSortBtn.addEventListener("click", () => {
                    t.sort.push({ keyType: "name", dir: "asc", key: "", customOrder: [] });
                    renderSortLevels();
                });
            };

            renderSortLevels();
        }

        let logicSection = body.createDiv({ cls: "explorer2-section" });
        logicSection.createDiv({ cls: "explorer2-section-title", text: "Rules:" });

        let matchRow = logicSection.createDiv({ cls: "explorer2-match-row" });
        matchRow.createSpan({ text: "Match" });
        let matchSelect = matchRow.createEl("select", { cls: "dropdown" });
        ["all", "any", "none"].forEach((o) => {
            let opt = matchSelect.createEl("option", { value: o, text: o });
            opt.selected = t.match === o;
        });
        matchSelect.addEventListener("change", (evt) => {
            t.match = (evt.target as HTMLSelectElement).value;
        });
        matchRow.createSpan({ text: "of the following:" });

        let rulesContainer = logicSection.createDiv({ cls: "explorer2-rules-container" });

        if (t.rules && Array.isArray(t.rules)) {
            t.rules.forEach((child: any, idx: number) => {
                if (child.type === "group") {
                    let childWrapper = rulesContainer.createDiv({ cls: "explorer2-filter-rule-group" });
                    this.renderRuleGroup(childWrapper, child, false, depth + 1, t.rules, idx);
                } else {
                    let ruleRow = rulesContainer.createDiv({ cls: "explorer2-rule-row" });
                    this.renderConditionRow(ruleRow, child, t.rules, idx);
                }
            });
        }

        let actionsRow = logicSection.createDiv({ cls: "explorer2-actions-row" });
        let addRuleBtn = actionsRow.createEl("button", { text: "+ Condition" });
        addRuleBtn.addEventListener("click", () => {
            if (!t.rules) t.rules = [];
            t.rules.push(createRuleCondition());
            this.render();
        });

        let addGroupBtn = actionsRow.createEl("button", { text: "+ Group" });
        addGroupBtn.addEventListener("click", () => {
            if (!t.rules) t.rules = [];
            t.rules.push({
                type: "group",
                name: "New Group",
                match: "all",
                rules: [],
                id: createBuilderId()
            });
            this.render();
        });
    }

    renderConditionRow(container: HTMLElement, condition: any, parentRules: any[], index: number) {
        // Source
        let sourceSelect = container.createEl("select", { cls: "dropdown" });
        getRuleSources(this.scope).forEach((s) => {
            let opt = sourceSelect.createEl("option", { value: s.value, text: s.label });
            opt.selected = condition.source === s.value;
        });
        sourceSelect.addEventListener("change", (e) => {
            condition.source = (e.target as HTMLSelectElement).value;
            const nextOps = getRuleOperatorsForSource(condition.source);
            condition.operator = nextOps[0]?.value || "contains";
            condition.value = "";
            this.render();
        });

        // Field (for frontmatter and property-scoped backlinks)
        if (condition.source === "frontmatter" || condition.source === "backlinks") {
            let fieldInput = container.createEl("input", {
                type: "text",
                cls: "explorer2-filter-input-field",
                placeholder: condition.source === "backlinks" ? "parent" : "key",
                value: condition.field || ""
            });
            fieldInput.addEventListener("change", (e) => {
                condition.field = (e.target as HTMLInputElement).value;
            });
            fieldInput.addEventListener("input", (e) => {
                condition.field = (e.target as HTMLInputElement).value;
            });
        }

        // Operator
        const operatorOptions = getRuleOperatorsForSource(condition.source);
        const operatorValues = new Set(operatorOptions.map((op) => op.value));
        if (!operatorValues.has(condition.operator)) {
            condition.operator = operatorOptions[0]?.value || "contains";
        }
        let opSelect = container.createEl("select", { cls: "dropdown" });
        operatorOptions.forEach((op) => {
            let opt = opSelect.createEl("option", { value: op.value, text: op.label });
            opt.selected = condition.operator === op.value;
        });
        opSelect.addEventListener("change", (e) => {
            condition.operator = (e.target as HTMLSelectElement).value;
            this.render(); // Re-render in case operator changes value input type? (Not currently, but good practice)
        });

        // Value
        if (!["exists", "!exists", "ondate", "!ondate"].includes(condition.operator)) {
            let valueInput = container.createEl("input", {
                type: "text",
                cls: "explorer2-filter-input-value",
                placeholder: getRuleValuePlaceholder(condition.source, condition.operator),
                value: condition.value || ""
            });
            valueInput.addEventListener("change", (e) => {
                condition.value = (e.target as HTMLInputElement).value;
            });
            valueInput.addEventListener("input", (e) => {
                condition.value = (e.target as HTMLInputElement).value;
            });
        }

        // Delete
        let delBtn = container.createEl("button", {
            cls: "explorer2-icon-button explorer2-danger-icon",
            attr: { "aria-label": "Remove condition" }
        });
        delBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        delBtn.addEventListener("click", () => {
            parentRules.splice(index, 1);
            this.render();
        });
    }

    removeGroup(root: any, target: any) {
        if (root === target) return false; // Cannot remove root
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

export class BuilderModal extends Modal {
    plugin: any;
    serviceType: any;
    declare scope: any;
    key: any;
    titleText: any;
    description: any;
    builder: any;
    builderHost: HTMLElement | null = null;
    builderRenderer: any;

    constructor(app: App, plugin: any, options: any = {}) {
        super(app);
        (this.plugin = plugin),
            (this.serviceType = options.serviceType || "sort"),
            (this.scope = options.scope || "sections"),
            (this.key = options.key || ""),
            (this.titleText = options.title || "Configure builder"),
            (this.description =
                options.description ||
                `Define rules that control how ${this.serviceType} is applied.`),
            (this.builder =
                options.builder && typeof options.builder == "object"
                    ? JSON.parse(JSON.stringify(options.builder))
                    : JSON.parse(
                        JSON.stringify(
                            this.plugin.getBuilderOverride(
                                this.serviceType,
                                this.scope,
                                this.key,
                            ) || normalizeBuilderDefinition({}),
                        ),
                    )),
            (this.builder.active = this.builder.active !== false),
            (this.builderHost = null),
            (this.builderRenderer = null);
    }
    onOpen() {
        this.titleEl.setText(this.titleText || "Configure builder"), this.render();
    }
    render() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("explorer2-builder-modal");
        contentEl.createEl("p", {
            cls: "mod-plaintext",
            text: this.description,
        });
        new Setting(contentEl)
            .setName("Active")
            .setDesc("Enable this builder while rendering Explorer 2.")
            .addToggle((t) =>
                t
                    .setValue(this.builder.active)
                    .onChange((e) => {
                        this.builder.active = e;
                    }),
            );
        new Setting(contentEl)
            .setDesc("Reset the rule tree to the empty builder.")
            .addButton((t) =>
                t
                    .setButtonText("Reset builder")
                    .setClass("mod-ghost")
                    .onClick(() => {
                        (this.builder = normalizeBuilderDefinition({})),
                            (this.builder.active = !1),
                            this.renderBuilderHost();
                    }),
            );
        (this.builderHost = contentEl.createDiv({
            cls: "explorer2-builder-host",
        })),
            this.renderBuilderHost();
        const actions = contentEl.createDiv({ cls: "modal-button-row" });
        const save = actions.createEl("button", {
            text: "Save",
            cls: "mod-cta",
        });
        const cancel = actions.createEl("button", { text: "Cancel" });
        save.addEventListener("click", () => {
            this.saveBuilder();
        });
        cancel.addEventListener("click", () => this.close());
    }
    renderBuilderHost() {
        if (!this.builderHost) return;
        this.builderHost.empty();
        this.builderRenderer = new RuleBuilderRenderer({
            app: this.app,
            container: this.builderHost,
            root: this.builder,
            serviceType: this.serviceType,
            onRender: (builder: any) => {
                this.builder = builder;
            },
        });
    }
    async saveBuilder() {
        this.plugin.setBuilderOverride(
            this.serviceType,
            this.scope,
            this.key,
            this.builder,
        );
        try {
            await this.plugin.savePluginState(),
                this.plugin.refreshAllExplorer2(),
                new Notice("Builder saved"),
                this.close();
        } catch (e: any) {
            logger.error("Explorer 2 builder save failed", e),
                new Notice("Unable to save builder");
        }
    }
    onClose() {
        if (this.builderHost) this.builderHost.empty();
    }
}

export class StyleProfileModal extends Modal {
    plugin: any;
    options: any;
    profileId: any;
    onSave: any;
    activeTab: any;
    profile: any;
    builderHost: HTMLElement | null = null;
    builderRenderer: any;

    constructor(app: App, plugin: any, options: any = {}) {
        super(app);
        this.plugin = plugin;
        this.options = options;
        this.profileId = options.profileId || null;
        this.onSave = options.onSave;
        this.activeTab = "file"; // file | folder

        const existing = this.profileId
            ? this.plugin.getStyleProfile(this.options.type, this.profileId)
            : null;

        this.profile = existing
            ? JSON.parse(JSON.stringify(existing))
            : {
                id: `${this.options.type}-${createBuilderId()}`,
                name: "",
                builder: normalizeBuilderDefinition({}),
            };

        // Ensure all builders exist
        this.profile.builder = normalizeBuilderDefinition(this.profile.builder || {});
        this.profile.folderBuilder = normalizeBuilderDefinition(this.profile.folderBuilder || {});
        // Default active state should be true for all
        if (this.profile.builder.active === undefined) this.profile.builder.active = true;
        if (this.profile.folderBuilder.active === undefined) this.profile.folderBuilder.active = true;

        this.builderHost = null;
        this.builderRenderer = null;
    }

    onOpen() {
        const type = this.options.type;
        this.titleEl.setText(`${type[0].toUpperCase()}${type.slice(1)} profile`);
        this.render();
    }

    render() {
        const { contentEl } = this;
        contentEl.empty();

        new Setting(contentEl)
            .setName("Profile name")
            .setDesc("Shown in drop-downs when applying this profile.")
            .addText((text) =>
                text
                    .setPlaceholder("My profile")
                    .setValue(this.profile.name || "")
                    .onChange((value) => {
                        this.profile.name = value.trim();
                    }),
            );

        // Profile Tabs
        const tabContainer = contentEl.createDiv({ cls: "explorer2-builder-tabs" });
        tabContainer.style.display = "flex";
        tabContainer.style.gap = "0";
        tabContainer.style.marginBottom = "15px";
        tabContainer.style.borderBottom = "1px solid var(--background-modifier-border)";

        const tabs = [
            { id: "file", label: "Files" },
            { id: "folder", label: "Folders" },
        ];

        tabs.forEach(tab => {
            const isActive = this.activeTab === tab.id;
            const tabEl = tabContainer.createDiv({
                text: tab.label,
                cls: "explorer2-builder-tab"
            });
            tabEl.style.padding = "8px 16px";
            tabEl.style.cursor = "pointer";
            tabEl.style.fontWeight = isActive ? "bold" : "normal";
            tabEl.style.borderBottom = isActive ? "2px solid var(--interactive-accent)" : "2px solid transparent";
            tabEl.style.color = isActive ? "var(--text-normal)" : "var(--text-muted)";
            tabEl.style.transition = "all 0.1s ease-in-out";

            tabEl.addEventListener("click", () => {
                if (this.activeTab === tab.id) return;
                this.activeTab = tab.id;
                this.render(); // Re-render to update UI
            });
        });

        // Active Toggle for Current Scope
        const currentBuilder = this.getCurrentBuilder();
        new Setting(contentEl)
            .setName(`${tabs.find(t => t.id === this.activeTab)?.label} Rules Active`)
            .setDesc(`Enable/disable rules for ${this.activeTab}s in this profile.`)
            .addToggle((toggle) =>
                toggle
                    .setValue(currentBuilder.active !== false)
                    .onChange((value) => {
                        currentBuilder.active = value;
                    }),
            );

        this.builderHost = contentEl.createDiv({ cls: "explorer2-builder-host" });
        this.renderBuilderHost();

        const actions = contentEl.createDiv({ cls: "modal-button-row" });
        const deleteBtn = actions.createEl("button", { text: "Delete", cls: "explorer2-danger" });
        deleteBtn.addEventListener("click", () => {
            if (confirm("Are you sure you want to delete this profile?")) {
                const profiles = this.plugin.settings.serviceConfig.styleProfiles[this.options.type];
                if (profiles && profiles[this.profileId]) {
                    delete profiles[this.profileId];
                    this.plugin.savePluginState().then(() => {
                        new Notice("Profile deleted");
                        if (this.onSave) this.onSave(null);
                        this.close();
                    });
                }
            }
        });

        const saveBtn = actions.createEl("button", { text: "Save", cls: "mod-cta" });
        const cancelBtn = actions.createEl("button", { text: "Cancel" });
        saveBtn.addEventListener("click", () => this.saveProfile());
        cancelBtn.addEventListener("click", () => this.close());
    }

    getCurrentBuilder() {
        if (this.activeTab === 'folder') return this.profile.folderBuilder;
        return this.profile.builder;
    }

    renderBuilderHost() {
        if (!this.builderHost) return;
        this.builderHost.empty();

        // Determine scope based on active tab
        const scope = this.activeTab;

        this.builderRenderer = new RuleBuilderRenderer({
            app: this.app,
            container: this.builderHost,
            root: this.getCurrentBuilder(),
            serviceType: this.options.type,
            scope: scope, // Pass scope so renderer shows correct sources
            onRender: (builder: any) => {
                if (this.activeTab === 'folder') this.profile.folderBuilder = builder;
                else this.profile.builder = builder;
            },
        });
    }

    async saveProfile() {
        const saved = this.plugin.upsertStyleProfile(this.options.type, this.profile);
        try {
            await this.plugin.savePluginState();
            this.plugin.refreshAllExplorer2();
            if (typeof this.onSave === "function") {
                await this.onSave(saved?.id);
            }
            this.close();
        } catch (e) {
            logger.error("Explorer 2 profile save failed", e);
            new Notice("Unable to save profile");
        }
    }

    onClose() {
        if (this.builderHost) this.builderHost.empty();
    }
}

export class IconPickerModal extends FuzzySuggestModal<string> {
    onChoose: (item: string) => void;

    constructor(app: App, onChoose: (item: string) => void) {
        super(app);
        this.onChoose = onChoose;
    }
    getItems(): string[] {
        return getIconIds();
    }
    getItemText(item: string): string {
        return item;
    }
    renderSuggestion(match: any, el: HTMLElement) {
        const item = match.item || match;
        el.addClass("explorer2-icon-suggestion");
        let iconContainer = el.createDiv({ cls: "explorer2-icon-preview" });
        setIcon(iconContainer, item);
        el.createDiv({ text: item });
    }
    onChooseItem(item: string, evt: MouseEvent | KeyboardEvent) {
        this.onChoose(item);
    }
}
