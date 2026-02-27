import { EditorState } from '@codemirror/state';

export interface CardBoundary {
  startLine: number;  // 0-indexed line number (inclusive)
  endLine: number;    // 0-indexed line number (inclusive)
  startPos: number;   // Character position in document
  endPos: number;     // Character position in document
  isEmpty: boolean;   // True if card has no content between delimiters
}

/**
 * Parses editor content into card boundaries based on --- delimiters
 * Frontmatter is excluded and cards are only defined by explicit --- markers
 */
export function parseCards(state: EditorState): CardBoundary[] {
  const doc = state.doc;
  const cards: CardBoundary[] = [];
  const lines: string[] = [];

  // Build line array
  for (let i = 1; i <= doc.lines; i++) {
    lines.push(doc.line(i).text);
  }

  // Find frontmatter end (if exists)
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

  // No delimiters = create a default card for the entire content area
  if (delimiterLines.length === 0) {
    // Create a single card that spans from after frontmatter to end of document
    const startLine = contentStartLine;
    const endLine = lines.length - 1;

    if (startLine <= endLine) {
      const startPos = doc.line(startLine + 1).from;
      const endPos = doc.line(endLine + 1).to;
      const cardText = doc.sliceString(startPos, endPos).trim();

      return [{
        startLine,
        endLine,
        startPos,
        endPos,
        isEmpty: cardText.length === 0
      }];
    }
    return [];
  }

  // Build cards from delimiters
  // Cards are defined as content BETWEEN --- markers
  for (let i = 0; i < delimiterLines.length - 1; i++) {
    const startLine = delimiterLines[i];
    const endLine = delimiterLines[i + 1];
    const contentStartLine = startLine + 1;
    const contentEndLine = endLine - 1;

    if (contentStartLine <= contentEndLine) {
      const startPos = doc.line(contentStartLine + 1).from;
      const endPos = doc.line(contentEndLine + 1).to;

      // Check if card is empty (only whitespace between delimiters)
      const cardText = doc.sliceString(startPos, endPos).trim();

      cards.push({
        startLine: contentStartLine,
        endLine: contentEndLine,
        startPos,
        endPos,
        isEmpty: cardText.length === 0
      });
    }
  }

  return cards;
}

/**
 * Finds which card contains the given position
 */
export function findCardAtPos(cards: CardBoundary[], pos: number): CardBoundary | null {
  return cards.find(card => pos >= card.startPos && pos <= card.endPos) || null;
}

/**
 * Gets the delimiter line numbers for a document (useful for hiding them)
 */
export function getDelimiterLines(state: EditorState): number[] {
  const doc = state.doc;
  const lines: string[] = [];
  const delimiterLines: number[] = [];

  // Find frontmatter end
  let contentStartLine = 0;
  for (let i = 1; i <= doc.lines; i++) {
    lines.push(doc.line(i).text);
  }

  if (lines[0]?.trim() === '---') {
    const frontmatterEnd = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
    if (frontmatterEnd !== -1) {
      contentStartLine = frontmatterEnd + 1;
    }
  }

  // Find all --- after frontmatter
  for (let i = contentStartLine; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      delimiterLines.push(i);
    }
  }

  return delimiterLines;
}
