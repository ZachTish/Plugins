import { Menu, Setting } from "obsidian";
import { SortBucket, SortCriteria, RuleCondition, createDefaultSortCriteria } from "../types";
import {
    createDefaultCondition,
    getConditionValuePlaceholder,
    normalizeConditionSource,
    normalizeRuleMatchMode,
    normalizeSmartOperator,
    parseMappings,
    SettingsSectionContext,
    stringifyMappings
} from "./ui-common";
import { getValidOperators } from "./operators";

let selectedBucketId: string | null = null;
let bucketFilterQuery = "";

const PRIORITY_MAPPING = "high=001, normal=002, low=003";
const STATUS_MAPPING = "open=001, working=002, complete=003, wont-do=004";

export class BucketSectionRenderer {
    private readonly context: SettingsSectionContext;

    constructor(context: SettingsSectionContext) {
        this.context = context;
    }

    render(container: HTMLElement): void {
        const { plugin, bindCommittedText, refresh } = this.context;
        const section = container.createDiv({ cls: "tps-nn-section" });

        section.createEl("h3", { text: "Smart Sort Buckets" });
        section.createEl("p", {
            cls: "setting-item-description",
            text: "Define buckets to group and sort notes. Files match the first bucket whose conditions they meet."
        });
        section.createEl("div", {
            cls: "tps-nn-callout",
            text: "Buckets are evaluated top-to-bottom. Within each bucket, notes are sorted by the defined criteria."
        });

        const preview = plugin.getSmartSortPreviewForActiveFile();
        section.createEl("p", {
            cls: "setting-item-description",
            text: preview ? `Active note key preview: ${preview}` : "Active note key preview: (unavailable)"
        });

        const smartSort = plugin.settings.smartSort;

        new Setting(section)
            .setName("Enable smart sort key")
            .setDesc("Write computed sort key to frontmatter.")
            .addToggle((toggle) => {
                toggle
                    .setValue(smartSort.enabled)
                    .onChange(async (value) => {
                        smartSort.enabled = value;
                        await plugin.saveSettings();
                        await plugin.applyRulesToActiveFile(false);
                        refresh();
                    });
            });

        new Setting(section)
            .setName("Sort key field")
            .setDesc("Frontmatter key for computed sort key.")
            .addText((text) => {
                text.setPlaceholder("navigator_sort");
                bindCommittedText(text, smartSort.field, async (value) => {
                    smartSort.field = value.trim().replace(/\s+/g, "") || "navigator_sort";
                }, false, true);
            });

        new Setting(section)
            .setName("Segment separator")
            .setDesc("Delimiter used to join segments.")
            .addText((text) => {
                text.setPlaceholder("_");
                bindCommittedText(text, smartSort.separator, async (value) => {
                    const trimmed = value.trim();
                    smartSort.separator = trimmed.slice(0, 3) || "_";
                }, false, true);
            });

        new Setting(section)
            .setName("Append basename")
            .setDesc("Append note basename as final segment.")
            .addToggle((toggle) => {
                toggle
                    .setValue(smartSort.appendBasename)
                    .onChange(async (value) => {
                        smartSort.appendBasename = value;
                        await plugin.saveSettings();
                        await plugin.applyRulesToActiveFile(false);
                        refresh();
                    });
            });

        new Setting(section)
            .setName("Clear key when empty")
            .setDesc("Remove sort field when no bucket matched.")
            .addToggle((toggle) => {
                toggle
                    .setValue(smartSort.clearWhenNoMatch)
                    .onChange(async (value) => {
                        smartSort.clearWhenNoMatch = value;
                        await plugin.saveSettings();
                        await plugin.applyRulesToActiveFile(false);
                        refresh();
                    });
            });

        const toolbar = section.createDiv({ cls: "tps-nn-toolbar" });
        this.createActionButton(toolbar, "+ Add bucket", async () => {
            const bucket = plugin.createDefaultSortBucket();
            plugin.settings.smartSort.buckets.push(bucket);
            selectedBucketId = bucket.id;
            await plugin.saveSettings();
            refresh();
        }, true);
        this.createActionButton(toolbar, "Apply active note", async () => {
            await plugin.applyRulesToActiveFile(true);
        });

        if (smartSort.buckets.length === 0) {
            section.createEl("p", {
                cls: "setting-item-description",
                text: "No buckets configured. Add a bucket to start organizing your notes."
            });
            return;
        }

        const selected = this.getSelectedBucket(smartSort.buckets);
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
                placeholder: "Filter buckets..."
            }
        });
        filterInput.value = bucketFilterQuery;
        filterInput.addEventListener("input", () => {
            bucketFilterQuery = filterInput.value.trim().toLowerCase();
            refresh();
        });

        const visibleBuckets = smartSort.buckets
            .map((bucket, index) => ({ bucket, index }))
            .filter(({ bucket, index }) => this.matchesBucketFilter(bucket, index + 1, bucketFilterQuery));

        if (visibleBuckets.length === 0) {
            listPane.createEl("p", {
                cls: "setting-item-description",
                text: "No buckets match the current filter."
            });
        } else {
            visibleBuckets.forEach(({ bucket, index }) => {
                this.renderBucketListItem(listPane, bucket, index, selected.id);
            });
        }

        this.renderBucketEditor(editorPane, selected.bucket, selected.index);
    }

    private renderBucketListItem(
        listPane: HTMLElement,
        bucket: SortBucket,
        index: number,
        activeId: string
    ): void {
        const row = listPane.createEl("button", { cls: "tps-nn-list-item" });
        row.type = "button";
        if (bucket.id === activeId) {
            row.addClass("is-active");
        }
        row.addEventListener("click", () => {
            selectedBucketId = bucket.id;
            this.context.refresh();
        });

        const title = bucket.name || `Bucket ${index + 1}`;
        row.createDiv({ cls: "tps-nn-list-item-title", text: `${index + 1}. ${title}` });
        row.createDiv({ cls: "tps-nn-list-item-summary", text: this.getBucketSummary(bucket) });
        row.createDiv({
            cls: "tps-nn-list-item-summary",
            text: bucket.enabled ? "Enabled" : "Disabled"
        });
    }

    private renderBucketEditor(editorPane: HTMLElement, bucket: SortBucket, index: number): void {
        const { plugin, bindCommittedText, refresh } = this.context;
        const bucketId = bucket.id;
        editorPane.createEl("h4", { text: `Editing Bucket ${index + 1}` });

        const topBar = editorPane.createDiv({ cls: "tps-nn-toolbar" });
        this.createActionButton(topBar, "Previous", async () => {
            const previousIndex = Math.max(0, index - 1);
            const previous = plugin.settings.smartSort.buckets[previousIndex];
            if (!previous) {
                return;
            }
            selectedBucketId = previous.id;
            refresh();
        }, false, index === 0);
        this.createActionButton(topBar, "Next", async () => {
            const nextIndex = Math.min(plugin.settings.smartSort.buckets.length - 1, index + 1);
            const next = plugin.settings.smartSort.buckets[nextIndex];
            if (!next) {
                return;
            }
            selectedBucketId = next.id;
            refresh();
        }, false, index >= plugin.settings.smartSort.buckets.length - 1);
        this.createMenuButton(topBar, "Bucket actions", (triggerEl) => {
            this.openBucketActionsMenu(triggerEl, bucket, index);
        });

        new Setting(editorPane)
            .setName("Bucket name")
            .setDesc("Descriptive name for this bucket.")
            .addText((text) => {
                text.setPlaceholder("My Bucket");
                bindCommittedText(text, bucket.name, async (value) => {
                    const live = this.getLiveBucket(bucketId);
                    if (!live) {
                        return;
                    }
                    live.name = value.trim();
                });
            });

        new Setting(editorPane)
            .setName("Enabled")
            .setDesc("Disable this bucket without deleting it.")
            .addToggle((toggle) => {
                toggle
                    .setValue(bucket.enabled)
                    .onChange(async (value) => {
                        const live = this.getLiveBucket(bucketId);
                        if (!live) {
                            return;
                        }
                        live.enabled = value;
                        await plugin.saveSettings();
                        await plugin.applyRulesToActiveFile(false);
                        refresh();
                    });
            });

        this.renderBucketConditions(editorPane, bucketId, bucket);
        this.renderSortCriteria(editorPane, bucketId, bucket);
    }

    private renderBucketConditions(editorPane: HTMLElement, bucketId: string, bucket: SortBucket): void {
        const { plugin, refresh } = this.context;
        bucket.match = normalizeRuleMatchMode(bucket.match);
        const conditions = this.ensureBucketConditions(bucket);

        const panel = editorPane.createEl("details", { cls: "tps-nn-sub-collapsible" });
        panel.open = conditions.length > 0;
        panel.createEl("summary", { text: "Bucket matching conditions" });
        const content = panel.createDiv({ cls: "tps-nn-sub-body" });

        content.createEl("p", {
            cls: "setting-item-description",
            text: "Define which notes belong in this bucket. If no conditions are set, all notes match."
        });

        new Setting(content)
            .setName("Match mode")
            .setDesc("How to combine multiple conditions.")
            .addDropdown((dropdown) => {
                dropdown
                    .addOption("all", "All conditions")
                    .addOption("any", "Any condition")
                    .setValue(bucket.match)
                    .onChange(async (value) => {
                        const live = this.getLiveBucket(bucketId);
                        if (!live) {
                            return;
                        }
                        live.match = normalizeRuleMatchMode(value);
                        await plugin.saveSettings();
                        await plugin.applyRulesToActiveFile(false);
                    });
            });

        if (conditions.length === 0) {
            content.createEl("p", {
                cls: "setting-item-description",
                text: "No conditions configured; this bucket matches all notes."
            });
        }

        conditions.forEach((condition, conditionIndex) => {
            this.renderCondition(content, bucketId, condition, conditionIndex);
        });

        new Setting(content)
            .setName("Add condition")
            .addButton((button) => {
                button
                    .setButtonText("+ Add condition")
                    .onClick(async () => {
                        const live = this.getLiveBucket(bucketId);
                        if (!live) {
                            return;
                        }
                        this.ensureBucketConditions(live).push(createDefaultCondition());
                        live.match = normalizeRuleMatchMode(live.match);
                        await plugin.saveSettings();
                        await plugin.applyRulesToActiveFile(false);
                        refresh();
                    });
            });
    }

    private renderCondition(
        container: HTMLElement,
        bucketId: string,
        condition: RuleCondition,
        conditionIndex: number
    ): void {
        const { plugin, refresh } = this.context;
        const conditionCard = container.createDiv({ cls: "tps-nn-condition-card" });

        const grid = conditionCard.createDiv({ cls: "tps-nn-condition-grid" });

        const sourceWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
        sourceWrap.createEl("label", { text: "Source" });
        const sourceSelect = sourceWrap.createEl("select");
        for (const source of ["frontmatter", "path", "extension", "name", "tag", "body", "backlink", "date-created", "date-modified"]) {
            sourceSelect.createEl("option", { value: source, text: source });
        }
        sourceSelect.value = condition.source;
        sourceSelect.addEventListener("change", () => {
            void (async () => {
                const live = this.getLiveBucket(bucketId);
                if (!live) {
                    return;
                }
                const liveCondition = this.ensureBucketConditions(live)[conditionIndex];
                if (!liveCondition) {
                    return;
                }
                liveCondition.source = normalizeConditionSource(sourceSelect.value);
                if (liveCondition.source !== "frontmatter") {
                    liveCondition.field = "";
                }

                const validOps = getValidOperators(liveCondition.source);
                if (!validOps.includes(liveCondition.operator)) {
                    liveCondition.operator = "contains";
                }
                await plugin.saveSettings();
                await plugin.applyRulesToActiveFile(false);
                refresh();
            })();
        });



        const operatorWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
        operatorWrap.createEl("label", { text: "Operator" });
        const operatorSelect = operatorWrap.createEl("select");
        const validOperators = getValidOperators(condition.source);

        for (const operator of validOperators) {
            operatorSelect.createEl("option", { value: operator, text: operator });
        }
        operatorSelect.value = condition.operator;

        // Ensure current operator is valid for the source (handle migration/inconsistent state)
        if (!validOperators.includes(condition.operator as any)) {
            // Default to 'contains' if invalid, as it's generally safe
            operatorSelect.value = "contains";
            // We should probably update the model lazily or on save, 
            // but for now we just show the right UI default.
            // Actually, we should probably force update it if we want strictness.
        }
        operatorSelect.addEventListener("change", () => {
            void (async () => {
                const live = this.getLiveBucket(bucketId);
                if (!live) {
                    return;
                }
                const liveCondition = this.ensureBucketConditions(live)[conditionIndex];
                if (!liveCondition) {
                    return;
                }
                const newOp = normalizeSmartOperator(operatorSelect.value);
                liveCondition.operator = newOp;

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

                await plugin.saveSettings();
                await plugin.applyRulesToActiveFile(false);
                refresh();
            })();
        });

        if (condition.source === "frontmatter" || condition.source === "backlink") {
            const fieldWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
            fieldWrap.createEl("label", { text: "Property" });
            const fieldInput = fieldWrap.createEl("input", {
                attr: {
                    type: "text",
                    placeholder: condition.source === "backlink" ? "parent" : "status"
                }
            });
            fieldInput.value = String(condition.field || "");
            fieldInput.addEventListener("blur", () => {
                void (async () => {
                    const live = this.getLiveBucket(bucketId);
                    if (!live) {
                        return;
                    }
                    const liveCondition = this.ensureBucketConditions(live)[conditionIndex];
                    if (!liveCondition) {
                        return;
                    }
                    liveCondition.field = fieldInput.value.trim();
                    await plugin.saveSettings();
                    await plugin.applyRulesToActiveFile(false);
                })();
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
                void (async () => {
                    const live = this.getLiveBucket(bucketId);
                    if (!live) {
                        return;
                    }
                    const liveCondition = this.ensureBucketConditions(live)[conditionIndex];
                    if (!liveCondition) {
                        return;
                    }
                    liveCondition.value = valueInput.value;
                    await plugin.saveSettings();
                    await plugin.applyRulesToActiveFile(false);
                })();
            });
        }

        const deleteWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
        const deleteButton = deleteWrap.createEl("button", { text: "✕", cls: "tps-nn-compact-btn mod-warning" });
        deleteButton.type = "button";
        deleteButton.style.minHeight = "30px";
        deleteButton.style.padding = "0 8px";
        deleteButton.addEventListener("click", () => {
            void (async () => {
                const live = this.getLiveBucket(bucketId);
                if (!live) {
                    return;
                }
                live.conditions = this.ensureBucketConditions(live).filter((_, idx) => idx !== conditionIndex);
                await plugin.saveSettings();
                await plugin.applyRulesToActiveFile(false);
                refresh();
            })();
        });
    }

    private renderSortCriteria(editorPane: HTMLElement, bucketId: string, bucket: SortBucket): void {
        const { plugin, bindCommittedText, refresh } = this.context;
        const criteria = this.ensureSortCriteria(bucket);

        const panel = editorPane.createEl("details", { cls: "tps-nn-sub-collapsible" });
        panel.open = criteria.length > 0;
        panel.createEl("summary", { text: "Sort criteria (within bucket)" });
        const content = panel.createDiv({ cls: "tps-nn-sub-body" });

        content.createEl("p", {
            cls: "setting-item-description",
            text: "Define how notes are sorted within this bucket. Criteria are applied in order."
        });

        if (criteria.length === 0) {
            content.createEl("p", {
                cls: "setting-item-description",
                text: "No sort criteria configured; notes will be sorted by basename only."
            });
        }

        criteria.forEach((criterion, criterionIndex) => {
            this.renderSortCriterion(content, bucketId, criterion, criterionIndex);
        });

        new Setting(content)
            .setName("Add sort criterion")
            .addButton((button) => {
                button
                    .setButtonText("+ Add criterion")
                    .onClick(async () => {
                        const live = this.getLiveBucket(bucketId);
                        if (!live) {
                            return;
                        }
                        this.ensureSortCriteria(live).push(createDefaultSortCriteria());
                        await plugin.saveSettings();
                        await plugin.applyRulesToActiveFile(false);
                        refresh();
                    });
            });
    }

    private renderSortCriterion(
        container: HTMLElement,
        bucketId: string,
        criterion: SortCriteria,
        criterionIndex: number
    ): void {
        const { plugin, bindCommittedText, refresh } = this.context;
        const criterionCard = container.createDiv({ cls: "tps-nn-condition-card" });
        const head = criterionCard.createDiv({ cls: "tps-nn-condition-head" });
        head.createEl("strong", { text: `Criterion ${criterionIndex + 1}` });

        const actions = head.createDiv({ cls: "tps-nn-inline-actions" });

        if (criterionIndex > 0) {
            const upButton = actions.createEl("button", { text: "↑", cls: "tps-nn-compact-btn" });
            upButton.type = "button";
            upButton.addEventListener("click", () => {
                void (async () => {
                    const live = this.getLiveBucket(bucketId);
                    if (!live) {
                        return;
                    }
                    const criteria = this.ensureSortCriteria(live);
                    [criteria[criterionIndex - 1], criteria[criterionIndex]] = [criteria[criterionIndex], criteria[criterionIndex - 1]];
                    await plugin.saveSettings();
                    await plugin.applyRulesToActiveFile(false);
                    refresh();
                })();
            });
        }

        if (criterionIndex < this.ensureSortCriteria(this.getLiveBucket(bucketId) || { sortCriteria: [] } as SortBucket).length - 1) {
            const downButton = actions.createEl("button", { text: "↓", cls: "tps-nn-compact-btn" });
            downButton.type = "button";
            downButton.addEventListener("click", () => {
                void (async () => {
                    const live = this.getLiveBucket(bucketId);
                    if (!live) {
                        return;
                    }
                    const criteria = this.ensureSortCriteria(live);
                    [criteria[criterionIndex + 1], criteria[criterionIndex]] = [criteria[criterionIndex], criteria[criterionIndex + 1]];
                    await plugin.saveSettings();
                    await plugin.applyRulesToActiveFile(false);
                    refresh();
                })();
            });
        }

        const deleteButton = actions.createEl("button", { text: "Delete", cls: "tps-nn-compact-btn" });
        deleteButton.type = "button";
        deleteButton.addEventListener("click", () => {
            void (async () => {
                const live = this.getLiveBucket(bucketId);
                if (!live) {
                    return;
                }
                live.sortCriteria = this.ensureSortCriteria(live).filter((_, idx) => idx !== criterionIndex);
                await plugin.saveSettings();
                await plugin.applyRulesToActiveFile(false);
                refresh();
            })();
        });

        const grid = criterionCard.createDiv({ cls: "tps-nn-condition-grid" });

        const sourceWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
        sourceWrap.createEl("label", { text: "Source" });
        const sourceSelect = sourceWrap.createEl("select");
        for (const source of ["frontmatter", "path", "extension", "name", "tag"]) {
            sourceSelect.createEl("option", { value: source, text: source });
        }
        sourceSelect.value = criterion.source;
        sourceSelect.addEventListener("change", () => {
            void (async () => {
                const live = this.getLiveBucket(bucketId);
                if (!live) {
                    return;
                }
                const liveCriterion = this.ensureSortCriteria(live)[criterionIndex];
                if (!liveCriterion) {
                    return;
                }
                liveCriterion.source = normalizeConditionSource(sourceSelect.value);
                if (liveCriterion.source !== "frontmatter") {
                    liveCriterion.field = "";
                }
                await plugin.saveSettings();
                await plugin.applyRulesToActiveFile(false);
                refresh();
            })();
        });

        const hasType = criterion.source === "frontmatter";
        const isMetadata = criterion.source === "frontmatter" || criterion.source === "tag";

        if (hasType) {
            const typeWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
            typeWrap.createEl("label", { text: "Type" });
            const typeSelect = typeWrap.createEl("select");
            for (const type of ["date", "status", "priority", "text", "number"]) {
                typeSelect.createEl("option", { value: type, text: type });
            }
            typeSelect.value = criterion.type;
            typeSelect.addEventListener("change", () => {
                void (async () => {
                    const live = this.getLiveBucket(bucketId);
                    if (!live) {
                        return;
                    }
                    const liveCriterion = this.ensureSortCriteria(live)[criterionIndex];
                    if (!liveCriterion) {
                        return;
                    }
                    liveCriterion.type = typeSelect.value as any;
                    await plugin.saveSettings();
                    await plugin.applyRulesToActiveFile(false);
                    refresh();
                })();
            });
        }

        if (criterion.source === "frontmatter") {
            const fieldWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
            fieldWrap.createEl("label", { text: "Field" });
            const fieldInput = fieldWrap.createEl("input", {
                attr: {
                    type: "text",
                    placeholder: "scheduled"
                }
            });
            fieldInput.value = String(criterion.field || "");
            fieldInput.addEventListener("blur", () => {
                void (async () => {
                    const live = this.getLiveBucket(bucketId);
                    if (!live) {
                        return;
                    }
                    const liveCriterion = this.ensureSortCriteria(live)[criterionIndex];
                    if (!liveCriterion) {
                        return;
                    }
                    liveCriterion.field = fieldInput.value.trim();
                    await plugin.saveSettings();
                    await plugin.applyRulesToActiveFile(false);
                })();
            });
        }

        const directionWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
        directionWrap.createEl("label", { text: "Direction" });
        const directionSelect = directionWrap.createEl("select");
        directionSelect.createEl("option", { value: "asc", text: "Ascending" });
        directionSelect.createEl("option", { value: "desc", text: "Descending" });
        directionSelect.value = criterion.direction;
        directionSelect.addEventListener("change", () => {
            void (async () => {
                const live = this.getLiveBucket(bucketId);
                if (!live) {
                    return;
                }
                const liveCriterion = this.ensureSortCriteria(live)[criterionIndex];
                if (!liveCriterion) {
                    return;
                }
                liveCriterion.direction = directionSelect.value as any;
                await plugin.saveSettings();
                await plugin.applyRulesToActiveFile(false);
            })();
        });

        if (isMetadata) {
            const missingWrap = grid.createDiv({ cls: "tps-nn-condition-field" });
            missingWrap.createEl("label", { text: "Missing values" });
            const missingSelect = missingWrap.createEl("select");
            missingSelect.createEl("option", { value: "last", text: "Sort last" });
            missingSelect.createEl("option", { value: "first", text: "Sort first" });
            missingSelect.value = criterion.missingValuePlacement;
            missingSelect.addEventListener("change", () => {
                void (async () => {
                    const live = this.getLiveBucket(bucketId);
                    if (!live) {
                        return;
                    }
                    const liveCriterion = this.ensureSortCriteria(live)[criterionIndex];
                    if (!liveCriterion) {
                        return;
                    }
                    liveCriterion.missingValuePlacement = missingSelect.value as any;
                    await plugin.saveSettings();
                    await plugin.applyRulesToActiveFile(false);
                })();
            });

            const mappingWrap = grid.createDiv({ cls: "tps-nn-condition-field tps-nn-condition-field-value" });
            mappingWrap.createEl("label", { text: "Value mappings (optional)" });
            const mappingInput = mappingWrap.createEl("input", {
                attr: {
                    type: "text",
                    placeholder: "high=001, normal=002, low=003"
                }
            });
            mappingInput.value = stringifyMappings(criterion.mappings);
            mappingInput.addEventListener("blur", () => {
                void (async () => {
                    const live = this.getLiveBucket(bucketId);
                    if (!live) {
                        return;
                    }
                    const liveCriterion = this.ensureSortCriteria(live)[criterionIndex];
                    if (!liveCriterion) {
                        return;
                    }
                    liveCriterion.mappings = parseMappings(mappingInput.value);
                    await plugin.saveSettings();
                    await plugin.applyRulesToActiveFile(false);
                })();
            });
        }
        // Quick preset buttons
        if (hasType && (criterion.type === "priority" || criterion.type === "status")) {
            const presetRow = criterionCard.createDiv({ cls: "tps-nn-toolbar" });
            if (criterion.type === "priority") {
                this.createActionButton(presetRow, "Priority preset", async () => {
                    const live = this.getLiveBucket(bucketId);
                    if (!live) {
                        return;
                    }
                    const liveCriterion = this.ensureSortCriteria(live)[criterionIndex];
                    if (!liveCriterion) {
                        return;
                    }
                    liveCriterion.mappings = parseMappings(PRIORITY_MAPPING);
                    await plugin.saveSettings();
                    await plugin.applyRulesToActiveFile(false);
                    refresh();
                });
            }
            if (criterion.type === "status") {
                this.createActionButton(presetRow, "Status preset", async () => {
                    const live = this.getLiveBucket(bucketId);
                    if (!live) {
                        return;
                    }
                    const liveCriterion = this.ensureSortCriteria(live)[criterionIndex];
                    if (!liveCriterion) {
                        return;
                    }
                    liveCriterion.mappings = parseMappings(STATUS_MAPPING);
                    await plugin.saveSettings();
                    await plugin.applyRulesToActiveFile(false);
                    refresh();
                });
            }
        }
    }

    private openBucketActionsMenu(triggerEl: HTMLElement, bucket: SortBucket, index: number): void {
        const { plugin, refresh } = this.context;
        const menu = new Menu();

        menu.addItem((item) => {
            item
                .setTitle(bucket.enabled ? "Disable bucket" : "Enable bucket")
                .setIcon(bucket.enabled ? "toggle-right" : "toggle-left")
                .onClick(() => {
                    void (async () => {
                        bucket.enabled = !bucket.enabled;
                        await plugin.saveSettings();
                        await plugin.applyRulesToActiveFile(false);
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
                        const buckets = plugin.settings.smartSort.buckets;
                        [buckets[index - 1], buckets[index]] = [buckets[index], buckets[index - 1]];
                        await plugin.saveSettings();
                        refresh();
                    })();
                });
        });

        menu.addItem((item) => {
            item
                .setTitle("Move down")
                .setIcon("arrow-down")
                .setDisabled(index >= plugin.settings.smartSort.buckets.length - 1)
                .onClick(() => {
                    void (async () => {
                        if (index >= plugin.settings.smartSort.buckets.length - 1) return;
                        const buckets = plugin.settings.smartSort.buckets;
                        [buckets[index + 1], buckets[index]] = [buckets[index], buckets[index + 1]];
                        await plugin.saveSettings();
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
                        const clone = plugin.createDefaultSortBucket();
                        clone.enabled = bucket.enabled;
                        clone.name = `${bucket.name} (copy)`;
                        clone.match = normalizeRuleMatchMode(bucket.match);
                        clone.conditions = this.ensureBucketConditions(bucket).map((condition) => ({ ...condition }));
                        clone.sortCriteria = this.ensureSortCriteria(bucket).map((criterion) => ({
                            ...criterion,
                            mappings: criterion.mappings.map((m) => ({ ...m }))
                        }));
                        plugin.settings.smartSort.buckets.splice(index + 1, 0, clone);
                        selectedBucketId = clone.id;
                        await plugin.saveSettings();
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
                        plugin.settings.smartSort.buckets = plugin.settings.smartSort.buckets.filter(
                            (existing) => existing.id !== bucket.id
                        );
                        if (selectedBucketId === bucket.id) {
                            selectedBucketId = plugin.settings.smartSort.buckets[0]?.id ?? null;
                        }
                        await plugin.saveSettings();
                        refresh();
                    })();
                });
        });

        this.showMenuBelowElement(menu, triggerEl);
    }

    private getSelectedBucket(
        buckets: SortBucket[]
    ): { id: string; bucket: SortBucket; index: number } | null {
        if (buckets.length === 0) {
            selectedBucketId = null;
            return null;
        }
        if (!selectedBucketId || !buckets.some((bucket) => bucket.id === selectedBucketId)) {
            selectedBucketId = buckets[0].id;
        }
        const index = buckets.findIndex((bucket) => bucket.id === selectedBucketId);
        if (index < 0) {
            return null;
        }
        return {
            id: selectedBucketId,
            bucket: buckets[index],
            index
        };
    }

    private getLiveBucket(bucketId: string): SortBucket | null {
        return this.context.plugin.settings.smartSort.buckets.find((b) => b.id === bucketId) ?? null;
    }

    private ensureBucketConditions(bucket: SortBucket): RuleCondition[] {
        if (!Array.isArray(bucket.conditions)) {
            bucket.conditions = [];
        }
        return bucket.conditions;
    }

    private ensureSortCriteria(bucket: SortBucket): SortCriteria[] {
        if (!Array.isArray(bucket.sortCriteria)) {
            bucket.sortCriteria = [];
        }
        return bucket.sortCriteria;
    }

    private matchesBucketFilter(bucket: SortBucket, position: number, query: string): boolean {
        if (!query) {
            return true;
        }
        const name = (bucket.name || "").toLowerCase();
        const posStr = String(position);
        return name.includes(query) || posStr.includes(query);
    }

    private getBucketSummary(bucket: SortBucket): string {
        const condCount = bucket.conditions?.length ?? 0;
        const criteriaCount = bucket.sortCriteria?.length ?? 0;
        return `${condCount} condition(s), ${criteriaCount} sort criterion/criteria`;
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

    private showMenuBelowElement(menu: Menu, triggerEl: HTMLElement): void {
        const rect = triggerEl.getBoundingClientRect();
        menu.showAtPosition({
            x: rect.left,
            y: rect.bottom + 4
        });
    }
}
