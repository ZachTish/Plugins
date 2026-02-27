import { App, Modal, Setting, ButtonComponent } from "obsidian";

export type ChecklistAction = "open" | "complete" | "progress" | "ignore" | "cancel";

export class ChecklistPromptModal extends Modal {
    private items: string[];
    private onResult: (result: ChecklistAction) => void;

    constructor(app: App, items: string[], onResult: (result: ChecklistAction) => void) {
        super(app);
        this.items = items;
        this.onResult = onResult;
    }

    onOpen() {
        this.modalEl.addClass('mod-tps-gcm');
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl("h2", { text: "Incomplete Checklist Items" });
        contentEl.createEl("p", { text: "This note has open checklist items. What would you like to do?" });

        const listContainer = contentEl.createDiv("tps-gcm-checklist-preview");
        listContainer.style.maxHeight = "200px";
        listContainer.style.overflowY = "auto";
        listContainer.style.background = "var(--background-secondary)";
        listContainer.style.padding = "10px";
        listContainer.style.borderRadius = "4px";
        listContainer.style.marginBottom = "20px";
        listContainer.style.fontFamily = "var(--font-monospace)";
        listContainer.style.fontSize = "0.9em";

        this.items.slice(0, 10).forEach(item => {
            listContainer.createDiv({ text: item });
        });
        if (this.items.length > 10) {
            listContainer.createDiv({ text: `...and ${this.items.length - 10} more`, attr: { style: "color: var(--text-muted); font-style: italic; margin-top: 5px;" } });
        }

        const buttonContainer = contentEl.createDiv("tps-gcm-modal-buttons");
        buttonContainer.style.display = "flex";
        buttonContainer.style.flexDirection = "column";
        buttonContainer.style.gap = "10px";

        // Open Note
        new Setting(buttonContainer)
            .setClass("tps-gcm-no-border")
            .addButton(btn => btn
                .setButtonText("Open Note")
                .onClick(() => {
                    this.onResult("open");
                    this.close();
                }));

        // Complete Items
        new Setting(buttonContainer)
            .setClass("tps-gcm-no-border")
            .addButton(btn => btn
                .setButtonText("Complete Items (- [x])")
                .setCta()
                .onClick(() => {
                    this.onResult("complete");
                    this.close();
                }));

        // Mark as [?]
        new Setting(buttonContainer)
            .setClass("tps-gcm-no-border")
            .addButton(btn => btn
                .setButtonText('Mark as Question (- [?])')
                .onClick(() => {
                    this.onResult("progress");
                    this.close();
                }));

        // Ignore (Just Complete Note)
        new Setting(buttonContainer)
            .setClass("tps-gcm-no-border")
            .addButton(btn => btn
                .setButtonText("Ignore Items & Complete Note")
                .setWarning()
                .onClick(() => {
                    this.onResult("ignore");
                    this.close();
                }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
