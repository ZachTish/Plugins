
import { BasesView, QueryController, Menu, BasesEntry, BasesEntryGroup, setIcon, TFile, debounce, normalizePath, Modal, Setting, getAllTags, Notice, Platform } from 'obsidian';
import { FileSelectionModal } from '../../../TPS-Calendar-Base (Dev)/src/modals/file-selection-modal';
import { getDailyNoteResolver } from '../../../TPS-Controller (Dev)/src/utils/daily-note-resolver';
import { ensureDailyNoteFile } from '../../../TPS-Controller (Dev)/src/utils/daily-note-create';
import { RuleEvaluationContext } from '../../../TPS-Notebook-Navigator-Companion (Dev)/src/types';

export const KANBAN_VIEW_TYPE = 'tps-kanban';
const TASK_LINE_UPDATED_EVENT = 'tps-task-line-updated';
const TASK_LINKED_NOTE_PROPERTY = 'linkednote';
const TASK_LINKED_NOTE_PROPERTY_RE = /\[linkednote::\s*([^\]]+)\]/i;
const TASK_REFERENCE_DRAG_TYPE = 'application/x-tps-card-reference';

const buildTaskSourceWikilink = (rawPath: string, rawTitle: string): string => {
  const path = normalizePath(String(rawPath || '').trim()).replace(/\.md$/i, '');
  const title = String(rawTitle || '').replace(/\r?\n+/g, ' ').replace(/\|/g, ' ').replace(/\]\]/g, '').trim();
  if (!path || !title) return '';
  return `[[${path}|${title}]]`;
};

type LaneRenderItem = {
  entry: BasesEntry;
  depth: number;
  hasChildren: boolean;
  childCount: number;
};

type VirtualKanbanTaskMeta = {
  parentPath: string;
  lineNumber: number;
  text: string;
  tags: string[];
  inlineProperties: Record<string, string>;
  scheduled: string | null;
  rawScheduled: string | null;
  stateMarker: string;
};

type ParsedKanbanTask = {
  lineNumber: number;
  text: string;
  tags: string[];
  inlineProperties: Record<string, string>;
  scheduled: string | null;
  rawScheduled: string | null;
  stateMarker: string;
};

type TaskDateValue = {
  isEmpty: () => boolean;
  toString: () => string;
  valueOf: () => number;
  format: (pattern?: string) => string;
  toJSON: () => string;
  toDate: () => Date;
};

type DisplayLaneGroup = {
  id: string;
  label: string;
  groups: BasesEntryGroup[];
  laneIds: string[];
};

type EntryVisualStyle = {
  iconName: string | null;
  colorValue: string | null;
  iconColor: string | null;
};

type GcmTaskSemanticsApi = {
  parseTaskLine?: (line: string) => {
    body: string;
    text: string;
    inlineProperties: Record<string, string>;
    scheduledDateToken: string | null;
    scheduledTimeToken: string | null;
    checkboxState: string | null;
  } | null;
};

class LaneRenameModal extends Modal {
  private resolve: (value: string | null) => void;
  private submitted = false;
  private inputEl: HTMLInputElement | null = null;
  private readonly baseLabel: string;
  private readonly currentLabel: string;

  constructor(app: any, baseLabel: string, currentLabel: string, resolve: (value: string | null) => void) {
    super(app);
    this.baseLabel = baseLabel;
    this.currentLabel = currentLabel;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: `Rename lane: ${this.baseLabel}` });

    new Setting(contentEl)
      .setName('Display label')
      .setDesc('Leave empty to reset to the original lane value.')
      .addText((text) => {
        text.setValue(this.currentLabel || this.baseLabel);
        this.inputEl = text.inputEl;
        text.inputEl.addEventListener('keydown', (evt: KeyboardEvent) => {
          if (evt.key === 'Enter') {
            evt.preventDefault();
            this.submit();
          } else if (evt.key === 'Escape') {
            evt.preventDefault();
            this.cancel();
          }
        });
      });

    const actions = contentEl.createDiv({ cls: 'tps-kanban-lane-rename-actions' });
    const cancelBtn = actions.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.cancel());
    const saveBtn = actions.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => this.submit());

    window.setTimeout(() => {
      this.inputEl?.focus();
      this.inputEl?.select();
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) {
      this.resolve(null);
    }
  }

  private submit(): void {
    if (this.submitted) return;
    this.submitted = true;
    this.resolve(String(this.inputEl?.value ?? '').trim());
    this.close();
  }

  private cancel(): void {
    if (this.submitted) return;
    this.submitted = true;
    this.resolve(null);
    this.close();
  }
}

class LaneValueSelectModal extends Modal {
  private readonly titleText: string;
  private readonly options: Array<{ label: string; value: string | null }>;
  private readonly resolve: (value: string | null | undefined) => void;
  private submitted = false;

  constructor(
    app: any,
    titleText: string,
    options: Array<{ label: string; value: string | null }>,
    resolve: (value: string | null | undefined) => void,
  ) {
    super(app);
    this.titleText = titleText;
    this.options = options;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.titleText });
    contentEl.createEl('p', { text: 'Choose which underlying value to apply:' });

    const list = contentEl.createDiv({ cls: 'tps-kanban-lane-value-picker' });
    this.options.forEach((option) => {
      const button = list.createEl('button', {
        cls: 'mod-cta',
        text: option.label,
      });
      button.addEventListener('click', () => this.submit(option.value));
    });

    const cancel = contentEl.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.cancel());
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) this.resolve(undefined);
  }

  private submit(value: string | null): void {
    if (this.submitted) return;
    this.submitted = true;
    this.resolve(value);
    this.close();
  }

  private cancel(): void {
    if (this.submitted) return;
    this.submitted = true;
    this.resolve(undefined);
    this.close();
  }
}

class CardTitleModal extends Modal {
  private readonly titleText: string;
  private readonly initialTitle: string;
  private readonly resolve: (value: string | null) => void;
  private submitted = false;
  private inputEl: HTMLInputElement | null = null;

  constructor(app: any, titleText: string, initialTitle: string, resolve: (value: string | null) => void) {
    super(app);
    this.titleText = titleText;
    this.initialTitle = initialTitle;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.titleText });
    new Setting(contentEl)
      .setName('Title')
      .addText((text) => {
        text.setValue(this.initialTitle);
        this.inputEl = text.inputEl;
        text.inputEl.addEventListener('keydown', (evt: KeyboardEvent) => {
          if (evt.key === 'Enter') {
            evt.preventDefault();
            this.submit();
          } else if (evt.key === 'Escape') {
            evt.preventDefault();
            this.cancel();
          }
        });
      });

    const buttons = contentEl.createDiv({ cls: 'tps-kanban-lane-rename-actions' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.cancel());
    const saveBtn = buttons.createEl('button', { text: 'Save', cls: 'mod-cta' });
    saveBtn.addEventListener('click', () => this.submit());

    window.setTimeout(() => {
      this.inputEl?.focus();
      this.inputEl?.select();
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) {
      this.resolve(null);
    }
  }

  private submit(): void {
    if (this.submitted) return;
    this.submitted = true;
    const value = String(this.inputEl?.value ?? '').trim();
    this.resolve(value || null);
    this.close();
  }

  private cancel(): void {
    if (this.submitted) return;
    this.submitted = true;
    this.resolve(null);
    this.close();
  }
}

export class KanbanView extends BasesView {
  type = KANBAN_VIEW_TYPE;
  private plugin: any;
  private scrollEl: HTMLElement;
  private containerEl: HTMLElement;
  private refreshDebounced: () => void;
  private selectedPaths = new Set<string>();
  private activeNotePath: string | null = null;
  private selectionAnchorPath: string | null = null;
  private renderedFileOrder: string[] = [];
  private expandedSubtreePaths = new Set<string>();
  private virtualTaskMetaByPath = new Map<string, VirtualKanbanTaskMeta>();
  private wheelHandlerTarget: HTMLElement | null = null;
  private onWheelBound: ((event: WheelEvent) => void) | null = null;
  private renderVersion = 0;

  constructor(controller: QueryController, scrollEl: HTMLElement, plugin: any) {
    super(controller);
    this.plugin = plugin;
    this.scrollEl = scrollEl;
    scrollEl.addClass('tps-kanban-scroll');
    this.containerEl = scrollEl.createDiv({ cls: 'tps-kanban-container' });
    this.refreshDebounced = debounce(() => this.render(), 120, false);
    this.applyLayoutSettings();
  }

