import { App, Notice, TFile, normalizePath } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { CardBoundary } from './card-parser';

/**
 * Service for extracting cards into standalone notes
 */
export class CardExtractService {
  constructor(private app: App) {}

  /**
   * Extract a card to a new note and replace with embed
   */
  async extractCard(view: EditorView, card: CardBoundary, currentFile: TFile): Promise<void> {
    const content = view.state.doc.sliceString(card.startPos, card.endPos).trim();

    if (!content) {
      new Notice('Cannot extract empty card');
      return;
    }

    // Generate filename from first line
    const firstLine = content.split('\n')[0];
    const filename = this.sanitizeFilename(this.extractTitle(firstLine));

    // Get the new file location (vault's default new file location)
    const newFilePath = this.getNewFilePath(filename);

    try {
      // Create the new file
      const newFile = await this.app.vault.create(newFilePath, content);

      // Replace card content with embed
      // We need to include the delimiters in the replacement
      const doc = view.state.doc;
      const startDelimiterLine = doc.line(card.startLine); // Line before card content
      const endDelimiterLine = doc.line(card.endLine + 2); // Line after card content

      view.dispatch({
        changes: {
          from: card.startPos,
          to: card.endPos,
          insert: `![[${newFile.basename}]]`
        }
      });

      new Notice(`Card extracted to "${newFile.basename}"`);
    } catch (error) {
      console.error('Failed to extract card:', error);
      new Notice('Failed to extract card: ' + error.message);
    }
  }

  /**
   * Extract title from first line of content (strip markdown syntax)
   */
  private extractTitle(firstLine: string): string {
    // Remove markdown heading markers
    let title = firstLine.replace(/^#+\s*/, '');

    // Remove other markdown formatting
    title = title.replace(/[*_~`]/g, '');

    // Remove links but keep link text
    title = title.replace(/\[\[([^\]]+)\]\]/g, '$1');
    title = title.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');

    // Trim and truncate
    title = title.trim();
    if (title.length > 50) {
      title = title.substring(0, 50);
    }

    return title || `Untitled ${Date.now()}`;
  }

  /**
   * Sanitize filename (remove invalid characters)
   */
  private sanitizeFilename(filename: string): string {
    return filename.replace(/[\\/:*?"<>|]/g, '-');
  }

  /**
   * Get the path for a new file based on vault settings
   */
  private getNewFilePath(filename: string): string {
    // @ts-ignore - accessing private API
    const newFileLocation = this.app.vault.getConfig('newFileLocation');
    // @ts-ignore
    const newFileFolderPath = this.app.vault.getConfig('newFileFolderPath');

    let folderPath = '';

    if (newFileLocation === 'folder') {
      folderPath = newFileFolderPath || '';
    } else if (newFileLocation === 'current') {
      // Use current file's folder
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) {
        folderPath = activeFile.parent?.path || '';
      }
    }
    // 'root' or default: use root

    const path = folderPath ? `${folderPath}/${filename}.md` : `${filename}.md`;
    return normalizePath(path);
  }
}
