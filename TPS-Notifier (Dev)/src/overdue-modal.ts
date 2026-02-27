import { Modal, App, TFile, debounce, setIcon, moment } from 'obsidian';
import TPSNotifier from './main';
import { OverdueItem } from './types';

export class OverdueItemsModal extends Modal {
    plugin: TPSNotifier;
    items: OverdueItem[] = [];
    container: HTMLDivElement;
    refreshDebounced: () => void;

    constructor(app: App, plugin: TPSNotifier) {
        super(app);
        this.plugin = plugin;
        this.refreshDebounced = debounce(this.refresh.bind(this), 300, true);
    }

    async onOpen() {
        const { contentEl, titleEl } = this;
        titleEl.setText('Overdue Items');

        this.container = contentEl.createDiv();
        this.container.style.maxHeight = '400px';
        this.container.style.overflowY = 'auto';

        // Initial load
        await this.refresh();

        // Register event listener
        this.plugin.registerEvent(
            this.app.metadataCache.on('changed', (file: TFile) => {
                // Only refresh if the changed file is relevant? 
                // Hard to know without checking all rules, so just refresh.
                // Or maybe check if file is in current list OR might be in list?
                // Safest to just refresh.
                this.refreshDebounced();
            })
        );

        // Also listen for detailed modify if metadataCache isn't enough (usually it is for frontmatter)
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }

    async refresh() {
        this.items = await this.plugin.getOverdueItems();
        this.render();
    }

    render() {
        this.container.empty();
        this.titleEl.setText(`Overdue Items (${this.items.length})`);

        if (this.items.length === 0) {
            this.container.createEl('div', { text: 'No overdue items.', cls: 'tps-overdue-empty' });
            return;
        }

        for (const item of this.items) {
            const row = this.container.createDiv({ cls: 'tps-overdue-item' });
            row.style.padding = '8px';
            row.style.borderBottom = '1px solid var(--background-modifier-border)';
            row.style.cursor = 'pointer';

            if (item.snoozedUntil) {
                row.style.opacity = '0.5';
            }

            const title = row.createEl('div', { text: item.file.basename });
            title.style.fontWeight = '600';

            const detailsText = item.snoozedUntil
                ? `Snoozed until ${moment(item.snoozedUntil).format('HH:mm')}`
                : `${item.reminder.property}: ${item.diff}`;

            const details = row.createEl('div', {
                text: detailsText
            });
            details.style.fontSize = '0.85em';
            details.style.color = item.snoozedUntil ? 'var(--text-accent)' : 'var(--text-muted)';

            const actions = row.createDiv({ cls: 'tps-overdue-actions' });
            actions.style.display = 'flex';
            actions.style.gap = '8px';
            actions.style.marginTop = '4px';
            actions.style.alignItems = 'center';

            // Helper to create icon buttons
            const createIconBtn = (icon: string, label: string, onClick: (e: MouseEvent) => void) => {
                const btn = actions.createDiv({ cls: 'tps-icon-btn' });
                setIcon(btn, icon);
                btn.setAttribute('aria-label', label);
                btn.style.padding = '4px';
                btn.style.borderRadius = '4px';
                btn.style.color = 'var(--text-muted)';
                btn.style.display = 'flex';
                btn.style.alignItems = 'center';
                btn.style.cursor = 'pointer';

                btn.addEventListener('mouseenter', () => {
                    btn.style.backgroundColor = 'var(--background-modifier-hover)';
                    btn.style.color = 'var(--text-normal)';
                });
                btn.addEventListener('mouseleave', () => {
                    btn.style.backgroundColor = 'transparent';
                    btn.style.color = 'var(--text-muted)';
                });

                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onClick(e);
                });
                return btn;
            };

            // Check button - mark as complete
            createIconBtn('check', 'Mark Complete', async (e) => {
                await this.plugin.markFileComplete(item.file);
                await this.refresh();
            });

            // X button - mark as won't do
            createIconBtn('x', 'Mark Won\'t Do', async (e) => {
                await this.plugin.markFileWontDo(item.file);
                await this.refresh();
            });

            const openBtn = actions.createEl('button', { text: 'Open Note' });
            openBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Don't close modal, just open file in background?
                // User asked for "responsive", keeping it open allows them to edit and see it vanish.
                // But usually open note means "I want to deal with this". 
                // Let's keep it open but activate the leaf.
                this.app.workspace.openLinkText(item.file.path, '', false);
            });

        }
    }
}
