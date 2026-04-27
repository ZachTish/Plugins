/**
 * Modal for handling unresolved/deleted subitem body links.
 * Prompts the user whether to remove lines referencing missing/deleted notes
 * instead of silently deleting them.
 */
import { App, Modal, TFile, Setting } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import { resolveLinkTargetToFile } from './link-target-service';

export interface UnresolvedSubitem {
  /** The line text from the body */
  rawLine: string;
  /** The line number (0-indexed) */
  line: number;
  /** The link target that couldn't be resolved */
  linkTarget: string;
  /** Whether the file was deleted (vs just missing) */
  isDeleted?: boolean;
}

export class UnresolvedSubitemModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly plugin: TPSGlobalContextMenuPlugin,
    private readonly parentFile: TFile,
    private readonly unresolved: UnresolvedSubitem[],
    private readonly onResolve: (linesToRemove: number[]) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('mod-tps-gcm');

    // Title
    contentEl.createEl('h2', { text: 'Unresolved Subitem Links' });

    // Description
    contentEl.createEl('p', {
      text: `The note "${this.parentFile.basename}" contains ${this.unresolved.length} subitem link${this.unresolved.length === 1 ? '' : 's'} referencing notes that no longer exist. Would you like to remove these lines?`,
      cls: 'tps-gcm-modal-description',
    });

    // List of unresolved items
    const listContainer = contentEl.createDiv({ cls: 'tps-gcm-unresolved-list' });
    for (const item of this.unresolved) {
      const itemEl = listContainer.createDiv({ cls: 'tps-gcm-unresolved-item' });
      itemEl.createEl('code', { text: item.linkTarget, cls: 'tps-gcm-unresolved-link' });
      itemEl.createEl('span', {
        text: ` (line ${item.line + 1})`,
        cls: 'tps-gcm-unresolved-line',
      });
      if (item.isDeleted) {
        itemEl.createEl('span', {
          text: ' — deleted',
          cls: 'tps-gcm-unresolved-deleted',
        });
      }
    }

    // Buttons
    const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

    // Remove all button
    new Setting(buttonContainer)
      .addButton((btn) =>
        btn
          .setButtonText(`Remove ${this.unresolved.length} link${this.unresolved.length === 1 ? '' : 's'}`)
          .setCta()
          .onClick(() => this.handleRemoveAll()),
      );

    // Keep all button
    new Setting(buttonContainer)
      .addButton((btn) =>
        btn
          .setButtonText('Keep all links')
          .onClick(() => this.handleKeepAll()),
      );

    // Cancel button
    new Setting(buttonContainer)
      .addButton((btn) =>
        btn.setButtonText('Cancel').onClick(() => this.close()),
      );
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }

  private async handleRemoveAll(): Promise<void> {
    if (this.resolved) return;
    this.resolved = true;

    const linesToRemove = this.unresolved.map((item) => item.line);
    await this.onResolve(linesToRemove);
    this.close();
  }

  private handleKeepAll(): void {
    if (this.resolved) return;
    this.resolved = true;
    // Don't remove any lines
    this.close();
  }
}

/**
 * Check a parent file for unresolved subitem links and prompt user if found.
 * Returns true if the check was performed (even if no unresolved links found).
 */
export async function checkAndPromptForUnresolvedSubitems(
  plugin: TPSGlobalContextMenuPlugin,
  parentFile: TFile,
): Promise<boolean> {
  const raw = await plugin.subitemRelationshipSyncService.readMarkdownText(parentFile);
  const lines = String(raw || '').split('\n');

  const unresolved: UnresolvedSubitem[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] || '';
    const parsed = plugin.bodySubitemLinkService.parseLine(rawLine);
    if (!parsed) continue;
    const resolved = resolveLinkTargetToFile(plugin.app, parsed.linkTarget, parentFile.path);
    if (resolved instanceof TFile) continue;

    const normalizedTarget = parsed.linkTarget.replace(/^\/+/, '').replace(/\.md$/i, '').trim().toLowerCase();
    const matchesExistingBasename = plugin.app.vault.getMarkdownFiles().some((file) => file.basename.trim().toLowerCase() === normalizedTarget);

    unresolved.push({
      rawLine,
      line: index,
      linkTarget: parsed.linkTarget,
      isDeleted: !matchesExistingBasename,
    });
  }

  if (unresolved.length === 0) {
    return false;
  }

  return new Promise((resolve) => {
    const modal = new UnresolvedSubitemModal(
      plugin.app,
      plugin,
      parentFile,
      unresolved,
      async (linesToRemove) => {
        if (linesToRemove.length === 0) {
          resolve(true);
          return;
        }

        // Remove the lines (in reverse order to preserve line numbers)
        const sortedLines = [...linesToRemove].sort((a, b) => b - a);
        await plugin.subitemRelationshipSyncService.mutateMarkdownBody(parentFile, async (lines) => {
          let changed = false;
          for (const lineNum of sortedLines) {
            if (lineNum >= 0 && lineNum < lines.length) {
              lines.splice(lineNum, 1);
              changed = true;
            }
          }
          return changed;
        });
        resolve(true);
      },
    );

    modal.onClose = () => resolve(true);
    modal.open();
  });
}
