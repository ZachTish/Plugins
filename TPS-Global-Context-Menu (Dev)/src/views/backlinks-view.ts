import { ItemView, WorkspaceLeaf, TFile, setIcon, debounce } from 'obsidian';
import TPSGlobalContextMenuPlugin from '../main';
import {
  ReferenceData,
  ReferenceGroup,
  ReferenceOccurrence,
  MentionGroup,
} from '../menu/panel-builder';
import { addSafeClickListener } from '../menu/menu-controller';
import * as logger from '../logger';

export const BACKLINKS_VIEW_TYPE = 'tps-gcm-backlinks';

/** Stable fingerprint for a ReferenceData object so we can skip re-renders. */
function referenceDataFingerprint(data: ReferenceData): string {
  const encode = (groups: { file: TFile; occurrences: ReferenceOccurrence[] }[]): string =>
    groups
      .map(
        (g) =>
          `${g.file.path}:${g.occurrences.map((o) => `${o.lineNumber}|${o.previews[0] || ''}`).join(',')}`
      )
      .join(';');
  return `${encode(data.outgoing)}##${encode(data.incoming)}##${encode(data.mentions)}`;
}

export class BacklinksView extends ItemView {
  private plugin: TPSGlobalContextMenuPlugin;
  private currentFile: TFile | null = null;
  private bodyEl: HTMLElement;
  private headerFileEl: HTMLElement;
  private collapsedGroups = new Map<string, boolean>();

  /** Companion local-graph leaf (split below this backlinks panel) */
  private graphLeaf: WorkspaceLeaf | null = null;

  /** Cached data to avoid redundant DOM rebuilds */
  private cachedFingerprint = '';
  private cachedPanelBuilder: any = null;
  private cachedRootFile: TFile | null = null;
  private isRefreshing = false;

  /** Fast debounce for active-leaf-change (user switched files) */
  private debouncedFileChange = debounce(() => {
    void this.refreshView(true);
  }, 150, false);

  /** Slow debounce for metadata-resolved (background cache updates) */
  private debouncedMetadataRefresh = debounce(() => {
    void this.refreshView(false);
  }, 2000, false);

  constructor(leaf: WorkspaceLeaf, plugin: TPSGlobalContextMenuPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return BACKLINKS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Backlinks';
  }

