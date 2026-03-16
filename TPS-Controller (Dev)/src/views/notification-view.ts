import { ItemView, WorkspaceLeaf, TFile, IconName, Menu, setIcon, debounce, moment } from 'obsidian';
import type { OverdueItem } from '../types';
import { SnoozeModal } from '../modals/snooze-modal';

export const NOTIFICATION_VIEW_TYPE = 'tps-notification-view';

// Minimal interface so the view stays decoupled from the full plugin class.
export interface TPSControllerRemindersAPI {
    settings: { snoozeOptions?: { label: string; minutes: number }[] };
    getOverdueItems(): Promise<OverdueItem[]>;
    snoozeFile(file: TFile, minutes: number): Promise<void>;
    snoozeOverdueItem?(item: OverdueItem, minutes: number): Promise<void>;
    openFile(file: TFile): void;
    markFileComplete(file: TFile): Promise<void>;
    markFileWontDo(file: TFile): Promise<void>;
    markOverdueItemComplete?(item: OverdueItem): Promise<void>;
    markOverdueItemWontDo?(item: OverdueItem): Promise<void>;
}

export class NotificationView extends ItemView {
    plugin: TPSControllerRemindersAPI;
    items: OverdueItem[] = [];
    private refreshDebounced: () => void;

    constructor(leaf: WorkspaceLeaf, plugin: TPSControllerRemindersAPI) {
        super(leaf);
        this.plugin = plugin;
        this.refreshDebounced = debounce(() => {
            void this.refresh();
        }, 120, false);
    }

    getViewType() { return NOTIFICATION_VIEW_TYPE; }
    getDisplayText() { return "Notifications"; }
    getIcon(): IconName { return "bell"; }

    async onOpen() {
        this.addAction('refresh-cw', 'Refresh Notifications', async () => {
            await this.refresh();
        });

        this.registerEvent(
            this.app.metadataCache.on('changed', (file) => {
                if (!(file instanceof TFile)) return;
                if (this.items.some((item) => item.file.path === file.path)) {
                    this.refreshDebounced();
                }
            })
        );

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
        this.registerInterval(window.setInterval(() => this.refreshDebounced(), 15000));
    }

    async refresh() {
        this.items = await this.plugin.getOverdueItems();
        this.draw();
    }

    draw() {
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

            row.addEventListener('mouseenter', () => {
                row.style.backgroundColor = 'var(--background-modifier-hover)';
            });
            row.addEventListener('mouseleave', () => {
                row.style.backgroundColor = 'transparent';
            });

            row.addEventListener('click', (e) => {
                if ((e.target as HTMLElement).closest('.tps-notification-actions')) return;
                this.plugin.openFile(item.file);
            });

            row.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.showContextMenu(e, item);
            });

            // Left Content
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

            let displayName = item.file.basename;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(displayName)) {
                displayName = displayName.replace(/ \d{4}-\d{2}-\d{2}$/, '');
            }
            const title = topRow.createEl('span', { text: displayName });
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
            body.setText(item.taskText || item.reminder.label || item.reminder.property);
            body.style.fontSize = '0.8em';
            body.style.color = 'var(--text-muted)';
            body.style.whiteSpace = 'nowrap';
            body.style.overflow = 'hidden';
            body.style.textOverflow = 'ellipsis';

            if (item.snoozedUntil) {
                row.style.opacity = '0.5';
            }

            // Right Actions
            const actions = row.createDiv({ cls: 'tps-notification-actions' });
            actions.style.display = 'flex';
            actions.style.alignItems = 'center';
            actions.style.gap = '4px';

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

            createIconBtn('clock', 'Snooze', (_e) => {
                new SnoozeModal(this.app, async (minutes) => {
                    if (this.plugin.snoozeOverdueItem) await this.plugin.snoozeOverdueItem(item, minutes);
                    else await this.plugin.snoozeFile(item.file, minutes);
                    await this.refresh();
                }, this.plugin.settings.snoozeOptions || []).open();
            });

            createIconBtn('check', 'Mark Complete', async () => {
                if (this.plugin.markOverdueItemComplete) await this.plugin.markOverdueItemComplete(item);
                else await this.plugin.markFileComplete(item.file);
                await this.refresh();
            });

            createIconBtn('x', "Mark Won't Do", async () => {
                if (this.plugin.markOverdueItemWontDo) await this.plugin.markOverdueItemWontDo(item);
                else await this.plugin.markFileWontDo(item.file);
                await this.refresh();
            });
        }
    }

    private showContextMenu(e: MouseEvent, item: OverdueItem) {
        const menu = new Menu();
        this.app.workspace.trigger('file-menu', menu, item.file, 'tps-notification-view', this.leaf);
        menu.showAtMouseEvent(e);
    }
}
