"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EditCardModal = void 0;
const obsidian_1 = require("obsidian");
class EditCardModal extends obsidian_1.Modal {
    constructor(app, title, filePath, onSave) {
        super(app);
        this.onSave = onSave;
        this.initialTitle = title;
        this.initialPath = filePath;
    }
    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Edit card' });
        const titleInput = new obsidian_1.TextComponent(contentEl);
        titleInput.setValue(this.initialTitle || '');
        const pathInput = new obsidian_1.TextComponent(contentEl);
        pathInput.setPlaceholder('Optional file path (obsidian link or path)');
        pathInput.setValue(this.initialPath || '');
        const btnRow = contentEl.createDiv({ cls: 'modal-button-row' });
        const saveBtn = new obsidian_1.ButtonComponent(btnRow);
        saveBtn.setButtonText('Save').onClick(() => {
            this.onSave(titleInput.getValue(), pathInput.getValue() || undefined);
            this.close();
        });
        const cancelBtn = new obsidian_1.ButtonComponent(btnRow);
        cancelBtn.setButtonText('Cancel').onClick(() => this.close());
    }
    onClose() {
        this.contentEl.empty();
    }
}
exports.EditCardModal = EditCardModal;