  getIcon(): string {
    return 'links-coming-in';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('tps-gcm-backlinks-container');

    // Header showing current file
    const header = container.createDiv({ cls: 'tps-gcm-backlinks-header' });
    this.headerFileEl = header.createDiv({ cls: 'tps-gcm-backlinks-current-file' });
    this.headerFileEl.textContent = 'No file selected';

    // Body for rendering groups
    this.bodyEl = container.createDiv({ cls: 'tps-gcm-backlinks-body' });

    // Listen for file changes — fast debounce
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const active = this.app.workspace.getActiveFile();
        if (active && active.path !== this.currentFile?.path) {
          this.currentFile = active;
          this.collapsedGroups.clear();
          this.cachedFingerprint = '';
          this.debouncedFileChange();
        }
      })
    );

    // Metadata resolved — slow debounce to avoid constant re-renders
    this.registerEvent(
      this.app.metadataCache.on('resolved', () => {
        if (this.currentFile) {
          this.debouncedMetadataRefresh();
        }
      })
    );

    // Initial render for the currently active file
    const active = this.app.workspace.getActiveFile();
    if (active) {
      this.currentFile = active;
      void this.refreshView(true);
    }

    // Open companion local-graph leaf below this panel once the layout is ready.
    // Use onLayoutReady to ensure restored leaves are available before we check.
    if ((this.app.workspace as any).onLayoutReady) {
      (this.app.workspace as any).onLayoutReady(() => {
        void this.openCompanionGraph();
      });
    } else {
      setTimeout(() => void this.openCompanionGraph(), 800);
    }
  }

  async onClose(): Promise<void> {
    // Detach the companion graph leaf if it still exists
    this.detachCompanionGraph();

    this.bodyEl?.empty();
    this.cachedFingerprint = '';
    this.cachedPanelBuilder = null;
    this.cachedRootFile = null;
  }

  private async refreshView(force: boolean): Promise<void> {
    if (this.isRefreshing) return;

    if (!this.currentFile) {
      this.headerFileEl.textContent = 'No file selected';
      this.bodyEl.empty();
      this.cachedFingerprint = '';
      return;
    }

    const file = this.currentFile;
    this.headerFileEl.textContent = file.basename;
    this.headerFileEl.title = file.path;

    try {
      const panelBuilder = this.plugin.menuController.getPanelBuilder();
      if (!panelBuilder) {
        this.bodyEl.empty();
        this.bodyEl.createDiv({ cls: 'tps-gcm-backlinks-empty', text: 'Panel builder unavailable.' });
        this.cachedFingerprint = '';
        return;
      }

      this.isRefreshing = true;
      const data = await panelBuilder.collectReferenceGroups(file);
      this.isRefreshing = false;

      // If the file changed while we were collecting, discard this result
      if (this.currentFile?.path !== file.path) return;

      const fp = referenceDataFingerprint(data);
      if (!force && fp === this.cachedFingerprint) return; // data unchanged → skip re-render

      this.cachedFingerprint = fp;
      this.cachedPanelBuilder = panelBuilder;
      this.cachedRootFile = file;
      this.renderBody(data, file, panelBuilder);
    } catch (error) {
      this.isRefreshing = false;
      logger.error('[TPS GCM Backlinks] Failed to refresh:', error);
      this.bodyEl.empty();
      this.bodyEl.createDiv({ cls: 'tps-gcm-backlinks-empty', text: 'Error loading references.' });
      this.cachedFingerprint = '';
    }
  }

  private renderBody(
    data: ReferenceData,
    rootFile: TFile,
    panelBuilder: any
  ): void {
    this.bodyEl.empty();

    const totalCount = data.outgoing.length + data.incoming.length + data.mentions.length;
    if (totalCount === 0) {
      this.bodyEl.createDiv({ cls: 'tps-gcm-backlinks-empty', text: 'No references found.' });
      return;
    }

    // Collect ALL FM occurrences across every direction into one merged map.
    // This lets us render all body content first, then FM sections at the bottom.
    const fmByKey = new Map<string, Array<{ file: TFile; occ: ReferenceOccurrence }>>();
    const collectFM = (groups: Array<{ file: TFile; occurrences: ReferenceOccurrence[] }>) => {
      for (const group of groups) {
        for (const occ of group.occurrences) {
          if (!occ.frontmatterKey) continue;
          if (!fmByKey.has(occ.frontmatterKey)) fmByKey.set(occ.frontmatterKey, []);
          fmByKey.get(occ.frontmatterKey)!.push({ file: group.file, occ });
        }
      }
    };
    collectFM(data.outgoing);
    collectFM(data.incoming);
    collectFM(data.mentions);

    // Filter out any keys the user wants to ignore
    const ignoredKeys = new Set(
      (this.plugin.settings.ignoredBacklinksFrontmatterKeys || []).map((k: string) => k.toLowerCase())
    );
    for (const key of [...fmByKey.keys()]) {
      if (ignoredKeys.has(key.toLowerCase())) fmByKey.delete(key);
    }

    // Body sections — direction renderers skip FM occurrences entirely
    if (data.outgoing.length > 0) {
      this.renderDirection(this.bodyEl, 'Outgoing', data.outgoing, 'outgoing', rootFile, panelBuilder);
    }
    if (data.incoming.length > 0) {
      this.renderDirection(this.bodyEl, 'Incoming', data.incoming, 'incoming', rootFile, panelBuilder);
    }
    if (data.mentions.length > 0) {
      this.renderMentionsDirection(this.bodyEl, data.mentions, rootFile, panelBuilder);
    }

    // All FM key sections at the bottom
    if (fmByKey.size > 0) {
      const sectionKey = '§frontmatter';
      const isCollapsed = this.collapsedGroups.get(sectionKey) ?? false;
      const fmSection = this.bodyEl.createDiv({ cls: 'tps-gcm-bl-direction tps-gcm-bl-fm-direction' });
      const fmHeader = fmSection.createDiv({ cls: 'tps-gcm-bl-direction-header tps-gcm-bl-section-header' });
      const fmChevron = fmHeader.createDiv({ cls: 'tps-gcm-bl-chevron' });
      setIcon(fmChevron, isCollapsed ? 'chevron-right' : 'chevron-down');
      fmHeader.createDiv({ cls: 'tps-gcm-bl-direction-title', text: 'Frontmatter' });
      fmHeader.createDiv({ cls: 'tps-gcm-bl-direction-count', text: String(fmByKey.size) });
      const fmBody = fmSection.createDiv({ cls: 'tps-gcm-bl-section-body' });
      if (isCollapsed) fmBody.style.display = 'none';
      this.renderFrontmatterKeySections(fmBody, fmByKey, panelBuilder);
      const toggleFm = () => {
        const nowCollapsed = !this.collapsedGroups.get(sectionKey);
        this.collapsedGroups.set(sectionKey, nowCollapsed);
        fmBody.style.display = nowCollapsed ? 'none' : '';
        setIcon(fmChevron, nowCollapsed ? 'chevron-right' : 'chevron-down');
      };
      fmHeader.addEventListener('click', toggleFm);
    }
  }

  // ─── Direction sections ───────────────────────────────────────────────

  private renderDirection(
    parent: HTMLElement,
    label: string,
    groups: ReferenceGroup[],
    mode: 'outgoing' | 'incoming',
    rootFile: TFile,
    panelBuilder: any
  ): void {
    // Only render groups that have at least one body (non-FM) occurrence
    const bodyGroups = groups
      .map(g => ({ ...g, occurrences: g.occurrences.filter(o => !o.frontmatterKey) }))
      .filter(g => g.occurrences.length > 0);

    if (bodyGroups.length === 0) return; // nothing to show — FM handled globally

    const sectionKey = `§${label.toLowerCase()}`;
    const isCollapsed = this.collapsedGroups.get(sectionKey) ?? false;

    const section = parent.createDiv({ cls: 'tps-gcm-bl-direction' });
    const dirHeader = section.createDiv({ cls: 'tps-gcm-bl-direction-header tps-gcm-bl-section-header' });
    const dirChevron = dirHeader.createDiv({ cls: 'tps-gcm-bl-chevron' });
    setIcon(dirChevron, isCollapsed ? 'chevron-right' : 'chevron-down');
    dirHeader.createDiv({ cls: 'tps-gcm-bl-direction-title', text: label });
    dirHeader.createDiv({ cls: 'tps-gcm-bl-direction-count', text: String(bodyGroups.length) });

    const sectionBody = section.createDiv({ cls: 'tps-gcm-bl-section-body' });
    if (isCollapsed) sectionBody.style.display = 'none';

    bodyGroups.forEach((group) => {
      if (mode === 'outgoing') {
        this.renderOutgoingGroup(sectionBody, group, panelBuilder);
      } else {
        this.renderIncomingGroup(sectionBody, group, rootFile, panelBuilder);
      }
    });

    const toggleSection = () => {
      const nowCollapsed = !this.collapsedGroups.get(sectionKey);
      this.collapsedGroups.set(sectionKey, nowCollapsed);
      sectionBody.style.display = nowCollapsed ? 'none' : '';
      setIcon(dirChevron, nowCollapsed ? 'chevron-right' : 'chevron-down');
    };
    dirHeader.addEventListener('click', toggleSection);
  }

  private renderMentionsDirection(
    parent: HTMLElement,
    groups: MentionGroup[],
    rootFile: TFile,
    panelBuilder: any
  ): void {
    const bodyGroups = groups
      .map(g => ({ ...g, occurrences: g.occurrences.filter(o => !o.frontmatterKey) }))
      .filter(g => g.occurrences.length > 0);

    if (bodyGroups.length === 0) return;

    const sectionKey = '§mentions';
    const isCollapsed = this.collapsedGroups.get(sectionKey) ?? false;

    const section = parent.createDiv({ cls: 'tps-gcm-bl-direction' });
    const dirHeader = section.createDiv({ cls: 'tps-gcm-bl-direction-header tps-gcm-bl-section-header' });
    const dirChevron = dirHeader.createDiv({ cls: 'tps-gcm-bl-chevron' });
    setIcon(dirChevron, isCollapsed ? 'chevron-right' : 'chevron-down');
    dirHeader.createDiv({ cls: 'tps-gcm-bl-direction-title', text: 'Mentions' });
    dirHeader.createDiv({ cls: 'tps-gcm-bl-direction-count', text: String(bodyGroups.length) });

    const sectionBody = section.createDiv({ cls: 'tps-gcm-bl-section-body' });
    if (isCollapsed) sectionBody.style.display = 'none';

    bodyGroups.forEach((group) => {
      this.renderMentionGroup(sectionBody, group, rootFile, panelBuilder);
    });

    const toggleSection = () => {
      const nowCollapsed = !this.collapsedGroups.get(sectionKey);
      this.collapsedGroups.set(sectionKey, nowCollapsed);
      sectionBody.style.display = nowCollapsed ? 'none' : '';
      setIcon(dirChevron, nowCollapsed ? 'chevron-right' : 'chevron-down');
    };
    dirHeader.addEventListener('click', toggleSection);
  }

  // ─── Outgoing groups (simple list — just filename + open) ─────────────

  private renderOutgoingGroup(parent: HTMLElement, group: ReferenceGroup, panelBuilder: any): void {
    const groupKey = `out-${group.file.path}`;
    const isCollapsed = this.collapsedGroups.get(groupKey) ?? false;

    const wrap = parent.createDiv({ cls: 'tps-gcm-bl-group' });

    const header = wrap.createDiv({ cls: 'tps-gcm-bl-group-header' });

    // Collapse chevron
    const chevron = header.createDiv({ cls: 'tps-gcm-bl-chevron' });
    setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');

    const titleLink = header.createEl('a', {
      cls: 'tps-gcm-bl-group-title',
      text: this.getFileDisplayTitle(group.file),
      attr: { title: group.file.path },
    });
    this.attachHoverPreview(titleLink, group.file);

    header.createEl('span', {
      cls: 'tps-gcm-bl-count',
      text: `${group.occurrences.length}`,
    });

    // Open note button
    const openBtn = header.createEl('button', {
      cls: 'tps-gcm-bl-open-btn',
      attr: { type: 'button', 'aria-label': 'Open note' },
    });
    setIcon(openBtn, 'external-link');
    addSafeClickListener(openBtn, () => {
      void this.plugin.openFileInLeaf(group.file, false, () => this.app.workspace.getLeaf(false), { revealLeaf: true });
    });

    // Occurrences body (collapsible)
    const occurrencesWrap = wrap.createDiv({ cls: 'tps-gcm-bl-occurrences' });
    if (isCollapsed) {
      occurrencesWrap.style.display = 'none';
    }

    const bodyOccs = group.occurrences.filter(o => !o.frontmatterKey);
    bodyOccs.forEach(occ => this.renderOccurrenceRow(occurrencesWrap, occ, 'outgoing', null, panelBuilder));

    // Toggle collapse on title or chevron click
    const toggleCollapse = () => {
      const nowCollapsed = !this.collapsedGroups.get(groupKey);
      this.collapsedGroups.set(groupKey, nowCollapsed);
      occurrencesWrap.style.display = nowCollapsed ? 'none' : '';
      setIcon(chevron, nowCollapsed ? 'chevron-right' : 'chevron-down');
    };

    titleLink.addEventListener('click', (e) => { e.preventDefault(); toggleCollapse(); });
    addSafeClickListener(chevron, toggleCollapse);
  }

  // ─── Incoming groups ──────────────────────────────────────────────────

  private renderIncomingGroup(parent: HTMLElement, group: ReferenceGroup, rootFile: TFile, panelBuilder: any): void {
    const groupKey = `in-${group.file.path}`;
    const isCollapsed = this.collapsedGroups.get(groupKey) ?? false;

    const wrap = parent.createDiv({ cls: 'tps-gcm-bl-group' });
    const header = wrap.createDiv({ cls: 'tps-gcm-bl-group-header' });

    const chevron = header.createDiv({ cls: 'tps-gcm-bl-chevron' });
    setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');

    const titleLink = header.createEl('a', {
      cls: 'tps-gcm-bl-group-title',
      text: this.getFileDisplayTitle(group.file),
      attr: { title: group.file.path },
    });
    this.attachHoverPreview(titleLink, group.file);

    header.createEl('span', {
      cls: 'tps-gcm-bl-count',
      text: `${group.occurrences.length}`,
    });

    const openBtn = header.createEl('button', {
      cls: 'tps-gcm-bl-open-btn',
      attr: { type: 'button', 'aria-label': 'Open note' },
    });
    setIcon(openBtn, 'external-link');
    addSafeClickListener(openBtn, () => {
      void panelBuilder.openReferenceOccurrence(group.file, group.occurrences[0]);
    });

    const occurrencesWrap = wrap.createDiv({ cls: 'tps-gcm-bl-occurrences' });
    if (isCollapsed) {
      occurrencesWrap.style.display = 'none';
    }

    const bodyOccs = group.occurrences.filter(o => !o.frontmatterKey);
    bodyOccs.forEach(occ => this.renderOccurrenceRow(occurrencesWrap, occ, 'incoming', rootFile, panelBuilder));

    const toggleCollapse = () => {
      const nowCollapsed = !this.collapsedGroups.get(groupKey);
      this.collapsedGroups.set(groupKey, nowCollapsed);
      occurrencesWrap.style.display = nowCollapsed ? 'none' : '';
      setIcon(chevron, nowCollapsed ? 'chevron-right' : 'chevron-down');
    };

    titleLink.addEventListener('click', (e) => { e.preventDefault(); toggleCollapse(); });
    addSafeClickListener(chevron, toggleCollapse);
  }

  // ─── Mention groups ───────────────────────────────────────────────────

  private renderMentionGroup(
    parent: HTMLElement,
    group: MentionGroup,
    rootFile: TFile,
    panelBuilder: any
  ): void {
    const groupKey = `mention-${group.file.path}`;
    const isCollapsed = this.collapsedGroups.get(groupKey) ?? false;

    const wrap = parent.createDiv({ cls: 'tps-gcm-bl-group' });
    const header = wrap.createDiv({ cls: 'tps-gcm-bl-group-header' });

    const chevron = header.createDiv({ cls: 'tps-gcm-bl-chevron' });
    setIcon(chevron, isCollapsed ? 'chevron-right' : 'chevron-down');

    const titleLink = header.createEl('a', {
      cls: 'tps-gcm-bl-group-title',
      text: this.getFileDisplayTitle(group.file),
      attr: { title: group.file.path },
    });
    this.attachHoverPreview(titleLink, group.file);

    header.createEl('span', {
      cls: 'tps-gcm-bl-count',
      text: `${group.occurrences.length}`,
    });

    const openBtn = header.createEl('button', {
      cls: 'tps-gcm-bl-open-btn',
      attr: { type: 'button', 'aria-label': 'Open note' },
    });
    setIcon(openBtn, 'external-link');
    addSafeClickListener(openBtn, () => {
      void panelBuilder.openReferenceOccurrence(group.file, group.occurrences[0]);
    });

    const occurrencesWrap = wrap.createDiv({ cls: 'tps-gcm-bl-occurrences' });
    if (isCollapsed) {
      occurrencesWrap.style.display = 'none';
    }

    const bodyOccs = group.occurrences.filter(o => !o.frontmatterKey);
    bodyOccs.forEach(occ => this.renderMentionOccurrenceRow(occurrencesWrap, occ, rootFile, panelBuilder));

    const toggleCollapse = () => {
      const nowCollapsed = !this.collapsedGroups.get(groupKey);
      this.collapsedGroups.set(groupKey, nowCollapsed);
      occurrencesWrap.style.display = nowCollapsed ? 'none' : '';
      setIcon(chevron, nowCollapsed ? 'chevron-right' : 'chevron-down');
    };

    titleLink.addEventListener('click', (e) => { e.preventDefault(); toggleCollapse(); });
    addSafeClickListener(chevron, toggleCollapse);
  }

  // ─── Occurrence rows ──────────────────────────────────────────────────

  /**
   * Render FM key sections at the direction level.
   * One section per unique frontmatterKey; each section lists the source files
   * that reference the current note via that key as clickable chips.
   */
  private renderFrontmatterKeySections(
    parent: HTMLElement,
    fmByKey: Map<string, Array<{ file: TFile; occ: ReferenceOccurrence }>>,
    panelBuilder: any
  ): void {
    for (const [key, entries] of fmByKey) {
      const section = parent.createDiv({ cls: 'tps-gcm-bl-fm-section' });

      // Key title
      section.createDiv({ cls: 'tps-gcm-bl-fm-section-key', text: key });

      // File chips
      const chips = section.createDiv({ cls: 'tps-gcm-bl-fm-chips' });
      for (const { file, occ } of entries) {
        const chip = chips.createEl('a', {
          cls: 'tps-gcm-bl-fm-chip',
          text: this.getFileDisplayTitle(file),
          attr: { title: file.path },
        });
        this.attachHoverPreview(chip, file);
        addSafeClickListener(chip, () => panelBuilder.openReferenceOccurrence(occ.sourceFile, occ));
      }
    }
  }

  /** @deprecated replaced by renderFrontmatterKeySections — kept so callers don't break at compile time */
  private renderFrontmatterKeyRows(
    _parent: HTMLElement,
    _occurrences: ReferenceOccurrence[],
    _onOpen: (occ: ReferenceOccurrence) => void
  ): void { /* no-op */ }

  private renderOccurrenceRow(
    parent: HTMLElement,
    occurrence: ReferenceOccurrence,
    mode: 'incoming' | 'outgoing',
    rootFile: TFile | null,
    panelBuilder: any
  ): void {
    const row = parent.createDiv({ cls: 'tps-gcm-bl-occurrence' });

    const meta = row.createDiv({ cls: 'tps-gcm-bl-occurrence-meta' });
    meta.textContent = occurrence.heading
      ? `${occurrence.heading} · line ${occurrence.lineNumber + 1}`
      : `line ${occurrence.lineNumber + 1}`;

    const preview = row.createDiv({ cls: 'tps-gcm-bl-occurrence-preview' });
    let previewIndex = 0;
    this.setPreviewHighlighted(preview, occurrence.previews[previewIndex] || '', occurrence, rootFile);

    const actions = row.createDiv({ cls: 'tps-gcm-bl-occurrence-actions' });

    if (occurrence.previews.length > 1) {
      const moreBtn = this.createActionButton('More', () => {
        previewIndex = previewIndex < occurrence.previews.length - 1 ? previewIndex + 1 : 0;
        this.setPreviewHighlighted(preview, occurrence.previews[previewIndex] || '', occurrence, rootFile);
        moreBtn.textContent = previewIndex < occurrence.previews.length - 1 ? 'More' : 'Less';
      });
      actions.appendChild(moreBtn);
    }

    const openBtn = this.createActionButton('Open', () => {
      void panelBuilder.openReferenceOccurrence(occurrence.sourceFile, occurrence);
    });
    actions.appendChild(openBtn);
  }

  private renderMentionOccurrenceRow(
    parent: HTMLElement,
    occurrence: ReferenceOccurrence,
    rootFile: TFile,
    panelBuilder: any
  ): void {
    const row = parent.createDiv({ cls: 'tps-gcm-bl-occurrence' });

    const meta = row.createDiv({ cls: 'tps-gcm-bl-occurrence-meta' });
    meta.textContent = occurrence.frontmatterKey
      ? occurrence.frontmatterKey
      : occurrence.heading
        ? `${occurrence.heading} · line ${occurrence.lineNumber + 1}`
        : `line ${occurrence.lineNumber + 1}`;

    const preview = row.createDiv({ cls: 'tps-gcm-bl-occurrence-preview' });
    let previewIndex = 0;
    this.setPreviewHighlighted(preview, occurrence.previews[previewIndex] || '', occurrence, rootFile);

    const actions = row.createDiv({ cls: 'tps-gcm-bl-occurrence-actions' });

    // Link button (convert mention → linked reference)
    const linkBtn = this.createActionButton('Link', () => {
      void panelBuilder.convertMentionToLinkedReference(rootFile, occurrence, row);
    });
    actions.appendChild(linkBtn);

    if (occurrence.previews.length > 1) {
      const moreBtn = this.createActionButton('More', () => {
        previewIndex = previewIndex < occurrence.previews.length - 1 ? previewIndex + 1 : 0;
        this.setPreviewHighlighted(preview, occurrence.previews[previewIndex] || '', occurrence, rootFile);
        moreBtn.textContent = previewIndex < occurrence.previews.length - 1 ? 'More' : 'Less';
      });
      actions.appendChild(moreBtn);
    }

    const openBtn = this.createActionButton('Open', () => {
      void panelBuilder.openReferenceOccurrence(occurrence.sourceFile, occurrence);
    });
    actions.appendChild(openBtn);
  }

  // ─── Companion local-graph ─────────────────────────────────────────────

  /**
   * Open Obsidian's native local-graph view as a companion leaf split
   * below this backlinks panel in the sidebar. The localgraph auto-tracks
   * the active file, so no manual state updates are needed.
   */
  private async openCompanionGraph(): Promise<void> {
    if (this.graphLeaf) return;

    try {
      // Check if a localgraph leaf already exists anywhere in the workspace
      // (e.g. restored from saved workspace layout after vault re-open).
      // Look in the same sidebar first (siblings), then anywhere.
      const existingLocalgraphLeaves = this.app.workspace.getLeavesOfType('localgraph');
      if (existingLocalgraphLeaves.length > 0) {
        // Prefer a sibling leaf in the same parent split
        const parentSplit = this.leaf.parent;
        const sibling = existingLocalgraphLeaves.find(l => l.parent === parentSplit);
        this.graphLeaf = (sibling || existingLocalgraphLeaves[0]) as WorkspaceLeaf;
        return;
      }

      // Split below this leaf (horizontal = stacked vertically)
      this.graphLeaf = this.app.workspace.createLeafBySplit(this.leaf, 'horizontal', false);
      await this.graphLeaf.setViewState({
        type: 'localgraph',
        active: false,
      });

      // If the user manually closes the graph leaf, null our reference
      this.registerEvent(
        this.app.workspace.on('layout-change', () => {
          if (this.graphLeaf) {
            // Check if the leaf is still attached to the workspace
            try {
              const viewType = this.graphLeaf.view?.getViewType();
              if (!viewType || viewType !== 'localgraph') {
                this.graphLeaf = null;
              }
            } catch {
              this.graphLeaf = null;
            }
          }
        })
      );
    } catch (e) {
      logger.error('[TPS GCM Backlinks] Failed to open companion graph:', e);
      this.graphLeaf = null;
    }
  }

  /** Safely detach the companion graph leaf. */
  private detachCompanionGraph(): void {
    if (this.graphLeaf) {
      try {
        this.graphLeaf.detach();
      } catch {
        // Leaf may already be detached
      }
      this.graphLeaf = null;
    }
  }

  // ─── Highlight helpers ────────────────────────────────────────────────

  /**
   * Render preview text into an element with highlighted link / mention matches.
   *
   * For linked references: highlights `[[wikilinks]]` and `[markdown](links)` that
   * point to the root file.
   *
   * For mentions: highlights the `matchedText` (case-insensitive).
   */
  private setPreviewHighlighted(
    el: HTMLElement,
    text: string,
    occurrence: ReferenceOccurrence,
    rootFile: TFile | null
  ): void {
    el.empty();

    if (!text) return;

    // Build a combined regex that matches any highlight-worthy span
    const patterns: string[] = [];

    // Mention text (unlinked)
    if (occurrence.matchedText) {
      patterns.push(occurrence.matchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }

    // Wikilinks [[target]] or [[target|alias]]
    // We match the raw wikilink syntax that may appear in the preview text
    patterns.push('\\[\\[[^\\]]+\\]\\]');

    // Markdown links [text](target)
    patterns.push('\\[[^\\]]*\\]\\([^)]+\\)');

    if (patterns.length === 0) {
      el.textContent = text;
      return;
    }

    const regex = new RegExp(`(${patterns.join('|')})`, 'gi');
    const parts = text.split(regex);

    for (const part of parts) {
      if (!part) continue;
      if (regex.test(part)) {
        // Reset lastIndex after test (global regex)
        regex.lastIndex = 0;
        const mark = el.createSpan({ cls: 'tps-gcm-bl-highlight' });
        // Render human-readable display text instead of raw syntax
        mark.textContent = this.linkDisplayText(part);
      } else {
        el.appendText(part);
      }
    }
  }

  /**
   * Extract the human-readable display text from a raw link token.
   * For wikilinks, resolves the target file and uses its frontmatter `title`
   * (falling back to the file's basename).
   *   [[Note]]           → frontmatter title or "Note"
   *   [[Note|Alias]]     → "Alias" (user-explicit override)
   *   [[Note#Heading]]   → title › Heading
   *   [text](url)        → "text"
   *   anything else      → unchanged
   */
  private linkDisplayText(raw: string): string {
    const sourcePath = this.currentFile?.path ?? '';
    // Wikilink: [[target]] or [[target|alias]]
    const wikiMatch = raw.match(/^\[\[([^\]]+)\]\]$/);
    if (wikiMatch) {
      const inner = wikiMatch[1];
      // [[target|alias]] → alias (explicit user override — keep as-is)
      if (inner.includes('|')) return inner.split('|')[1].trim();
      // Split off heading anchor
      const [linkpart, heading] = inner.split('#', 2);
      // Try to resolve to a file and use its frontmatter title
      const target = this.app.metadataCache.getFirstLinkpathDest(linkpart.trim(), sourcePath);
      let displayName: string;
      if (target) {
        const fm = this.app.metadataCache.getFileCache(target)?.frontmatter;
        const fmTitle = typeof fm?.title === 'string' ? fm.title.trim() : '';
        displayName = fmTitle || target.basename;
      } else {
        // Unresolvable link — strip path and .md
        displayName = linkpart.split('/').pop()?.replace(/\.md$/i, '') ?? linkpart;
      }
      return heading ? `${displayName} › ${heading}` : displayName;
    }
    // Markdown link: [text](url) → text
    const mdMatch = raw.match(/^\[([^\]]*)\]\([^)]+\)$/);
    if (mdMatch) return mdMatch[1] || raw;
    return raw;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /** Returns the frontmatter `title` for a file, falling back to its basename. */
  private getFileDisplayTitle(file: TFile): string {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const fmTitle = typeof fm?.title === 'string' ? fm.title.trim() : '';
    return fmTitle || file.basename;
  }

  /** Attach Obsidian's hover-link preview to an element linking to a given file. */
  private attachHoverPreview(el: HTMLElement, file: TFile): void {
    el.addEventListener('mouseover', (e: MouseEvent) => {
      this.app.workspace.trigger('hover-link', {
        event: e,
        source: BACKLINKS_VIEW_TYPE,
        hoverParent: this,
        targetEl: el,
        linktext: file.path,
        sourcePath: this.currentFile?.path ?? '',
      });
    });
  }

  private createActionButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tps-gcm-bl-action';
    button.textContent = label;
    addSafeClickListener(button, onClick);
    return button;
  }
}
