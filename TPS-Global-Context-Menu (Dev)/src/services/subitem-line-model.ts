/**
 * Shared subitem line model for unified rendering between reading mode and Live Preview.
 * This module provides a single computed model for subitem lines that both rendering
 * paths can use, ensuring consistent behavior and styling.
 */
import type { TFile } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import { resolveCustomProperties } from '../resolve-profiles';
import { ViewModeService } from './view-mode-service';

export type SubitemLineKind = 'bare' | 'bullet' | 'checkbox';

export type VisualState = 'open' | 'complete' | 'canceled';

export interface PropertyPill {
  label: string;
  kind: 'status' | 'priority' | 'scheduled' | 'tag' | 'folder' | 'action' | 'recurrence' | 'selector';
  value?: string;
  propertyKey?: string;
  propertyType?: string;
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
    const checkboxState = parsed.checkboxState || this.mapStatusToCheckboxState(status);
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
  getVisualState(checkboxState: string): VisualState {
    if (/[xX]/.test(checkboxState)) return 'complete';
    if (checkboxState.includes('-')) return 'canceled';
    return 'open';
  }

  /**
   * Map a status string to a checkbox state string.
   */
  mapStatusToCheckboxState(status: string): string {
    const normalized = String(status || '').trim().toLowerCase();
    for (const mapping of this.getMappings()) {
      if (mapping.statuses.some((value) => String(value || '').trim().toLowerCase() === normalized)) {
        return mapping.checkboxState;
      }
    }
    return this.plugin.settings.linkedSubitemDefaultOpenState || '[ ]';
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
    const aliasMatch = String(wikilink || '').match(/^\[\[[^\]|]+(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]$/);
    const alias = String(aliasMatch?.[1] || '').trim();
    if (alias) return alias;

    const title = this.readFrontmatterString(
      (this.plugin.app.metadataCache.getFileCache(childFile)?.frontmatter || {}) as Record<string, unknown>,
      'title',
    );
    return title || childFile.basename;
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

    for (const prop of properties) {
      if (prop.hidden === true || prop.showInCollapsed === false) continue;

      if (prop.type === 'selector') {
        const rawValue = this.readFrontmatterString(fm, prop.key);
        if (!rawValue) continue;
        if ((prop.id === 'status' || prop.key === this.getStatusKey() || prop.key === 'status') && lineKind === 'checkbox') {
          continue;
        }
        const kind: PropertyPill['kind'] =
          prop.id === 'status' || prop.key === this.getStatusKey() || prop.key === 'status'
            ? 'status'
            : prop.id === 'priority' || prop.key === 'priority'
              ? 'priority'
              : 'selector';
        pills.push({
          label: rawValue,
          kind,
          value: rawValue,
          propertyKey: prop.key,
          propertyType: prop.type,
        });
        continue;
      }

      if (prop.type === 'datetime') {
        const rawValue = this.readFrontmatterString(fm, prop.key);
        if (!rawValue) continue;
        const formatted = this.formatDateForDisplay(rawValue) || rawValue;
        pills.push({
          label: formatted,
          kind: 'scheduled',
          value: rawValue,
          propertyKey: prop.key,
          propertyType: prop.type,
        });
        continue;
      }

      if (prop.type === 'recurrence') {
        const recurrence = this.readFrontmatterString(fm, prop.key)
          || this.readFrontmatterString(fm, 'recurrenceRule')
          || this.readFrontmatterString(fm, 'recurrence');
        if (!recurrence) continue;
        pills.push({
          label: this.formatRecurrenceForDisplay(recurrence),
          kind: 'recurrence',
          value: recurrence,
          propertyKey: prop.key,
          propertyType: prop.type,
        });
        continue;
      }

      if (prop.type === 'folder') {
        pills.push({
          label: file.parent?.name || '/',
          kind: 'folder',
          value: file.parent?.path || '/',
          propertyKey: prop.key,
          propertyType: prop.type,
        });
        continue;
      }

      if (prop.type === 'list' && prop.key.toLowerCase() === 'tags') {
        for (const tag of this.readTags(fm)) {
          pills.push({
            label: `#${tag}`,
            kind: 'tag',
            value: tag,
            propertyKey: prop.key,
            propertyType: prop.type,
          });
        }
        pills.push({
          label: '+',
          kind: 'action',
          value: '+',
          propertyKey: prop.key,
          propertyType: prop.type,
        });
      }
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

  private formatRecurrenceForDisplay(value: string): string {
    const normalized = String(value || '').toUpperCase();
    if (normalized.includes('FREQ=DAILY')) return 'Daily';
    if (normalized.includes('FREQ=WEEKLY')) return 'Weekly';
    if (normalized.includes('FREQ=MONTHLY')) return 'Monthly';
    if (normalized.includes('FREQ=YEARLY')) return 'Yearly';
    return 'Recur';
  }
}
