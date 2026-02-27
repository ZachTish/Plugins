import { App, Modal, Setting, TFile, TextComponent, ButtonComponent } from "obsidian";

export class MultiFileSelectModal extends Modal {
    private onChoose: (files: TFile[]) => void;
    private selectedFiles: Set<TFile> = new Set();
    private allFiles: TFile[];
    private filteredFiles: TFile[];
    private searchInput: TextComponent | null = null;
    private listContainer: HTMLElement | null = null;

    constructor(app: App, onChoose: (files: TFile[]) => void) {
        super(app);
        this.onChoose = onChoose;
        this.allFiles = this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
        this.filteredFiles = [...this.allFiles];
    }

    onOpen() {
        this.modalEl.addClass('mod-tps-gcm');
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('tps-gcm-multi-select-modal');

        contentEl.createEl('h2', { text: 'Select Notes' });

        const searchContainer = contentEl.createDiv('tps-gcm-search-container');
        this.searchInput = new TextComponent(searchContainer)
            .setPlaceholder('Search notes...')
            .onChange((value) => {
                this.filterFiles(value);
            });
        this.searchInput.inputEl.style.width = '100%';
        this.searchInput.inputEl.focus();

        this.listContainer = contentEl.createDiv('tps-gcm-file-list');
        this.listContainer.style.maxHeight = '300px';
        this.listContainer.style.overflowY = 'auto';
        this.listContainer.style.marginTop = '10px';
        this.listContainer.style.marginBottom = '20px';
        this.listContainer.style.border = '1px solid var(--background-modifier-border)';
        this.listContainer.style.borderRadius = '4px';

        this.renderList();

        const buttonContainer = contentEl.createDiv('tps-gcm-modal-buttons');
        buttonContainer.style.display = 'flex';
        buttonContainer.style.justifyContent = 'flex-end';
        buttonContainer.style.gap = '10px';

        new ButtonComponent(buttonContainer)
            .setButtonText('Cancel')
            .onClick(() => {
                this.close();
            });

        new ButtonComponent(buttonContainer)
            .setButtonText('Link Selected')
            .setCta()
            .onClick(() => {
                this.onChoose(Array.from(this.selectedFiles));
                this.close();
            });
    }

    filterFiles(query: string) {
        if (!query) {
            this.filteredFiles = [...this.allFiles];
        } else {
            const lowerQuery = query.toLowerCase();
            this.filteredFiles = this.allFiles.filter(f => f.path.toLowerCase().includes(lowerQuery));
        }
        this.renderList();
    }

    renderList() {
        if (!this.listContainer) return;
        this.listContainer.empty();

        // Limit rendering for performance
        const displayFiles = this.filteredFiles.slice(0, 50);

        displayFiles.forEach(file => {
            const item = this.listContainer!.createDiv('tps-gcm-file-item');
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.padding = '5px 10px';
            item.style.cursor = 'pointer';
            item.style.borderBottom = '1px solid var(--background-modifier-border)';

            const checkbox = item.createEl('input', { type: 'checkbox' });
            checkbox.checked = this.selectedFiles.has(file);
            checkbox.style.marginRight = '10px';

            const label = item.createSpan();
            label.textContent = file.path;

            const toggle = () => {
                if (this.selectedFiles.has(file)) {
                    this.selectedFiles.delete(file);
                } else {
                    this.selectedFiles.add(file);
                }
                checkbox.checked = this.selectedFiles.has(file);
                this.updateButtonLabel();
            };

            item.addEventListener('click', (e) => {
                // Prevent double toggle if clicking checkbox directly
                if (e.target !== checkbox) {
                    toggle();
                }
            });

            checkbox.addEventListener('change', () => {
                // Logic is handled by click or we need to sync manually if we don't prevent prop
                // Actually the item click handles it, so we just stop prop on checkbox if strictly needed,
                // but simpler:
                if (this.selectedFiles.has(file) !== checkbox.checked) {
                    if (checkbox.checked) this.selectedFiles.add(file);
                    else this.selectedFiles.delete(file);
                    this.updateButtonLabel();
                }
            });

            this.listContainer!.appendChild(item);
        });

        if (this.filteredFiles.length === 0) {
            this.listContainer.createDiv({ text: 'No results found', cls: 'tps-gcm-no-results' });
        }
    }

    updateButtonLabel() {
        const btn = this.contentEl.querySelector('.mod-cta') as HTMLButtonElement;
        if (btn) {
            btn.textContent = `Link Selected (${this.selectedFiles.size})`;
        }
    }

    onClose() {
        this.contentEl.empty();
    }
}
