import { ItemView, WorkspaceLeaf, TFile, IconName, Menu, setIcon, debounce, moment, Plugin } from 'obsidian';
import type { OverdueItem } from '../types';
import { SnoozeModal } from '../modals/snooze-modal';
import { getPluginById } from '../core';

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

interface GcmPluginSettings {
    properties?: Array<{ key?: string; options?: string[] }>;
    recurrenceCompletionStatuses?: string[];
}

interface GcmPluginAPI {
    settings?: GcmPluginSettings;
    applyCalendarFrontmatterMutation?: (input: {
        file: TFile;
        updates?: Record<string, unknown>;
        deletes?: string[];
        folderPath?: string | null;
        userInitiated?: boolean;
    }) => Promise<boolean>;
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

            // Note icon (left of content)
            const noteIconEl = row.createDiv({ cls: 'tps-notification-icon' });
            noteIconEl.style.display = 'flex';
            noteIconEl.style.alignItems = 'center';
            noteIconEl.style.flexShrink = '0';
            noteIconEl.style.fontSize = '16px';
            noteIconEl.style.lineHeight = '1';

            let iconName: string;
            let iconColor: string;
            const checkboxState = item.checkboxState ?? '';
            const checkboxIconMap: Record<string, [string, string]> = {
                '':   ['square', 'var(--text-muted)'],
                'x':  ['check-square', 'var(--text-success)'],
                '/':  ['play', 'var(--text-accent)'],
                '?':  ['help-circle', 'var(--text-warning)'],
                '-':  ['x-circle', 'var(--text-error)'],
            };
            if ((item.sourceType === 'task-item' || item.sourceType === 'kanban-task') && checkboxIconMap[checkboxState] !== undefined) {
                [iconName, iconColor] = checkboxIconMap[checkboxState];
            } else {
                const rawIcon = (item.icon && item.icon.trim()) ? item.icon.trim() : '';
                iconName = rawIcon.includes(':') ? rawIcon.split(':').pop()! : (rawIcon || 'file-text');
                iconColor = (item.color && item.color.trim() && item.color.trim() !== 'undefined')
                    ? item.color.trim()
                    : 'var(--text-muted)';
            }
            noteIconEl.setAttribute('title', iconName);
            noteIconEl.style.color = iconColor;
            setIcon(noteIconEl, iconName);

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
            if ((item.sourceType === 'task-item' || item.sourceType === 'kanban-task') && item.taskText) {
                displayName = item.taskText;
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
                : (item.isAllDay ? 'All day' : item.diff);
            const time = topRow.createEl('span', { text: timeText });
            time.style.fontSize = '0.75em';
            time.style.color = item.snoozedUntil ? 'var(--text-accent)' : 'var(--text-muted)';
            time.style.flexShrink = '0';

            // Next-reminder subtitle
            if (item.nextTriggerTime !== undefined && item.nextRuleLabel) {
                const now2 = Date.now();
                let nextStr: string;
                if (item.isRepeating) {
                    const intervalMins = item.nextReminderIntervalMinutes ?? item.reminder.repeatIntervalMinutes ?? 1;
                    // Prefer showing the concrete next trigger time when available,
                    // falling back to the generic "every X min" wording.
                    if (item.nextTriggerTime !== undefined) {
                        const msUntil = item.nextTriggerTime - now2;
                        const minsUntil = Math.round(msUntil / 60000);
                        if (minsUntil <= 60) {
                            nextStr = `in ${minsUntil} min — repeats every ${intervalMins} min — ${item.nextRuleLabel}`;
                        } else {
                            nextStr = `${moment(item.nextTriggerTime).format('h:mm A')} — repeats every ${intervalMins} min — ${item.nextRuleLabel}`;
                        }
                    } else {
                        nextStr = `every ${intervalMins} min — ${item.nextRuleLabel}`;
                    }
                } else {
                    const msUntil = item.nextTriggerTime - now2;
                    const minsUntil = Math.round(msUntil / 60000);
                    if (minsUntil <= 60) {
                        nextStr = `in ${minsUntil} min — ${item.nextRuleLabel}`;
                    } else {
                        nextStr = `${moment(item.nextTriggerTime).format('h:mm A')} — ${item.nextRuleLabel}`;
                    }
                }
                const subtitle = content.createDiv({ cls: 'tps-notification-subtitle', text: nextStr });
                subtitle.style.fontSize = '0.75em';
                subtitle.style.color = 'var(--text-faint)';
                subtitle.style.whiteSpace = 'nowrap';
                subtitle.style.overflow = 'hidden';
                subtitle.style.textOverflow = 'ellipsis';
                subtitle.style.marginTop = '1px';
            }

            if (item.snoozedUntil) {
                row.style.opacity = '0.5';
            }

            // Right Actions
            const actions = row.createDiv({ cls: 'tps-notification-actions' });
            actions.style.display = 'flex';
            actions.style.alignItems = 'center';
            actions.style.gap = '4px';

            // Clickable status pill — always visible even when empty
            const gcmPlugin = getPluginById(this.app, 'tps-global-context-menu') as (Plugin & GcmPluginAPI) | null;
            const statusOptions: string[] = gcmPlugin?.settings?.properties
                ?.find((p: any) => p.key === 'status')?.options
                ?? ['open', 'working', 'blocked', 'wont-do', 'complete'];

            const currentStatus = item.status || '';
            const isTaskItem = item.sourceType === 'task-item' || item.sourceType === 'kanban-task';
            const statusPill = actions.createDiv({ cls: 'tps-status-pill', text: currentStatus || '—' });
            statusPill.style.cursor = 'pointer';
            statusPill.style.padding = '2px 8px';
            statusPill.style.borderRadius = '10px';
            statusPill.style.fontSize = '0.72em';
            statusPill.style.background = 'var(--background-secondary)';
            statusPill.style.color = currentStatus ? 'var(--text-normal)' : 'var(--text-faint)';
            statusPill.style.border = '1px solid var(--background-modifier-border)';
            statusPill.style.whiteSpace = 'nowrap';
            statusPill.addEventListener('mouseenter', () => {
                statusPill.style.background = 'var(--background-modifier-hover)';
            });
            statusPill.addEventListener('mouseleave', () => {
                statusPill.style.background = 'var(--background-secondary)';
            });
            statusPill.addEventListener('click', async (e) => {
                e.stopPropagation();
                const menu = new Menu();
                const doneStatuses = new Set<string>([
                    ...(gcmPlugin?.settings?.recurrenceCompletionStatuses ?? ['complete', 'wont-do'])
                        .map((s: string) => String(s || '').trim().toLowerCase()),
                ]);
                const nowStamp = () => moment().format('YYYY-MM-DD HH:mm:ss');

                const writeCheckboxState = async (newCheckboxState: string) => {
                    if (item.taskLineNumber == null) return;
                    const editor = this.getEditorForFile(item.file);
                    if (editor) {
                        const line = editor.getLine(item.taskLineNumber);
                        editor.setLine(item.taskLineNumber, line.replace(/\[([^\]]*)\]/, `[${newCheckboxState}]`));
                    } else {
                        const content = await this.app.vault.read(item.file);
                        const lines = content.split('\n');
                        if (item.taskLineNumber < lines.length) {
                            lines[item.taskLineNumber] = lines[item.taskLineNumber].replace(/\[([^\]]*)\]/, `[${newCheckboxState}]`);
                            await this.app.vault.modify(item.file, lines.join('\n'));
                        }
                    }
                };

                const writeFileStatus = async (newStatus: string | null) => {
                    if (!gcmPlugin?.applyCalendarFrontmatterMutation) {
                        throw new Error('TPS Global Context Menu API unavailable for notification status mutation');
                    }
                    await gcmPlugin.applyCalendarFrontmatterMutation({
                        file: item.file,
                        updates: newStatus == null
                            ? {}
                            : {
                                status: newStatus,
                                ...(doneStatuses.has(newStatus.trim().toLowerCase()) ? { completedDate: nowStamp() } : {}),
                            },
                        deletes: newStatus == null || !doneStatuses.has((newStatus || '').trim().toLowerCase())
                            ? ['completedDate', ...(newStatus == null ? ['status'] : [])]
                            : [],
                        folderPath: item.file.parent?.path || '/',
                        userInitiated: true,
                    });
                };

                const statusToCheckbox: Record<string, string> = {
                    'complete': 'x',
                    'wont-do': '-',
                    'working': '/',
                    'holding': '?',
                    'todo': ' ',
                    'open': ' ',
                };

                const handleStatusChange = async (newStatus: string | null) => {
                    if (isTaskItem && newStatus && statusToCheckbox[newStatus.trim().toLowerCase()]) {
                        await writeCheckboxState(statusToCheckbox[newStatus.trim().toLowerCase()]);
                    } else {
                        await writeFileStatus(newStatus);
                    }
                    await this.refresh();
                };

                menu.addItem((i) => i.setTitle('(none)').setChecked(!currentStatus).onClick(() => handleStatusChange(null)));
                menu.addItem((i) => i.setTitle('(empty)').setChecked(currentStatus === '').onClick(() => handleStatusChange('')));
                statusOptions.forEach((opt) => {
                    menu.addItem((i) => i.setTitle(opt).setChecked(currentStatus === opt).onClick(() => handleStatusChange(opt)));
                });
                menu.showAtMouseEvent(e);
            });

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
        }
    }

    private showContextMenu(e: MouseEvent, item: OverdueItem) {
        const isTaskItem = item.sourceType === 'task-item' || item.sourceType === 'kanban-task';

        if (isTaskItem && item.taskLineNumber != null) {
            const menu = new Menu();

            const states: Array<{ char: string; label: string }> = [
                { char: " ", label: "Todo [ ]" },
                { char: "/", label: "Working [/]" },
                { char: "x", label: "Complete [x]" },
                { char: "?", label: "Holding [?]" },
                { char: "-", label: "Won't Do [-]" },
            ];
            const currentState = item.checkboxState ?? "";
            for (const s of states) {
                const isActive = currentState === s.char;
                menu.addItem((i) => i.setTitle(s.label).setChecked(isActive).onClick(async () => {
                    const editor = this.getEditorForFile(item.file);
                    if (editor) {
                        const line = editor.getLine(item.taskLineNumber!);
                        editor.setLine(item.taskLineNumber!, line.replace(/\[([^\]]*)\]/, `[${s.char}]`));
                    } else {
                        const content = await this.app.vault.read(item.file);
                        const lines = content.split('\n');
                        if (item.taskLineNumber! < lines.length) {
                            lines[item.taskLineNumber!] = lines[item.taskLineNumber!].replace(/\[([^\]]*)\]/, `[${s.char}]`);
                            await this.app.vault.modify(item.file, lines.join('\n'));
                        }
                    }
                    await this.refresh();
                }));
            }

            menu.addSeparator();
            menu.addItem((i) => i.setTitle("Go to task line").setIcon("list").onClick(async () => {
                const leaf = this.app.workspace.getLeaf(false);
                await leaf.openFile(item.file);
                const view = leaf.view as any;
                if (view?.editor) {
                    const line = item.taskLineNumber!;
                    view.editor.setCursor({ line, ch: 0 });
                    view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line: line + 1, ch: 0 } }, true);
                }
            }));

            menu.showAtMouseEvent(e);
        } else {
            const menu = new Menu();
            this.app.workspace.trigger('file-menu', menu, item.file, 'tps-notification-view', this.leaf);
            menu.showAtMouseEvent(e);
        }
    }

    private getEditorForFile(file: TFile): any | null {
        const leaves = this.app.workspace.getLeavesOfType('markdown');
        for (const leaf of leaves) {
            const view = leaf.view as any;
            if (view?.file?.path === file.path && view?.editor) {
                return view.editor;
            }
        }
        return null;
    }
}
