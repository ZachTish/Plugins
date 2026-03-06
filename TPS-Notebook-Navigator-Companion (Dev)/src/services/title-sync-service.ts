import { App, TFile } from "obsidian";
import { Logger } from "./logger";
import { MetadataManager } from "./metadata-manager";
import { NotebookNavigatorCompanionSettings } from "../types";
import { FrontmatterWriteExclusionService } from "./frontmatter-write-exclusion-service";

/**
 * Handles bidirectional sync between filenames and the frontmatter `title` field:
 *  - Filename → title: extracts a "clean" title from the filename (strips date suffix).
 *  - Title → filename: renames the file when the frontmatter title changes.
 *
 * Extracted from main.ts to keep the main class under 500 lines.
 */
export class TitleSyncService {
    constructor(
        private app: App,
        private metadataManager: MetadataManager,
        private logger: Logger,
        private getSettings: () => NotebookNavigatorCompanionSettings,
        private exclusionService: FrontmatterWriteExclusionService,
    ) {}

    /** Iterate every markdown file and queue a title update where the title is stale. */
    async syncAllTitlesFromFilenames(): Promise<void> {
        const files = this.app.vault.getMarkdownFiles();
        let count = 0;
        for (const file of files) {
            if (this.exclusionService.shouldIgnore(file)) continue;
            const { cleanTitle, dateSuffix } = this.parseFilenameComponents(file.basename);
            let resolvedTitle = cleanTitle;
            if (!resolvedTitle && dateSuffix) {
                const m = (window as any).moment;
                const dateObj = m(dateSuffix, ["YYYY-MM-DD", "YYYYMMDD"], true);
                if (dateObj.isValid()) resolvedTitle = dateObj.format("ddd, MMM D YYYY");
            }
            if (!resolvedTitle) continue;

            // For date-only files, also check whether `scheduled` needs repair.
            const isDateOnlyFile = !cleanTitle && !!dateSuffix;
            const cache = this.app.metadataCache.getFileCache(file);
            const currentTitle = String(cache?.frontmatter?.title ?? "").trim();
            const currentScheduled = String(cache?.frontmatter?.scheduled ?? "").trim();
            const needsScheduledFix =
                isDateOnlyFile &&
                !!dateSuffix &&
                (!currentScheduled || this.isTemplaterVariable(currentScheduled));

            if (currentTitle === resolvedTitle && !needsScheduledFix) continue;

            await this.metadataManager.queueFrontmatterUpdate(file, "filename-sync", (fm) => {
                let changed = false;
                if (String(fm.title ?? "").trim() !== resolvedTitle) {
                    fm.title = resolvedTitle;
                    changed = true;
                }
                if (needsScheduledFix) {
                    const sched = String(fm.scheduled ?? "").trim();
                    if (!sched || this.isTemplaterVariable(sched)) {
                        fm.scheduled = dateSuffix;
                        changed = true;
                    }
                }
                return changed;
            });
            count++;
        }
        this.logger.info(`syncAllTitlesFromFilenames: queued updates for ${count} files`);
    }

    /** Return true if a string appears to be an unresolved Templater expression. */
    private isTemplaterVariable(value: string): boolean {
        return /<%.*%>/.test(value);
    }

    /** Extract the "clean" title from a file's basename and update frontmatter.title. */
    async handleFilenameUpdate(file: TFile): Promise<void> {
        if (!this.getSettings().syncTitleFromFilename) return;
        if (this.exclusionService.shouldIgnore(file)) return;

        const { cleanTitle, dateSuffix } = this.parseFilenameComponents(file.basename);

        let resolvedTitle = cleanTitle;
        if (!resolvedTitle && dateSuffix) {
            const m = (window as any).moment;
            const dateObj = m(dateSuffix, ["YYYY-MM-DD", "YYYYMMDD"], true);
            if (dateObj.isValid()) {
                resolvedTitle = dateObj.format("ddd, MMM D YYYY");
            }
        }

        // For date-only filenames (no text prefix), also fix `scheduled` if it
        // holds an unresolved Templater variable or is blank.
        const isDateOnlyFile = !cleanTitle && !!dateSuffix;

        await this.metadataManager.queueFrontmatterUpdate(file, "filename-sync", (frontmatter) => {
            let changed = false;

            const currentTitle = String(frontmatter.title || "").trim();
            if (currentTitle !== resolvedTitle) {
                frontmatter.title = resolvedTitle;
                changed = true;
            }

            if (isDateOnlyFile && dateSuffix) {
                const currentScheduled = String(frontmatter.scheduled ?? "").trim();
                const needsScheduledFix =
                    !currentScheduled ||
                    this.isTemplaterVariable(currentScheduled);
                if (needsScheduledFix) {
                    frontmatter.scheduled = dateSuffix; // YYYY-MM-DD
                    changed = true;
                }
            }

            if (!changed) return false;
            return true;
        });
    }

    /** Rename the file to match its frontmatter title (preserving any date suffix). */
    async handleTitleSync(file: TFile): Promise<void> {
        if (!this.getSettings().syncFilenameFromTitle) return;
        if (this.exclusionService.shouldIgnore(file)) return;

        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache || !cache.frontmatter) return;

        const desiredTitle = String(cache.frontmatter.title || "").trim();
        if (!desiredTitle) return;

        const { cleanTitle: currentClean, dateSuffix } = this.parseFilenameComponents(file.basename);

        if (desiredTitle === currentClean) return;

        let newBasename = desiredTitle;
        if (dateSuffix) {
            newBasename = `${newBasename} ${dateSuffix}`;
        }

        // @ts-ignore: Internal API
        const sanitized = (this.app.vault.adapter as any).fs?.sanitize?.(newBasename) || newBasename.replace(/[\\/:]/g, "");

        const newPath = `${file.parent.path}/${sanitized}.${file.extension}`;

        if (newPath === file.path) return;
        if (await this.app.vault.adapter.exists(newPath)) {
            this.logger.warn("Skipping title sync rename: Target file already exists", { from: file.path, to: newPath });
            return;
        }

        try {
            await this.app.fileManager.renameFile(file, newPath);
            this.logger.info("Synced filename to match title", { old: file.path, new: newPath });
        } catch (error) {
            this.logger.error("Failed to rename file for title sync", error, { from: file.path, to: newPath });
        }
    }

    private parseFilenameComponents(basename: string): { cleanTitle: string; dateSuffix: string | null } {
        const datePattern = /\s*(\d{4}[-/]\d{2}[-/]\d{2}|\d{8})(?:\s+\d+)?$/;
        const match = basename.match(datePattern);
        if (match) {
            const dateSuffix = match[1];
            const cleanTitle = basename.substring(0, match.index).trim();
            return { cleanTitle, dateSuffix };
        }
        return { cleanTitle: basename, dateSuffix: null };
    }
}
