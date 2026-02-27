import { App, Modal, Setting, TextComponent } from 'obsidian';
import { RECURRENCE_OPTIONS } from './constants';
import { RRule } from 'rrule';

export class RecurrenceModal extends Modal {
    currentRule: string;
    onSubmit: (rule: string) => void;
    previewEl: HTMLElement | null = null;
    startDate: Date;

    constructor(app: App, currentRule: string, startDate: Date, onSubmit: (rule: string) => void) {
        super(app);
        this.currentRule = currentRule;
        this.startDate = startDate;
        this.onSubmit = onSubmit;
    }

    private updatePreview(ruleStr: string): void {
        if (!this.previewEl) return;
        this.previewEl.empty();

        if (!ruleStr || !ruleStr.trim()) {
            this.previewEl.style.display = 'none';
            return;
        }

        try {
            // Parse the rule string into options, then override dtstart with the event's start date
            // This ensures the recurrence calculation is based on the event's date, not "now"
            const options = RRule.parseString(ruleStr);
            options.dtstart = this.startDate;
            const rule = new RRule(options);

            const start = this.startDate;
            const nextDates = rule.between(start, new Date(start.getTime() + 365 * 24 * 60 * 60 * 1000), true, (_, len) => len < 5);

            if (nextDates.length === 0) {
                this.previewEl.style.display = 'none';
                return;
            }

            this.previewEl.style.display = 'block';
            const titleEl = this.previewEl.createDiv({ cls: 'tps-gcm-recurrence-preview-title' });
            titleEl.textContent = 'Next Occurrences';

            const listEl = this.previewEl.createDiv({ cls: 'tps-gcm-recurrence-preview-list' });
            nextDates.forEach(date => {
                const itemEl = listEl.createDiv({ cls: 'tps-gcm-recurrence-preview-item' });
                itemEl.textContent = date.toLocaleDateString(undefined, {
                    weekday: 'short',
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                });
            });
        } catch (e) {
            // Invalid rule, hide preview
            this.previewEl.style.display = 'none';
        }
    }

    onOpen() {
        this.modalEl.addClass('mod-tps-gcm');
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Set Recurrence' });

        let ruleInput: TextComponent;

        new Setting(contentEl)
            .setName('Recurrence Rule')
            .setDesc('RRULE string (e.g., FREQ=WEEKLY;BYDAY=MO)')
            .addText((text) => {
                ruleInput = text;
                text.setValue(this.currentRule);
                text.setPlaceholder('FREQ=DAILY');
                text.inputEl.style.width = '100%';
                text.inputEl.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                        this.close();
                        this.onSubmit(ruleInput.getValue());
                    }
                });
                text.inputEl.addEventListener('input', () => {
                    this.updatePreview(ruleInput.getValue());
                });
            });

        const quickOptionsEl = contentEl.createDiv('tps-gcm-recurrence-options');
        quickOptionsEl.style.display = 'flex';
        quickOptionsEl.style.flexWrap = 'wrap';
        quickOptionsEl.style.gap = '8px';
        quickOptionsEl.style.marginTop = '12px';
        quickOptionsEl.style.marginBottom = '12px';

        RECURRENCE_OPTIONS.forEach(opt => {
            const btn = quickOptionsEl.createEl('button', { text: opt.label });
            btn.addEventListener('click', () => {
                ruleInput.setValue(opt.value);
                this.updatePreview(opt.value);
            });
        });

        // Preview section
        this.previewEl = contentEl.createDiv({ cls: 'tps-gcm-recurrence-preview' });
        this.updatePreview(this.currentRule);

        new Setting(contentEl)
            .addButton((btn) => {
                btn.setButtonText('Clear')
                    .setWarning()
                    .onClick(() => {
                        this.close();
                        this.onSubmit('');
                    });
            })
            .addButton((btn) => {
                btn.setButtonText('Save')
                    .setCta()
                    .onClick(() => {
                        this.close();
                        this.onSubmit(ruleInput.getValue());
                    });
            });
    }

    onClose() {
        this.contentEl.empty();
        this.previewEl = null;
    }
}
