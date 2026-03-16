import { App, SuggestModal, TFile } from 'obsidian';

export class FileSelectionModal extends SuggestModal<TFile> {
  onChoose: (file: TFile) => void;

  constructor(app: App, onChoose: (file: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Select existing note to link...");
  }

  getSuggestions(query: string): TFile[] {
    const files = this.app.vault.getMarkdownFiles();
    return files.filter(f => f.path.toLowerCase().includes(query.toLowerCase()));
  }

  renderSuggestion(file: TFile, el: HTMLElement) {
    el.setText(file.path);
  }

  onChooseSuggestion(file: TFile) {
    this.onChoose(file);
  }
}
