import {
  ViewUpdate,
  PluginValue,
  ViewPlugin,
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType
} from '@codemirror/view';
import { RangeSetBuilder, Extension } from '@codemirror/state';
import { App, setIcon, Menu } from 'obsidian';
import { parseCards, CardBoundary, getDelimiterLines } from './card-parser';
import { InsertionZoneHandler } from './insertion-zone-handler';
import { CardExtractService } from './card-extract-service';
import { createReadOnlyFilter } from './read-only-filter';

/**
 * Widget for insertion zones between cards
 */
class InsertionZoneWidget extends WidgetType {
  constructor(
    private handler: InsertionZoneHandler,
    private pos: number
  ) {
    super();
  }

  eq(other: InsertionZoneWidget): boolean {
    return other.pos === this.pos;
  }

  toDOM(view: EditorView): HTMLElement {
    const zone = document.createElement('div');
    zone.className = 'tps-card-insertion-zone';
    zone.setAttribute('data-pos', this.pos.toString());

    // Left-click: create empty card
    zone.addEventListener('click', (e) => {
      e.preventDefault();
      this.handler.handleClick(view, this.pos);
    });

    // Right-click: embed existing file
    zone.addEventListener('contextmenu', (e) => {
      this.handler.handleRightClick(view, this.pos, e);
    });

    return zone;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Widget for card menu button (three dots)
 */
class CardMenuWidget extends WidgetType {
  constructor(
    private app: App,
    private card: CardBoundary,
    private extractService: CardExtractService
  ) {
    super();
  }

  eq(other: CardMenuWidget): boolean {
    return (
      other.card.startPos === this.card.startPos &&
      other.card.endPos === this.card.endPos
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'tps-card-menu-button';
    setIcon(container, 'more-vertical');

    container.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const menu = new Menu();

      menu.addItem((item) =>
        item
          .setTitle('Extract to note')
          .setIcon('file-plus')
          .onClick(async () => {
            const file = this.app.workspace.getActiveFile();
            if (file) {
              await this.extractService.extractCard(view, this.card, file);
            }
          })
      );

      menu.addItem((item) =>
        item
          .setTitle('Delete card')
          .setIcon('trash')
          .onClick(() => {
            // Delete card including delimiters
            const doc = view.state.doc;
            const startDelimiterLine = doc.line(this.card.startLine);
            const endDelimiterLine = doc.line(this.card.endLine + 2);

            view.dispatch({
              changes: {
                from: startDelimiterLine.from - 4, // Include the --- above
                to: endDelimiterLine.to + 1 // Include the --- below and newline
              }
            });
          })
      );

      menu.showAtMouseEvent(e);
    });

    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Main Canvas Extension
 */
class CanvasExtension implements PluginValue {
  decorations: DecorationSet;
  app: App;
  insertionHandler: InsertionZoneHandler;
  extractService: CardExtractService;
  draggedCard: CardBoundary | null = null;

  constructor(view: EditorView, app: App) {
    this.app = app;
    this.insertionHandler = new InsertionZoneHandler(app);
    this.extractService = new CardExtractService(app);
    this.decorations = this.buildDecorations(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet) {
      this.decorations = this.buildDecorations(update.view);
    }
  }

  buildDecorations(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    const cards = parseCards(view.state);
    const delimiterLines = getDelimiterLines(view.state);

    // Collect all decorations with their positions
    const decorations: Array<{ from: number; to: number; decoration: Decoration }> = [];

    // Hide delimiter lines
    for (const lineNum of delimiterLines) {
      const line = view.state.doc.line(lineNum + 1);
      decorations.push({
        from: line.from,
        to: line.from,
        decoration: Decoration.line({ class: 'tps-card-delimiter-hidden' })
      });
    }

    // Add card decorations
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];

      // Add line decoration for entire card range
      for (let lineNum = card.startLine; lineNum <= card.endLine; lineNum++) {
        const line = view.state.doc.line(lineNum + 1);
        decorations.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({
            class: card.isEmpty ? 'tps-canvas-card-line tps-canvas-card-empty' : 'tps-canvas-card-line'
          })
        });
      }

      // Add menu widget at end of first line of card
      const firstLine = view.state.doc.line(card.startLine + 1);
      decorations.push({
        from: firstLine.to,
        to: firstLine.to,
        decoration: Decoration.widget({
          widget: new CardMenuWidget(this.app, card, this.extractService),
          side: 1
        })
      });

      // Add insertion zone after each card
      const lastLine = view.state.doc.line(card.endLine + 1);
      decorations.push({
        from: lastLine.to,
        to: lastLine.to,
        decoration: Decoration.widget({
          widget: new InsertionZoneWidget(this.insertionHandler, lastLine.to),
          side: 1
        })
      });
    }

    // Add insertion zone at very end of document if there are cards
    if (cards.length > 0) {
      const lastLine = view.state.doc.line(view.state.doc.lines);
      decorations.push({
        from: lastLine.to,
        to: lastLine.to,
        decoration: Decoration.widget({
          widget: new InsertionZoneWidget(this.insertionHandler, lastLine.to),
          side: 1
        })
      });
    }

