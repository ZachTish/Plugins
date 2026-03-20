import { normalizePath, TFile } from 'obsidian';
import TPSGlobalContextMenuPlugin from '../main';
import * as logger from "../logger";
import { extractDateSuffix, stripDateSuffix } from '../utils/date-suffix-utils';
import { parseDateFromFilename, isDailyBasename } from '../utils/daily-file-date';

/**
 * Handles automatic file naming based on title and scheduled date
 */
export class FileNamingService {
    plugin: TPSGlobalContextMenuPlugin;
    private processingFiles: Set<string> = new Set();
    private recentFolderPathWrites: Map<string, { value: string; until: number }> = new Map();
    private inferredDailyNoteFormat: string | null = null;

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        this.plugin = plugin;
    }

    private static readonly TEMPLATE_TITLE_MARKERS: RegExp[] = [
        /<%[\s\S]*%>/i,
        /\{\{[\s\S]*\}\}/i,
        /\btp\.[a-z0-9_]+\b/i,
        /\btemplater\b/i,
    ];

    private getDailyNoteDateFormat(): string {
        const configured = String((this.plugin as any)?.settings?.dailyNoteDateFormat || '').trim();
        if (configured) return configured;
        const dailyNotesFormat = String((this.plugin.app as any)?.internalPlugins?.plugins?.["daily-notes"]?.instance?.options?.format || '').trim();
        if (dailyNotesFormat) return dailyNotesFormat;
        if (!this.inferredDailyNoteFormat) {
            const hasPrettyDaily = this.plugin.app.vault.getFiles().some((file) =>
                /\/Notes\/[A-Za-z]+,\s+[A-Za-z]+\s+\d{1,2}(st|nd|rd|th)\s+\d{4}\.md$/.test(file.path),
            );
            this.inferredDailyNoteFormat = hasPrettyDaily ? 'dddd, MMMM Do YYYY' : 'YYYY-MM-DD';
        }
        return this.inferredDailyNoteFormat;
    }

    private titleMatchesScheduledDate(title: string, scheduledDate: any): boolean {
        const normalizedTitle = String(title || '').replace(/\s+/g, ' ').trim();
        if (!normalizedTitle) return false;
        if (!scheduledDate || !scheduledDate.isValid || !scheduledDate.isValid()) return false;

        const preferredFormat = this.getDailyNoteDateFormat();
        const expectedIso = scheduledDate.format('YYYY-MM-DD');
        const expectedPreferred = scheduledDate.format(preferredFormat);

        const lowered = normalizedTitle.toLowerCase();
        if (lowered === expectedIso.toLowerCase() || lowered === expectedPreferred.toLowerCase()) return true;
        if (lowered.includes(expectedIso.toLowerCase()) || lowered.includes(expectedPreferred.toLowerCase())) return true;

        const parsed = parseDateFromFilename(normalizedTitle, preferredFormat);
        return !!parsed?.isValid?.() && parsed.isValid() && parsed.format('YYYY-MM-DD') === expectedIso;
    }

    private stripKnownDateSuffix(value: string, scheduledDate: any): string {
        let stripped = stripDateSuffix(String(value || '')).replace(/\s+/g, ' ').trim();
        if (!scheduledDate || !scheduledDate.isValid || !scheduledDate.isValid()) return stripped;

        const candidates = [
            scheduledDate.format(this.getDailyNoteDateFormat()),
            scheduledDate.format('YYYY-MM-DD'),
        ].map((v) => String(v || '').trim()).filter(Boolean);

        for (const suffix of candidates) {
            const lowered = stripped.toLowerCase();
            const target = ` ${suffix.toLowerCase()}`;
            if (lowered.endsWith(target)) {
                stripped = stripped.slice(0, stripped.length - target.length).trim();
            }
        }

        return stripped;
    }

    /**
     * Process a file when it's opened - update filename and folder path
     */
    async processFileOnOpen(file: TFile, options: { bypassCreationGrace?: boolean } = {}): Promise<void> {
        if (!this.shouldProcess(file, options)) return;
        const liveFile = this.getLiveFile(file);
        if (!liveFile || !this.shouldProcess(liveFile, options)) return;
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

            // Keep frontmatter title aligned with filename only when explicitly enabled.
            if (this.plugin.settings.autoSyncTitleFromFilename && !skipFrontmatterWrites) {
                await this.syncTitleFromFilename(liveFile, {
                    bypassCreationGrace: options.bypassCreationGrace,
                    onlyIfTemplateDerived: !this.plugin.settings.enableAutoRename,
                });
            }

            // Check if filename needs updating (if enabled)
            if (this.plugin.settings.enableAutoRename) {
                await this.updateFilenameIfNeeded(liveFile, {
                    bypassCreationGrace: options.bypassCreationGrace,
                });
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
        logger.log(`[FILE-DRAG] syncFolderPath called for: ${file.path}`);
        if (!this.plugin.settings.autoSaveFolderPath) {
            logger.log(`[FILE-DRAG] autoSaveFolderPath disabled, skipping`);
            return;
        }
        if (!this.shouldProcess(file)) {
            logger.log(`[FILE-DRAG] shouldProcess returned false, skipping`);
            return;
        }
        const liveFile = this.getLiveFile(file);
        if (!liveFile || !this.shouldProcess(liveFile)) {
            logger.log(`[FILE-DRAG] liveFile check failed, skipping`);
            return;
        }
        if (this.shouldSkipAutoFrontmatterWrite(liveFile)) {
            logger.log(`[FILE-DRAG] shouldSkipAutoFrontmatterWrite true, skipping`);
            return;
        }
        const lockKey = liveFile.path;

        // Use internal helper to avoid duplicate processing checks if called directly
        // But we should still use the lock to prevent races
        if (this.processingFiles.has(lockKey)) {
            logger.log(`[FILE-DRAG] Already processing ${lockKey}, skipping`);
            return;
        }
        this.processingFiles.add(lockKey);
        logger.log(`[FILE-DRAG] Acquired lock for ${lockKey}`);

        try {
            await this._syncFolderPath(liveFile);
        } finally {
            this.processingFiles.delete(lockKey);
            logger.log(`[FILE-DRAG] Released lock for ${lockKey}`);
        }
    }

    private async _syncFolderPath(file: TFile): Promise<void> {
        logger.log(`[FILE-DRAG] _syncFolderPath: ${file.path}`);
        const liveFile = this.getLiveFile(file);
        if (!liveFile) {
            logger.log(`[FILE-DRAG] No live file found`);
            return;
        }
        if (this.shouldSkipAutoFrontmatterWrite(liveFile)) {
            logger.log(`[FILE-DRAG] Skipping frontmatter write`);
            return;
        }
        if (!(await this.plugin.bulkEditService.canMutateFrontmatterSafely(liveFile))) {
            logger.warn(`[FILE-DRAG] Skipping folderPath write due to malformed frontmatter: ${liveFile.path}`);
            return;
        }
        const currentFolder = liveFile.parent?.path || '/';
        const cache = this.plugin.app.metadataCache.getFileCache(liveFile);
        const fm = cache?.frontmatter;
        const existingFolderPath = this.getFrontmatterStringValueCaseInsensitive(fm || {}, 'folderPath').trim();
        const persistedFolderPath = await this.getPersistedFolderPath(liveFile);
        const hasLegacyTypeKeys = Object.keys(fm || {}).some((key) => {
            const normalized = String(key || '').trim().toLowerCase();
            return normalized === 'type' || normalized === 'types';
        });

        logger.log(`[FILE-DRAG] currentFolder=${currentFolder}, existingFolderPath=${existingFolderPath}, persistedFolderPath=${persistedFolderPath}, hasLegacyTypeKeys=${hasLegacyTypeKeys}`);

        if (this.hasRecentFolderPathWrite(liveFile.path, currentFolder)) {
            logger.log(`[FILE-DRAG] Skipping repeated folderPath write for ${liveFile.path}`);
            return;
        }

        const effectiveFolderPath = persistedFolderPath || existingFolderPath;
        if (effectiveFolderPath === currentFolder && !hasLegacyTypeKeys) {
            logger.log(`[FILE-DRAG] No update needed`);
            return;
        }

        try {
            logger.log(`[FILE-DRAG] Writing folderPath to frontmatter: ${currentFolder}`);
            await this.plugin.bulkEditService.runSerializedFrontmatterWrite(liveFile, async () => {
                await this.plugin.app.fileManager.processFrontMatter(liveFile, (frontmatter) => {
                    frontmatter.folderPath = currentFolder;
                    for (const key of Object.keys(frontmatter)) {
                        const normalized = String(key || '').trim().toLowerCase();
                        if (normalized === 'type' || normalized === 'types') {
                            delete frontmatter[key];
                        }
                    }
                });
            });
            this.rememberRecentFolderPathWrite(liveFile.path, currentFolder);
            logger.log(`[FILE-DRAG] Frontmatter updated successfully`);
        } catch (error) {
            if (this.isLikelyMissingFileError(error)) {
                logger.log(`[FILE-DRAG] Missing file error (expected during move)`);
                return;
            }
            if (this.isDuplicateYamlKeyError(error)) {
                logger.log(`[FILE-DRAG] Duplicate YAML key error`);
                return;
            }
            logger.error(`[FILE-DRAG] Unexpected error:`, error);
            throw error;
        }
    }

    /**
     * When a file is renamed by Obsidian core, keep frontmatter.title in sync with the new basename.
     * Applies the same "date suffix" normalization rules used by auto-rename (title excludes YYYY-MM-DD).
     */
    async syncTitleFromFilename(
        file: TFile,
        options: { onlyIfTemplateDerived?: boolean; force?: boolean; bypassCreationGrace?: boolean } = {},
    ): Promise<void> {
        if (!options.force && !this.plugin.settings.autoSyncTitleFromFilename) {
            return;
        }
        await this.syncTitleFromFilenameWithOptions(file, options);
    }

    async repairTemplateDerivedTitlesAcrossVault(): Promise<{ scanned: number; updated: number; skipped: number; failed: number }> {
        const files = this.plugin.app.vault.getMarkdownFiles().filter((file) => this.shouldProcess(file));
        let scanned = 0;
        let updated = 0;
        let skipped = 0;
        let failed = 0;

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            scanned += 1;

            try {
                const result = await this.syncTitleFromFilenameWithOptions(file, {
                    onlyIfTemplateDerived: true,
                    force: true,
                });
                if (result === "updated") updated += 1;
                else skipped += 1;
            } catch {
                failed += 1;
            }

            if ((i + 1) % 50 === 0) {
                await this.yieldToEventLoop();
            }
        }

        return { scanned, updated, skipped, failed };
    }

    private async syncTitleFromFilenameWithOptions(
        file: TFile,
        options: { onlyIfTemplateDerived?: boolean; force?: boolean; bypassCreationGrace?: boolean },
    ): Promise<"updated" | "skipped"> {
        if (!options.force && !this.plugin.settings.autoSyncTitleFromFilename) return "skipped";
        if (!this.shouldProcess(file, options)) return "skipped";
        const liveFile = this.getLiveFile(file);
        if (!liveFile || !this.shouldProcess(liveFile, options)) return "skipped";
        if (this.shouldSkipAutoFrontmatterWrite(liveFile)) return "skipped";
        const lockKey = liveFile.path;

        // Prevent recursion / duplicate work during vault operations
        if (this.processingFiles.has(lockKey)) return "skipped";
        this.processingFiles.add(lockKey);

        try {
            const cache = this.plugin.app.metadataCache.getFileCache(liveFile);
            const fm = cache?.frontmatter || {};

            const rawBasename = (liveFile.basename || '').trim();
            if (!rawBasename) return "skipped";

            // Date-only files (daily notes) are owned by the Companion
            // plugin for title sync. Skip them here to avoid fighting over title values.
            if (isDailyBasename(rawBasename, (this.plugin as any)?.settings?.dailyNoteDateFormat)) return "skipped";

            // Avoid writing clearly-stale template-derived titles
            if (rawBasename.toLowerCase().includes('template')) return "skipped";

            const scheduled = fm.scheduled;
            let nextTitle = rawBasename;

            // If the filename ends with a YYYY-MM-DD suffix, strip it from the title.
            // This keeps the "title" canonical and allows the filename to carry the date.
            const { base: before, dateStr } = extractDateSuffix(nextTitle);
            if (dateStr) {
                if (scheduled) {
                    const scheduledDate = window.moment(scheduled);
                    const parsed = parseDateFromFilename(dateStr, (this.plugin as any)?.settings?.dailyNoteDateFormat);
                    const suffixDateValid = parsed && parsed.isValid && parsed.isValid();
                    if (scheduledDate.isValid() && suffixDateValid) {
                        const scheduledStr = scheduledDate.format('YYYY-MM-DD');
                        const suffixStr = (parsed as any).format('YYYY-MM-DD');
                        if (scheduledStr === suffixStr) {
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
            const currentTitle = this.getFrontmatterStringValueCaseInsensitive(fm, 'title').trim();
            const templateDerivedTitle = this.isTemplateDerivedTitle(currentTitle, rawBasename);
            if (options.onlyIfTemplateDerived && !templateDerivedTitle) {
                return "skipped";
            }

            if (nextTitle && nextTitle !== currentTitle) {
                const targetFile = this.getLiveFile(liveFile);
                if (!targetFile) return "skipped";
                if (!(await this.plugin.bulkEditService.canMutateFrontmatterSafely(targetFile))) {
                    logger.warn(`[TPS GCM] Skipping title sync due to malformed frontmatter: ${targetFile.path}`);
                    return "skipped";
                }
                await this.plugin.bulkEditService.runSerializedFrontmatterWrite(targetFile, async () => {
                    await this.plugin.app.fileManager.processFrontMatter(targetFile, (frontmatter) => {
                        const existingTitleKeys = Object.keys(frontmatter).filter(
                            (key) => key.trim().toLowerCase() === 'title',
                        );
                        if (existingTitleKeys.length === 0) {
                            frontmatter.title = nextTitle;
                            return;
                        }
                        frontmatter[existingTitleKeys[0]] = nextTitle;
                        for (let i = 1; i < existingTitleKeys.length; i++) {
                            delete frontmatter[existingTitleKeys[i]];
                        }
                    });
                });
                return "updated";
            }
            return "skipped";
        } catch (error) {
            if (this.isLikelyMissingFileError(error)) return "skipped";
            if (this.isDuplicateYamlKeyError(error)) return "skipped";
            logger.error('[TPS GCM] Error syncing title from filename:', error);
            return "skipped";
        } finally {
            this.processingFiles.delete(lockKey);
        }
        return "skipped";
    }

    /**
     * Update filename based on title and scheduled date
     */
    async updateFilenameIfNeeded(file: TFile, options: { bypassCreationGrace?: boolean } = {}): Promise<void> {
        if (!this.shouldProcess(file, options)) return;
        const liveFile = this.getLiveFile(file);
        if (!liveFile || !this.shouldProcess(liveFile, options)) return;
        if (this.shouldSkipAutoFrontmatterWrite(liveFile)) return;

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

        // Date-only files (daily notes: YYYY-MM-DD) should never be renamed based on
        // title/scheduled logic. Their filename IS the canonical identifier.
        if (FULL_DATE_REGEX.test(String(liveFile.basename).trim())) return;

        const scheduled = fm.scheduled;

        // Generate the expected filename
        let expectedBasename: string;
        if (scheduled) {
            // Parse the scheduled date
            const scheduledDate = window.moment(scheduled);
            if (!scheduledDate.isValid()) {
                expectedBasename = this.sanitizeFilename(title);
            } else {
                const dateStr = scheduledDate.format(this.getDailyNoteDateFormat());
                const normalizedTitle = title.replace(/\s+/g, ' ').trim();
                const titleHasScheduledDate = this.titleMatchesScheduledDate(normalizedTitle, scheduledDate);

                // If the title IS the date, just use the date (prevent "2025-01-01 2025-01-01")
                if (this.titleMatchesScheduledDate(title.trim(), scheduledDate)) {
                    expectedBasename = this.sanitizeFilename(normalizedTitle);
                } else if (titleHasScheduledDate) {
                    expectedBasename = this.sanitizeFilename(normalizedTitle);
                } else {
                    // Remove any existing date suffix from title to prevent duplication
                    const titleWithoutDate = this.stripKnownDateSuffix(title, scheduledDate);
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
    shouldProcess(file: TFile, options: { bypassCreationGrace?: boolean } = {}): boolean {
        // Only process markdown files
        if (file.extension !== 'md') return false;

        // Grace period for newly created files to allow other plugins (TPS-Controller, Templater) to finish initialization
        const age = Date.now() - file.stat.ctime;
        if (!options.bypassCreationGrace && age < 2000) return false;

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

            const normalizedPath = this.normalizeBasenameForCompare(file.path);
            const normalizedBasename = this.normalizeBasenameForCompare(file.basename);

            if (exclusions.some(pattern => this.plugin.matchesAutoFrontmatterExclusionPattern(normalizedPath, normalizedBasename, pattern))) {
                return false;
            }
        }

        // Check frontmatter auto-write exclusions (prevents auto-rename/title sync for excluded paths)
        if (this.shouldSkipAutoFrontmatterWrite(file)) {
            return false;
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

    private hasRecentFolderPathWrite(path: string, value: string): boolean {
        this.clearExpiredRecentFolderPathWrites();
        const record = this.recentFolderPathWrites.get(path);
        if (!record) return false;
        return record.value === value;
    }

    private rememberRecentFolderPathWrite(path: string, value: string): void {
        this.clearExpiredRecentFolderPathWrites();
        this.recentFolderPathWrites.set(path, {
            value,
            until: Date.now() + 5000,
        });
    }

    private clearExpiredRecentFolderPathWrites(): void {
        const now = Date.now();
        for (const [path, record] of this.recentFolderPathWrites.entries()) {
            if (record.until <= now) {
                this.recentFolderPathWrites.delete(path);
            }
        }
    }

    private async getPersistedFolderPath(file: TFile): Promise<string> {
        let content = '';
        try {
            content = await this.plugin.app.vault.cachedRead(file);
        } catch {
            return '';
        }

        if (!content) return '';

        const normalized = content.replace(/\r\n/g, '\n');
        const body = normalized.startsWith('\uFEFF') ? normalized.slice(1) : normalized;
        const trimmedLeading = body.replace(/^\s*/, '');
        const candidate = body.startsWith('---\n')
            ? body
            : trimmedLeading.startsWith('---\n')
                ? trimmedLeading
                : '';
        if (!candidate) return '';

        const closeIndex = candidate.indexOf('\n---\n', 4);
        if (closeIndex === -1) return '';

        const yamlBody = candidate.slice(4, closeIndex);
        for (const line of yamlBody.split('\n')) {
            const match = line.match(/^\s*([^:#]+?)\s*:\s*(.*)\s*$/);
            if (!match) continue;
            if (match[1].trim().toLowerCase() !== 'folderpath') continue;
            const rawValue = match[2].trim();
            if (!rawValue) return '';
            const quoted = rawValue.match(/^(['"])(.*)\1$/);
            return quoted ? quoted[2] : rawValue;
        }

        return '';
    }

    private getFrontmatterStringValueCaseInsensitive(frontmatter: Record<string, any>, key: string): string {
        const normalized = key.trim().toLowerCase();
        const existingKey = Object.keys(frontmatter).find((k) => k.trim().toLowerCase() === normalized);
        if (!existingKey) return "";
        const value = frontmatter[existingKey];
        return typeof value === "string" ? value : String(value ?? "");
    }

    private isTemplateDerivedTitle(currentTitle: string, basename: string): boolean {
        const title = String(currentTitle || '').trim();
        if (!title) return true;

        if (FileNamingService.TEMPLATE_TITLE_MARKERS.some((pattern) => pattern.test(title))) {
            return true;
        }

        const normalizedTitle = this.normalizeBasenameForCompare(title);
        const normalizedBasename = this.normalizeBasenameForCompare(basename);
        if (normalizedTitle.includes('template') && !normalizedBasename.includes('template')) {
            return true;
        }

        if (normalizedTitle === 'untitled' || normalizedTitle === 'new note') {
            return true;
        }

        return false;
    }

    private async yieldToEventLoop(): Promise<void> {
        await new Promise<void>((resolve) => {
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => resolve());
                return;
            }
            setTimeout(resolve, 0);
        });
    }
}
