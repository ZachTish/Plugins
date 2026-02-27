import { App, Modal, Setting } from "obsidian";

export type ParentLinkAction = "open" | "ignore" | "cancel";

export interface ParentLinkIssue {
  path: string;
  status: string;
}

export class ParentLinkPromptModal extends Modal {
  private issues: ParentLinkIssue[];
  private onResult: (result: ParentLinkAction) => void;
  private resolved: boolean = false;

  constructor(app: App, issues: ParentLinkIssue[], onResult: (result: ParentLinkAction) => void) {
    super(app);
    this.issues = issues;
    this.onResult = onResult;
  }

  onOpen() {
    this.modalEl.addClass('mod-tps-gcm');
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Linked Notes Not Complete" });
    contentEl.createEl("p", { text: "Some notes that link to this note are not marked complete. What would you like to do?" });

    const listContainer = contentEl.createDiv("tps-gcm-parentlink-preview");
    listContainer.style.maxHeight = "220px";
    listContainer.style.overflowY = "auto";
    listContainer.style.background = "var(--background-secondary)";
    listContainer.style.padding = "10px";
    listContainer.style.borderRadius = "4px";
    listContainer.style.marginBottom = "20px";
    listContainer.style.fontFamily = "var(--font-monospace)";
    listContainer.style.fontSize = "0.9em";

    this.issues.slice(0, 12).forEach((issue) => {
      listContainer.createDiv({ text: `${issue.path} (${issue.status || "no status"})` });
    });
    if (this.issues.length > 12) {
      listContainer.createDiv({
        text: `...and ${this.issues.length - 12} more`,
        attr: { style: "color: var(--text-muted); font-style: italic; margin-top: 5px;" }
      });
    }

    const buttonContainer = contentEl.createDiv("tps-gcm-modal-buttons");
    buttonContainer.style.display = "flex";
    buttonContainer.style.flexDirection = "column";
    buttonContainer.style.gap = "10px";

    new Setting(buttonContainer)
      .setClass("tps-gcm-no-border")
      .addButton((btn) =>
        btn.setButtonText("Open Linked Notes")
          .onClick(() => {
            this.resolved = true;
            this.onResult("open");
            this.close();
          })
      );

    new Setting(buttonContainer)
      .setClass("tps-gcm-no-border")
      .addButton((btn) =>
        btn.setButtonText("Ignore & Continue")
          .setWarning()
          .onClick(() => {
            this.resolved = true;
            this.onResult("ignore");
            this.close();
          })
      );

    new Setting(buttonContainer)
      .setClass("tps-gcm-no-border")
      .addButton((btn) =>
        btn.setButtonText("Cancel")
          .onClick(() => {
            this.resolved = true;
            this.onResult("cancel");
            this.close();
          })
      );
  }

  onClose() {
    if (!this.resolved) {
      this.onResult("cancel");
    }
    const { contentEl } = this;
    contentEl.empty();
  }
}
