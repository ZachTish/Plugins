import { App, SuggestModal } from 'obsidian';

export interface HeaderInfo {
  text: string;
  level: number;
  line: number;
}

export class HeaderSelectionModal extends SuggestModal<HeaderInfo | string> {
  headers: HeaderInfo[];
  onChoose: (result: HeaderInfo | string | null) => void;
  chosen: boolean = false;

  constructor(app: App, headers: HeaderInfo[], onChoose: (result: HeaderInfo | string | null) => void) {
    super(app);
    this.headers = headers;
    this.onChoose = onChoose;
    this.setPlaceholder("Select a header in current file to append under...");
  }

  getSuggestions(query: string): (HeaderInfo | string)[] {
    const suggestions: (HeaderInfo | string)[] = ["Append to bottom"];
    const lowerQuery = query.toLowerCase();
    const filteredHeaders = this.headers.filter(h =>
      h.text.toLowerCase().includes(lowerQuery)
    );
    return [...suggestions, ...filteredHeaders];
  }

  renderSuggestion(item: HeaderInfo | string, el: HTMLElement) {
    if (typeof item === 'string') {
      el.createDiv({ text: item, cls: "header-selection-special" });
      el.style.fontWeight = 'bold';
      el.style.borderBottom = '1px solid var(--background-modifier-border)';
      el.style.marginBottom = '5px';
      el.style.paddingBottom = '5px';
    } else {
      const indent = (item.level - 1) * 15;
      const div = el.createDiv();
      div.style.paddingLeft = `${indent}px`;
      div.innerText = item.text;
      div.style.color = 'var(--text-normal)';
    }
  }

  onChooseSuggestion(item: HeaderInfo | string) {
    this.chosen = true;
    this.onChoose(item);
  }

  onClose() {
    if (!this.chosen) {
      this.onChoose(null);
    }
    this.contentEl.empty();
  }
}
