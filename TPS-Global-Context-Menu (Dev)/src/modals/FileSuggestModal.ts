import { App, FuzzySuggestModal, TFile } from "obsidian";

export class FileSuggestModal extends FuzzySuggestModal<TFile> {
    private onChoose: (file: TFile) => void;
    private readonly allowedExtensions: Set<string> | null;

    constructor(app: App, onChoose: (file: TFile) => void, options?: { extensions?: string[] }) {
        super(app);
        this.onChoose = onChoose;
        this.allowedExtensions = Array.isArray(options?.extensions) && options.extensions.length > 0
            ? new Set(options.extensions.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))
            : null;
    }

    getItems(): TFile[] {
        const files = this.app.vault.getAllLoadedFiles().filter((file): file is TFile => file instanceof TFile);
        if (!this.allowedExtensions) {
            return files.filter((file) => file.extension?.toLowerCase() === 'md');
        }
        return files.filter((file) => this.allowedExtensions!.has(String(file.extension || '').trim().toLowerCase()));
    }

    getItemText(item: TFile): string {
        return item.path;
    }

    onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent): void {
        this.onChoose(item);
    }
}
