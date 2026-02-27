import { App, Modal, Setting, TFolder } from 'obsidian';

export class FolderSelectionModal extends Modal {
    allFolders: TFolder[];
    onSubmit: (folder: TFolder) => void;
    selectedFolder: TFolder | null = null;

    constructor(app: App, onSubmit: (folder: TFolder) => void) {
        super(app);
        this.onSubmit = onSubmit;
        this.allFolders = this.getAllFolders();
    }

    getAllFolders(): TFolder[] {
        const folders: TFolder[] = [];
        // @ts-ignore
        const root = this.app.vault.getRoot();

        const recurse = (folder: TFolder) => {
            folders.push(folder);
            folder.children.forEach(child => {
                if (child instanceof TFolder) {
                    recurse(child);
                }
            });
        };
        recurse(root);

        // Sort by path
        return folders.sort((a, b) => a.path.localeCompare(b.path));
    }

    onOpen() {
        this.modalEl.addClass('mod-tps-gcm');
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h2', { text: 'Select Folder' });

        new Setting(contentEl).setName('Folder').addDropdown((dropdown) => {
            this.allFolders.forEach((folder) => {
                dropdown.addOption(folder.path, folder.path || '/');
            });

            // Default to root or first
            if (this.allFolders.length > 0) {
                this.selectedFolder = this.allFolders[0];
                dropdown.setValue(this.allFolders[0].path);
            }

            dropdown.onChange((value) => {
                this.selectedFolder = this.allFolders.find(f => f.path === value) || null;
            });

            // Fix for dropdown interaction if needed
            dropdown.selectEl.addEventListener('click', e => e.stopPropagation());
            dropdown.selectEl.addEventListener('mousedown', e => e.stopPropagation());
        });

        new Setting(contentEl).addButton((btn) => {
            btn
                .setButtonText('Move')
                .setCta()
                .onClick(() => {
                    if (this.selectedFolder) {
                        this.close();
                        this.onSubmit(this.selectedFolder);
                    }
                });
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}
