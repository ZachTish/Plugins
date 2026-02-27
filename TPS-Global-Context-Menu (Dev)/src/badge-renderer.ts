import { App, Menu, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import TPSGlobalContextMenuPlugin from './main';
import { addSafeClickListener } from './menu-controller';
import { FULL_DATE_REGEX, stripDateSuffix } from './date-suffix-utils';
import { resolveCustomProperties } from './resolve-profiles';
import { ViewModeService } from './view-mode-service';

/**
 * Generate a consistent hue (0-360) from a string using a simple hash.
 * This ensures the same tag always gets the same color.
 */
export function hashStringToHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash) % 360;
}

export class BadgeRenderer {
  private plugin: TPSGlobalContextMenuPlugin;
  private delegates: {
    createFileEntries: (files: TFile[]) => any[];
    getRecurrenceValue: (fm: any) => string;
    openAddTagModal: (entries: any[], key?: string) => void;
    openRecurrenceModalNative: (entries: any[]) => void;
    openScheduledModal: (entries: any[], key?: string) => void;
    openTypeSubmenu: (anchor: HTMLElement | MouseEvent | KeyboardEvent, entries: any[], onUpdate?: (val: string) => void) => void;
    showMenuAtAnchor: (menu: Menu, anchor: HTMLElement | MouseEvent | KeyboardEvent) => void;
    triggerTagSearch: (tag: string) => void;
  };

  constructor(
    plugin: TPSGlobalContextMenuPlugin,
    delegates: BadgeRenderer['delegates']
  ) {
    this.plugin = plugin;
    this.delegates = delegates;
  }

  private getValueCaseInsensitive(frontmatter: any, key: string): any {
    if (!frontmatter || !key) return undefined;
    if (key in frontmatter) return frontmatter[key];
    const lowerKey = key.toLowerCase();
    const match = Object.keys(frontmatter).find(k => k.toLowerCase() === lowerKey);
    return match ? frontmatter[match] : undefined;
  }

  private get app(): App {
    return this.plugin.app;
  }

  createSummaryHeader(file: TFile, leaf?: WorkspaceLeaf): HTMLElement {
    const entries = this.delegates.createFileEntries([file]);
    const fm = entries[0].frontmatter;

    const header = document.createElement('div');
    header.className = 'tps-global-context-header';

    // Left container with collapse button
    const left = document.createElement('div');
    left.className = 'tps-gcm-header-left';

    const collapseButton = document.createElement('button');
    collapseButton.type = 'button';
    collapseButton.className = 'tps-gcm-collapse-button';
    collapseButton.setAttribute('aria-expanded', 'false');
    collapseButton.setAttribute('aria-label', 'Expand inline menu controls');
    left.appendChild(collapseButton);

    const title = document.createElement('span');
    title.className = 'tps-gcm-file-title';

    let displayTitle = fm.title && fm.title !== file.basename
      ? `${fm.title} (${file.basename})`
      : (fm.title || file.basename || 'Untitled');

    if (!FULL_DATE_REGEX.test(displayTitle)) {
      displayTitle = stripDateSuffix(displayTitle);
    }

    title.textContent = displayTitle;
    title.setAttribute('aria-label', file.path);
    left.appendChild(title);

    header.appendChild(left);

    // Container for badges (right side)
    const right = this.createHeaderBadges(file, leaf);
    header.appendChild(right);

    return header;
  }