    // Sort decorations by position (required by RangeSetBuilder)
    decorations.sort((a, b) => a.from - b.from);

    // Add sorted decorations to builder
    for (const { from, to, decoration } of decorations) {
      builder.add(from, to, decoration);
    }

    return builder.finish();
  }

  destroy() {
    // Cleanup if needed
  }
}

/**
 * Build and export the Canvas extension
 * @param app Obsidian App instance
 * @param shouldActivate Optional function to check if extension should be active
 */
export function buildCanvasExtension(app: App, shouldActivate?: () => boolean): Extension[] {
  const viewPlugin = ViewPlugin.define(
    (view) => new CanvasExtension(view, app),
    {
      decorations: (v) => {
        // Check if extension should be active for this file
        if (shouldActivate && !shouldActivate()) {
          return Decoration.none;
        }
        return v.decorations;
      },

      eventHandlers: {
        dragstart: (e: DragEvent, view: EditorView) => {
          // Check if extension should be active
          if (shouldActivate && !shouldActivate()) {
            return false;
          }

          const target = e.target as HTMLElement;

          // Check if dragging from a card line
          if (!target.closest('.tps-canvas-card-line')) {
            return false;
          }

          const pos = view.posAtDOM(target);
          const cards = parseCards(view.state);
          const card = cards.find(c => pos >= c.startPos && pos <= c.endPos);

          if (!card) return false;

          const content = view.state.doc.sliceString(card.startPos, card.endPos);

          if (e.dataTransfer) {
            e.dataTransfer.setData('text/plain', content);
            e.dataTransfer.setData(
              'application/tps-canvas-card',
              JSON.stringify({
                startPos: card.startPos,
                endPos: card.endPos,
                startLine: card.startLine,
                endLine: card.endLine
              })
            );
            e.dataTransfer.effectAllowed = 'move';
          }

          // Add dragging class
          target.classList.add('tps-card-dragging');

          return false;
        },

        dragover: (e: DragEvent, view: EditorView) => {
          // Check if extension should be active
          if (shouldActivate && !shouldActivate()) {
            return false;
          }

          if (!e.dataTransfer?.types.includes('application/tps-canvas-card')) {
            return false;
          }

          e.preventDefault();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = 'move';
          }

          return true;
        },

        drop: (e: DragEvent, view: EditorView) => {
          // Check if extension should be active
          if (shouldActivate && !shouldActivate()) {
            return false;
          }

          if (!e.dataTransfer?.types.includes('application/tps-canvas-card')) {
            return false;
          }

          e.preventDefault();

          const cardDataRaw = e.dataTransfer.getData('application/tps-canvas-card');
          if (!cardDataRaw) return true;

          let cardData: any;
          try {
            cardData = JSON.parse(cardDataRaw);
          } catch {
            return true;
          }

          const dropPos = view.posAtCoords({ x: e.clientX, y: e.clientY });
          if (dropPos === null) return true;

          // Find which card we're dropping into/near
          const cards = parseCards(view.state);
          let insertBeforeCard: CardBoundary | null = null;

          for (const card of cards) {
            if (dropPos < card.startPos) {
              insertBeforeCard = card;
              break;
            }
          }

          // Don't drop on itself
          if (
            insertBeforeCard &&
            insertBeforeCard.startPos === cardData.startPos
          ) {
            return true;
          }

          // Get the full card content including delimiters
          const doc = view.state.doc;
          const sourceStartDelim = doc.line(cardData.startLine); // Line before content
          const sourceEndDelim = doc.line(cardData.endLine + 2); // Line after content

          const fullCardContent = doc.sliceString(
            sourceStartDelim.from - 4,
            sourceEndDelim.to
          );

          let insertPos: number;
          if (insertBeforeCard) {
            // Insert before this card's starting delimiter
            const targetDelim = doc.line(insertBeforeCard.startLine);
            insertPos = targetDelim.from - 4;
          } else {
            // Insert at end
            insertPos = doc.length;
          }

          // Perform the move
          view.dispatch({
            changes: [
              // Delete from original position
              {
                from: sourceStartDelim.from - 4,
                to: sourceEndDelim.to + 1,
                insert: ''
              },
              // Insert at new position (adjust if needed based on deletion)
              {
                from: insertPos > cardData.startPos ? insertPos - (sourceEndDelim.to - sourceStartDelim.from + 5) : insertPos,
                insert: fullCardContent + '\n'
              }
            ]
          });

          return true;
        },

        dragend: (e: DragEvent) => {
          // Remove dragging class
          const target = e.target as HTMLElement;
          target.classList.remove('tps-card-dragging');
          return false;
        }
      }
    }
  );

  // Return an array of extensions: the view plugin and the read-only filter
  return [viewPlugin, createReadOnlyFilter()];
}
