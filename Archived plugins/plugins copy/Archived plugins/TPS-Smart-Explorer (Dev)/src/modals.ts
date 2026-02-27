/**
 * Smart Explorer Modals
 * Extracted modal classes for cleaner codebase organization
 */

import { Modal, App, FuzzySuggestModal, TFile } from "obsidian";
import * as logger from "./logger";

/**
 * Confirmation modal for file/folder deletion
 */
export class DeleteConfirmationModal extends Modal {
    files: any[];

    constructor(app: App, files: any[]) {
        super(app);
        this.files = files;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h2", { text: "Delete Files?" });

        const msg = this.files.length === 1
            ? `Are you sure you want to delete "${this.files[0].name}"?`
            : `Are you sure you want to delete ${this.files.length} files?`;

        contentEl.createEl("p", { text: msg });
        contentEl.createEl("p", {
            text: "Items will be moved to the system trash.",
            cls: "mod-warning"
        });

        const div = contentEl.createDiv({ cls: "modal-button-container" });
        const cancelBtn = div.createEl("button", { text: "Cancel" });
        cancelBtn.addEventListener("click", () => this.close());

        const deleteBtn = div.createEl("button", { text: "Delete", cls: "mod-warning" });
        deleteBtn.addEventListener("click", async () => {
            for (const file of this.files) {
                try {
                    await this.app.vault.trash(file, true);
                } catch (err) {
                    logger.error(`Failed to delete ${file.path}`, err);
                }
            }
            this.close();
        });

        cancelBtn.focus();
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Quick modal for adding a new note with title and folder selection
 */
export class QuickAddNoteModal extends Modal {
    private titlePlaceholder: string;
    private folderOptions: Array<{ label: string; value: string }>;
    result: { title: string; folderPath: string } | null = null;

    constructor(app: App, opts: { titlePlaceholder?: string; folderOptions: Array<{ label: string; value: string }> }) {
        super(app);
        this.titlePlaceholder = opts.titlePlaceholder || "Note title";
        this.folderOptions = opts.folderOptions;
    }

    onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText("New note");
        contentEl.empty();

        const form = contentEl.createEl("form", { attr: { autocomplete: "off" } });
        form.style.display = "flex";
        form.style.flexDirection = "column";
        form.style.gap = "10px";

        const input = form.createEl("input", {
            type: "text",
            placeholder: this.titlePlaceholder,
            attr: { spellcheck: "false" },
        });
        input.style.width = "100%";

        const select = form.createEl("select", { cls: "explorer2-filter-select" });
        for (const opt of this.folderOptions) {
            const option = select.createEl("option");
            option.value = opt.value;
            option.textContent = opt.label;
        }

        const actions = form.createDiv({ cls: "modal-button-container" });
        actions.createEl("button", { text: "Create", type: "submit", cls: "mod-cta" });
        const cancelBtn = actions.createEl("button", { text: "Cancel", type: "button" });

        cancelBtn.addEventListener("click", () => this.close());
        form.addEventListener("submit", (e) => {
            e.preventDefault();
            const title = input.value.trim();
            if (!title) return;
            this.result = { title, folderPath: select.value || "" };
            this.close();
        });

        setTimeout(() => input.focus(), 50);
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Simple name prompt modal (for renaming, new folder, etc)
 */
export class NamePromptModal extends Modal {
    result: string | null = null;
    private title: string;
    private placeholder: string;
    private initialValue: string;

    constructor(app: App, title: string, placeholder = "", initialValue = "") {
        super(app);
        this.title = title;
        this.placeholder = placeholder;
        this.initialValue = initialValue;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl("h3", { text: this.title });

        const input = contentEl.createEl("input", {
            type: "text",
            value: this.initialValue,
            placeholder: this.placeholder,
            attr: { spellcheck: "false" }
        });
        input.style.width = "100%";
        input.style.marginBottom = "10px";

        const buttons = contentEl.createDiv({ cls: "modal-button-container" });
        const cancelBtn = buttons.createEl("button", { text: "Cancel" });
        cancelBtn.addEventListener("click", () => this.close());

        const confirmBtn = buttons.createEl("button", { text: "OK", cls: "mod-cta" });
        confirmBtn.addEventListener("click", () => {
            this.result = input.value.trim() || null;
            this.close();
        });

        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                this.result = input.value.trim() || null;
                this.close();
            }
        });

        setTimeout(() => {
            input.focus();
            input.select();
        }, 50);
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Folder selection modal
 */
export class FolderSelectionModal extends Modal {
    private onSubmit: (path: string) => void;
    private folders: string[];
    private selected: string;

    constructor(app: App, onSubmit: (path: string) => void) {
        super(app);
        this.onSubmit = onSubmit;
        this.folders = this.getAllFolders();
        this.selected = this.folders[0] || "/";
    }

    private getAllFolders(): string[] {
        // @ts-ignore
        const root = this.app.vault.getRoot();
        const folders: string[] = [];
        const recurse = (folder: any) => {
            folders.push(folder.path || "/");
            folder.children?.forEach((child: any) => {
                if (child?.children) recurse(child);
            });
        };
        recurse(root);
        return folders.sort((a, b) => a.localeCompare(b));
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl("h2", { text: "Select Folder" });

        const select = contentEl.createEl("select", { cls: "explorer2-filter-select" });
        this.folders.forEach((path) => {
            const option = select.createEl("option");
            option.value = path;
            option.textContent = path;
        });
        select.value = this.selected;
        select.addEventListener("change", () => {
            this.selected = select.value;
        });

        const actions = contentEl.createDiv({ cls: "modal-button-container" });
        const cancelBtn = actions.createEl("button", { text: "Cancel", type: "button" });
        cancelBtn.addEventListener("click", () => this.close());
        const saveBtn = actions.createEl("button", { text: "Select", cls: "mod-cta" });
        saveBtn.addEventListener("click", () => {
            this.onSubmit(this.selected);
            this.close();
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

/**
 * Markdown file picker modal
 */
export class MarkdownFileSuggestModal extends FuzzySuggestModal<TFile> {
    private onChoose: (file: TFile) => void;

    constructor(app: App, onChoose: (file: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder("Select a template note...");
    }

    getItems(): TFile[] {
        return this.app.vault.getMarkdownFiles();
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile): void {
        this.onChoose(item);
    }
}

/**
 * Canvas file picker modal
 */
export class CanvasFileSuggestModal extends FuzzySuggestModal<TFile> {
    private onChoose: (file: TFile) => void;

    constructor(app: App, onChoose: (file: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder("Select a canvas template...");
    }

    getItems(): TFile[] {
        // @ts-ignore - getFiles is available in Obsidian vault
        const files = (this.app.vault.getFiles?.() || []) as TFile[];
        return files.filter((f) => f.extension === "canvas");
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile): void {
        this.onChoose(item);
    }
}

/**
 * Base file picker modal
 */
export class BaseFileSuggestModal extends FuzzySuggestModal<TFile> {
    private onChoose: (file: TFile) => void;

    constructor(app: App, onChoose: (file: TFile) => void) {
        super(app);
        this.onChoose = onChoose;
        this.setPlaceholder("Select a base file...");
    }

    getItems(): TFile[] {
        // @ts-ignore - getFiles is available in Obsidian vault
        const files = (this.app.vault.getFiles?.() || []) as TFile[];
        return files.filter((f) => f.extension === "base");
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile): void {
        this.onChoose(item);
    }
}
