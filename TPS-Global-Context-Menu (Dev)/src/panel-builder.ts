import { App, TFile, TFolder, Notice, Modal, Setting, setIcon, WorkspaceLeaf, normalizePath, Menu, FuzzySuggestModal, Platform, MarkdownView, getAllTags } from 'obsidian';
import TPSGlobalContextMenuPlugin from './main';
import { BuildPanelOptions } from './types';
import { SYSTEM_COMMANDS, STATUSES, PRIORITIES } from './constants';
import { PropertyRowService } from './property-row-service';
import { FileSuggestModal } from './FileSuggestModal';
import { MultiFileSelectModal } from './MultiFileSelectModal';
import { addSafeClickListener } from './menu-controller';
import { mergeNormalizedTags, normalizeTagValue, parseTagInput } from './tag-utils';
import { TextInputModal } from './text-input-modal';
import * as logger from './logger';
import { resolveCustomProperties } from './resolve-profiles';
import { ViewModeService } from './view-mode-service';
import { resolveLinkValueToFile } from './parent-link-format';

type SubitemRelationKind = 'child' | 'attachment';

interface SubitemRelationEntry {
  file: TFile;
  relations: Set<SubitemRelationKind>;
}

interface SubitemNode {
  file: TFile;
  relations: SubitemRelationKind[];
  children: SubitemNode[];
}

type ChecklistTaskState = ' ' | 'x' | 'X' | '?' | '-';

interface ChecklistSubitem {
  lineNumber: number;
  rawLine: string;
  prefix: string;
  state: ChecklistTaskState;
  text: string;
}

type ReferenceDirection = 'incoming' | 'outgoing';

interface ReferenceOccurrence {
  sourceFile: TFile;
  targetFile: TFile;
  lineNumber: number;
  heading: string;
  previews: string[];
  matchedText?: string;
}

interface ReferenceGroup {
  file: TFile;
  direction: ReferenceDirection;
  occurrences: ReferenceOccurrence[];
}

interface MentionGroup {
  file: TFile;
  occurrences: ReferenceOccurrence[];
}

const ATTACHMENTS_FRONTMATTER_KEY = 'attachments';
const MAX_SUBITEM_DEPTH = 8;
const SUBITEM_PANEL_REFRESH_DEBOUNCE_MS = 200;

export class PanelBuilder {
  private plugin: TPSGlobalContextMenuPlugin;
  private propertyRowService: PropertyRowService;
  private delegates: {
    createFileEntries: (files: TFile[]) => any[];
    openAddTagModal: (entries: any[], key?: string) => void;
    openScheduledModal: (entries: any[], key?: string) => void;
    openRecurrenceModalNative: (entries: any[]) => void;
    formatDatetimeDisplay: (value: string | null | undefined) => string;
  };
  private subitemPanelRefreshTimers: Map<string, number> = new Map();

  constructor(
    plugin: TPSGlobalContextMenuPlugin,
    propertyRowService: PropertyRowService,
    delegates: PanelBuilder['delegates']
  ) {
    this.plugin = plugin;
    this.propertyRowService = propertyRowService;
    this.delegates = delegates;
  }

  private get app(): App {
    return this.plugin.app;
  }

  // ... (View mode switching helpers retained) ...
  private async setViewModeForFile(file: TFile, mode: 'reading' | 'live' | 'source'): Promise<void> {
    let targetLeaf = this.app.workspace.getLeavesOfType('markdown')
      .find((leaf: any) => leaf?.view?.file?.path === file.path) || null;

    if (!targetLeaf) {
      const activeLeaf = this.app.workspace.activeLeaf as any;
      if (activeLeaf?.view?.getViewType?.() === 'markdown') {
        targetLeaf = activeLeaf;
      }
    }

    if (!targetLeaf) {
      targetLeaf = this.app.workspace.getLeaf(false) as any;
    }
    if (!targetLeaf) return;

    const currentFilePath = (targetLeaf.view as any)?.file?.path;
    if (currentFilePath !== file.path) {
      await this.plugin.openFileInLeaf(file, false, () => targetLeaf, { revealLeaf: false });
    }

    const view = targetLeaf.view as any;
    if (!view || view.getViewType?.() !== 'markdown') return;

    const state = { ...view.getState() };
    if (mode === 'reading') {
      state.mode = 'preview';
      delete state.source;
    } else if (mode === 'live') {
      state.mode = 'source';
      state.source = false;
    } else {
      state.mode = 'source';
      state.source = true;
    }

    await view.setState(state, { history: true });
    this.plugin.suppressViewModeSwitchForPathUntilFocusChange(file.path);
  }

  // ... (Archive helpers retained) ...
  private async ensureFolderPath(path: string): Promise<void> {
    const clean = normalizePath(path).trim();
    if (!clean) return;
    const segments = clean.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private getUniqueArchiveTargetPath(file: TFile, archiveFolder: string): string {
    const targetBase = normalizePath(`${archiveFolder}/${file.name}`);
    let targetPath = targetBase;
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(targetPath)) {
      targetPath = normalizePath(`${archiveFolder}/${file.basename} ${counter}.${file.extension}`);
      counter += 1;
    }
    return targetPath;
  }

  private buildRenameTargetPath(file: TFile, rawName: string): string | null {
    const trimmed = String(rawName || '').trim();
    if (!trimmed) return null;

    let baseName = trimmed.replace(/[\\/]/g, ' ').trim();
    if (!baseName) return null;

    if (file.extension) {
      const extSuffix = `.${file.extension.toLowerCase()}`;
      if (baseName.toLowerCase().endsWith(extSuffix)) {
        baseName = baseName.slice(0, -extSuffix.length).trim();
      }
    }
    if (!baseName) return null;

    const targetName = file.extension ? `${baseName}.${file.extension}` : baseName;
    const parentPath = file.parent?.path ?? '';
    return normalizePath(parentPath ? `${parentPath}/${targetName}` : targetName);
  }

