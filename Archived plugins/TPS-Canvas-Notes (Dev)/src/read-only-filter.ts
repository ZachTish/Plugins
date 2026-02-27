import { EditorState, Transaction, TransactionSpec } from '@codemirror/state';
import { parseCards } from './card-parser';

/**
 * Transaction filter that prevents editing outside of card boundaries
 * Only allows edits within card content areas (between --- delimiters)
 */
export function createReadOnlyFilter() {
  return EditorState.transactionFilter.of((tr: Transaction): TransactionSpec | readonly TransactionSpec[] => {
    // Allow transactions that don't change the document
    if (!tr.docChanged) {
      return tr;
    }

    // Parse current card boundaries
    const cards = parseCards(tr.startState);

    // If there are no cards, block all changes
    if (cards.length === 0) {
      return [];
    }

    // Check each change in the transaction
    let hasInvalidChange = false;
    tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      // Check if this change is within any card
      const isInCard = cards.some(card => {
        // Allow changes that are completely within a card
        return fromA >= card.startPos && toA <= card.endPos;
      });

      // If the change is outside all cards, check if it's allowed
      if (!isInCard) {
        // Allow if this is a change that's inserting card delimiters (---)
        const insertedText = inserted.toString();
        if (!insertedText.includes('---')) {
          // Block changes outside cards that aren't delimiter insertions
          hasInvalidChange = true;
        }
      }
    });

    // If any invalid changes were found, block the transaction
    if (hasInvalidChange) {
      return [];
    }

    // All changes are within cards, allow the transaction
    return tr;
  });
}
