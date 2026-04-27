/**
 * Shared subitem line model for unified rendering between reading mode and Live Preview.
 * This module provides a single computed model for subitem lines that both rendering
 * paths can use, ensuring consistent behavior and styling.
 */
import type { TFile } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import { resolveCustomProperties } from '../resolve-profiles';
import { ViewModeService } from './view-mode-service';
import { getFileDisplayTitle } from '../utils/file-display-title';
import { normalizeTagValue } from '../utils/tag-utils';

export type SubitemLineKind = 'bare' | 'bullet' | 'checkbox' | 'heading';

export type VisualState = 'open' | 'complete' | 'canceled' | 'working';

export interface PropertyPill {
  label: string;
  kind: 'status' | 'priority' | 'scheduled' | 'tag' | 'folder' | 'action' | 'recurrence' | 'selector';
  value?: string;
  propertyKey?: string;
  propertyType?: string;
  textColor?: string;
  backgroundColor?: string;
  borderColor?: string;
}

export interface SubitemLineModel {
  /** The child file referenced by this line */
  childFile: TFile;
  /** The parent file containing this line */
  parentFile: TFile;
  /** Line kind: bare wikilink, bullet with wikilink, or checkbox with wikilink */
  kind: SubitemLineKind;
  /** The checkbox state string (e.g., "[ ]", "[x]") if kind is checkbox */
  checkboxState: string | null;
  /** The raw wikilink markup */
  wikilink: string;
  /** The resolved link target path */
  linkTarget: string;
  /** Display label for the link */
  displayLabel: string;
  /** Visual state derived from status mapping */
  visualState: VisualState;
  /** Whether the child has an explicit status value in frontmatter */
  hasExplicitStatus: boolean;
  /** Property pills to render */
  pills: PropertyPill[];
  /** CSS class for the visual state */
  visualStateClass: string;
}

/**
 * Service for computing a unified subitem line model.
 * Both reading mode and Live Preview should use this to derive their rendering.
 */
export class SubitemLineModelService {
  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  /**
   * Build a line model from a parsed line and resolved files.
   */
  buildModel(
    parsed: {
      kind: SubitemLineKind;
      checkboxState: string | null;
      wikilink: string;
      linkTarget: string;
    },
    childFile: TFile,
    parentFile: TFile,
  ): SubitemLineModel {
    const status = this.getNormalizedStatus(childFile);
    const statusMappedCheckboxState = status ? this.mapStatusToCheckboxState(status) : '';
    const hasExplicitStatus = !!status;
    const checkboxState =
      hasExplicitStatus
        ? (statusMappedCheckboxState || parsed.checkboxState || this.plugin.settings.linkedSubitemDefaultOpenState || '[ ]')
        : (parsed.kind === 'checkbox' || parsed.kind === 'heading' ? (parsed.checkboxState || this.plugin.settings.linkedSubitemDefaultOpenState || '[ ]') : null);
    const visualState = this.getVisualState(checkboxState);
    const pills = this.getPropertyPills(childFile, parsed.kind);

    return {
      childFile,
      parentFile,
      kind: parsed.kind,
      checkboxState,
      wikilink: parsed.wikilink,
      linkTarget: parsed.linkTarget,
      displayLabel: this.getDisplayLabel(parsed.wikilink, childFile),
      visualState,
      hasExplicitStatus,
      pills,
      visualStateClass: this.getVisualStateClass(visualState),
    };
  }

  /**
   * Get the CSS class for a visual state.
   */
  getVisualStateClass(state: VisualState): string {
    return `is-${state}`;
  }

  /**
   * Map a checkbox state string to a visual state.
   */
  getVisualState(checkboxState: string | null | undefined): VisualState {
    if (!checkboxState) return 'open';
    if (/[xX]/.test(checkboxState)) return 'complete';
    if (checkboxState.includes('-')) return 'canceled';
    if (checkboxState.includes('/')) return 'working';
    return 'open';
  }

