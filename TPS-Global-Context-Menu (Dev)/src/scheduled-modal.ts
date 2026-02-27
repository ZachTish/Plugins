import { App, Modal, Setting, ToggleComponent, TextComponent } from 'obsidian';

export interface ScheduledResult {
    date: string;
    timeEstimate: number;
    allDay: boolean;
}

export class ScheduledModal extends Modal {
    currentDate: string;
    currentTimeEstimate: number;
    currentAllDay: boolean;
    onSubmit: (result: ScheduledResult) => void;

    // UI Elements
    dateComponent: TextComponent;
    timeEstimateComponent: TextComponent;
    endTimeComponent: TextComponent;
    allDayToggle: ToggleComponent;

    constructor(
        app: App,
        currentDate: string,
        currentTimeEstimate: number,
        currentAllDay: boolean,
        onSubmit: (result: ScheduledResult) => void
    ) {
        super(app);
        this.currentDate = currentDate;
        this.currentTimeEstimate = currentTimeEstimate || 0;
        this.currentAllDay = currentAllDay || false;
        this.onSubmit = onSubmit;
    }

    onOpen() {
        this.modalEl.addClass('mod-tps-gcm');
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Set Scheduled Date' });

        // Normalize date for datetime-local (YYYY-MM-DDTHH:mm)
        let initialDate = this.currentDate;
        if (initialDate && !initialDate.includes('T')) {
            initialDate = `${initialDate}T00:00`;
        }

        // 1. Scheduled Date Input
        new Setting(contentEl)
            .setName('Scheduled')
            .addText((text) => {
                text.inputEl.type = 'datetime-local';
                text.setValue(initialDate);
                this.dateComponent = text;

                text.inputEl.addEventListener('input', () => this.recalculateEndTime());
                text.inputEl.addEventListener('click', e => e.stopPropagation());
                text.inputEl.addEventListener('keydown', e => e.stopPropagation());
            });

        // 2. All Day Toggle
        new Setting(contentEl)
            .setName('All Day')
            .addToggle((toggle) => {
                toggle.setValue(this.currentAllDay);
                this.allDayToggle = toggle;
            });

        // 3. Time Estimate (Minutes)
        new Setting(contentEl)
            .setName('Time Estimate (minutes)')
            .addText((text) => {
                text.inputEl.type = 'number';
                text.setValue(String(this.currentTimeEstimate));
                this.timeEstimateComponent = text;

                text.inputEl.addEventListener('input', () => this.recalculateEndTime());
                text.inputEl.addEventListener('click', e => e.stopPropagation());
                text.inputEl.addEventListener('keydown', e => e.stopPropagation());
            });

        // 4. End Time (Computed / Editable)
        new Setting(contentEl)
            .setName('End Time')
            .setDesc('Modifying this updates Time Estimate')
            .addText((text) => {
                text.inputEl.type = 'datetime-local';
                this.endTimeComponent = text;

                // Use 'input' for immediate feedback, or 'change' if preferred. 
                // 'input' is better for responsiveness.
                text.inputEl.addEventListener('input', () => this.recalculateTimeEstimate());
                text.inputEl.addEventListener('click', e => e.stopPropagation());
                text.inputEl.addEventListener('keydown', e => e.stopPropagation());
            });

        // Initial calculation
        this.recalculateEndTime();

        // Footer Actions
        const footer = contentEl.createDiv('tps-gcm-modal-footer');
        footer.style.display = 'flex';
        footer.style.justifyContent = 'flex-end';
        footer.style.gap = '8px';
        footer.style.marginTop = '16px';

        const clearBtn = footer.createEl('button', { text: 'Clear' });
        clearBtn.classList.add('mod-warning');
        clearBtn.addEventListener('click', () => {
            this.close();
            this.onSubmit({ date: '', timeEstimate: 0, allDay: false });
        });

        const saveBtn = footer.createEl('button', { text: 'Save' });
        saveBtn.classList.add('mod-cta');
        saveBtn.addEventListener('click', () => {
            this.close();
            this.onSubmit({
                date: this.dateComponent.getValue(),
                timeEstimate: parseInt(this.timeEstimateComponent.getValue()) || 0,
                allDay: this.allDayToggle.getValue()
            });
        });
    }

    recalculateEndTime() {
        if (!this.dateComponent || !this.timeEstimateComponent || !this.endTimeComponent) return;

        const startDateStr = this.dateComponent.getValue();
        const minutes = parseInt(this.timeEstimateComponent.getValue()) || 0;

        if (!startDateStr) {
            this.endTimeComponent.setValue('');
            return;
        }

        const startDate = new Date(startDateStr);
        if (isNaN(startDate.getTime())) return;

        const endDate = new Date(startDate.getTime() + minutes * 60000);

        // Format for datetime-local: YYYY-MM-DDTHH:mm (Local Time)
        // toISOString() gives UTC. We need to adjust for timezone offset to get "Local ISO".
        const offsetMs = endDate.getTimezoneOffset() * 60000;
        const localDate = new Date(endDate.getTime() - offsetMs);
        const iso = localDate.toISOString().substring(0, 16);

        this.endTimeComponent.setValue(iso);
    }

    recalculateTimeEstimate() {
        if (!this.dateComponent || !this.timeEstimateComponent || !this.endTimeComponent) return;

        const startDateStr = this.dateComponent.getValue();
        const endDateStr = this.endTimeComponent.getValue();

        if (!startDateStr || !endDateStr) return;

        const startDate = new Date(startDateStr);
        const endDate = new Date(endDateStr);

        if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return;

        const diffMs = endDate.getTime() - startDate.getTime();
        const diffMins = Math.round(diffMs / 60000);

        if (diffMins >= 0) {
            this.timeEstimateComponent.setValue(String(diffMins));
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
