import { App, MarkdownPostProcessorContext, Menu, Notice, TFile, setIcon } from 'obsidian';

/**
 * Reading Mode post-processor for Canvas Notes
 * Wraps content between --- delimiters in draggable cards
 */
export class ReadingModeProcessor {
  constructor(private app: App) {}

  async process(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const sourceFile = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(sourceFile instanceof TFile)) return;

    const content = await this.app.vault.read(sourceFile);
    const lines = content.split('\n');

    // Find frontmatter end
    let contentStartLine = 0;
    if (lines[0]?.trim() === '---') {
      const frontmatterEnd = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
      if (frontmatterEnd !== -1) {
        contentStartLine = frontmatterEnd + 1;
      }
    }

    // Find all --- delimiters after frontmatter
    const delimiterLines: number[] = [];
    for (let i = contentStartLine; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        delimiterLines.push(i);
      }
    }

    // Parse cards from delimiters
    const cards: { startLine: number; endLine: number; content: string }[] = [];

    if (delimiterLines.length >= 2) {
      // Parse cards from delimiters
      for (let i = 0; i < delimiterLines.length - 1; i++) {
        const startLine = delimiterLines[i] + 1;
        const endLine = delimiterLines[i + 1] - 1;
        if (startLine <= endLine) {
          const cardContent = lines.slice(startLine, endLine + 1).join('\n');
          cards.push({ startLine, endLine, content: cardContent });
        }
      }
    } else {
      // No delimiters - treat entire content as one card
      const contentLines = lines.slice(contentStartLine);
      const cardContent = contentLines.join('\n');
      if (cardContent.trim().length > 0 || delimiterLines.length === 0) {
        cards.push({
          startLine: contentStartLine,
          endLine: lines.length - 1,
          content: cardContent
        });
      }
    }

    // Clear the element and rebuild with cards
    el.empty();

    const container = el.createDiv({ cls: 'tps-canvas-reading-container' });

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];

      // Create card wrapper
      const cardEl = container.createDiv({
        cls: card.content.trim() === '' ? 'tps-canvas-card tps-canvas-card-empty' : 'tps-canvas-card'
      });
      cardEl.setAttribute('draggable', 'true');
      cardEl.setAttribute('data-card-index', i.toString());

      // Render card content
      const contentEl = cardEl.createDiv({ cls: 'tps-canvas-card-content' });
      await this.renderMarkdown(card.content, contentEl, ctx);

      // Add menu button
      const menuBtn = cardEl.createDiv({ cls: 'tps-card-menu-button' });
      setIcon(menuBtn, 'more-vertical');
      menuBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showCardMenu(e, card, sourceFile);
      });

      // Add drag handlers
      this.setupDragHandlers(cardEl, i, cards, sourceFile);

      // Add insertion zone
      const insertionZone = container.createDiv({ cls: 'tps-card-insertion-zone' });
      insertionZone.setAttribute('data-insert-after', i.toString());
      this.setupInsertionZone(insertionZone, sourceFile);
    }

    // Final insertion zone at the end
    const finalZone = container.createDiv({ cls: 'tps-card-insertion-zone' });
    finalZone.setAttribute('data-insert-after', (cards.length - 1).toString());
    this.setupInsertionZone(finalZone, sourceFile);
  }

  private async renderMarkdown(
    markdown: string,
    container: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ) {
    await (window as any).MarkdownRenderer.renderMarkdown(
      markdown,
      container,
      ctx.sourcePath,
      this.app.workspace.getActiveViewOfType((window as any).MarkdownView)
    );
  }

  private setupDragHandlers(
    cardEl: HTMLElement,
    cardIndex: number,
    cards: any[],
    file: TFile
  ) {
    cardEl.addEventListener('dragstart', (e) => {
      if (!(e instanceof DragEvent)) return;
      if (!e.dataTransfer) return;

      e.dataTransfer.setData('application/tps-card-index', cardIndex.toString());
      e.dataTransfer.effectAllowed = 'move';
      cardEl.classList.add('tps-card-dragging');
    });

    cardEl.addEventListener('dragover', (e) => {
      if (!(e instanceof DragEvent)) return;
      if (!e.dataTransfer?.types.includes('application/tps-card-index')) return;

      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      cardEl.classList.add('tps-card-drop-target');
    });

    cardEl.addEventListener('dragleave', () => {
      cardEl.classList.remove('tps-card-drop-target');
    });

    cardEl.addEventListener('drop', async (e) => {
      if (!(e instanceof DragEvent)) return;
      if (!e.dataTransfer) return;

      e.preventDefault();
      cardEl.classList.remove('tps-card-drop-target');

      const sourceIndex = parseInt(e.dataTransfer.getData('application/tps-card-index'));
      const targetIndex = cardIndex;

      if (sourceIndex === targetIndex) return;

      await this.moveCard(file, sourceIndex, targetIndex);
    });

    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('tps-card-dragging');
    });
  }

  private setupInsertionZone(zone: HTMLElement, file: TFile) {
    // Left click: create new card
    zone.addEventListener('click', async (e) => {
      e.preventDefault();
      const insertAfter = parseInt(zone.getAttribute('data-insert-after') || '0');
      await this.insertNewCard(file, insertAfter);
    });

    // Right click: embed existing file
    zone.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      // TODO: Show file picker modal
      new Notice('Right-click embed not yet implemented in Reading Mode');
    });
  }

  private showCardMenu(event: MouseEvent, card: any, file: TFile) {
    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle('Extract to note')
        .setIcon('file-plus')
        .onClick(async () => {
          await this.extractCard(file, card);
        })
    );

    menu.addItem((item) =>
      item
        .setTitle('Delete card')
        .setIcon('trash')
        .onClick(async () => {
          await this.deleteCard(file, card);
        })
    );

    menu.showAtMouseEvent(event);
  }

  private async moveCard(file: TFile, fromIndex: number, toIndex: number) {
    const content = await this.app.vault.read(file);
    const lines = content.split('\n');

    // Find cards
    const cards = this.parseCardsFromLines(lines);
    if (fromIndex >= cards.length || toIndex >= cards.length) return;

    const sourceCard = cards[fromIndex];

    // Extract the card with delimiters
    const cardLines = lines.slice(sourceCard.delimiterStart, sourceCard.delimiterEnd + 1);

    // Remove from original position
    lines.splice(sourceCard.delimiterStart, sourceCard.delimiterEnd - sourceCard.delimiterStart + 1);

    // Recalculate target position after removal
    const updatedCards = this.parseCardsFromLines(lines);
    const targetCard = updatedCards[toIndex > fromIndex ? toIndex - 1 : toIndex];

    if (!targetCard) {
      // Insert at end
      lines.push(...cardLines);
    } else {
      // Insert before target
      lines.splice(targetCard.delimiterStart, 0, ...cardLines);
    }

    await this.app.vault.modify(file, lines.join('\n'));
    new Notice('Card moved');
  }

  private async insertNewCard(file: TFile, afterIndex: number) {
    const content = await this.app.vault.read(file);
    const lines = content.split('\n');

    const cards = this.parseCardsFromLines(lines);
    const insertPos = cards[afterIndex] ? cards[afterIndex].delimiterEnd + 1 : lines.length;

    lines.splice(insertPos, 0, '---', '', '---');

    await this.app.vault.modify(file, lines.join('\n'));
    new Notice('New card created');
  }

  private async deleteCard(file: TFile, card: any) {
    const content = await this.app.vault.read(file);
    const lines = content.split('\n');

    const cards = this.parseCardsFromLines(lines);
    const cardToDelete = cards.find(c =>
      c.startLine === card.startLine && c.endLine === card.endLine
    );

    if (!cardToDelete) return;

    lines.splice(
      cardToDelete.delimiterStart,
      cardToDelete.delimiterEnd - cardToDelete.delimiterStart + 1
    );

    await this.app.vault.modify(file, lines.join('\n'));
    new Notice('Card deleted');
  }

  private async extractCard(file: TFile, card: any) {
    // Similar to card-extract-service but for reading mode
    // TODO: Implement extraction
    new Notice('Extract not yet implemented in Reading Mode');
  }

  private parseCardsFromLines(lines: string[]): any[] {
    let contentStartLine = 0;
    if (lines[0]?.trim() === '---') {
      const frontmatterEnd = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
      if (frontmatterEnd !== -1) {
        contentStartLine = frontmatterEnd + 1;
      }
    }

    const delimiterLines: number[] = [];
    for (let i = contentStartLine; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        delimiterLines.push(i);
      }
    }

    const cards: any[] = [];
    for (let i = 0; i < delimiterLines.length - 1; i++) {
      cards.push({
        delimiterStart: delimiterLines[i],
        delimiterEnd: delimiterLines[i + 1],
        startLine: delimiterLines[i] + 1,
        endLine: delimiterLines[i + 1] - 1
      });
    }

    return cards;
  }
}
