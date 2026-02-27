import { App, Menu, TFile, TFolder, Notice, Platform, WorkspaceLeaf } from 'obsidian';
import TPSGlobalContextMenuPlugin from './main';
import { AddTagModal } from './add-tag-modal';
import { RecurrenceModal } from './recurrence-modal';
import { ScheduledModal } from './scheduled-modal';
import { SnoozeModal } from './snooze-modal';
import { BuildPanelOptions } from './types';
import { STATUSES, PRIORITIES } from './constants';
import * as logger from "./logger";
import { PropertyRowService } from './property-row-service';
import { normalizeTagValue, parseTagInput } from './tag-utils';
import { BadgeRenderer, hashStringToHue } from './badge-renderer';
import { PanelBuilder } from './panel-builder';
import { MenuBuilder } from './menu-builder';
import { getInternalPlugin } from './core';

export function addSafeClickListener(element: HTMLElement, handler: (e: MouseEvent) => void) {
  element.addEventListener('click', (e) => {
    e.stopPropagation();
    handler(e as MouseEvent);
  });
  element.addEventListener('mousedown', (e) => e.stopPropagation());
}

/**
 * Thin facade coordinating MenuBuilder (native menus), PanelBuilder (custom panels),
 * and BadgeRenderer (header badges). Owns shared utilities like modal openers,
 * menu positioning, tag search, and folder resolution.
 */
export class MenuController {
  plugin: TPSGlobalContextMenuPlugin;
  private propertyRowService: PropertyRowService;
  private badgeRenderer: BadgeRenderer;
  private panelBuilder: PanelBuilder;
  private menuBuilder: MenuBuilder;

  constructor(plugin: TPSGlobalContextMenuPlugin) {
    this.plugin = plugin;
    this.propertyRowService = new PropertyRowService(this.app, this.plugin, {
      addSafeClickListener,
      showMenuAtAnchor: this.showMenuAtAnchor.bind(this),
      openAddTagModal: this.openAddTagModal.bind(this),
      openScheduledModal: this.openScheduledModal.bind(this),
      openRecurrenceModalNative: this.openRecurrenceModalNative.bind(this),
      moveFiles: this.moveFiles.bind(this),
      getTypeFolderOptions: this.getTypeFolderOptions.bind(this),
      getRecurrenceValue: this.getRecurrenceValue.bind(this),
      formatDatetimeDisplay: this.formatDatetimeDisplay.bind(this),
      hashStringToHue,
    });

    this.badgeRenderer = new BadgeRenderer(this.plugin, {
      createFileEntries: this.createFileEntries.bind(this),
      getRecurrenceValue: this.getRecurrenceValue.bind(this),
      openAddTagModal: this.openAddTagModal.bind(this),
      openRecurrenceModalNative: this.openRecurrenceModalNative.bind(this),
      openScheduledModal: this.openScheduledModal.bind(this),
      openTypeSubmenu: this.openTypeSubmenu.bind(this),
      showMenuAtAnchor: this.showMenuAtAnchor.bind(this),
      triggerTagSearch: this.triggerTagSearch.bind(this),
    });

    this.panelBuilder = new PanelBuilder(this.plugin, this.propertyRowService, {
      createFileEntries: this.createFileEntries.bind(this),
      openAddTagModal: this.openAddTagModal.bind(this),
      openScheduledModal: this.openScheduledModal.bind(this),
      openRecurrenceModalNative: this.openRecurrenceModalNative.bind(this),
      formatDatetimeDisplay: this.formatDatetimeDisplay.bind(this),
    });

    this.menuBuilder = new MenuBuilder(this.plugin, {
      createFileEntries: this.createFileEntries.bind(this),
      openAddTagModal: this.openAddTagModal.bind(this),
      openScheduledModal: this.openScheduledModal.bind(this),
      openRecurrenceModalNative: this.openRecurrenceModalNative.bind(this),
      openSnoozeModal: this.openSnoozeModal.bind(this),
      getRecurrenceValue: this.getRecurrenceValue.bind(this),
      moveFiles: this.moveFiles.bind(this),
      getTypeFolderOptions: this.getTypeFolderOptions.bind(this),
    });
  }

  detach() {
    // No-op
  }

  hideMenu() {
    // No-op
  }

  // --- Delegated public API ---

