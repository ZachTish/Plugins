import { App, Modal, Setting, TextComponent } from 'obsidian';

export class AddTagModal extends Modal {
    allTags: string[];
    onSubmit: (tag: string) => void;
    tag: string = '';

    constructor(app: App, allTags: string[], onSubmit: (tag: string) => void) {
        super(app);
        this.allTags = allTags;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        this.modalEl.addClass('mod-tps-gcm');
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Add tag' });

        new Setting(contentEl).setName('Tag').addText((text) => {
            text.setPlaceholder('tag1, tag2, tag3');
            // Fix for text input in modal: stop propagation
            text.inputEl.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                    this.close();
                    this.onSubmit(this.tag);
                }
            });
            text.onChange((value) => {
                this.tag = value;
            });
            // Focus the input
            setTimeout(() => text.inputEl.focus(), 50);
        });

        new Setting(contentEl).addButton((btn) => {
            btn
                .setButtonText('Add')
                .setCta()
                .onClick(() => {
                    this.close();
                    this.onSubmit(this.tag);
                });
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
