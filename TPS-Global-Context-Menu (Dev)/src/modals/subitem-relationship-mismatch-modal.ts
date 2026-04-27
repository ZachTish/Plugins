import { App, Modal, Setting } from 'obsidian';
import type { SubitemRelationshipMismatch } from '../services/subitem-types';

export type SubitemRelationshipMismatchResolution =
  | 'restore-parent-link'
  | 'remove-body-link'
  | 'detach-body-link'
  | 'restore-body-link'
  | 'remove-parent-link'
  | 'snooze'
  | 'cancel';

export class SubitemRelationshipMismatchModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly mismatch: SubitemRelationshipMismatch,
    private readonly onResolve: (resolution: SubitemRelationshipMismatchResolution) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('mod-tps-gcm');
    const { contentEl } = this;
    contentEl.empty();

    const isBodyOnly = this.mismatch.kind === 'body-only';
    const parentTitle = this.mismatch.parentFile.basename;
    const childTitle = this.mismatch.childFile.basename;

    contentEl.createEl('h2', {
      text: isBodyOnly ? 'Subitem Link Missing Parent Link' : 'Parent Link Missing Body Link',
    });
    contentEl.createEl('p', {
      text: isBodyOnly
        ? `"${parentTitle}" still contains a subitem body link to "${childTitle}", but "${childTitle}" no longer links back to that parent in frontmatter.`
        : `"${childTitle}" still links to "${parentTitle}" in frontmatter, but "${parentTitle}" no longer contains the matching body subitem link.`,
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
    preview.createDiv({ text: `Parent: ${this.mismatch.parentFile.path}` });
    preview.createDiv({ text: `Child: ${this.mismatch.childFile.path}` });
    if (typeof this.mismatch.line === 'number') {
      preview.createDiv({ text: `Line: ${this.mismatch.line + 1}` });
    }
    if (this.mismatch.rawLine) {
      preview.createDiv({ text: this.mismatch.rawLine });
    }

    const buttonContainer = contentEl.createDiv('tps-gcm-modal-buttons');
    buttonContainer.style.display = 'flex';
    buttonContainer.style.flexDirection = 'column';
    buttonContainer.style.gap = '10px';

    const addAction = (label: string, resolution: SubitemRelationshipMismatchResolution, cta = false, warning = false) => {
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

    if (isBodyOnly) {
      addAction('Restore Parent Link On Child', 'restore-parent-link', true);
      addAction('Remove Subitem Link From Parent Body', 'remove-body-link');
      addAction('Keep Body Link But Detach Managed Behavior', 'detach-body-link');
    } else {
      addAction('Restore Body Link In Parent', 'restore-body-link', true);
      addAction('Remove Parent Link From Child', 'remove-parent-link');
    }

    addAction("I'm Reordering The Page", 'snooze');
    addAction('Cancel', 'cancel', false, true);
  }

  onClose(): void {
    if (!this.resolved) {
      this.onResolve('cancel');
    }
    this.contentEl.empty();
  }
}
