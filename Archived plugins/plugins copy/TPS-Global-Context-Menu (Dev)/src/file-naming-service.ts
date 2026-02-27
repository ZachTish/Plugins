import { normalizePath, TFile } from 'obsidian';
import TPSGlobalContextMenuPlugin from './main';
import * as logger from "./logger";
import { extractDateSuffix, stripDateSuffix } from './date-suffix-utils';

/**
 * Handles automatic file naming based on title and scheduled date
 */
export class FileNamingService {
    plugin: TPSGlobalContextMenuPlugin;
    private processingFiles: Set<string> = new Set();

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        this.plugin = plugin;
    }

    /**
     * Process a file when it's opened - update filename and folder path
     */
    async processFileOnOpen(file: TFile): Promise<void> {
        if (!this.shouldProcess(file)) return;
        const liveFile = this.getLiveFile(file);
        if (!liveFile || !this.shouldProcess(liveFile)) return;
        const lockKey = liveFile.path;
        const skipFrontmatterWrites = this.shouldSkipAutoFrontmatterWrite(liveFile);

        // Prevent recursive processing
        if (this.processingFiles.has(lockKey)) {
            return;
        }

        this.processingFiles.add(lockKey);

        try {
            // Update folder path if enabled
            if (this.plugin.settings.autoSaveFolderPath && !skipFrontmatterWrites) {
                await this._syncFolderPath(liveFile);
            }

            // Check if filename needs updating (if enabled)
            if (this.plugin.settings.enableAutoRename) {
                await this.updateFilenameIfNeeded(liveFile);
            }
        } catch (error) {
            logger.error('[TPS GCM] Error processing file on open:', error);
        } finally {
            this.processingFiles.delete(lockKey);
        }
    }

    /**
     * Public method to sync folder path on demand (e.g. after move/rename)
     */
    async syncFolderPath(file: TFile): Promise<void> {
        if (!this.plugin.settings.autoSaveFolderPath) return;
        if (!this.shouldProcess(file)) return;
        const liveFile = this.getLiveFile(file);
        if (!liveFile || !this.shouldProcess(liveFile)) return;
        if (this.shouldSkipAutoFrontmatterWrite(liveFile)) return;
        const lockKey = liveFile.path;

        // Use internal helper to avoid duplicate processing checks if called directly
        // But we should still use the lock to prevent races
        if (this.processingFiles.has(lockKey)) return;
        this.processingFiles.add(lockKey);

        try {
            await this._syncFolderPath(liveFile);
        } finally {
            this.processingFiles.delete(lockKey);
        }
    }

    private async _syncFolderPath(file: TFile): Promise<void> {
        const liveFile = this.getLiveFile(file);
        if (!liveFile) return;
        if (this.shouldSkipAutoFrontmatterWrite(liveFile)) return;
        const currentFolder = liveFile.parent?.path || '/';
        const cache = this.plugin.app.metadataCache.getFileCache(liveFile);
        const fm = cache?.frontmatter;
        const existingFolderPath = typeof fm?.folderPath === 'string' ? fm.folderPath : String(fm?.folderPath ?? '');
        const hasLegacyTypeKeys = Object.keys(fm || {}).some((key) => {
            const normalized = String(key || '').trim().toLowerCase();
            return normalized === 'type' || normalized === 'types';
        });

        if (existingFolderPath === currentFolder && !hasLegacyTypeKeys) return;

        try {
            await this.plugin.app.fileManager.processFrontMatter(liveFile, (frontmatter) => {
                frontmatter.folderPath = currentFolder;
                for (const key of Object.keys(frontmatter)) {
                    const normalized = String(key || '').trim().toLowerCase();
                    if (normalized === 'type' || normalized === 'types') {
                        delete frontmatter[key];
                    }
                }
            });
        } catch (error) {
            if (this.isLikelyMissingFileError(error)) return;
            if (this.isDuplicateYamlKeyError(error)) return;
            throw error;
        }
    }

    /**
     * When a file is renamed by Obsidian core, keep frontmatter.title in sync with the new basename.
     * Applies the same "date suffix" normalization rules used by auto-rename (title excludes YYYY-MM-DD).
     */
    async syncTitleFromFilename(file: TFile): Promise<void> {
        if (!this.shouldProcess(file)) return;
        const liveFile = this.getLiveFile(file);
        if (!liveFile || !this.shouldProcess(liveFile)) return;
        if (this.shouldSkipAutoFrontmatterWrite(liveFile)) return;
        const lockKey = liveFile.path;

        // Prevent recursion / duplicate work during vault operations
        if (this.processingFiles.has(lockKey)) return;
        this.processingFiles.add(lockKey);

        try {
            const cache = this.plugin.app.metadataCache.getFileCache(liveFile);
            const fm = cache?.frontmatter || {};

            const rawBasename = (liveFile.basename || '').trim();
            if (!rawBasename) return;

            // Avoid writing clearly-stale template-derived titles
            if (rawBasename.toLowerCase().includes('template')) return;

            const scheduled = fm.scheduled;
            let nextTitle = rawBasename;

            // If the filename ends with a YYYY-MM-DD suffix, strip it from the title.
            // This keeps the "title" canonical and allows the filename to carry the date.
            const { base: before, dateStr } = extractDateSuffix(nextTitle);
            if (dateStr) {

                if (scheduled) {
                    const scheduledDate = window.moment(scheduled);
                    const suffixDate = window.moment(dateStr, 'YYYY-MM-DD', true);
                    if (scheduledDate.isValid() && suffixDate.isValid()) {
                        const scheduledStr = scheduledDate.format('YYYY-MM-DD');
                        if (scheduledStr === dateStr) {
                            nextTitle = before;
                        }
                    } else {
                        nextTitle = before;
                    }
                } else {
                    nextTitle = before;
                }
            }

            nextTitle = nextTitle.replace(/\s+/g, ' ').trim();
            const currentTitle = typeof fm.title === 'string' ? fm.title.trim() : '';

            if (nextTitle && nextTitle !== currentTitle) {
                const targetFile = this.getLiveFile(liveFile);
                if (!targetFile) return;
                await this.plugin.app.fileManager.processFrontMatter(targetFile, (frontmatter) => {
                    frontmatter.title = nextTitle;
                });
            }
        } catch (error) {
            if (this.isLikelyMissingFileError(error)) return;
            if (this.isDuplicateYamlKeyError(error)) return;
            logger.error('[TPS GCM] Error syncing title from filename:', error);
        } finally {
            this.processingFiles.delete(lockKey);
        }
    }

    /**
     * Update filename based on title and scheduled date
     */
    async updateFilenameIfNeeded(file: TFile): Promise<void> {
        if (!this.shouldProcess(file)) return;
        const liveFile = this.getLiveFile(file);
        if (!liveFile || !this.shouldProcess(liveFile)) return;

        const cache = this.plugin.app.metadataCache.getFileCache(liveFile);
        const fm = cache?.frontmatter;

        if (!fm) return;

        // Only proceed if there's a title in frontmatter
        if (!fm.title) return;

        const title = String(fm.title ?? '');
        if (!title.trim()) return;

        // Skip if title looks like a template name (stale cache data)
        // This prevents renaming newly created files with the template's title
        if (title.toLowerCase().includes('template')) {
            return;
        }

        const scheduled = fm.scheduled;

        // Generate the expected filename
        let expectedBasename: string;
        if (scheduled) {
            // Parse the scheduled date
            const scheduledDate = window.moment(scheduled);
            if (!scheduledDate.isValid()) {
                expectedBasename = this.sanitizeFilename(title);
            } else {
                const dateStr = scheduledDate.format('YYYY-MM-DD');
                const normalizedTitle = title.replace(/\s+/g, ' ').trim();
                const titleHasScheduledDate = new RegExp(`(^|\\s)${dateStr}(?:\\s|$)`).test(normalizedTitle);

                // If the title IS the date, just use the date (prevent "2025-01-01 2025-01-01")
                if (title.trim() === dateStr) {
                    expectedBasename = dateStr;
                } else if (titleHasScheduledDate) {
                    expectedBasename = this.sanitizeFilename(normalizedTitle);
                } else {
                    // Remove any existing date suffix from title to prevent duplication
                    const titleWithoutDate = stripDateSuffix(title);
                    expectedBasename = this.sanitizeFilename(`${titleWithoutDate} ${dateStr}`);
                }
            }
        } else {
            // Remove any existing date suffix if no scheduled date
            const titleWithoutDate = stripDateSuffix(title);
            expectedBasename = this.sanitizeFilename(titleWithoutDate);
        }

        // Check if current filename already matches (case-insensitive and trimmed)
        if (!expectedBasename) return;
        const currentNormalized = this.normalizeBasenameForCompare(liveFile.basename);
        const expectedNormalized = this.normalizeBasenameForCompare(expectedBasename);

        if (currentNormalized === expectedNormalized) {
            return; // Already has correct name
        }

        // Additional safety check: if current filename already contains the date, don't rename
        if (scheduled) {
            const dateStr = window.moment(scheduled).format('YYYY-MM-DD');
            const datePattern = new RegExp(`\\s${dateStr.replace(/-/g, '\\-')}(?:\\s|$)`);

            if (datePattern.test(liveFile.basename)) {
                // Filename already contains this date, check if it just needs exact matching
                const currentWithoutExtras = liveFile.basename.replace(/\s+/g, ' ').trim();
                const expectedWithoutExtras = expectedBasename.replace(/\s+/g, ' ').trim();

                if (currentWithoutExtras === expectedWithoutExtras) {
                    return; // Already correct, just whitespace differences
                }
            }
        }

        // Check if a file with the expected name already exists
        const expectedPath = liveFile.parent
            ? `${liveFile.parent.path}/${expectedBasename}.md`
            : `${expectedBasename}.md`;
        const currentPathNormalized = normalizePath(liveFile.path).toLowerCase();
        const expectedPathNormalized = normalizePath(expectedPath).toLowerCase();
        if (currentPathNormalized === expectedPathNormalized) {
            return;
        }

        const existingFile = this.plugin.app.vault.getAbstractFileByPath(expectedPath);

        if (existingFile && existingFile !== liveFile) {
            // A different file with this name already exists - don't overwrite
            logger.log(`[TPS GCM] File with name "${expectedBasename}" already exists, skipping rename`);
            return;
        }

        // Rename the file
        try {
            const previousBasename = liveFile.basename;
            const previousPath = liveFile.path;
            await this.plugin.app.fileManager.renameFile(liveFile, expectedPath);
            logger.log(`[TPS GCM] Renamed file from "${previousBasename}" to "${expectedBasename}" (${previousPath} -> ${expectedPath})`);
        } catch (error) {
            if (this.isLikelyMissingFileError(error)) return;
            logger.error(`[TPS GCM] Failed to rename file to "${expectedBasename}":`, error);
        }
    }

    /**
     * Sanitize filename to remove invalid characters
     */
    private sanitizeFilename(name: string): string {
        // Remove or replace invalid filename characters
        return name
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // Remove invalid characters
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim();
    }

    /**
     * Check if a file should be processed for auto-naming
     */
    shouldProcess(file: TFile): boolean {
        // Only process markdown files
        if (file.extension !== 'md') return false;

        const baseName = String(file.basename || '').trim().toLowerCase();
        if (baseName === '__type__' || baseName === '__root__') return false;

        // Don't process if already processing
        if (this.processingFiles.has(file.path)) return false;

        // Check folder exclusions
        if (this.plugin.settings.folderExclusions) {
            const exclusions = this.plugin.settings.folderExclusions
                .split('\n')
                .map(e => e.trim())
                .filter(e => e.length > 0);

            if (exclusions.some(excludedPath => file.path.startsWith(excludedPath))) {
                // logger.log(`[TPS GCM] Skipping ${file.path} due to folder exclusion`);
                return false;
            }
        }

        return true;
    }

    private getLiveFile(file: TFile): TFile | null {
        const latest = this.plugin.app.vault.getAbstractFileByPath(file.path);
        return latest instanceof TFile ? latest : null;
    }

    private normalizeBasenameForCompare(name: string): string {
        return String(name || '')
            .normalize('NFKC')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    private isLikelyMissingFileError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error ?? '');
        return /ENOENT|no such file or directory/i.test(message);
    }

    private isDuplicateYamlKeyError(error: unknown): boolean {
        const message = error instanceof Error ? error.message : String(error ?? '');
        return /map keys must be unique|duplicate key|duplicated mapping key/i.test(message);
    }

    private shouldSkipAutoFrontmatterWrite(file: TFile): boolean {
        return this.plugin.shouldIgnoreAutoFrontmatterWrite(file);
    }
}
