import { App, Modal, Setting } from "obsidian";
import type { TagPageFileType } from "../types";

export class PageFileTypeModal extends Modal {
  private resolvePromise: ((value: TagPageFileType | null) => void) | null = null;
  private selectedType: TagPageFileType;

  constructor(app: App, defaultType: TagPageFileType, private readonly entityLabel: string) {
    super(app);
    this.selectedType = defaultType;
  }

  openAndWait(): Promise<TagPageFileType | null> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Create ${this.entityLabel}`);
    contentEl.empty();

    new Setting(contentEl)
      .setName("File type")
      .setDesc("Choose the file type to create.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("canvas", "Canvas")
          .addOption("markdown", "Markdown")
          .addOption("base", "Base")
          .setValue(this.selectedType)
          .onChange((value) => {
            if (value === "canvas" || value === "markdown" || value === "base") {
              this.selectedType = value;
            }
          });
      });

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => {
      this.finish(null);
    });

    const createButton = actions.createEl("button", { text: "Create" });
    createButton.addClass("mod-cta");
    createButton.addEventListener("click", () => {
      this.finish(this.selectedType);
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.resolvePromise) {
      this.resolvePromise(null);
      this.resolvePromise = null;
    }
  }

  private finish(value: TagPageFileType | null): void {
    const resolve = this.resolvePromise;
    this.resolvePromise = null;
    this.close();
    resolve?.(value);
  }
}
