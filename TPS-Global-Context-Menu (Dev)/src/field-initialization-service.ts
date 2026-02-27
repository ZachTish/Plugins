import { Notice } from 'obsidian';
import TPSGlobalContextMenuPlugin from './main';

/**
 * Handles two-step field initialization for undefined frontmatter fields.
 * First click: initializes the field with a default value
 * Second click: opens the normal editor/modal
 */
export class FieldInitializationService {
  // Track which file+key combinations have been initialized this session
  private initializedFields = new Set<string>();

  constructor(private plugin: TPSGlobalContextMenuPlugin) { }

  private getFieldKey(file: any, propKey: string): string {
    return `${file.path}::${propKey}`;
  }

  private isFieldDefined(frontmatter: any, propKey: string): boolean {
    if (!frontmatter || typeof frontmatter !== 'object') return false;
    if (propKey in frontmatter && frontmatter[propKey] !== undefined) return true;
    const lowerKey = propKey.toLowerCase();
    return Object.keys(frontmatter).some(k => k.toLowerCase() === lowerKey && frontmatter[k] !== undefined);
  }

  /**
   * Check if field needs initialization and initialize if needed.
   * Returns true if initialization happened (caller should skip opening modal)
   * Returns false if field is already defined (caller should proceed normally)
   */
  async checkAndInitialize(entries: any[], propKey: string, defaultValue: any): Promise<boolean> {
    // Check if ALL entries have this field undefined
    const allUndefined = entries.every((e: any) => !this.isFieldDefined(e.frontmatter, propKey));

    if (!allUndefined) {
      // At least one file has the field defined, proceed normally
      return false;
    }

    // Check if we've already initialized this field for the first entry
    const fieldKey = this.getFieldKey(entries[0].file, propKey);
    if (this.initializedFields.has(fieldKey)) {
      // Already initialized, proceed to normal behavior
      return false;
    }

    // First interaction - initialize the field
    const fieldLabel = propKey.charAt(0).toUpperCase() + propKey.slice(1);
    new Notice(`Creating field "${fieldLabel}"...`);

    await this.plugin.bulkEditService.updateFrontmatter(
      entries.map((e: any) => e.file),
      { [propKey]: defaultValue }
    );

    // Mark as initialized for all entries
    entries.forEach((e: any) => {
      this.initializedFields.add(this.getFieldKey(e.file, propKey));
    });

    // Refresh menus to show the new field
    entries.forEach((e: any) => {
      this.plugin.persistentMenuManager?.refreshMenusForFile(e.file, true);
    });

    return true; // Signal that we initialized (caller should skip opening modal)
  }

  /**
   * Check if a field is defined (has a value in frontmatter)
   */
  isFieldDefinedForEntries(entries: any[], propKey: string): boolean {
    return !entries.every((e: any) => !this.isFieldDefined(e.frontmatter, propKey));
  }

  /**
   * Clear initialization tracking (useful for testing or session resets)
   */
  clearInitializationTracking() {
    this.initializedFields.clear();
  }
}