  addToNativeMenu(menu: Menu, files: TFile[]) {
    if (this.plugin.settings.inlineMenuOnly) return;
    this.menuBuilder.addToNativeMenu(menu, files);
  }

  buildSpecialPanel(files: TFile[], options: BuildPanelOptions = {}): HTMLElement {
    return this.panelBuilder.buildSpecialPanel(files, options);
  }

  createSubitemsPanel(file: TFile): HTMLElement {
    return this.panelBuilder.createSubitemsPanel(file);
  }

  createSummaryHeader(file: TFile, leaf?: WorkspaceLeaf): HTMLElement {
    return this.badgeRenderer.createSummaryHeader(file, leaf);
  }

  createHeaderBadges(file: TFile, leaf?: WorkspaceLeaf): HTMLElement {
    return this.badgeRenderer.createHeaderBadges(file, leaf);
  }

  // --- Shared utilities (used by delegates) ---

  createFileEntries(files: TFile[]) {
    return files.map(f => ({
      file: f,
      frontmatter: this.app.metadataCache.getFileCache(f)?.frontmatter || {}
    }));
  }

  getRecurrenceValue(fm: any): string {
    return fm.recurrenceRule || fm.recurrence || '';
  }

  private getTypeFolderOptions(): { path: string; label: string }[] {
    const allFiles = this.app.vault.getAllLoadedFiles();
    const folders = allFiles.filter(f => f instanceof TFolder) as TFolder[];
    const files = allFiles.filter(f => f instanceof TFile) as TFile[];

    const normalizedPaths = folders
      .map(f => f.path)
      .filter(p => p && p !== '/')
      .map(p => p.replace(/\/+$/, ''));
    const folderSet = new Set(normalizedPaths);

    const leafPaths = normalizedPaths
      .filter(path => !normalizedPaths.some(other => other !== path && other.startsWith(path + '/')));

    const directFileCounts = new Map<string, number>();
    for (const file of files) {
      const parentPath = file.parent?.path;
      if (!parentPath || parentPath === '/') continue;
      if (!folderSet.has(parentPath)) continue;
      directFileCounts.set(parentPath, (directFileCounts.get(parentPath) || 0) + 1);
    }

    const includedSet = new Set<string>(leafPaths);
    for (const [path, count] of directFileCounts.entries()) {
      if (count > 0) includedSet.add(path);
    }

    const includedPaths = Array.from(includedSet).sort((a, b) => a.localeCompare(b));

    const findNearestIncludedAncestor = (path: string): string | null => {
      let current = path;
      while (current.includes('/')) {
        current = current.substring(0, current.lastIndexOf('/'));
        if (includedSet.has(current)) return current;
      }
      return null;
    };

    return includedPaths.map(path => {
      const ancestor = findNearestIncludedAncestor(path);
      if (!ancestor) {
        return { path, label: path.split('/').pop() || path };
      }
      const ancestorLabel = ancestor.split('/').pop() || ancestor;
      const suffix = path.slice(ancestor.length + 1);
      return { path, label: `${ancestorLabel}/${suffix}` };
    });
  }

  async moveFiles(entries: any[], folderPath: string) {
    const files = entries
      .map((entry: any) => entry?.file)
      .filter((file: unknown): file is TFile => file instanceof TFile);

    await this.plugin.runQueuedMove(files, async () => {
      for (const entry of entries) {
        const newPath = `${folderPath === '/' ? '' : folderPath}/${entry.file.name}`;
        if (newPath !== entry.file.path) {
          try {
            await this.app.fileManager.renameFile(entry.file, newPath);
          } catch (e: any) {
            logger.error(`Failed to move file to ${newPath}`, e);
            new Notice(`Failed to move file: ${e?.message ?? 'Unknown error'}`);
          }
        }
      }
    });
  }

  // --- Submenu openers (used by PropertyRowService and BadgeRenderer) ---

