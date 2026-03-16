import { App, Modal } from 'obsidian';

export class StatusChoiceModal extends Modal {
  private readonly statuses: string[];
  private readonly onChoose: (status: string | null) => void;

  constructor(app: App, statuses: string[], onChoose: (status: string | null) => void) {
    super(app);
    this.statuses = statuses;
    this.onChoose = onChoose;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'All checklist items are resolved' });
    contentEl.createEl('p', { text: 'Set a status for this note:' });

    const buttonWrap = contentEl.createDiv({ cls: 'tps-gcm-status-choice-buttons' });
    for (const status of this.statuses) {
      const btn = buttonWrap.createEl('button', { text: status });
      btn.addEventListener('click', () => {
        this.onChoose(status);
        this.close();
      });
    }

    const cancelBtn = contentEl.createEl('button', { text: 'Cancel' });
    cancelBtn.style.marginTop = '12px';
    cancelBtn.addEventListener('click', () => {
      this.onChoose(null);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

