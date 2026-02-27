import { ItemView, WorkspaceLeaf, TFile, IconName, Menu, setIcon, debounce, moment } from 'obsidian';
import { OverdueItem, TPSNotifierSettings } from './types';
import { SnoozeModal } from './snooze-modal';

export const NOTIFICATION_VIEW_TYPE = 'tps-notification-view';

// Minimal interface to decouple from main plugin class
export interface TPSNotifierInterface {
    settings: TPSNotifierSettings;
    getOverdueItems(): Promise<OverdueItem[]>;
    snoozeFile(file: TFile, minutes: number): Promise<void>;
    openFile(file: TFile): void;
    markFileComplete(file: TFile): Promise<void>;
    markFileWontDo(file: TFile): Promise<void>;
}

export class NotificationView extends ItemView {
    plugin: TPSNotifierInterface;
    items: OverdueItem[] = [];
    private refreshDebounced: () => void;

    constructor(leaf: WorkspaceLeaf, plugin: TPSNotifierInterface) {
        super(leaf);
        this.plugin = plugin;
        this.refreshDebounced = debounce(() => {
            void this.refresh();
        }, 120, false);
    }

    getViewType() {
        return NOTIFICATION_VIEW_TYPE;
    }

    getDisplayText() {
        return "Notifications";
    }

    getIcon(): IconName {
        return "bell"; // or 'alarm-clock'
    }

