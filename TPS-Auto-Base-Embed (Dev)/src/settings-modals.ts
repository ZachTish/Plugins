import {
  App,
  FuzzySuggestModal,
  Modal,
  TFile,
} from "obsidian";

export class BaseFileSuggestModal extends FuzzySuggestModal<TFile> {
  onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Select a .base file...");
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles().filter((file) => file.extension === "base");
  }

  getItemText(item: TFile): string {
    return item.path;
  }

  onChooseItem(item: TFile): void {
    this.onChoose(item);
  }
}

export class TextInputModal extends Modal {
  private value: string;
  private onSubmit: (value: string) => void;
  private title: string;
  private placeholder: string;

  constructor(app: App, title: string, placeholder: string, initialValue: string, onSubmit: (value: string) => void) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.value = initialValue;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });

    const input = contentEl.createEl("input", { type: "text" });
    input.placeholder = this.placeholder;
    input.value = this.value;
    input.style.width = "100%";
    input.style.marginBottom = "12px";
    input.addEventListener("input", () => {
      this.value = input.value;
    });

    const actions = contentEl.createDiv({ cls: "tps-auto-base-embed-actions" });
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.justifyContent = "flex-end";

    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = actions.createEl("button", { text: "Add", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      if (this.value.trim()) {
        this.onSubmit(this.value.trim());
      }
      this.close();
    });

    input.focus();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (this.value.trim()) {
          this.onSubmit(this.value.trim());
        }
        this.close();
      }
    });
  }
}

export class KeyValueModal extends Modal {
  private propKey = "";
  private propValue = "";
  private onSubmit: (key: string, value: string) => void;

  constructor(app: App, onSubmit: (key: string, value: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Add property condition" });

    const keyInput = contentEl.createEl("input", { type: "text", placeholder: "Property key (e.g., status)" });
    keyInput.style.width = "100%";
    keyInput.style.marginBottom = "8px";
    keyInput.addEventListener("input", () => {
      this.propKey = keyInput.value;
    });

    const valueInput = contentEl.createEl("input", { type: "text", placeholder: "Value (e.g., active)" });
    valueInput.style.width = "100%";
    valueInput.style.marginBottom = "12px";
    valueInput.addEventListener("input", () => {
      this.propValue = valueInput.value;
    });

    const actions = contentEl.createDiv();
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.justifyContent = "flex-end";

    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const saveBtn = actions.createEl("button", { text: "Add", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      if (this.propKey.trim() && this.propValue.trim()) {
        this.onSubmit(this.propKey.trim(), this.propValue.trim());
      }
      this.close();
    });

    keyInput.focus();
  }
}