
import { BasesView, QueryController, Menu, BasesEntry, BasesEntryGroup, setIcon, TFile, debounce, normalizePath, Modal, Setting, getAllTags } from 'obsidian';

export const KANBAN_VIEW_TYPE = 'tps-kanban';

type LaneRenderItem = {
  entry: BasesEntry;
  depth: number;
  hasChildren: boolean;
  childCount: number;
};

type VirtualKanbanTaskMeta = {
  parentPath: string;
  lineNumber: number;
  tags: string[];
};

type DisplayLaneGroup = {
  id: string;
  label: string;
  groups: BasesEntryGroup[];
  laneIds: string[];
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
    this.syncNativeResultsCountSoon();
  }

  private ensureContainer(): void {
    if (this.containerEl && this.containerEl.parentElement === this.scrollEl) return;
    this.containerEl = this.scrollEl.createDiv({ cls: 'tps-kanban-container' });
    this.applyLayoutSettings();
  }

  private syncNativeResultsCountSoon(): void {
    this.syncNativeResultsCount();
    window.setTimeout(() => this.syncNativeResultsCount(), 0);
    window.setTimeout(() => this.syncNativeResultsCount(), 180);
  }

  private syncNativeResultsCount(): void {
    const header = this.getNearestBasesHeader();
    if (!header) return;
    const resultCount = this.getUnderlyingResultCount();
    const text = `${resultCount} result${resultCount === 1 ? '' : 's'}`;
    const countEl =
      header.querySelector<HTMLElement>('.view-header-count') ??
      header.querySelector<HTMLElement>('.bases-view-results-count') ??
      header.querySelector<HTMLElement>('.bases-results-count') ??
      header.querySelector<HTMLElement>('.bases-view-result-count') ??
      header.querySelector<HTMLElement>('.bases-result-count') ??
      header.querySelector<HTMLElement>('[class*="results-count"]') ??
      header.querySelector<HTMLElement>('[class*="result-count"]') ??
      header.querySelector<HTMLElement>('.bases-view-results') ??
      header.querySelector<HTMLElement>('.bases-results');
    if (countEl && countEl.textContent?.trim() !== text) {
      countEl.textContent = text;
    }
  }

  private getUnderlyingResultCount(): number {
    const dataRows = (this.data as any)?.data;
    if (Array.isArray(dataRows)) return dataRows.length;
    const unique = new Set<string>();
    const groups: BasesEntryGroup[] = this.data?.groupedData ?? [];
    for (const group of groups) {
      for (const entry of group.entries) unique.add(entry.file.path);
    }
    return unique.size;
  }

  private getNearestBasesHeader(): HTMLElement | null {
    const selectors = '.bases-view-header, .base-view-header, .bases-toolbar, .bases-header, .view-header';
    const embedRoot = this.containerEl.closest(
      '.tps-auto-base-embed__panel, .block-language-bases, .cm-preview-code-block, .internal-embed, .markdown-embed, .cm-embed-block, .sync-embed, .sync-container',
    ) as HTMLElement | null;
    const searchRoot = embedRoot ?? (this.containerEl.closest('.workspace-leaf') as HTMLElement | null);
    if (!searchRoot) return null;
    const headers = Array.from(searchRoot.querySelectorAll<HTMLElement>(selectors));
    if (!headers.length) return null;
    const preceding = headers.filter((header) => {
      if (header === this.containerEl) return false;
      const relation = header.compareDocumentPosition(this.containerEl);
      return Boolean(relation & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    if (preceding.length > 0) return preceding[preceding.length - 1];
    return headers[headers.length - 1];
  }

  applyLayoutSettings(): void {
    const raw = Number(this.plugin?.settings?.scale ?? 1);
    const scale = Number.isFinite(raw) ? Math.max(0.7, Math.min(1.4, raw)) : 1;
    const layoutMode = this.getLayoutMode();
    this.containerEl?.style.setProperty('--tps-kanban-scale', String(scale));
    this.containerEl?.setAttr('data-kanban-view-id', this.getLaneOrderViewId());
    this.containerEl?.classList.toggle('tps-kanban-container--list', layoutMode === 'list');
    this.bindWheelHandler();
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
    if (this.getLayoutMode() !== 'board') return false;

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

  private async applyCompanionRulesToFile(file: TFile): Promise<void> {
    try {
      const companion = (this.app as any)?.plugins?.plugins?.['tps-notebook-navigator-companion'];
      const apply = companion?.api?.applyRulesToFile;
      if (typeof apply === 'function') {
        await apply(file);
      }
    } catch {
      // Ignore optional companion integration failures.
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
      if (verticalDelta !== 0) {
        const previous = laneCards.scrollTop;
        laneCards.scrollTop += verticalDelta;
        if (laneCards.scrollTop !== previous) event.preventDefault();
      }
      return;
    }

    if (this.getLayoutMode() === 'list') {
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

  private buildMultiValueGroups(propId: string): BasesEntryGroup[] {
    const entries: BasesEntry[] = this.data?.data ?? [];
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

  private stripKanbanDateTokens(text: string): string {
    return String(text || '')
      .replace(/@@\{[^}]*\}/g, '')
      .replace(/@\{[^}]*\}/g, '')
      // Also strip Tasks-plugin dataview inline properties (e.g. [scheduled:: 2026-03-17])
      .replace(/\[[a-zA-Z0-9_-]+::\s*[^\]]+\]/g, '')
      .trim();
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
    const taskMatch = line.match(/^([\t ]*-\s+\[[ xX]\]\s+)(.*)$/);
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
    await this.app.vault.modify(parentFile, lines.join('\n'));
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
    const taskMatch = line.match(/^([\t ]*-\s+\[[^\]]\]\s+)(.*)$/);
    if (!taskMatch) return false;

    const prefix = taskMatch[1];
    let body = taskMatch[2] ?? '';
    const propLower = propName.trim().toLowerCase();

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
        body = body.replace(propRe, `[${propName}:: ${targetValue}]`);
      }
    } else if (targetValue != null) {
      // Append before trailing Kanban tokens so they stay at the end
      const trailingMatch = body.match(/(\s+@@?\{[^}]*\})+$/);
      const trailing = trailingMatch?.[0] ?? '';
      const mainBody = trailing ? body.slice(0, -trailing.length) : body;
      body = `${mainBody.trimEnd()} [${propName}:: ${targetValue}]${trailing}`;
    }

    const newLine = `${prefix}${body}`.trimEnd();
    if (newLine === line) return false;
    lines[meta.lineNumber] = newLine;
    await this.app.vault.modify(parentFile, lines.join('\n'));
    return true;
  }

  private simplifyTaskText(raw: string): string {
    const text = this.stripKanbanDateTokens(raw);
    const mdLink = text.match(/^\[([^\]]+)\]\([^)]+\)$/);
    if (mdLink?.[1]) return mdLink[1].trim();
    return text;
  }

  private parseKanbanBoardTasks(content: string): Array<{ lineNumber: number; text: string; tags: string[] }> {
    const lines = content.split('\n');
    const tasks: Array<{ lineNumber: number; text: string; tags: string[] }> = [];
    const taskLine = /^[\t ]*-\s+\[([ xX])\]\s+(.*)$/;

    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(taskLine);
      if (!m) continue;
      const rawText = m[2];
      const text = this.simplifyTaskText(rawText);
      if (!text) continue;
      const tags = this.extractInlineTags(this.stripKanbanDateTokens(rawText));
      tasks.push({ lineNumber: i, text, tags });
    }

    return tasks;
  }

  private createVirtualTaskEntry(parentEntry: BasesEntry, task: { lineNumber: number; text: string; tags: string[] }): BasesEntry {
    const parentFile = parentEntry.file;
    const syntheticPath = `${parentFile.path}::kanban-task:${task.lineNumber}`;
    this.virtualTaskMetaByPath.set(syntheticPath, { parentPath: parentFile.path, lineNumber: task.lineNumber, tags: task.tags });

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
        if (this.isTagsPropId(propId)) return task.tags;
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
        if (!(file instanceof TFile) || !this.isKanbanBoardFile(file)) {
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
  ): HTMLElement {
    const cardEl = document.createElement('div');
    const virtualMeta = this.virtualTaskMetaByPath.get(entry.file.path);
    const isVirtualTask = !!virtualMeta;
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
    cardEl.title = entry.file.path;
    cardEl.draggable = true;
    cardEl.dataset.path = entry.file.path;
    if (this.selectedPaths.has(entry.file.path)) cardEl.classList.add('tps-kanban-card--selected');
    if (this.activeNotePath && entry.file.path === this.activeNotePath) {
      cardEl.classList.add('tps-kanban-card--open-note');
    }

    // Read icon and color from the note's frontmatter using configured keys
    const settings = this.plugin.settings;
    const fm = this.app.metadataCache.getFileCache(entry.file)?.frontmatter as Record<string, unknown> | undefined;
    const iconName = fm && settings.iconKey
      ? String(this.getFrontmatterValueCaseInsensitive(fm, settings.iconKey) ?? '').trim()
      : '';
    const resolvedIconName = iconName || this.resolveCompanionIconValue(entry.file, fm);
    const colorValue = fm && settings.colorKey
      ? String(this.getFrontmatterValueCaseInsensitive(fm, settings.colorKey) ?? '').trim()
      : '';
    const colorTarget = settings.frontmatterColorTarget || 'both';
    const applyColorToCard = colorTarget === 'card' || colorTarget === 'both';
    const applyColorToIcon = colorTarget === 'icon' || colorTarget === 'both';

    if (colorValue && applyColorToCard) {
      cardEl.style.setProperty('--tps-card-color', colorValue);
      cardEl.classList.add('tps-kanban-card--colored');
    }
    if (colorValue && applyColorToIcon) {
      cardEl.style.setProperty('--tps-card-icon-color', colorValue);
    }

    // Card inner: optional icon + title text
    const inner = cardEl.createDiv({ cls: 'tps-kanban-card-inner' });
    if (resolvedIconName) {
      const iconEl = inner.createDiv({ cls: 'tps-kanban-card-icon' });
      const bareIcon = this.normalizeLucideIconValue(resolvedIconName);
      setIcon(iconEl, bareIcon);
      // If setIcon couldn't find the icon it renders nothing — remove the empty div
      // so it doesn't add unwanted spacing.
      if (!iconEl.querySelector('svg')) iconEl.remove();
    }

    inner.createSpan({ text: entry.file.basename, cls: 'tps-kanban-card-title' });

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
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-kanban-entry', entry.file.path);
      if (isVirtualTask) e.dataTransfer.setData('application/x-kanban-virtual-task', '1');
      e.dataTransfer.setData('obsidian/file', entry.file.path);
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
        const menu = new Menu();
        menu.addItem((it) => it.setTitle('Open board note').onClick(async () => {
          const parent = this.app.vault.getFileByPath(virtualMeta.parentPath);
          if (parent) await this.app.workspace.getLeaf(false).openFile(parent);
        }));
        menu.showAtPosition({ x: e.clientX, y: e.clientY });
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
                await this.applyCompanionRulesToFile(file);
              }
              this.render();
            }));
          } else {
            const target = selectedFiles[0] ?? entry.file;
            menu.addItem(it => it.setTitle(`Move → ${label}`).onClick(async () => {
              await this.applyFrontmatterProperty(target, propName, val);
              await this.applyCompanionRulesToFile(target);
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
    this.applyLayoutSettings();
    this.ensureContainer();
    this.containerEl.empty();
    this.syncNativeResultsCountSoon();

    const propName = this.getGroupByPropName();
    const propId = this.getGroupByPropId(propName);
    const listGrouping = this.isLikelyListGroupingProperty(propName, propId);
    const sourceGroups: BasesEntryGroup[] = (listGrouping && propId)
      ? this.buildMultiValueGroups(propId)
      : (this.data?.groupedData ?? []);
    void this.renderAsync(sourceGroups, propName);
  }

  private async renderAsync(sourceGroups: BasesEntryGroup[], propName: string | null): Promise<void> {
    this.activeNotePath = this.getActiveMarkdownPath();
    const expandedSourceGroups = this.plugin.settings.enableKanbanTaskCards === false
      ? sourceGroups
      : await this.expandGroupEntriesWithKanbanTasks(sourceGroups);
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

    this.renderedFileOrder = this.getOrderedVisiblePaths(displayLanes, renderItemsByDisplayLane);
    const visible = new Set(this.renderedFileOrder);
    this.selectedPaths = new Set(Array.from(this.selectedPaths).filter((p) => visible.has(p)));
    if (this.selectionAnchorPath && !visible.has(this.selectionAnchorPath)) this.selectionAnchorPath = null;

    const layoutMode = this.getLayoutMode();
    const controls = this.containerEl.createDiv({ cls: 'tps-kanban-view-controls' });
    controls
      .createEl('button', {
        cls: 'tps-kanban-view-toggle',
        text: layoutMode === 'list' ? 'Switch to board' : 'Switch to list',
      })
      .addEventListener('click', () => {
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
          if (!e.dataTransfer) return;
          const filePath = e.dataTransfer.getData('application/x-kanban-entry');
          if (!filePath) return;
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
          await this.applyCompanionRulesToFile(file);
          this.render();
        });
      }

      for (const item of renderItems) {
        const card = this.createEntryCard(item.entry, groups, propName, item);
        if (item.depth > 0) {
          card.addClass('tps-kanban-card--nested');
          card.style.setProperty('--tps-kanban-depth', String(Math.min(item.depth, 8)));
        }
        cardsWrap.appendChild(card);
      }

      // "Add card" creates a new note pre-populated with this lane's groupBy value
      laneEl.createEl('button', { text: '+ Add card', cls: 'tps-kanban-add-card' })
        .addEventListener('click', async () => {
          const targetSelection = propName
            ? await this.resolveDropValueForDisplayLane(displayLane)
            : { selected: true, value: null as string | null };
          if (!targetSelection.selected) return;
          const targetValue = targetSelection.value;
          const proc = propName
            ? (fm: Record<string, unknown>) => {
              if (targetValue == null) {
                delete fm[propName];
              } else {
                fm[propName] = targetValue;
              }
            }
            : undefined;
          await this.createFileForView(undefined, proc);
        });
    }
    this.syncSelectionClasses();
    this.syncNativeResultsCountSoon();
  }
}