    async onOpen() {
        // Add standard refresh action to the view header toolbar
        this.addAction('refresh-cw', 'Refresh Notifications', async () => {
            await this.refresh();
        });

        // Keep view responsive after status/frontmatter updates from context menus/modals.
        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                if (!(file instanceof TFile)) return;
                if (this.items.some((item) => item.file.path === file.path)) {
                    this.refreshDebounced();
                }
            })
        );

        // File-level operations (rename/delete) should also update immediately.
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (!(file instanceof TFile)) return;
                if (this.items.some((item) => item.file.path === file.path)) {
                    this.refreshDebounced();
                }
            })
        );
        this.registerEvent(
            this.app.vault.on('rename', (file) => {
                if (!(file instanceof TFile)) return;
                this.refreshDebounced();
            })
        );

        // Immediate refresh path for explicit TPS GCM updates.
        this.registerEvent(
            (this.app.workspace as any).on('tps-gcm-files-updated', (paths: string[] | undefined) => {
                if (!Array.isArray(paths) || paths.length === 0) return;
                const pathSet = new Set(paths);
                if (this.items.some((item) => pathSet.has(item.file.path))) {
                    void this.refresh();
                }
            })
        );

        await this.refresh();
        // Keep a periodic safety refresh as backup.
        this.registerInterval(window.setInterval(() => this.refreshDebounced(), 15000));
    }

    async refresh() {
        this.items = await this.plugin.getOverdueItems();
        this.draw();
    }

    draw() {
        // console.log('[TPS Notifier Debug] View draw() started');
        const container = this.contentEl;
        container.empty();
        container.addClass('tps-notification-view');

        const list = container.createDiv({ cls: 'tps-notification-list' });
        list.style.display = 'flex';
        list.style.flexDirection = 'column';
        list.style.height = '100%';
        list.style.overflowY = 'auto';

        if (this.items.length === 0) {
            const emptyState = list.createDiv({ cls: 'tps-empty-state' });
            emptyState.style.display = 'flex';
            emptyState.style.flexDirection = 'column';
            emptyState.style.alignItems = 'center';
            emptyState.style.justifyContent = 'center';
            emptyState.style.height = '100%';
            emptyState.style.color = 'var(--text-muted)';
            emptyState.style.padding = '20px';

            const icon = emptyState.createDiv();
            setIcon(icon, 'check-circle');
            icon.style.marginBottom = '8px';
            icon.style.opacity = '0.5';

            emptyState.createDiv({ text: 'All caught up!' });
            return;
        }

        for (const item of this.items) {
            const row = list.createDiv({ cls: 'tps-notification-item' });
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.padding = '8px 12px';
            row.style.borderBottom = '1px solid var(--background-modifier-border)';
            row.style.cursor = 'pointer';
            row.style.gap = '12px';
            row.style.transition = 'background-color 0.1s ease';

            // Hover effect
            row.addEventListener('mouseenter', () => {
                row.style.backgroundColor = 'var(--background-modifier-hover)';
            });
            row.addEventListener('mouseleave', () => {
                row.style.backgroundColor = 'transparent';
            });

            // Click to open file
            row.addEventListener('click', (e) => {
                // Ignore if clicked on action buttons
                if ((e.target as HTMLElement).closest('.tps-notification-actions')) return;
                this.plugin.openFile(item.file);
            });

            // Context Menu
            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.showContextMenu(e, item);
            });

            // Left Content: Title + Preview
            const content = row.createDiv({ cls: 'tps-notification-content' });
            content.style.display = 'flex';
            content.style.flexDirection = 'column';
            content.style.flex = '1';
            content.style.overflow = 'hidden';

            const topRow = content.createDiv({ cls: 'tps-notification-top' });
            topRow.style.display = 'flex';
            topRow.style.alignItems = 'baseline';
            topRow.style.gap = '8px';
            topRow.style.marginBottom = '2px';

            const titleText = item.title || item.file.basename;
            const title = topRow.createEl('span', { text: titleText });
            title.style.fontWeight = '600';
            title.style.color = 'var(--text-normal)';
            title.style.fontSize = '0.9em';
            title.style.whiteSpace = 'nowrap';
            title.style.overflow = 'hidden';
            title.style.textOverflow = 'ellipsis';

            const timeText = item.snoozedUntil
                ? `Snoozed until ${moment(item.snoozedUntil).format('HH:mm')}`
                : item.diff;
            const time = topRow.createEl('span', { text: timeText });
            time.style.fontSize = '0.75em';
            time.style.color = item.snoozedUntil ? 'var(--text-accent)' : 'var(--text-muted)';
            time.style.flexShrink = '0';

            const body = content.createDiv({ cls: 'tps-notification-body' });
            body.setText(item.body || item.reminder.property);
            body.style.fontSize = '0.8em';
            body.style.color = 'var(--text-muted)';
            body.style.whiteSpace = 'nowrap';
            body.style.overflow = 'hidden';
            body.style.textOverflow = 'ellipsis';

            if (item.snoozedUntil) {
                row.style.opacity = '0.5';
            }

            // Right Actions: Snooze
            const actions = row.createDiv({ cls: 'tps-notification-actions' });
            actions.style.display = 'flex';
            actions.style.alignItems = 'center';
            actions.style.gap = '4px'; // Minimal gap

            const createIconBtn = (icon: string, label: string, onClick: (e: MouseEvent) => void) => {
                const btn = actions.createDiv({ cls: 'tps-icon-btn' });
                setIcon(btn, icon);
                btn.setAttribute('aria-label', label);
                btn.style.padding = '6px';
                btn.style.borderRadius = '4px';
                btn.style.color = 'var(--text-muted)';
                btn.style.display = 'flex';
                btn.style.alignItems = 'center';

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

            createIconBtn('clock', 'Snooze', (e) => {
                new SnoozeModal(this.app, async (minutes) => {
                    await this.plugin.snoozeFile(item.file, minutes);
                    await this.refresh();
                }, this.plugin.settings.snoozeOptions || []).open();
            });

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

        }
    }

    /**
     * Shows the context menu for a notification item
     */
    private showContextMenu(e: MouseEvent, item: OverdueItem) {
        const menu = new Menu();

        // Trigger the native file-menu event so all plugins (including TPS Global Context Menu)
        // can populate the menu with their standard actions.
        this.app.workspace.trigger('file-menu', menu, item.file, 'tps-notification-view', this.leaf);

        menu.showAtMouseEvent(e);
    }
}