  openStatusSubmenu(anchor: HTMLElement | MouseEvent | KeyboardEvent, entries: any[], onUpdate?: (val: string) => void) {
    const menu = new Menu();
    const currentStatus = typeof entries[0]?.frontmatter?.status === 'string'
      ? String(entries[0].frontmatter.status).trim()
      : '';
    STATUSES.forEach(status => {
      menu.addItem(item => {
        item.setTitle(status)
          .setChecked(currentStatus === status)
          .onClick(async () => {
            entries.forEach((entry: any) => {
              if (!entry.frontmatter || typeof entry.frontmatter !== 'object') entry.frontmatter = {};
              entry.frontmatter.status = status;
            });
            if (onUpdate) onUpdate(status);
            await this.plugin.bulkEditService.setStatus(entries.map(e => e.file), status);
            // Apply companion rules to update icon
            for (const entry of entries) {
              await this.applyCompanionRulesToFile(entry.file);
            }
            // Refresh menus immediately
            entries.forEach((e: any) => {
              if (e.file instanceof TFile) {
                this.plugin.persistentMenuManager?.refreshMenusForFile(e.file, true);
              }
            });
          });
      });
    });
    this.showMenuAtAnchor(menu, anchor);
  }

  openPrioritySubmenu(anchor: HTMLElement | MouseEvent | KeyboardEvent, entries: any[], onUpdate?: (val: string) => void) {
    const menu = new Menu();
    const currentPriority = typeof entries[0]?.frontmatter?.priority === 'string'
      ? String(entries[0].frontmatter.priority).trim()
      : '';
    PRIORITIES.forEach(prio => {
      menu.addItem(item => {
        item.setTitle(prio)
          .setChecked(currentPriority === prio)
          .onClick(async () => {
            entries.forEach((entry: any) => {
              if (!entry.frontmatter || typeof entry.frontmatter !== 'object') entry.frontmatter = {};
              entry.frontmatter.priority = prio;
            });
            if (onUpdate) onUpdate(prio);
            await this.plugin.bulkEditService.setPriority(entries.map(e => e.file), prio);
            // Refresh menus immediately
            entries.forEach((e: any) => {
              if (e.file instanceof TFile) {
                this.plugin.persistentMenuManager?.refreshMenusForFile(e.file, true);
              }
            });
          });
      });
    });
    this.showMenuAtAnchor(menu, anchor);
  }

  openTypeSubmenu(anchor: HTMLElement | MouseEvent | KeyboardEvent, entries: any[], onUpdate?: (val: string) => void) {
    const menu = new Menu();
    const options = this.getTypeFolderOptions();
    const currentPath = entries[0]?.file?.parent?.path || '/';
    options.forEach(({ path, label }) => {
      menu.addItem(item => {
        item.setTitle(label)
          .setChecked(currentPath === path)
          .onClick(async () => {
            if (onUpdate) onUpdate(path);
            await this.moveFiles(entries, path);
          });
      });
    });
    this.showMenuAtAnchor(menu, anchor);
  }

  private activeMenu: Menu | null = null;

  showMenuAtAnchor(menu: Menu, anchor: HTMLElement | MouseEvent | KeyboardEvent) {
    // Ensure primitive menu stacking (close previous if exists)
    if (this.activeMenu) {
      this.activeMenu.hide();
    }
    this.activeMenu = menu;
    menu.onHide(() => {
      if (this.activeMenu === menu) {
        this.activeMenu = null;
      }
    });

    if (anchor instanceof MouseEvent) {
      // @ts-ignore
      menu.showAtMouseEvent(anchor);
      return;
    }

    let element: HTMLElement | null = null;
    if (anchor instanceof HTMLElement) {
      element = anchor;
    } else if (anchor instanceof Event && anchor.target instanceof HTMLElement) {
      element = anchor.target as HTMLElement;
    }

    if (element) {
      // Try native positioning first (best for collision detection)
      // @ts-ignore
      if (typeof menu.showAtElement === 'function') {
        // @ts-ignore
        menu.showAtElement(element);
        return;
      }

      // Fallback manual positioning
      if (element.getBoundingClientRect) {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const viewportW = Math.max(0, window.innerWidth || document.documentElement.clientWidth || 0);
          const viewportH = Math.max(0, window.innerHeight || document.documentElement.clientHeight || 0);

          // Reduced estimates to avoid aggressive vertical shifting
          const estimatedWidth = Platform.isMobile ? Math.min(340, Math.floor(viewportW * 0.9)) : 200;
          // Estimate smaller height (e.g. 5 items = ~180px) instead of 360
          const estimatedHeight = Platform.isMobile ? Math.min(420, Math.floor(viewportH * 0.7)) : 200;
          const margin = Platform.isMobile ? 10 : 8;

          let x = rect.left;
          let y = rect.bottom + 4;

          // Clamp logic
          x = Math.max(margin, Math.min(x, viewportW - estimatedWidth - margin));

          // If the menu would fall off the bottom, flip it to top
          if (y + estimatedHeight > viewportH - margin) {
            y = rect.top - 4;
            // Note: showAtPosition anchors top-left. 
            // If we want it to extend UPWARDS from 'y', we assume Obsidian handles it?
            // No, Obsidian Menu always extends DOWN from x,y.
            // So if we want it above, we specifically position 'y' so the MENU TOP is at 'y'.
            // Wait, if we want bottom of menu at rect.top..
            // y = rect.top - actualHeight. But we don't know height.
            // This is why showAtElement is crucial.

            // Best effort: set y such that it is on screen, but clearly separate.
            // If we set y = rect.top - estimatedHeight?
            y = Math.max(margin, rect.top - estimatedHeight);
          }

          menu.showAtPosition({ x, y });
          return;
        }
      }
    }