  /**
   * Create just the header badges container.
   * This is separated so we can update badges in-place without recreating the whole menu.
   */
  createHeaderBadges(file: TFile, leaf?: WorkspaceLeaf): HTMLElement {
    const entries = this.delegates.createFileEntries([file]);
    const fm = entries[0].frontmatter;

    const right = document.createElement('div');
    right.className = 'tps-gcm-header-right';

    // Helper to create badge
    const createBadge = (text: string, type: string, icon: string | null, onClick: (e: MouseEvent) => void) => {
      const badge = document.createElement('span');
      badge.className = `tps-gcm-badge tps-gcm-badge-${type}`;
      badge.textContent = text;
      addSafeClickListener(badge, onClick);
      return badge;
    };

    // Collect badges in two arrays: non-tags first, then tags
    const nonTagBadges: HTMLElement[] = [];
    const tagBadges: HTMLElement[] = [];

    // Dynamically create badges based on configured properties
    const properties = resolveCustomProperties(this.plugin.settings.properties || [], entries, new ViewModeService());
    properties.forEach(prop => {
      if (prop.showInCollapsed === false) return;
      if (prop.type === 'selector') {
        const rawValue = this.getValueCaseInsensitive(fm, prop.key);
        const value =
          rawValue === undefined || rawValue === null ? '' : String(rawValue).trim();
        if (value) {
          const badge = createBadge(value, `${prop.key} tps-gcm-badge-${value}`, null, (e) => {
            e.stopPropagation();
            const menu = new Menu();
            (prop.options || []).forEach((opt: string) => {
              menu.addItem((item: any) => {
                item.setTitle(opt)
                  .setChecked(this.getValueCaseInsensitive(fm, prop.key) === opt)
                  .onClick(async () => {
                    await this.plugin.bulkEditService.updateFrontmatter(entries.map((entry: any) => entry.file), { [prop.key]: opt });
                    (e.target as HTMLElement).textContent = opt;
                    (e.target as HTMLElement).className = `tps-gcm-badge tps-gcm-badge-${prop.key} tps-gcm-badge-${opt}`;
                  });
              });
            });
            this.delegates.showMenuAtAnchor(menu, e);
          });
          nonTagBadges.push(badge);
        }
      } else if (prop.type === 'list') {
        const listValues = this.getValueCaseInsensitive(fm, prop.key);

        if (listValues && listValues !== false && listValues !== null) {
          const rawItems = Array.isArray(listValues) ? listValues : [listValues];
          const items = rawItems.filter((v: any) => typeof v === 'string' && v.trim());
          items.slice(0, 4).forEach((item: string) => {
            const cleanItem = item.replace('#', '');
            const badge = document.createElement('span');
            badge.className = 'tps-gcm-badge tps-gcm-badge-tag';

            const removeBtn = document.createElement('button');
            removeBtn.className = 'tps-gcm-badge-tag-remove';
            removeBtn.type = 'button';
            removeBtn.textContent = '×';
            addSafeClickListener(removeBtn, async (e) => {
              e.stopPropagation();
              await this.plugin.bulkEditService.removeTag(entries.map((entry: any) => entry.file), cleanItem, prop.key);
              this.plugin.bulkEditService.showNotice('removed', `Tag #${cleanItem}`, '', entries.length);
              badge.remove();
            });
            badge.appendChild(removeBtn);

            const text = document.createElement('span');
            text.className = 'tps-gcm-badge-tag-text';
            text.textContent = cleanItem;
            badge.appendChild(text);

            addSafeClickListener(badge, (e) => {
              e.stopPropagation();
              this.delegates.triggerTagSearch(cleanItem);
            });

            // Consistent color based on tag hash
            const hue = hashStringToHue(cleanItem);
            badge.style.backgroundColor = `hsla(${hue}, 40%, 20%, 0.4)`;
            badge.style.color = `hsl(${hue}, 60%, 85%)`;
            badge.style.border = `1px solid hsla(${hue}, 40%, 30%, 0.5)`;

            tagBadges.push(badge);
          });
          if (items.length > 4) {
            tagBadges.push(createBadge(`+${items.length - 4}`, 'tag-more', null, (e) => {
              e.stopPropagation();
              this.delegates.openAddTagModal(entries, prop.key);
            }));
          }
        }

        // Add the "+" button AFTER the tags
        const addBadge = createBadge('+', 'add-tag', null, (e) => {
          e.stopPropagation();
          this.delegates.openAddTagModal(entries, prop.key);
        });
        tagBadges.push(addBadge);
      } else if (prop.type === 'recurrence') {
        const recurrence = this.delegates.getRecurrenceValue(fm);
        if (recurrence) {
          let label = 'Recur';
          if (recurrence.includes('FREQ=DAILY')) label = 'Daily';
          else if (recurrence.includes('FREQ=WEEKLY')) label = 'Weekly';
          else if (recurrence.includes('FREQ=MONTHLY')) label = 'Monthly';
          else if (recurrence.includes('FREQ=YEARLY')) label = 'Yearly';

          nonTagBadges.push(createBadge(label, 'recurrence', null, (e) => {
            e.stopPropagation();
            this.delegates.openRecurrenceModalNative(entries);
          }));
        }
      } else if (prop.type === 'datetime') {
        const dateValue = fm[prop.key];
        if (dateValue) {
          const dateStr = dateValue.split('T')[0];
          nonTagBadges.push(createBadge(dateStr, prop.key, null, (e) => {
            e.stopPropagation();
            this.delegates.openScheduledModal(entries, prop.key);
          }));
        }
      } else if (prop.type === 'folder') {
        const folderPath = file.parent?.path || '/';
        nonTagBadges.push(createBadge(folderPath, 'folder', null, (e) => {
          e.stopPropagation();
          this.delegates.openTypeSubmenu(e, entries);
        }));
      }
    });

    // Append non-tag badges first
    nonTagBadges.forEach(badge => right.appendChild(badge));

    // Append tag badges last
    tagBadges.forEach(badge => right.appendChild(badge));

    return right;
  }
}
