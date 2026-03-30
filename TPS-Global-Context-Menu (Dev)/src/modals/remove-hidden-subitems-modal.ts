import { App, Modal, TFile } from 'obsidian';
import type { BodySubitemLink } from '../services/subitem-types';

export class RemoveHiddenSubitemsModal extends Modal {
  private matchingLinks: BodySubitemLink[];
  private onConfirm: (linksToRemove: BodySubitemLink[]) => Promise<void>;

  constructor(
    app: App,
    matchingLinks: BodySubitemLink[],
    onConfirm: (linksToRemove: BodySubitemLink[]) => Promise<void>
  ) {
    super(app);
    this.matchingLinks = matchingLinks;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    this.modalEl.addClass('mod-tps-gcm');
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl('h3', { text: 'Remove Hidden Subitems?' });
    
    const description = contentEl.createEl('p', {
      text: `This note contains ${this.matchingLinks.length} subitem link${this.matchingLinks.length === 1 ? '' : 's'} that match your hide rules:`
    });

    const listContainer = contentEl.createDiv({ cls: 'tps-gcm-hidden-subitems-list' });
    const ul = listContainer.createEl('ul');
    
    for (const link of this.matchingLinks) {
      const li = ul.createEl('li');
      li.createEl('span', { text: link.childFile?.basename || link.childPath });
    }

    const question = contentEl.createEl('p', {
      text: 'Would you like to remove these links from the note body?'
    });

    const buttonRow = contentEl.createDiv({ cls: 'tps-gcm-confirm-buttons' });
    const cancelBtn = buttonRow.createEl('button', { text: 'Keep Links' });
    const confirmBtn = buttonRow.createEl('button', { text: 'Remove Links', cls: 'mod-warning' });

    cancelBtn.addEventListener('click', () => this.close());
    confirmBtn.addEventListener('click', async () => {
      await this.onConfirm(this.matchingLinks);
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
