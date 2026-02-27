/**
 * Activity Tracker Service
 *
 * Tracks file changes and logs them in frontmatter under the "activity" key.
 * Uses minimal data storage for lightweight state recovery.
 *
 * Activity entries: { type, ts, [type-specific data] }
 * - type: 'archive' | 'folder' | 'content' | 'metadata' | 'custom'
 * - ts: Unix timestamp (seconds)
 * - Additional fields vary by type (e.g., 'folder' for archive)
 */

import { TFile, App } from 'obsidian';

export interface ActivityEntry {
  type: 'archive' | 'folder' | 'content' | 'metadata' | 'custom';
  ts: number;
  [key: string]: any;
}

export class ActivityTracker {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Create a new activity entry with timestamp
   */
  private createEntry(type: ActivityEntry['type'], data?: any): ActivityEntry {
    const entry: ActivityEntry = {
      type,
      ts: Math.floor(Date.now() / 1000),
      ...data
    };
    return entry;
  }

  /**
   * Log an activity entry in a file's frontmatter
   */
  async logActivity(file: TFile, entry: ActivityEntry): Promise<void> {
    if (file.extension?.toLowerCase() !== 'md') {
      return; // Only track markdown files
    }

    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter: any) => {
        if (!Array.isArray(frontmatter.activity)) {
          frontmatter.activity = [];
        }
        frontmatter.activity.push(entry);
      });
    } catch (err) {
      console.error('[Activity Tracker] Failed to log activity:', err);
    }
  }

  /**
   * Get all activity entries from a file
   */
  async getActivity(file: TFile): Promise<ActivityEntry[]> {
    try {
      const cache = this.app.metadataCache.getFileCache(file);
      const activity = cache?.frontmatter?.activity;
      return Array.isArray(activity) ? activity : [];
    } catch {
      return [];
    }
  }

  /**
   * Get the last activity entry of a specific type
   */
  async getLastActivity(file: TFile, type?: ActivityEntry['type']): Promise<ActivityEntry | null> {
    const activity = await this.getActivity(file);
    if (type) {
      for (let i = activity.length - 1; i >= 0; i--) {
        if (activity[i].type === type) {
          return activity[i];
        }
      }
      return null;
    }
    return activity.length > 0 ? activity[activity.length - 1] : null;
  }

  /**
   * Query activity entries by type
   */
  async queryActivity(
    file: TFile,
    filter?: { type?: ActivityEntry['type'] }
  ): Promise<ActivityEntry[]> {
    const activity = await this.getActivity(file);
    if (!filter || !filter.type) {
      return activity;
    }

    return activity.filter((entry) => entry.type === filter.type);
  }

  /**
   * Get the most recent folder location before archive
   * Useful for unarchive operations
   */
  async getOriginalFolder(file: TFile): Promise<string | null> {
    const activity = await this.queryActivity(file, { type: 'archive' });
    if (activity.length === 0) {
      return null;
    }

    // Look for the most recent archive entry with stored folder
    for (let i = activity.length - 1; i >= 0; i--) {
      const entry = activity[i];
      if (entry.folder !== undefined) {
        return entry.folder;
      }
    }

    return null;
  }
}
