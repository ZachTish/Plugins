import { App, Modal, Notice, Setting } from 'obsidian';

export class CreateSubitemModal extends Modal {
  private readonly folderPaths: string[];
  private readonly defaultFolderPath: string;
  private readonly onResolve: (value: { title: string; folderPath: string } | null) => void;
  private resolved = false;
  private title = '';
  private folderPath = '/';
  private showFolderPicker = false;

  constructor(
    app: App,
    folderPaths: string[],
    defaultFolderPath: string,
    onResolve: (value: { title: string; folderPath: string } | null) => void
  ) {
    super(app);
    this.folderPaths = folderPaths.length ? folderPaths : ['/'];
    this.defaultFolderPath = this.folderPaths.includes(defaultFolderPath) ? defaultFolderPath : this.folderPaths[0];
    this.folderPath = this.defaultFolderPath;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    this.modalEl.addClass('mod-tps-gcm');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Add Subitem' });

    new Setting(contentEl)
      .setName('Title')
      .setDesc('Name for the new subitem.')
      .addText((text) => {
        text.setPlaceholder('Subitem title');
        text.setValue(this.title);
        text.onChange((value) => {
          this.title = value;
        });
        text.inputEl.addEventListener('keydown', (event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            this.submit();
          }
        });
        setTimeout(() => text.inputEl.focus(), 10);
      });

    const locationSetting = new Setting(contentEl)
      .setName('Location')
      .setDesc(this.folderPath || '/');

    let pickerRow: HTMLElement | null = null;
    const mountFolderPicker = () => {
      if (pickerRow) {
        pickerRow.style.display = this.showFolderPicker ? '' : 'none';
        return;
      }

      pickerRow = contentEl.createDiv('tps-gcm-subitem-folder-picker');
      pickerRow.style.display = this.showFolderPicker ? '' : 'none';

      new Setting(pickerRow)
        .setName('Change Folder')
        .setDesc('Optional. Defaults to current note folder.')
        .addDropdown((dropdown) => {
          this.folderPaths.forEach((path) => {
            dropdown.addOption(path, path || '/');
          });
          dropdown.setValue(this.folderPath);
          dropdown.onChange((value) => {
            this.folderPath = value;
            locationSetting.setDesc(this.folderPath || '/');
          });
        });
    };

    locationSetting.addButton((btn) => {
      btn.setButtonText('Change')
        .onClick(() => {
          this.showFolderPicker = !this.showFolderPicker;
          mountFolderPicker();
        });
    });

    mountFolderPicker();

    const actions = contentEl.createDiv('tps-gcm-subitem-create-actions');
    const cancel = actions.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());

    const create = actions.createEl('button', { text: 'Create', cls: 'mod-cta' });
    create.addEventListener('click', () => this.submit());
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.onResolve(null);
    }
  }

  private submit(): void {
    const nextTitle = String(this.title || '').trim();
    if (!nextTitle) {
      new Notice('Title is required.');
      return;
    }

    this.resolved = true;
    this.onResolve({
      title: nextTitle,
      folderPath: this.folderPath || '/',
    });
    this.close();
  }
}
