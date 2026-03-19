import { App, TFile, TFolder, Notice, Modal, Setting, setIcon, WorkspaceLeaf, normalizePath, Menu, FuzzySuggestModal, Platform, MarkdownView, getAllTags } from 'obsidian';
import TPSGlobalContextMenuPlugin from '../main';
import { BuildPanelOptions } from '../types';
import { PanelEntry } from '../../types';
import { SYSTEM_COMMANDS, STATUSES, PRIORITIES } from '../constants';
import { PropertyRowService } from '../services/property-row-service';
import { FileSuggestModal } from '../modals/FileSuggestModal';
import { MultiFileSelectModal } from '../modals/MultiFileSelectModal';
import { addSafeClickListener } from './menu-controller';
import { mergeNormalizedTags, normalizeTagValue, parseTagInput } from '../utils/tag-utils';
import { TextInputModal } from '../modals/text-input-modal';
import * as logger from '../logger';
import { resolveCustomProperties } from '../resolve-profiles';
import { ViewModeService } from '../services/view-mode-service';
import { resolveLinkValueToFile } from '../handlers/parent-link-format';
import { ConfirmDeleteModal } from '../modals/confirm-delete-modal';
import { CameraCaptureModal } from '../modals/camera-capture-modal';
import { CreateSubitemModal } from '../modals/create-subitem-modal';

type SubitemRelationKind = 'child' | 'attachment';

interface SubitemRelationEntry {
  file: TFile;
  relations: Set<SubitemRelationKind>;
}

interface SubitemNode {
  file: TFile;
  relations: SubitemRelationKind[];
  children: SubitemNode[];
  hidden?: boolean;
}

type ChecklistTaskState = ' ' | 'x' | 'X' | '?' | '-';

interface ChecklistSubitem {
  lineNumber: number;
  rawLine: string;
  prefix: string;
  state: ChecklistTaskState;
  text: string;
}

export type ReferenceDirection = 'incoming' | 'outgoing';

export interface ReferenceOccurrence {
  sourceFile: TFile;
  targetFile: TFile;
  lineNumber: number;
  heading: string;
  previews: string[];
  matchedText?: string;
  /** When the match was found in a frontmatter field, stores the key name (e.g. "dateCreated") */
  frontmatterKey?: string;
}

export interface ReferenceGroup {
  file: TFile;
  direction: ReferenceDirection;
  occurrences: ReferenceOccurrence[];
}

export interface MentionGroup {
  file: TFile;
  occurrences: ReferenceOccurrence[];
}

export interface ReferenceData {
  outgoing: ReferenceGroup[];
  incoming: ReferenceGroup[];
  mentions: MentionGroup[];
}

interface GraphData {
  outgoing: TFile[];
  incoming: TFile[];
  mentions: TFile[];
}

