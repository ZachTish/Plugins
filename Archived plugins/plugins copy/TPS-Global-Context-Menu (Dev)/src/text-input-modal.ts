import { App, Modal, Setting } from 'obsidian';

export class TextInputModal extends Modal {
    label: string;
    initialValue: string;
    onSubmit: (value: string) => void;
    value: string = '';

    constructor(app: App, label: string, initialValue: string, onSubmit: (value: string) => void) {
        super(app);
        this.label = label;
        this.initialValue = initialValue || '';
        this.value = this.initialValue;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        this.modalEl.addClass('mod-tps-gcm');
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: `Edit ${this.label}` });

        new Setting(contentEl).setName(this.label).addText((text) => {
            text.setValue(this.initialValue);
            text.setPlaceholder(`Enter ${this.label}...`);
            // Stop propagation to prevent menu from closing
            text.inputEl.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                    this.close();
                    this.onSubmit(this.value);
                }
            });
            text.onChange((value) => {
                this.value = value;
            });
            // Focus the input
            setTimeout(() => text.inputEl.focus(), 50);
        });

        new Setting(contentEl).addButton((btn) => {
            btn
                .setButtonText('Save')
                .setCta()
                .onClick(() => {
                    this.close();
                    this.onSubmit(this.value);
                });
        }).addButton((btn) => {
            btn
                .setButtonText('Cancel')
                .onClick(() => {
                    this.close();
                });
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
