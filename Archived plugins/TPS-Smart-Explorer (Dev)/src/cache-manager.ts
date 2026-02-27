/**
 * Smart Explorer Cache Manager
 * Centralized, optimized cache management for the explorer view
 */

import { TFile, TFolder, App } from "obsidian";

export interface CacheStats {
    frontmatter: number;
    filter: number;
    visual: number;
    folder: number;
    sort: number;
}

/**
 * Centralized cache manager with LRU-like eviction and smart invalidation
 */
export class CacheManager {
    private app: App;

    // File-level caches
    frontmatterCache: Map<string, any> = new Map();
    fileTagCache: Map<string, string[]> = new Map();

    // Filter caches  
    filterMatchesCache: Map<string, boolean> = new Map();
    filterMatchVersion: number = 0;

    // Visual caches
    visualMatchCache: Map<string, any> = new Map();
    visualMatchVersion: number = 0;

    // Folder caches
    folderCountCache: Map<string, number> = new Map();
    folderFilterMatchCache: Map<string, { version: number; result: boolean }> = new Map();

    // Sort caches
    sortValueCache: Map<string, any> = new Map();

    // Service caches
    serviceMatchCache: Map<string, boolean> = new Map();

    // Cache size limits (for memory management)
    private readonly MAX_CACHE_SIZE = 5000;

    constructor(app: App) {
        this.app = app;
    }

    /**
     * Get frontmatter for a file, with caching
     */
    getFrontmatter(file: TFile): any {
        const cached = this.frontmatterCache.get(file.path);
        if (cached !== undefined) {
            // Move to end of Map iteration order (true LRU behavior)
            this.frontmatterCache.delete(file.path);
            this.frontmatterCache.set(file.path, cached);
            return cached;
        }

        try {
            const fileCache = this.app.metadataCache.getFileCache(file);
            const frontmatter = fileCache?.frontmatter || null;

            // Only cache non-null values
            if (frontmatter !== null) {
                this.frontmatterCache.set(file.path, frontmatter);
                this.evictIfNeeded(this.frontmatterCache);
            }
            return frontmatter;
        } catch {
            return null;
        }
    }

    /**
     * Get frontmatter value for a specific field
     */
    getFrontmatterValue(file: TFile, field: string): any {
        const front = this.getFrontmatter(file);
        if (!front) return undefined;

        // Case-sensitive lookup first
        if (Object.prototype.hasOwnProperty.call(front, field)) {
            return front[field];
        }

        // Case-insensitive fallback
        const lower = field.toLowerCase();
        for (const [k, v] of Object.entries(front)) {
            if (String(k).toLowerCase() === lower) return v;
        }
        return undefined;
    }

    /**
     * Get tags for a file
     */
    getFileTags(file: TFile): string[] {
        const cached = this.fileTagCache.get(file.path);
        if (cached !== undefined) {
            // Move to end of Map iteration order (true LRU behavior)
            this.fileTagCache.delete(file.path);
            this.fileTagCache.set(file.path, cached);
            return cached;
        }

        try {
            const tags: string[] = [];
            const fileCache = this.app.metadataCache.getFileCache(file);

            // Inline tags
            if (fileCache?.tags) {
                tags.push(...fileCache.tags.map(t => t.tag.replace(/^#/, "")));
            }

            // Frontmatter tags
            const fm = fileCache?.frontmatter;
            if (fm?.tags) {
                if (Array.isArray(fm.tags)) {
                    tags.push(...fm.tags.map(String));
                } else {
                    const raw = String(fm.tags);
                    const parts = raw.split(/[\s,]+/).filter(Boolean);
                    tags.push(...(parts.length > 0 ? parts : [raw]));
                }
            }

            const normalized = tags
                .map(tag => String(tag).replace(/^#/, "").trim().toLowerCase())
                .filter(Boolean);
            const unique = Array.from(new Set(normalized));

            this.fileTagCache.set(file.path, unique);
            this.evictIfNeeded(this.fileTagCache);
            return unique;
        } catch {
            return [];
        }
    }

    /**
     * Invalidate caches for a specific file
     */
    invalidateFile(filePath: string): void {
        this.frontmatterCache.delete(filePath);
        this.fileTagCache.delete(filePath);
    }

    /**
     * Invalidate filter caches for a specific file only.
     * Much cheaper than clearing everything.
     */
    invalidateFileFilterCaches(filePath: string): void {
        this.frontmatterCache.delete(filePath);
        this.fileTagCache.delete(filePath);
        // Invalidate filter matches that include this file path
        for (const key of this.filterMatchesCache.keys()) {
            if (key.startsWith(filePath + "::")) {
                this.filterMatchesCache.delete(key);
            }
        }
        for (const key of this.visualMatchCache.keys()) {
            if (key.startsWith(filePath + "::")) {
                this.visualMatchCache.delete(key);
            }
        }
        for (const key of this.serviceMatchCache.keys()) {
            if (key.startsWith(filePath + "::")) {
                this.serviceMatchCache.delete(key);
            }
        }
        for (const key of this.sortValueCache.keys()) {
            if (key.startsWith(filePath + "::")) {
                this.sortValueCache.delete(key);
            }
        }
        // Bump versions so folder caches re-evaluate
        this.filterMatchVersion++;
        this.visualMatchVersion++;
        // Folder caches depend on file contents so clear them
        this.folderCountCache.clear();
        this.folderFilterMatchCache.clear();
    }

    /**
     * Invalidate all filter-related caches (full reset)
     */
    invalidateFilterCaches(): void {
        this.filterMatchVersion++;
        this.filterMatchesCache.clear();
        this.visualMatchVersion++;
        this.visualMatchCache.clear();
        this.serviceMatchCache.clear();
        this.frontmatterCache.clear();
        this.fileTagCache.clear();
        this.folderCountCache.clear();
        this.folderFilterMatchCache.clear();
        this.sortValueCache.clear();
    }

    /**
     * Clear visual caches only (for render, preserve expensive filter caches)
     */
    clearVisualCaches(): void {
        this.visualMatchCache.clear();
        this.serviceMatchCache.clear();
        this.sortValueCache.clear();
    }

    /**
     * Clear all caches
     */
    clearAll(): void {
        this.frontmatterCache.clear();
        this.fileTagCache.clear();
        this.filterMatchesCache.clear();
        this.visualMatchCache.clear();
        this.folderCountCache.clear();
        this.folderFilterMatchCache.clear();
        this.sortValueCache.clear();
        this.serviceMatchCache.clear();
    }

    /**
     * Get cache statistics for debugging
     */
    getStats(): CacheStats {
        return {
            frontmatter: this.frontmatterCache.size,
            filter: this.filterMatchesCache.size,
            visual: this.visualMatchCache.size,
            folder: this.folderCountCache.size + this.folderFilterMatchCache.size,
            sort: this.sortValueCache.size
        };
    }

    /**
     * LRU eviction when cache gets too large.
     * Cache hits re-insert keys at the end of Map iteration order,
     * so the first 20% of keys are the least-recently-used.
     */
    private evictIfNeeded(cache: Map<any, any>): void {
        if (cache.size > this.MAX_CACHE_SIZE) {
            // Remove oldest 20% of entries
            const removeCount = Math.floor(cache.size * 0.2);
            const keys = Array.from(cache.keys()).slice(0, removeCount);
            keys.forEach(k => cache.delete(k));
        }
    }
}
