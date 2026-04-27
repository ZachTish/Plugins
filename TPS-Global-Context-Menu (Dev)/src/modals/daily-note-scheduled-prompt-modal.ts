import { App, Modal } from 'obsidian';

export class DailyNoteScheduledPromptModal extends Modal {
  private readonly message: string;
  private readonly onResolve: (confirmed: boolean) => void;

  constructor(app: App, message: string, onResolve: (confirmed: boolean) => void) {
    super(app);
    this.message = message;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    this.modalEl.addClass('mod-tps-gcm');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Insert scheduled date?' });
    contentEl.createEl('p', { text: this.message });

    const buttonRow = contentEl.createDiv({ cls: 'tps-gcm-confirm-buttons' });
    const cancelBtn = buttonRow.createEl('button', { text: 'No' });
    const confirmBtn = buttonRow.createEl('button', { text: 'Yes', cls: 'mod-cta' });

    cancelBtn.addEventListener('click', () => {
      this.onResolve(false);
      this.close();
    });
    confirmBtn.addEventListener('click', () => {
      this.onResolve(true);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
