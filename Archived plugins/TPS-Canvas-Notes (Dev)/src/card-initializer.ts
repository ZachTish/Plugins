import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';

/**
 * Initialize a daily note with the card structure if it doesn't have any cards yet
 */
export function initializeCardStructure(view: EditorView): boolean {
  const doc = view.state.doc;
  const text = doc.toString();

  // Check if there's already content with --- delimiters (skip frontmatter)
  const lines = text.split('\n');
  let contentStartIdx = 0;

  // Skip frontmatter
  if (lines[0]?.trim() === '---') {
    const frontmatterEnd = lines.findIndex((line, idx) => idx > 0 && line.trim() === '---');
    if (frontmatterEnd !== -1) {
      contentStartIdx = frontmatterEnd + 1;
    }
  }

  const contentLines = lines.slice(contentStartIdx);
  const hasDelimiters = contentLines.some(line => line.trim() === '---');

  // If there are already delimiters, don't initialize
  if (hasDelimiters) {
    return false;
  }

  // Check if there's any content after frontmatter
  const hasContent = contentLines.some(line => line.trim().length > 0);

  // Build initial structure
  const frontmatterLines = lines.slice(0, contentStartIdx);
  const frontmatter = frontmatterLines.join('\n');

  let newContent: string;
  if (hasContent) {
    // Wrap existing content in a card
    const existingContent = contentLines.join('\n').trim();
    newContent = `${frontmatter}\n---\n${existingContent}\n\n---\n`;
  } else {
    // Create an empty card
    newContent = `${frontmatter}\n---\n\n---\n`;
  }

  // Apply the changes
  view.dispatch({
    changes: {
      from: 0,
      to: doc.length,
      insert: newContent
    }
  });

  return true;
}
