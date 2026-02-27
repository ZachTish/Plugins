import { EditorView } from '@codemirror/view';
import { App, FuzzySuggestModal, TFile } from 'obsidian';

/**
 * Handles insertion zone interactions (click to create card, right-click to embed)
 */
export class InsertionZoneHandler {
  constructor(private app: App) {}

  /**
   * Handle left-click: insert new empty card
   */
  handleClick(view: EditorView, pos: number) {
    const line = view.state.doc.lineAt(pos);

    // Insert at the start of the line where clicked
    view.dispatch({
      changes: {
        from: line.from,
        insert: '---\n\n---\n'
      },
      selection: { anchor: line.from + 5 } // Position cursor inside new card
    });
  }

  /**
   * Handle right-click: show file picker to embed existing note
   */
  handleRightClick(view: EditorView, pos: number, event: MouseEvent) {
    event.preventDefault();

    new FileSuggestModal(this.app, (file: TFile) => {
      const line = view.state.doc.lineAt(pos);

      // Insert card with embed
      view.dispatch({
        changes: {
          from: line.from,
          insert: `---\n![[${file.basename}]]\n---\n`
        }
      });
    }).open();
  }
}

/**
 * Modal for selecting a file to embed
 */
class FileSuggestModal extends FuzzySuggestModal<TFile> {
  private onChooseCallback: (file: TFile) => void;

  constructor(app: App, onChooseItem: (file: TFile) => void) {
    super(app);
    this.onChooseCallback = onChooseItem;
    this.setPlaceholder('Select a file to embed as a card...');
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    this.onChooseCallback(file);
  }
}