const ATTACHMENTS_FRONTMATTER_KEY = 'attachments';
const MAX_SUBITEM_DEPTH = 8;
const SUBITEM_PANEL_REFRESH_DEBOUNCE_MS = 200;
const SUBITEM_LINK_RECONCILE_INTERVAL_MS = 3000;

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
  private subitemLinkReconcileAt: Map<string, number> = new Map();

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

  private async archiveEntries(entries: PanelEntry[]): Promise<void> {
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
    const entries = this.delegates.createFileEntries(files) as PanelEntry[];
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
  createContextStrip(entries: PanelEntry[]): HTMLElement {
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
    const showInlineProperties = this.plugin.settings.showCustomPropertiesInInlineUi !== false;

    // Status (if enabled)
    const statusProp = properties.find(p => p.id === 'status' || p.key === 'status');
    if (showInlineProperties && statusProp && statusProp.showInCollapsed !== false) {
      strip.appendChild(this.createStatusChip(entries, statusProp));
    }

    // Priority (if enabled)
    const priorityProp = properties.find(p => p.id === 'priority' || p.key === 'priority');
    if (showInlineProperties && priorityProp && priorityProp.showInCollapsed !== false) {
      strip.appendChild(this.createPriorityChip(entries, priorityProp));
    }

    // Pomodoro
    if (this.plugin.settings.enablePomodoro) {
      strip.appendChild(this.createPomodoroChip(entries));
    }

    // Date (if enabled)
    const dateProp = properties.find(p => p.type === 'datetime' || p.key === 'scheduled');
    if (showInlineProperties && dateProp && dateProp.showInCollapsed !== false) {
      strip.appendChild(this.createDateChip(entries, dateProp));
    }

    // Tags (if enabled)
    const tagsProp = properties.find(p => p.id === 'tags' || p.key === 'tags');
    if (showInlineProperties && tagsProp && tagsProp.showInCollapsed !== false) {
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
    if (showInlineProperties && folderProp && folderProp.showInCollapsed !== false) {
      strip.appendChild(this.createFolderChip(entries));
    }

    return strip;
  }

  createStatusChip(entries: PanelEntry[], resolvedProp: any): HTMLElement {
    const fm = entries[0].frontmatter;
    const statusKey = String(resolvedProp?.key || 'status').trim() || 'status';
    const statusRaw = this.getFrontmatterValueCaseInsensitive(fm, statusKey);
    const currentStatus = Array.isArray(statusRaw)
      ? String(statusRaw.find((value) => String(value ?? '').trim()) ?? '').trim()
      : String(statusRaw ?? '').trim();
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

  createPriorityChip(entries: PanelEntry[], resolvedProp: any): HTMLElement {
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

  createDateChip(entries: PanelEntry[], resolvedProp: any): HTMLElement {
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

  createTagsChip(entries: PanelEntry[], resolvedProp: any): HTMLElement {
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
    let tags = parseTagInput([fm.tags, fm.tag]);
    const file = entry?.file;
    if (file instanceof TFile) {
      const cache = this.app.metadataCache.getFileCache(file);
      tags = parseTagInput([tags, ...(getAllTags(cache) || [])]);
    }

    return Array.from(new Set(tags.map((tag) => normalizeTagValue(tag)).filter(Boolean)));
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
    if (this.plugin.settings.inheritNotebookNavigatorTagColors === false) {
      chip.style.removeProperty('background');
      chip.style.removeProperty('background-color');
      chip.style.removeProperty('background-image');
      chip.style.removeProperty('color');
      chip.style.removeProperty('border');
      return;
    }

    const fallbackBackground = 'var(--nn-theme-file-tag-bg, var(--background-secondary-alt))';
    const fallbackText = 'var(--nn-theme-file-tag-color, var(--text-normal))';
    const fallbackBorder = 'var(--nn-theme-file-pill-border-color, var(--background-modifier-border))';

    chip.style.background = fallbackBackground;
    chip.style.color = fallbackText;
    chip.style.border = `1px solid ${fallbackBorder}`;

    if (!normalizedTag) return;

    const pluginApi: any = (this.app as any)?.plugins;
    const nnCandidates = Object.values(pluginApi?.plugins || {}) as any[];
    const nn: any =
      pluginApi?.plugins?.['notebook-navigator'] ??
      pluginApi?.getPlugin?.('notebook-navigator') ??
      nnCandidates.find((candidate) => String(candidate?.manifest?.id || '').trim() === 'notebook-navigator') ??
      nnCandidates.find((candidate) => String(candidate?.manifest?.name || '').trim().toLowerCase() === 'notebook navigator');
    const settings = nn?.settings ?? nn?.settingsController?.settings ?? nn?.api?.settings ?? null;

    const renderedColor = this.getNotebookNavigatorRenderedTagColor(normalizedTag);
    if (renderedColor) {
      chip.style.color = renderedColor;
      chip.style.backgroundColor = 'var(--nn-theme-file-tag-bg, transparent)';
      chip.style.backgroundImage = 'none';
      chip.style.border = '1px solid color-mix(in srgb, currentColor 30%, transparent)';
      return;
    }

    const keyCandidates = Array.from(new Set([
      normalizedTag,
      normalizedTag.toLowerCase(),
      `#${normalizedTag}`,
      `#${normalizedTag.toLowerCase()}`,
    ]));

    const colorMap = (settings?.tagColors && typeof settings.tagColors === 'object')
      ? settings.tagColors as Record<string, string>
      : {};
    const backgroundMap = (settings?.tagBackgroundColors && typeof settings.tagBackgroundColors === 'object')
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
        chip.style.backgroundColor = 'var(--nn-theme-file-tag-bg, transparent)';
        chip.style.backgroundImage = 'none';
      }
    }
    if (customBackground || customColor) {
      chip.style.border = '1px solid color-mix(in srgb, currentColor 30%, transparent)';
      return;
    }

    const apiColor = this.getNotebookNavigatorTagColorFromApi(normalizedTag, nn);
    if (apiColor) {
      chip.style.color = apiColor;
      chip.style.backgroundColor = 'var(--nn-theme-file-tag-bg, transparent)';
      chip.style.backgroundImage = 'none';
      chip.style.border = '1px solid color-mix(in srgb, currentColor 30%, transparent)';
      return;
    }

    const rainbowColor = this.resolveNotebookNavigatorRainbowTagColor(normalizedTag, settings);
    if (rainbowColor) {
      chip.style.color = rainbowColor;
      chip.style.backgroundColor = 'var(--nn-theme-file-tag-bg, transparent)';
      chip.style.backgroundImage = 'none';
      chip.style.border = '1px solid color-mix(in srgb, currentColor 30%, transparent)';
    }
  }

  private resolveNotebookNavigatorRainbowTagColor(normalizedTag: string, settings: any): string {
    if (!normalizedTag) {
      return '';
    }

    if (settings && settings.inheritTagColors === false) {
      return '';
    }

    const activeProfileName = String(settings?.vaultProfile || '').trim();
    const profiles = Array.isArray(settings?.vaultProfiles) ? settings.vaultProfiles : [];
    const activeProfile = profiles.find((profile: any) => String(profile?.name || '').trim() === activeProfileName);
    const navRainbow = activeProfile?.navRainbow;
    const tagRainbow = navRainbow?.tags;

    const rainbowEnabled = tagRainbow ? tagRainbow.enabled !== false : true;
    if (!rainbowEnabled) return '';

    const firstColor = this.parseHexColor(String(tagRainbow?.firstColor || '#ef4444').trim());
    const lastColor = this.parseHexColor(String(tagRainbow?.lastColor || '#8b5cf6').trim());
    if (!firstColor || !lastColor) {
      return '';
    }

    const ratio = this.getNotebookNavigatorRainbowRatio(normalizedTag, settings);
    const transitionStyle = String(tagRainbow?.transitionStyle || 'hue').toLowerCase();
    const color = transitionStyle === 'rgb'
      ? this.interpolateRgb(firstColor, lastColor, ratio)
      : this.interpolateHue(firstColor, lastColor, ratio);
    return this.formatHexColor(color);
  }

  private getNotebookNavigatorRainbowRatio(normalizedTag: string, settings?: any): number {
    const metadataCacheAny = this.app.metadataCache as any;
    const tagMap = typeof metadataCacheAny?.getTags === 'function'
      ? metadataCacheAny.getTags()
      : {};
    const entries = Object.entries(tagMap || {})
      .map(([rawTag, rawCount]) => ({
        tag: normalizeTagValue(String(rawTag || '')),
        count: Number(rawCount || 0),
      }))
      .filter((entry) => !!entry.tag);

    if (!entries.some((entry) => entry.tag === normalizedTag)) {
      entries.push({ tag: normalizedTag, count: 0 });
    }

    const sortOrder = String(settings?.tagSortOrder || settings?.defaultTagSort || 'alpha-asc').trim().toLowerCase();
    entries.sort((a, b) => {
      switch (sortOrder) {
        case 'frequency-desc': {
          const delta = b.count - a.count;
          return delta !== 0 ? delta : a.tag.localeCompare(b.tag);
        }
        case 'frequency-asc': {
          const delta = a.count - b.count;
          return delta !== 0 ? delta : a.tag.localeCompare(b.tag);
        }
        case 'alpha-desc':
          return b.tag.localeCompare(a.tag);
        case 'alpha-asc':
        default:
          return a.tag.localeCompare(b.tag);
      }
    });

    const tags = entries.map((entry) => entry.tag);
    if (tags.length <= 1) {
      return this.getDeterministicTagRatio(normalizedTag);
    }
    const index = Math.max(0, tags.indexOf(normalizedTag));
    return index / Math.max(1, tags.length - 1);
  }

  private getDeterministicTagRatio(tag: string): number {
    let hash = 0;
    for (let i = 0; i < tag.length; i++) {
      hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
    }
    return (Math.abs(hash) % 1000) / 999;
  }

  private parseHexColor(value: string): { r: number; g: number; b: number } | null {
    const raw = value.trim();
    const short = /^#([0-9a-f]{3})$/i.exec(raw);
    if (short) {
      const [r, g, b] = short[1].split('').map((digit) => parseInt(digit + digit, 16));
      return { r, g, b };
    }

    const full = /^#([0-9a-f]{6})$/i.exec(raw);
    if (!full) return null;
    const hex = full[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  private interpolateRgb(
    start: { r: number; g: number; b: number },
    end: { r: number; g: number; b: number },
    ratio: number,
  ): { r: number; g: number; b: number } {
    const t = Math.max(0, Math.min(1, ratio));
    return {
      r: Math.round(start.r + (end.r - start.r) * t),
      g: Math.round(start.g + (end.g - start.g) * t),
      b: Math.round(start.b + (end.b - start.b) * t),
    };
  }

  private interpolateHue(
    start: { r: number; g: number; b: number },
    end: { r: number; g: number; b: number },
    ratio: number,
  ): { r: number; g: number; b: number } {
    const t = Math.max(0, Math.min(1, ratio));
    const startHsl = this.rgbToHsl(start.r, start.g, start.b);
    const endHsl = this.rgbToHsl(end.r, end.g, end.b);

    let hueDelta = endHsl.h - startHsl.h;
    if (Math.abs(hueDelta) > 180) {
      hueDelta -= Math.sign(hueDelta) * 360;
    }
    const h = (startHsl.h + hueDelta * t + 360) % 360;
    const s = startHsl.s + (endHsl.s - startHsl.s) * t;
    const l = startHsl.l + (endHsl.l - startHsl.l) * t;
    return this.hslToRgb(h, s, l);
  }

  private rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;

    if (max === min) {
      return { h: 0, s: 0, l };
    }

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }
    h *= 60;
    return { h, s, l };
  }

  private hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
    const hue = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
    const m = l - c / 2;
    let rp = 0;
    let gp = 0;
    let bp = 0;

    if (hue < 60) {
      rp = c; gp = x; bp = 0;
    } else if (hue < 120) {
      rp = x; gp = c; bp = 0;
    } else if (hue < 180) {
      rp = 0; gp = c; bp = x;
    } else if (hue < 240) {
      rp = 0; gp = x; bp = c;
    } else if (hue < 300) {
      rp = x; gp = 0; bp = c;
    } else {
      rp = c; gp = 0; bp = x;
    }

    return {
      r: Math.round((rp + m) * 255),
      g: Math.round((gp + m) * 255),
      b: Math.round((bp + m) * 255),
    };
  }

  private formatHexColor(color: { r: number; g: number; b: number }): string {
    const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
  }

  private getNotebookNavigatorTagColorFromApi(normalizedTag: string, nn: any): string {
    const candidates = [
      nn?.api?.navigation?.getTagColor,
      nn?.api?.getTagColor,
      nn?.getTagColor,
    ].filter((candidate): candidate is Function => typeof candidate === 'function');
    const args = Array.from(new Set([
      normalizedTag,
      normalizedTag.toLowerCase(),
      `#${normalizedTag}`,
      `#${normalizedTag.toLowerCase()}`,
    ]));
    for (const fn of candidates) {
      for (const arg of args) {
        try {
          const value = String(fn.call(nn, arg) || '').trim();
          if (value && this.isValidCssColor(value)) {
            return value;
          }
        } catch {
          // Best effort.
        }
      }
    }
    return '';
  }

  private getNotebookNavigatorRenderedTagColor(normalizedTag: string): string {
    if (typeof document === 'undefined' || !normalizedTag) {
      return '';
    }

    const rows = Array.from(
      document.querySelectorAll(
        '.nn-navitem[data-nav-item-type="tag"], .nn-navitem[data-drop-zone="tag"], .nn-file-tag, [data-tag], [data-tag-name]',
      ),
    );
    for (const row of rows) {
      const rowEl = row as HTMLElement;
      const nameEl = rowEl.querySelector('.nn-navitem-name, .nn-file-tag') as HTMLElement | null;
      const iconEl = rowEl.querySelector('.nn-navitem-icon, .nn-file-icon, .nn-file-tag svg, .nn-navitem svg') as HTMLElement | null;
      const attrTag = String(
        rowEl.getAttribute('data-tag-name') ||
        rowEl.getAttribute('data-tag') ||
        '',
      ).trim();
      const textRaw = String(attrTag || nameEl?.textContent || rowEl.textContent || '').trim();
      if (!textRaw) continue;

      const normalizedRowTag = normalizeTagValue(textRaw.replace(/\s+\d+$/, '').replace(/^#/, ''));
      if (normalizedRowTag !== normalizedTag) continue;

      const colorCandidates = [
        String(getComputedStyle(iconEl || rowEl).color || '').trim(),
        String(getComputedStyle(nameEl || rowEl).color || '').trim(),
      ];
      for (const color of colorCandidates) {
        if (color && this.isValidCssColor(color)) {
          return color;
        }
      }
    }
    return '';
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

  createPomodoroChip(entries: any[]): HTMLElement {
    const chip = document.createElement('div');
    chip.className = 'tps-gcm-chip tps-gcm-pomodoro-chip';

    const iconEl = document.createElement('div');
    iconEl.className = 'tps-gcm-chip-icon';
    setIcon(iconEl, 'timer');
    chip.appendChild(iconEl);

    const valueEl = document.createElement('div');
    valueEl.className = 'tps-gcm-chip-value tps-gcm-pomodoro-value';

    // Check current state from PomodoroService
    const pomo = this.plugin.pomodoroService;
    if (pomo.currentState !== 'idle') {
      valueEl.textContent = pomo.getFormattedRemainingTime();
      chip.classList.add(`is-${pomo.currentState}`);

      // Stop button
      const stopBtn = document.createElement('button');
      stopBtn.className = 'tps-gcm-pomodoro-action';
      setIcon(stopBtn, 'square');
      stopBtn.title = 'Stop Pomodoro';
      addSafeClickListener(stopBtn, (e) => {
        e.stopPropagation();
        pomo.stopSession(false);
      });
      chip.appendChild(stopBtn);

    } else {
      valueEl.textContent = 'Start Focus';

      const startBtn = document.createElement('button');
      startBtn.className = 'tps-gcm-pomodoro-action';
      setIcon(startBtn, 'play');
      startBtn.title = 'Start Work Session';
      addSafeClickListener(startBtn, (e) => {
        e.stopPropagation();
        pomo.startSession();
      });
      chip.appendChild(startBtn);
    }

    chip.insertBefore(valueEl, chip.lastChild); // Put value between icon and button

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

    // Attachment button: only for single markdown file
    if (entries.length === 1 && (entries[0]?.file as TFile)?.extension?.toLowerCase() === 'md') {
      const currentFile = entries[0].file as TFile;
      const refreshAttachments = () => {
        void this.plugin.persistentMenuManager.refreshMenusForFile(currentFile, true, { rebuildInlineSubitems: true });
      };
      const attachBtn = this.createIconButton('paperclip', 'Add attachment', (evt: MouseEvent) => {
        const menu = new Menu();
        menu.addItem((item) => {
          item.setTitle('Handwritten Note')
            .setIcon('pencil')
            .onClick(() => {
              void this.ensureEditModeAndExecute(() => this.triggerHandwriting());
              window.setTimeout(refreshAttachments, 1500);
            });
        });
        menu.addItem((item) => {
          item.setTitle('Audio Recording')
            .setIcon('mic')
            .onClick(() => {
              void this.ensureEditModeAndExecute(() => this.triggerVoiceRecording());
              window.setTimeout(refreshAttachments, 1500);
            });
        });
        menu.addItem((item) => {
          item.setTitle('Link Note')
            .setIcon('file-text')
            .onClick(() => {
              void this.attachExistingNoteAsAttachment(currentFile).then(refreshAttachments);
            });
        });
        menu.showAtMouseEvent(evt);
      });
      group.appendChild(attachBtn);
    }

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
    const expandCount = document.createElement('span');
    expandCount.className = 'tps-gcm-expand-count';
    expandCount.textContent = '0';
    expandHandle.appendChild(expandCount);

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
    childrenSection.dataset.showHidden = 'false';

    const childrenHeader = document.createElement('div');
    childrenHeader.className = 'tps-gcm-subitems-header';

    const childrenTitleWrap = document.createElement('div');
    childrenTitleWrap.className = 'tps-gcm-subitems-title-wrap';
    childrenTitleWrap.style.flexDirection = 'row';
    childrenTitleWrap.style.alignItems = 'center';
    childrenTitleWrap.style.gap = '6px';

    const childrenTitle = document.createElement('h4');
    childrenTitle.className = 'tps-gcm-subitems-title';
    childrenTitle.textContent = 'Children';
    childrenTitleWrap.appendChild(childrenTitle);

    const hiddenChildrenBadge = document.createElement('span');
    hiddenChildrenBadge.className = 'tps-gcm-subitems-hidden-badge';
    hiddenChildrenBadge.style.display = 'none';
    childrenTitleWrap.appendChild(hiddenChildrenBadge);

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
          await this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody);
          window.setTimeout(() => {
            void this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody);
          }, 220);
        }
      });
    });
    childrenActions.appendChild(addSubitemBtn);

    const hiddenToggleBtn = document.createElement('button');
    hiddenToggleBtn.type = 'button';
    hiddenToggleBtn.className = 'tps-gcm-subitems-header-btn tps-gcm-subitems-hidden-toggle';
    hiddenToggleBtn.title = 'Show completed / archived children';
    hiddenToggleBtn.style.display = 'none';
    setIcon(hiddenToggleBtn, 'eye-off');
    addSafeClickListener(hiddenToggleBtn, () => {
      const showing = childrenSection.dataset.showHidden === 'true';
      const willShow = !showing;
      childrenSection.dataset.showHidden = willShow ? 'true' : 'false';
      hiddenToggleBtn.title = willShow
        ? 'Hide completed / archived children'
        : 'Show completed / archived children';
      setIcon(hiddenToggleBtn, willShow ? 'eye' : 'eye-off');
      void this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody);
    });
    childrenActions.appendChild(hiddenToggleBtn);

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

    const attachmentBody = document.createElement('div');
    attachmentBody.className = 'tps-gcm-subitems-body tps-gcm-subitems-body--attachments';

    attachmentSection.appendChild(attachmentHeader);
    attachmentSection.appendChild(attachmentBody);
    section.appendChild(attachmentSection);

    // Set up drop zones once — after both bodies are in the DOM
    const getBodyRefs = () => [childrenBody, attachmentBody] as [HTMLElement, HTMLElement];
    this.setupDropZone(childrenBody, 'child', rootFile, getBodyRefs);
    this.setupDropZone(attachmentBody, 'attachment', rootFile, getBodyRefs);

    // Initial load — fire immediately, then re-fire after a short delay so that any
    // in-flight metadata cache updates (e.g. from a just-completed processFrontMatter)
    // are fully settled before the second render.
    void this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody);
    window.setTimeout(() => {
      void this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody);
    }, 400);
    return section;
  }

  createNoteReferencesPanel(rootFile: TFile): HTMLElement {
    const section = document.createElement('section');
    section.className = 'tps-gcm-note-references';
    section.dataset.filePath = rootFile.path;

    const header = document.createElement('div');
    header.className = 'tps-gcm-note-references-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'tps-gcm-note-references-title-wrap';

    const title = document.createElement('h3');
    title.className = 'tps-gcm-note-references-title';
    title.textContent = 'References';
    titleWrap.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.className = 'tps-gcm-note-references-subtitle';
    subtitle.textContent = 'Outgoing links, backlinks, and mentions';
    titleWrap.appendChild(subtitle);

    header.appendChild(titleWrap);
    section.appendChild(header);

    const body = document.createElement('div');
    body.className = 'tps-gcm-note-references-body';
    section.appendChild(body);

    void this.refreshNoteReferencesPanel(rootFile, body);
    window.setTimeout(() => {
      void this.refreshNoteReferencesPanel(rootFile, body);
    }, 250);

    return section;
  }

  createNoteGraphPanel(rootFile: TFile): HTMLElement {
    const section = document.createElement('aside');
    section.className = 'tps-gcm-note-graph';
    section.dataset.filePath = rootFile.path;
    section.setAttribute('aria-label', 'Reference graph');
    section.setAttribute('role', 'button');
    section.setAttribute('tabindex', '0');
    section.setAttribute('aria-description', 'Open the master graph focused on this note');

    const openMasterGraph = () => {
      void this.openMasterGraphForFile(rootFile);
    };
    section.addEventListener('click', () => openMasterGraph());
    section.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        openMasterGraph();
      }
    });

    const header = document.createElement('div');
    header.className = 'tps-gcm-note-graph-header';
    header.textContent = 'Graph';
    section.appendChild(header);

    const body = document.createElement('div');
    body.className = 'tps-gcm-note-graph-body';
    section.appendChild(body);

    void this.refreshNoteGraphPanel(rootFile, body);
    window.setTimeout(() => {
      void this.refreshNoteGraphPanel(rootFile, body);
    }, 250);

    return section;
  }

  async refreshNoteReferencesPanel(rootFile: TFile, body: HTMLElement): Promise<void> {
    if (!body.isConnected) return;
    const refreshToken = `${Date.now()}-${Math.random()}`;
    body.dataset.refreshToken = refreshToken;
    body.innerHTML = '';

    const references = await this.collectReferenceGroups(rootFile);
    if (!body.isConnected || body.dataset.refreshToken !== refreshToken) return;
    this.renderReferencesSection(body, references, rootFile, true); // pass true for standalone
  }

  async refreshNoteGraphPanel(rootFile: TFile, body: HTMLElement): Promise<void> {
    if (!body.isConnected) return;
    const refreshToken = `${Date.now()}-${Math.random()}`;
    body.dataset.refreshToken = refreshToken;
    body.innerHTML = '';

    const graphData = await this.collectGraphData(rootFile);
    if (!body.isConnected || body.dataset.refreshToken !== refreshToken) return;
    const totalNodes = graphData.incoming.length + graphData.outgoing.length + graphData.mentions.length;
    if (totalNodes === 0) {
      const empty = document.createElement('div');
      empty.className = 'tps-gcm-note-graph-empty';
      empty.textContent = 'No linked notes';
      body.appendChild(empty);
      return;
    }
    body.appendChild(this.createNoteGraphSvg(rootFile, graphData));
  }

  private async openMasterGraphForFile(rootFile: TFile): Promise<void> {
    const search = this.buildGraphFocusSearch(rootFile);
    const options = await this.loadMasterGraphOptions(search);
    let leaf = this.app.workspace.getLeavesOfType('graph')[0] ?? null;

    try {
      if (!leaf) {
        leaf = this.app.workspace.getLeaf('tab');
      }
      await this.applyMasterGraphViewState(leaf, options);
      this.app.workspace.setActiveLeaf(leaf, true, true);
    } catch (error) {
      logger.warn('[TPS GCM] Failed opening master graph via view state, falling back to command.', error);
      const opened = (this.app as any)?.commands?.executeCommandById?.('graph:Open graph view');
      if (!opened) {
        new Notice('Unable to open the graph view.');
        return;
      }
      window.setTimeout(async () => {
        const graphLeaf = this.app.workspace.getLeavesOfType('graph')[0];
        if (!graphLeaf) return;
        try {
          await this.applyMasterGraphViewState(graphLeaf, options);
          this.app.workspace.setActiveLeaf(graphLeaf, true, true);
        } catch (fallbackError) {
          logger.warn('[TPS GCM] Failed applying graph focus state after fallback open.', fallbackError);
        }
      }, 120);
    }
  }

  private buildGraphFocusSearch(rootFile: TFile): string {
    const escapedBasename = rootFile.basename.replace(/"/g, '\\"');
    const escapedPath = rootFile.path.replace(/"/g, '\\"');
    return `"${escapedBasename}" path:"${escapedPath}"`;
  }

  private async loadMasterGraphOptions(search: string): Promise<Record<string, unknown>> {
    const defaultOptions: Record<string, unknown> = { search };
    const graphConfigPath = normalizePath(`${this.app.vault.configDir}/graph.json`);

    try {
      if (!(await this.app.vault.adapter.exists(graphConfigPath))) {
        return defaultOptions;
      }
      const raw = await this.app.vault.adapter.read(graphConfigPath);
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return defaultOptions;
      }
      return {
        ...(parsed as Record<string, unknown>),
        search,
      };
    } catch (error) {
      logger.warn('[TPS GCM] Failed loading graph.json options, using focused defaults.', error);
      return defaultOptions;
    }
  }

  private async applyMasterGraphViewState(leaf: WorkspaceLeaf, options: Record<string, unknown>): Promise<void> {
    await leaf.setViewState({
      type: 'graph',
      active: true,
      state: options,
    });
  }

  private async populateParentNavButton(rootFile: TFile, container: HTMLElement): Promise<void> {
    container.innerHTML = '';

    const parentFiles = this.resolveParentFilesFor(rootFile);

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
        void this.plugin.openFileInLeaf(parentFiles[0], false, () => this.app.workspace.getLeaf(false), {
          revealLeaf: true,
          ignoreCanvasDragGuard: true,
        });
      } else {
        // Multiple parents: show menu
        const menu = new Menu();
        for (const parentFile of parentFiles) {
          menu.addItem((item) => {
            item
              .setTitle(this.getFileDisplayTitle(parentFile))
              .setIcon('file-text')
              .onClick(() => {
                void this.plugin.openFileInLeaf(parentFile, false, () => this.app.workspace.getLeaf(false), {
                  revealLeaf: true,
                  ignoreCanvasDragGuard: true,
                });
              });
          });
          menu.addItem((item) => {
            item
              .setTitle(`Unlink from "${this.getFileDisplayTitle(parentFile)}"`)
              .setIcon('unlink')
              .onClick(() => {
                void this.plugin.bulkEditService.unlinkFromParent(rootFile, parentFile).then(() => {
                  void this.populateParentNavButton(rootFile, container);
                });
              });
          });
        }
        menu.addSeparator();
        menu.addItem((item) => {
          item
            .setTitle('Unlink from all parents')
            .setIcon('unlink-2')
            .onClick(() => {
              void this.plugin.bulkEditService.unlinkFromAllParents(rootFile).then((count) => {
                if (count > 0) {
                  new Notice(`Removed ${count} parent link${count === 1 ? '' : 's'}.`);
                }
                void this.populateParentNavButton(rootFile, container);
              });
            });
        });
        menu.showAtPosition({ x: navButton.getBoundingClientRect().left, y: navButton.getBoundingClientRect().bottom });
      }
    });

    navButton.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const menu = new Menu();
      for (const parentFile of parentFiles) {
        const unlinkTitle = parentFiles.length === 1 ? 'Unlink from parent' : `Unlink from "${this.getFileDisplayTitle(parentFile)}"`;
        menu.addItem((item) => {
          item
            .setTitle(unlinkTitle)
            .setIcon('unlink')
            .onClick(() => {
              void this.plugin.bulkEditService.unlinkFromParent(rootFile, parentFile).then(() => {
                void this.populateParentNavButton(rootFile, container);
              });
            });
        });
      }
      menu.addSeparator();
      menu.addItem((item) => {
        item
          .setTitle('Unlink from all parents')
          .setIcon('unlink-2')
          .onClick(() => {
            void this.plugin.bulkEditService.unlinkFromAllParents(rootFile).then((count) => {
              if (count > 0) {
                new Notice(`Removed ${count} parent link${count === 1 ? '' : 's'}.`);
              }
              void this.populateParentNavButton(rootFile, container);
            });
          });
      });
      menu.showAtMouseEvent(evt);
    });

    container.appendChild(navButton);
  }

  private resolveParentFilesFor(rootFile: TFile): TFile[] {
    const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'childOf').trim() || 'childOf';
    const childKey = String(this.plugin.settings.childLinkFrontmatterKey || 'parentOf').trim() || 'parentOf';
    const parentByPath = new Map<string, TFile>();

    const ownCache = this.app.metadataCache.getFileCache(rootFile);
    const ownFm = (ownCache?.frontmatter || {}) as Record<string, any>;
    const directParentsRaw = this.getFrontmatterValueCaseInsensitive(ownFm, parentKey);
    for (const parentFile of this.parseLinksFromFrontmatterValue(directParentsRaw, rootFile.path)) {
      if (parentFile.path !== rootFile.path) {
        parentByPath.set(parentFile.path, parentFile);
      }
    }

    // Reverse-only link support: parent note defines this note in its child key.
    for (const candidate of this.app.vault.getMarkdownFiles()) {
      if (candidate.path === rootFile.path) continue;
      const candidateFm = (this.app.metadataCache.getFileCache(candidate)?.frontmatter || {}) as Record<string, any>;
      const childRaw = this.getFrontmatterValueCaseInsensitive(candidateFm, childKey);
      const children = this.parseLinksFromFrontmatterValue(childRaw, candidate.path);
      if (children.some((child) => child.path === rootFile.path)) {
        parentByPath.set(candidate.path, candidate);
      }
    }

    return Array.from(parentByPath.values());
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
    attachmentBody: HTMLElement
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
        void this.refreshSubitemsPanel(rootFile, childrenBody, attachmentBody);
      }, SUBITEM_PANEL_REFRESH_DEBOUNCE_MS)
    );
  }

  private async refreshSubitemsPanel(
    rootFile: TFile,
    childrenBody: HTMLElement,
    attachmentBody: HTMLElement
  ): Promise<void> {
    const now = Date.now();
    const lastReconcileAt = this.subitemLinkReconcileAt.get(rootFile.path) ?? 0;
    if (now - lastReconcileAt >= SUBITEM_LINK_RECONCILE_INTERVAL_MS) {
      this.subitemLinkReconcileAt.set(rootFile.path, now);
      try {
        const repaired = await this.plugin.bulkEditService.reconcileParentChildLinksForParent(rootFile);
        if (repaired > 0) {
          logger.log(`[TPS GCM] Reconciled ${repaired} parent/child link update(s) for ${rootFile.path}`);
        }
      } catch (error) {
        logger.warn('[TPS GCM] Failed reconciling parent/child links for subitems panel:', rootFile.path, error);
      }
    }

    // Refresh the parent nav button alongside children/attachments so it stays in sync
    // after operations like linkToParent that change the parent frontmatter key.
    const panel = childrenBody.closest('.tps-gcm-subitems-panel');
    const navContainer = panel?.querySelector<HTMLElement>('.tps-gcm-parent-nav-container');
    if (navContainer) {
      const isCollapsed = panel?.classList.contains('tps-gcm-subitems-panel--collapsed') ?? false;
      navContainer.style.display = isCollapsed ? 'none' : '';
      void this.populateParentNavButton(rootFile, navContainer);
    }
    try {
      const tree = await this.buildSubitemTree(rootFile);

      // Separate children and attachments, track hidden children separately
      const visibleChildren: SubitemNode[] = [];
      const hiddenChildren: SubitemNode[] = [];
      const attachments: SubitemNode[] = [];

      tree.forEach((node) => {
        const isAttachmentOnly = node.relations.includes('attachment') && !node.relations.includes('child');
        if (isAttachmentOnly) {
          attachments.push(node);
        } else if (node.hidden) {
          hiddenChildren.push(node);
        } else {
          visibleChildren.push(node);
        }
      });

      // Read show-hidden state and update toggle button / badge
      const childrenSection = childrenBody.closest<HTMLElement>('.tps-gcm-subitems-section');
      const showHidden = childrenSection?.dataset.showHidden === 'true';

      const toggleBtn = panel?.querySelector<HTMLButtonElement>('.tps-gcm-subitems-hidden-toggle');
      const hiddenBadge = panel?.querySelector<HTMLElement>('.tps-gcm-subitems-hidden-badge');
      const checklistItems = await (
        this.plugin.settings.showChecklistInSubitemsPanel
          ? this.collectChecklistSubitems(rootFile)
          : Promise.resolve([])
      );

      const hasHidden = hiddenChildren.length > 0;
      const totalChildren = visibleChildren.length + hiddenChildren.length;
      const totalAttachments = attachments.length;
      const totalChecklist = checklistItems.length;
      const totalItems = totalChildren + totalAttachments + totalChecklist;
      const expandCountEl = panel?.querySelector<HTMLElement>('.tps-gcm-expand-count');
      if (expandCountEl) {
        const parts: string[] = [];
        if (totalChildren > 0) parts.push(`C:${totalChildren}`);
        if (totalAttachments > 0) parts.push(`A:${totalAttachments}`);
        if (totalChecklist > 0) parts.push(`K:${totalChecklist}`);
        expandCountEl.textContent = parts.length ? parts.join(' ') : '0';
        expandCountEl.title = `Children: ${totalChildren}, Attachments: ${totalAttachments}, Checklist: ${totalChecklist}, Total: ${totalItems}`;
      }

      if (toggleBtn) {
        toggleBtn.style.display = hasHidden ? '' : 'none';
        if (hasHidden) {
          toggleBtn.title = showHidden
            ? 'Hide completed / archived children'
            : 'Show completed / archived children';
          setIcon(toggleBtn, showHidden ? 'eye' : 'eye-off');
        }
      }
      if (hiddenBadge) {
        hiddenBadge.style.display = hasHidden ? '' : 'none';
        hiddenBadge.textContent = `${hiddenChildren.length} hidden`;
      }

      const childrenToRender = showHidden
        ? [...visibleChildren, ...hiddenChildren]
        : visibleChildren;

      const getBodyRefs = (): [HTMLElement, HTMLElement] => [childrenBody, attachmentBody];

      // Render children section
      this.renderSubitemsSection(
        childrenBody,
        childrenToRender,
        rootFile,
        'No linked children yet. Use + to create one.',
        getBodyRefs,
        checklistItems
      );

      // Render attachments section
      this.renderSubitemsSection(attachmentBody, attachments, rootFile, 'No attachments yet. Use + to create one.', getBodyRefs);

      // Auto-collapse: advance the state machine on each render pass.
      // 'pending' → 'ready' on first render; 'ready' → collapsed/expanded on second render.
      if (panel instanceof HTMLElement) {
        const ac = panel.dataset.autoCollapse;
        if (ac === 'pending') {
          panel.dataset.autoCollapse = 'ready';
        } else if (ac === 'ready') {
          delete panel.dataset.autoCollapse;
          const hasContent =
            visibleChildren.length > 0 ||
            hiddenChildren.length > 0 ||
            attachments.length > 0 ||
            checklistItems.length > 0;
          if (hasContent) {
            panel.classList.remove('tps-gcm-subitems-panel--collapsed');
            this.plugin.persistentMenuManager.setSubitemsPanelCollapsed(rootFile.path, false);
          } else {
            panel.classList.add('tps-gcm-subitems-panel--collapsed');
            this.plugin.persistentMenuManager.setSubitemsPanelCollapsed(rootFile.path, true);
          }
        }
      }
    } catch (error) {
      logger.error('[TPS GCM] Failed to render subitems panel:', error);
      childrenBody.innerHTML = '';
      attachmentBody.innerHTML = '';
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
      this.scheduleSubitemsPanelRefresh(rootFile, childrenBody, attachmentBody);
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
      this.scheduleSubitemsPanelRefresh(rootFile, childrenBody, attachmentBody);
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
    checkbox.title = 'Complete (right-click for more options)';
    checkbox.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (checkbox.disabled) return;
      checkbox.disabled = true;
      void this.toggleChecklistItemFromPanel(rootFile, item, row, onRefresh).finally(() => {
        checkbox.disabled = false;
      });
    });

    const showChecklistStateMenu = (x: number, y: number) => {
      const menu = new Menu();
      menu.addItem((mi) => {
        mi.setTitle('Complete')
          .setIcon('check')
          .onClick(() => {
            void this.setChecklistItemStateFromPanel(rootFile, item, row, 'x', onRefresh);
          });
      });
      menu.addItem((mi) => {
        mi.setTitle('Cross out')
          .setIcon('minus')
          .onClick(() => {
            void this.setChecklistItemStateFromPanel(rootFile, item, row, '-', onRefresh);
          });
      });
      menu.addItem((mi) => {
        mi.setTitle('Question')
          .setIcon('help-circle')
          .onClick(() => {
            void this.setChecklistItemStateFromPanel(rootFile, item, row, '?', onRefresh);
          });
      });
      menu.showAtPosition({ x, y });
    };

    checkbox.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      showChecklistStateMenu(evt.clientX, evt.clientY);
    });

    // Long-press for touch devices
    let longPressTimer: number | null = null;
    checkbox.addEventListener('touchstart', (evt) => {
      longPressTimer = window.setTimeout(() => {
        longPressTimer = null;
        const touch = evt.touches[0];
        showChecklistStateMenu(touch?.clientX ?? 0, touch?.clientY ?? 0);
      }, 500);
    }, { passive: true });
    const cancelLongPress = () => {
      if (longPressTimer !== null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    };
    checkbox.addEventListener('touchmove', cancelLongPress, { passive: true });
    checkbox.addEventListener('touchend', cancelLongPress, { passive: true });
    checkbox.addEventListener('touchcancel', cancelLongPress, { passive: true });

    const content = document.createElement('div');
    content.className = 'tps-gcm-subitem-content';

    const header = document.createElement('div');
    header.className = 'tps-gcm-subitem-header';
    header.appendChild(checkbox);

    const textWrap = document.createElement('div');
    textWrap.className = 'tps-gcm-subitem-text';

    const titleLine = document.createElement('div');
    titleLine.className = 'tps-gcm-subitem-title-line';
    const title = document.createElement('span');
    title.className = 'tps-gcm-subitem-title tps-gcm-subitem-title--checklist';
    title.textContent = item.text;
    title.title = `${rootFile.path}:${item.lineNumber + 1}`;
    addSafeClickListener(title, () => {
      void this.scrollToChecklistLine(rootFile, item);
    });
    titleLine.appendChild(title);

    const metaRow = document.createElement('div');
    metaRow.className = 'tps-gcm-subitem-meta';

    const stateBadge = document.createElement('span');
    stateBadge.className = 'tps-gcm-subitem-relation';
    stateBadge.textContent = item.state === '?' ? 'question' : item.state === '-' ? 'canceled' : 'open';
    metaRow.appendChild(stateBadge);

    const lineInfo = document.createElement('span');
    lineInfo.className = 'tps-gcm-subitem-path';
    lineInfo.textContent = `line ${item.lineNumber + 1}`;
    metaRow.appendChild(lineInfo);

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

    metaRow.appendChild(actions);
    textWrap.appendChild(titleLine);
    textWrap.appendChild(metaRow);
    header.appendChild(textWrap);
    content.appendChild(header);
    row.appendChild(content);

    container.appendChild(row);
  }

  private async toggleChecklistItemFromPanel(
    rootFile: TFile,
    item: ChecklistSubitem,
    rowEl: HTMLElement,
    onRefresh: () => void
  ): Promise<void> {
    // Standard toggle: mark complete. The item disappears (filtered by collectChecklistSubitems).
    await this.setChecklistItemStateFromPanel(rootFile, item, rowEl, 'x', onRefresh);
  }

  private async setChecklistItemStateFromPanel(
    rootFile: TFile,
    item: ChecklistSubitem,
    rowEl: HTMLElement,
    newState: ChecklistTaskState,
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
        `$1[${newState}]$3`
      );
      if (updatedLine === currentLine) return;

      lines[lineIndex] = updatedLine;
      const updatedContent = lines.join('\n');
      if (updatedContent === content) return;

      await this.app.vault.modify(rootFile, updatedContent);
      // x / X / - are filtered out of the panel — fade and remove the row
      if (newState === 'x' || newState === 'X' || newState === '-') {
        rowEl.style.opacity = '0';
        rowEl.style.pointerEvents = 'none';
        window.setTimeout(() => rowEl.remove(), 120);
      }
      const pluginAny = this.plugin as any;
      if (typeof pluginAny.scheduleChecklistReorder === 'function') {
        pluginAny.scheduleChecklistReorder(rootFile);
      }
      window.setTimeout(() => onRefresh(), 180);
    } catch (error) {
      logger.warn('[TPS GCM] Failed setting checklist item state from subitems panel for', rootFile.path, error);
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
      this.getDefaultSubitemFolderPath(rootFile),
      {
        seedDefaults: false,
        seedParentTags: false,
        seedVisualMetadata: false,
      }
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
      const behavior = this.plugin.settings.checklistPromotionBehavior ?? 'complete-and-link';
      if (behavior === 'remove') {
        lines.splice(lineIndex, 1);
      } else if (behavior === 'link-only') {
        const nextState = parsed.state === 'x' || parsed.state === 'X' || parsed.state === '-' ? ' ' : parsed.state;
        lines[lineIndex] = `${parsed.prefix}[${nextState}] ${markdownLink}`;
      } else {
        lines[lineIndex] = `${parsed.prefix}[x] ${markdownLink}`;
      }
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

  private async scrollToChecklistLine(rootFile: TFile, item: ChecklistSubitem): Promise<void> {
    try {
      // Resolve the actual line index (may have shifted since panel was rendered)
      const content = await this.app.vault.cachedRead(rootFile);
      const lines = content.split('\n');
      const lineIndex = this.resolveChecklistLineIndex(lines, item);
      if (lineIndex < 0) return;

      // Find the leaf showing this file
      const leaf = this.app.workspace.getLeavesOfType('markdown')
        .find((l: any) => l?.view?.file?.path === rootFile.path);
      if (!leaf) return;

      const view = leaf.view as MarkdownView;
      const viewState = (view as any).getState?.() || {};
      const isReading = viewState.mode === 'preview';

      if (isReading) {
        this.scrollInReadingMode(view, lineIndex, item.text);
      } else {
        this.scrollInEditorMode(view, lineIndex);
      }
    } catch (error) {
      logger.warn('[TPS GCM] Failed scrolling to checklist line for', rootFile.path, error);
    }
  }

  private scrollInEditorMode(view: MarkdownView, lineIndex: number): void {
    const editor = view.editor;
    if (!editor || typeof editor.setCursor !== 'function') return;

    editor.setCursor({ line: lineIndex, ch: 0 });
    if (typeof editor.scrollIntoView === 'function') {
      editor.scrollIntoView(
        { from: { line: lineIndex, ch: 0 }, to: { line: lineIndex + 1, ch: 0 } },
        true
      );
    }

    // Flash-highlight after a short delay so CM6 updates the DOM
    window.setTimeout(() => {
      try {
        const cmEditor = (editor as any)?.cm;
        if (!cmEditor) return;
        const lineInfo = cmEditor.state?.doc?.line(lineIndex + 1);
        if (!lineInfo) return;

        const domResult = cmEditor.domAtPos?.(lineInfo.from);
        if (!domResult) return;
        const node = domResult.node;
        const lineEl = node instanceof HTMLElement
          ? (node.closest('.cm-line') || node)
          : node?.parentElement?.closest?.('.cm-line');

        if (lineEl instanceof HTMLElement) {
          lineEl.classList.add('tps-gcm-line-highlight');
          window.setTimeout(() => lineEl.classList.remove('tps-gcm-line-highlight'), 1500);
        }
      } catch {
        // Highlight is purely cosmetic
      }
    }, 80);
  }

  private scrollInReadingMode(view: MarkdownView, lineIndex: number, itemText: string): void {
    const previewEl = (view as any).previewMode?.containerEl
      || view.containerEl?.querySelector('.markdown-preview-view');
    if (!previewEl) return;

    // Reading mode renders checklist items as <li> with class "task-list-item"
    // We match by text content since line numbers aren't preserved in the DOM
    const taskItems = previewEl.querySelectorAll('li.task-list-item') as NodeListOf<HTMLElement>;
    const normalizedTarget = itemText.replace(/\s+/g, ' ').trim().toLowerCase();

    let matchedEl: HTMLElement | null = null;
    for (const li of Array.from(taskItems)) {
      const liText = (li.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (liText.includes(normalizedTarget)) {
        matchedEl = li as HTMLElement;
        break;
      }
    }

    if (!matchedEl) {
      // Fallback: try to find by position among all list items
      // Count all checklist lines up to lineIndex to get approximate position
      // This won't be perfect but provides a reasonable fallback
      return;
    }

    matchedEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Flash highlight
    matchedEl.classList.add('tps-gcm-line-highlight');
    window.setTimeout(() => matchedEl!.classList.remove('tps-gcm-line-highlight'), 1500);
  }

  private flashHighlightLine(_cmEditor: any, _lineIndex: number): void {
    // Deprecated: highlighting is now handled inline by scrollInEditorMode / scrollInReadingMode
  }

  async collectReferenceGroups(rootFile: TFile): Promise<ReferenceData> {
    const outgoingOccurrences = await this.extractReferenceOccurrencesFromSource(rootFile);
    const outgoing = this.groupReferenceOccurrences(outgoingOccurrences, 'outgoing');

    const incomingSourceFiles = this.getIncomingReferenceSourceFiles(rootFile);
    const incomingBatches = await Promise.all(
      incomingSourceFiles.map(async (sourceFile) => this.extractReferenceOccurrencesFromSource(sourceFile, rootFile))
    );
    const incoming = this.groupReferenceOccurrences(incomingBatches.flat(), 'incoming');

    const mentions = await this.collectUnlinkedMentionGroups(rootFile);
    const referencedPaths = new Set<string>([
      ...outgoing.map((group) => group.file.path),
      ...incoming.map((group) => group.file.path),
    ]);

    // Fold children & parent into mentions
    const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'childOf').trim() || 'childOf';
    const parentIndex = this.buildParentToChildrenIndex();
    const childFiles = parentIndex.get(rootFile.path) || [];
    const existingMentionPaths = new Set(mentions.map((m) => m.file.path));

    for (const child of childFiles) {
      if (child.path === rootFile.path || existingMentionPaths.has(child.path) || referencedPaths.has(child.path)) continue;
      existingMentionPaths.add(child.path);
      mentions.push({
        file: child,
        occurrences: [{
          sourceFile: child,
          targetFile: rootFile,
          lineNumber: 0,
          heading: '',
          previews: [`${parentKey}: [[${rootFile.basename}]]`],
          matchedText: rootFile.basename,
          frontmatterKey: parentKey,
        }],
      });
    }

    // Add parent as a mention (the current file's frontmatter references the parent)
    const rootFm = (this.app.metadataCache.getFileCache(rootFile)?.frontmatter || {}) as Record<string, any>;
    const parentRaw = this.getFrontmatterValueCaseInsensitive(rootFm, parentKey);
    const parentFiles = this.parseLinksFromFrontmatterValue(parentRaw, rootFile.path);
    for (const parentFile of parentFiles) {
      if (parentFile.path === rootFile.path || existingMentionPaths.has(parentFile.path) || referencedPaths.has(parentFile.path)) continue;
      existingMentionPaths.add(parentFile.path);
      mentions.push({
        file: parentFile,
        occurrences: [{
          sourceFile: rootFile,
          targetFile: parentFile,
          lineNumber: 0,
          heading: '',
          previews: [`${parentKey}: [[${parentFile.basename}]]`],
          matchedText: parentFile.basename,
          frontmatterKey: parentKey,
        }],
      });
    }

    // Fold attachments into outgoing
    const attachmentFiles = await this.resolveAttachmentFilesFromFrontmatter(rootFile);
    const existingOutgoingPaths = new Set(outgoing.map((g) => g.file.path));
    for (const attachment of attachmentFiles) {
      if (attachment.path === rootFile.path || existingOutgoingPaths.has(attachment.path)) continue;
      existingOutgoingPaths.add(attachment.path);
      outgoing.push({
        file: attachment,
        direction: 'outgoing',
        occurrences: [{
          sourceFile: rootFile,
          targetFile: attachment,
          lineNumber: 0,
          heading: '',
          previews: [`attachment: ${attachment.basename}`],
          matchedText: attachment.basename,
          frontmatterKey: 'attachments',
        }],
      });
    }

    // Sort after merging
    mentions.sort((a, b) => this.getFileDisplayTitle(a.file).localeCompare(this.getFileDisplayTitle(b.file)));
    outgoing.sort((a, b) => this.getFileDisplayTitle(a.file).localeCompare(this.getFileDisplayTitle(b.file)));

    return { outgoing, incoming, mentions };
  }

  private async collectGraphData(rootFile: TFile): Promise<GraphData> {
    const depth = Math.max(1, Math.min(3, Math.floor(this.plugin.settings.noteGraphDepth ?? 1)));
    const maxIncoming = Math.max(1, Math.floor(this.plugin.settings.noteGraphMaxIncoming ?? 3));
    const maxOutgoing = Math.max(1, Math.floor(this.plugin.settings.noteGraphMaxOutgoing ?? 3));
    const maxMentions = Math.max(0, Math.floor(this.plugin.settings.noteGraphMaxMentions ?? 2));

    const outgoing = await this.collectOutgoingGraphFiles(rootFile, depth, maxOutgoing);
    const incoming = await this.collectIncomingGraphFiles(rootFile, depth, maxIncoming);
    const mentionGroups = maxMentions > 0 ? await this.collectUnlinkedMentionGroups(rootFile) : [];
    const mentions = mentionGroups.slice(0, maxMentions).map((group) => group.file);

    return { outgoing, incoming, mentions };
  }

  private async collectOutgoingGraphFiles(rootFile: TFile, depth: number, limit: number): Promise<TFile[]> {
    const seen = new Set<string>([rootFile.path]);
    const collected: TFile[] = [];
    let frontier: TFile[] = [rootFile];

    for (let level = 0; level < depth && frontier.length > 0 && collected.length < limit; level += 1) {
      const nextFrontier: TFile[] = [];
      for (const file of frontier) {
        const occurrences = await this.extractReferenceOccurrencesFromSource(file);
        const targets = occurrences
          .map((occurrence) => occurrence.targetFile)
          .filter((target): target is TFile => target instanceof TFile && target.extension?.toLowerCase() === 'md');

        for (const target of targets) {
          if (seen.has(target.path)) continue;
          seen.add(target.path);
          collected.push(target);
          nextFrontier.push(target);
          if (collected.length >= limit) break;
        }

        if (collected.length >= limit) break;
      }
      frontier = nextFrontier;
    }

    return collected;
  }

  private async collectIncomingGraphFiles(rootFile: TFile, depth: number, limit: number): Promise<TFile[]> {
    const seen = new Set<string>([rootFile.path]);
    const collected: TFile[] = [];
    let frontier: TFile[] = [rootFile];

    for (let level = 0; level < depth && frontier.length > 0 && collected.length < limit; level += 1) {
      const nextFrontier: TFile[] = [];
      for (const file of frontier) {
        const sources = this.getIncomingReferenceSourceFiles(file);
        for (const source of sources) {
          if (seen.has(source.path)) continue;
          const occurrences = await this.extractReferenceOccurrencesFromSource(source, file);
          if (occurrences.length === 0) continue;
          seen.add(source.path);
          collected.push(source);
          nextFrontier.push(source);
          if (collected.length >= limit) break;
        }
        if (collected.length >= limit) break;
      }
      frontier = nextFrontier;
    }

    return collected;
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

          // Use the full link syntax as focus text so the preview centers on it
          const linkSnippet = line.slice(match.start, match.end);
          occurrences.push({
            sourceFile,
            targetFile,
            lineNumber,
            heading: this.findHeadingForLine(headings, lineNumber),
            previews: this.buildReferencePreviewLevels(lines, lineNumber, linkSnippet),
            matchedText: linkSnippet,
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

  private buildReferencePreviewLevels(lines: string[], lineNumber: number, focusText?: string): string[] {
    const linePreview = this.cropPreviewText(lines[lineNumber] || '', 140, focusText);
    const paragraphPreview = this.cropPreviewText(this.extractParagraphPreview(lines, lineNumber), 320, focusText);
    const sectionPreview = this.cropPreviewText(this.extractSectionPreview(lines, lineNumber), 520, focusText);
    return Array.from(new Set([linePreview, paragraphPreview, sectionPreview].filter(Boolean)));
  }

  private cropPreviewText(text: string, maxLength = 140, focusText?: string): string {
    const normalized = String(text || '').replace(/\t/g, '  ').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    if (normalized.length <= maxLength) return normalized;

    // If a focus string is provided, try to center the window around it
    if (focusText) {
      const idx = normalized.toLowerCase().indexOf(focusText.toLowerCase());
      if (idx >= 0) {
        const matchEnd = idx + focusText.length;
        const half = Math.floor((maxLength - focusText.length) / 2);
        let start = Math.max(0, idx - half);
        let end = Math.min(normalized.length, start + maxLength - 1);
        // If we hit the end, shift start back
        if (end >= normalized.length) {
          end = normalized.length;
          start = Math.max(0, end - maxLength + 1);
        }
        const prefix = start > 0 ? '…' : '';
        const suffix = end < normalized.length ? '…' : '';
        return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
      }
    }

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
      .sort((a, b) => this.getFileDisplayTitle(a.file).localeCompare(this.getFileDisplayTitle(b.file)));
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

    return groups.sort((a, b) => this.getFileDisplayTitle(a.file).localeCompare(this.getFileDisplayTitle(b.file)));
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

  private getFileDisplayTitle(file: TFile): string {
    const frontmatter = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
    const titleValue = this.getFrontmatterValueCaseInsensitive(frontmatter, 'title');
    if (typeof titleValue === 'string' && titleValue.trim()) {
      return titleValue.trim();
    }
    return file.basename;
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

      // Scan body lines
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
          previews: this.buildReferencePreviewLevels(lines, lineNumber, matchedText),
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
    references: ReferenceData,
    rootFile: TFile,
    forceShowAll = false
  ): void {
    body.innerHTML = '';
    const showReferences = forceShowAll || this.plugin.settings.showReferencesInSubitemsPanel;
    const showMentions = forceShowAll || this.plugin.settings.showMentionsInSubitemsPanel;

    const bodyOutgoing = references.outgoing
      .map((group) => ({ ...group, occurrences: group.occurrences.filter((o) => !o.frontmatterKey) }))
      .filter((group) => group.occurrences.length > 0);
    const bodyIncoming = references.incoming
      .map((group) => ({ ...group, occurrences: group.occurrences.filter((o) => !o.frontmatterKey) }))
      .filter((group) => group.occurrences.length > 0);
    const bodyMentions = references.mentions
      .map((group) => ({ ...group, occurrences: group.occurrences.filter((o) => !o.frontmatterKey) }))
      .filter((group) => group.occurrences.length > 0);

    const fmByKey = new Map<string, Array<{ file: TFile; occurrence: ReferenceOccurrence }>>();
    const collectFrontmatter = (groups: Array<{ file: TFile; occurrences: ReferenceOccurrence[] }>) => {
      for (const group of groups) {
        for (const occurrence of group.occurrences) {
          if (!occurrence.frontmatterKey) continue;
          if (!fmByKey.has(occurrence.frontmatterKey)) {
            fmByKey.set(occurrence.frontmatterKey, []);
          }
          fmByKey.get(occurrence.frontmatterKey)?.push({ file: group.file, occurrence });
        }
      }
    };
    collectFrontmatter(references.outgoing);
    collectFrontmatter(references.incoming);
    collectFrontmatter(references.mentions);

    const ignoredKeys = new Set(
      (this.plugin.settings.ignoredBacklinksFrontmatterKeys || []).map((key: string) => key.toLowerCase())
    );
    for (const key of [...fmByKey.keys()]) {
      if (ignoredKeys.has(key.toLowerCase())) {
        fmByKey.delete(key);
      }
    }

    if (
      (!showReferences || (bodyOutgoing.length === 0 && bodyIncoming.length === 0 && fmByKey.size === 0))
      && (!showMentions || bodyMentions.length === 0)
    ) {
      const empty = document.createElement('div');
      empty.className = 'tps-gcm-subitem-empty';
      empty.textContent = 'No references yet.';
      body.appendChild(empty);
      return;
    }

    if (showReferences && bodyOutgoing.length > 0) {
      body.appendChild(this.createOutgoingReferenceSection(bodyOutgoing));
    }

    if (showReferences && bodyIncoming.length > 0) {
      body.appendChild(this.createReferenceDirectionSection('Incoming', bodyIncoming, 'incoming'));
    }

    if (showMentions && bodyMentions.length > 0) {
      body.appendChild(this.createMentionsSection(bodyMentions, rootFile));
    }

    if (showReferences && fmByKey.size > 0) {
      body.appendChild(this.createFrontmatterReferenceSection(fmByKey));
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
      button.textContent = this.getFileDisplayTitle(group.file);
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
    titleButton.textContent = this.getFileDisplayTitle(group.file);
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
      titleButton.textContent = this.getFileDisplayTitle(group.file);
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

  private createFrontmatterReferenceSection(
    fmByKey: Map<string, Array<{ file: TFile; occurrence: ReferenceOccurrence }>>
  ): HTMLElement {
    const section = document.createElement('div');
    section.className = 'tps-gcm-reference-direction tps-gcm-reference-direction--frontmatter';

    const title = document.createElement('div');
    title.className = 'tps-gcm-reference-direction-title';
    title.textContent = 'Frontmatter';
    section.appendChild(title);

    for (const [key, entries] of fmByKey) {
      const keySection = document.createElement('div');
      keySection.className = 'tps-gcm-reference-frontmatter-group';

      const keyTitle = document.createElement('div');
      keyTitle.className = 'tps-gcm-reference-frontmatter-title';
      keyTitle.textContent = key;
      keySection.appendChild(keyTitle);

      const chips = document.createElement('div');
      chips.className = 'tps-gcm-reference-frontmatter-chips';
      keySection.appendChild(chips);

      entries.forEach(({ file, occurrence }) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'tps-gcm-reference-frontmatter-chip';
        chip.textContent = this.getFileDisplayTitle(file);
        chip.title = file.path;
        addSafeClickListener(chip, () => {
          void this.openReferenceOccurrence(occurrence.sourceFile, occurrence);
        });
        chips.appendChild(chip);
      });

      section.appendChild(keySection);
    }

    return section;
  }

  private createNoteGraphSvg(rootFile: TFile, references: GraphData): SVGSVGElement {
    const svgNs = 'http://www.w3.org/2000/svg';
    const width = 250;
    const height = 144;
    const centerX = 125;
    const centerY = 64;
    const centerRadius = 10;

    const incoming = references.incoming;
    const outgoing = references.outgoing;
    const mentions = references.mentions;

    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('class', 'tps-gcm-note-graph-svg');

    const lanes = [
      { items: incoming, x: 48, relation: 'incoming', color: 'var(--text-accent)' },
      { items: outgoing, x: 202, relation: 'outgoing', color: '#7fc7ff' },
      { items: mentions, x: 125, relation: 'mention', color: '#d6b8ff' },
    ] as const;

    const halo = document.createElementNS(svgNs, 'circle');
    halo.setAttribute('cx', String(centerX));
    halo.setAttribute('cy', String(centerY));
    halo.setAttribute('r', '32');
    halo.setAttribute('class', 'tps-gcm-note-graph-root-halo');
    svg.appendChild(halo);

    const makeNode = (item: TFile, relation: string, color: string, x: number, y: number) => {
      const edge = document.createElementNS(svgNs, 'path');
      const controlX = x < centerX ? centerX - 34 : x > centerX ? centerX + 34 : centerX;
      const controlY = (centerY + y) / 2;
      edge.setAttribute('d', `M ${centerX} ${centerY} Q ${controlX} ${controlY} ${x} ${y}`);
      edge.setAttribute('class', 'tps-gcm-note-graph-edge');
      edge.setAttribute('stroke', color);
      svg.appendChild(edge);

      const node = document.createElementNS(svgNs, 'circle');
      node.setAttribute('cx', String(x));
      node.setAttribute('cy', String(y));
      node.setAttribute('r', '5.5');
      node.setAttribute('fill', color);
      node.setAttribute('class', 'tps-gcm-note-graph-node');
      node.setAttribute('data-path', item.path);
      node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'button');
      node.setAttribute('aria-label', `${relation}: ${item.basename}`);
      const tooltip = document.createElementNS(svgNs, 'title');
      tooltip.textContent = `${relation}: ${item.basename}`;
      node.appendChild(tooltip);
      const openTarget = () => {
        void this.plugin.openFileInLeaf(item, false, () => this.app.workspace.getLeaf(false), { revealLeaf: true });
      };
      node.addEventListener('click', (evt) => {
        evt.stopPropagation();
        openTarget();
      });
      node.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          openTarget();
        }
      });
      svg.appendChild(node);
    };

    lanes.forEach((lane) => {
      const count = lane.items.length;
      lane.items.forEach((item, index) => {
        const y = count <= 1
          ? (lane.x === centerX ? 110 : centerY)
          : 28 + (index * 72) / Math.max(1, count - 1);
        makeNode(item, lane.relation, lane.color, lane.x, y);
      });
    });

    const centerNode = document.createElementNS(svgNs, 'circle');
    centerNode.setAttribute('cx', String(centerX));
    centerNode.setAttribute('cy', String(centerY));
    centerNode.setAttribute('r', String(centerRadius));
    centerNode.setAttribute('class', 'tps-gcm-note-graph-root-node');
    svg.appendChild(centerNode);

    const rootLabel = document.createElementNS(svgNs, 'text');
    rootLabel.setAttribute('x', String(centerX));
    rootLabel.setAttribute('y', String(centerY + 30));
    rootLabel.setAttribute('text-anchor', 'middle');
    rootLabel.setAttribute('class', 'tps-gcm-note-graph-root-label');
    rootLabel.textContent = this.truncateGraphLabel(rootFile.basename, 18);
    svg.appendChild(rootLabel);

    const footer = document.createElementNS(svgNs, 'text');
    footer.setAttribute('x', String(centerX));
    footer.setAttribute('y', String(height - 8));
    footer.setAttribute('text-anchor', 'middle');
    footer.setAttribute('class', 'tps-gcm-note-graph-meta');
    footer.textContent = `${incoming.length} in • ${outgoing.length} out${mentions.length ? ` • ${mentions.length} mentions` : ''}`;
    svg.appendChild(footer);

    return svg;
  }

  private truncateGraphLabel(value: string, maxLength = 12): string {
    const normalized = String(value || '').trim();
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  }

  async openReferenceOccurrence(file: TFile, occurrence: ReferenceOccurrence): Promise<void> {
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

  async convertMentionToLinkedReference(
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
    const identityCache = new Map<string, ReturnType<PanelBuilder['getTaskIdentityForFile']>>();
    const getIdentity = (targetFile: TFile) => {
      const cached = identityCache.get(targetFile.path);
      if (cached) return cached;
      const resolved = this.getTaskIdentityForFile(targetFile);
      identityCache.set(targetFile.path, resolved);
      return resolved;
    };

    // Mark archived / completed children as hidden (they can be shown via the toggle)
    type MarkedEntry = SubitemRelationEntry & { hidden: boolean };
    const markedEntries: MarkedEntry[] = Array.from(relationMap.values()).map((entry) => {
      const identity = getIdentity(entry.file);
      const isHidden =
        this.isArchived(entry.file) ||
        identity.isComplete ||
        identity.isWontDo;
      return { ...entry, hidden: isHidden };
    });

    const relationEntries = markedEntries.sort((a, b) => {
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
        const identity = getIdentity(file);
        if (identity.isComplete || identity.isWontDo) return 4;
        if (identity.allStatuses.some((status) => status === 'working' || status === 'in-progress')) return 1;
        if (identity.allStatuses.includes('blocked')) return 2;
        if (identity.isPending || identity.allStatuses.length === 0) return 3;
        return 5;
      };

      const aStatus = statusWeight(a.file);
      const bStatus = statusWeight(b.file);
      if (aStatus !== bStatus) return aStatus - bStatus;

      return this.getFileDisplayTitle(a.file).localeCompare(this.getFileDisplayTitle(b.file));
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
        hidden: entry.hidden,
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
    const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'childOf').trim() || 'childOf';
    const childKey = String(this.plugin.settings.childLinkFrontmatterKey || 'parentOf').trim() || 'parentOf';
    const index = new Map<string, TFile[]>();

    const addToIndex = (parentPath: string, childFile: TFile) => {
      if (parentPath === childFile.path) return;
      const bucket = index.get(parentPath) || [];
      if (!bucket.some((c) => c.path === childFile.path)) {
        bucket.push(childFile);
      }
      index.set(parentPath, bucket);
    };

    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;

      // Forward direction: file has childOf → [[parent]]
      const parentRaw = this.getFrontmatterValueCaseInsensitive(fm, parentKey);
      const parentFiles = this.parseLinksFromFrontmatterValue(parentRaw, file.path);
      for (const parent of parentFiles) {
        addToIndex(parent.path, file);
      }

      // Reverse direction: file has parentOf → [[child1]], [[child2]]
      const childRaw = this.getFrontmatterValueCaseInsensitive(fm, childKey);
      const childFiles = this.parseLinksFromFrontmatterValue(childRaw, file.path);
      for (const child of childFiles) {
        addToIndex(file.path, child);
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
    const visitedObjects = new Set<any>();

    const consume = (candidate: any) => {
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
        Object.values(candidate).forEach((entry) => consume(entry));
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

  private getTaskIdentityForFile(file: TFile) {
    const entry = this.delegates.createFileEntries([file])[0];
    const frontmatter = this.getResolvedFrontmatter(file, (entry?.frontmatter || {}) as Record<string, any>);
    const statusProperty = this.getStatusPropertyKeyForFile(file, entry);
    const statusValue = this.getFrontmatterValueCaseInsensitive(frontmatter, statusProperty);
    const identityFrontmatter = statusValue === undefined
      ? frontmatter
      : { ...frontmatter, [statusProperty]: statusValue };

    return this.plugin.taskIdentityService.identify(file, identityFrontmatter, {
      statusProperty,
      completionStatuses: this.plugin.settings.parentCompletionStatuses?.length
        ? this.plugin.settings.parentCompletionStatuses
        : undefined,
    });
  }

  private getStatusPropertyKeyForFile(file: TFile, existingEntry?: any): string {
    const entry = existingEntry ?? this.delegates.createFileEntries([file])[0];
    const properties = resolveCustomProperties(this.plugin.settings.properties || [], entry ? [entry] : [], new ViewModeService());
    const statusProp = properties.find((property) => property.id === 'status' || property.key === 'status');
    return String(statusProp?.key || 'status').trim() || 'status';
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
    for (const candidate of Object.keys(frontmatter || {})) {
      if (candidate.toLowerCase() === normalized) {
        delete frontmatter[candidate];
      }
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
    if (node.hidden) {
      row.classList.add('tps-gcm-subitem-row--hidden');
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

    row.addEventListener('contextmenu', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      const menu = new Menu();
      if (isAttachmentOnly) {
        menu.addItem((item) => {
          item
            .setTitle('Remove attachment')
            .setIcon('unlink')
            .onClick(() => {
              void this.plugin.bulkEditService.unlinkAttachment(rootFile, node.file).then(onRefresh);
            });
        });
      } else {
        menu.addItem((item) => {
          item
            .setTitle('Unlink from parent')
            .setIcon('unlink')
            .onClick(() => {
              void this.plugin.bulkEditService.unlinkFromParent(node.file, rootFile).then(onRefresh);
            });
        });
        menu.addItem((item) => {
          item
            .setTitle('Unlink from all parents')
            .setIcon('unlink-2')
            .onClick(() => {
              void this.plugin.bulkEditService.unlinkFromAllParents(node.file).then((count) => {
                if (count > 0) {
                  new Notice(`Removed ${count} parent link${count === 1 ? '' : 's'} from ${node.file.basename}.`);
                }
                onRefresh();
              });
            });
        });
      }
      menu.showAtMouseEvent(evt);
    });

    const content = document.createElement('div');
    content.className = 'tps-gcm-subitem-content';

    const header = document.createElement('div');
    header.className = 'tps-gcm-subitem-header';

    const iconEl = document.createElement('span');
    iconEl.className = 'tps-gcm-subitem-icon';
    this.createSubitemIcon(iconEl, node.file, fm);
    header.appendChild(iconEl);

    const textWrap = document.createElement('div');
    textWrap.className = 'tps-gcm-subitem-text';

    const titleLine = document.createElement('div');
    titleLine.className = 'tps-gcm-subitem-title-line';

    const titleButton = document.createElement('button');
    titleButton.type = 'button';
    titleButton.className = 'tps-gcm-subitem-title';
    titleButton.textContent = this.getFileDisplayTitle(node.file);
    titleButton.title = node.file.path;
    addSafeClickListener(titleButton, () => this.openFileInPreferredLeaf(node.file));
    titleLine.appendChild(titleButton);

    const metaRow = document.createElement('div');
    metaRow.className = 'tps-gcm-subitem-meta';

    if (isAttachmentOnly) {
      const relationBadge = document.createElement('span');
      relationBadge.className = 'tps-gcm-subitem-relation tps-gcm-subitem-relation--attachment';
      relationBadge.textContent = 'attachment';
      metaRow.appendChild(relationBadge);
    } else {
      const strip = this.createContextStrip([entry]);
      if (strip.childElementCount > 0) {
        strip.classList.add('tps-gcm-subitem-strip');
        metaRow.appendChild(strip);
      }
    }

    if (metaRow.childElementCount === 0) {
      const pathEl = document.createElement('span');
      pathEl.className = 'tps-gcm-subitem-path';
      pathEl.textContent = node.file.parent?.path || rootFile.parent?.path || '';
      if (pathEl.textContent) {
        metaRow.appendChild(pathEl);
      }
    }

    textWrap.appendChild(titleLine);
    if (metaRow.childElementCount > 0) {
      textWrap.appendChild(metaRow);
    }

    header.appendChild(textWrap);
    content.appendChild(header);

    row.appendChild(content);

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
        const cacheTags = parseTagInput([...(getAllTags(cache) || []), frontmatter?.tags, frontmatter?.tag]);
        const visual = ruleEngine.resolveVisualOutputs(companion.settings.rules || [], {
          file: {
            path: file.path,
            name: file.name,
            basename: file.basename,
            extension: file.extension,
          },
          frontmatter,
          tags: Array.from(new Set(cacheTags.map((tag) => normalizeTagValue(tag)).filter(Boolean))),
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
    const normalizedTags = Array.from(new Set(
      parseTagInput([...(getAllTags(cache) || []), frontmatter?.tags, frontmatter?.tag])
        .map((tag) => normalizeTagValue(tag))
        .filter(Boolean)
    ));

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
   * - Remove `childOf` key from child's frontmatter
   * - Remove child from root's `parentOf` frontmatter list
   * - Add child to root's `attachments` frontmatter
   */
  private async changeRelationToAttachment(rootFile: TFile, childFile: TFile): Promise<void> {
    const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'childOf').trim() || 'childOf';
    const childKey = String(this.plugin.settings.childLinkFrontmatterKey || 'parentOf').trim() || 'parentOf';
    // Remove parent link from child
    await this.app.fileManager.processFrontMatter(childFile, (fm: Record<string, any>) => {
      const existingKey = Object.keys(fm).find((k) => k.toLowerCase() === parentKey.toLowerCase());
      if (existingKey) delete fm[existingKey];
    });
    // Remove child from parent's reverse list
    await this.app.fileManager.processFrontMatter(rootFile, (fm: Record<string, any>) => {
      const existingKey = Object.keys(fm).find((k) => k.toLowerCase() === childKey.toLowerCase());
      if (!existingKey) return;
      const raw = fm[existingKey];
      const existing = this.parseLinksFromFrontmatterValue(raw, rootFile.path);
      const filtered = existing.filter((f) => f.path !== childFile.path);
      if (filtered.length === 0) {
        delete fm[existingKey];
      } else {
        fm[existingKey] = filtered.map((f) => this.app.fileManager.generateMarkdownLink(f, rootFile.path));
      }
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
    folderPathSelection?: string,
    options?: {
      seedDefaults?: boolean;
      seedParentTags?: boolean;
      seedVisualMetadata?: boolean;
    }
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
    const seedDefaults = options?.seedDefaults ?? true;
    const seedParentTags = options?.seedParentTags ?? true;
    const seedVisualMetadata = options?.seedVisualMetadata ?? this.plugin.settings.seedNewSubitemVisualMetadata;
    const defaultStatus = seedDefaults
      ? String(this.plugin.settings.defaultNewSubitemStatus || '').trim().replace(/"/g, '\\"')
      : '';
    const defaultPriority = seedDefaults
      ? String(this.plugin.settings.defaultNewSubitemPriority || '').trim().replace(/"/g, '\\"')
      : '';
    const frontmatterLines = [
      '---',
      `title: "${escapedTitle}"`,
    ];
    if (defaultStatus) {
      frontmatterLines.push(`status: "${defaultStatus}"`);
    }
    if (defaultPriority) {
      frontmatterLines.push(`priority: "${defaultPriority}"`);
    }
    if (this.plugin.settings.autoSaveFolderPath) {
      frontmatterLines.push(`folderPath: "${(folderPath || '/').replace(/"/g, '\\"')}"`);
    }
    if (seedVisualMetadata) {
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
    const parentTags = seedParentTags ? parseTagInput([parentFrontmatter.tags, parentFrontmatter.tag]) : [];
    if (seedParentTags && parentTags.length > 0) {
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
    if (seedParentTags && parentTags.length > 0) {
      await this.mergeParentTagsIntoSubitem(created, parentTags);
    }

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

    // Brief pause to let the metadata cache index the newly-created file.
    // Templater folder-templates may also fire during this window; we merge
    // parent tags on top of whatever frontmatter exists after the pause.
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
