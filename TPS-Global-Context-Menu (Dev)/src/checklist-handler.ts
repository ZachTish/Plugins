import { App, TFile } from 'obsidian';
import { ChecklistPromptModal } from './checklist-prompt-modal';
import * as logger from './logger';

export class ChecklistHandler {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Scan a file for incomplete checklist items
   */
  async scanChecklistItems(file: TFile): Promise<string[]> {
    try {
      const content = await this.app.vault.read(file);
      const lines = content.split('\n');
      const incompleteItems: string[] = [];

      const regex = /^\s*[-*+]\s*\[ \]\s*(.*)$/;

      for (const line of lines) {
        const match = line.match(regex);
        if (match) {
          incompleteItems.push(match[1].trim());
        }
      }
      return incompleteItems;
    } catch (error) {
      logger.error(`[TPS GCM] Failed to scan checklist items for ${file.path}:`, error);
      return [];
    }
  }

  /**
   * Update checklist items in a file based on action
   */
  async updateChecklistItems(file: TFile, action: 'complete' | 'progress'): Promise<void> {
    try {
      let content = await this.app.vault.read(file);

      if (action === 'complete') {
        content = content.replace(/^(\s*[-*+]\s*)\[ \]/gm, '$1[x]');
      } else if (action === 'progress') {
        content = content.replace(/^(\s*[-*+]\s*)\[ \]/gm, '$1[?]');
      }

      await this.app.vault.modify(file, content);
    } catch (error) {
      logger.error(`[TPS GCM] Failed to update checklist items for ${file.path}:`, error);
    }
  }

  /**
   * Prompt user about incomplete checklist items before completing a task.
   * Returns true if the status change should proceed, false to abort.
   */
  async handleChecklistCompletion(file: TFile): Promise<boolean> {
    const incompleteItems = await this.scanChecklistItems(file);

    if (incompleteItems.length === 0) {
      return true;
    }

    const userAction = await new Promise<string>((resolve) => {
      new ChecklistPromptModal(this.app, incompleteItems, (result) => {
        resolve(result);
      }).open();
    });

    if (userAction === 'cancel') {
      return false;
    }

    if (userAction === 'open') {
      const leaf = this.app.workspace.getLeaf(false);
      if (leaf) {
        await leaf.openFile(file);
      }
      return false;
    }

    if (userAction === 'complete') {
      await this.updateChecklistItems(file, 'complete');
    } else if (userAction === 'progress') {
      await this.updateChecklistItems(file, 'progress');
    }
    // 'ignore' falls through to set status
    return true;
  }
}
