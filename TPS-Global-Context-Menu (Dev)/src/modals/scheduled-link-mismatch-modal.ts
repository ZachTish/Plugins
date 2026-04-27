import { App, Modal, Setting } from 'obsidian';
import type { ScheduledLinkMismatch } from '../services/scheduled-link-guard-service';

export type ScheduledLinkResolution =
  | 'embed-in-daily-note'
  | 'reschedule'
  | 'dismiss'
  | 'snooze'
  | 'cancel';

export class ScheduledLinkMismatchModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly mismatch: ScheduledLinkMismatch,
    private readonly onResolve: (resolution: ScheduledLinkResolution) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('mod-tps-gcm');
    const { contentEl } = this;
    contentEl.empty();

    const isDailyNoteOpened = this.mismatch.direction === 'daily-note-opened';
    const scheduledTitle = this.mismatch.scheduledFile.basename;
    const dateStr = this.mismatch.scheduledDate;

    contentEl.createEl('h2', {
      text: isDailyNoteOpened
        ? 'Scheduled Note Not Embedded'
        : 'Daily Note Missing Embed',
    });

    contentEl.createEl('p', {
      text: isDailyNoteOpened
        ? `"${scheduledTitle}" is scheduled for today (${dateStr}) but is not embedded in this daily note.`
        : `"${scheduledTitle}" is scheduled for ${dateStr} but is not embedded in that day's daily note.`,
    });

    const preview = contentEl.createDiv({ cls: 'tps-gcm-checklist-preview' });
    preview.style.maxHeight = '180px';
    preview.style.overflowY = 'auto';
    preview.style.background = 'var(--background-secondary)';
    preview.style.padding = '10px';
    preview.style.borderRadius = '4px';
    preview.style.marginBottom = '20px';
    preview.style.fontFamily = 'var(--font-monospace)';
    preview.style.fontSize = '0.9em';
    preview.createDiv({ text: `Scheduled note: ${this.mismatch.scheduledFile.path}` });
    preview.createDiv({ text: `Scheduled date: ${dateStr}` });
    if (this.mismatch.dailyNoteFile) {
      preview.createDiv({ text: `Daily note: ${this.mismatch.dailyNoteFile.path}` });
    } else {
      preview.createDiv({ text: 'Daily note: (not found)' });
    }

    const buttonContainer = contentEl.createDiv('tps-gcm-modal-buttons');
    buttonContainer.style.display = 'flex';
    buttonContainer.style.flexDirection = 'column';
    buttonContainer.style.gap = '10px';

    const addAction = (
      label: string,
      resolution: ScheduledLinkResolution,
      cta = false,
      warning = false,
    ) => {
      new Setting(buttonContainer)
        .setClass('tps-gcm-no-border')
        .addButton((btn) => {
          btn.setButtonText(label);
          if (cta) btn.setCta();
          if (warning) btn.setWarning();
          btn.onClick(() => {
            this.resolved = true;
            this.onResolve(resolution);
            this.close();
          });
        });
    };

    addAction('Embed in Daily Note', 'embed-in-daily-note', true);

    if (!isDailyNoteOpened) {
      addAction('Reschedule', 'reschedule');
    }

    addAction('Dismiss', 'dismiss');
    addAction("I'm Reordering", 'snooze');
    addAction('Cancel', 'cancel', false, true);
  }

  onClose(): void {
    if (!this.resolved) {
      this.onResolve('cancel');
    }
    this.contentEl.empty();
  }
}