    // Fallback
    // @ts-ignore
    if (this.app.workspace.activeLeaf) {
      // @ts-ignore
      const mouse = this.app.workspace.activeLeaf.view.contentEl.getBoundingClientRect();
      menu.showAtPosition({ x: mouse.left + 100, y: mouse.top + 100 });
    } else {
      menu.showAtPosition({ x: 0, y: 0 });
    }
  }

  // --- Modal openers ---

  openAddTagModal(entries: any[], key = 'tags') {
    logger.log(`[TPS GCM] openAddTagModal called with ${entries.length} entries`);
    new AddTagModal(this.app, this.getAllKnownTags(), async (tag) => {
      const files = entries.map(e => e.file);
      logger.log(`[TPS GCM] Adding tag '${tag}' to ${files.length} files`);
      const count = await this.plugin.bulkEditService.addTag(files, tag, key);
      if (count > 0) {
        const normalized = parseTagInput(tag);
        const display = normalized.length ? normalized.map((value) => `#${value}`).join(' ') : `#${tag}`;
        this.plugin.bulkEditService.showNotice('added', `Tag ${display}`, '', count);
        // Refresh menus immediately to show newly added tags
        files.forEach(file => {
          this.plugin.persistentMenuManager?.refreshMenusForFile(file, true);
        });
      }
    }).open();
  }

  openRecurrenceModalNative(entries: any[]) {
    const fm = entries[0].frontmatter;
    const dateStr = fm.scheduled || fm.start || fm.date || fm.day;
    let startDate = new Date();

    if (dateStr) {
      const parsed = window.moment(dateStr, ["YYYY-MM-DD HH:mm", "YYYY-MM-DD"]).toDate();
      if (!isNaN(parsed.getTime())) {
        startDate = parsed;
      }
    }

    new RecurrenceModal(this.app, this.getRecurrenceValue(fm), startDate, async (rule) => {
      const files = entries.map(e => e.file);
      await this.plugin.bulkEditService.setRecurrence(files, rule);
      // Refresh menus immediately to show updated recurrence
      files.forEach(file => {
        this.plugin.persistentMenuManager?.refreshMenusForFile(file, true);
      });
    }).open();
  }

  openScheduledModal(entries: any[], key = 'scheduled') {
    const fm = entries[0].frontmatter;
    new ScheduledModal(
      this.app,
      fm[key] || '',
      fm.timeEstimate || 0,
      fm.allDay || false,
      async (result) => {
        const files = entries.map(e => e.file);
        await this.plugin.bulkEditService.updateScheduledDetails(
          files,
          result.date,
          result.timeEstimate,
          result.allDay,
          key
        );
        // Refresh menus immediately to show updated scheduled date
        files.forEach(file => {
          this.plugin.persistentMenuManager?.refreshMenusForFile(file, true);
        });
      }
    ).open();
  }

  openSnoozeModal(entries: any[], key = 'snooze') {
    const notifier: any = (this.app as any)?.plugins?.plugins?.['tps-notifier'];
    const notifierSettings = notifier?.settings || {};
    const options = Array.isArray(notifierSettings.snoozeOptions) ? notifierSettings.snoozeOptions : [];
    const resolvedKey = typeof notifierSettings.snoozeProperty === 'string' && notifierSettings.snoozeProperty.trim()
      ? notifierSettings.snoozeProperty.trim()
      : (key || 'reminderSnooze');
    new SnoozeModal(
      this.app,
      entries.map(e => e.file),
      options,
      async (minutes) => {
        const files = entries.map(e => e.file);
        const snoozeDate = window.moment().add(minutes, 'minutes').format('YYYY-MM-DD HH:mm');
        await this.plugin.bulkEditService.updateFrontmatter(files, { [resolvedKey]: snoozeDate });
        new Notice(`Snoozed for ${minutes} minutes`);
        // Refresh menus immediately to show updated snooze date
        files.forEach(file => {
          this.plugin.persistentMenuManager?.refreshMenusForFile(file, true);
        });
      }
    ).open();
  }

  // --- Tag utilities ---

  getAllKnownTags(): string[] {
    // @ts-ignore
    const cache = this.app.metadataCache;
    // @ts-ignore
    const tags = typeof cache.getTags === 'function' ? cache.getTags() : {};
    return Array.from(new Set(Object.keys(tags || {}).map(t => normalizeTagValue(t)).filter(Boolean)));
  }

  triggerTagSearch(tag: string): void {
    const cleanTag = normalizeTagValue(tag);
    const fallbackToSearch = () => this.openTagSearch(cleanTag);

    try {
      const pluginManager = (this.app as any)?.plugins;
      const notebookNavigator =
        pluginManager?.getPlugin?.('notebook-navigator') ??
        pluginManager?.plugins?.['notebook-navigator'];
      const notebookNavigatorNavigateToTag = notebookNavigator?.api?.navigation?.navigateToTag;

      if (typeof notebookNavigatorNavigateToTag === 'function') {
        Promise.resolve(notebookNavigatorNavigateToTag.call(notebookNavigator.api.navigation, cleanTag))
          .catch((error: unknown) => {
            logger.error('[TPS GCM] Notebook Navigator tag navigation failed; falling back to global search:', error);
            fallbackToSearch();
          });
        return;
      }
      fallbackToSearch();
    } catch (error) {
      logger.error('[TPS GCM] Failed to navigate tag from context menu:', error);
      fallbackToSearch();
    }
  }

  private openTagSearch(cleanTag: string): void {
    const searchQuery = `tag:#${cleanTag}`;
    try {
      const globalSearch = getInternalPlugin<any>(this.app, 'global-search');
      if (globalSearch && globalSearch.instance) {
        globalSearch.instance.openGlobalSearch(searchQuery);
        return;
      }

      const leaf = this.app.workspace.getLeaf(false);
      if (!leaf) return;
      leaf.setViewState({
        type: 'search',
        state: { query: searchQuery }
      });
    } catch (error) {
      logger.error('[TPS GCM] Failed to trigger tag search:', error);
      new Notice('Failed to search for tag');
    }
  }

  formatDatetimeDisplay(value: string | null | undefined): string {
    if (!value) return '';
    const momentLib = (window as any).moment;
    if (momentLib) {
      const parsed = momentLib(value);
      if (parsed.isValid()) {
        if (value.length <= 10 || parsed.format('HH:mm:ss') === '00:00:00') {
          return parsed.format('ddd, MMM D, YYYY');
        }
        return parsed.format('ddd, MMM D, YYYY [at] h:mm A');
      }
    }
    const parsedDate = new Date(value);
    if (!isNaN(parsedDate.getTime())) {
      return parsedDate.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    }
    return value;
  }

  private async applyCompanionRulesToFile(file: TFile): Promise<void> {
    const pluginsApi: any = (this.app as any)?.plugins;
    const companion: any = pluginsApi?.plugins?.['tps-notebook-navigator-companion'];
    if (!companion?.settings?.enabled) return;

    const applyRulesToFile = companion.applyRulesToFile;
    if (typeof applyRulesToFile !== 'function') return;

    try {
      await applyRulesToFile.call(companion, file, { reason: 'gcm-status-update', force: true });
    } catch (error) {
      logger.warn('[TPS GCM] Failed applying companion rules after status update:', file.path, error);
    }
  }

  get app() {
    return this.plugin.app;
  }
}