  /**
   * Map a status string to a checkbox state string.
   */
  mapStatusToCheckboxState(status: string): string {
    return this.plugin.itemSemanticsService.mapStatusToCheckboxState(status);
  }

  /**
   * Get the normalized status value from a file.
   */
  getNormalizedStatus(file: TFile): string {
    const fm = (this.plugin.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, unknown>;
    const statusKey = this.getStatusKey();
    const actualKey = Object.keys(fm).find((key) => key.toLowerCase() === statusKey.toLowerCase());
    return String(actualKey ? fm[actualKey] : '').trim().toLowerCase();
  }

  /**
   * Get the configured status key.
   */
  getStatusKey(): string {
    const configured = this.plugin.settings.properties?.find((prop) => prop.id === 'status')?.key;
    return String(configured || 'status').trim() || 'status';
  }

  /**
   * Get the configured status mappings.
   */
  getMappings(): Array<{ checkboxState: string; statuses: string[]; toggleTargetStatus?: string }> {
    return this.plugin.settings.linkedSubitemCheckboxMappings || [];
  }

  /**
   * Get the display label for a wikilink.
   */
  getDisplayLabel(wikilink: string, childFile: TFile): string {
    const title = getFileDisplayTitle(this.plugin.app, childFile);
    const aliasMatch = String(wikilink || '').match(/^\[\[[^\]|]+(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]$/);
    const alias = String(aliasMatch?.[1] || '').trim();
    if (alias && alias !== childFile.basename) return alias;
    return String(title || childFile.basename || childFile.name || '').trim() || childFile.basename;
  }

  /**
   * Get property pills for a subitem line.
   */
  getPropertyPills(file: TFile, lineKind?: string): PropertyPill[] {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
    const pills: PropertyPill[] = [];
    const showInlineProperties = this.plugin.settings.showCustomPropertiesInInlineUi !== false;
    if (!showInlineProperties) {
      console.debug('[TPS GCM] [DIAG] getPropertyPills skipped', {
        file: file.path,
        lineKind,
        reason: 'showCustomPropertiesInInlineUi-disabled',
      });
      return pills;
    }

    const entries = [{ file, frontmatter: fm }];
    const properties = resolveCustomProperties(this.plugin.settings.properties || [], entries, new ViewModeService());

    const visibleProperties = properties.filter((prop) => prop.hidden !== true && prop.showInCollapsed !== false);

    const statusProp = visibleProperties.find((prop) => prop.id === 'status' || prop.key === this.getStatusKey() || prop.key === 'status');
    if (statusProp?.type === 'selector') {
      const rawValue = this.readFrontmatterString(fm, statusProp.key);
      if (rawValue && lineKind !== 'checkbox') {
        pills.push({
          label: rawValue,
          kind: 'status',
          value: rawValue,
          propertyKey: statusProp.key,
          propertyType: statusProp.type,
        });
      }
    }

    const priorityProp = visibleProperties.find((prop) => prop.id === 'priority' || prop.key === 'priority');
    if (priorityProp?.type === 'selector') {
      const rawValue = this.readFrontmatterString(fm, priorityProp.key);
      if (rawValue) {
        pills.push({
          label: rawValue,
          kind: 'priority',
          value: rawValue,
          propertyKey: priorityProp.key,
          propertyType: priorityProp.type,
        });
      }
    }

    const dateProp = visibleProperties.find((prop) => prop.type === 'datetime' || prop.key === 'scheduled');
    if (dateProp?.type === 'datetime') {
      const rawValue = this.readFrontmatterString(fm, dateProp.key);
      if (rawValue) {
        pills.push({
          label: this.formatDateForDisplay(rawValue) || rawValue,
          kind: 'scheduled',
          value: rawValue,
          propertyKey: dateProp.key,
          propertyType: dateProp.type,
        });
      }
    }

    const tagsProp = visibleProperties.find((prop) => prop.id === 'tags' || prop.key === 'tags');
    if (tagsProp?.type === 'list') {
      pills.push({
        label: '+',
        kind: 'action',
        value: '+',
        propertyKey: tagsProp.key,
        propertyType: tagsProp.type,
      });
      for (const tag of this.readTags(fm)) {
        const tagStyle = this.resolveNotebookNavigatorTagStyle(tag);
        pills.push({
          label: `#${tag}`,
          kind: 'tag',
          value: tag,
          propertyKey: tagsProp.key,
          propertyType: tagsProp.type,
          ...tagStyle,
        });
      }
    }

    const folderProp = visibleProperties.find((prop) => prop.id === 'type' || prop.type === 'folder');
    if (folderProp?.type === 'folder') {
      pills.push({
        label: file.parent?.name || '/',
        kind: 'folder',
        value: file.parent?.path || '/',
        propertyKey: folderProp.key,
        propertyType: folderProp.type,
      });
    }

    console.debug('[TPS GCM] [DIAG] getPropertyPills result', {
      file: file.path,
      lineKind,
      frontmatterKeys: Object.keys(fm),
      pillCount: pills.length,
      pills: pills.map((pill) => ({ kind: pill.kind, label: pill.label, value: pill.value })),
    });

    return pills;
  }

  /**
   * Read a string value from frontmatter (case-insensitive key lookup).
   */
  private readFrontmatterString(frontmatter: Record<string, unknown>, key: string): string {
    const actualKey = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    const raw = actualKey ? frontmatter[actualKey] : undefined;
    if (typeof raw === 'string') return raw.trim();
    return '';
  }

  /**
   * Read tags from frontmatter.
   */
  private readTags(frontmatter: Record<string, unknown>): string[] {
    const tagsKey = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === 'tags');
    const raw = tagsKey ? frontmatter[tagsKey] : undefined;
    const values = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    const ignored = new Set(
      (this.plugin.settings.ignoredSubitemTags || [])
        .map((tag) => String(tag || '').trim().replace(/^#/, '').toLowerCase())
        .filter(Boolean),
    );
    return values
      .map((value) => String(value || '').trim().replace(/^#/, ''))
      .filter(Boolean)
      .filter((tag, index, all) => all.indexOf(tag) === index)
      .filter((tag) => !ignored.has(tag.toLowerCase()));
  }

  /**
   * Format a date for display.
   */
  private formatDateForDisplay(value: string): string {
    const menuController = this.plugin.menuController as any;
    if (typeof menuController?.formatDatetimeDisplay === 'function') {
      return String(menuController.formatDatetimeDisplay(value) || '').trim();
    }
    return value;
  }

  private resolveNotebookNavigatorTagStyle(tag: string): Pick<PropertyPill, 'textColor' | 'backgroundColor' | 'borderColor'> {
    const normalizedTag = normalizeTagValue(tag);
    if (!normalizedTag) return {};

    const fallbackBackground = 'var(--nn-theme-file-tag-bg, var(--background-secondary-alt))';
    const fallbackText = 'var(--nn-theme-file-tag-color, var(--text-normal))';

    const pluginApi: any = (this.plugin.app as any)?.plugins;
    const nnCandidates = Object.values(pluginApi?.plugins || {}) as any[];
    const nn: any =
      pluginApi?.plugins?.['notebook-navigator'] ??
      pluginApi?.getPlugin?.('notebook-navigator') ??
      nnCandidates.find((candidate) => String(candidate?.manifest?.id || '').trim() === 'notebook-navigator') ??
      nnCandidates.find((candidate) => String(candidate?.manifest?.name || '').trim().toLowerCase() === 'notebook navigator');
    const settings = nn?.settings ?? nn?.settingsController?.settings ?? nn?.api?.settings ?? null;

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

    if (customColor || customBackground) {
      return {
        textColor: customColor || 'var(--nn-theme-file-tag-custom-color-text-color, var(--text-normal))',
        backgroundColor: customBackground || fallbackBackground,
        borderColor: 'color-mix(in srgb, currentColor 30%, transparent)',
      };
    }

    const rainbowColor = this.resolveNotebookNavigatorRainbowTagColor(normalizedTag, settings);
    if (rainbowColor) {
      return {
        textColor: rainbowColor,
        backgroundColor: fallbackBackground,
        borderColor: 'color-mix(in srgb, currentColor 30%, transparent)',
      };
    }

    return {
      textColor: fallbackText,
      backgroundColor: fallbackBackground,
      borderColor: 'var(--nn-theme-file-pill-border-color, var(--background-modifier-border))',
    };
  }

  private resolveNotebookNavigatorRainbowTagColor(normalizedTag: string, settings: any): string {
    if (!normalizedTag) return '';
    if (settings && settings.inheritTagColors === false) return '';

    const activeProfileName = String(settings?.vaultProfile || '').trim();
    const profiles = Array.isArray(settings?.vaultProfiles) ? settings.vaultProfiles : [];
    const activeProfile = profiles.find((profile: any) => String(profile?.name || '').trim() === activeProfileName);
    const navRainbow = activeProfile?.navRainbow;
    const tagRainbow = navRainbow?.tags;

    const rainbowEnabled = tagRainbow ? tagRainbow.enabled !== false : true;
    if (!rainbowEnabled) return '';

    const firstColor = this.parseHexColor(String(tagRainbow?.firstColor || '#ef4444').trim());
    const lastColor = this.parseHexColor(String(tagRainbow?.lastColor || '#8b5cf6').trim());
    if (!firstColor || !lastColor) return '';

    const ratio = this.getNotebookNavigatorRainbowRatio(normalizedTag, settings);
    const transitionStyle = String(tagRainbow?.transitionStyle || 'hue').toLowerCase();
    const color = transitionStyle === 'rgb'
      ? this.interpolateRgb(firstColor, lastColor, ratio)
      : this.interpolateHue(firstColor, lastColor, ratio);
    return this.formatHexColor(color);
  }

  private getNotebookNavigatorRainbowRatio(normalizedTag: string, settings?: any): number {
    const metadataCacheAny = this.plugin.app.metadataCache as any;
    const tagMap = typeof metadataCacheAny?.getTags === 'function' ? metadataCacheAny.getTags() : {};
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

    const index = Math.max(0, entries.findIndex((entry) => entry.tag === normalizedTag));
    const denominator = Math.max(entries.length - 1, 1);
    return index / denominator;
  }

  private parseHexColor(value: string): [number, number, number] | null {
    const normalized = String(value || '').trim().replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
    return [
      parseInt(normalized.slice(0, 2), 16),
      parseInt(normalized.slice(2, 4), 16),
      parseInt(normalized.slice(4, 6), 16),
    ];
  }

  private interpolateRgb(first: [number, number, number], last: [number, number, number], ratio: number): [number, number, number] {
    return [
      Math.round(first[0] + (last[0] - first[0]) * ratio),
      Math.round(first[1] + (last[1] - first[1]) * ratio),
      Math.round(first[2] + (last[2] - first[2]) * ratio),
    ];
  }

  private interpolateHue(first: [number, number, number], last: [number, number, number], ratio: number): [number, number, number] {
    return this.interpolateRgb(first, last, ratio);
  }

  private formatHexColor(color: [number, number, number]): string {
    return `#${color.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  }

  private formatRecurrenceForDisplay(value: string): string {
    const normalized = String(value || '').toUpperCase();
    if (normalized.includes('FREQ=DAILY')) return 'Daily';
    if (normalized.includes('FREQ=WEEKLY')) return 'Weekly';
    if (normalized.includes('FREQ=MONTHLY')) return 'Monthly';
    if (normalized.includes('FREQ=YEARLY')) return 'Yearly';
    return 'Recur';
  }
}
