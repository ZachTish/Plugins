import { App, Modal } from 'obsidian';

export class ConfirmDeleteModal extends Modal {
  private message: string;
  private onConfirm: () => Promise<void>;

  constructor(app: App, message: string, onConfirm: () => Promise<void>) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    this.modalEl.addClass('mod-tps-gcm');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Confirm delete' });
    contentEl.createEl('p', { text: this.message });

    const buttonRow = contentEl.createDiv({ cls: 'tps-gcm-confirm-buttons' });
    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    const confirmBtn = buttonRow.createEl('button', { text: 'Delete', cls: 'mod-warning' });

    cancelBtn.addEventListener('click', () => this.close());
    confirmBtn.addEventListener('click', async () => {
      await this.onConfirm();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
