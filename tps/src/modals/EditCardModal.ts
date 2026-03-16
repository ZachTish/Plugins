import { Modal, ButtonComponent, TextComponent } from 'obsidian';

type SaveCallback = (title: string, filePath?: string) => void;

export class EditCardModal extends Modal {
  private onSave: SaveCallback;
  private initialTitle: string;
  private initialPath?: string;

  constructor(app: any, title: string, filePath: string | undefined, onSave: SaveCallback) {
    super(app);
    this.onSave = onSave;
    this.initialTitle = title;
    this.initialPath = filePath;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Edit card' });
    const titleInput = new TextComponent(contentEl);
    titleInput.setValue(this.initialTitle || '');

    const pathInput = new TextComponent(contentEl);
    pathInput.setPlaceholder('Optional file path (obsidian link or path)');
    pathInput.setValue(this.initialPath || '');

    const btnRow = contentEl.createDiv({ cls: 'modal-button-row' });
    const saveBtn = new ButtonComponent(btnRow);
    saveBtn.setButtonText('Save').onClick(() => {
      this.onSave(titleInput.getValue(), pathInput.getValue() || undefined);
      this.close();
    });

    const cancelBtn = new ButtonComponent(btnRow);
    cancelBtn.setButtonText('Cancel').onClick(() => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}
