
import { BasesView, QueryController, Menu, BasesEntry, BasesEntryGroup, setIcon, TFile, debounce } from 'obsidian';

export const KANBAN_VIEW_TYPE = 'tps-kanban';

export class KanbanView extends BasesView {
  type = KANBAN_VIEW_TYPE;
  private plugin: any;
  private scrollEl: HTMLElement;
  private containerEl: HTMLElement;
  private refreshDebounced: () => void;
  private selectedPaths = new Set<string>();
  private selectionAnchorPath: string | null = null;
  private renderedFileOrder: string[] = [];

  constructor(controller: QueryController, scrollEl: HTMLElement, plugin: any) {
    super(controller);
    this.plugin = plugin;
    this.scrollEl = scrollEl;
    scrollEl.addClass('tps-kanban-scroll');
    this.containerEl = scrollEl.createDiv({ cls: 'tps-kanban-container' });
    this.refreshDebounced = debounce(() => this.render(), 120, false);
  }

  onload(): void {
    this.ensureContainer();

    // Keep card icon/color in sync when frontmatter changes but query results don't.
    // Do not gate by visible-path checks; those can be stale while Bases is mid-refresh.
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      if (!(file instanceof TFile)) return;
      this.refreshDebounced();
    }));

    // Companion updates can involve a regular file modify before/after metadata refresh.
    // Listen to vault modify as an additional signal so open-note edits reflect quickly.
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (!(file instanceof TFile)) return;
      this.refreshDebounced();
    }));

    // Keep board stable through file lifecycle changes while this view is open.
    this.registerEvent(this.app.vault.on('rename', () => this.refreshDebounced()));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (!(file instanceof TFile)) return;
      if (!this.isVisibleFile(file.path)) return;
      this.refreshDebounced();
    }));

    this.render();
  }
  onunload(): void {
    // Do not clear the root scroll element; Bases controls this container's lifecycle.
    // Clearing it here can leave the view blank when switching away and back.
    this.containerEl?.empty();
  }
  onResize(): void {}
  focus(): void { this.scrollEl.focus({ preventScroll: true }); }
  onDataUpdated(): void {
    this.ensureContainer();
    this.render();
  }

  private ensureContainer(): void {
    if (this.containerEl && this.containerEl.parentElement === this.scrollEl) return;
    this.containerEl = this.scrollEl.createDiv({ cls: 'tps-kanban-container' });
  }

  private isVisibleFile(path: string): boolean {
    const groups: BasesEntryGroup[] = this.data?.groupedData ?? [];
    for (const group of groups) {
      for (const entry of group.entries) {
        if (entry.file.path === path) return true;
      }
    }
    return false;
  }

  /**
   * Returns the raw frontmatter key name for the view's groupBy property.
   *
   * The .base file stores groupBy.property as either a plain name ("status")
   * or a BasesPropertyId ("note.status"). Only 'note' (user/frontmatter) props
   * support write-back; 'file' and 'formula' props are read-only.
   *
   * Falls back to scanning allProperties vs. entry values if config is opaque.
   */
  private getGroupByPropName(): string | null {
    // Primary: read from the internal config (works when Bases exposes groupBy)
    const raw = (this.config as any)?.groupBy?.property as string | undefined;
    if (raw) {
      const dot = raw.indexOf('.');
      if (dot === -1) return raw;                    // plain "status"
      const prefix = raw.slice(0, dot);
      if (prefix === 'note') return raw.slice(dot + 1); // "note.status" → "status"
      return null; // 'file.*' or 'formula.*' — not writable via frontmatter
    }

    // Fallback: find which allProperty's value matches .key for the first real group
    const groups = this.data?.groupedData ?? [];
    const allProps: string[] = Array.isArray((this as any).allProperties)
      ? (this as any).allProperties
      : [];
    for (const g of groups) {
      if (!g.hasKey() || g.key == null || g.entries.length === 0) continue;
      const keyStr = g.key.toString();
      const entry = g.entries[0];
      for (const propId of allProps) {
        const val = entry.getValue(propId as any);
        if (val != null && val.toString() === keyStr) {
          const dot = propId.indexOf('.');
          const prefix = dot !== -1 ? propId.slice(0, dot) : '';
          if (prefix === 'file' || prefix === 'formula') return null;
          return dot !== -1 ? propId.slice(dot + 1) : propId;
        }
      }
      break;
    }
    return null;
  }

  private keyLabel(group: BasesEntryGroup): string {
    if (!group.hasKey() || group.key == null) return 'No value';
    const s = group.key.toString();
    return s.length > 0 ? s : 'No value';
  }

  private getOrderedVisiblePaths(groups: BasesEntryGroup[]): string[] {
    const ordered: string[] = [];
    for (const group of groups) {
      for (const entry of group.entries) {
        ordered.push(entry.file.path);
      }
    }
    return ordered;
  }

  private getSelectedFiles(): TFile[] {
    const selected: TFile[] = [];
    for (const path of this.renderedFileOrder) {
      if (!this.selectedPaths.has(path)) continue;
      const af = this.app.vault.getAbstractFileByPath(path);
      if (af instanceof TFile) selected.push(af);
    }
    return selected;
  }

  private syncSelectionClasses(): void {
    const cards = this.containerEl.querySelectorAll<HTMLElement>('.tps-kanban-card[data-path]');
    cards.forEach((card) => {
      const path = card.dataset.path;
      card.classList.toggle('tps-kanban-card--selected', !!path && this.selectedPaths.has(path));
    });
  }

  private clearSelection(): void {
    if (this.selectedPaths.size === 0) return;
    this.selectedPaths.clear();
    this.selectionAnchorPath = null;
    this.syncSelectionClasses();
  }

  private selectOnly(path: string): void {
    this.selectedPaths.clear();
    this.selectedPaths.add(path);
    this.selectionAnchorPath = path;
    this.syncSelectionClasses();
  }

  private toggleSelect(path: string): void {
    if (this.selectedPaths.has(path)) {
      this.selectedPaths.delete(path);
    } else {
      this.selectedPaths.add(path);
    }
    this.selectionAnchorPath = path;
    this.syncSelectionClasses();
  }

  private selectRange(path: string): void {
    if (!this.selectionAnchorPath) {
      this.selectOnly(path);
      return;
    }
    const start = this.renderedFileOrder.indexOf(this.selectionAnchorPath);
    const end = this.renderedFileOrder.indexOf(path);
    if (start === -1 || end === -1) {
      this.selectOnly(path);
      return;
    }
    const [lo, hi] = start < end ? [start, end] : [end, start];
    this.selectedPaths.clear();
    for (let i = lo; i <= hi; i++) this.selectedPaths.add(this.renderedFileOrder[i]);
    this.syncSelectionClasses();
  }

  private createEntryCard(entry: BasesEntry, groups: BasesEntryGroup[], propName: string | null): HTMLElement {
    const cardEl = document.createElement('div');
    cardEl.className = 'tps-kanban-card';
    cardEl.title = entry.file.path;
    cardEl.draggable = true;
    cardEl.dataset.path = entry.file.path;
    if (this.selectedPaths.has(entry.file.path)) cardEl.classList.add('tps-kanban-card--selected');

    // Read icon and color from the note's frontmatter using configured keys
    const settings = this.plugin.settings;
    const fm = this.app.metadataCache.getFileCache(entry.file)?.frontmatter;
    const iconName = fm && settings.iconKey ? String(fm[settings.iconKey] ?? '').trim() : '';
    const colorValue = fm && settings.colorKey ? String(fm[settings.colorKey] ?? '').trim() : '';

    if (colorValue) {
      cardEl.style.setProperty('--tps-card-color', colorValue);
      cardEl.classList.add('tps-kanban-card--colored');
    }

    // Card inner: optional icon + title text
    const inner = cardEl.createDiv({ cls: 'tps-kanban-card-inner' });
    if (iconName) {
      const iconEl = inner.createDiv({ cls: 'tps-kanban-card-icon' });
      // Icon values may use a "provider:icon-name" format (e.g. "lucide:file-text").
      // Obsidian's setIcon expects only the bare Lucide name, so strip any prefix.
      const colonIdx = iconName.indexOf(':');
      const bareIcon = colonIdx !== -1 ? iconName.slice(colonIdx + 1) : iconName;
      setIcon(iconEl, bareIcon);
      // If setIcon couldn't find the icon it renders nothing — remove the empty div
      // so it doesn't add unwanted spacing.
      if (!iconEl.querySelector('svg')) iconEl.remove();
    }
    inner.createSpan({ text: entry.file.basename, cls: 'tps-kanban-card-title' });

    cardEl.addEventListener('dragstart', (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-kanban-entry', entry.file.path);
      e.dataTransfer.setData('obsidian/file', entry.file.path);
      cardEl.style.opacity = '0.5';
    });
    cardEl.addEventListener('dragend', () => { cardEl.style.opacity = '1'; });

    // single click — open the file
    cardEl.addEventListener('click', (e: MouseEvent) => {
      if (e.shiftKey) {
        this.selectRange(entry.file.path);
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        this.toggleSelect(entry.file.path);
        return;
      }
      this.selectOnly(entry.file.path);
      this.app.workspace.getLeaf(false).openFile(entry.file);
    });

    // right-click — trigger native file/files menu so GCM augments this view too.
    cardEl.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Right-click without modifiers should target this card (standard file list behavior).
      if (!this.selectedPaths.has(entry.file.path) && !e.shiftKey && !(e.metaKey || e.ctrlKey)) {
        this.selectOnly(entry.file.path);
      } else if (e.shiftKey) {
        this.selectRange(entry.file.path);
      } else if (e.metaKey || e.ctrlKey) {
        this.toggleSelect(entry.file.path);
      }

      const selectedFiles = this.getSelectedFiles();
      const menu = new Menu();

      if (selectedFiles.length > 1) {
        this.app.workspace.trigger('files-menu', menu as any, selectedFiles as any);
      } else {
        const target = selectedFiles[0] ?? entry.file;
        this.app.workspace.trigger('file-menu', menu as any, target as any);
      }

      // Keep Kanban-specific move actions in this menu.
      if (propName) {
        menu.addSeparator();
        for (const g of groups) {
          if (!g.hasKey() || g.key == null) continue;
          const val = g.key.toString();
          if (!val) continue;
          const label = this.keyLabel(g);
          if (selectedFiles.length > 1) {
            menu.addItem(it => it.setTitle(`Move ${selectedFiles.length} cards → ${label}`).onClick(async () => {
              for (const file of selectedFiles) {
                await this.app.fileManager.processFrontMatter(file, fm => { fm[propName] = val; });
              }
            }));
          } else {
            const target = selectedFiles[0] ?? entry.file;
            menu.addItem(it => it.setTitle(`Move → ${label}`).onClick(async () => {
              await this.app.fileManager.processFrontMatter(target, fm => { fm[propName] = val; });
            }));
          }
        }
      }
      menu.showAtPosition({ x: e.clientX, y: e.clientY });
    });

    return cardEl;
  }

  private render(): void {
    this.ensureContainer();
    this.containerEl.empty();

    const allGroups: BasesEntryGroup[] = this.data?.groupedData ?? [];
    const propName = this.getGroupByPropName();

    if (allGroups.length === 0) {
      this.containerEl.createEl('p', {
        text: 'No results. Set up a Group By in the base settings to define lanes.',
        cls: 'tps-kanban-empty',
      });
      return;
    }

    // Separate keyed groups from the ungrouped lane, then reorder per settings
    const keyed = allGroups.filter(g => g.hasKey() && g.key != null);
    const ungrouped = allGroups.filter(g => !g.hasKey() || g.key == null);
    const ungroupedPos = this.plugin.settings.ungroupedPosition;
    const groups = ungroupedPos === 'first'
      ? [...ungrouped, ...keyed]
      : [...keyed, ...ungrouped];

    this.renderedFileOrder = this.getOrderedVisiblePaths(groups);
    const visible = new Set(this.renderedFileOrder);
    this.selectedPaths = new Set(Array.from(this.selectedPaths).filter((p) => visible.has(p)));
    if (this.selectionAnchorPath && !visible.has(this.selectionAnchorPath)) this.selectionAnchorPath = null;

    const board = this.containerEl.createEl('div', { cls: 'tps-kanban-board' });
    board.addEventListener('click', (e: MouseEvent) => {
      if (e.target === board || e.target === this.containerEl) this.clearSelection();
    });

    for (const group of groups) {
      const laneEl = board.createEl('div', { cls: 'tps-kanban-lane' });

      // lane header: title + entry count badge
      const header = laneEl.createEl('div', { cls: 'tps-kanban-lane-header' });
      header.createEl('span', { text: this.keyLabel(group), cls: 'tps-kanban-lane-title' });
      header.createEl('span', { text: String(group.entries.length), cls: 'tps-kanban-lane-count' });

      const cardsWrap = laneEl.createEl('div', { cls: 'tps-kanban-cards' });

      // drop zone — dragging a card here updates its groupBy property in frontmatter
      if (propName) {
        cardsWrap.addEventListener('dragover', (e: DragEvent) => {
          if (!e.dataTransfer) return;
          if (Array.from(e.dataTransfer.types).includes('application/x-kanban-entry')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            cardsWrap.addClass('tps-kanban-drop-target');
          }
        });
        cardsWrap.addEventListener('dragleave', () => cardsWrap.removeClass('tps-kanban-drop-target'));
        cardsWrap.addEventListener('drop', async (e: DragEvent) => {
          e.preventDefault();
          cardsWrap.removeClass('tps-kanban-drop-target');
          if (!e.dataTransfer || !group.hasKey() || group.key == null) return;
          const filePath = e.dataTransfer.getData('application/x-kanban-entry');
          if (!filePath) return;
          const newValue = group.key.toString();
          if (!newValue) return;
          const file = this.app.vault.getFileByPath(filePath);
          if (!file) return;
          await this.app.fileManager.processFrontMatter(file, fm => { fm[propName] = newValue; });
        });
      }

      for (const entry of group.entries) {
        cardsWrap.appendChild(this.createEntryCard(entry, groups, propName));
      }

      // "Add card" creates a new note pre-populated with this lane's groupBy value
      laneEl.createEl('button', { text: '+ Add card', cls: 'tps-kanban-add-card' })
        .addEventListener('click', async () => {
          const proc = (propName && group.hasKey() && group.key != null)
            ? (fm: Record<string, unknown>) => { fm[propName] = group.key!.toString(); }
            : undefined;
          await this.createFileForView(undefined, proc);
        });
    }
  }
}
