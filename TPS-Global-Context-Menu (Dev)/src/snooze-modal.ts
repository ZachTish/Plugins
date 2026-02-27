import { App, Modal, TFile } from 'obsidian';

interface SnoozeOption {
    label: string;
    minutes: number;
}

export class SnoozeModal extends Modal {
    private files: TFile[];
    private onSnooze: (minutes: number) => Promise<void>;
    private customOptions: SnoozeOption[];

    constructor(app: App, files: TFile[], options: SnoozeOption[], onSnooze: (minutes: number) => Promise<void>) {
        super(app);
        this.files = files;
        this.customOptions = options;
        this.onSnooze = onSnooze;
    }

    onOpen() {
        this.modalEl.addClass('mod-tps-gcm');
        const { contentEl } = this;
        contentEl.addClass('tps-context-modal');

        // Add custom class for styling consistent with other modals
        contentEl.createEl('h2', { text: `Snooze (${this.files.length} notes)` });

        const grid = contentEl.createDiv({ cls: 'tps-context-grid' });
        grid.style.display = 'grid';
        grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(140px, 1fr))';
        grid.style.gap = '10px';
        grid.style.marginTop = '15px';

        this.customOptions.forEach(opt => {
            const btn = grid.createEl('button', {
                text: opt.label,
                cls: 'mod-cta'
            });
            btn.style.width = '100%';
            btn.style.height = '40px';

            btn.addEventListener('click', async () => {
                await this.onSnooze(opt.minutes);
                this.close();
            });
        });

        const customDiv = contentEl.createDiv({ cls: 'tps-context-input-group' });
        customDiv.style.marginTop = '20px';
        customDiv.style.borderTop = '1px solid var(--background-modifier-border)';
        customDiv.style.paddingTop = '15px';

        customDiv.createEl('span', { text: 'Custom (minutes): ' });
        const input = customDiv.createEl('input', { type: 'number' });
        input.placeholder = '30';

        const applyBtn = customDiv.createEl('button', { text: 'Apply' });
        applyBtn.addEventListener('click', async () => {
            const val = parseInt(input.value);
            if (!isNaN(val) && val > 0) {
                await this.onSnooze(val);
                this.close();
            }
        });

        // Enter key support
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const val = parseInt(input.value);
                if (!isNaN(val) && val > 0) {
                    this.onSnooze(val).then(() => this.close());
                }
            }
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}