  onload(): void {
    this.ensureContainer();
    this.activeNotePath = this.getActiveMarkdownPath();

    // Keep card icon/color in sync when frontmatter changes but query results don't.
    // Do not gate by visible-path checks; those can be stale while Bases is mid-refresh.
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      if (!(file instanceof TFile)) return;
      if (!this.shouldProcessUpdates()) return;
      if (!this.isVisibleFile(file.path) && !this.hasRenderedVirtualTaskForFile(file.path)) return;
      this.refreshDebounced();
    }));

    // Companion updates can involve a regular file modify before/after metadata refresh.
    // Listen to vault modify as an additional signal so open-note edits reflect quickly.
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (!(file instanceof TFile)) return;
      if (!this.shouldProcessUpdates()) return;
      if (!this.isVisibleFile(file.path) && !this.hasRenderedVirtualTaskForFile(file.path)) return;
      this.refreshDebounced();
    }));

    // Keep board stable through file lifecycle changes while this view is open.
    this.registerEvent(this.app.vault.on('rename', (file) => {
      if (!this.shouldProcessUpdates()) return;
      if (file instanceof TFile && !this.isVisibleFile(file.path) && !this.hasRenderedVirtualTaskForFile(file.path)) return;
      this.refreshDebounced();
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (!(file instanceof TFile)) return;
      if (!this.shouldProcessUpdates()) return;
      if (!this.isVisibleFile(file.path) && !this.hasRenderedVirtualTaskForFile(file.path)) return;
      this.refreshDebounced();
    }));
    this.registerEvent((this.app.workspace as any).on(TASK_LINE_UPDATED_EVENT as any, (payload: { path?: string; lineNumber?: number | null } | null) => {
      if (!this.shouldProcessUpdates()) return;
      const path = String(payload?.path || '').trim();
      if (!path) return;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      if (!this.isVisibleVirtualTaskLine(file, payload?.lineNumber ?? null)) return;
      this.refreshDebounced();
    }));

    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      const nextPath = file instanceof TFile ? file.path : null;
      if (nextPath === this.activeNotePath) return;
      this.activeNotePath = nextPath;
      this.syncSelectionClasses();
    }));

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      const nextPath = this.getActiveMarkdownPath();
      if (nextPath === this.activeNotePath) return;
      this.activeNotePath = nextPath;
      this.syncSelectionClasses();
    }));

    this.render();
  }
  onunload(): void {
    this.detachWheelHandler();
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
    this.applyLayoutSettings();
  }

  applyLayoutSettings(): void {
    const raw = Number(this.plugin?.settings?.scale ?? 1);
    const scale = Number.isFinite(raw) ? Math.max(0.7, Math.min(1.4, raw)) : 1;
    const layoutMode = this.getEffectiveLayoutMode();
    this.containerEl?.style.setProperty('--tps-kanban-scale', String(scale));
    this.containerEl?.setAttr('data-kanban-view-id', this.getLaneOrderViewId());
    this.containerEl?.classList.toggle('tps-kanban-container--list', layoutMode === 'list');
    this.scrollEl?.classList.toggle('tps-kanban-scroll--list', layoutMode === 'list');
    this.bindWheelHandler();
  }

  private getEffectiveLayoutMode(): 'board' | 'list' {
    if (this.isCompactViewport()) return 'list';
    return this.getLayoutMode();
  }

  private isCompactViewport(): boolean {
    return Platform.isMobile;
  }

  private getBoardScale(): number {
    const raw = Number(this.plugin?.settings?.scale ?? 1);
    return Number.isFinite(raw) ? Math.max(0.7, Math.min(1.4, raw)) : 1;
  }

  private shouldCompressEmptyLanes(
    displayLanes: DisplayLaneGroup[],
    renderItemsByDisplayLane: Map<string, LaneRenderItem[]>,
  ): boolean {
    if (!this.plugin.settings.dynamicEmptyLaneWidth) return false;
    if (this.getEffectiveLayoutMode() !== 'board') return false;

    const laneCount = displayLanes.length;
    if (laneCount <= 0) return false;

    let emptyLaneCount = 0;
    for (const displayLane of displayLanes) {
      const itemCount = (renderItemsByDisplayLane.get(displayLane.id) ?? []).length;
      if (itemCount === 0) emptyLaneCount += 1;
    }
    if (emptyLaneCount === 0) return false;

    const availableWidth = this.containerEl?.clientWidth ?? 0;
    if (availableWidth <= 0) return false;

    const scale = this.getBoardScale();
    const regularLaneWidth = 260 * scale;
    const compactLaneWidth = 96 * scale;
    const laneGap = 12 * scale;
    const gapTotal = Math.max(0, laneCount - 1) * laneGap;
    const fullExpandedWidth = laneCount * regularLaneWidth + gapTotal;
    if (fullExpandedWidth <= availableWidth) return false;

    const compressedWidth =
      (laneCount - emptyLaneCount) * regularLaneWidth +
      emptyLaneCount * compactLaneWidth +
      gapTotal;

    return compressedWidth < fullExpandedWidth;
  }

  private async applyNotebookNavigatorRulesToFile(file: TFile): Promise<void> {
    try {
      const gcm = (this.app as any)?.plugins?.getPlugin?.('tps-global-context-menu')
        ?? (this.app as any)?.plugins?.plugins?.['tps-global-context-menu'];
      const apply = gcm?.api?.notebookNavigator?.applyRulesToFile;
      if (typeof apply === 'function') {
        await apply(file, 'kanban-status-update');
      }
    } catch {
      // Ignore optional notebook rule integration failures.
    }
  }

  private bindWheelHandler(): void {
    if (!this.containerEl) return;
    if (this.wheelHandlerTarget === this.containerEl) return;
    this.detachWheelHandler();
    this.onWheelBound = (event: WheelEvent) => this.handleWheelRouting(event);
    this.containerEl.addEventListener('wheel', this.onWheelBound, { passive: false });
    this.wheelHandlerTarget = this.containerEl;
  }

  private detachWheelHandler(): void {
    if (!this.wheelHandlerTarget || !this.onWheelBound) return;
    this.wheelHandlerTarget.removeEventListener('wheel', this.onWheelBound);
    this.wheelHandlerTarget = null;
    this.onWheelBound = null;
  }

  private handleWheelRouting(event: WheelEvent): void {
    if (event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    const target = event.target as HTMLElement | null;
    if (!target) return;

    const laneCards = target.closest('.tps-kanban-cards') as HTMLElement | null;
    if (laneCards) {
      const verticalDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      const canScrollVertically = laneCards.scrollHeight > laneCards.clientHeight + 1;
      if (verticalDelta !== 0 && canScrollVertically) {
        const previous = laneCards.scrollTop;
        laneCards.scrollTop += verticalDelta;
        if (laneCards.scrollTop !== previous) event.preventDefault();
        if (laneCards.scrollTop !== previous) return;
      }
    }

    if (this.getEffectiveLayoutMode() === 'list') {
      const verticalDelta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      if (verticalDelta === 0) return;
      const previous = this.containerEl.scrollTop;
      this.containerEl.scrollTop += verticalDelta;
      if (this.containerEl.scrollTop !== previous) event.preventDefault();
      return;
    }

    const horizontalDelta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
    if (horizontalDelta === 0) return;
    const previous = this.containerEl.scrollLeft;
    this.containerEl.scrollLeft += horizontalDelta;
    if (this.containerEl.scrollLeft !== previous) event.preventDefault();
  }

  private isTaskScopedVirtualProp(normalizedPropId: string): boolean {
    if (!normalizedPropId) return false;
    const bare = normalizedPropId.startsWith('note.') ? normalizedPropId.slice(5) : normalizedPropId;
    return bare === 'status'
      || bare === 'scheduled'
      || bare === 'start'
      || bare === 'scheduleddate'
      || bare === 'scheduled-date'
      || bare === 'priority'
      || bare === 'allday'
      || bare === 'recurrence'
      || bare === 'completed'
      || bare === 'completeddate'
      || bare === 'due'
      || bare === 'date'
      || bare === 'timeestimate';
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

  private shouldProcessUpdates(): boolean {
    return this.containerEl.isConnected && this.containerEl.isShown();
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
        if (typeof propId !== 'string' || propId.length === 0) continue;
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

  private getViewCreationMode(): 'inherit' | 'note' | 'task' {
    const raw = String(this.config?.get?.('tpsCreateMode') ?? '').trim().toLowerCase();
    if (raw === 'note' || raw === 'task' || raw === 'inherit') return raw;
    return 'inherit';
  }

  private getResolvedCreationMode(): 'note' | 'task' {
    const mode = this.getViewCreationMode();
    if (mode === 'note' || mode === 'task') return mode;
    return this.plugin.settings.defaultCreateMode || 'note';
  }

  private getViewCreationDestination(): string {
    return String(this.config?.get?.('tpsCreateDestination') ?? '').trim();
  }

  private getResolvedCreationDestination(): string {
    const viewValue = this.getViewCreationDestination();
    if (viewValue) return viewValue;
    return String(this.plugin.settings.defaultCreateDestination ?? '').trim();
  }

  private normalizeNoteDestination(destination: string): string {
    const trimmed = String(destination || '').trim();
    if (!trimmed) return '';
    if (trimmed.toLowerCase().endsWith('.md')) {
      const slash = trimmed.lastIndexOf('/');
      return slash !== -1 ? trimmed.slice(0, slash) : '';
    }
    return trimmed;
  }

  private getGroupByPropId(propName: string | null): string | null {
    if (!propName) return null;

    const raw = (this.config as any)?.groupBy?.property as string | undefined;
    if (raw) {
      if (raw.includes('.')) return raw;
      return `note.${raw}`;
    }

    const allProps: string[] = Array.isArray((this as any).allProperties)
      ? (this as any).allProperties
      : [];
    const lower = propName.toLowerCase();
    const exact = allProps.find((p) => p.toLowerCase() === lower || p.toLowerCase() === `note.${lower}`);
    if (exact) return exact;

    const suffix = allProps.find((p) => p.toLowerCase().endsWith(`.${lower}`));
    return suffix || null;
  }

  private isLikelyListGroupingProperty(propName: string | null, propId: string | null): boolean {
    const name = String(propName || '').trim().toLowerCase();
    const id = String(propId || '').trim().toLowerCase();
    if (!propId || !id) return false;
    if (name === 'tags' || id.endsWith('.tags') || id === 'tags') return true;

    const entries: BasesEntry[] = this.data?.data ?? [];
    for (const entry of entries) {
      const values = this.extractGroupValues(entry.getValue(propId as any));
      if (values.length > 1) return true;
    }
    return false;
  }

  private buildGroupsFromEntries(entries: BasesEntry[], propId: string): BasesEntryGroup[] {
    const byKey = new Map<string, BasesEntry[]>();
    const keyLabel = new Map<string, string>();
    const ungrouped: BasesEntry[] = [];

    for (const entry of entries) {
      const values = this.extractGroupValues(entry.getValue(propId as any));
      if (!values.length) {
        ungrouped.push(entry);
        continue;
      }

      const unique = new Set(values.map((v) => v.trim()).filter(Boolean));
      if (!unique.size) {
        ungrouped.push(entry);
        continue;
      }

      for (const label of unique) {
        const norm = label.toLowerCase();
        const lane = byKey.get(norm) ?? [];
        lane.push(entry);
        byKey.set(norm, lane);
        if (!keyLabel.has(norm)) keyLabel.set(norm, label);
      }
    }

    const groups: BasesEntryGroup[] = [];
    for (const [norm, laneEntries] of byKey.entries()) {
      const label = keyLabel.get(norm) || norm;
      groups.push({
        key: label,
        entries: laneEntries,
        hasKey: () => true,
      } as unknown as BasesEntryGroup);
    }

    if (ungrouped.length) {
      groups.push({
        key: null,
        entries: ungrouped,
        hasKey: () => false,
      } as unknown as BasesEntryGroup);
    }

    return groups;
  }

  private buildMultiValueGroups(propId: string): BasesEntryGroup[] {
    const entries: BasesEntry[] = this.data?.data ?? [];
    return this.buildGroupsFromEntries(entries, propId);
  }

  private extractGroupValues(raw: unknown): string[] {
    if (raw == null) return [];

    if (Array.isArray(raw)) {
      return raw
        .map((v) => String(v ?? '').trim())
        .filter(Boolean);
    }

    if (raw instanceof Set) {
      return Array.from(raw.values())
        .map((v) => String(v ?? '').trim())
        .filter(Boolean);
    }

    if (typeof raw === 'object') {
      const anyRaw = raw as any;
      if (Array.isArray(anyRaw.values)) {
        return anyRaw.values
          .map((v: unknown) => String(v ?? '').trim())
          .filter(Boolean);
      }
    }

    const scalar = String(raw).trim();
    if (!scalar) return [];

    // Handle serialized list forms from Bases/frontmatter (e.g. "tag1, tag2", "[tag1, tag2]").
    const unwrapped = scalar.startsWith('[') && scalar.endsWith(']')
      ? scalar.slice(1, -1)
      : scalar;
    const hasListDelimiters = /[,;\n]/.test(unwrapped);
    if (!hasListDelimiters) return [this.normalizeGroupToken(unwrapped)];

    return unwrapped
      .split(/[,;\n]/g)
      .map((part) => this.normalizeGroupToken(part))
      .filter(Boolean);
  }

  private normalizeGroupToken(value: string): string {
    const trimmed = String(value ?? '').trim();
    if (!trimmed) return '';
    return trimmed.replace(/^['"]+|['"]+$/g, '').trim();
  }

  private keyLabel(group: BasesEntryGroup): string {
    if (!group.hasKey() || group.key == null) return 'No value';
    const s = String(group.key ?? '').trim();
    const normalized = s.toLowerCase();
    if (!s || normalized === 'null' || normalized === 'undefined') return 'No value';
    return s;
  }

  private getLaneLabelAlias(laneId: string): string | null {
    const viewId = this.getLaneOrderViewId();
    const all = this.plugin.settings?.laneLabelAliasesByView as Record<string, Record<string, string>> | undefined;
    const aliases = all?.[viewId];
    if (!aliases || typeof aliases !== 'object') return null;
    const alias = String(aliases[laneId] ?? '').trim();
    return alias || null;
  }

  private getLaneDisplayLabel(group: BasesEntryGroup): string {
    const laneId = this.getLaneId(group);
    return this.getLaneLabelAlias(laneId) || this.keyLabel(group);
  }

  private buildDisplayLaneGroups(groups: BasesEntryGroup[]): DisplayLaneGroup[] {
    const byLabel = new Map<string, DisplayLaneGroup>();
    const ordered: DisplayLaneGroup[] = [];

    for (const group of groups) {
      const label = this.getLaneDisplayLabel(group);
      const normalized = label.trim().toLowerCase() || 'no value';
      let display = byLabel.get(normalized);
      if (!display) {
        display = {
          id: `display:${normalized}`,
          label,
          groups: [],
          laneIds: [],
        };
        byLabel.set(normalized, display);
        ordered.push(display);
      }
      display.groups.push(group);
      display.laneIds.push(this.getLaneId(group));
    }

    return ordered;
  }

  private getRenderItemsForDisplayLane(
    displayLane: DisplayLaneGroup,
    laneRenderItemsByLane: Map<string, LaneRenderItem[]>,
  ): LaneRenderItem[] {
    const items: LaneRenderItem[] = [];
    const seen = new Set<string>();
    for (const laneId of displayLane.laneIds) {
      const laneItems = laneRenderItemsByLane.get(laneId) ?? [];
      for (const item of laneItems) {
        const path = item.entry.file.path;
        if (seen.has(path)) continue;
        seen.add(path);
        items.push(item);
      }
    }
    return items;
  }

  private async resolveDropValueForDisplayLane(
    displayLane: DisplayLaneGroup,
  ): Promise<{ selected: boolean; value: string | null }> {
    const options = displayLane.groups.map((group) => {
      if (group.hasKey() && group.key != null) {
        const value = String(group.key ?? '').trim();
        return { label: value || 'No value', value: value || null };
      }
      return { label: 'No value', value: null };
    });

    // De-duplicate while preserving lane order.
    const deduped: Array<{ label: string; value: string | null }> = [];
    const seen = new Set<string>();
    for (const option of options) {
      const key = option.value === null ? '__null__' : option.value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(option);
    }

    if (displayLane.groups.length <= 1 || deduped.length <= 1) {
      return { selected: true, value: deduped[0]?.value ?? null };
    }

    const selection = await new Promise<string | null | undefined>((resolve) => {
      const modal = new LaneValueSelectModal(
        this.app,
        `Apply value in "${displayLane.label}"`,
        deduped,
        resolve,
      );
      modal.open();
    });
    if (selection === undefined) return { selected: false, value: null };
    return { selected: true, value: selection };
  }

  private async renameLaneLabel(group: BasesEntryGroup): Promise<void> {
    const laneId = this.getLaneId(group);
    const viewId = this.getLaneOrderViewId();
    const baseLabel = this.keyLabel(group);
    const current = this.getLaneLabelAlias(laneId) || '';
    const entered = await new Promise<string | null>((resolve) => {
      const modal = new LaneRenameModal(this.app, baseLabel, current, resolve);
      modal.open();
    });
    if (entered == null) return;
    const nextLabel = entered.trim();

    const existingAll = this.plugin.settings?.laneLabelAliasesByView;
    const all: Record<string, Record<string, string>> = (existingAll && typeof existingAll === 'object')
      ? { ...existingAll }
      : {};
    const viewAliases: Record<string, string> = { ...(all[viewId] || {}) };

    if (!nextLabel || nextLabel === baseLabel) {
      delete viewAliases[laneId];
    } else {
      viewAliases[laneId] = nextLabel;
    }

    all[viewId] = viewAliases;
    this.plugin.settings.laneLabelAliasesByView = all;
    await this.plugin.saveSettings();
    this.render();
  }

  private isKanbanBoardFile(file: TFile): boolean {
    const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, unknown>;
    const key = this.findFrontmatterKeyCaseInsensitive(fm, 'kanban-plugin');
    const value = key ? String(fm[key] ?? '').trim().toLowerCase() : '';
    return value === 'board';
  }

  private shouldExpandTaskCardsFromFile(file: TFile): boolean {
    return file.extension.toLowerCase() === 'md';
  }

  private stripKanbanDateTokens(text: string): string {
    return String(text || '')
      .replace(/@@\{[^}]*\}/g, '')
      .replace(/@\{[^}]*\}/g, '')
      // Also strip Tasks-plugin dataview inline properties (e.g. [scheduled:: 2026-03-17])
      .replace(/\[[a-zA-Z0-9_-]+::\s*[^\]]+\]/g, '')
      .trim();
  }

  private isStoredTaskVisualPropertyKey(key: string): boolean {
    const normalized = String(key || '').trim().toLowerCase();
    return normalized === 'icon'
      || normalized === 'iconname'
      || normalized === 'icon-name'
      || normalized === 'iconcolor'
      || normalized === 'icon-color'
      || normalized === 'color';
  }

  private getStoredVirtualTaskVisualStyle(meta: VirtualKanbanTaskMeta): EntryVisualStyle {
    const iconName = String(
      meta.inlineProperties.icon
        || meta.inlineProperties.iconname
        || meta.inlineProperties['icon-name']
        || '',
    ).trim() || null;
    const colorValue = String(
      meta.inlineProperties.color
        || meta.inlineProperties.iconcolor
        || meta.inlineProperties['icon-color']
        || '',
    ).trim() || null;
    if (!iconName && !colorValue) {
      return { iconName: null, colorValue: null, iconColor: null };
    }
    return {
      iconName,
      colorValue,
      iconColor: iconName ? 'var(--text-on-accent)' : null,
    };
  }

  private applyTaskVisualInlineProperties(line: string, iconName: string | null, colorValue: string | null): string {
    const iconRe = /\s*\[(icon|iconname|icon-name)::\s*[^\]]+\]/i;
    const colorRe = /\s*\[(color|iconcolor|icon-color)::\s*[^\]]+\]/i;
    let updated = String(line || '');

    if (iconName && iconName.trim()) {
      const prop = `[icon:: ${iconName.trim()}]`;
      updated = iconRe.test(updated) ? updated.replace(iconRe, ` ${prop}`) : `${updated} ${prop}`;
    } else {
      updated = updated.replace(iconRe, '');
    }

    if (colorValue && colorValue.trim()) {
      const prop = `[color:: ${this.serializeTaskInlineColorValue(colorValue)}]`;
      updated = colorRe.test(updated) ? updated.replace(colorRe, ` ${prop}`) : `${updated} ${prop}`;
    } else {
      updated = updated.replace(colorRe, '');
    }

    return updated.replace(/\s{2,}/g, ' ').trimEnd();
  }

  private serializeTaskInlineColorValue(colorValue: string): string {
    const value = String(colorValue || '').trim();
    if (!value) return '';

    const hex = this.parseHexColorToRgba(value);
    if (!hex) return value;

    const { r, g, b, a } = hex;
    if (a >= 0.999) {
      return `rgb(${r}, ${g}, ${b})`;
    }
    const alpha = Math.round(a * 1000) / 1000;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  private parseHexColorToRgba(value: string): { r: number; g: number; b: number; a: number } | null {
    const raw = String(value || '').trim();
    const match = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
    if (!match) return null;

    const hex = match[1];
    if (hex.length === 3 || hex.length === 4) {
      const expanded = hex.split('').map((char) => char + char).join('');
      return this.parseHexColorToRgba(`#${expanded}`);
    }

    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }

  private createSyntheticVirtualTaskEntry(parentFile: TFile, taskText: string, lineNumber: number): BasesEntry {
    const syntheticFile = {
      ...parentFile,
      path: `${parentFile.path}::kanban-task:${lineNumber}`,
      basename: taskText || parentFile.basename,
      name: `${taskText || parentFile.basename}.md`,
      extension: 'md',
    } as TFile;
    return { file: syntheticFile } as BasesEntry;
  }

  private createVirtualTaskMeta(parentPath: string, task: ParsedKanbanTask): VirtualKanbanTaskMeta {
    return {
      parentPath,
      lineNumber: task.lineNumber,
      text: task.text,
      tags: task.tags,
      inlineProperties: task.inlineProperties,
      scheduled: task.scheduled,
      rawScheduled: task.rawScheduled,
      stateMarker: task.stateMarker,
    };
  }

  private extractInlineTags(text: string): string[] {
    const found = new Set<string>();
    const re = /(^|\s)#([^\s#]+)/g;
    let match: RegExpExecArray | null = null;
    while ((match = re.exec(text)) !== null) {
      const raw = String(match[2] ?? '').trim();
      if (!raw) continue;
      found.add(raw);
    }
    return Array.from(found);
  }

  private isTagsPropId(propId: unknown): boolean {
    const id = String(propId ?? '').trim().toLowerCase();
    if (!id) return false;
    return id === 'tags' || id === 'note.tags' || id.endsWith('.tags');
  }

  private normalizeTagValue(raw: string): string {
    const cleaned = String(raw ?? '')
      .trim()
      .replace(/^#/, '')
      .replace(/\s+/g, '-');
    return cleaned;
  }

  private collectLaneTagSet(groups: BasesEntryGroup[]): Set<string> {
    const laneTags = new Set<string>();
    for (const group of groups) {
      if (!group.hasKey() || group.key == null) continue;
      const normalized = this.normalizeTagValue(String(group.key));
      if (!normalized) continue;
      laneTags.add(normalized.toLowerCase());
    }
    return laneTags;
  }

  private updateKanbanTaskLineLaneTag(
    line: string,
    laneTags: Set<string>,
    targetTag: string | null,
  ): { changed: boolean; line: string } {
    const taskMatch = line.match(/^([\t ]*-\s+\[[^\]]\]\s+)(.*)$/);
    if (!taskMatch) return { changed: false, line };

    const prefix = taskMatch[1];
    const body = taskMatch[2] ?? '';
    const normalizedTarget = targetTag ? this.normalizeTagValue(targetTag) : '';
    const targetLower = normalizedTarget.toLowerCase();
    const targetToken = normalizedTarget ? `#${normalizedTarget}` : '';

    const trailingScheduleMatch = body.match(/(?:\s+@@?\{[^}]*\})+$/);
    const trailingSchedule = trailingScheduleMatch?.[0] ?? '';
    const mainBody = trailingSchedule ? body.slice(0, -trailingSchedule.length) : body;

    const tokens = mainBody.split(/(\s+)/);
    const kept: string[] = [];
    for (const token of tokens) {
      const m = token.match(/^#([^\s#]+)$/);
      if (!m) {
        kept.push(token);
        continue;
      }
      const normalizedExisting = this.normalizeTagValue(m[1]).toLowerCase();
      if (laneTags.has(normalizedExisting)) continue;
      kept.push(token);
    }

    let rebuiltMain = kept.join('').trimEnd();
    if (targetToken) {
      rebuiltMain = rebuiltMain ? `${rebuiltMain} ${targetToken}` : targetToken;
    }
    const rebuiltBody = `${rebuiltMain}${trailingSchedule}`.trim();
    const newLine = `${prefix}${rebuiltBody}`;
    return { changed: newLine !== line, line: newLine };
  }

  private async applyLaneTagToVirtualTask(
    meta: VirtualKanbanTaskMeta,
    laneTags: Set<string>,
    targetTag: string | null,
  ): Promise<boolean> {
    const parentFile = this.app.vault.getFileByPath(meta.parentPath);
    if (!parentFile) return false;

    const content = await this.app.vault.cachedRead(parentFile);
    const lines = content.split('\n');
    if (meta.lineNumber < 0 || meta.lineNumber >= lines.length) return false;

    const updated = this.updateKanbanTaskLineLaneTag(lines[meta.lineNumber], laneTags, targetTag);
    if (!updated.changed) return false;

    lines[meta.lineNumber] = updated.line;
    const parsed = this.parseKanbanBoardTasks(`${updated.line}\n`)[0];
    if (parsed) {
      const visual = this.computeVirtualTaskVisualStyleFromRules(this.createSyntheticVirtualTaskEntry(parentFile, parsed.text, meta.lineNumber), {
        ...this.createVirtualTaskMeta(parentFile.path, parsed),
        lineNumber: meta.lineNumber,
      });
      lines[meta.lineNumber] = this.applyTaskVisualInlineProperties(lines[meta.lineNumber], visual.iconName, visual.colorValue);
    }
    await this.app.vault.modify(parentFile, lines.join('\n'));
    this.emitTaskLineUpdated(parentFile, meta.lineNumber);
    return true;
  }

  /**
   * Apply a generic frontmatter-like property to a virtual task line.
   * Write order preference:
   *  1. If the task already has a Kanban @{date} token and the prop is a scheduled alias → update that token
   *  2. If the task already has a [prop:: value] inline property → update it in-place
   *  3. Otherwise append as [prop:: value] at the end of the task body (before Kanban tokens)
   */
  private async applyPropertyToVirtualTask(
    meta: VirtualKanbanTaskMeta,
    propName: string,
    targetValue: string | null,
  ): Promise<boolean> {
    const parentFile = this.app.vault.getFileByPath(meta.parentPath);
    if (!parentFile) return false;

    const content = await this.app.vault.cachedRead(parentFile);
    const lines = content.split('\n');
    if (meta.lineNumber < 0 || meta.lineNumber >= lines.length) return false;

    const line = lines[meta.lineNumber];
    const checkboxMatch = line.match(/^([\t ]*-\s+\[[^\]]\]\s+)(.*)$/);
    const bulletMatch = checkboxMatch ? null : line.match(/^([\t ]*-\s+)(.*)$/);
    const lineMatch = checkboxMatch || bulletMatch;
    if (!lineMatch) return false;

    const prefix = lineMatch[1];
    let body = lineMatch[2] ?? '';
    const propLower = propName.trim().toLowerCase();

    if (propLower === 'status' || propLower === 'note.status') {
      if (targetValue == null || !String(targetValue).trim()) {
        const strippedBody = body.replace(/\[[Ss]tatus::\s*[^\]]+\]\s*/g, '').trim();
        const newLine = `${prefix.replace(/\[[^\]]\]\s+$/, '')}${strippedBody}`.replace(/-\s+$/, '- ');
        if (newLine === line) return false;
        lines[meta.lineNumber] = newLine;
        const parsed = this.parseKanbanBoardTasks(`${newLine}\n`)[0];
        if (parsed) {
          const visual = this.computeVirtualTaskVisualStyleFromRules(this.createSyntheticVirtualTaskEntry(parentFile, parsed.text, meta.lineNumber), {
            ...this.createVirtualTaskMeta(parentFile.path, parsed),
            lineNumber: meta.lineNumber,
          });
          lines[meta.lineNumber] = this.applyTaskVisualInlineProperties(lines[meta.lineNumber], visual.iconName, visual.colorValue);
        }
        await this.app.vault.modify(parentFile, lines.join('\n'));
        this.emitTaskLineUpdated(parentFile, meta.lineNumber);
        return true;
      }
      const marker = this.getMarkerForTaskStatus(targetValue);
      if (marker == null) return false;
      const nextPrefix = prefix.replace(/\[[^\]]\]/, `[${marker}]`);
      const newLine = `${nextPrefix}${body}`;
      if (newLine === line) return false;
      lines[meta.lineNumber] = newLine;
      const parsed = this.parseKanbanBoardTasks(`${newLine}\n`)[0];
      if (parsed) {
        const visual = this.computeVirtualTaskVisualStyleFromRules(this.createSyntheticVirtualTaskEntry(parentFile, parsed.text, meta.lineNumber), {
          ...this.createVirtualTaskMeta(parentFile.path, parsed),
          lineNumber: meta.lineNumber,
        });
        lines[meta.lineNumber] = this.applyTaskVisualInlineProperties(lines[meta.lineNumber], visual.iconName, visual.colorValue);
      }
      await this.app.vault.modify(parentFile, lines.join('\n'));
      this.emitTaskLineUpdated(parentFile, meta.lineNumber);
      return true;
    }

    // Aliases that map to Kanban @{date} token
    const kanbanDateAliases = new Set(['scheduled', 'start', 'scheduleddate', 'scheduled-date']);

    // 1. Update existing Kanban @{date} token if prop is a scheduled-like alias
    if (kanbanDateAliases.has(propLower) && /@\{[^}]*\}/.test(body)) {
      if (targetValue == null) {
        body = body.replace(/\s*@@?\{[^}]*\}/g, '').trim();
      } else {
        // Preserve @@{time} token but replace @{date}
        body = body.replace(/(^|[^@])@\{[^}]*\}/, `$1@{${targetValue}}`);
      }
      const newLine = `${prefix}${body}`;
      if (newLine === line) return false;
      lines[meta.lineNumber] = newLine;
      const parsed = this.parseKanbanBoardTasks(`${newLine}\n`)[0];
      if (parsed) {
        const visual = this.computeVirtualTaskVisualStyleFromRules(this.createSyntheticVirtualTaskEntry(parentFile, parsed.text, meta.lineNumber), {
          ...this.createVirtualTaskMeta(parentFile.path, parsed),
          lineNumber: meta.lineNumber,
        });
        lines[meta.lineNumber] = this.applyTaskVisualInlineProperties(lines[meta.lineNumber], visual.iconName, visual.colorValue);
      }
      await this.app.vault.modify(parentFile, lines.join('\n'));
      return true;
    }

    // 2 & 3. Update or append [prop:: value] inline property
    const propRe = new RegExp(`\\[${propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}::\\s*[^\\]]*\\]`, 'i');
    if (propRe.test(body)) {
      // Update in-place
      if (targetValue == null) {
        body = body.replace(propRe, '').replace(/\s+/g, ' ').trim();
      } else {
        const storedValue = this.isStoredTaskVisualColorProperty(propLower)
          ? this.serializeTaskInlineColorValue(targetValue)
          : targetValue;
        body = body.replace(propRe, `[${propName}:: ${storedValue}]`);
      }
    } else if (targetValue != null) {
      // Append before trailing Kanban tokens so they stay at the end
      const trailingMatch = body.match(/(\s+@@?\{[^}]*\})+$/);
      const trailing = trailingMatch?.[0] ?? '';
      const mainBody = trailing ? body.slice(0, -trailing.length) : body;
      const storedValue = this.isStoredTaskVisualColorProperty(propLower)
        ? this.serializeTaskInlineColorValue(targetValue)
        : targetValue;
      body = `${mainBody.trimEnd()} [${propName}:: ${storedValue}]${trailing}`;
    }

    const newLine = `${prefix}${body}`.trimEnd();
    if (newLine === line) return false;
    lines[meta.lineNumber] = newLine;
    const parsed = this.parseKanbanBoardTasks(`${newLine}\n`)[0];
    if (parsed) {
      const visual = this.computeVirtualTaskVisualStyleFromRules(this.createSyntheticVirtualTaskEntry(parentFile, parsed.text, meta.lineNumber), {
        ...this.createVirtualTaskMeta(parentFile.path, parsed),
        lineNumber: meta.lineNumber,
      });
      lines[meta.lineNumber] = this.applyTaskVisualInlineProperties(lines[meta.lineNumber], visual.iconName, visual.colorValue);
    }
    await this.app.vault.modify(parentFile, lines.join('\n'));
    this.emitTaskLineUpdated(parentFile, meta.lineNumber);
    return true;
  }

  private isStoredTaskVisualColorProperty(propLower: string): boolean {
    return propLower === 'color' || propLower === 'iconcolor' || propLower === 'icon-color';
  }

  private getTaskPriorityValuesForMenu(): string[] {
    const calendarPlugin: any = (this.app as any)?.plugins?.plugins?.['tps-calendar-base'];
    const values =
      typeof calendarPlugin?.getPriorityValues === 'function'
        ? calendarPlugin.getPriorityValues()
        : [];
    const normalized = Array.from(
      new Set(
        (Array.isArray(values) ? values : [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    );
    return normalized.length > 0 ? normalized : ['low', 'normal', 'medium', 'high'];
  }

  private async mutateVirtualTaskLine(
    meta: VirtualKanbanTaskMeta,
    mutate: (line: string, parentFile: TFile) => string,
  ): Promise<boolean> {
    const parentFile = this.app.vault.getFileByPath(meta.parentPath);
    if (!parentFile) return false;

    const content = await this.app.vault.read(parentFile);
    const lines = content.split('\n');
    if (meta.lineNumber < 0 || meta.lineNumber >= lines.length) return false;

    const original = lines[meta.lineNumber];
    const updated = mutate(original, parentFile);
    if (!updated || updated === original) return false;

    const parsed = this.parseKanbanBoardTasks(`${updated}\n`)[0];
    const visual = parsed
      ? this.computeVirtualTaskVisualStyleFromRules(this.createSyntheticVirtualTaskEntry(parentFile, parsed.text, meta.lineNumber), {
          ...this.createVirtualTaskMeta(parentFile.path, parsed),
          lineNumber: meta.lineNumber,
        })
      : { iconName: null, colorValue: null, iconColor: null };
    lines[meta.lineNumber] = parsed
      ? this.applyTaskVisualInlineProperties(updated, visual.iconName, visual.colorValue)
      : updated;
    await this.app.vault.modify(parentFile, lines.join('\n'));
    this.emitTaskLineUpdated(parentFile, meta.lineNumber);
    return true;
  }

  private async syncMostRecentVirtualTaskVisualProperties(file: TFile): Promise<boolean> {
    const content = await this.app.vault.read(file);
    const tasks = this.parseKanbanBoardTasks(content);
    if (!tasks.length) return false;

    const latestTask = tasks.reduce((latest, task) => (task.lineNumber > latest.lineNumber ? task : latest));
    const lines = content.split('\n');
    if (latestTask.lineNumber < 0 || latestTask.lineNumber >= lines.length) return false;

    const visual = this.computeVirtualTaskVisualStyleFromRules(this.createSyntheticVirtualTaskEntry(file, latestTask.text, latestTask.lineNumber), {
      ...this.createVirtualTaskMeta(file.path, latestTask),
    });
    const updatedLine = this.applyTaskVisualInlineProperties(lines[latestTask.lineNumber], visual.iconName, visual.colorValue);
    if (updatedLine === lines[latestTask.lineNumber]) return false;

    lines[latestTask.lineNumber] = updatedLine;
    await this.app.vault.modify(file, lines.join('\n'));
    this.emitTaskLineUpdated(file, latestTask.lineNumber);
    return true;
  }

  private getVirtualTaskLinkedNoteValue(meta: VirtualKanbanTaskMeta, rawLine: string): string | null {
    const inlineValue = String(meta.inlineProperties[TASK_LINKED_NOTE_PROPERTY] || '').trim();
    if (inlineValue) return inlineValue;
    const match = String(rawLine || '').match(TASK_LINKED_NOTE_PROPERTY_RE);
    return match?.[1]?.trim() || null;
  }

  private resolveLinkValueToFile(value: string, sourcePath: string): TFile | null {
    const target = this.extractLinkTarget(value);
    if (!target) return null;
    const resolvedPath = this.resolveLinkTargetToPath(target, sourcePath);
    if (!resolvedPath) return null;
    const file = this.app.vault.getAbstractFileByPath(resolvedPath);
    return file instanceof TFile ? file : null;
  }

  private async promptForTaskLinkedNoteSelection(): Promise<TFile | null> {
    return await new Promise((resolve) => {
      let settled = false;
      const ModalCtor: any = FileSelectionModal as any;
      const modal = new ModalCtor(this.app as any, (file: TFile) => {
        if (settled) return;
        settled = true;
        resolve(file);
      });
      const originalOnClose = modal.onClose.bind(modal);
      modal.onClose = () => {
        originalOnClose();
        if (settled) return;
        settled = true;
        resolve(null);
      };
      modal.open();
    });
  }

  private async setVirtualTaskLinkedNote(meta: VirtualKanbanTaskMeta, linkedFile: TFile): Promise<boolean> {
    return await this.mutateVirtualTaskLine(meta, (line, parentFile) => {
      const linktext = this.app.metadataCache.fileToLinktext(linkedFile, parentFile.path, true);
      const propertyText = `[${TASK_LINKED_NOTE_PROPERTY}:: [[${linktext}]]]`;
      if (TASK_LINKED_NOTE_PROPERTY_RE.test(line)) {
        return line.replace(TASK_LINKED_NOTE_PROPERTY_RE, propertyText);
      }
      return `${line} ${propertyText}`;
    });
  }

  private async removeVirtualTaskLinkedNote(meta: VirtualKanbanTaskMeta): Promise<boolean> {
    return await this.mutateVirtualTaskLine(meta, (line) =>
      line.replace(new RegExp(`\\s*\\[${TASK_LINKED_NOTE_PROPERTY}::\\s*[^\\]]+\\]`, 'i'), ''),
    );
  }

  private async addTagsToVirtualTask(meta: VirtualKanbanTaskMeta, tagsToAdd: string[]): Promise<boolean> {
    const normalizedToAdd = Array.from(
      new Set(tagsToAdd.map((tag) => this.normalizeTagValue(tag)).filter(Boolean)),
    );
    if (!normalizedToAdd.length) return false;

    return await this.mutateVirtualTaskLine(meta, (line) => {
      const existing = new Set<string>();
      const re = /(^|\s)#([^\s#]+)/g;
      let match: RegExpExecArray | null = null;
      while ((match = re.exec(line)) !== null) {
        const normalized = this.normalizeTagValue(match[2] ?? '').toLowerCase();
        if (normalized) existing.add(normalized);
      }
      const missing = normalizedToAdd.filter((tag) => !existing.has(tag.toLowerCase()));
      if (!missing.length) return line;
      return `${line}${missing.map((tag) => ` #${tag}`).join('')}`;
    });
  }

  private async removeTagFromVirtualTask(meta: VirtualKanbanTaskMeta, tagToRemove: string): Promise<boolean> {
    const normalizedTarget = this.normalizeTagValue(tagToRemove).toLowerCase();
    if (!normalizedTarget) return false;

    return await this.mutateVirtualTaskLine(meta, (line) => {
      const updated = line.replace(/(^|\s)#([^\s#]+)/g, (full, prefix, rawTag) => {
        const normalized = this.normalizeTagValue(rawTag ?? '').toLowerCase();
        if (normalized !== normalizedTarget) return full;
        return prefix || '';
      });
      return updated.replace(/\s{2,}/g, ' ').trimEnd();
    });
  }

  private sanitizeFileName(value: string): string {
    return String(value || '')
      .replace(/[\\/:*?"<>|\x00-\x1F\x7F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    const normalized = normalizePath(String(folderPath || '').trim());
    if (!normalized) return;
    if (normalized === '/') return;
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (!existing) {
      await this.app.vault.createFolder(normalized);
    }
  }

  private async buildUniqueNotePath(folderPath: string, title: string): Promise<string> {
    const folder = normalizePath(String(folderPath || '').trim());
    const baseTitle = this.sanitizeFileName(title) || 'Untitled';
    const basePath = normalizePath(`${folder}/${baseTitle}.md`);
    const withoutExt = basePath.endsWith('.md') ? basePath.slice(0, -3) : basePath;
    const baseWithoutCounter = withoutExt.replace(/ \d+$/, '');
    const MAX_RETRIES = 20;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const candidate = attempt === 0 ? basePath : normalizePath(`${baseWithoutCounter} ${attempt}.md`);
      const existing = this.app.vault.getAbstractFileByPath(candidate);
      if (!existing) return candidate;
    }
    return normalizePath(`${baseWithoutCounter} ${MAX_RETRIES + 1}.md`);
  }

  private async promptForCardTitle(titleText: string, initialTitle: string): Promise<string | null> {
    return await new Promise((resolve) => {
      let settled = false;
      const modal = new CardTitleModal(this.app as any, titleText, initialTitle, (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      });
      const originalOnClose = modal.onClose.bind(modal);
      modal.onClose = () => {
        originalOnClose();
        if (settled) return;
        settled = true;
        resolve(null);
      };
      modal.open();
    });
  }

  private buildTaskLineForCreation(
    title: string,
    propName: string | null,
    targetValue: string | null,
    scheduledValue: string | null = null,
  ): string {
    const trimmedTitle = String(title || '').trim();
    const prop = String(propName || '').trim().toLowerCase();
    const value = String(targetValue || '').trim();
    const properties: string[] = [];

    if (scheduledValue) {
      properties.push(`[scheduled:: ${scheduledValue}]`);
    }

    if ((prop === 'status' || prop === 'note.status') && value) {
      const marker = this.getMarkerForTaskStatus(value) || ' ';
      const suffix = properties.length ? ` ${properties.join(' ')}` : '';
      return `- [${marker}] ${trimmedTitle}${suffix}`;
    }

    if (prop === 'status' || prop === 'note.status') {
      const suffix = properties.length ? ` ${properties.join(' ')}` : '';
      return `- ${trimmedTitle}${suffix}`;
    }

    if (prop && value) {
      if (prop === 'tags' || prop === 'note.tags') {
        const tags = value.split(/[,;\n]/g).map((tag) => this.normalizeTagValue(tag)).filter(Boolean);
        if (tags.length) {
          properties.push(...tags.map((tag) => `#${tag}`));
        }
      } else {
        properties.push(`[${prop}:: ${value}]`);
      }
    }

    const suffix = properties.length ? ` ${properties.join(' ')}` : '';
    return `- ${trimmedTitle}${suffix}`;
  }

  private async createNoteCardAtDestination(
    title: string,
    destinationFolder: string,
    propName: string | null,
    targetValue: string | null,
  ): Promise<boolean> {
    const folder = normalizePath(String(destinationFolder || '').trim());
    if (!folder) return false;
    await this.ensureFolderExists(folder);
    const path = await this.buildUniqueNotePath(folder, title);
    const file = await this.app.vault.create(path, '---\n---\n');
    if (propName) {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        if (targetValue === null) {
          delete fm[propName];
        } else {
          if (String(propName).trim().toLowerCase() === 'tags') {
            fm[propName] = targetValue
              .split(/[,;\n]/g)
              .map((tag) => this.normalizeTagValue(tag))
              .filter(Boolean);
          } else {
            fm[propName] = targetValue;
          }
        }
      });
    }
    await this.applyNotebookNavigatorRulesToFile(file);
    await this.app.workspace.getLeaf(false).openFile(file);
    this.render();
    return true;
  }

  private async appendTaskCardToDestination(
    title: string,
    destinationFilePath: string,
    propName: string | null,
    targetValue: string | null,
    scheduledValue: string | null = null,
  ): Promise<boolean> {
    const normalizedRaw = normalizePath(String(destinationFilePath || '').trim());
    if (!normalizedRaw) return false;
    const normalized = normalizedRaw.toLowerCase().endsWith('.md') ? normalizedRaw : `${normalizedRaw}.md`;

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing && !(existing instanceof TFile)) {
      throw new Error(`Task destination is not a markdown file: ${normalized}`);
    }
    const file = existing instanceof TFile ? existing : await this.app.vault.create(normalized, '');
    const line = this.buildTaskLineForCreation(title, propName, targetValue, scheduledValue);
    const content = await this.app.vault.cachedRead(file);
    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const next = `${content}${separator}${line}\n`;
    if (content !== next) {
      await this.app.vault.modify(file, next);
    }
    await this.applyNotebookNavigatorRulesToFile(file);
    const syncedVisuals = await this.syncMostRecentVirtualTaskVisualProperties(file);
    if (!syncedVisuals) {
      const createdTasks = this.parseKanbanBoardTasks(next);
      const createdTask = createdTasks.length > 0 ? createdTasks[createdTasks.length - 1] : null;
      this.emitTaskLineUpdated(file, createdTask?.lineNumber ?? null);
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    this.render();
    return true;
  }

  private async resolveDefaultTaskDestinationPath(): Promise<{ path: string | null; scheduledValue: string | null; }> {
    const resolver = getDailyNoteResolver(this.app as any);
    const today = new Date();
    const scheduledValue = resolver.formatDateKey(today);
    const dailyNote = await ensureDailyNoteFile(this.app as any, today);
    if (dailyNote instanceof TFile) {
      return { path: dailyNote.path, scheduledValue };
    }
    return { path: this.getActiveMarkdownPath(), scheduledValue };
  }

  private buildCardFrontmatterProcessor(
    propName: string | null,
    targetValue: string | null,
  ): ((frontmatter: Record<string, unknown>) => void) | undefined {
    if (!propName) return undefined;
    return (frontmatter: Record<string, unknown>) => {
      if (targetValue == null) {
        delete frontmatter[propName];
        return;
      }
      if (String(propName).trim().toLowerCase() === 'tags') {
        frontmatter[propName] = targetValue
          .split(/[,;\n]/g)
          .map((tag) => this.normalizeTagValue(tag))
          .filter(Boolean);
        return;
      }
      frontmatter[propName] = targetValue;
    };
  }

  private async handleAddCard(displayLane: DisplayLaneGroup, propName: string | null): Promise<void> {
    const targetSelection = propName
      ? await this.resolveDropValueForDisplayLane(displayLane)
      : { selected: true, value: null as string | null };
    if (!targetSelection.selected) return;

    const targetValue = targetSelection.value;
    const mode = this.getResolvedCreationMode();
    const destination = this.getResolvedCreationDestination();

    if (mode === 'note' && !destination) {
      await this.createFileForView(undefined, this.buildCardFrontmatterProcessor(propName, targetValue));
      return;
    }

    const title = await this.promptForCardTitle(
      mode === 'task' ? 'Create task card' : 'Create card note',
      '',
    );
    if (!title) return;

    if (mode === 'note') {
      const created = await this.createNoteCardAtDestination(title, this.normalizeNoteDestination(destination), propName, targetValue);
      if (!created) {
        new Notice('Failed to create card at the configured destination.');
      }
      return;
    }

    const taskTarget = destination
      ? { path: destination, scheduledValue: null }
      : await this.resolveDefaultTaskDestinationPath();
    const taskDestination = taskTarget.path;
    if (!taskDestination) {
      new Notice('No task destination configured.');
      return;
    }
    const created = await this.appendTaskCardToDestination(
      title,
      taskDestination,
      propName,
      targetValue,
      taskTarget.scheduledValue,
    );
    if (!created) {
      new Notice('Failed to create task card at the configured destination.');
    }
  }

  private parseVirtualTaskStateLabel(rawLine: string): string {
    const state = rawLine.match(/^[\t ]*-\s+\[([^\]]*)\]/)?.[1]?.trim() ?? '';
    if (/^[xX]$/.test(state)) return 'complete';
    if (state === '-') return 'canceled';
    if (state === '?') return 'question';
    return 'open';
  }

  private async revealVirtualTaskLine(meta: VirtualKanbanTaskMeta): Promise<void> {
    const parentFile = this.app.vault.getFileByPath(meta.parentPath);
    if (!parentFile) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(parentFile);
    const view: any = leaf.view;
    const editor = view?.editor;
    if (!editor) return;
    const safeLine = Math.max(0, meta.lineNumber);
    editor.setCursor({ line: safeLine, ch: 0 });
    editor.scrollIntoView({ from: { line: safeLine, ch: 0 }, to: { line: safeLine + 1, ch: 0 } }, true);
  }

  private async showVirtualTaskContextMenu(
    e: MouseEvent,
    meta: VirtualKanbanTaskMeta,
    text: string,
  ): Promise<void> {
    const parentFile = this.app.vault.getFileByPath(meta.parentPath);
    if (!parentFile) return;
    const content = await this.app.vault.cachedRead(parentFile);
    const lines = content.split('\n');
    const rawLine = lines[meta.lineNumber] || '';
    const currentState = rawLine.match(/^[\t ]*-\s+\[([^\]]*)\]/)?.[1]?.trim() ?? '';
    const stateLabel = this.parseVirtualTaskStateLabel(rawLine);
    const linkedNoteValue = this.getVirtualTaskLinkedNoteValue(meta, rawLine);
    const linkedNoteFile = linkedNoteValue ? this.resolveLinkValueToFile(linkedNoteValue, parentFile.path) : null;
    const scheduledLabel = String(
      meta.inlineProperties.scheduled
      || meta.inlineProperties.start
      || meta.inlineProperties.scheduleddate
      || meta.inlineProperties['scheduled-date']
      || '',
    ).trim();
    const durationLabel = String(meta.inlineProperties.timeestimate || '').trim();
    const currentPriority = String(meta.inlineProperties.priority || '').trim();
    const currentTags = Array.from(new Set(meta.tags.map((tag) => this.normalizeTagValue(tag)).filter(Boolean)));

    const menu = new Menu();
    menu.addItem((item) => item.setTitle(text || 'Task').setIcon('square').setDisabled(true));
    menu.addSeparator();
    const states: Array<{ char: string; label: string }> = [
      { char: ' ', label: 'Todo' },
      { char: '/', label: 'Working' },
      { char: 'x', label: 'Complete' },
      { char: '?', label: 'Holding' },
      { char: '-', label: "Won't Do" },
    ];
    for (const state of states) {
      const isActive = currentState === state.char;
      menu.addItem((item) =>
        item
          .setTitle(`${state.label} [${state.char === ' ' ? ' ' : state.char}]`)
          .setChecked(isActive)
          .onClick(async () => {
            const changed = await this.applyPropertyToVirtualTask(meta, 'status', this.getTaskStatusFromMarker(state.char));
            if (changed) {
              new Notice(`Task marked ${state.label.toLowerCase()}.`);
              this.render();
            }
          }),
      );
    }

    menu.addSeparator();

    for (const priority of this.getTaskPriorityValuesForMenu()) {
      const isActive = currentPriority.toLowerCase() === priority.toLowerCase();
      menu.addItem((item) =>
        item
          .setTitle(`Priority: ${priority}`)
          .setChecked(isActive)
          .onClick(async () => {
            const changed = await this.applyPropertyToVirtualTask(meta, 'priority', priority);
            if (changed) {
              new Notice(`Priority set to ${priority}.`);
              this.render();
            }
          }),
      );
    }
    if (currentPriority) {
      menu.addItem((item) =>
        item
          .setTitle('Clear priority')
          .setIcon('eraser')
          .onClick(async () => {
            const changed = await this.applyPropertyToVirtualTask(meta, 'priority', null);
            if (changed) {
              new Notice('Priority cleared.');
              this.render();
            }
          }),
      );
    }

    menu.addItem((item) =>
      item
        .setTitle('Add tags...')
        .setIcon('tags')
        .onClick(async () => {
          const entered = window.prompt('Add tags (comma separated, with or without #):', '');
          if (entered == null) return;
          const changed = await this.addTagsToVirtualTask(meta, entered.split(',').map((tag) => tag.trim()).filter(Boolean));
          if (changed) {
            new Notice('Tags updated.');
            this.render();
          }
        }),
    );
    for (const tag of currentTags) {
      menu.addItem((item) =>
        item
          .setTitle(`Remove tag: #${tag}`)
          .setIcon('tag')
          .onClick(async () => {
            const changed = await this.removeTagFromVirtualTask(meta, tag);
            if (changed) {
              new Notice(`Removed #${tag}.`);
              this.render();
            }
          }),
      );
    }

    menu.addSeparator();
    menu.addItem((item) => item.setTitle(`State: ${stateLabel}`).setDisabled(true));
    menu.addItem((item) => item.setTitle(`Line: ${meta.lineNumber + 1}`).setDisabled(true));
    if (scheduledLabel) {
      menu.addItem((item) => item.setTitle(`Scheduled: ${scheduledLabel}`).setDisabled(true));
    }
    if (durationLabel) {
      menu.addItem((item) => item.setTitle(`Duration: ${durationLabel}m`).setDisabled(true));
    }
    menu.addItem((item) =>
      item
        .setTitle('Open task line')
        .setIcon('list')
        .onClick(async () => {
          await this.revealVirtualTaskLine(meta);
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle('Open parent note')
        .setIcon('file-text')
        .onClick(async () => {
          await this.app.workspace.getLeaf(false).openFile(parentFile);
        }),
    );
    if (linkedNoteValue) {
      menu.addItem((item) =>
        item
          .setTitle(linkedNoteFile ? `Open linked note: ${linkedNoteFile.basename}` : 'Open linked note')
          .setIcon('link')
          .setDisabled(!linkedNoteFile)
          .onClick(async () => {
            if (!linkedNoteFile) return;
            await this.app.workspace.getLeaf(false).openFile(linkedNoteFile);
          }),
      );
      menu.addItem((item) =>
        item
          .setTitle('Replace linked note')
          .setIcon('link')
          .onClick(async () => {
            const selectedFile = await this.promptForTaskLinkedNoteSelection();
            if (!selectedFile) return;
            const changed = await this.setVirtualTaskLinkedNote(meta, selectedFile);
            if (changed) {
              new Notice(`Linked task to "${selectedFile.basename}".`);
              this.render();
            }
          }),
      );
      menu.addItem((item) =>
        item
          .setTitle('Remove linked note')
          .setIcon('unlink')
          .onClick(async () => {
            const changed = await this.removeVirtualTaskLinkedNote(meta);
            if (changed) {
              new Notice('Removed linked note from task.');
              this.render();
            }
          }),
      );
    } else {
      menu.addItem((item) =>
        item
          .setTitle('Link to Existing Note')
          .setIcon('link')
          .onClick(async () => {
            const selectedFile = await this.promptForTaskLinkedNoteSelection();
            if (!selectedFile) return;
            const changed = await this.setVirtualTaskLinkedNote(meta, selectedFile);
            if (changed) {
              new Notice(`Linked task to "${selectedFile.basename}".`);
              this.render();
            }
          }),
      );
    }
    menu.addItem((item) =>
      item
        .setTitle('Copy task text')
        .setIcon('copy')
        .onClick(async () => {
          await navigator.clipboard.writeText(text || rawLine.trim());
        }),
    );
    menu.showAtPosition({ x: e.clientX, y: e.clientY });
  }

  private normalizeTaskScheduleValue(raw: string): string | null {
    const value = String(raw || '').trim();
    if (!value) return null;

    const isoDateMatch = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/);
    if (isoDateMatch?.[1]) return isoDateMatch[1];

    const momentFactory = (window as any).moment;
    if (typeof momentFactory === 'function') {
      const parsed = momentFactory(value, [
        'YYYY-MM-DD',
        'YYYY-MM-DD HH:mm',
        'YYYY-MM-DD HH:mm:ss',
        'YYYY-MM-DDTHH:mm',
        'YYYY-MM-DDTHH:mm:ss',
        'ddd, MMM DD YYYY',
        'MMM DD YYYY',
      ], true);
      if (parsed?.isValid?.()) {
        return parsed.format('YYYY-MM-DD');
      }
    }

    const fallback = new Date(value);
    if (!Number.isNaN(fallback.getTime())) {
      return fallback.toISOString().slice(0, 10);
    }

    return null;
  }

  private parseTaskBooleanValue(raw: unknown): boolean | null {
    const normalized = String(raw ?? '').trim().toLowerCase();
    if (!normalized) return null;
    if (['true', 'yes', '1', 'on'].includes(normalized)) return true;
    if (['false', 'no', '0', 'off'].includes(normalized)) return false;
    return null;
  }

  private hasExplicitTimeComponent(raw: string | null): boolean {
    const value = String(raw ?? '').trim();
    if (!value) return false;
    return /(?:[T\s])\d{1,2}:\d{2}(?::\d{2})?$/.test(value);
  }

  private getTaskStatusFromMarker(marker: string): string {
    const normalized = String(marker ?? '').trim();
    if (!normalized) return '';
    if (/^[xX]$/.test(normalized)) return 'complete';
    if (normalized === '-') return 'wont-do';
    if (normalized === '?') return 'holding';
    if (normalized === '/') return 'working';
    return 'todo';
  }

  private getMarkerForTaskStatus(rawStatus: string | null): string | null {
    const normalized = String(rawStatus ?? '').trim().toLowerCase();
    if (!normalized) return null;
    if (['complete', 'completed', 'done', 'closed', 'x'].includes(normalized)) return 'x';
    if (['wont-do', 'won’t-do', 'wontdo', 'cancelled', 'canceled', 'archived', '-'].includes(normalized)) return '-';
    if (['holding', 'question', 'blocked', '?'].includes(normalized)) return '?';
    if (['working', 'in-progress', 'in progress', 'doing', '/'].includes(normalized)) return '/';
    if (['todo', 'open', 'scheduled', 'backlog', 'pending', ' '].includes(normalized)) return ' ';
    return null;
  }

  private createTaskDateValue(dateString: string): TaskDateValue {
    const normalized = String(dateString || '').trim();
    const momentFactory = (window as any).moment;
    const momentValue =
      typeof momentFactory === 'function'
        ? momentFactory(normalized, 'YYYY-MM-DD', true)
        : null;
    if (momentValue?.isValid?.()) {
      const dateValue = momentValue as typeof momentValue & TaskDateValue;
      dateValue.isEmpty = () => !normalized;
      dateValue.toJSON = () => normalized;
      dateValue.toDate = () => momentValue.toDate();
      return dateValue;
    }
    const fallbackDate = new Date(`${normalized}T00:00:00`);
    const safeDate = Number.isNaN(fallbackDate.getTime()) ? new Date(normalized) : fallbackDate;
    const dateValue = safeDate as Date & TaskDateValue;
    dateValue.isEmpty = () => !normalized;
    dateValue.toString = () => normalized;
    dateValue.valueOf = () => safeDate.getTime();
    dateValue.format = () => normalized;
    dateValue.toJSON = () => normalized;
    dateValue.toDate = () => safeDate;
    return dateValue;
  }

  private parseKanbanBoardTasks(content: string): ParsedKanbanTask[] {
    const lines = content.split('\n');
    const tasks: ParsedKanbanTask[] = [];
    const gcmSemantics = this.getGcmTaskSemanticsApi();

    for (let i = 0; i < lines.length; i++) {
      const parsedTask = gcmSemantics?.parseTaskLine?.(lines[i]);
      if (parsedTask) {
        const inlineProperties = parsedTask.inlineProperties || {};
        const text = String(parsedTask.text || '').trim();
        if (!text) continue;
        const rawText = String(parsedTask.body || '');
        const tags = this.extractInlineTags(this.stripKanbanDateTokens(rawText));
        tasks.push({
          lineNumber: i,
          text,
          tags,
          inlineProperties,
          scheduled: inlineProperties.scheduled || inlineProperties.start || inlineProperties.scheduleddate || inlineProperties['scheduled-date'] || null,
          rawScheduled:
            inlineProperties.scheduled
            || inlineProperties.start
            || inlineProperties.scheduleddate
            || inlineProperties['scheduled-date']
            || null,
          stateMarker: parsedTask.checkboxState ? String(parsedTask.checkboxState || '').replace(/^\[|\]$/g, '') : '',
        });
        continue;
      }

      const checkboxMatch = lines[i].match(/^[\t ]*-\s+\[([^\]])\]\s+(.*)$/);
      const bulletMatch = checkboxMatch ? null : lines[i].match(/^[\t ]*-\s+(?!\[[^\]]\]\s+)(.*)$/);
      if (!checkboxMatch && !bulletMatch) continue;
      const rawText = checkboxMatch ? checkboxMatch[2] : (bulletMatch?.[1] ?? '');
      const inlineProperties: Record<string, string> = {};
      const inlineRe = /\[([a-zA-Z0-9_-]+)::\s*([^\]]+)\]/g;
      let inlineMatch: RegExpExecArray | null;
      while ((inlineMatch = inlineRe.exec(rawText)) !== null) {
        const key = String(inlineMatch[1] ?? '').trim().toLowerCase();
        const value = String(inlineMatch[2] ?? '').trim();
        if (key && value) inlineProperties[key] = value;
      }
      const text = this.stripKanbanDateTokens(rawText).replace(/^\[([^\]]+)\]\([^)]+\)$/, '$1').trim();
      if (!text) continue;
      const tags = this.extractInlineTags(this.stripKanbanDateTokens(rawText));
      tasks.push({
        lineNumber: i,
        text,
        tags,
        inlineProperties,
        scheduled: inlineProperties.scheduled || inlineProperties.start || inlineProperties.scheduleddate || inlineProperties['scheduled-date'] || null,
        rawScheduled:
          inlineProperties.scheduled
          || inlineProperties.start
          || inlineProperties.scheduleddate
          || inlineProperties['scheduled-date']
          || null,
        stateMarker: checkboxMatch ? String(checkboxMatch[1] ?? '') : '',
      });
    }

    return tasks;
  }

  private getGcmTaskSemanticsApi(): GcmTaskSemanticsApi | null {
    const gcm =
      (this.app as any)?.plugins?.getPlugin?.('tps-global-context-menu') ??
      (this.app as any)?.plugins?.plugins?.['TPS-Global-Context-Menu (Dev)'];
    const api = gcm?.api ?? gcm;
    if (!api?.parseTaskLine) return null;
    return api as GcmTaskSemanticsApi;
  }

  private createVirtualTaskEntry(parentEntry: BasesEntry, task: ParsedKanbanTask): BasesEntry {
    const parentFile = parentEntry.file;
    const syntheticPath = `${parentFile.path}::kanban-task:${task.lineNumber}`;
    this.virtualTaskMetaByPath.set(syntheticPath, this.createVirtualTaskMeta(parentFile.path, task));

    const taskPropertyLookup = new Map<string, unknown>();
    for (const [key, value] of Object.entries(task.inlineProperties)) {
      const normalizedKey = String(key || '').trim().toLowerCase();
      const normalizedValue = String(value || '').trim();
      if (!normalizedKey || !normalizedValue) continue;
      if (normalizedKey === 'timeestimate') {
        const numeric = Number(normalizedValue);
        taskPropertyLookup.set(normalizedKey, Number.isFinite(numeric) ? numeric : normalizedValue);
        continue;
      }
      if (normalizedKey === 'allday') {
        const boolValue = this.parseTaskBooleanValue(normalizedValue);
        taskPropertyLookup.set(normalizedKey, boolValue ?? normalizedValue);
        continue;
      }
      taskPropertyLookup.set(normalizedKey, normalizedValue);
    }
    const derivedStatus = String(taskPropertyLookup.get('status') ?? this.getTaskStatusFromMarker(task.stateMarker)).trim();
    if (derivedStatus) {
      taskPropertyLookup.set('status', derivedStatus);
      taskPropertyLookup.set('note.status', derivedStatus);
    }
    const explicitAllDay = this.parseTaskBooleanValue(taskPropertyLookup.get('allday'));
    const derivedAllDay = explicitAllDay ?? (task.rawScheduled ? !this.hasExplicitTimeComponent(task.rawScheduled) : null);
    if (derivedAllDay != null) {
      taskPropertyLookup.set('allday', derivedAllDay);
      taskPropertyLookup.set('allDay', derivedAllDay);
      taskPropertyLookup.set('note.allday', derivedAllDay);
      taskPropertyLookup.set('note.allDay', derivedAllDay);
    }
    if (task.scheduled) {
      const scheduledValue = this.createTaskDateValue(task.scheduled);
      taskPropertyLookup.set('scheduled', scheduledValue);
      taskPropertyLookup.set('start', scheduledValue);
      taskPropertyLookup.set('scheduleddate', scheduledValue);
      taskPropertyLookup.set('scheduled-date', scheduledValue);
      taskPropertyLookup.set('note.scheduled', scheduledValue);
      taskPropertyLookup.set('note.start', scheduledValue);
      taskPropertyLookup.set('note.scheduleddate', scheduledValue);
      taskPropertyLookup.set('note.scheduled-date', scheduledValue);
    }

    const syntheticFile = {
      ...parentFile,
      path: syntheticPath,
      basename: task.text,
      name: `${task.text}.md`,
      extension: 'md',
    } as TFile;

    return {
      file: syntheticFile,
      getValue: (propId: any) => {
        const normalizedPropId = String(propId ?? '').trim().toLowerCase();
        if (!normalizedPropId) return parentEntry.getValue(propId);
        if (this.isTagsPropId(propId)) return task.tags;
        if (taskPropertyLookup.has(normalizedPropId)) {
          return taskPropertyLookup.get(normalizedPropId);
        }
        if (this.isTaskScopedVirtualProp(normalizedPropId)) {
          return null;
        }
        if (normalizedPropId.startsWith('note.')) {
          const strippedPropId = normalizedPropId.slice(5);
          if (taskPropertyLookup.has(strippedPropId)) {
            return taskPropertyLookup.get(strippedPropId);
          }
          if (strippedPropId === 'title' || strippedPropId === 'name' || strippedPropId === 'file.name' || strippedPropId === 'file.basename') {
            return task.text;
          }
        }
        if (
          normalizedPropId === 'title' ||
          normalizedPropId === 'name' ||
          normalizedPropId === 'file.name' ||
          normalizedPropId === 'file.basename'
        ) {
          return task.text;
        }
        return parentEntry.getValue(propId);
      },
    } as unknown as BasesEntry;
  }

  private async expandGroupEntriesWithKanbanTasks(groups: BasesEntryGroup[]): Promise<BasesEntryGroup[]> {
    this.virtualTaskMetaByPath.clear();
    const expandedGroups: BasesEntryGroup[] = [];
    const taskPosition = this.plugin.settings.kanbanTaskCardPosition || 'bottom';

    for (const group of groups) {
      const expandedEntries: BasesEntry[] = [];
      for (const entry of group.entries) {
        const file = entry.file;
        if (!(file instanceof TFile) || !this.shouldExpandTaskCardsFromFile(file)) {
          expandedEntries.push(entry);
          continue;
        }

        try {
          const content = await this.app.vault.cachedRead(file);
          const tasks = this.parseKanbanBoardTasks(content);
          if (!tasks.length) {
            expandedEntries.push(entry);
            continue;
          }

          const taskEntries = tasks.map((task) => this.createVirtualTaskEntry(entry, task));
          if (taskPosition === 'top') {
            expandedEntries.push(...taskEntries);
            expandedEntries.push(entry);
          } else {
            expandedEntries.push(entry);
            expandedEntries.push(...taskEntries);
          }
        } catch {
          expandedEntries.push(entry);
        }
      }

      expandedGroups.push({
        key: group.key,
        entries: expandedEntries,
        hasKey: group.hasKey,
      } as unknown as BasesEntryGroup);
    }

    return expandedGroups;
  }

  private getOrderedVisiblePaths(
    displayLanes: DisplayLaneGroup[],
    renderItemsByDisplayLane: Map<string, LaneRenderItem[]>,
  ): string[] {
    const ordered: string[] = [];
    for (const displayLane of displayLanes) {
      const items = renderItemsByDisplayLane.get(displayLane.id) ?? [];
      for (const item of items) {
        ordered.push(item.entry.file.path);
      }
    }
    return ordered;
  }

  private buildLaneRenderItemsByLane(
    groups: BasesEntryGroup[],
    parentByChild: Map<string, string>,
  ): Map<string, LaneRenderItem[]> {
    const laneRenderItemsByLane = new Map<string, LaneRenderItem[]>();
    const walk = (
      entry: BasesEntry,
      depth: number,
      laneId: string,
      lineage: Set<string>,
      renderedInLane: Set<string>,
      laneChildrenByParent: Map<string, BasesEntry[]>,
    ) => {
      const path = entry.file.path;
      if (renderedInLane.has(path) || lineage.has(path)) return;

      renderedInLane.add(path);
      const childCount = (laneChildrenByParent.get(path) ?? []).length;
      const hasChildren = childCount > 0;
      const laneItems = laneRenderItemsByLane.get(laneId) ?? [];
      laneItems.push({ entry, depth, hasChildren, childCount });
      laneRenderItemsByLane.set(laneId, laneItems);

      if (hasChildren && !this.expandedSubtreePaths.has(path)) {
        return;
      }

      const nextLineage = new Set(lineage);
      nextLineage.add(path);
      const children = laneChildrenByParent.get(path) ?? [];
      for (const child of children) {
        walk(child, depth + 1, laneId, nextLineage, renderedInLane, laneChildrenByParent);
      }
    };

    for (const group of groups) {
      const laneId = this.getLaneId(group);
      const laneEntryByPath = new Map<string, BasesEntry>();
      for (const entry of group.entries) {
        if (!laneEntryByPath.has(entry.file.path)) {
          laneEntryByPath.set(entry.file.path, entry);
        }
      }

      const laneChildrenByParent = new Map<string, BasesEntry[]>();
      for (const entry of laneEntryByPath.values()) {
        const parentPath = parentByChild.get(entry.file.path);
        if (!parentPath || parentPath === entry.file.path) continue;
        if (!laneEntryByPath.has(parentPath)) continue;
        const children = laneChildrenByParent.get(parentPath) ?? [];
        children.push(entry);
        laneChildrenByParent.set(parentPath, children);
      }

      const topLevel: BasesEntry[] = [];
      for (const entry of laneEntryByPath.values()) {
        const parentPath = parentByChild.get(entry.file.path);
        const hasVisibleParentInLane = !!parentPath && parentPath !== entry.file.path && laneEntryByPath.has(parentPath);
        if (!hasVisibleParentInLane) topLevel.push(entry);
      }

      laneRenderItemsByLane.set(laneId, []);
      const renderedInLane = new Set<string>();
      for (const entry of topLevel) {
        walk(entry, 0, laneId, new Set(), renderedInLane, laneChildrenByParent);
      }

      // Defensive fallback for malformed parent chains/cycles.
      for (const entry of laneEntryByPath.values()) {
        if (!renderedInLane.has(entry.file.path)) {
          walk(entry, 0, laneId, new Set(), renderedInLane, laneChildrenByParent);
        }
      }
    }

    return laneRenderItemsByLane;
  }

  private toggleSubtreeExpanded(path: string): void {
    if (!path) return;
    if (this.expandedSubtreePaths.has(path)) {
      this.expandedSubtreePaths.delete(path);
    } else {
      this.expandedSubtreePaths.add(path);
    }
    this.render();
  }

  private getParentLinkKeys(): string[] {
    const keys = new Set<string>();
    for (const settings of this.getRelationshipSettingsSources()) {
      const configured = String(
        settings?.parentLinkFrontmatterKey
        ?? settings?.parentLinkKey
        ?? '',
      ).trim();
      if (configured) keys.add(configured);
    }
    keys.add('childOf');
    keys.add('parent');
    return Array.from(keys);
  }

  /** Returns the set of "done" status values from GCM settings (or defaults). */
  private getDoneStatuses(): Set<string> {
    const firstWithDoneStatuses = this.getRelationshipSettingsSources().find(
      (settings) => Array.isArray(settings?.recurrenceCompletionStatuses) && settings.recurrenceCompletionStatuses.length > 0,
    );
    const raw: string[] = firstWithDoneStatuses?.recurrenceCompletionStatuses?.length
      ? firstWithDoneStatuses.recurrenceCompletionStatuses
      : ['complete', 'wont-do'];
    return new Set(raw.map((s: string) => String(s || '').trim().toLowerCase()));
  }

  /**
   * Write a property update to a file's frontmatter.
   * When propName is 'status', also manages completedDate automatically.
   * Fires tps-gcm-files-updated so all listening views refresh immediately.
   */
  private async applyFrontmatterProperty(
    file: TFile,
    propName: string,
    value: string | null,
  ): Promise<void> {
    const isStatusProp = propName.trim().toLowerCase() === 'status';
    const doneStatuses = isStatusProp ? this.getDoneStatuses() : null;
    const nowStamp = (): string =>
      typeof (window as any).moment === 'function'
        ? (window as any).moment().format('YYYY-MM-DD HH:mm:ss')
        : new Date().toISOString().replace('T', ' ').slice(0, 19);

    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (value == null) {
        delete fm[propName];
      } else {
        fm[propName] = value;
      }
      if (isStatusProp && doneStatuses) {
        const normalized = String(value ?? '').trim().toLowerCase();
        if (value != null && doneStatuses.has(normalized)) {
          fm['completedDate'] = nowStamp();
        } else {
          const cdKey = Object.keys(fm).find((k) => k.toLowerCase() === 'completeddate');
          if (cdKey) delete fm[cdKey];
        }
      }
    });
    (this.app.workspace as any).trigger('tps-gcm-files-updated', [file.path]);
  }

  /** Returns true if `ancestorPath` is a direct or transitive ancestor of `childPath`. */
  private isDescendantOf(childPath: string, ancestorPath: string, visited = new Set<string>()): boolean {
    if (visited.has(childPath)) return false; // cycle guard
    visited.add(childPath);
    const file = this.app.vault.getFileByPath(childPath);
    if (!file) return false;
    const parentPath = this.resolveParentPath(file);
    if (!parentPath) return false;
    if (parentPath === ancestorPath) return true;
    return this.isDescendantOf(parentPath, ancestorPath, visited);
  }

  private getChildLinkKeys(): string[] {
    const keys = new Set<string>();
    for (const settings of this.getRelationshipSettingsSources()) {
      const configured = String(
        settings?.childLinkFrontmatterKey
        ?? settings?.childLinkKey
        ?? '',
      ).trim();
      if (configured) keys.add(configured);
    }
    keys.add('parentOf');
    keys.add('children');
    keys.add('meetings');
    return Array.from(keys);
  }

  private getRelationshipSettingsSources(): Array<Record<string, any>> {
    const out: Array<Record<string, any>> = [];
    const pushIfObject = (candidate: unknown) => {
      if (candidate && typeof candidate === 'object') out.push(candidate as Record<string, any>);
    };

    // Local plugin settings (if present in this build variant).
    pushIfObject((this.plugin as any)?.settings);

    const plugins = (this.app as any)?.plugins?.plugins;
    if (plugins && typeof plugins === 'object') {
      // Dedicated GCM plugin variants.
      pushIfObject(plugins['tps-global-context-menu']?.settings);
      pushIfObject(plugins['TPS-Global-Context-Menu (Dev)']?.settings);
      // Consolidated TPS plugin variants.
      pushIfObject(plugins['tps']?.settings);
      pushIfObject(plugins['TPS (Dev)']?.settings);
    }

    return out;
  }

  private findFrontmatterKeyCaseInsensitive(frontmatter: Record<string, unknown>, target: string): string | null {
    const normalizedTarget = String(target || '').trim().toLowerCase();
    if (!normalizedTarget) return null;
    for (const key of Object.keys(frontmatter || {})) {
      if (String(key || '').trim().toLowerCase() === normalizedTarget) return key;
    }
    return null;
  }

  private getFrontmatterValueCaseInsensitive(frontmatter: Record<string, unknown>, key: string): unknown {
    const actual = this.findFrontmatterKeyCaseInsensitive(frontmatter, key);
    return actual ? frontmatter[actual] : undefined;
  }

  private getCalendarPlugin(): any {
    const plugins = (this.app as any)?.plugins?.plugins;
    if (!plugins || typeof plugins !== 'object') return null;
    return plugins['tps-calendar-base'] ?? plugins['TPS-Calendar-Base (Dev)'] ?? null;
  }

  private createTaskCheckboxIcon(state: string, size: number): HTMLElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.style.width = `${size}px`;
    svg.style.height = `${size}px`;
    svg.style.marginRight = '4px';
    svg.style.flexShrink = '0';
    svg.style.opacity = '0.9';

    const normalized = String(state || '').trim();
    if (!normalized) {
      const bullet = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      bullet.setAttribute('cx', '12');
      bullet.setAttribute('cy', '12');
      bullet.setAttribute('r', '3');
      bullet.setAttribute('fill', 'currentColor');
      bullet.setAttribute('stroke', 'none');
      svg.appendChild(bullet);
      return svg as unknown as HTMLElement;
    }

    const box = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    box.setAttribute('x', '3');
    box.setAttribute('y', '3');
    box.setAttribute('width', '18');
    box.setAttribute('height', '18');
    box.setAttribute('rx', '2');
    box.setAttribute('ry', '2');
    svg.appendChild(box);

    if (/^[xX]$/.test(normalized)) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M8 12l3 3 5-6');
      svg.appendChild(path);
    } else if (normalized === '-') {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M8 12h8');
      svg.appendChild(path);
    } else if (normalized === '\\') {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M8 8l8 8');
      svg.appendChild(path);
    } else if (normalized === '?') {
      const p1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p1.setAttribute('d', 'M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-.9.8-1.7 1.3-1.7 2.7');
      const p2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p2.setAttribute('d', 'M12 17h.01');
      svg.appendChild(p1);
      svg.appendChild(p2);
    }

    return svg as unknown as HTMLElement;
  }

  private computeVirtualTaskVisualStyleFromRules(entry: BasesEntry, virtualMeta: VirtualKanbanTaskMeta): EntryVisualStyle {
    const companion = this.getNotebookNavigatorCompanion();
    const useApiResolver = typeof companion?.api?.resolveVisualOutputsForContext === 'function';
    const useEngineResolver = typeof companion?.ruleEngine?.resolveVisualOutputs === 'function';
    const rules = Array.isArray(companion?.settings?.rules) ? companion.settings.rules : [];
    if ((!useApiResolver && !useEngineResolver) || !companion?.settings?.enabled || rules.length === 0) {
      return { iconName: null, colorValue: null, iconColor: null };
    }

    const parentFile = this.app.vault.getFileByPath(virtualMeta.parentPath);
    if (!(parentFile instanceof TFile)) {
      return { iconName: null, colorValue: null, iconColor: null };
    }

    const parentCache = this.app.metadataCache.getFileCache(parentFile);
    const parentFrontmatter = (parentCache?.frontmatter || {}) as Record<string, unknown>;
    const parentTags = this.collectNormalizedEntryTags(parentFile, parentFrontmatter);
    const taskTags = Array.from(new Set(virtualMeta.tags.map((tag) => this.normalizeTagValue(tag)).filter(Boolean)));
    const taskFrontmatter: Record<string, unknown> = { ...parentFrontmatter };

    for (const [key, value] of Object.entries(virtualMeta.inlineProperties || {})) {
      if (this.isStoredTaskVisualPropertyKey(key)) continue;
      if (String(value || '').trim()) {
        taskFrontmatter[key] = value;
      }
    }

    const status = this.getTaskStatusFromMarker(virtualMeta.stateMarker);
    if (!String(taskFrontmatter.status ?? '').trim()) {
      taskFrontmatter.status = status;
    }
    if (virtualMeta.inlineProperties.priority) {
      taskFrontmatter.priority = virtualMeta.inlineProperties.priority;
    }
    if (virtualMeta.scheduled) {
      const scheduledValue = this.createTaskDateValue(virtualMeta.scheduled);
      taskFrontmatter.scheduled = scheduledValue;
      taskFrontmatter.start = scheduledValue;
    }
    const dueValue = String(virtualMeta.inlineProperties.due || '').trim();
    if (dueValue) {
      const normalizedDue = this.normalizeTaskScheduleValue(dueValue);
      if (normalizedDue) {
        taskFrontmatter.due = this.createTaskDateValue(normalizedDue);
      }
    }
    const startValue = String(
      virtualMeta.inlineProperties.start
        || virtualMeta.inlineProperties.scheduled
        || virtualMeta.inlineProperties.scheduleddate
        || virtualMeta.inlineProperties['scheduled-date']
        || '',
    ).trim();
    if (startValue) {
      const normalizedStart = this.normalizeTaskScheduleValue(startValue);
      if (normalizedStart) {
        taskFrontmatter.start = this.createTaskDateValue(normalizedStart);
      }
    }
    taskFrontmatter.title = virtualMeta.text;
    taskFrontmatter.name = virtualMeta.text;
    taskFrontmatter.text = virtualMeta.text;
    taskFrontmatter.body = virtualMeta.text;

    const taskContext: RuleEvaluationContext = {
      file: {
        path: entry.file.path,
        name: entry.file.name,
        basename: entry.file.basename,
        extension: entry.file.extension,
      },
      frontmatter: taskFrontmatter,
      tags: Array.from(new Set([...parentTags, ...taskTags])),
      body: virtualMeta.text,
      parent: {
        file: {
          path: parentFile.path,
          name: parentFile.name,
          basename: parentFile.basename,
          extension: parentFile.extension,
        },
        frontmatter: parentFrontmatter,
        tags: parentTags,
      },
    };

    try {
      const visual = useApiResolver
        ? companion.api.resolveVisualOutputsForContext(taskContext)
        : companion.ruleEngine.resolveVisualOutputs(rules, taskContext);
      const iconName = String(visual?.icon?.value || '').trim() || null;
      const colorValue = String(visual?.color?.value || '').trim() || null;
      return {
        iconName,
        colorValue,
        iconColor: iconName ? 'var(--text-on-accent)' : null,
      };
    } catch {
      return { iconName: null, colorValue: null, iconColor: null };
    }
  }

  private getResolvedVirtualTaskVisualStyle(entry: BasesEntry, virtualMeta: VirtualKanbanTaskMeta): EntryVisualStyle {
    const stored = this.getStoredVirtualTaskVisualStyle(virtualMeta);
    if (stored.iconName || stored.colorValue) {
      return stored;
    }
    return this.computeVirtualTaskVisualStyleFromRules(entry, virtualMeta);
  }

  private emitTaskLineUpdated(file: TFile, lineNumber: number | null): void {
    (this.app.workspace as any)?.trigger?.(TASK_LINE_UPDATED_EVENT, {
      path: file.path,
      lineNumber,
    });
  }

  private hasRenderedVirtualTaskForFile(filePath: string): boolean {
    const prefix = `${normalizePath(filePath)}::kanban-task:`;
    for (const path of this.renderedFileOrder) {
      if (path.startsWith(prefix)) return true;
    }
    return false;
  }

  private isVisibleVirtualTaskLine(file: TFile, lineNumber: number | null): boolean {
    const syntheticPath = `${file.path}::kanban-task:${lineNumber}`;
    return this.renderedFileOrder.includes(syntheticPath) || this.virtualTaskMetaByPath.has(syntheticPath);
  }

  private resolveNoteVisualStyle(sourceFile: TFile): EntryVisualStyle {
    const kanbanSettings = this.plugin.settings;
    const calendarPlugin = this.getCalendarPlugin();
    const calendarSettings = calendarPlugin?.settings ?? {};
    const frontmatter = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter as Record<string, unknown> | undefined;
    const colorSource = String(calendarSettings.noteEventColorSource || 'frontmatter');
    const iconSource = String(calendarSettings.noteEventIconSource || 'frontmatter');
    const colorTarget = String(calendarSettings.noteEventFrontmatterColorTarget || 'both');
    const frontmatterColorField = String(calendarSettings.frontmatterColorField || kanbanSettings.colorKey || 'color');
    const frontmatterIconField = String(calendarSettings.frontmatterIconField || kanbanSettings.iconKey || 'icon');

    const canUseFrontmatterColor = colorSource === 'frontmatter' && colorTarget !== 'off';
    const canUseFrontmatterIcon = iconSource === 'frontmatter';

    const colorValue = canUseFrontmatterColor
      ? String(
        frontmatter
          ? this.getFrontmatterValueCaseInsensitive(frontmatter, frontmatterColorField)
          ?? this.getFrontmatterValueCaseInsensitive(frontmatter, 'iconColor')
          ?? ''
          : '',
      ).trim()
      : '';
    const iconName = canUseFrontmatterIcon
      ? String(
        frontmatter
          ? this.getFrontmatterValueCaseInsensitive(frontmatter, frontmatterIconField) ?? ''
          : '',
      ).trim()
      : '';

    return {
      iconName: iconName || null,
      colorValue: colorValue || null,
      iconColor: colorValue || null,
    };
  }

  private resolveEntryVisualStyle(entry: BasesEntry): EntryVisualStyle {
    const kanbanSettings = this.plugin.settings;
    const virtualMeta = this.virtualTaskMetaByPath.get(entry.file.path);
    if (virtualMeta) {
      return this.getResolvedVirtualTaskVisualStyle(entry, virtualMeta);
    }

    const calendarPlugin = this.getCalendarPlugin();
    const calendarSettings = calendarPlugin?.settings ?? {};
    const sourceFile = entry.file;
    const frontmatter = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter as Record<string, unknown> | undefined;
    const colorSource = String(calendarSettings.noteEventColorSource || 'frontmatter');
    const iconSource = String(calendarSettings.noteEventIconSource || 'frontmatter');
    const colorTarget = String(calendarSettings.noteEventFrontmatterColorTarget || 'both');
    const frontmatterColorField = String(calendarSettings.frontmatterColorField || kanbanSettings.colorKey || 'color');
    const frontmatterIconField = String(calendarSettings.frontmatterIconField || kanbanSettings.iconKey || 'icon');

    const canUseFrontmatterColor = colorSource === 'frontmatter' && colorTarget !== 'off';
    const canUseFrontmatterIcon = iconSource === 'frontmatter';

    const colorValue = canUseFrontmatterColor
      ? String(
        frontmatter
          ? this.getFrontmatterValueCaseInsensitive(frontmatter, frontmatterColorField)
          ?? this.getFrontmatterValueCaseInsensitive(frontmatter, 'iconColor')
          ?? ''
          : '',
      ).trim()
      : '';
    const iconName = canUseFrontmatterIcon
      ? String(
        frontmatter
          ? this.getFrontmatterValueCaseInsensitive(frontmatter, frontmatterIconField) ?? ''
          : '',
      ).trim()
      : '';

    return {
      iconName: iconName || (!calendarPlugin ? this.resolveCompanionIconValue(sourceFile, frontmatter) : '') || null,
      colorValue: colorValue || null,
      iconColor: colorValue || null,
    };
  }

  private getNotebookNavigatorCompanion(): any {
    const plugins = (this.app as any)?.plugins?.plugins;
    if (!plugins || typeof plugins !== 'object') return null;
    return (
      plugins['tps-notebook-navigator-companion']
      ?? plugins['TPS-Notebook-Navigator-Companion (Dev)']
      ?? null
    );
  }

  private isCompanionWriteExcluded(file: TFile): boolean {
    const companion = this.getNotebookNavigatorCompanion();
    const exclusionService: any = companion?.exclusionService;
    if (!exclusionService || typeof exclusionService.shouldIgnore !== 'function') return false;
    try {
      return !!exclusionService.shouldIgnore(file, { bypassCreationGrace: true });
    } catch {
      return false;
    }
  }

  private collectNormalizedEntryTags(file: TFile, frontmatter?: Record<string, unknown> | null): string[] {
    const cache = this.app.metadataCache.getFileCache(file);
    const rawValues = [
      ...(cache ? (getAllTags(cache) || []) : []),
      this.getFrontmatterValueCaseInsensitive(frontmatter || {}, 'tags'),
      this.getFrontmatterValueCaseInsensitive(frontmatter || {}, 'tag'),
    ];

    return Array.from(new Set(
      rawValues
        .flatMap((value) => Array.isArray(value) ? value : value == null ? [] : [value])
        .map((value) => String(value || '').replace(/^#+/, '').trim().toLowerCase())
        .filter(Boolean),
    ));
  }

  private resolveCompanionIconValue(file: TFile, frontmatter?: Record<string, unknown> | null): string {
    const companion = this.getNotebookNavigatorCompanion();
    const pickString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

    const configuredIconField = pickString(companion?.settings?.frontmatterIconField);
    if (configuredIconField) {
      const configuredValue = pickString(this.getFrontmatterValueCaseInsensitive(frontmatter || {}, configuredIconField));
      if (configuredValue) return configuredValue;
    }

    if (this.isCompanionWriteExcluded(file)) {
      return '';
    }

    const ruleEngine = companion?.ruleEngine;
    if (!companion?.settings?.enabled || typeof ruleEngine?.resolveVisualOutputs !== 'function') {
      return '';
    }

    try {
      const visual = ruleEngine.resolveVisualOutputs(companion.settings.rules || [], {
        file: {
          path: file.path,
          name: file.name,
          basename: file.basename,
          extension: file.extension,
        },
        frontmatter: frontmatter || {},
        tags: this.collectNormalizedEntryTags(file, frontmatter),
      });
      return pickString(visual?.icon?.value);
    } catch {
      return '';
    }
  }

  private normalizeLucideIconValue(iconName: string): string {
    const raw = String(iconName || '').trim();
    if (!raw) return '';
    if (raw.startsWith('lucide:')) return raw.slice('lucide:'.length).trim();
    if (raw.startsWith('lucide-')) return raw.slice('lucide-'.length).trim();
    const colonIdx = raw.indexOf(':');
    return colonIdx !== -1 ? raw.slice(colonIdx + 1).trim() : raw;
  }

  private normalizeLinkTarget(rawTarget: string): string | null {
    let target = String(rawTarget || '').trim();
    if (!target) return null;
    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1).trim();
    }
    if (target.includes('|')) {
      target = target.split('|')[0].trim();
    }
    if (target.includes('#')) {
      target = target.split('#')[0].trim();
    }
    target = target.replace(/^\.\/+/, '').trim();
    if (!target) return null;
    try {
      target = decodeURI(target);
    } catch {
      // Keep raw if decode fails.
    }
    return target || null;
  }

  private extractLinkTarget(value: unknown): string | null {
    if (value == null) return null;
    const raw = String(value).trim();
    if (!raw) return null;

    const markdownMatch = raw.match(/^!?\[[^\]]*]\(([^)]+)\)$/);
    if (markdownMatch?.[1]) return this.normalizeLinkTarget(markdownMatch[1]);

    const wikiMatch = raw.match(/^!?\[\[([^[\]]+)]]$/);
    if (wikiMatch?.[1]) return this.normalizeLinkTarget(wikiMatch[1]);

    return this.normalizeLinkTarget(raw);
  }

  private resolveLinkTargetToPath(rawTarget: string, sourcePath: string): string | null {
    const target = this.normalizeLinkTarget(rawTarget);
    if (!target) return null;

    const noMd = target.replace(/\.md$/i, '');
    const viaCache =
      this.app.metadataCache.getFirstLinkpathDest(target, sourcePath)
      || this.app.metadataCache.getFirstLinkpathDest(noMd, sourcePath);
    if (viaCache instanceof TFile) return viaCache.path;

    const normalized = normalizePath(target);
    const direct = this.app.vault.getAbstractFileByPath(normalized);
    if (direct instanceof TFile) return direct.path;

    const withMd = normalized.endsWith('.md') ? normalized : `${normalized}.md`;
    const directMd = this.app.vault.getAbstractFileByPath(withMd);
    if (directMd instanceof TFile) return directMd.path;

    // Defensive decode of malformed nested markdown link payloads.
    const nestedTargets = this.extractLinkTargetsFromText(target, false);
    for (const nestedTarget of nestedTargets) {
      const nestedResolved = this.resolveLinkTargetToPath(nestedTarget, sourcePath);
      if (nestedResolved) return nestedResolved;
    }

    return null;
  }

  private extractLinkTargetsFromText(rawText: string, allowBareValue: boolean = false): string[] {
    const text = String(rawText || '').trim();
    if (!text) return [];

    const targets: string[] = [];
    const seen = new Set<string>();
    const push = (rawTarget: string) => {
      const normalized = this.normalizeLinkTarget(rawTarget);
      if (!normalized) return;
      const key = normalized.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      targets.push(normalized);
    };

    let matchedStructuredLink = false;

    const wikiPattern = /!?\[\[([^[\]]+)\]\]/g;
    let wikiMatch: RegExpExecArray | null = null;
    while ((wikiMatch = wikiPattern.exec(text)) !== null) {
      matchedStructuredLink = true;
      push(wikiMatch[1]);
    }

    for (const markdownTarget of this.extractMarkdownLinkTargets(text)) {
      matchedStructuredLink = true;
      push(markdownTarget);
    }

    if (allowBareValue && !matchedStructuredLink) {
      text.split(/[\n,;]/).forEach((chunk) => push(chunk));
    }

    return targets;
  }

  private extractMarkdownLinkTargets(text: string): string[] {
    const targets: string[] = [];
    let i = 0;

    while (i < text.length) {
      const openBracket = text.indexOf('[', i);
      if (openBracket === -1) break;

      let closeBracket = openBracket + 1;
      let escaped = false;
      while (closeBracket < text.length) {
        const ch = text[closeBracket];
        if (!escaped && ch === ']') break;
        escaped = !escaped && ch === '\\';
        closeBracket += 1;
      }
      if (closeBracket >= text.length) break;

      if (text[closeBracket + 1] !== '(') {
        i = closeBracket + 1;
        continue;
      }

      let cursor = closeBracket + 2;
      let depth = 1;
      let inAngle = false;
      escaped = false;

      while (cursor < text.length) {
        const ch = text[cursor];
        if (!escaped) {
          if (ch === '<') inAngle = true;
          if (ch === '>') inAngle = false;
          if (!inAngle) {
            if (ch === '(') depth += 1;
            if (ch === ')') {
              depth -= 1;
              if (depth === 0) break;
            }
          }
        }
        escaped = !escaped && ch === '\\';
        cursor += 1;
      }

      if (depth !== 0 || cursor >= text.length) {
        i = closeBracket + 1;
        continue;
      }

      const destination = text.slice(closeBracket + 2, cursor).trim();
      if (destination) {
        targets.push(destination);
      }
      i = cursor + 1;
    }

    return targets;
  }

  private parseLinksFromFrontmatterValue(value: unknown, sourcePath: string): string[] {
    const output = new Set<string>();
    const visitedObjects = new Set<unknown>();

    const consume = (candidate: unknown) => {
      if (candidate === null || candidate === undefined) return;

      if (Array.isArray(candidate)) {
        if (visitedObjects.has(candidate)) return;
        visitedObjects.add(candidate);
        candidate.forEach((entry) => consume(entry));
        return;
      }

      if (typeof candidate === 'object') {
        if (visitedObjects.has(candidate)) return;
        visitedObjects.add(candidate);
        const record = candidate as Record<string, unknown>;
        const preferredLinkKeys = ['path', 'link', 'target', 'file', 'href', 'value'];
        let consumedPreferred = false;
        for (const key of preferredLinkKeys) {
          if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
          consumedPreferred = true;
          consume(record[key]);
        }
        if (!consumedPreferred) {
          Object.values(record).forEach((entry) => consume(entry));
        }
        return;
      }

      if (typeof candidate === 'string') {
        const targets = this.extractLinkTargetsFromText(candidate, true);
        for (const target of targets) {
          const resolved = this.resolveLinkTargetToPath(target, sourcePath);
          if (resolved) output.add(resolved);
        }
        return;
      }

      if (typeof candidate === 'number' || typeof candidate === 'boolean') {
        const resolved = this.resolveLinkTargetToPath(String(candidate), sourcePath);
        if (resolved) output.add(resolved);
      }
    };

    consume(value);
    return Array.from(output);
  }

  private resolveParentPath(file: TFile): string | null {
    const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, unknown>;
    const parentKeys = this.getParentLinkKeys();

    for (const key of parentKeys) {
      const raw = this.getFrontmatterValueCaseInsensitive(fm, key);
      const paths = this.parseLinksFromFrontmatterValue(raw, file.path);
      for (const path of paths) {
        if (path && path !== file.path) return path;
      }
    }

    return null;
  }

  private buildParentByChild(groups: BasesEntryGroup[]): Map<string, string> {
    const parentByChild = new Map<string, string>();
    const visiblePaths = new Set<string>();
    const entries: BasesEntry[] = [];
    const visibleEntryByPath = new Map<string, BasesEntry>();

    for (const group of groups) {
      for (const entry of group.entries) {
        visiblePaths.add(entry.file.path);
        if (!visibleEntryByPath.has(entry.file.path)) {
          visibleEntryByPath.set(entry.file.path, entry);
        }
        entries.push(entry);
      }
    }

    // Forward direction: child -> parent (e.g. childOf)
    for (const entry of entries) {
      if (parentByChild.has(entry.file.path)) continue;
      const parentPath = this.resolveParentPath(entry.file);
      if (!parentPath) continue;
      if (!visiblePaths.has(parentPath)) continue;
      parentByChild.set(entry.file.path, parentPath);
    }

    // Reverse direction: parent -> children (e.g. parentOf)
    const childKeys = this.getChildLinkKeys();
    for (const parentEntry of visibleEntryByPath.values()) {
      const fm = (this.app.metadataCache.getFileCache(parentEntry.file)?.frontmatter || {}) as Record<string, unknown>;
      for (const childKey of childKeys) {
        const raw = this.getFrontmatterValueCaseInsensitive(fm, childKey);
        const childPaths = this.parseLinksFromFrontmatterValue(raw, parentEntry.file.path);
        for (const childPath of childPaths) {
          if (!visiblePaths.has(childPath)) continue;
          if (childPath === parentEntry.file.path) continue;
          if (parentByChild.has(childPath)) continue;
          parentByChild.set(childPath, parentEntry.file.path);
        }
      }
    }

    return parentByChild;
  }

  private createSyntheticGroup(key: string | null): BasesEntryGroup {
    return {
      key,
      entries: [],
      hasKey: () => key != null,
    } as unknown as BasesEntryGroup;
  }

  private createFileBackedEntry(file: TFile): BasesEntry {
    return {
      file,
      getValue: (propId: any) => {
        const normalizedPropId = String(propId ?? '').trim().toLowerCase();
        if (!normalizedPropId) return null;
        if (this.isTagsPropId(propId)) {
          const tags = this.collectNormalizedEntryTags(file, this.app.metadataCache.getFileCache(file)?.frontmatter || {});
          return tags;
        }
        if (
          normalizedPropId === 'title'
          || normalizedPropId === 'name'
          || normalizedPropId === 'file.name'
          || normalizedPropId === 'file.basename'
          || normalizedPropId === 'note.title'
          || normalizedPropId === 'note.name'
          || normalizedPropId === 'note.file.name'
          || normalizedPropId === 'note.file.basename'
        ) {
          return file.basename;
        }
        const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, unknown>;
        const actualKey = this.findFrontmatterKeyCaseInsensitive(fm, normalizedPropId);
        if (actualKey) return fm[actualKey];
        if (normalizedPropId.startsWith('note.')) {
          const stripped = normalizedPropId.slice(5);
          const strippedKey = this.findFrontmatterKeyCaseInsensitive(fm, stripped);
          if (strippedKey) return fm[strippedKey];
        }
        return null;
      },
    } as unknown as BasesEntry;
  }

  private getCurrentDayKey(): string | null {
    const activePath = this.getActiveMarkdownPath();
    if (!activePath) return null;
    const file = this.app.vault.getFileByPath(activePath);
    if (!(file instanceof TFile)) return null;
    const normalized = this.normalizeTaskScheduleValue(file.basename);
    return normalized || null;
  }

  private shouldUseScheduledTaskFallback(): boolean {
    return true;
  }

  private async buildScheduledTaskFallbackGroups(targetDate: string): Promise<BasesEntryGroup[]> {
    const taskEntries: BasesEntry[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.shouldExpandTaskCardsFromFile(file)) continue;
      try {
        const content = await this.app.vault.cachedRead(file);
        const tasks = this.parseKanbanBoardTasks(content);
        const matchingTasks = tasks.filter((task) => task.scheduled && this.normalizeTaskScheduleValue(task.scheduled) === targetDate);
        if (!matchingTasks.length) continue;
        const parentEntry = this.createFileBackedEntry(file);
        for (const task of matchingTasks) {
          taskEntries.push(this.createVirtualTaskEntry(parentEntry, task));
        }
      } catch {
        continue;
      }
    }

    if (!taskEntries.length) return [];
    return [{
      key: null,
      entries: taskEntries,
      hasKey: () => false,
    } as unknown as BasesEntryGroup];
  }

  private hasVirtualTaskEntries(groups: BasesEntryGroup[]): boolean {
    for (const group of groups) {
      for (const entry of group.entries) {
        if (this.virtualTaskMetaByPath.has(entry.file.path)) return true;
      }
    }
    return false;
  }

  private getSavedLaneFallbackGroups(): BasesEntryGroup[] {
    const map = (this.plugin.settings?.laneOrderByView || {}) as Record<string, string[]>;
    const viewId = this.getLaneOrderViewId();
    const saved = Array.isArray(map[viewId]) ? map[viewId] : [];
    const groups: BasesEntryGroup[] = [];
    for (const laneIdRaw of saved) {
      const laneId = String(laneIdRaw || '').trim();
      if (!laneId) continue;
      if (laneId === 'ungrouped') {
        groups.push(this.createSyntheticGroup(null));
        continue;
      }
      if (laneId.startsWith('key:')) {
        const key = laneId.slice(4).trim();
        groups.push(this.createSyntheticGroup(key || null));
      }
    }
    return groups;
  }

  private getForcedLanesFromFilters(propName: string | null): { keys: string[]; includeUngrouped: boolean } {
    if (!propName) return { keys: [], includeUngrouped: false };

    const keys = new Set<string>();
    const includeUngrouped = { value: false };
    const roots: unknown[] = [
      this.config?.get?.('filters'),
      (this.config as any)?.filters,
      (this as any)?.filters,
      (this as any)?.view?.filters,
      (this as any)?.controller?.viewConfig?.filters,
      (this as any)?.controller?.config?.filters,
    ];
    for (const root of roots) {
      if (!root) continue;
      this.collectForcedLanesFromFilterNode(root, propName, keys, includeUngrouped);
    }
    return { keys: Array.from(keys), includeUngrouped: includeUngrouped.value };
  }

  private collectForcedLanesFromFilterNode(
    node: unknown,
    propName: string,
    keys: Set<string>,
    includeUngrouped: { value: boolean },
  ): void {
    if (!node) return;

    if (Array.isArray(node)) {
      for (const child of node) {
        this.collectForcedLanesFromFilterNode(child, propName, keys, includeUngrouped);
      }
      return;
    }

    if (typeof node === 'string') {
      this.collectForcedLanesFromFilterString(node, propName, keys, includeUngrouped);
      return;
    }

    if (typeof node !== 'object') return;
    this.collectForcedLanesFromFilterObject(node as Record<string, unknown>, propName, keys, includeUngrouped);

    for (const value of Object.values(node as Record<string, unknown>)) {
      this.collectForcedLanesFromFilterNode(value, propName, keys, includeUngrouped);
    }
  }

  private collectForcedLanesFromFilterString(
    rawExpr: string,
    propName: string,
    keys: Set<string>,
    includeUngrouped: { value: boolean },
  ): void {
    const expr = String(rawExpr || '').trim();
    if (!expr || expr.startsWith('!')) return;

    const escaped = propName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const propPattern = `(?:note\\.)?${escaped}`;

    const containsAnyMatch = expr.match(new RegExp(`^${propPattern}\\.containsAny\\((.*)\\)$`, 'i'));
    if (containsAnyMatch) {
      const args = containsAnyMatch[1] || '';
      for (const token of this.extractQuotedStrings(args)) {
        keys.add(token);
      }
    }

    const equalsCallMatch = expr.match(new RegExp(`^${propPattern}\\.equals\\((.*)\\)$`, 'i'));
    if (equalsCallMatch) {
      const [first] = this.extractQuotedStrings(equalsCallMatch[1] || '');
      if (first) keys.add(first);
    }

    const comparisonMatch = expr.match(new RegExp(`^${propPattern}\\s*(==|=)\\s*["']([^"']+)["']$`, 'i'));
    if (comparisonMatch?.[2]) {
      keys.add(comparisonMatch[2].trim());
    }

    const isEmptyMatch = expr.match(new RegExp(`^${propPattern}\\.isEmpty\\(\\)$`, 'i'));
    if (isEmptyMatch) includeUngrouped.value = true;
  }

  private collectForcedLanesFromFilterObject(
    node: Record<string, unknown>,
    propName: string,
    keys: Set<string>,
    includeUngrouped: { value: boolean },
  ): void {
    const propRaw =
      (typeof node.property === 'string' ? node.property : '') ||
      (typeof node.field === 'string' ? node.field : '');
    if (!propRaw) return;

    const normalizedProp = propRaw.startsWith('note.') ? propRaw.slice(5) : propRaw;
    if (normalizedProp.toLowerCase() !== propName.toLowerCase()) return;

    const op = String(node.operator ?? node.op ?? '').toLowerCase();
    if (op.includes('empty')) {
      includeUngrouped.value = true;
      return;
    }

    const rawValues = node.values ?? node.value;
    if (Array.isArray(rawValues)) {
      for (const value of rawValues) {
        if (typeof value === 'string' && value.trim()) keys.add(value.trim());
      }
      return;
    }

    if (typeof rawValues === 'string' && rawValues.trim()) {
      keys.add(rawValues.trim());
    }
  }

  private extractQuotedStrings(text: string): string[] {
    const values: string[] = [];
    const regex = /"([^"]+)"|'([^']+)'/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const value = (match[1] ?? match[2] ?? '').trim();
      if (value) values.push(value);
    }
    return values;
  }

  private getLaneId(group: BasesEntryGroup): string {
    if (!group.hasKey() || group.key == null) return 'ungrouped';
    const key = String(group.key).trim().toLowerCase();
    if (!key || key === 'null' || key === 'undefined') return 'ungrouped';
    return `key:${key}`;
  }

  private mergeGroupsByLaneId(groups: BasesEntryGroup[]): BasesEntryGroup[] {
    const laneOrder: string[] = [];
    const laneEntries = new Map<string, Map<string, BasesEntry>>();
    const laneLabel = new Map<string, string | null>();

    for (const group of groups) {
      const laneId = this.getLaneId(group);
      if (!laneEntries.has(laneId)) {
        laneOrder.push(laneId);
        laneEntries.set(laneId, new Map<string, BasesEntry>());
        laneLabel.set(
          laneId,
          laneId === 'ungrouped'
            ? null
            : String(group.key ?? '').trim() || null,
        );
      }

      const entriesByPath = laneEntries.get(laneId)!;
      for (const entry of group.entries) {
        if (!entriesByPath.has(entry.file.path)) {
          entriesByPath.set(entry.file.path, entry);
        }
      }
    }

    return laneOrder.map((laneId) => {
      const entries = Array.from((laneEntries.get(laneId) ?? new Map()).values());
      const key = laneId === 'ungrouped' ? null : (laneLabel.get(laneId) ?? null);
      return {
        key,
        entries,
        hasKey: () => key != null,
      } as unknown as BasesEntryGroup;
    });
  }

  private getLaneOrderViewId(): string {
    const controller: any = (this as any)?.controller;
    const sourcePath = [
      controller?.file?.path,
      controller?.baseFile?.path,
      controller?.source?.path,
      (this as any)?.file?.path,
    ].find((value) => typeof value === 'string' && value.length > 0) || 'unknown-base';
    const viewName = String(this.config?.name || 'kanban').trim() || 'kanban';
    return `${sourcePath}::${viewName}`;
  }

  static getOptions(): any[] {
    return [
      {
        displayName: 'Creation',
        type: 'group',
        items: [
          {
            displayName: 'Creation mode',
            type: 'dropdown',
            key: 'tpsCreateMode',
            default: 'inherit',
            options: {
              inherit: 'Use global default',
              note: 'Full note',
              task: 'Task line',
            },
          },
          {
            displayName: 'Creation destination',
            type: 'text',
            key: 'tpsCreateDestination',
            placeholder: 'Leave blank to use the global default',
          },
        ],
      },
    ];
  }

  private getLayoutMode(): 'board' | 'list' {
    const viewId = this.getLaneOrderViewId();
    const map = (this.plugin.settings?.layoutModeByView || {}) as Record<string, 'board' | 'list'>;
    return map[viewId] === 'list' ? 'list' : 'board';
  }

  private async toggleLayoutMode(): Promise<void> {
    const viewId = this.getLaneOrderViewId();
    const current = this.getLayoutMode();
    const next: 'board' | 'list' = current === 'list' ? 'board' : 'list';
    const existing = this.plugin.settings?.layoutModeByView;
    const map: Record<string, 'board' | 'list'> = (existing && typeof existing === 'object') ? { ...existing } : {};
    map[viewId] = next;
    this.plugin.settings.layoutModeByView = map;
    await this.plugin.saveSettings();
    this.applyLayoutSettings();
    this.render();
  }

  private async toggleDynamicEmptyLaneWidth(): Promise<void> {
    const current = !!this.plugin.settings.dynamicEmptyLaneWidth;
    this.plugin.settings.dynamicEmptyLaneWidth = !current;
    await this.plugin.saveSettings();
    this.render();
  }

  private applyManualLaneOrder(groups: BasesEntryGroup[]): BasesEntryGroup[] {
    const settings = this.plugin.settings;
    const map = (settings?.laneOrderByView || {}) as Record<string, string[]>;
    const viewId = this.getLaneOrderViewId();
    const saved = Array.isArray(map[viewId]) ? map[viewId] : [];
    if (!saved.length) return groups;

    const rank = new Map<string, number>();
    saved.forEach((id, i) => rank.set(String(id), i));

    return groups
      .map((group, index) => ({ group, index, laneId: this.getLaneId(group) }))
      .sort((a, b) => {
        const ar = rank.has(a.laneId) ? (rank.get(a.laneId) as number) : Number.MAX_SAFE_INTEGER;
        const br = rank.has(b.laneId) ? (rank.get(b.laneId) as number) : Number.MAX_SAFE_INTEGER;
        if (ar !== br) return ar - br;
        return a.index - b.index;
      })
      .map((item) => item.group);
  }

  private async saveManualLaneOrder(groups: BasesEntryGroup[]): Promise<void> {
    const viewId = this.getLaneOrderViewId();
    const laneIds = groups.map((group) => this.getLaneId(group));
    const existing = this.plugin.settings?.laneOrderByView;
    const next = (existing && typeof existing === 'object') ? { ...existing } : {};
    next[viewId] = laneIds;
    this.plugin.settings.laneOrderByView = next;
    await this.plugin.saveSettings();
  }

  private reorderGroups(groups: BasesEntryGroup[], draggedLaneId: string, targetLaneId: string): BasesEntryGroup[] {
    if (draggedLaneId === targetLaneId) return groups;
    const ordered = [...groups];
    const from = ordered.findIndex((group) => this.getLaneId(group) === draggedLaneId);
    const to = ordered.findIndex((group) => this.getLaneId(group) === targetLaneId);
    if (from === -1 || to === -1) return groups;

    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
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
      card.classList.toggle('tps-kanban-card--open-note', !!path && !!this.activeNotePath && path === this.activeNotePath);
    });
  }

  private getActiveMarkdownPath(): string | null {
    const active = this.app.workspace.getActiveFile();
    return active instanceof TFile ? active.path : null;
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

  private createEntryCard(
    entry: BasesEntry,
    groups: BasesEntryGroup[],
    propName: string | null,
    item: LaneRenderItem,
    layoutMode: 'board' | 'list',
  ): HTMLElement {
    const cardEl = document.createElement('div');
    const virtualMeta = this.virtualTaskMetaByPath.get(entry.file.path);
    const isVirtualTask = !!virtualMeta;
    const isListLayout = layoutMode === 'list';
    const taskState = virtualMeta?.stateMarker ?? '';
    const taskStatus = isVirtualTask ? this.getTaskStatusFromMarker(taskState) : '';
    const taskIsDone = isVirtualTask && (/^[xX]$/.test(taskState) || taskState === '-');
    const visualStyle = this.resolveEntryVisualStyle(entry);
    const taskColor = isVirtualTask ? visualStyle.colorValue || '' : '';
    let suppressNextClick = false;
    let clearSuppressTimer: number | null = null;

    const scheduleSuppressReset = () => {
      if (clearSuppressTimer != null) {
        window.clearTimeout(clearSuppressTimer);
      }
      clearSuppressTimer = window.setTimeout(() => {
        suppressNextClick = false;
        clearSuppressTimer = null;
      }, 250);
    };

    cardEl.className = 'tps-kanban-card';
    if (isListLayout) {
      cardEl.classList.add('tps-kanban-card--list');
    }
    if (isVirtualTask) {
      cardEl.classList.add('tps-kanban-card--task');
      cardEl.classList.add('bases-calendar-event', 'is-task');
      if (taskStatus) {
        cardEl.classList.add(`bases-calendar-event-status-${taskStatus}`);
      }
      cardEl.style.setProperty('--tps-card-color', taskColor);
      cardEl.style.setProperty('--tps-card-icon-color', 'var(--text-on-accent)');
      cardEl.style.backgroundColor = taskColor;
      cardEl.style.borderColor = taskColor;
      cardEl.style.color = 'var(--text-on-accent)';
    }
    cardEl.title = entry.file.path;
    cardEl.draggable = true;
    cardEl.dataset.path = entry.file.path;
    if (this.selectedPaths.has(entry.file.path)) cardEl.classList.add('tps-kanban-card--selected');
    if (this.activeNotePath && entry.file.path === this.activeNotePath) {
      cardEl.classList.add('tps-kanban-card--open-note');
    }

    const colorTarget = this.plugin.settings.frontmatterColorTarget || 'both';
    const applyColorToCard = colorTarget === 'card' || colorTarget === 'both';
    const applyColorToIcon = colorTarget === 'icon' || colorTarget === 'both';

    if (!isVirtualTask) {
      if (visualStyle.colorValue && applyColorToCard) {
        cardEl.style.setProperty('--tps-card-color', visualStyle.colorValue);
        cardEl.classList.add('tps-kanban-card--colored');
      }
      if (visualStyle.iconColor && applyColorToIcon) {
        cardEl.style.setProperty('--tps-card-icon-color', visualStyle.iconColor);
      }
    }

    // Card inner: optional icon + title text
    const inner = cardEl.createDiv({ cls: 'tps-kanban-card-inner' });
    if (isVirtualTask) {
      if (visualStyle.iconName) {
        const iconEl = inner.createDiv({ cls: 'tps-kanban-card-icon tps-kanban-task-icon' });
        setIcon(iconEl, this.normalizeLucideIconValue(visualStyle.iconName));
        iconEl.style.color = visualStyle.iconColor || 'var(--text-on-accent)';
      } else {
        const iconEl = inner.createDiv({ cls: 'tps-kanban-card-icon tps-kanban-task-checkbox' });
        iconEl.appendChild(this.createTaskCheckboxIcon(taskState, isListLayout ? 12 : 14));
        if (taskIsDone) {
          iconEl.classList.add('tps-kanban-task-checkbox--done');
        }
        iconEl.style.color = 'var(--text-on-accent)';
      }
    } else if (visualStyle.iconName) {
      const iconEl = inner.createDiv({ cls: 'tps-kanban-card-icon' });
      const bareIcon = this.normalizeLucideIconValue(visualStyle.iconName);
      setIcon(iconEl, bareIcon);
      // If setIcon couldn't find the icon it renders nothing — remove the empty div
      // so it doesn't add unwanted spacing.
      if (!iconEl.querySelector('svg')) iconEl.remove();
    }

    const titleEl = inner.createSpan({ text: entry.file.basename, cls: 'tps-kanban-card-title' });
    if (isVirtualTask && taskIsDone) {
      titleEl.style.textDecoration = 'line-through';
      titleEl.style.opacity = '0.72';
    }

    if (item.hasChildren) {
      const collapsed = !this.expandedSubtreePaths.has(entry.file.path);
      const toggleBtn = inner.createEl('button', {
        cls: 'tps-kanban-subtree-toggle',
        attr: {
          type: 'button',
          'aria-label': collapsed ? 'Expand subitems' : 'Collapse subitems',
          title: collapsed
            ? `Expand ${item.childCount} subitem${item.childCount === 1 ? '' : 's'}`
            : `Collapse ${item.childCount} subitem${item.childCount === 1 ? '' : 's'}`,
        },
      });
      toggleBtn.draggable = false;
      setIcon(toggleBtn, collapsed ? 'chevron-right' : 'chevron-down');
      toggleBtn.addEventListener('pointerdown', (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
      });
      toggleBtn.addEventListener('click', (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleSubtreeExpanded(entry.file.path);
      });
    }

    cardEl.addEventListener('dragstart', (e: DragEvent) => {
      if (!e.dataTransfer) return;
      suppressNextClick = true;
      scheduleSuppressReset();
      const referenceTitle = isVirtualTask
        ? String(virtualMeta?.text || entry.file.basename).trim()
        : String(entry.file.basename || '').trim();
      const referencePath = isVirtualTask
        ? String(virtualMeta?.parentPath || entry.file.path).trim()
        : String(entry.file.path).trim();
      const wikilink = buildTaskSourceWikilink(referencePath, referenceTitle);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-kanban-entry', entry.file.path);
      if (isVirtualTask) e.dataTransfer.setData('application/x-kanban-virtual-task', '1');
      if (referenceTitle && referencePath) {
        const cardRefPayload: Record<string, string> = {
          title: referenceTitle,
          linkPath: referencePath,
        };
        if (isVirtualTask) {
          cardRefPayload.isTask = '1';
          cardRefPayload.checkboxState = `[${taskState || ' '}]`;
        }
        e.dataTransfer.setData(TASK_REFERENCE_DRAG_TYPE, JSON.stringify(cardRefPayload));
      }
      if (wikilink) {
        e.dataTransfer.setData('text/plain', wikilink);
      }
      cardEl.style.opacity = '0.5';
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.style.opacity = '1';
      scheduleSuppressReset();
    });

    // single click — open the file
    cardEl.addEventListener('click', (e: MouseEvent) => {
      if (suppressNextClick) {
        e.preventDefault();
        e.stopPropagation();
        suppressNextClick = false;
        if (clearSuppressTimer != null) {
          window.clearTimeout(clearSuppressTimer);
          clearSuppressTimer = null;
        }
        return;
      }
      if (e.shiftKey) {
        this.selectRange(entry.file.path);
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        this.toggleSelect(entry.file.path);
        return;
      }
      this.selectOnly(entry.file.path);
      if (isVirtualTask && virtualMeta) {
        const parent = this.app.vault.getFileByPath(virtualMeta.parentPath);
        if (parent) this.app.workspace.getLeaf(false).openFile(parent);
        return;
      }
      this.app.workspace.getLeaf(false).openFile(entry.file);
    });

    // right-click — trigger native file/files menu so GCM augments this view too.
    cardEl.addEventListener('contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (isVirtualTask && virtualMeta) {
        void this.showVirtualTaskContextMenu(e, virtualMeta, entry.file.basename);
        return;
      }

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
                await this.applyFrontmatterProperty(file, propName, val);
                await this.applyNotebookNavigatorRulesToFile(file);
              }
              this.render();
            }));
          } else {
            const target = selectedFiles[0] ?? entry.file;
            menu.addItem(it => it.setTitle(`Move → ${label}`).onClick(async () => {
              await this.applyFrontmatterProperty(target, propName, val);
              await this.applyNotebookNavigatorRulesToFile(target);
              this.render();
            }));
          }
        }
      }
      menu.showAtPosition({ x: e.clientX, y: e.clientY });
    });

    // Drag-onto-card: make dragged card a subitem of this card
    // Only available for real (non-virtual-task) cards that have a known parent key.
    if (!isVirtualTask) {
      cardEl.addEventListener('dragover', (e: DragEvent) => {
        if (!e.dataTransfer) return;
        if (!e.dataTransfer.types.includes('application/x-kanban-entry')) return;
        const draggedPath = e.dataTransfer.getData('application/x-kanban-entry');
        // Can't nest onto itself, and skip if dragged path not yet available (security restriction)
        if (draggedPath === entry.file.path) return;
        // Don't allow nesting virtual tasks
        if (e.dataTransfer.types.includes('application/x-kanban-virtual-task')) return;
        e.preventDefault();
        e.stopPropagation(); // don't also highlight the lane cardsWrap
        e.dataTransfer.dropEffect = 'move';
        cardEl.addClass('tps-kanban-card--drop-nest');
      });

      cardEl.addEventListener('dragleave', (e: DragEvent) => {
        // Only clear if we're leaving the card entirely (not entering a child element)
        if (!cardEl.contains(e.relatedTarget as Node)) {
          cardEl.removeClass('tps-kanban-card--drop-nest');
        }
      });

      cardEl.addEventListener('drop', async (e: DragEvent) => {
        cardEl.removeClass('tps-kanban-card--drop-nest');
        if (!e.dataTransfer) return;
        if (!e.dataTransfer.types.includes('application/x-kanban-entry')) return;
        if (e.dataTransfer.types.includes('application/x-kanban-virtual-task')) return;
        const draggedPath = e.dataTransfer.getData('application/x-kanban-entry');
        if (!draggedPath || draggedPath === entry.file.path) return;
        e.preventDefault();
        e.stopPropagation();

        const draggedFile = this.app.vault.getFileByPath(draggedPath);
        if (!draggedFile) return;

        // Circular-parent guard: disallow if target is already a descendant of dragged
        if (this.isDescendantOf(entry.file.path, draggedPath)) return;

        // Determine the parent key to write (prefer GCM-configured, else 'parent')
        const parentKeys = this.getParentLinkKeys();
        const parentKey = parentKeys[0] ?? 'parent';

        const existingParentPath = this.resolveParentPath(draggedFile);
        
        if (existingParentPath === entry.file.path) {
          // Already a child of this card — toggle off (remove parent link)
          await this.app.fileManager.processFrontMatter(draggedFile, (fm) => {
            const actualKey = this.findFrontmatterKeyCaseInsensitive(fm, parentKey);
            if (actualKey) delete fm[actualKey];
          });
        } else {
          // Generate the correct link format for this vault (respects shortest-path vs full-path settings)
          const linktext = this.app.metadataCache.fileToLinktext(entry.file, draggedFile.path, true);
          const linkValue = `[[${linktext}]]`;
          // Set as subitem of this card
          await this.app.fileManager.processFrontMatter(draggedFile, (fm) => {
            fm[parentKey] = linkValue;
          });
          // Auto-expand the target so the new child is immediately visible
          this.expandedSubtreePaths.add(entry.file.path);
        }
        this.render();
      });
    }

    return cardEl;
  }

  private render(): void {
    const renderVersion = ++this.renderVersion;
    this.applyLayoutSettings();
    this.ensureContainer();
    this.containerEl.empty();

    const propName = this.getGroupByPropName();
    const propId = this.getGroupByPropId(propName);
    const listGrouping = this.isLikelyListGroupingProperty(propName, propId);
    const sourceGroups: BasesEntryGroup[] = (listGrouping && propId)
      ? this.buildMultiValueGroups(propId)
      : (this.data?.groupedData ?? []);
    void this.renderAsync(sourceGroups, propName, renderVersion, propId);
  }

  private async renderAsync(
    sourceGroups: BasesEntryGroup[],
    propName: string | null,
    renderVersion: number,
    propId: string | null,
  ): Promise<void> {
    this.activeNotePath = this.getActiveMarkdownPath();
    try {
      let expandedSourceGroups = this.plugin.settings.enableKanbanTaskCards === false
        ? sourceGroups
        : await this.expandGroupEntriesWithKanbanTasks(sourceGroups);
      if (renderVersion !== this.renderVersion) return;
      if (
        this.plugin.settings.enableKanbanTaskCards !== false
        && !this.hasVirtualTaskEntries(expandedSourceGroups)
        && this.shouldUseScheduledTaskFallback()
      ) {
        const targetDate = this.getCurrentDayKey();
        if (targetDate) {
          const fallbackGroups = await this.buildScheduledTaskFallbackGroups(targetDate);
          if (fallbackGroups.length) {
            if (propId) {
              const fallbackEntries = fallbackGroups.flatMap((group) => group.entries);
              expandedSourceGroups = this.buildGroupsFromEntries(fallbackEntries, propId);
            } else {
              expandedSourceGroups = fallbackGroups;
            }
          }
        }
      }
      if (renderVersion !== this.renderVersion) return;
      if (propId) {
        const regroupedEntries = expandedSourceGroups.flatMap((group) => group.entries);
        expandedSourceGroups = this.buildGroupsFromEntries(regroupedEntries, propId);
      }
      if (renderVersion !== this.renderVersion) return;
      const allGroups = this.mergeGroupsByLaneId(expandedSourceGroups);

      // Separate keyed groups from the ungrouped lane, then reorder per settings
      const keyed = allGroups.filter((g) => this.getLaneId(g) !== 'ungrouped');
      const ungrouped = allGroups.filter((g) => this.getLaneId(g) === 'ungrouped');
      const forced = this.getForcedLanesFromFilters(propName);

      const keyedWithForced: BasesEntryGroup[] = [...keyed];
      const existingKeys = new Set(keyed.map((g) => String(g.key).trim().toLowerCase()));
      for (const forcedKey of forced.keys) {
        const normalized = forcedKey.trim().toLowerCase();
        if (!normalized || existingKeys.has(normalized)) continue;
        keyedWithForced.push(this.createSyntheticGroup(forcedKey));
        existingKeys.add(normalized);
      }

      const ungroupedWithForced = [...ungrouped];
      if (forced.includeUngrouped && ungroupedWithForced.length === 0) {
        ungroupedWithForced.push(this.createSyntheticGroup(null));
      }

      const ungroupedPos = this.plugin.settings.ungroupedPosition;
      let mergedGroups = ungroupedPos === 'first'
        ? [...ungroupedWithForced, ...keyedWithForced]
        : [...keyedWithForced, ...ungroupedWithForced];
      if (mergedGroups.length === 0) {
        const savedFallback = this.getSavedLaneFallbackGroups();
        mergedGroups = savedFallback.length > 0
          ? savedFallback
          : [this.createSyntheticGroup(null)];
      }
      const groups = this.applyManualLaneOrder(mergedGroups);
      const parentByChild = this.buildParentByChild(groups);
      const laneRenderItemsByLane = this.buildLaneRenderItemsByLane(groups, parentByChild);
      const displayLanes = this.buildDisplayLaneGroups(groups);
      const renderItemsByDisplayLane = new Map<string, LaneRenderItem[]>();
      for (const displayLane of displayLanes) {
        renderItemsByDisplayLane.set(
          displayLane.id,
          this.getRenderItemsForDisplayLane(displayLane, laneRenderItemsByLane),
        );
      }
      if (renderVersion !== this.renderVersion) return;

    this.renderedFileOrder = this.getOrderedVisiblePaths(displayLanes, renderItemsByDisplayLane);
      const visible = new Set(this.renderedFileOrder);
      this.selectedPaths = new Set(Array.from(this.selectedPaths).filter((p) => visible.has(p)));
      if (this.selectionAnchorPath && !visible.has(this.selectionAnchorPath)) this.selectionAnchorPath = null;

      const layoutMode = this.getEffectiveLayoutMode();
      const controls = this.containerEl.createDiv({ cls: 'tps-kanban-view-controls' });
      const layoutToggle = controls.createEl('button', {
        cls: 'tps-kanban-view-toggle',
        text: Platform.isMobile ? 'Mobile list' : (layoutMode === 'list' ? 'Switch to board' : 'Switch to list'),
      });
      layoutToggle.disabled = Platform.isMobile;
      layoutToggle.addEventListener('click', () => {
        if (Platform.isMobile) return;
        void this.toggleLayoutMode();
      });
      controls
        .createEl('button', {
          cls: 'tps-kanban-view-toggle',
          text: this.plugin.settings.dynamicEmptyLaneWidth ? 'Dynamic width: on' : 'Dynamic width: off',
        })
        .addEventListener('click', () => {
          void this.toggleDynamicEmptyLaneWidth();
        });

    const boardClasses = ['tps-kanban-board'];
    if (layoutMode === 'list') boardClasses.push('tps-kanban-board--list');
    if (this.shouldCompressEmptyLanes(displayLanes, renderItemsByDisplayLane)) {
      boardClasses.push('tps-kanban-board--dynamic-empty');
    }
    const board = this.containerEl.createEl('div', { cls: boardClasses.join(' ') });
    board.addEventListener('click', (e: MouseEvent) => {
      if (e.target === board || e.target === this.containerEl) this.clearSelection();
    });

    for (const displayLane of displayLanes) {
      const primaryGroup = displayLane.groups[0];
      const laneEl = board.createEl('div', { cls: 'tps-kanban-lane' });
      const laneId = this.getLaneId(primaryGroup);
      const renderItems = renderItemsByDisplayLane.get(displayLane.id) ?? [];
      laneEl.dataset.laneId = laneId;
      laneEl.classList.toggle('tps-kanban-lane--empty', renderItems.length === 0);

      // lane header: title + entry count badge
      const header = laneEl.createEl('div', { cls: 'tps-kanban-lane-header' });
      const dragHandle = header.createEl('button', {
        cls: 'tps-kanban-lane-handle',
        attr: { 'aria-label': 'Reorder lane', title: 'Drag to reorder lane' },
      });
      setIcon(dragHandle, 'grip-vertical');
      dragHandle.draggable = displayLane.groups.length === 1;
      if (displayLane.groups.length > 1) {
        dragHandle.classList.add('is-disabled');
      }
      dragHandle.addEventListener('dragstart', (e: DragEvent) => {
        if (displayLane.groups.length > 1) {
          e.preventDefault();
          return;
        }
        if (!e.dataTransfer) return;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-kanban-lane', laneId);
        board.addClass('tps-kanban-board--lane-drag');
      });
      dragHandle.addEventListener('dragend', () => {
        board.removeClass('tps-kanban-board--lane-drag');
        board.querySelectorAll('.tps-kanban-lane--drop-before, .tps-kanban-lane--drop-after').forEach((el) => {
          (el as HTMLElement).classList.remove('tps-kanban-lane--drop-before', 'tps-kanban-lane--drop-after');
        });
      });

      laneEl.addEventListener('dragover', (e: DragEvent) => {
        if (!e.dataTransfer) return;
        if (!Array.from(e.dataTransfer.types).includes('application/x-kanban-lane')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        laneEl.removeClass('tps-kanban-lane--drop-before');
        laneEl.removeClass('tps-kanban-lane--drop-after');
        const rect = laneEl.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (x < rect.width / 2) {
          laneEl.addClass('tps-kanban-lane--drop-before');
        } else {
          laneEl.addClass('tps-kanban-lane--drop-after');
        }
      });
      laneEl.addEventListener('dragleave', () => {
        laneEl.removeClass('tps-kanban-lane--drop-before');
        laneEl.removeClass('tps-kanban-lane--drop-after');
      });
      laneEl.addEventListener('drop', async (e: DragEvent) => {
        if (!e.dataTransfer) return;
        if (!Array.from(e.dataTransfer.types).includes('application/x-kanban-lane')) return;
        e.preventDefault();
        laneEl.removeClass('tps-kanban-lane--drop-before');
        laneEl.removeClass('tps-kanban-lane--drop-after');
        board.removeClass('tps-kanban-board--lane-drag');

        const draggedLaneId = e.dataTransfer.getData('application/x-kanban-lane');
        if (!draggedLaneId || draggedLaneId === laneId) return;
        const nextGroups = this.reorderGroups(groups, draggedLaneId, laneId);
        if (nextGroups === groups) return;
        await this.saveManualLaneOrder(nextGroups);
        this.render();
      });

      header.createEl('span', { text: displayLane.label, cls: 'tps-kanban-lane-title' });
      header.createEl('span', { text: String(renderItems.length), cls: 'tps-kanban-lane-count' });
      const labelEdit = header.createEl('button', {
        cls: 'tps-kanban-lane-label-edit',
        attr: { type: 'button', 'aria-label': 'Rename lane label', title: 'Rename column label' },
      });
      setIcon(labelEdit, 'pencil');
      if (displayLane.groups.length > 1) {
        labelEdit.classList.add('is-disabled');
      }
      labelEdit.addEventListener('pointerdown', (evt: PointerEvent) => {
        evt.preventDefault();
        evt.stopPropagation();
      });
      labelEdit.addEventListener('click', (evt) => {
        if (displayLane.groups.length > 1) return;
        evt.preventDefault();
        evt.stopPropagation();
        void this.renameLaneLabel(primaryGroup);
      });
      header.addEventListener('dblclick', (evt) => {
        if (displayLane.groups.length > 1) return;
        evt.preventDefault();
        evt.stopPropagation();
        void this.renameLaneLabel(primaryGroup);
      });

      const cardsWrap = laneEl.createEl('div', { cls: 'tps-kanban-cards' });

      // Whole-lane drop zone — dragging a card anywhere in the lane updates its
      // groupBy property in frontmatter. Card-level nesting still handles drops
      // on specific cards because those handlers stop propagation.
      if (propName) {
        const clearLaneDropTarget = () => {
          laneEl.removeClass('tps-kanban-lane-drop-target');
          cardsWrap.removeClass('tps-kanban-drop-target');
        };
        const applyLaneDrop = async (filePath: string) => {
          const targetSelection = await this.resolveDropValueForDisplayLane(displayLane);
          if (!targetSelection.selected) return;
          const targetValue = targetSelection.value;
          const virtualMeta = this.virtualTaskMetaByPath.get(filePath);
          if (virtualMeta) {
            if (this.isTagsPropId(propName)) {
              // Tag-based lane: update the inline #tag on the task line
              const laneTags = this.collectLaneTagSet(groups);
              const changed = await this.applyLaneTagToVirtualTask(virtualMeta, laneTags, targetValue);
              if (changed) this.render();
            } else {
              // Property-based lane (date, status, etc.): write back to task line
              const changed = await this.applyPropertyToVirtualTask(virtualMeta, propName, targetValue);
              if (changed) this.render();
            }
            return;
          }
          const file = this.app.vault.getFileByPath(filePath);
          if (!file) return;
          await this.applyFrontmatterProperty(file, propName, targetValue);
          await this.applyNotebookNavigatorRulesToFile(file);
          this.render();
        };
        laneEl.addEventListener('dragover', (e: DragEvent) => {
          if (!e.dataTransfer) return;
          if (!Array.from(e.dataTransfer.types).includes('application/x-kanban-entry')) return;
          if ((e.target as HTMLElement | null)?.closest('.tps-kanban-card')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          laneEl.addClass('tps-kanban-lane-drop-target');
          cardsWrap.addClass('tps-kanban-drop-target');
        });
        laneEl.addEventListener('dragleave', (e: DragEvent) => {
          const relatedTarget = e.relatedTarget as Node | null;
          if (relatedTarget && laneEl.contains(relatedTarget)) return;
          clearLaneDropTarget();
        });
        laneEl.addEventListener('drop', async (e: DragEvent) => {
          if (!e.dataTransfer) return;
          if (!Array.from(e.dataTransfer.types).includes('application/x-kanban-entry')) return;
          if ((e.target as HTMLElement | null)?.closest('.tps-kanban-card')) return;
          e.preventDefault();
          clearLaneDropTarget();
          const filePath = e.dataTransfer.getData('application/x-kanban-entry');
          if (!filePath) return;
          await applyLaneDrop(filePath);
        });
        cardsWrap.addEventListener('dragover', (e: DragEvent) => {
          if (!e.dataTransfer) return;
          if (!Array.from(e.dataTransfer.types).includes('application/x-kanban-entry')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          laneEl.addClass('tps-kanban-lane-drop-target');
          cardsWrap.addClass('tps-kanban-drop-target');
        });
        cardsWrap.addEventListener('dragleave', (e: DragEvent) => {
          const relatedTarget = e.relatedTarget as Node | null;
          if (relatedTarget && cardsWrap.contains(relatedTarget)) return;
          clearLaneDropTarget();
        });
        cardsWrap.addEventListener('drop', async (e: DragEvent) => {
          e.preventDefault();
          clearLaneDropTarget();
          if (!e.dataTransfer) return;
          const filePath = e.dataTransfer.getData('application/x-kanban-entry');
          if (!filePath) return;
          await applyLaneDrop(filePath);
        });
      }

      for (const item of renderItems) {
        const card = this.createEntryCard(item.entry, groups, propName, item, layoutMode);
        if (item.depth > 0) {
          card.addClass('tps-kanban-card--nested');
          card.style.setProperty('--tps-kanban-depth', String(Math.min(item.depth, 8)));
        }
        cardsWrap.appendChild(card);
      }

      // "Add card" creates a new note pre-populated with this lane's groupBy value
      laneEl.createEl('button', { text: '+ Add card', cls: 'tps-kanban-add-card' })
        .addEventListener('click', async () => {
          await this.handleAddCard(displayLane, propName);
        });
    }
      this.syncSelectionClasses();
    } catch (error) {
      console.error('TPS Kanban renderAsync failed', error);
      this.containerEl.createEl('div', { text: 'Kanban view failed to render.', cls: 'tps-kanban-debug-marker' });
    }
  }
}