  private async promptRenameFile(file: TFile): Promise<void> {
    const fileManager: any = this.app.fileManager as any;
    if (typeof fileManager?.promptForFileRename === 'function') {
      fileManager.promptForFileRename(file);
      return;
    }

    new TextInputModal(this.app, 'Name', file.basename, async (value) => {
      const targetPath = this.buildRenameTargetPath(file, value);
      if (!targetPath) {
        new Notice('Name cannot be empty.');
        return;
      }
      if (targetPath === file.path) return;
      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing) {
        new Notice('A file with that name already exists.');
        return;
      }
      try {
        await this.plugin.runQueuedMove([file], async () => {
          await this.app.fileManager.renameFile(file, targetPath);
        });
      } catch (error) {
        logger.error('[TPS GCM] Rename failed:', error);
        new Notice('Rename failed.');
      }
    }).open();
  }

  private async archiveEntries(entries: any[]): Promise<void> {
    const archiveTag = normalizeTagValue(this.plugin.settings.archiveTag || 'archive');
    const archiveFolder = this.plugin.getArchiveFolderPath();
    if (!archiveTag || !archiveFolder) {
      new Notice('Archive tag/folder settings are not configured.');
      return;
    }

    await this.ensureFolderPath(archiveFolder);

    const files = entries
      .map((entry: any) => entry?.file)
      .filter((candidate: unknown): candidate is TFile => candidate instanceof TFile);

    let archivedCount = 0;
    await this.plugin.runQueuedMove(files, async () => {
      for (const entry of entries) {
        const file = entry?.file as TFile;
        if (!(file instanceof TFile)) continue;

        if (file.extension?.toLowerCase() === 'md') {
          try {
            await this.app.fileManager.processFrontMatter(file, (frontmatter: any) => {
              frontmatter.tags = mergeNormalizedTags(frontmatter.tags, archiveTag);
            });
          } catch (err) {
            logger.error('[TPS GCM] Failed adding archive tag', file.path, err);
          }
        }

        if (file.path.startsWith(`${archiveFolder}/`)) {
          archivedCount += 1;
          continue;
        }

        try {
          const targetPath = this.getUniqueArchiveTargetPath(file, archiveFolder);
          await this.app.fileManager.renameFile(file, targetPath);
          archivedCount += 1;
        } catch (err) {
          logger.error('[TPS GCM] Failed moving archived file', file.path, err);
        }
      }
    });

    new Notice(archivedCount === 1 ? 'Archived 1 file' : `Archived ${archivedCount} files`);
  }

  // --- NEW 2-ROW LAYOUT ---

  buildSpecialPanel(files: TFile[], options: BuildPanelOptions = {}): HTMLElement {
    const entries = this.delegates.createFileEntries(files);
    const panel = document.createElement('div');
    panel.className = 'tps-gcm-panel';

    addSafeClickListener(panel, (e) => {
      // e.stopPropagation();
    });

    if (files.length > 1) {
      const banner = document.createElement('div');
      banner.className = 'tps-gcm-multi-banner';
      banner.textContent = `${files.length} items selected`;
      panel.appendChild(banner);
    }

    // Single row: chips (scrolling) + buttons (fixed right)
    const row = document.createElement('div');
    row.className = 'tps-gcm-unified-row';

    // 1. Context Strip (Horizontal Scroll: Chips)
    const contextStrip = this.createContextStrip(entries);
    row.appendChild(contextStrip);

    // 2. Action Toolbar (Compact: Tools + System Menu)
    const actionBar = this.createActionToolbar(entries);
    row.appendChild(actionBar);

    panel.appendChild(row);

    return panel;
  }

  /**
   * Creates the horizontal scrolling strip of property chips
   */
  createContextStrip(entries: any[]): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'tps-gcm-context-strip';

    strip.addEventListener('wheel', (e) => {
      if (e.deltaY === 0 || e.shiftKey) return;

      const canScrollLeft = strip.scrollLeft > 0;
      const canScrollRight = strip.scrollLeft < Math.ceil(strip.scrollWidth - strip.clientWidth);

      const scrollingLeft = e.deltaY < 0;
      const scrollingRight = e.deltaY > 0;

      if ((scrollingLeft && canScrollLeft) || (scrollingRight && canScrollRight)) {
        e.preventDefault();
        strip.scrollLeft += e.deltaY;
      }
    }, { passive: false });

    const properties = resolveCustomProperties(this.plugin.settings.properties || [], entries, new ViewModeService());

    // Status (if enabled)
    const statusProp = properties.find(p => p.id === 'status' || p.key === 'status');
    if (statusProp && statusProp.showInCollapsed !== false) {
      strip.appendChild(this.createStatusChip(entries, statusProp));
    }

    // Priority (if enabled)
    const priorityProp = properties.find(p => p.id === 'priority' || p.key === 'priority');
    if (priorityProp && priorityProp.showInCollapsed !== false) {
      strip.appendChild(this.createPriorityChip(entries, priorityProp));
    }

    // Date (if enabled)
    const dateProp = properties.find(p => p.type === 'datetime' || p.key === 'scheduled');
    if (dateProp && dateProp.showInCollapsed !== false) {
      strip.appendChild(this.createDateChip(entries, dateProp));
    }

    // Tags (if enabled)
    const tagsProp = properties.find(p => p.id === 'tags' || p.key === 'tags');
    if (tagsProp && tagsProp.showInCollapsed !== false) {
      // Add the "+" button first
      strip.appendChild(this.createTagsChip(entries, tagsProp));

      // Then add the tags
      const tags = this.extractNormalizedTags(entries);
      if (tags.length > 0) {
        tags.forEach((tag) => {
          strip.appendChild(this.createTagValueChip(tag, entries));
        });
      }
    }

    // Folder / Project (if enabled)
    const folderProp = properties.find(p => p.id === 'type' || p.type === 'folder');
    if (folderProp && folderProp.showInCollapsed !== false) {
      strip.appendChild(this.createFolderChip(entries));
    }

    return strip;
  }

  createStatusChip(entries: any[], resolvedProp: any): HTMLElement {
    const fm = entries[0].frontmatter;
    const statusRaw = fm.status;
    const currentStatus = typeof statusRaw === 'string' ? statusRaw.trim() : '';
    const hasStatus = !!currentStatus;

    const chip = document.createElement('div');
    chip.className = 'tps-gcm-chip';

    const icon = document.createElement('span');
    icon.className = 'tps-gcm-chip-icon';
    setIcon(icon, hasStatus ? this.getStatusIcon(currentStatus) : 'circle');
    chip.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tps-gcm-chip-label';
    label.textContent = hasStatus ? currentStatus : 'No Status';
    chip.appendChild(label);

    if (resolvedProp?.disabled) {
      chip.classList.add('tps-gcm-chip-disabled');
      chip.title = "Cannot edit mixed status profiles";
      return chip;
    }

    const options = resolvedProp?.options;

    addSafeClickListener(chip, (e) => {
      this.propertyRowService.openStatusSubmenu(chip, entries, (newVal) => {
        // Optimistic update
        label.textContent = newVal;
        setIcon(icon, this.getStatusIcon(newVal));
      }, options, async (files) => {
        // Apply companion rules to update icon after status change
        for (const file of files) {
          await this.applyCompanionRulesToFile(file);
        }
      });
    });

    return chip;
  }

  getStatusIcon(status: string): string {
    switch (status) {
      case 'complete': return 'circle-check';
      case 'working': return 'clock';
      case 'blocked': return 'circle-alert';
      case 'wont-do': return 'circle-x';
      default: return 'circle';
    }
  }

  createPriorityChip(entries: any[], resolvedProp: any): HTMLElement {
    const fm = entries[0].frontmatter;
    const priorityRaw = fm.priority;
    const currentPrio = typeof priorityRaw === 'string' ? priorityRaw.trim() : '';
    const hasPriority = !!currentPrio;

    const chip = document.createElement('div');
    chip.className = 'tps-gcm-chip';

    const icon = document.createElement('span');
    icon.className = 'tps-gcm-chip-icon';
    setIcon(icon, 'flag');
    chip.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tps-gcm-chip-label';
    label.textContent = hasPriority ? currentPrio : 'No Priority';
    chip.appendChild(label);

    if (resolvedProp?.disabled) {
      chip.classList.add('tps-gcm-chip-disabled');
      chip.title = "Cannot edit mixed priority profiles";
      return chip;
    }

    addSafeClickListener(chip, (e) => {
      this.propertyRowService.openPrioritySubmenu(chip, entries, (newVal) => {
        label.textContent = newVal;
      }, resolvedProp?.options);
    });

    return chip;
  }

  createDateChip(entries: any[], resolvedProp: any): HTMLElement {
    const fm = entries[0].frontmatter;
    const dateVal = fm.scheduled || fm.date || null;

    const chip = document.createElement('div');
    chip.className = 'tps-gcm-chip';

    const icon = document.createElement('span');
    icon.className = 'tps-gcm-chip-icon';
    setIcon(icon, 'calendar');
    chip.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tps-gcm-chip-label';
    label.textContent = dateVal ? this.delegates.formatDatetimeDisplay(dateVal) : 'No Date';
    chip.appendChild(label);

    if (resolvedProp?.disabled) {
      chip.classList.add('tps-gcm-chip-disabled');
      chip.title = "Cannot edit mixed date profiles";
      return chip;
    }

    addSafeClickListener(chip, (e) => {
      this.delegates.openScheduledModal(entries, 'scheduled');
    });

    return chip;
  }

  createTagsChip(entries: any[], resolvedProp: any): HTMLElement {
    const chip = document.createElement('div');
    chip.className = 'tps-gcm-chip';

    const icon = document.createElement('span');
    icon.className = 'tps-gcm-chip-icon';
    setIcon(icon, 'tag');
    chip.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tps-gcm-chip-label';
    label.textContent = 'Add Tag';
    chip.appendChild(label);

    if (resolvedProp?.disabled) {
      chip.classList.add('tps-gcm-chip-disabled');
      chip.title = "Cannot edit mixed tag profiles";
      return chip;
    }

    addSafeClickListener(chip, (e) => {
      this.delegates.openAddTagModal(entries);
    });

    return chip;
  }

  private extractNormalizedTags(entries: any[]): string[] {
    const entry = entries?.[0];
    const fm = (entry?.frontmatter || {}) as Record<string, any>;
    const fromFrontmatter = parseTagInput([fm.tags, fm.tag]);

    let fromMetadata: string[] = [];
    const file = entry?.file;
    if (file instanceof TFile) {
      const cache = this.app.metadataCache.getFileCache(file);
      const inlineTags = Array.isArray(cache?.tags)
        ? cache.tags.map((tag: any) => tag?.tag).filter((tag: any) => typeof tag === 'string' && tag.trim().length > 0)
        : [];
      fromMetadata = parseTagInput(inlineTags);
    }

    return Array.from(new Set([
      ...fromFrontmatter,
      ...fromMetadata,
    ].map((tag) => normalizeTagValue(tag)).filter(Boolean)));
  }

  private createTagValueChip(tag: string, entries: any[]): HTMLElement {
    const normalizedTag = normalizeTagValue(tag);
    const chip = document.createElement('div');
    chip.className = 'tps-gcm-chip tps-gcm-chip--tag-value';
    this.applyNotebookNavigatorTagStyle(chip, normalizedTag);

    const icon = document.createElement('span');
    icon.className = 'tps-gcm-chip-icon';
    setIcon(icon, 'tag');
    chip.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tps-gcm-chip-label';
    label.textContent = `#${normalizedTag}`;
    chip.appendChild(label);

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'tps-gcm-chip-tag-remove';
    removeButton.title = `Remove #${normalizedTag}`;
    removeButton.setAttribute('aria-label', `Remove #${normalizedTag}`);
    removeButton.style.color = 'currentColor';
    setIcon(removeButton, 'x');
    removeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!normalizedTag) return;
      void this.plugin.bulkEditService.removeTag(
        entries.map((entry: any) => entry.file),
        normalizedTag,
        'tags'
      );
      chip.remove();
    });
    chip.appendChild(removeButton);

    addSafeClickListener(chip, () => {
      if (!normalizedTag) return;
      this.plugin.menuController?.triggerTagSearch(normalizedTag);
    });

    return chip;
  }

  private applyNotebookNavigatorTagStyle(chip: HTMLElement, normalizedTag: string): void {
    const fallbackBackground = 'var(--nn-theme-file-tag-bg, var(--background-secondary-alt))';
    const fallbackText = 'var(--nn-theme-file-tag-color, var(--text-normal))';
    const fallbackBorder = 'var(--nn-theme-file-pill-border-color, var(--background-modifier-border))';

    chip.style.background = fallbackBackground;
    chip.style.color = fallbackText;
    chip.style.border = `1px solid ${fallbackBorder}`;

    if (!normalizedTag) return;

    const pluginApi: any = (this.app as any)?.plugins;
    const nn: any =
      pluginApi?.plugins?.['notebook-navigator'] ??
      pluginApi?.getPlugin?.('notebook-navigator');
    const settings = nn?.settings;
    if (!settings) return;

    const keyCandidates = Array.from(new Set([
      normalizedTag,
      normalizedTag.toLowerCase(),
      `#${normalizedTag}`,
      `#${normalizedTag.toLowerCase()}`,
    ]));

    const colorMap = (settings.tagColors && typeof settings.tagColors === 'object')
      ? settings.tagColors as Record<string, string>
      : {};
    const backgroundMap = (settings.tagBackgroundColors && typeof settings.tagBackgroundColors === 'object')
      ? settings.tagBackgroundColors as Record<string, string>
      : {};

    const customColor = keyCandidates.map((k) => String(colorMap[k] || '').trim()).find(Boolean) || '';
    const customBackground = keyCandidates.map((k) => String(backgroundMap[k] || '').trim()).find(Boolean) || '';

    if (customBackground) {
      chip.style.backgroundColor = 'var(--nn-theme-nav-bg, var(--background-primary))';
      chip.style.backgroundImage = `linear-gradient(${customBackground}, ${customBackground})`;
      if (!customColor) {
        chip.style.color = 'var(--nn-theme-file-tag-custom-color-text-color, var(--text-normal))';
      }
    }
    if (customColor) {
      chip.style.color = customColor;
      if (!customBackground) {
        chip.style.backgroundColor = 'var(--nn-theme-list-bg, var(--background-secondary))';
        chip.style.backgroundImage = 'linear-gradient(color-mix(in srgb, currentColor 10%, transparent), color-mix(in srgb, currentColor 10%, transparent))';
      }
    }
    if (customBackground || customColor) {
      chip.style.border = '1px solid color-mix(in srgb, currentColor 30%, transparent)';
    }
  }

  createFolderChip(entries: any[]): HTMLElement {
    const file = entries[0].file;
    const parentName = file.parent?.name || '/';

    const chip = document.createElement('div');
    chip.className = 'tps-gcm-chip';

    const icon = document.createElement('span');
    icon.className = 'tps-gcm-chip-icon';
    setIcon(icon, 'folder');
    chip.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tps-gcm-chip-label';
    label.textContent = parentName;
    chip.appendChild(label);

    addSafeClickListener(chip, (e) => {
      this.propertyRowService.openTypeSubmenu(chip, entries);
    });

    return chip;
  }

  /**
   * Creates the compact bottom bar with tools and system commands
   */
  createActionToolbar(entries: any[]): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'tps-gcm-action-bar';

    // SINGLE GROUP: System Menu (Three Dots) only - other actions nested inside
    const group = document.createElement('div');
    group.className = 'tps-gcm-action-group';

    const menuBtn = this.createIconButton('more-horizontal', 'Options', (e) => {
      this.showOptionsMenu(e, entries);
    });
    group.appendChild(menuBtn);

    bar.appendChild(group);

    return bar;
  }

  createIconButton(iconId: string, tooltip: string, onClick: (e: MouseEvent) => void): HTMLElement {
    const btn = document.createElement('button');
    btn.className = 'tps-gcm-icon-btn';
    btn.title = tooltip;
    setIcon(btn, iconId);
    addSafeClickListener(btn, onClick);
    return btn;
  }

  createSubitemsPanel(rootFile: TFile): HTMLElement {
    const section = document.createElement('div');
    section.className = 'tps-gcm-subitems-panel';

    // Collapse Handling
    const expandHandle = document.createElement('div');
    expandHandle.className = 'tps-gcm-expand-handle';
    expandHandle.title = 'Expand';
    const expandIcon = document.createElement('span');
    setIcon(expandIcon, 'chevron-up'); // Swapped to UP
    expandHandle.appendChild(expandIcon);

    // Add expand handle (will be hidden unless collapsed)
    section.appendChild(expandHandle);

    const collapseHandle = document.createElement('div');
    logger.log('[TPS GCM] Creating V2 Collapse Button');
    collapseHandle.className = 'tps-gcm-collapse-overlay-btn-v2';
    collapseHandle.title = 'Collapse';
    const collapseIcon = document.createElement('span');
    setIcon(collapseIcon, 'chevron-down'); // Swapped to DOWN
    collapseHandle.appendChild(collapseIcon);

    addSafeClickListener(collapseHandle, (e) => {
      e.stopPropagation();
      section.classList.add('tps-gcm-subitems-panel--collapsed');
      this.plugin.persistentMenuManager.setSubitemsPanelCollapsed(rootFile.path, true);
    });
    addSafeClickListener(expandHandle, (e) => {
      e.stopPropagation();
      section.classList.remove('tps-gcm-subitems-panel--collapsed');
      this.plugin.persistentMenuManager.setSubitemsPanelCollapsed(rootFile.path, false);
    });

    // Add collapse handle at the top
    section.appendChild(collapseHandle);

    const parentNavContainer = document.createElement('div');
    parentNavContainer.className = 'tps-gcm-parent-nav-container';
    section.appendChild(parentNavContainer);

    // Children section
    const childrenSection = document.createElement('div');
    childrenSection.className = 'tps-gcm-subitems-section';

    const childrenHeader = document.createElement('div');
    childrenHeader.className = 'tps-gcm-subitems-header';

    const childrenTitleWrap = document.createElement('div');
    childrenTitleWrap.className = 'tps-gcm-subitems-title-wrap';

    const childrenTitle = document.createElement('h4');
    childrenTitle.className = 'tps-gcm-subitems-title';
    childrenTitle.textContent = 'Children';
    childrenTitleWrap.appendChild(childrenTitle);

    childrenHeader.appendChild(childrenTitleWrap);

    const childrenActions = document.createElement('div');
    childrenActions.className = 'tps-gcm-subitems-header-actions';

    const addSubitemBtn = document.createElement('button');
    addSubitemBtn.type = 'button';
    addSubitemBtn.className = 'tps-gcm-subitems-header-btn';
    addSubitemBtn.title = 'Add subitem (linked task)';
    setIcon(addSubitemBtn, 'plus');
    addSafeClickListener(addSubitemBtn, () => {
      void this.createSubitemForParent(rootFile).then(async (created) => {
        if (created) {
          await this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody, referencesBody);
          window.setTimeout(() => {
            void this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody, referencesBody);
          }, 220);
        }
      });
    });
    childrenActions.appendChild(addSubitemBtn);
    childrenHeader.appendChild(childrenActions);

    const childrenBody = document.createElement('div');
    childrenBody.className = 'tps-gcm-subitems-body tps-gcm-subitems-body--children';

    childrenSection.appendChild(childrenHeader);
    childrenSection.appendChild(childrenBody);
    section.appendChild(childrenSection);

    // Attachments section
    const attachmentSection = document.createElement('div');
    attachmentSection.className = 'tps-gcm-subitems-section tps-gcm-subitems-section--attachments';

    const attachmentHeader = document.createElement('div');
    attachmentHeader.className = 'tps-gcm-subitems-header';

    const attachmentTitleWrap = document.createElement('div');
    attachmentTitleWrap.className = 'tps-gcm-subitems-title-wrap';

    const attachmentTitle = document.createElement('h4');
    attachmentTitle.className = 'tps-gcm-subitems-title';
    attachmentTitle.textContent = 'Attachments';
    attachmentTitleWrap.appendChild(attachmentTitle);

    attachmentHeader.appendChild(attachmentTitleWrap);

    const attachmentActions = document.createElement('div');
    attachmentActions.className = 'tps-gcm-subitems-header-actions';

    const addAttachmentBtn = document.createElement('button');
    addAttachmentBtn.type = 'button';
    addAttachmentBtn.className = 'tps-gcm-subitems-header-btn';
    addAttachmentBtn.title = 'Add attachment';
    setIcon(addAttachmentBtn, 'paperclip');
    addSafeClickListener(addAttachmentBtn, (evt: MouseEvent) => {
      const menu = new Menu();
      const refreshAfter = async () => {
        await this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody, referencesBody);
        window.setTimeout(() => {
          void this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody, referencesBody);
        }, 220);
      };

      menu.addItem((item) => {
        item.setTitle('Handwritten Note')
          .setIcon('pencil')
          .onClick(() => {
            void this.ensureEditModeAndExecute(() => this.triggerHandwriting());
            // Handwriting plugin embeds inline; refresh panel after a delay
            window.setTimeout(() => void refreshAfter(), 1500);
          });
      });

      menu.addItem((item) => {
        item.setTitle('Audio Recording')
          .setIcon('mic')
          .onClick(() => {
            void this.ensureEditModeAndExecute(() => this.triggerVoiceRecording());
            window.setTimeout(() => void refreshAfter(), 1500);
          });
      });

      menu.addItem((item) => {
        item.setTitle('Note')
          .setIcon('file-text')
          .onClick(() => {
            void this.createNoteAndAddAsAttachment(rootFile).then(async () => {
              await refreshAfter();
            });
          });
      });

      menu.showAtMouseEvent(evt);
    });
    attachmentActions.appendChild(addAttachmentBtn);
    attachmentHeader.appendChild(attachmentActions);

    const attachmentBody = document.createElement('div');
    attachmentBody.className = 'tps-gcm-subitems-body tps-gcm-subitems-body--attachments';

    attachmentSection.appendChild(attachmentHeader);
    attachmentSection.appendChild(attachmentBody);
    section.appendChild(attachmentSection);

    const referencesSection = document.createElement('div');
    referencesSection.className = 'tps-gcm-subitems-section tps-gcm-subitems-section--references';

    const referencesHeader = document.createElement('div');
    referencesHeader.className = 'tps-gcm-subitems-header';

    const referencesTitleWrap = document.createElement('div');
    referencesTitleWrap.className = 'tps-gcm-subitems-title-wrap';

    const referencesTitle = document.createElement('h4');
    referencesTitle.className = 'tps-gcm-subitems-title';
    referencesTitle.textContent = 'References';
    referencesTitleWrap.appendChild(referencesTitle);

    const referencesSubtitle = document.createElement('div');
    referencesSubtitle.className = 'tps-gcm-subitems-subtitle tps-gcm-subitems-subtitle--visible';
    referencesSubtitle.textContent = 'Incoming and outgoing body links';
    referencesTitleWrap.appendChild(referencesSubtitle);

    referencesHeader.appendChild(referencesTitleWrap);
    referencesSection.appendChild(referencesHeader);

    const referencesBody = document.createElement('div');
    referencesBody.className = 'tps-gcm-subitems-body tps-gcm-subitems-body--references';
    referencesSection.appendChild(referencesBody);
    if (!this.plugin.settings.showReferencesInSubitemsPanel && !this.plugin.settings.showMentionsInSubitemsPanel) {
      referencesSection.style.display = 'none';
    }
    section.appendChild(referencesSection);

    // Set up drop zones once — after both bodies are in the DOM
    const getBodyRefs = () => [childrenBody, attachmentBody] as [HTMLElement, HTMLElement];
    this.setupDropZone(childrenBody, 'child', rootFile, getBodyRefs);
    this.setupDropZone(attachmentBody, 'attachment', rootFile, getBodyRefs);

    // Initial load — fire immediately, then re-fire after a short delay so that any
    // in-flight metadata cache updates (e.g. from a just-completed processFrontMatter)
    // are fully settled before the second render.
    void this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody, referencesBody);
    window.setTimeout(() => {
      void this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody, referencesBody);
    }, 400);
    return section;
  }

  private async populateParentNavButton(rootFile: TFile, container: HTMLElement): Promise<void> {
    container.innerHTML = '';

    const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'parent').trim() || 'parent';
    const parentFiles: TFile[] = [];

    // Find the parent(s) OF this file by reading its frontmatter
    const cache = this.app.metadataCache.getFileCache(rootFile);
    const fm = cache?.frontmatter || {};
    if (!(parentKey in fm)) return;

    const raw = fm[parentKey];
    const values = Array.isArray(raw) ? raw : [raw];

    for (const val of values) {
      const parentFile = this.resolveParentValueToFile(val, rootFile.path);
      if (parentFile) {
        parentFiles.push(parentFile);
      }
    }

    if (parentFiles.length === 0) return;

    const navButton = document.createElement('button');
    navButton.type = 'button';
    navButton.className = 'tps-gcm-parent-nav-button';
    navButton.title = parentFiles.length === 1 ? 'Go to parent' : 'Select parent';
    setIcon(navButton, 'arrow-up');

    const label = document.createElement('span');
    label.className = 'tps-gcm-parent-nav-label';
    label.textContent = parentFiles.length === 1 ? 'Parent' : `Parents (${parentFiles.length})`;
    navButton.appendChild(label);

    addSafeClickListener(navButton, () => {
      if (parentFiles.length === 1) {
        // Single parent: open directly
        void this.plugin.openFileInLeaf(parentFiles[0], false, () => this.app.workspace.getLeaf(false), { revealLeaf: true });
      } else {
        // Multiple parents: show menu
        const menu = new Menu();
        for (const parentFile of parentFiles) {
          menu.addItem((item) => {
            item
              .setTitle(parentFile.basename)
              .setIcon('file-text')
              .onClick(() => {
                void this.plugin.openFileInLeaf(parentFile, false, () => this.app.workspace.getLeaf(false), { revealLeaf: true });
              });
          });
        }
        menu.showAtPosition({ x: navButton.getBoundingClientRect().left, y: navButton.getBoundingClientRect().bottom });
      }
    });

    container.appendChild(navButton);
  }

  private resolveParentValueToFile(value: any, sourcePath: string): TFile | null {
    return resolveLinkValueToFile(this.app, value, sourcePath);
  }

  private parentValueMatchesTarget(value: any, sourcePath: string, target: TFile): boolean {
    const file = this.resolveParentValueToFile(value, sourcePath);
    return file !== null && file.path === target.path;
  }

  private scheduleSubitemsPanelRefresh(
    rootFile: TFile,
    childrenBody: HTMLElement,
    attachmentBody: HTMLElement,
    referencesBody: HTMLElement
  ): void {
    const key = rootFile.path;
    const existing = this.subitemPanelRefreshTimers.get(key);
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }
    this.subitemPanelRefreshTimers.set(
      key,
      window.setTimeout(() => {
        this.subitemPanelRefreshTimers.delete(key);
        void this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody, referencesBody);
      }, SUBITEM_PANEL_REFRESH_DEBOUNCE_MS)
    );
  }

  private async refreshSubitemsPanel(
    rootFile: TFile,
    childrenBody: HTMLElement,
    attachmentBody: HTMLElement,
    referencesBody: HTMLElement
  ): Promise<void> {
    // Refresh the parent nav button alongside children/attachments so it stays in sync
    // after operations like linkToParent that change the parent frontmatter key.
    const panel = childrenBody.closest('.tps-gcm-subitems-panel');
    const navContainer = panel?.querySelector<HTMLElement>('.tps-gcm-parent-nav-container');
    if (navContainer) {
      void this.populateParentNavButton(rootFile, navContainer);
    }
    try {
      const tree = await this.buildSubitemTree(rootFile);

      // Separate children and attachments
      const children: SubitemNode[] = [];
      const attachments: SubitemNode[] = [];

      tree.forEach((node) => {
        const isAttachmentOnly = node.relations.includes('attachment') && !node.relations.includes('child');
        if (isAttachmentOnly) {
          attachments.push(node);
        } else {
          children.push(node);
        }
      });
      const [checklistItems, references] = await Promise.all([
        this.plugin.settings.showChecklistInSubitemsPanel
          ? this.collectChecklistSubitems(rootFile)
          : Promise.resolve([]),
        (this.plugin.settings.showReferencesInSubitemsPanel || this.plugin.settings.showMentionsInSubitemsPanel)
          ? this.collectReferenceGroups(rootFile)
          : Promise.resolve({ outgoing: [], incoming: [], mentions: [] }),
      ]);

      const getBodyRefs = (): [HTMLElement, HTMLElement] => [childrenBody, attachmentBody];

      // Render children section
      this.renderSubitemsSection(
        childrenBody,
        children,
        rootFile,
        'No linked children yet. Use + to create one.',
        getBodyRefs,
        checklistItems
      );

      // Render attachments section
      this.renderSubitemsSection(attachmentBody, attachments, rootFile, 'No attachments yet. Use + to create one.', getBodyRefs);
      if (this.plugin.settings.showReferencesInSubitemsPanel || this.plugin.settings.showMentionsInSubitemsPanel) {
        this.renderReferencesSection(referencesBody, references, rootFile);
      } else {
        referencesBody.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'tps-gcm-subitem-empty';
        empty.textContent = 'Reference previews are disabled.';
        referencesBody.appendChild(empty);
      }
    } catch (error) {
      logger.error('[TPS GCM] Failed to render subitems panel:', error);
      childrenBody.innerHTML = '';
      attachmentBody.innerHTML = '';
      referencesBody.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'tps-gcm-subitem-empty';
      err.textContent = 'Unable to render subitems.';
      childrenBody.appendChild(err);
    }
  }

  private setupDropZone(
    body: HTMLElement,
    targetRelation: 'child' | 'attachment',
    rootFile: TFile,
    getBodyRefs: () => [HTMLElement, HTMLElement]
  ): void {
    const rerender = () => {
      const [childrenBody, attachmentBody] = getBodyRefs();
      const referencesBody = rootFile instanceof TFile
        ? (childrenBody.closest('.tps-gcm-subitems-panel')?.querySelector('.tps-gcm-subitems-body--references') as HTMLElement | null)
        : null;
      if (!referencesBody) return;
      this.scheduleSubitemsPanelRefresh(rootFile, childrenBody, attachmentBody, referencesBody);
    };

    body.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes('application/tps-gcm-subitem')) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      body.classList.add('tps-gcm-subitems-body--drop-target');
    });
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget as Node)) {
        body.classList.remove('tps-gcm-subitems-body--drop-target');
      }
    });
    body.addEventListener('drop', (e) => {
      e.preventDefault();
      body.classList.remove('tps-gcm-subitems-body--drop-target');
      const raw = e.dataTransfer?.getData('application/tps-gcm-subitem');
      if (!raw) return;
      let dragData: { path: string; relation: string; rootPath: string };
      try { dragData = JSON.parse(raw); } catch { return; }

      // No-op if dropped on same section
      if (dragData.relation === targetRelation) return;
      // Must be from the same root file
      if (dragData.rootPath !== rootFile.path) return;

      const draggedFile = this.app.vault.getAbstractFileByPath(dragData.path);
      if (!(draggedFile instanceof TFile)) return;

      if (targetRelation === 'child') {
        // Dragging attachment → children: file must be markdown
        if (draggedFile.extension?.toLowerCase() !== 'md') {
          new Notice('Only markdown files can be subitems.');
          return;
        }
        void this.changeRelationToChild(rootFile, draggedFile).then(rerender);
      } else {
        // Dragging child → attachments
        void this.changeRelationToAttachment(rootFile, draggedFile).then(rerender);
      }
    });
  }

  private renderSubitemsSection(
    body: HTMLElement,
    nodes: SubitemNode[],
    rootFile: TFile,
    emptyMessage: string,
    getBodyRefs: () => [HTMLElement, HTMLElement],
    checklistItems: ChecklistSubitem[] = []
  ): void {
    body.innerHTML = '';

    const rerender = () => {
      const [childrenBody, attachmentBody] = getBodyRefs();
      const referencesBody = rootFile instanceof TFile
        ? (childrenBody.closest('.tps-gcm-subitems-panel')?.querySelector('.tps-gcm-subitems-body--references') as HTMLElement | null)
        : null;
      if (!referencesBody) return;
      this.scheduleSubitemsPanelRefresh(rootFile, childrenBody, attachmentBody, referencesBody);
    };

    if (!nodes.length && checklistItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tps-gcm-subitem-empty';
      empty.textContent = emptyMessage;
      body.appendChild(empty);
      return;
    }

    nodes.forEach((node) => this.createSubitemRow(body, node, 0, rootFile, rerender));
    if (checklistItems.length > 0) {
      this.renderChecklistSubitems(body, checklistItems, rootFile, rerender);
    }
  }

  private async collectChecklistSubitems(rootFile: TFile): Promise<ChecklistSubitem[]> {
    if (rootFile.extension?.toLowerCase() !== 'md') return [];

    try {
      const content = await this.app.vault.cachedRead(rootFile);
      const lines = content.split('\n');
      const checklistItems: ChecklistSubitem[] = [];

      for (let i = 0; i < lines.length; i += 1) {
        const parsed = this.parseChecklistLine(lines[i]);
        if (!parsed) continue;
        // Hide completed and canceled checklist items from the checklist-child list.
        if (parsed.state === 'x' || parsed.state === 'X' || parsed.state === '-') continue;
        if (!parsed.text.trim()) continue;
        checklistItems.push({
          lineNumber: i,
          rawLine: lines[i],
          prefix: parsed.prefix,
          state: parsed.state,
          text: parsed.text.trim(),
        });
      }

      return checklistItems;
    } catch (error) {
      logger.warn('[TPS GCM] Failed reading checklist subitems for', rootFile.path, error);
      return [];
    }
  }

  private parseChecklistLine(line: string): { prefix: string; state: ChecklistTaskState; text: string } | null {
    const match = line.match(/^(\s*(?:[-*+]|\d+\.)\s*)\[( |x|X|\?|-)\]\s*(.*)$/);
    if (!match) return null;
    return {
      prefix: match[1],
      state: match[2] as ChecklistTaskState,
      text: match[3] || '',
    };
  }

  private renderChecklistSubitems(
    body: HTMLElement,
    checklistItems: ChecklistSubitem[],
    rootFile: TFile,
    onRefresh: () => void
  ): void {
    const checklistWrap = document.createElement('div');
    checklistWrap.className = 'tps-gcm-checklist-subitems';
    body.appendChild(checklistWrap);

    const checklistTitle = document.createElement('div');
    checklistTitle.className = 'tps-gcm-checklist-subitems-title';
    checklistTitle.textContent = 'Checklist items';
    checklistWrap.appendChild(checklistTitle);

    const checklistList = document.createElement('div');
    checklistList.className = 'tps-gcm-checklist-subitems-list';
    checklistWrap.appendChild(checklistList);

    const fragment = document.createDocumentFragment();
    checklistItems.forEach((item) => {
      this.createChecklistSubitemRow(fragment, item, rootFile, onRefresh);
    });
    checklistList.appendChild(fragment);
  }

  private createChecklistSubitemRow(
    container: Node,
    item: ChecklistSubitem,
    rootFile: TFile,
    onRefresh: () => void
  ): void {
    const row = document.createElement('div');
    row.className = 'tps-gcm-subitem-row tps-gcm-subitem-row--checklist';
    row.style.setProperty('--tps-gcm-subitem-depth', '0');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'task-list-item-checkbox tps-gcm-checklist-toggle';
    checkbox.checked = false;
    checkbox.indeterminate = item.state === '?';
    checkbox.title = 'Complete checklist item';
    checkbox.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (checkbox.disabled) return;
      checkbox.disabled = true;
      void this.toggleChecklistItemFromPanel(rootFile, item, row, onRefresh).finally(() => {
        checkbox.disabled = false;
      });
    });
    row.appendChild(checkbox);

    const title = document.createElement('span');
    title.className = 'tps-gcm-subitem-title tps-gcm-subitem-title--checklist';
    title.textContent = item.text;
    title.title = `${rootFile.path}:${item.lineNumber + 1}`;
    row.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'tps-gcm-subitem-actions';
    const promoteBtn = this.createSubitemActionButton('Promote', () => {
      if (promoteBtn.disabled) return;
      promoteBtn.disabled = true;
      void this.promoteChecklistItemToChild(rootFile, item, onRefresh).finally(() => {
        promoteBtn.disabled = false;
      });
    });
    promoteBtn.title = 'Create a linked child note from this checklist item';
    actions.appendChild(promoteBtn);
    row.appendChild(actions);

    container.appendChild(row);
  }

  private async toggleChecklistItemFromPanel(
    rootFile: TFile,
    item: ChecklistSubitem,
    rowEl: HTMLElement,
    onRefresh: () => void
  ): Promise<void> {
    try {
      const content = await this.app.vault.read(rootFile);
      const lines = content.split('\n');
      const lineIndex = this.resolveChecklistLineIndex(lines, item);
      if (lineIndex < 0) return;

      const currentLine = lines[lineIndex];
      const updatedLine = currentLine.replace(
        /^(\s*(?:[-*+]|\d+\.)\s*)\[( |x|X|\?|-)\](\s*.*)$/,
        '$1[x]$3'
      );
      if (updatedLine === currentLine) return;

      lines[lineIndex] = updatedLine;
      const updatedContent = lines.join('\n');
      if (updatedContent === content) return;

      await this.app.vault.modify(rootFile, updatedContent);
      rowEl.style.opacity = '0';
      rowEl.style.pointerEvents = 'none';
      window.setTimeout(() => {
        rowEl.remove();
      }, 120);
      const pluginAny = this.plugin as any;
      if (typeof pluginAny.scheduleChecklistReorder === 'function') {
        pluginAny.scheduleChecklistReorder(rootFile);
      }
      window.setTimeout(() => onRefresh(), 180);
    } catch (error) {
      logger.warn('[TPS GCM] Failed toggling checklist item from subitems panel for', rootFile.path, error);
    }
  }

  private async promoteChecklistItemToChild(
    rootFile: TFile,
    item: ChecklistSubitem,
    onRefresh: () => void
  ): Promise<void> {
    const promotionTitle = this.getChecklistPromotionTitle(item.text);
    if (!promotionTitle) {
      new Notice('Checklist item title is empty.');
      return;
    }

    const created = await this.createSubitemForParentWithTitle(
      rootFile,
      promotionTitle,
      this.getDefaultSubitemFolderPath(rootFile)
    );
    if (!created) return;

    await this.markChecklistItemPromoted(rootFile, item, created);
    onRefresh();
  }

  private getChecklistPromotionTitle(rawText: string): string {
    const source = String(rawText || '');
    if (!source.trim()) return '';

    const withoutWiki = source.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, alias) => {
      const preferred = String(alias || target || '').trim();
      return preferred || '';
    });
    const withoutMarkdownLinks = withoutWiki.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
    return withoutMarkdownLinks
      .replace(/`([^`]*)`/g, '$1')
      .replace(/[*_~]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async markChecklistItemPromoted(rootFile: TFile, item: ChecklistSubitem, created: TFile): Promise<void> {
    try {
      const content = await this.app.vault.read(rootFile);
      const lines = content.split('\n');
      const lineIndex = this.resolveChecklistLineIndex(lines, item);
      if (lineIndex < 0) return;

      const parsed = this.parseChecklistLine(lines[lineIndex]);
      if (!parsed) return;

      const alias = item.text.trim() || created.basename;
      const markdownLink = this.app.fileManager.generateMarkdownLink(created, rootFile.path, undefined, alias);
      lines[lineIndex] = `${parsed.prefix}[x] ${markdownLink}`;
      const updatedContent = lines.join('\n');
      if (updatedContent !== content) {
        await this.app.vault.modify(rootFile, updatedContent);
      }
    } catch (error) {
      logger.warn('[TPS GCM] Failed marking checklist item as promoted for', rootFile.path, error);
    }
  }

  private resolveChecklistLineIndex(lines: string[], item: ChecklistSubitem): number {
    const direct = lines[item.lineNumber];
    if (typeof direct === 'string' && direct === item.rawLine) {
      return item.lineNumber;
    }

    const normalizedTarget = this.normalizeChecklistText(item.text);
    if (!normalizedTarget) return -1;

    for (let i = 0; i < lines.length; i += 1) {
      const parsed = this.parseChecklistLine(lines[i]);
      if (!parsed) continue;
      if (this.normalizeChecklistText(parsed.text) === normalizedTarget) {
        return i;
      }
    }
    return -1;
  }

  private normalizeChecklistText(text: string): string {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private async collectReferenceGroups(rootFile: TFile): Promise<{ outgoing: ReferenceGroup[]; incoming: ReferenceGroup[]; mentions: MentionGroup[] }> {
    const outgoingOccurrences = await this.extractReferenceOccurrencesFromSource(rootFile);
    const outgoing = this.groupReferenceOccurrences(outgoingOccurrences, 'outgoing');

    const incomingSourceFiles = this.getIncomingReferenceSourceFiles(rootFile);
    const incomingBatches = await Promise.all(
      incomingSourceFiles.map(async (sourceFile) => this.extractReferenceOccurrencesFromSource(sourceFile, rootFile))
    );
    const incoming = this.groupReferenceOccurrences(incomingBatches.flat(), 'incoming');

    const mentions = await this.collectUnlinkedMentionGroups(rootFile);

    return { outgoing, incoming, mentions };
  }

  private getIncomingReferenceSourceFiles(rootFile: TFile): TFile[] {
    const resolvedLinks = ((this.app.metadataCache as any)?.resolvedLinks || {}) as Record<string, Record<string, number>>;
    const seen = new Set<string>();
    const files: TFile[] = [];

    for (const [sourcePath, targets] of Object.entries(resolvedLinks)) {
      if (!targets || !Object.prototype.hasOwnProperty.call(targets, rootFile.path)) continue;
      if (sourcePath === rootFile.path || seen.has(sourcePath)) continue;
      const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(sourceFile instanceof TFile) || sourceFile.extension?.toLowerCase() !== 'md') continue;
      seen.add(sourcePath);
      files.push(sourceFile);
    }

    files.sort((a, b) => a.basename.localeCompare(b.basename));
    return files;
  }

  private async extractReferenceOccurrencesFromSource(
    sourceFile: TFile,
    onlyTarget?: TFile
  ): Promise<ReferenceOccurrence[]> {
    if (sourceFile.extension?.toLowerCase() !== 'md') return [];

    try {
      const raw = await this.app.vault.cachedRead(sourceFile);
      const lines = raw.split('\n');
      const frontmatterEndLine = this.getFrontmatterEndLine(sourceFile, raw);
      const headings = Array.isArray((this.app.metadataCache.getFileCache(sourceFile) as any)?.headings)
        ? ((this.app.metadataCache.getFileCache(sourceFile) as any)?.headings as any[])
        : [];

      const occurrences: ReferenceOccurrence[] = [];
      let inFence = false;
      for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
        if (lineNumber <= frontmatterEndLine) continue;
        const line = lines[lineNumber];
        if (String(line || '').trimStart().startsWith('```')) {
          inFence = !inFence;
          continue;
        }
        if (inFence || !line || line.indexOf('[') < 0) continue;

        for (const match of this.extractReferenceTargetsFromLine(line)) {
          const targetFile = this.resolveLinkTargetToFile(match.target, sourceFile.path);
          if (!(targetFile instanceof TFile) || targetFile.extension?.toLowerCase() !== 'md') continue;
          if (onlyTarget && targetFile.path !== onlyTarget.path) continue;

          occurrences.push({
            sourceFile,
            targetFile,
            lineNumber,
            heading: this.findHeadingForLine(headings, lineNumber),
            previews: this.buildReferencePreviewLevels(lines, lineNumber),
          });
        }
      }

      return occurrences;
    } catch (error) {
      logger.warn('[TPS GCM] Failed extracting reference occurrences for', sourceFile.path, error);
      return [];
    }
  }

  private extractReferenceTargetsFromLine(line: string): Array<{ target: string; start: number; end: number }> {
    const matches: Array<{ target: string; start: number; end: number }> = [];
    const patterns = [
      /(?<!!)\[\[([^\]]+)\]\]/g,
      /(?<!!)\[[^\]]*\]\(([^)]+)\)/g,
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null = null;
      while ((match = pattern.exec(line)) !== null) {
        const target = String(match[1] || '').trim();
        if (!target) continue;
        matches.push({
          target,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }

    return matches;
  }

  private getFrontmatterEndLine(file: TFile, raw: string): number {
    const cache = this.app.metadataCache.getFileCache(file) as any;
    const fmPosition = cache?.frontmatter?.position;
    if (fmPosition?.end?.line !== undefined) {
      return Number(fmPosition.end.line);
    }

    const lines = raw.split('\n');
    if (lines[0]?.trim() !== '---') return -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i]?.trim() === '---') return i;
    }
    return -1;
  }

  private findHeadingForLine(headings: any[], lineNumber: number): string {
    let activeHeading = '';
    for (const heading of headings) {
      const headingLine = Number(heading?.position?.start?.line);
      if (!Number.isFinite(headingLine) || headingLine > lineNumber) break;
      const value = String(heading?.heading || '').trim();
      if (value) activeHeading = value;
    }
    return activeHeading;
  }

  private buildReferencePreviewLevels(lines: string[], lineNumber: number): string[] {
    const linePreview = this.cropPreviewText(lines[lineNumber] || '');
    const paragraphPreview = this.cropPreviewText(this.extractParagraphPreview(lines, lineNumber), 320);
    const sectionPreview = this.cropPreviewText(this.extractSectionPreview(lines, lineNumber), 520);
    return Array.from(new Set([linePreview, paragraphPreview, sectionPreview].filter(Boolean)));
  }

  private cropPreviewText(text: string, maxLength = 140): string {
    const normalized = String(text || '').replace(/\t/g, '  ').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  private extractParagraphPreview(lines: string[], lineNumber: number): string {
    let start = lineNumber;
    while (start - 1 >= 0) {
      const prev = lines[start - 1] || '';
      if (!prev.trim()) break;
      if (/^\s*#{1,6}\s/.test(prev)) break;
      if (/^\s*```/.test(prev)) break;
      start -= 1;
    }

    let end = lineNumber;
    while (end + 1 < lines.length) {
      const next = lines[end + 1] || '';
      if (!next.trim()) break;
      if (/^\s*#{1,6}\s/.test(next)) break;
      if (/^\s*```/.test(next)) break;
      end += 1;
    }

    return lines.slice(start, end + 1).join(' ');
  }

  private extractSectionPreview(lines: string[], lineNumber: number): string {
    let start = lineNumber;
    while (start - 1 >= 0) {
      const prev = lines[start - 1] || '';
      if (/^\s*#{1,6}\s/.test(prev)) {
        start -= 1;
        break;
      }
      start -= 1;
    }
    start = Math.max(0, start);

    let end = lineNumber;
    while (end + 1 < lines.length) {
      const next = lines[end + 1] || '';
      if (/^\s*#{1,6}\s/.test(next)) break;
      end += 1;
    }

    return lines.slice(start, end + 1).join(' ');
  }

  private groupReferenceOccurrences(
    occurrences: ReferenceOccurrence[],
    direction: ReferenceDirection
  ): ReferenceGroup[] {
    const grouped = new Map<string, ReferenceGroup>();

    for (const occurrence of occurrences) {
      const file = direction === 'outgoing' ? occurrence.targetFile : occurrence.sourceFile;
      const existing = grouped.get(file.path);
      if (existing) {
        existing.occurrences.push(occurrence);
        continue;
      }
      grouped.set(file.path, { file, direction, occurrences: [occurrence] });
    }

    return Array.from(grouped.values())
      .map((group) => ({
        ...group,
        occurrences: group.occurrences.sort((a, b) => a.lineNumber - b.lineNumber),
      }))
      .sort((a, b) => a.file.basename.localeCompare(b.file.basename));
  }

  private async collectUnlinkedMentionGroups(rootFile: TFile): Promise<MentionGroup[]> {
    const candidateTitles = this.getMentionCandidateTitles(rootFile);
    if (candidateTitles.length === 0) return [];

    const markdownFiles = this.app.vault.getMarkdownFiles();
    const groups: MentionGroup[] = [];

    for (const sourceFile of markdownFiles) {
      if (sourceFile.path === rootFile.path) continue;
      const occurrences = await this.extractUnlinkedMentionsFromSource(sourceFile, rootFile, candidateTitles);
      if (occurrences.length === 0) continue;
      groups.push({
        file: sourceFile,
        occurrences,
      });
    }

    return groups.sort((a, b) => a.file.basename.localeCompare(b.file.basename));
  }

  private getMentionCandidateTitles(rootFile: TFile): string[] {
    const values = new Set<string>([rootFile.basename]);
    const cache = this.app.metadataCache.getFileCache(rootFile);
    const frontmatter = (cache?.frontmatter || {}) as Record<string, any>;
    const titleValue = this.getFrontmatterValueCaseInsensitive(frontmatter, 'title');
    if (typeof titleValue === 'string' && titleValue.trim()) {
      values.add(titleValue.trim());
    }

    return Array.from(values)
      .map((value) => String(value || '').trim())
      .filter((value) => value.length >= 3)
      .sort((a, b) => b.length - a.length);
  }

  private async extractUnlinkedMentionsFromSource(
    sourceFile: TFile,
    targetFile: TFile,
    candidateTitles: string[]
  ): Promise<ReferenceOccurrence[]> {
    if (sourceFile.extension?.toLowerCase() !== 'md') return [];

    try {
      const raw = await this.app.vault.cachedRead(sourceFile);
      const lines = raw.split('\n');
      const frontmatterEndLine = this.getFrontmatterEndLine(sourceFile, raw);
      const headings = Array.isArray((this.app.metadataCache.getFileCache(sourceFile) as any)?.headings)
        ? ((this.app.metadataCache.getFileCache(sourceFile) as any)?.headings as any[])
        : [];

      const existingReferenceLineNumbers = new Set(
        (await this.extractReferenceOccurrencesFromSource(sourceFile, targetFile)).map((occurrence) => occurrence.lineNumber)
      );

      const occurrences: ReferenceOccurrence[] = [];
      let inFence = false;
      for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
        if (lineNumber <= frontmatterEndLine) continue;
        const line = lines[lineNumber] || '';
        if (line.trimStart().startsWith('```')) {
          inFence = !inFence;
          continue;
        }
        if (inFence || !line.trim() || existingReferenceLineNumbers.has(lineNumber)) continue;

        const matchedText = this.findMentionInLine(line, candidateTitles);
        if (!matchedText) continue;

        occurrences.push({
          sourceFile,
          targetFile,
          lineNumber,
          heading: this.findHeadingForLine(headings, lineNumber),
          previews: this.buildReferencePreviewLevels(lines, lineNumber),
          matchedText,
        });
      }

      return occurrences;
    } catch (error) {
      logger.warn('[TPS GCM] Failed extracting unlinked mentions for', sourceFile.path, error);
      return [];
    }
  }

  private findMentionInLine(line: string, candidateTitles: string[]): string {
    const source = String(line || '');
    for (const candidate of candidateTitles) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[^\\w])(${escaped})(?=$|[^\\w])`, 'i');
      const match = source.match(regex);
      if (match?.[2]) {
        return match[2];
      }
    }
    return '';
  }

  private renderReferencesSection(
    body: HTMLElement,
    references: { outgoing: ReferenceGroup[]; incoming: ReferenceGroup[]; mentions: MentionGroup[] },
    rootFile: TFile
  ): void {
    body.innerHTML = '';
    const showReferences = this.plugin.settings.showReferencesInSubitemsPanel;
    const showMentions = this.plugin.settings.showMentionsInSubitemsPanel;

    if (
      (!showReferences || (references.outgoing.length === 0 && references.incoming.length === 0))
      && (!showMentions || references.mentions.length === 0)
    ) {
      const empty = document.createElement('div');
      empty.className = 'tps-gcm-subitem-empty';
      empty.textContent = 'No references yet.';
      body.appendChild(empty);
      return;
    }

    if (showReferences && references.outgoing.length > 0) {
      body.appendChild(this.createOutgoingReferenceSection(references.outgoing));
    }

    if (showReferences && references.incoming.length > 0) {
      body.appendChild(this.createReferenceDirectionSection('Incoming', references.incoming, 'incoming'));
    }

    if (showMentions && references.mentions.length > 0) {
      body.appendChild(this.createMentionsSection(references.mentions, rootFile));
    }
  }

  private createReferenceDirectionSection(
    label: string,
    groups: ReferenceGroup[],
    mode: 'incoming'
  ): HTMLElement {
    const section = document.createElement('div');
    section.className = 'tps-gcm-reference-direction';

    const title = document.createElement('div');
    title.className = 'tps-gcm-reference-direction-title';
    title.textContent = label;
    section.appendChild(title);

    const fragment = document.createDocumentFragment();
    groups.forEach((group) => {
      fragment.appendChild(this.createReferenceGroup(group, mode));
    });
    section.appendChild(fragment);
    return section;
  }

  private createOutgoingReferenceSection(groups: ReferenceGroup[]): HTMLElement {
    const section = document.createElement('div');
    section.className = 'tps-gcm-reference-direction';

    const title = document.createElement('div');
    title.className = 'tps-gcm-reference-direction-title';
    title.textContent = 'Outgoing';
    section.appendChild(title);

    const list = document.createElement('div');
    list.className = 'tps-gcm-reference-simple-list';
    section.appendChild(list);

    const fragment = document.createDocumentFragment();
    groups.forEach((group) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tps-gcm-reference-simple-item';
      button.textContent = group.file.basename;
      button.title = group.file.path;
      addSafeClickListener(button, () => {
        void this.plugin.openFileInLeaf(group.file, false, () => this.app.workspace.getLeaf(false), { revealLeaf: true });
      });
      fragment.appendChild(button);
    });
    list.appendChild(fragment);
    return section;
  }

  private createReferenceGroup(group: ReferenceGroup, mode: 'incoming'): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'tps-gcm-reference-group';

    const header = document.createElement('div');
    header.className = 'tps-gcm-reference-group-header';
    wrap.appendChild(header);

    const titleButton = document.createElement('button');
    titleButton.type = 'button';
    titleButton.className = 'tps-gcm-reference-group-title';
    titleButton.textContent = group.file.basename;
    titleButton.title = group.file.path;
    addSafeClickListener(titleButton, () => {
      void this.openReferenceOccurrence(group.file, group.occurrences[0]);
    });
    header.appendChild(titleButton);

    const countBadge = document.createElement('span');
    countBadge.className = 'tps-gcm-reference-count';
    countBadge.textContent = `${group.occurrences.length}`;
    header.appendChild(countBadge);

    const occurrencesWrap = document.createElement('div');
    occurrencesWrap.className = 'tps-gcm-reference-occurrences';
    wrap.appendChild(occurrencesWrap);

    const fragment = document.createDocumentFragment();
    group.occurrences.forEach((occurrence) => {
      fragment.appendChild(this.createReferenceOccurrenceRow(occurrence, mode));
    });
    occurrencesWrap.appendChild(fragment);

    return wrap;
  }

  private createReferenceOccurrenceRow(occurrence: ReferenceOccurrence, mode: 'incoming' | 'mention'): HTMLElement {
    const row = document.createElement('div');
    row.className = 'tps-gcm-reference-occurrence';

    const meta = document.createElement('div');
    meta.className = 'tps-gcm-reference-occurrence-meta';
    meta.textContent = occurrence.heading
      ? `${occurrence.heading} • line ${occurrence.lineNumber + 1}`
      : `line ${occurrence.lineNumber + 1}`;
    row.appendChild(meta);

    const preview = document.createElement('div');
    preview.className = 'tps-gcm-reference-preview';
    let previewIndex = 0;
    preview.textContent = occurrence.previews[previewIndex] || '';
    row.appendChild(preview);

    const actions = document.createElement('div');
    actions.className = 'tps-gcm-reference-actions';

    if (occurrence.previews.length > 1) {
      const moreBtn = this.createSubitemActionButton('More', () => {
        if (previewIndex < occurrence.previews.length - 1) {
          previewIndex += 1;
        } else {
          previewIndex = 0;
        }
        preview.textContent = occurrence.previews[previewIndex] || '';
        moreBtn.textContent = previewIndex < occurrence.previews.length - 1 ? 'More' : 'Less';
      });
      actions.appendChild(moreBtn);
    }

    const openBtn = this.createSubitemActionButton('Open', () => {
      void this.openReferenceOccurrence(occurrence.sourceFile, occurrence);
    });
    actions.appendChild(openBtn);
    row.appendChild(actions);

    return row;
  }

  private createMentionsSection(groups: MentionGroup[], rootFile: TFile): HTMLElement {
    const section = document.createElement('div');
    section.className = 'tps-gcm-reference-direction';

    const title = document.createElement('div');
    title.className = 'tps-gcm-reference-direction-title';
    title.textContent = 'Mentions';
    section.appendChild(title);

    const fragment = document.createDocumentFragment();
    groups.forEach((group) => {
      const wrap = document.createElement('div');
      wrap.className = 'tps-gcm-reference-group';

      const header = document.createElement('div');
      header.className = 'tps-gcm-reference-group-header';
      wrap.appendChild(header);

      const titleButton = document.createElement('button');
      titleButton.type = 'button';
      titleButton.className = 'tps-gcm-reference-group-title';
      titleButton.textContent = group.file.basename;
      titleButton.title = group.file.path;
      addSafeClickListener(titleButton, () => {
        void this.openReferenceOccurrence(group.file, group.occurrences[0]);
      });
      header.appendChild(titleButton);

      const countBadge = document.createElement('span');
      countBadge.className = 'tps-gcm-reference-count';
      countBadge.textContent = `${group.occurrences.length}`;
      header.appendChild(countBadge);

      const occurrencesWrap = document.createElement('div');
      occurrencesWrap.className = 'tps-gcm-reference-occurrences';
      wrap.appendChild(occurrencesWrap);

      const innerFragment = document.createDocumentFragment();
      group.occurrences.forEach((occurrence) => {
        const row = this.createReferenceOccurrenceRow(occurrence, 'mention');
        const actions = row.querySelector('.tps-gcm-reference-actions');
        if (actions instanceof HTMLElement) {
          const linkBtn = this.createSubitemActionButton('Link', () => {
            void this.convertMentionToLinkedReference(rootFile, occurrence, row);
          });
          actions.insertBefore(linkBtn, actions.firstChild);
        }
        innerFragment.appendChild(row);
      });
      occurrencesWrap.appendChild(innerFragment);
      fragment.appendChild(wrap);
    });

    section.appendChild(fragment);
    return section;
  }

  private async openReferenceOccurrence(file: TFile, occurrence: ReferenceOccurrence): Promise<void> {
    const opened = await this.plugin.openFileInLeaf(file, false, () => this.app.workspace.getLeaf(false), { revealLeaf: true });
    if (!opened) return;

    window.setTimeout(() => {
      const markdownView = this.app.workspace.getLeavesOfType('markdown')
        .map((leaf) => leaf.view)
        .find((view: any) => view?.file?.path === file.path) as any;
      const editor = markdownView?.editor;
      if (!editor || typeof editor.setCursor !== 'function') return;
      try {
        editor.setCursor({ line: occurrence.lineNumber, ch: 0 });
        if (typeof editor.scrollIntoView === 'function') {
          editor.scrollIntoView({ from: { line: occurrence.lineNumber, ch: 0 }, to: { line: occurrence.lineNumber + 1, ch: 0 } }, true);
        }
      } catch (error) {
        logger.warn('[TPS GCM] Failed focusing reference occurrence for', file.path, error);
      }
    }, 60);
  }

  private async convertMentionToLinkedReference(
    targetFile: TFile,
    occurrence: ReferenceOccurrence,
    rowEl: HTMLElement
  ): Promise<void> {
    const matchedText = String(occurrence.matchedText || '').trim();
    if (!matchedText) return;

    try {
      const content = await this.app.vault.read(occurrence.sourceFile);
      const lines = content.split('\n');
      if (occurrence.lineNumber < 0 || occurrence.lineNumber >= lines.length) return;

      const currentLine = lines[occurrence.lineNumber] || '';
      const escaped = matchedText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(^|[^\\w])(${escaped})(?=$|[^\\w])`);
      const markdownLink = this.app.fileManager.generateMarkdownLink(targetFile, occurrence.sourceFile.path, undefined, matchedText);
      const replacedLine = currentLine.replace(regex, (full, prefix) => `${prefix}${markdownLink}`);
      if (replacedLine === currentLine) return;

      lines[occurrence.lineNumber] = replacedLine;
      const updatedContent = lines.join('\n');
      if (updatedContent === content) return;

      await this.app.vault.modify(occurrence.sourceFile, updatedContent);
      rowEl.style.opacity = '0';
      rowEl.style.pointerEvents = 'none';
      window.setTimeout(() => {
        rowEl.remove();
      }, 120);
    } catch (error) {
      logger.warn('[TPS GCM] Failed converting mention to linked reference for', occurrence.sourceFile.path, error);
    }
  }

  private async buildSubitemTree(rootFile: TFile): Promise<SubitemNode[]> {
    const parentIndex = this.buildParentToChildrenIndex();
    const visited = new Set<string>([normalizePath(rootFile.path)]);
    return this.buildSubitemTreeRecursive(rootFile, parentIndex, visited, 0);
  }

  private async buildSubitemTreeRecursive(
    file: TFile,
    parentIndex: Map<string, TFile[]>,
    visited: Set<string>,
    depth: number
  ): Promise<SubitemNode[]> {
    if (depth >= MAX_SUBITEM_DEPTH) return [];

    const relationMap = await this.collectDirectSubitemRelations(file, parentIndex);

    // Filter out archived notes and completed children
    const activeEntries = Array.from(relationMap.values()).filter((entry) => {
      if (this.isArchived(entry.file)) return false;
      const cache = this.app.metadataCache.getFileCache(entry.file);
      if (cache?.frontmatter?.status === 'complete') return false;
      return true;
    });

    const relationEntries = activeEntries.sort((a, b) => {
      // 1. Custom Sort Key from Companion (if configured)
      const sortField = this.getSortField();
      if (sortField) {
        const aCache = this.app.metadataCache.getFileCache(a.file);
        const bCache = this.app.metadataCache.getFileCache(b.file);

        // Case-insensitive lookup
        const getVal = (fm: any, key: string) => {
          if (!fm) return undefined;
          if (key in fm) return fm[key];
          const lowerKey = key.toLowerCase();
          for (const k of Object.keys(fm)) {
            if (k.toLowerCase() === lowerKey) return fm[k];
          }
          return undefined;
        };

        const aVal = getVal(aCache?.frontmatter, sortField);
        const bVal = getVal(bCache?.frontmatter, sortField);

        const hasA = aVal !== undefined && aVal !== null && aVal !== '';
        const hasB = bVal !== undefined && bVal !== null && bVal !== '';

        if (hasA && hasB) {
          // Both have sort value: compare them
          // Try numeric sort if both are numbers
          const aNum = Number(aVal);
          const bNum = Number(bVal);
          if (!isNaN(aNum) && !isNaN(bNum)) {
            return aNum - bNum;
          }
          // Fallback to string sort
          return String(aVal).localeCompare(String(bVal));
        }
        if (hasA && !hasB) return -1; // A comes first
        if (!hasA && hasB) return 1;  // B comes first
      }

      // 2. Existing fallback logic
      const aChild = a.relations.has('child') ? 0 : 1;
      const bChild = b.relations.has('child') ? 0 : 1;
      if (aChild !== bChild) return aChild - bChild;
      const aMd = a.file.extension?.toLowerCase() === 'md' ? 0 : 1;
      const bMd = b.file.extension?.toLowerCase() === 'md' ? 0 : 1;
      // Status sort
      const statusWeight = (file: TFile) => {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const status = fm?.status || 'open';
        if (status === 'working') return 1;
        if (status === 'blocked') return 2;
        if (status === 'open') return 3;
        return 4; // wont-do or implicit completed
      };

      const aStatus = statusWeight(a.file);
      const bStatus = statusWeight(b.file);
      if (aStatus !== bStatus) return aStatus - bStatus;

      return a.file.basename.localeCompare(b.file.basename);
    });

    const nodes: SubitemNode[] = [];
    for (const entry of relationEntries) {
      const targetPath = normalizePath(entry.file.path);
      if (visited.has(targetPath)) continue;

      const nextVisited = new Set(visited);
      nextVisited.add(targetPath);

      const childNodes = entry.file.extension?.toLowerCase() === 'md'
        ? await this.buildSubitemTreeRecursive(entry.file, parentIndex, nextVisited, depth + 1)
        : [];

      nodes.push({
        file: entry.file,
        relations: Array.from(entry.relations.values()),
        children: childNodes,
      });
    }

    return nodes;
  }

  private getSortField(): string {
    const pluginApi: any = (this.app as any)?.plugins;
    const nn: any =
      pluginApi?.plugins?.['notebook-navigator'] ??
      pluginApi?.getPlugin?.('notebook-navigator');
    return nn?.settings?.smartSort?.field || 'navigator_sort';
  }

  private isArchived(file: TFile): boolean {
    const archiveFolder = this.plugin.getArchiveFolderPath();
    if (!archiveFolder) {
      return false;
    }
    if (file.path.startsWith(`${archiveFolder}/`)) {
      return true;
    }

    const archiveTag = normalizeTagValue(this.plugin.settings.archiveTag || 'archive');
    if (archiveTag) {
      const cache = this.app.metadataCache.getFileCache(file);
      const tags = getAllTags(cache) || [];
      // Check for exact tag or nested tag match
      if (tags.some(t => {
        const norm = normalizeTagValue(t);
        return norm === archiveTag || norm.startsWith(`${archiveTag}/`);
      })) {
        return true;
      }
    }

    return false;
  }

  private buildParentToChildrenIndex(): Map<string, TFile[]> {
    const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'parent').trim() || 'parent';
    const index = new Map<string, TFile[]>();

    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
      const parentRaw = this.getFrontmatterValueCaseInsensitive(fm, parentKey);
      const parentFiles = this.parseLinksFromFrontmatterValue(parentRaw, file.path);
      for (const parent of parentFiles) {
        if (parent.path === file.path) continue;
        const bucket = index.get(parent.path) || [];
        if (!bucket.some((child) => child.path === file.path)) {
          bucket.push(file);
        }
        index.set(parent.path, bucket);
      }
    }

    return index;
  }

  private async collectDirectSubitemRelations(
    file: TFile,
    parentIndex: Map<string, TFile[]>
  ): Promise<Map<string, SubitemRelationEntry>> {
    const map = new Map<string, SubitemRelationEntry>();

    const addRelation = (target: TFile, relation: SubitemRelationKind) => {
      if (!(target instanceof TFile)) return;
      if (target.path === file.path) return;
      const key = normalizePath(target.path);
      const current = map.get(key);
      if (current) {
        current.relations.add(relation);
        return;
      }
      map.set(key, { file: target, relations: new Set([relation]) });
    };

    const linkedChildren = parentIndex.get(file.path) || [];
    linkedChildren.forEach((child) => addRelation(child, 'child'));

    const attachmentFiles = await this.resolveAttachmentFilesFromFrontmatter(file);
    attachmentFiles.forEach((attachment) => addRelation(attachment, 'attachment'));

    return map;
  }

  private async resolveAttachmentFilesFromFrontmatter(file: TFile): Promise<TFile[]> {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter || {}) as Record<string, any>;
    const collected = new Map<string, TFile>();

    const frontmatterAttachments = this.parseLinksFromFrontmatterValue(
      this.getFrontmatterValueCaseInsensitive(fm, ATTACHMENTS_FRONTMATTER_KEY),
      file.path
    );
    frontmatterAttachments.forEach((attachment) => {
      if (attachment.path !== file.path) {
        collected.set(attachment.path, attachment);
      }
    });

    const inlineEmbeds = await this.resolveInlineEmbedAttachments(file);
    inlineEmbeds.forEach((attachment) => {
      if (attachment.path !== file.path) {
        collected.set(attachment.path, attachment);
      }
    });

    return Array.from(collected.values());
  }

  private async resolveInlineEmbedAttachments(file: TFile): Promise<TFile[]> {
    const resolved = new Map<string, TFile>();
    const pushTarget = (rawTarget: string) => {
      const targetFile = this.resolveLinkTargetToFile(rawTarget, file.path);
      if (!targetFile || targetFile.path === file.path) return;
      resolved.set(targetFile.path, targetFile);
    };

    const cache = this.app.metadataCache.getFileCache(file) as any;
    const embeds = Array.isArray(cache?.embeds) ? cache.embeds : [];
    embeds.forEach((embed: any) => {
      if (typeof embed?.link === 'string' && embed.link.trim()) {
        pushTarget(embed.link);
      }
    });

    if (resolved.size > 0) {
      return Array.from(resolved.values());
    }

    try {
      const raw = await this.app.vault.cachedRead(file);
      const patterns = [/!\[\[([^\]]+)\]\]/g, /!\[[^\]]*]\(([^)]+)\)/g];
      for (const pattern of patterns) {
        let match: RegExpExecArray | null = null;
        while ((match = pattern.exec(raw)) !== null) {
          const candidate = match[1];
          if (candidate) pushTarget(candidate);
        }
      }
    } catch (error) {
      logger.warn('[TPS GCM] Failed to parse inline embeds for', file.path, error);
    }

    return Array.from(resolved.values());
  }

  private parseLinksFromFrontmatterValue(value: any, sourcePath: string): TFile[] {
    const output = new Map<string, TFile>();

    const consume = (candidate: any) => {
      if (candidate === null || candidate === undefined) return;
      if (Array.isArray(candidate)) {
        candidate.forEach((entry) => consume(entry));
        return;
      }

      if (typeof candidate === 'string') {
        const targets = this.extractLinkTargetsFromText(candidate, true);
        targets.forEach((target) => {
          const resolved = this.resolveLinkTargetToFile(target, sourcePath);
          if (resolved) output.set(resolved.path, resolved);
        });
        return;
      }

      if (typeof candidate === 'number' || typeof candidate === 'boolean') {
        const resolved = this.resolveLinkTargetToFile(String(candidate), sourcePath);
        if (resolved) output.set(resolved.path, resolved);
      }
    };

    consume(value);
    return Array.from(output.values());
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

    const markdownPattern = /!?\[[^\]]*]\(([^)]+)\)/g;
    let markdownMatch: RegExpExecArray | null = null;
    while ((markdownMatch = markdownPattern.exec(text)) !== null) {
      matchedStructuredLink = true;
      push(markdownMatch[1]);
    }

    if (allowBareValue && !matchedStructuredLink) {
      text.split(/[\n,;]/).forEach((chunk) => push(chunk));
    }

    return targets;
  }

  private normalizeLinkTarget(rawTarget: string): string {
    let target = String(rawTarget || '').trim();
    if (!target) return '';

    if (target.startsWith('<') && target.endsWith('>')) {
      target = target.slice(1, -1).trim();
    }

    target = target.replace(/^!/, '').trim();
    target = target.replace(/^['"]|['"]$/g, '').trim();

    const pipeIndex = target.indexOf('|');
    if (pipeIndex >= 0) {
      target = target.slice(0, pipeIndex).trim();
    }

    const hashIndex = target.indexOf('#');
    if (hashIndex >= 0) {
      target = target.slice(0, hashIndex).trim();
    }

    if (!target) return '';

    try {
      target = decodeURIComponent(target);
    } catch {
      // Keep raw target when it is not URI encoded.
    }

    return target;
  }

  private resolveLinkTargetToFile(rawTarget: string, sourcePath: string): TFile | null {
    const target = this.normalizeLinkTarget(rawTarget);
    if (!target || this.isLikelyExternalLink(target)) return null;

    const resolved = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
    if (resolved instanceof TFile) return resolved;

    const normalized = normalizePath(target.replace(/^\/+/, ''));
    const direct = this.app.vault.getAbstractFileByPath(normalized);
    if (direct instanceof TFile) return direct;

    if (!/\.[a-z0-9]+$/i.test(normalized)) {
      const withMd = this.app.vault.getAbstractFileByPath(`${normalized}.md`);
      if (withMd instanceof TFile) return withMd;
    }

    return null;
  }

  private isLikelyExternalLink(value: string): boolean {
    return /^(https?:|mailto:|tel:|file:|data:)/i.test(String(value || '').trim());
  }

  private getFrontmatterValueCaseInsensitive(
    frontmatter: Record<string, any> | null | undefined,
    key: string
  ): any {
    if (!frontmatter || typeof frontmatter !== 'object') return undefined;
    const normalized = String(key || '').trim().toLowerCase();
    if (!normalized) return undefined;
    const match = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === normalized);
    return match ? frontmatter[match] : undefined;
  }

  private setFrontmatterValueCaseInsensitive(
    frontmatter: Record<string, any>,
    key: string,
    value: any
  ): void {
    const normalized = String(key || '').trim().toLowerCase();
    if (!normalized) return;
    const existing = Object.keys(frontmatter || {}).find((candidate) => candidate.toLowerCase() === normalized);
    if (existing && existing !== key) {
      delete frontmatter[existing];
    }
    frontmatter[key] = value;
  }

  private createSubitemRow(
    container: HTMLElement,
    node: SubitemNode,
    depth: number,
    rootFile: TFile,
    onRefresh: () => void
  ): void {
    const entry = this.delegates.createFileEntries([node.file])[0];
    const fm = this.getResolvedFrontmatter(node.file, (entry?.frontmatter || {}) as Record<string, any>);
    const relationSet = new Set(node.relations || []);
    const isAttachmentOnly = relationSet.has('attachment') && !relationSet.has('child');
    const row = document.createElement('div');
    row.className = 'tps-gcm-subitem-row';
    row.style.setProperty('--tps-gcm-subitem-depth', String(depth));
    row.dataset.path = node.file.path;
    row.dataset.file = node.file.path;
    row.dataset.relation = isAttachmentOnly ? 'attachment' : 'child';
    if (isAttachmentOnly) {
      row.classList.add('tps-gcm-subitem-row--attachment');
    }

    // Drag support
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('text/plain', node.file.path);
      e.dataTransfer?.setData('application/tps-gcm-subitem', JSON.stringify({
        path: node.file.path,
        relation: isAttachmentOnly ? 'attachment' : 'child',
        rootPath: rootFile.path,
      }));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      row.classList.add('tps-gcm-subitem-row--dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('tps-gcm-subitem-row--dragging');
    });

    const iconEl = document.createElement('span');
    iconEl.className = 'tps-gcm-subitem-icon';
    this.createSubitemIcon(iconEl, node.file, fm);
    row.appendChild(iconEl);

    const titleButton = document.createElement('button');
    titleButton.type = 'button';
    titleButton.className = 'tps-gcm-subitem-title';
    titleButton.textContent = String(fm.title || node.file.basename || node.file.name);
    titleButton.title = node.file.path;
    addSafeClickListener(titleButton, () => this.openFileInPreferredLeaf(node.file));
    row.appendChild(titleButton);

    if (isAttachmentOnly) {
      const relationBadge = document.createElement('span');
      relationBadge.className = 'tps-gcm-subitem-relation tps-gcm-subitem-relation--attachment';
      relationBadge.textContent = 'attachment';
      row.appendChild(relationBadge);
    } else {
      const strip = this.createContextStrip([entry]);
      strip.classList.add('tps-gcm-subitem-strip');
      row.appendChild(strip);
    }

    container.appendChild(row);

    if (node.children.length > 0) {
      const childrenWrap = document.createElement('div');
      childrenWrap.className = 'tps-gcm-subitem-children';
      container.appendChild(childrenWrap);
      node.children.forEach((child) => {
        this.createSubitemRow(childrenWrap, child, depth + 1, rootFile, onRefresh);
      });
    }
  }

  private createSubitemIcon(iconEl: HTMLElement, file: TFile, frontmatter: Record<string, any>): void {
    const iconValue = this.resolveFrontmatterIcon(file, frontmatter);
    const color = this.resolveFrontmatterColor(frontmatter, file);
    if (color) {
      iconEl.style.color = color;
    } else {
      iconEl.style.removeProperty('color');
    }

    if (!iconValue) {
      const rendered = this.trySetIcon(iconEl, [
        file.extension?.toLowerCase() === 'md' ? 'file-text' : 'paperclip',
        'file',
        'document',
        'circle',
      ]);
      if (!rendered) this.ensureSubitemIconVisible(iconEl);
      return;
    }

    if (/[\u2600-\u27BF\u{1F300}-\u{1FAFF}]/u.test(iconValue)) {
      iconEl.textContent = iconValue;
      iconEl.classList.add('tps-gcm-subitem-icon--emoji');
      return;
    }

    try {
      const rendered = this.trySetIcon(iconEl, [
        iconValue,
        'file-text',
        'file',
        'document',
        'circle',
      ]);
      if (!rendered) this.ensureSubitemIconVisible(iconEl);
    } catch {
      iconEl.textContent = iconValue.charAt(0).toUpperCase();
      iconEl.classList.add('tps-gcm-subitem-icon--emoji');
    }
  }

  /** Strip vendor prefixes like "lucide:" or "lucide-" that Notebook Navigator stores in frontmatter. */
  private normalizeIconId(id: string): string {
    return id.replace(/^lucide[:\-]/i, '');
  }

  private trySetIcon(iconEl: HTMLElement, candidates: string[]): boolean {
    const unique = Array.from(new Set(
      candidates.map((c) => this.normalizeIconId(String(c || '').trim())).filter(Boolean)
    ));
    for (const id of unique) {
      try {
        iconEl.innerHTML = '';
        iconEl.classList.remove('tps-gcm-subitem-icon--emoji');
        setIcon(iconEl, id);
        if (iconEl.querySelector('svg')) return true;
      } catch {
        // continue to next icon id
      }
    }
    return false;
  }

  private getResolvedFrontmatter(file: TFile, fallback: Record<string, any>): Record<string, any> {
    const cacheFm = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
    return { ...fallback, ...cacheFm };
  }

  private resolveFrontmatterIcon(file: TFile, frontmatter: Record<string, any>): string {
    const pickString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
    const fromIconField = pickString(frontmatter?.icon);
    if (fromIconField) return fromIconField;

    const pluginsApi: any = (this.app as any)?.plugins;
    const companion: any = pluginsApi?.plugins?.['tps-notebook-navigator-companion'];
    const configuredIconField = pickString(companion?.settings?.frontmatterIconField);
    if (configuredIconField) {
      const configuredValue = pickString(this.getFrontmatterValueCaseInsensitive(frontmatter, configuredIconField));
      if (configuredValue) return configuredValue;
    }

    const ruleEngine: any = companion?.ruleEngine;
    if (companion?.settings?.enabled && ruleEngine?.resolveVisualOutputs) {
      try {
        const cache = this.app.metadataCache.getFileCache(file) as any;
        const cacheTags = Array.isArray(cache?.tags)
          ? cache.tags.map((entry: any) => String(entry?.tag || '').replace(/^#+/, '').trim().toLowerCase()).filter(Boolean)
          : [];
        const visual = ruleEngine.resolveVisualOutputs(companion.settings.rules || [], {
          file: {
            path: file.path,
            name: file.name,
            basename: file.basename,
            extension: file.extension,
          },
          frontmatter,
          tags: Array.from(new Set(cacheTags)),
        });
        const ruleIcon = pickString(visual?.icon?.value);
        if (ruleIcon) return ruleIcon;
      } catch (error) {
        logger.warn('[TPS GCM] Failed resolving companion icon for subitem:', file.path, error);
      }
    }

    return '';
  }

  private ensureSubitemIconVisible(iconEl: HTMLElement): void {
    const hasSvg = !!iconEl.querySelector('svg');
    const hasText = String(iconEl.textContent || '').trim().length > 0;
    if (hasSvg || hasText) return;
    iconEl.textContent = '•';
    iconEl.classList.add('tps-gcm-subitem-icon--emoji');
  }

  private resolveFrontmatterColor(frontmatter: Record<string, any>, file?: TFile): string {
    const companionColor = file ? this.resolveCompanionRuleColor(file, frontmatter) : '';
    if (companionColor) {
      return companionColor;
    }

    const candidates = ['iconColor', 'color', 'accentColor', 'accent'];
    for (const key of candidates) {
      const raw = frontmatter?.[key];
      if (typeof raw !== 'string') continue;
      const value = raw.trim();
      if (!value) continue;
      if (this.isValidCssColor(value)) {
        return value;
      }
    }
    return '';
  }

  private isValidCssColor(value: string): boolean {
    const normalized = String(value || '').trim();
    if (!normalized) return false;
    if (normalized.startsWith('var(')) return true;
    if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('color', normalized)) {
      return true;
    }
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(normalized);
  }

  private resolveCompanionRuleColor(file: TFile, frontmatter: Record<string, any>): string {
    const pluginsApi: any = (this.app as any)?.plugins;
    const companion: any = pluginsApi?.plugins?.['tps-notebook-navigator-companion'];
    if (!companion?.settings?.enabled) return '';

    const ruleEngine: any = companion.ruleEngine;
    if (!ruleEngine || typeof ruleEngine.resolveVisualOutputs !== 'function') return '';

    const cache = this.app.metadataCache.getFileCache(file) as any;
    const cacheTags = Array.isArray(cache?.tags)
      ? cache.tags
        .map((entry: any) => (typeof entry?.tag === 'string' ? entry.tag : ''))
        .filter((tag: string) => !!tag)
      : [];
    const fmTagsRaw = frontmatter?.tags;
    const fmTags = Array.isArray(fmTagsRaw)
      ? fmTagsRaw.map((tag: any) => String(tag || ''))
      : typeof fmTagsRaw === 'string'
        ? fmTagsRaw.split(/[\s,]+/)
        : [];
    const normalizedTags = Array.from(
      new Set(
        [...cacheTags, ...fmTags]
          .map((tag) => String(tag || '').replace(/^#+/, '').trim().toLowerCase())
          .filter(Boolean)
      )
    );

    const context = {
      file: {
        path: file.path,
        name: file.name,
        basename: file.basename,
        extension: file.extension,
      },
      frontmatter,
      tags: normalizedTags,
    };

    try {
      const visual = ruleEngine.resolveVisualOutputs(companion.settings.rules || [], context);
      const color = String(visual?.color?.value || '').trim();
      return this.isValidCssColor(color) ? color : '';
    } catch (error) {
      logger.warn('[TPS GCM] Failed resolving companion color for subitem:', file.path, error);
      return '';
    }
  }

  private createSubitemPillButton(label: string, kind: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tps-gcm-subitem-pill tps-gcm-subitem-pill--${kind}`;
    button.textContent = label;
    return button;
  }

  private createSubitemActionButton(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tps-gcm-subitem-action';
    button.textContent = label;
    addSafeClickListener(button, () => onClick());
    return button;
  }

  private openFileInPreferredLeaf(file: TFile): void {
    void this.plugin.openFileInLeaf(file, false, () => this.app.workspace.getLeaf(false), { revealLeaf: true });
  }

  private async promptLinkToParent(file: TFile, onRefresh: () => void): Promise<void> {
    new FileSuggestModal(this.app, async (parentFile: TFile) => {
      await this.plugin.bulkEditService.linkToParent([file], parentFile);
      new Notice(`Linked ${file.basename} to parent: ${parentFile.basename}`);
      onRefresh();
    }).open();
  }

  private async promptLinkChildren(file: TFile, onRefresh: () => void): Promise<void> {
    new MultiFileSelectModal(this.app, async (childFiles: TFile[]) => {
      const unique = childFiles.filter((candidate) => candidate.path !== file.path);
      if (!unique.length) return;
      await this.plugin.bulkEditService.linkChildren(file, unique);
      new Notice(`Linked ${unique.length} child item(s) to ${file.basename}.`);
      onRefresh();
    }).open();
  }

  private async promptAttachFiles(parentFile: TFile, onRefresh: () => void): Promise<void> {
    if (parentFile.extension?.toLowerCase() !== 'md') {
      new Notice('Attachments can only be managed from markdown notes.');
      return;
    }

    new MultiFileSelectModal(this.app, async (files: TFile[]) => {
      const added = await this.addFilesToAttachmentsFrontmatter(parentFile, files);
      if (added > 0) {
        new Notice(`Attached ${added} item(s) to ${parentFile.basename}.`);
        onRefresh();
      }
    }).open();
  }

  private async addFilesToAttachmentsFrontmatter(parentFile: TFile, files: TFile[]): Promise<number> {
    if (parentFile.extension?.toLowerCase() !== 'md') return 0;
    const uniqueFiles = files.filter((file, index) => file.path !== parentFile.path && files.findIndex((f) => f.path === file.path) === index);
    if (!uniqueFiles.length) return 0;

    let added = 0;
    await this.app.fileManager.processFrontMatter(parentFile, (frontmatter: Record<string, any>) => {
      const existingRaw = this.getFrontmatterValueCaseInsensitive(frontmatter, ATTACHMENTS_FRONTMATTER_KEY);
      const values: string[] = [];
      const seen = new Set<string>();

      const pushValue = (raw: any) => {
        if (typeof raw !== 'string') return;
        const trimmed = raw.trim();
        if (!trimmed) return;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        values.push(trimmed);
      };

      if (Array.isArray(existingRaw)) {
        existingRaw.forEach((entry) => pushValue(entry));
      } else {
        pushValue(existingRaw);
      }

      const startCount = values.length;
      uniqueFiles.forEach((file) => {
        const link = this.app.fileManager.generateMarkdownLink(file, parentFile.path);
        pushValue(link);
      });

      added = values.length - startCount;
      this.setFrontmatterValueCaseInsensitive(frontmatter, ATTACHMENTS_FRONTMATTER_KEY, values);
    });

    return added;
  }

  /**
   * Remove a file from the root's `attachments` frontmatter list.
   */
  private async removeFromAttachmentsFrontmatter(rootFile: TFile, targetFile: TFile): Promise<void> {
    await this.app.fileManager.processFrontMatter(rootFile, (fm: Record<string, any>) => {
      const existingRaw = this.getFrontmatterValueCaseInsensitive(fm, ATTACHMENTS_FRONTMATTER_KEY);
      const existing = this.parseLinksFromFrontmatterValue(existingRaw, rootFile.path);
      const filtered = existing.filter((f) => f.path !== targetFile.path);
      const existingKey = Object.keys(fm).find((k) => k.toLowerCase() === ATTACHMENTS_FRONTMATTER_KEY.toLowerCase());
      if (filtered.length === 0) {
        if (existingKey) delete fm[existingKey];
      } else {
        const links = filtered.map((f) => this.app.fileManager.generateMarkdownLink(f, rootFile.path));
        this.setFrontmatterValueCaseInsensitive(fm, ATTACHMENTS_FRONTMATTER_KEY, links);
      }
    });
  }

  /**
   * Change a child → attachment:
   * - Remove `parent` key from child's frontmatter
   * - Add child to root's `attachments` frontmatter
   */
  private async changeRelationToAttachment(rootFile: TFile, childFile: TFile): Promise<void> {
    const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'parent').trim() || 'parent';
    // Remove parent link from child
    await this.app.fileManager.processFrontMatter(childFile, (fm: Record<string, any>) => {
      const existingKey = Object.keys(fm).find((k) => k.toLowerCase() === parentKey.toLowerCase());
      if (existingKey) delete fm[existingKey];
    });
    // Add to root's attachments
    await this.addFilesToAttachmentsFrontmatter(rootFile, [childFile]);
  }

  /**
   * Change an attachment → child (subitem):
   * - Remove file from root's `attachments` frontmatter
   * - Set `parent: [[rootFile]]` in the target file's frontmatter
   */
  private async changeRelationToChild(rootFile: TFile, targetFile: TFile): Promise<void> {
    // Remove from attachments
    await this.removeFromAttachmentsFrontmatter(rootFile, targetFile);
    // Set parent link through bulk service so format + parent-tag settings stay centralized.
    await this.plugin.bulkEditService.linkToParent([targetFile], rootFile);
  }

  private showSubitemAddMenu(event: MouseEvent, file: TFile): void {
    const menu = new Menu();
    const isMarkdown = file.extension?.toLowerCase() === 'md';

    if (isMarkdown) {
      menu.addItem((item) => {
        item.setTitle('Add to note...')
          .setIcon('file-plus')
          .onClick(() => {
            void this.plugin.noteOperationService.addNotesToAnotherNote([file]);
          });
      });

      menu.addItem((item) => {
        item.setTitle('Add to daily note...')
          .setIcon('calendar-plus')
          .onClick(() => {
            void this.plugin.noteOperationService.addNotesToDailyNotes([file]);
          });
      });
    }

    menu.addItem((item) => {
      item.setTitle('Add to board...')
        .setIcon('layout-grid')
        .onClick(() => {
          void this.addFilesToBoard([file]);
        });
    });

    menu.showAtMouseEvent(event);
  }

  private getDefaultSubitemFolderPath(parentFile: TFile): string {
    return this.plugin.settings.defaultSubitemsPath || parentFile.parent?.path || '/';
  }

  private async createSubitemForParent(parentFile: TFile): Promise<TFile | null> {
    if (parentFile.extension?.toLowerCase() !== 'md') {
      new Notice('Subitems can only be created under markdown notes.');
      return null;
    }

    const folderOptions = this.getFolderPathOptions();
    const defaultFolderPath = this.getDefaultSubitemFolderPath(parentFile);
    const selection = await new Promise<{ title: string; folderPath: string } | null>((resolve) => {
      const modal = new CreateSubitemModal(this.app, folderOptions, defaultFolderPath, resolve);
      modal.open();
    });

    if (!selection) return null;
    return this.createSubitemForParentWithTitle(parentFile, selection.title, selection.folderPath);
  }

  private async createSubitemForParentWithTitle(
    parentFile: TFile,
    title: string,
    folderPathSelection?: string
  ): Promise<TFile | null> {
    const cleanedTitle = this.sanitizeSubitemTitle(title);
    if (!cleanedTitle) {
      new Notice('Subitem title cannot be empty.');
      return null;
    }

    const folderInput = String(folderPathSelection ?? this.getDefaultSubitemFolderPath(parentFile) ?? '/').trim() || '/';
    const folderPath = folderInput === '/' ? '' : normalizePath(folderInput);
    if (folderPath) {
      await this.ensureFolderPath(folderPath);
    }

    const targetPath = this.getUniqueMarkdownPath(folderPath, cleanedTitle);
    const escapedTitle = cleanedTitle.replace(/"/g, '\\"');
    const frontmatterLines = [
      '---',
      `title: "${escapedTitle}"`,
      'status: open',
      'priority: normal',
    ];
    if (this.plugin.settings.autoSaveFolderPath) {
      frontmatterLines.push(`folderPath: "${(folderPath || '/').replace(/"/g, '\\"')}"`);
    }
    if (this.plugin.settings.seedNewSubitemVisualMetadata) {
      const iconDefaults = this.resolveNewSubitemIconDefaults(parentFile, folderPath);
      if (iconDefaults.icon) {
        frontmatterLines.push(`icon: "${iconDefaults.icon.replace(/"/g, '\\"')}"`);
      }
      if (iconDefaults.iconColor) {
        const escapedColor = iconDefaults.iconColor.replace(/"/g, '\\"');
        // Persist both keys so first-render color works across icon/title renderers.
        frontmatterLines.push(`iconColor: "${escapedColor}"`);
        frontmatterLines.push(`color: "${escapedColor}"`);
      }
    }

    // Inherit parent file's tags
    const parentCache = this.app.metadataCache.getFileCache(parentFile);
    const parentFrontmatter = (parentCache?.frontmatter || {}) as Record<string, any>;
    const parentTags = parseTagInput([parentFrontmatter.tags, parentFrontmatter.tag]);
    if (parentTags.length > 0) {
      const tagsYaml = parentTags.map((tag) => `#${tag}`).join(' ');
      frontmatterLines.push(`tags: "${tagsYaml.replace(/"/g, '\\"')}"`);
    }

    frontmatterLines.push('---', '');
    const initialContent = `${frontmatterLines.join('\n')}\n`;

    let created: TFile;
    try {
      created = await this.app.vault.create(targetPath, initialContent);
    } catch (error) {
      logger.error('[TPS GCM] Failed creating subitem:', error);
      new Notice('Failed to create subitem.');
      return null;
    }

    try {
      await this.plugin.bulkEditService.linkToParent([created], parentFile);
    } catch (error) {
      logger.error('[TPS GCM] Failed linking new subitem to parent:', error);
      new Notice('Created subitem, but failed to link to parent.');
    }

    if (this.plugin.settings.applyCompanionRulesOnSubitemCreate) {
      await this.applyCompanionRulesToFile(created);
    }

    // Merge parent tags with any tags that may have been added by templater
    await this.mergeParentTagsIntoSubitem(created, parentTags);

    new Notice(`Created subitem: ${created.basename}`);
    return created;
  }

  private async applyCompanionRulesToFile(file: TFile): Promise<void> {
    const pluginsApi: any = (this.app as any)?.plugins;
    const companion: any = pluginsApi?.plugins?.['tps-notebook-navigator-companion'];
    if (!companion?.settings?.enabled) return;

    const applyRulesToFile = companion.applyRulesToFile;
    if (typeof applyRulesToFile !== 'function') return;

    try {
      await applyRulesToFile.call(companion, file, { reason: 'gcm-subitem-create', force: true });
    } catch (error) {
      logger.warn('[TPS GCM] Failed applying companion rules after subitem create:', file.path, error);
    }
  }

  private async mergeParentTagsIntoSubitem(file: TFile, parentTags: string[]): Promise<void> {
    if (parentTags.length === 0) return;

    // Wait a moment for templater to potentially process the file
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      const cache = this.app.metadataCache.getFileCache(file);
      const currentFrontmatter = (cache?.frontmatter || {}) as Record<string, any>;
      const currentTags = parseTagInput([currentFrontmatter.tags, currentFrontmatter.tag]);

      // Merge parent tags with any tags from template
      const mergedTags = mergeNormalizedTags(parentTags, currentTags);

      // Only update if tags actually changed
      const currentTagsStr = JSON.stringify(currentTags.sort());
      const mergedTagsStr = JSON.stringify(
        mergedTags.map((t) => t.replace(/^#/, '')).sort()
      );

      if (currentTagsStr !== mergedTagsStr) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          this.setFrontmatterValueCaseInsensitive(fm, 'tags', mergedTags);
        });
      }
    } catch (error) {
      logger.warn('[TPS GCM] Failed merging parent tags into subitem:', file.path, error);
    }
  }

  private resolveNewSubitemIconDefaults(
    parentFile: TFile,
    folderPath: string
  ): { icon: string; iconColor: string } {
    const fromParent = this.resolveIconDefaultsFromFile(parentFile);
    const fromFolder = this.resolveIconDefaultsFromFolder(folderPath);

    return {
      icon: fromParent.icon || fromFolder.icon,
      iconColor: fromParent.iconColor || fromFolder.iconColor,
    };
  }

  private resolveIconDefaultsFromFile(file: TFile): { icon: string; iconColor: string } {
    const cache = this.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter || {}) as Record<string, any>;
    const icon = this.readFrontmatterStringCaseInsensitive(fm, ['icon']);
    const iconColor = this.readFrontmatterStringCaseInsensitive(fm, ['iconColor', 'color', 'accentColor', 'accent']);
    return { icon, iconColor };
  }

  private resolveIconDefaultsFromFolder(folderPath: string): { icon: string; iconColor: string } {
    const normalizedFolder = normalizePath((folderPath || '').trim());
    const folderFiles = this.app.vault
      .getMarkdownFiles()
      .filter((file) => (file.parent?.path || '') === normalizedFolder);

    const iconCounts = new Map<string, number>();
    const colorCounts = new Map<string, number>();

    for (const file of folderFiles) {
      const { icon, iconColor } = this.resolveIconDefaultsFromFile(file);
      if (icon) {
        iconCounts.set(icon, (iconCounts.get(icon) || 0) + 1);
      }
      if (iconColor) {
        colorCounts.set(iconColor, (colorCounts.get(iconColor) || 0) + 1);
      }
    }

    const pickMostCommon = (counts: Map<string, number>): string => {
      let best = '';
      let bestCount = -1;
      for (const [value, count] of counts.entries()) {
        if (count > bestCount) {
          best = value;
          bestCount = count;
        }
      }
      return best;
    };

    return {
      icon: pickMostCommon(iconCounts),
      iconColor: pickMostCommon(colorCounts),
    };
  }

  private readFrontmatterStringCaseInsensitive(
    frontmatter: Record<string, any> | null | undefined,
    keys: string[]
  ): string {
    if (!frontmatter || typeof frontmatter !== 'object') return '';
    for (const key of keys) {
      const value = this.getFrontmatterValueCaseInsensitive(frontmatter, key);
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) return trimmed;
      }
    }
    return '';
  }

  private getFolderPathOptions(): string[] {
    const paths = new Set<string>(['/']);
    const folders = this.app.vault.getAllLoadedFiles().filter((item): item is TFolder => item instanceof TFolder);
    folders.forEach((folder) => paths.add(folder.path || '/'));
    return Array.from(paths.values()).sort((a, b) => {
      if (a === '/') return -1;
      if (b === '/') return 1;
      return a.localeCompare(b);
    });
  }

  private sanitizeSubitemTitle(rawTitle: string): string {
    return String(rawTitle || '')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private getUniqueMarkdownPath(folderPath: string, basename: string): string {
    const prefix = folderPath ? `${folderPath}/` : '';
    let counter = 1;
    let candidate = normalizePath(`${prefix}${basename}.md`);
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      counter += 1;
      candidate = normalizePath(`${prefix}${basename} ${counter}.md`);
    }
    return candidate;
  }

  // --- Action Triggers ---

  private async ensureEditModeAndExecute(callback: () => void): Promise<void> {
    const activeLeaf = this.app.workspace.activeLeaf;
    const view = activeLeaf?.view;

    if (!(view instanceof MarkdownView)) {
      new Notice('No markdown note is active.');
      return;
    }

    const isPreviewMode = (view as any).currentMode?.type === 'preview';

    if (isPreviewMode) {
      // Switch to edit mode
      const state = activeLeaf.getViewState();
      state.state.mode = 'source';
      await activeLeaf.setViewState(state);

      // Wait a bit for mode switch
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    callback();
  }

  private async createNoteAndAddAsAttachment(parentFile: TFile): Promise<void> {
    if (parentFile.extension?.toLowerCase() !== 'md') {
      new Notice('Parent must be a markdown note.');
      return;
    }

    const modal = await new Promise<{ title: string; folderPath: string } | null>((resolve) => {
      const defaultFolderPath = this.plugin.settings.defaultAttachmentsPath || parentFile.parent?.path || '/';
      const createModal = new CreateSubitemModal(this.app, this.getFolderPathOptions(), defaultFolderPath, resolve);
      createModal.open();
      // Override title to make it clear this is for creating a note
      createModal.titleEl.textContent = 'Create New Note';
    });

    if (!modal) return;

    const cleanedTitle = this.sanitizeSubitemTitle(modal.title);
    if (!cleanedTitle) {
      new Notice('Note title cannot be empty.');
      return;
    }

    const folderPath = modal.folderPath === '/' ? '' : normalizePath(modal.folderPath);
    if (folderPath) {
      await this.ensureFolderPath(folderPath);
    }

    const targetPath = this.getUniqueMarkdownPath(folderPath, cleanedTitle);
    const escapedTitle = cleanedTitle.replace(/"/g, '\\"');
    const initialContent = `---\ntitle: "${escapedTitle}"\n---\n\n`;

    let created: TFile;
    try {
      created = await this.app.vault.create(targetPath, initialContent);
    } catch (error) {
      logger.error('[TPS GCM] Failed creating note:', error);
      new Notice('Failed to create note.');
      return;
    }

    // Add to parent's attachments field
    try {
      const parentCache = this.app.metadataCache.getFileCache(parentFile);
      const parentFm = (parentCache?.frontmatter || {}) as Record<string, any>;
      const existingRaw = this.getFrontmatterValueCaseInsensitive(parentFm, ATTACHMENTS_FRONTMATTER_KEY);
      const existingAttachments = this.parseLinksFromFrontmatterValue(existingRaw, parentFile.path);

      // Add the new note to the list
      const allAttachments = [...existingAttachments, created];

      const attachmentLinks = allAttachments
        .map((f) => `[[${f.path}]]`)
        .join(', ');
      await this.app.fileManager.processFrontMatter(parentFile, (fm) => {
        this.setFrontmatterValueCaseInsensitive(fm, ATTACHMENTS_FRONTMATTER_KEY, attachmentLinks);
      });
    } catch (error) {
      logger.warn('[TPS GCM] Failed adding note to parent attachments:', error);
    }

    // Ask if user wants to embed and open
    const shouldEmbedAndOpen = await new Promise<boolean>((resolve) => {
      const confirmText = 'Embed & Open';
      const skipText = 'Skip';

      const dialog = new Modal(this.app);
      dialog.titleEl.textContent = 'Embed Note?';
      dialog.contentEl.createEl('p', { text: `Would you like to embed this note in ${parentFile.basename} and open it?` });

      const buttonContainer = dialog.contentEl.createDiv({ cls: 'modal-button-container' });

      const embedBtn = buttonContainer.createEl('button', { text: confirmText, cls: 'mod-cta' });
      embedBtn.onclick = () => {
        dialog.close();
        resolve(true);
      };

      const skipBtn = buttonContainer.createEl('button', { text: skipText });
      skipBtn.onclick = () => {
        dialog.close();
        resolve(false);
      };

      dialog.open();
    });

    if (shouldEmbedAndOpen) {
      // Embed the note in parent (sneaky way that works in reading mode)
      try {
        const parentContent = await this.app.vault.read(parentFile);
        const embedCode = `![[${created.basename}]]`;
        const newContent = `${parentContent.trimRight()}\n\n${embedCode}`;
        await this.app.vault.modify(parentFile, newContent);
      } catch (error) {
        logger.warn('[TPS GCM] Failed embedding note:', error);
      }

      // Open the created note only if embedding was selected
      await this.plugin.openFileInLeaf(created, false, () => this.app.workspace.getLeaf(false), { revealLeaf: true });

      new Notice(`Created note: ${created.basename}`);
    } else {
      // Just notify that the note was created, don't open it
      new Notice(`Created note: ${created.basename}`);
    }
  }

  private async attachExistingNoteAsAttachment(parentFile: TFile): Promise<void> {
    if (parentFile.extension?.toLowerCase() !== 'md') {
      new Notice('Parent must be a markdown note.');
      return;
    }

    // Open file picker to select a note to attach
    const selection = await new Promise<TFile | null>((resolve) => {
      const modal = new FileSuggestModal(this.app, (file: TFile) => {
        resolve(file);
      });
      modal.open();
    });

    if (!selection || selection.path === parentFile.path) {
      if (selection?.path === parentFile.path) {
        new Notice('Cannot attach a note to itself.');
      }
      return;
    }

    // Add to parent's attachments field
    try {
      const parentCache = this.app.metadataCache.getFileCache(parentFile);
      const parentFm = (parentCache?.frontmatter || {}) as Record<string, any>;
      const existingRaw = this.getFrontmatterValueCaseInsensitive(parentFm, ATTACHMENTS_FRONTMATTER_KEY);
      const existingAttachments = this.parseLinksFromFrontmatterValue(existingRaw, parentFile.path);

      // Check if note is already attached
      if (existingAttachments.some((f) => f.path === selection.path)) {
        new Notice(`${selection.basename} is already attached.`);
        return;
      }

      // Add the note to the list
      const allAttachments = [...existingAttachments, selection];

      const attachmentLinks = allAttachments
        .map((f) => `[[${f.path}]]`)
        .join(', ');
      await this.app.fileManager.processFrontMatter(parentFile, (fm) => {
        this.setFrontmatterValueCaseInsensitive(fm, ATTACHMENTS_FRONTMATTER_KEY, attachmentLinks);
      });

      new Notice(`Attached: ${selection.basename}`);
    } catch (error) {
      logger.error('[TPS GCM] Failed attaching note:', error);
      new Notice('Failed to attach note.');
    }

    // Ask if user wants to embed
    const shouldEmbed = await new Promise<boolean>((resolve) => {
      const dialog = new Modal(this.app);
      dialog.titleEl.textContent = 'Embed Note?';
      dialog.contentEl.createEl('p', { text: `Would you like to embed ${selection.basename} in ${parentFile.basename}?` });

      const buttonContainer = dialog.contentEl.createDiv({ cls: 'modal-button-container' });

      const embedBtn = buttonContainer.createEl('button', { text: 'Embed', cls: 'mod-cta' });
      embedBtn.onclick = () => {
        dialog.close();
        resolve(true);
      };

      const skipBtn = buttonContainer.createEl('button', { text: 'Skip' });
      skipBtn.onclick = () => {
        dialog.close();
        resolve(false);
      };

      dialog.open();
    });

    if (shouldEmbed) {
      // Embed the note in parent (sneaky way that works in reading mode)
      try {
        const parentContent = await this.app.vault.read(parentFile);
        const embedCode = `![[${selection.basename}]]`;

        // Check if already embedded
        if (!parentContent.includes(embedCode)) {
          const newContent = `${parentContent.trimRight()}\n\n${embedCode}`;
          await this.app.vault.modify(parentFile, newContent);
        }
      } catch (error) {
        logger.warn('[TPS GCM] Failed embedding note:', error);
      }
    }
  }

  triggerTemplateInsert() {
    const app = this.app as any;
    if (app.plugins?.getPlugin('templater-obsidian')) {
      app.commands.executeCommandById('templater-obsidian:insert-templater');
    } else {
      app.commands.executeCommandById('editor:insert-template');
    }
  }

  triggerHandwriting() {
    const app = this.app as any;
    const cmdId = 'handwritten-notes:quick-create-embed';
    if (app.commands.findCommand(cmdId)) {
      app.commands.executeCommandById(cmdId);
    } else {
      app.commands.executeCommandById('handwritten-notes:modal-create-embed');
    }
  }

  triggerVoiceRecording() {
    const app = this.app as any;
    const commandsApi = app.commands as any;

    const preferredIds = [
      'audio-recorder:start',
      'audio-recorder:start-stop',
      'audio-recorder:start-stop-recording',
      'audio-recorder:record',
      'audio-recorder:insert-recording',
    ];

    for (const id of preferredIds) {
      if (commandsApi?.findCommand?.(id)) {
        commandsApi.executeCommandById(id);
        return;
      }
    }

    const allCommands: Array<{ id?: string; name?: string }> =
      typeof commandsApi?.listCommands === 'function'
        ? commandsApi.listCommands()
        : Object.values(commandsApi?.commands ?? {});

    const discovered = allCommands.find((cmd) => {
      const id = (cmd?.id ?? '').toLowerCase();
      const name = (cmd?.name ?? '').toLowerCase();
      const isAudioRecorder = id.includes('audio-recorder');
      const looksLikeRecordAction =
        name.includes('record') ||
        name.includes('voice') ||
        (name.includes('audio') && name.includes('insert'));
      return isAudioRecorder && looksLikeRecordAction;
    });

    if (discovered?.id && commandsApi?.findCommand?.(discovered.id)) {
      commandsApi.executeCommandById(discovered.id);
      return;
    }

    new Notice('Voice recorder command not found. Enable the core Audio Recorder plugin.');
  }

  async triggerInsertPhoto(): Promise<void> {
    let imageBlob: Blob | null = null;

    if (Platform.isMobile) {
      imageBlob = await this.openImageCaptureInput(true);
    } else {
      imageBlob = await this.capturePhotoWithWebcam();
      if (!imageBlob) {
        imageBlob = await this.openImageCaptureInput(false);
      }
    }

    if (!imageBlob) return;

    const attachmentFile = await this.saveImageBlobAsAttachment(imageBlob);
    if (!attachmentFile) return;

    this.insertAttachmentLinkIntoEditorOrClipboard(attachmentFile);
  }

  private async capturePhotoWithWebcam(): Promise<Blob | null> {
    if (!navigator.mediaDevices?.getUserMedia) {
      return null;
    }

    return new Promise<Blob | null>((resolve) => {
      const modal = new CameraCaptureModal(this.app, resolve);
      modal.open();
    });
  }

  private async openImageCaptureInput(preferCamera: boolean): Promise<Blob | null> {
    return new Promise<Blob | null>((resolve) => {
      const input = document.createElement('input');
      let settled = false;

      const finish = (value: Blob | null) => {
        if (settled) return;
        settled = true;
        try {
          input.remove();
        } catch { }
        resolve(value);
      };

      input.type = 'file';
      input.accept = 'image/*';
      if (preferCamera) {
        input.setAttribute('capture', 'environment');
      }
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      input.style.width = '1px';
      input.style.height = '1px';
      input.style.opacity = '0';

      const handleChange = () => {
        const file = input.files?.[0] ?? null;
        finish(file);
      };

      const handleWindowFocus = () => {
        window.setTimeout(() => {
          if (!settled) {
            finish(null);
          }
        }, 250);
      };

      input.addEventListener('change', handleChange, { once: true });
      window.addEventListener('focus', handleWindowFocus, { once: true });

      document.body.appendChild(input);
      input.click();
    });
  }

  private async saveImageBlobAsAttachment(blob: Blob): Promise<TFile | null> {
    const extension = this.getImageExtension(blob.type);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `photo-${timestamp}.${extension}`;
    const activeFile = this.app.workspace.getActiveFile();
    const sourcePath = activeFile?.path;

    try {
      const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment(filename, sourcePath);
      const data = await blob.arrayBuffer();
      return await this.app.vault.createBinary(attachmentPath, data);
    } catch (error) {
      logger.error('[TPS GCM] Failed saving photo attachment:', error);
      new Notice('Failed to save photo attachment.');
      return null;
    }
  }

  private getImageExtension(mimeType: string): string {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    if (mime.includes('heic') || mime.includes('heif')) return 'heic';
    return 'jpg';
  }

  private insertAttachmentLinkIntoEditorOrClipboard(file: TFile): void {
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const sourcePath = markdownView?.file?.path ?? file.path;
    const markdownLink = this.app.fileManager.generateMarkdownLink(file, sourcePath);

    if (markdownView?.editor) {
      markdownView.editor.replaceSelection(markdownLink);
      new Notice(`Inserted photo: ${file.name}`);
      return;
    }

    try {
      void navigator.clipboard.writeText(markdownLink);
      new Notice(`Saved ${file.name}. Link copied to clipboard.`);
    } catch {
      new Notice(`Saved ${file.name}.`);
    }
  }

  /**
   * Show the Insert menu (Template, Handwriting, Voice Recording, Photo, Create Note)
   */
  showInsertMenu(e: MouseEvent, entries: any[]) {
    const menu = new Menu();
    const isMd = entries.length === 1 && entries[0].file.extension === 'md';

    if (!isMd) return; // Only show for markdown files

    const currentFile = entries[0].file as TFile;

    // Template
    menu.addItem(item => {
      item.setTitle('Insert Template')
        .setIcon('layout-template')
        .onClick(() => {
          this.ensureEditModeAndExecute(() => this.triggerTemplateInsert());
        });
    });

    // Handwriting
    menu.addItem(item => {
      item.setTitle('Create Handwritten Note')
        .setIcon('pencil')
        .onClick(() => {
          this.ensureEditModeAndExecute(() => this.triggerHandwriting());
        });
    });

    // Voice recording (built-in Audio Recorder core plugin)
    menu.addItem(item => {
      item.setTitle('Insert Voice Recording')
        .setIcon('mic')
        .onClick(() => {
          this.ensureEditModeAndExecute(() => this.triggerVoiceRecording());
        });
    });

    menu.addItem(item => {
      item.setTitle('Insert Photo')
        .setIcon('camera')
        .onClick(() => {
          this.ensureEditModeAndExecute(() => this.triggerInsertPhoto());
        });
    });

    menu.addSeparator();

    // Create Note
    menu.addItem(item => {
      item.setTitle('Create Note')
        .setIcon('file-plus')
        .onClick(() => {
          void this.createNoteAndAddAsAttachment(currentFile);
        });
    });

    // Attach Existing Note
    menu.addItem(item => {
      item.setTitle('Attach Existing Note')
        .setIcon('link')
        .onClick(() => {
          void this.attachExistingNoteAsAttachment(currentFile);
        });
    });

    menu.showAtMouseEvent(e);
  }

  showLinkMenu(e: MouseEvent, entries: any[]) {
    const menu = new Menu();
    const sourceFiles = entries
      .map((entry) => entry?.file)
      .filter((file): file is TFile => file instanceof TFile);
    const markdownFiles = sourceFiles.filter((file) => file.extension?.toLowerCase() === 'md');
    const currentFile = sourceFiles[0];

    menu.addItem(item => {
      item.setTitle('Link to Parent')
        .setIcon('link')
        .onClick(() => {
          new FileSuggestModal(this.app, async (file: TFile) => {
            await this.plugin.bulkEditService.linkToParent(entries.map(e => e.file), file);
            new Notice(`Linked to parent: ${file.basename}`);
          }).open();
        });
    });

    menu.addItem(item => {
      item.setTitle('Link Children')
        .setIcon('network')
        .onClick(() => {
          if (!currentFile) {
            new Notice('No source file selected.');
            return;
          }
          new MultiFileSelectModal(this.app, async (files: TFile[]) => {
            if (files.length > 0) {
              await this.plugin.bulkEditService.linkChildren(currentFile, files);
              new Notice(`Linked ${files.length} children.`);
            }
          }).open();
        });
    });

    menu.addItem(item => {
      item.setTitle('Link Attachments')
        .setIcon('paperclip')
        .onClick(() => {
          if (!currentFile) {
            new Notice('No source file selected.');
            return;
          }
          new MultiFileSelectModal(this.app, async (files: TFile[]) => {
            if (files.length > 0) {
              const added = await this.plugin.bulkEditService.linkAttachments(currentFile, files);
              new Notice(`Linked ${added} attachment(s).`);
            }
          }).open();
        });
    });

    menu.addSeparator();

    menu.addItem(item => {
      item.setTitle('Add to Note...')
        .setIcon('file-plus')
        .onClick(() => {
          if (!markdownFiles.length) {
            new Notice('No markdown files selected.');
            return;
          }
          void this.plugin.noteOperationService.addNotesToAnotherNote(markdownFiles);
        });
    });

    menu.addItem(item => {
      item.setTitle('Add to Daily Note...')
        .setIcon('calendar-plus')
        .onClick(() => {
          if (!markdownFiles.length) {
            new Notice('No markdown files selected.');
            return;
          }
          void this.plugin.noteOperationService.addNotesToDailyNotes(markdownFiles);
        });
    });

    menu.addItem(item => {
      item.setTitle('Add to Board...')
        .setIcon('layout-grid')
        .onClick(() => {
          void this.addFilesToBoard(sourceFiles);
        });
    });

    menu.showAtMouseEvent(e);
  }

  private async addFilesToBoard(files: TFile[]): Promise<void> {
    if (!files.length) {
      new Notice('Select at least one file first.');
      return;
    }

    const boardFile = await this.pickCanvasFile();
    if (!boardFile) return;

    let canvasData: any = {};
    try {
      const raw = await this.app.vault.read(boardFile);
      if (raw.trim()) {
        canvasData = JSON.parse(raw);
      }
    } catch (error) {
      logger.error('[TPS GCM] Failed to parse canvas file:', boardFile.path, error);
      new Notice(`Unable to read board: ${boardFile.basename}`);
      return;
    }

    if (!canvasData || typeof canvasData !== 'object') {
      canvasData = {};
    }
    if (!Array.isArray(canvasData.nodes)) {
      canvasData.nodes = [];
    }
    if (!Array.isArray(canvasData.edges)) {
      canvasData.edges = [];
    }

    const nodes = canvasData.nodes as Array<Record<string, any>>;
    const existingFileNodes = new Set(
      nodes
        .filter((node) => node?.type === 'file' && typeof node.file === 'string')
        .map((node) => normalizePath(String(node.file))),
    );

    const filesToAdd = files.filter((file) => !existingFileNodes.has(normalizePath(file.path)));
    if (!filesToAdd.length) {
      new Notice(`All selected files are already on ${boardFile.basename}.`);
      return;
    }

    const nodeWidth = 320;
    const nodeHeight = 200;
    const gap = 40;
    const columns = 3;

    let maxBottom = 0;
    for (const node of nodes) {
      const y = Number(node?.y);
      const height = Number(node?.height);
      if (!Number.isFinite(y)) continue;
      const resolvedHeight = Number.isFinite(height) ? height : nodeHeight;
      maxBottom = Math.max(maxBottom, y + resolvedHeight);
    }

    const startX = 40;
    const startY = maxBottom > 0 ? maxBottom + gap : 40;

    filesToAdd.forEach((file, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      nodes.push({
        id: this.generateCanvasNodeId(),
        type: 'file',
        file: file.path,
        x: startX + col * (nodeWidth + gap),
        y: startY + row * (nodeHeight + gap),
        width: nodeWidth,
        height: nodeHeight,
      });
    });

    try {
      await this.app.vault.modify(boardFile, JSON.stringify(canvasData, null, 2));
      new Notice(`Added ${filesToAdd.length} file(s) to ${boardFile.basename}.`);
    } catch (error) {
      logger.error('[TPS GCM] Failed to update canvas board:', boardFile.path, error);
      new Notice(`Failed to update ${boardFile.basename}.`);
    }
  }

  private async pickCanvasFile(): Promise<TFile | null> {
    const canvasFiles = this.app.vault.getFiles()
      .filter((file) => file.extension?.toLowerCase() === 'canvas')
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    if (!canvasFiles.length) {
      new Notice('No canvas files found in this vault.');
      return null;
    }

    return new Promise<TFile | null>((resolve) => {
      let settled = false;
      const finish = (value: TFile | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      class CanvasPickerModal extends FuzzySuggestModal<TFile> {
        getItems(): TFile[] {
          return canvasFiles;
        }

        getItemText(item: TFile): string {
          return item.path;
        }

        onChooseItem(item: TFile): void {
          finish(item);
        }

        onClose(): void {
          finish(null);
        }
      }

      const modal = new CanvasPickerModal(this.app);
      modal.setPlaceholder('Choose canvas board...');
      modal.open();
    });
  }

  private generateCanvasNodeId(): string {
    return `tps-gcm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  showOptionsMenu(e: MouseEvent, entries: any[]) {
    const menu = new Menu();
    const file = entries[0].file;
    const isMd = file.extension === 'md';
    const currentFile = entries[0].file as TFile;

    // === INSERT SECTION ===
    if (isMd) {
      menu.addItem(item => {
        item.setTitle('Insert Template')
          .setIcon('layout-template')
          .onClick(() => {
            this.ensureEditModeAndExecute(() => this.triggerTemplateInsert());
          });
      });

      menu.addItem(item => {
        item.setTitle('Create Handwritten Note')
          .setIcon('pencil')
          .onClick(() => {
            this.ensureEditModeAndExecute(() => this.triggerHandwriting());
          });
      });

      menu.addItem(item => {
        item.setTitle('Insert Voice Recording')
          .setIcon('mic')
          .onClick(() => {
            this.ensureEditModeAndExecute(() => this.triggerVoiceRecording());
          });
      });

      menu.addItem(item => {
        item.setTitle('Insert Photo')
          .setIcon('camera')
          .onClick(() => {
            this.ensureEditModeAndExecute(() => this.triggerInsertPhoto());
          });
      });

      menu.addSeparator();

      menu.addItem(item => {
        item.setTitle('Create Note')
          .setIcon('file-plus')
          .onClick(() => {
            void this.createNoteAndAddAsAttachment(currentFile);
          });
      });

      menu.addItem(item => {
        item.setTitle('Attach Existing Note')
          .setIcon('link')
          .onClick(() => {
            void this.attachExistingNoteAsAttachment(currentFile);
          });
      });

      menu.addSeparator();
    }

    // === LINK SECTION ===
    if (isMd) {
      const sourceFiles = entries
        .map((entry) => entry?.file)
        .filter((file): file is TFile => file instanceof TFile);
      const markdownFiles = sourceFiles.filter((file) => file.extension?.toLowerCase() === 'md');

      menu.addItem(item => {
        item.setTitle('Link to Parent')
          .setIcon('link')
          .onClick(() => {
            new FileSuggestModal(this.app, async (file: TFile) => {
              await this.plugin.bulkEditService.linkToParent(entries.map(e => e.file), file);
              new Notice(`Linked to parent: ${file.basename}`);
            }).open();
          });
      });

      menu.addItem(item => {
        item.setTitle('Link Children')
          .setIcon('network')
          .onClick(() => {
            if (!currentFile) {
              new Notice('No source file selected.');
              return;
            }
            new MultiFileSelectModal(this.app, async (files: TFile[]) => {
              if (files.length > 0) {
                await this.plugin.bulkEditService.linkChildren(currentFile, files);
                new Notice(`Linked ${files.length} children.`);
              }
            }).open();
          });
      });

      menu.addItem(item => {
        item.setTitle('Link Attachments')
          .setIcon('paperclip')
          .onClick(() => {
            if (!currentFile) {
              new Notice('No source file selected.');
              return;
            }
            new MultiFileSelectModal(this.app, async (files: TFile[]) => {
              if (files.length > 0) {
                const added = await this.plugin.bulkEditService.linkAttachments(currentFile, files);
                new Notice(`Linked ${added} attachment(s).`);
              }
            }).open();
          });
      });

      menu.addSeparator();

      menu.addItem(item => {
        item.setTitle('Add to Note...')
          .setIcon('file-plus')
          .onClick(() => {
            if (!markdownFiles.length) {
              new Notice('No markdown files selected.');
              return;
            }
            void this.plugin.noteOperationService.addNotesToAnotherNote(markdownFiles);
          });
      });

      menu.addItem(item => {
        item.setTitle('Add to Daily Note...')
          .setIcon('calendar-plus')
          .onClick(() => {
            if (!markdownFiles.length) {
              new Notice('No markdown files selected.');
              return;
            }
            void this.plugin.noteOperationService.addNotesToDailyNotes(markdownFiles);
          });
      });

      menu.addItem(item => {
        item.setTitle('Add to Board...')
          .setIcon('layout-grid')
          .onClick(() => {
            void this.addFilesToBoard(sourceFiles);
          });
      });

      menu.addSeparator();
    }

    // === RENAME ===

    menu.addItem(item => {
      item.setTitle('Rename')
        .setIcon('pencil')
        .onClick(() => {
          void this.promptRenameFile(file);
        });
    });

    menu.addSeparator();

    // View Modes
    if (this.plugin.settings.enableInlineManualViewMode !== false && isMd) {
      menu.addItem(item => item.setTitle('Reading View').setIcon('book-open').onClick(() => this.setViewModeForFile(file, 'reading')));
      menu.addItem(item => item.setTitle('Live Preview').setIcon('eye').onClick(() => this.setViewModeForFile(file, 'live')));
      menu.addItem(item => item.setTitle('Source Mode').setIcon('file-code-2').onClick(() => this.setViewModeForFile(file, 'source')));
      menu.addSeparator();
    }

    menu.addItem(item => {
      item.setTitle('Open in New Tab')
        .setIcon('square-plus')
        .onClick(async () => {
          await this.plugin.openFileInLeaf(file, 'tab', () => this.app.workspace.getLeaf('tab'));
        });
    });

    menu.addItem(item => {
      item.setTitle('Duplicate')
        .setIcon('copy')
        .onClick(async () => {
          const folder = file.parent?.path || '';
          const ext = file.extension ? `.${file.extension}` : '';
          let candidate = folder ? `${folder}/${file.basename} copy${ext}` : `${file.basename} copy${ext}`;
          let counter = 2;
          while (this.app.vault.getAbstractFileByPath(candidate)) {
            candidate = folder ? `${folder}/${file.basename} copy ${counter}${ext}` : `${file.basename} copy ${counter}${ext}`;
            counter += 1;
          }
          const content = await this.app.vault.readBinary(file);
          await this.app.vault.createBinary(candidate, content);
        });
    });

    menu.addItem(item => {
      item.setTitle('Copy Path')
        .setIcon('link')
        .onClick(() => {
          navigator.clipboard.writeText(file.path);
          new Notice('Path copied');
        });
    });

    menu.addSeparator();

    menu.addItem(item => {
      item.setTitle('Archive')
        .setIcon('archive')
        .onClick(() => this.archiveEntries(entries));
    });

    menu.addItem(item => {
      item.setTitle('Delete')
        .setIcon('trash-2')
        .setWarning(true)
        .onClick(() => {
          const modal = new ConfirmDeleteModal(this.app, `Delete "${file.basename}"?`, async () => {
            await this.plugin.runQueuedDelete([file], async () => {
              await this.app.vault.trash(file, true);
            });
          });
          modal.open();
        });
    });

    menu.showAtMouseEvent(e);
  }

}

class ConfirmDeleteModal extends Modal {
  private message: string;
  private onConfirm: () => Promise<void>;

  constructor(app: App, message: string, onConfirm: () => Promise<void>) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    this.modalEl.addClass('mod-tps-gcm');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Confirm delete' });
    contentEl.createEl('p', { text: this.message });

    const buttonRow = contentEl.createDiv({ cls: 'tps-gcm-confirm-buttons' });
    const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
    const confirmBtn = buttonRow.createEl('button', { text: 'Delete', cls: 'mod-warning' });

    cancelBtn.addEventListener('click', () => this.close());
    confirmBtn.addEventListener('click', async () => {
      await this.onConfirm();
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class CameraCaptureModal extends Modal {
  private readonly onResolve: (value: Blob | null) => void;
  private stream: MediaStream | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private settled = false;

  constructor(app: App, onResolve: (value: Blob | null) => void) {
    super(app);
    this.onResolve = onResolve;
  }

  onOpen(): void {
    this.modalEl.addClass('mod-tps-gcm');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Take Photo' });

    const videoWrap = contentEl.createDiv();
    videoWrap.style.marginBottom = '12px';
    videoWrap.style.borderRadius = '8px';
    videoWrap.style.overflow = 'hidden';
    videoWrap.style.background = 'var(--background-secondary)';

    this.videoEl = videoWrap.createEl('video');
    this.videoEl.autoplay = true;
    this.videoEl.playsInline = true;
    this.videoEl.muted = true;
    this.videoEl.style.width = '100%';
    this.videoEl.style.maxHeight = '340px';
    this.videoEl.style.objectFit = 'cover';

    const actions = contentEl.createDiv();
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.justifyContent = 'flex-end';

    const cancelBtn = actions.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.finish(null);
      this.close();
    });

    const captureBtn = actions.createEl('button', { text: 'Capture', cls: 'mod-cta' });
    captureBtn.addEventListener('click', () => {
      void this.captureFrame();
    });

    void this.startStream();
  }

  onClose(): void {
    this.stopStream();
    if (!this.settled) {
      this.finish(null);
    }
    this.contentEl.empty();
  }

  private async startStream(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      new Notice('Camera access is not available on this device.');
      return;
    }

    const constraints: Array<MediaTrackConstraints | boolean> = [
      { facingMode: { ideal: 'environment' } },
      { facingMode: { ideal: 'user' } },
      true,
    ];

    for (const videoConstraint of constraints) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraint,
          audio: false,
        });
        break;
      } catch (error) {
        // Try next constraint.
      }
    }

    if (!this.stream || !this.videoEl) {
      new Notice('Unable to access camera. You can use Insert Photo to choose an image file.');
      return;
    }

    this.videoEl.srcObject = this.stream;
    try {
      await this.videoEl.play();
    } catch (error) {
      logger.warn('[TPS GCM] Video preview failed to autoplay:', error);
    }
  }

  private stopStream(): void {
    if (!this.stream) return;
    for (const track of this.stream.getTracks()) {
      track.stop();
    }
    this.stream = null;
  }

  private async captureFrame(): Promise<void> {
    if (!this.videoEl) {
      new Notice('Camera preview is not ready.');
      return;
    }

    const width = this.videoEl.videoWidth || 1280;
    const height = this.videoEl.videoHeight || 720;
    if (width <= 0 || height <= 0) {
      new Notice('Camera preview is not ready yet.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      new Notice('Unable to capture photo.');
      return;
    }

    ctx.drawImage(this.videoEl, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), 'image/jpeg', 0.92);
    });

    if (!blob) {
      new Notice('Unable to capture photo.');
      return;
    }

    this.finish(blob);
    this.close();
  }

  private finish(value: Blob | null): void {
    if (this.settled) return;
    this.settled = true;
    this.onResolve(value);
  }
}

class CreateSubitemModal extends Modal {
  private readonly folderPaths: string[];
  private readonly defaultFolderPath: string;
  private readonly onResolve: (value: { title: string; folderPath: string } | null) => void;
  private resolved = false;
  private title = '';
  private folderPath = '/';
  private showFolderPicker = false;

  constructor(
    app: App,
    folderPaths: string[],
    defaultFolderPath: string,
    onResolve: (value: { title: string; folderPath: string } | null) => void
  ) {
    super(app);
    this.folderPaths = folderPaths.length ? folderPaths : ['/'];
    this.defaultFolderPath = this.folderPaths.includes(defaultFolderPath) ? defaultFolderPath : this.folderPaths[0];
    this.folderPath = this.defaultFolderPath;
    this.onResolve = onResolve;
  }

  onOpen(): void {
    this.modalEl.addClass('mod-tps-gcm');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Add Subitem' });

    new Setting(contentEl)
      .setName('Title')
      .setDesc('Name for the new subitem.')
      .addText((text) => {
        text.setPlaceholder('Subitem title');
        text.setValue(this.title);
        text.onChange((value) => {
          this.title = value;
        });
        text.inputEl.addEventListener('keydown', (event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            this.submit();
          }
        });
        setTimeout(() => text.inputEl.focus(), 10);
      });

    const locationSetting = new Setting(contentEl)
      .setName('Location')
      .setDesc(this.folderPath || '/');

    let pickerRow: HTMLElement | null = null;
    const mountFolderPicker = () => {
      if (pickerRow) {
        pickerRow.style.display = this.showFolderPicker ? '' : 'none';
        return;
      }

      pickerRow = contentEl.createDiv('tps-gcm-subitem-folder-picker');
      pickerRow.style.display = this.showFolderPicker ? '' : 'none';

      new Setting(pickerRow)
        .setName('Change Folder')
        .setDesc('Optional. Defaults to current note folder.')
        .addDropdown((dropdown) => {
          this.folderPaths.forEach((path) => {
            dropdown.addOption(path, path || '/');
          });
          dropdown.setValue(this.folderPath);
          dropdown.onChange((value) => {
            this.folderPath = value;
            locationSetting.setDesc(this.folderPath || '/');
          });
        });
    };

    locationSetting.addButton((btn) => {
      btn.setButtonText('Change')
        .onClick(() => {
          this.showFolderPicker = !this.showFolderPicker;
          mountFolderPicker();
        });
    });

    mountFolderPicker();

    const actions = contentEl.createDiv('tps-gcm-subitem-create-actions');
    const cancel = actions.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());

    const create = actions.createEl('button', { text: 'Create', cls: 'mod-cta' });
    create.addEventListener('click', () => this.submit());
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.onResolve(null);
    }
  }

  private submit(): void {
    const nextTitle = String(this.title || '').trim();
    if (!nextTitle) {
      new Notice('Title is required.');
      return;
    }

    this.resolved = true;
    this.onResolve({
      title: nextTitle,
      folderPath: this.folderPath || '/',
    });
    this.close();
  }
}
