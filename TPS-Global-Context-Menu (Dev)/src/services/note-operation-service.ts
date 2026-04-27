import { App, TFile, Notice, FuzzySuggestModal, Modal, parseYaml, stringifyYaml, normalizePath } from "obsidian";
import TPSGlobalContextMenuPlugin from "../main";
import * as logger from "../logger";
import { mergeNormalizedTags, normalizeTagValue } from "../utils/tag-utils";
import { setValueCaseInsensitive } from "../core/record-utils";
import { getArchiveBucketPath, normalizeArchiveFolderMode, resolveArchiveTargetInfo } from "../utils/archive-path";
import { getDailyNoteResolver } from "../../../TPS-Controller (Dev)/src/utils/daily-note-resolver";
import { ensureDailyNoteFile } from "../../../TPS-Controller (Dev)/src/utils/daily-note-create";

export class NoteOperationService {
    app: App;
    plugin: TPSGlobalContextMenuPlugin;

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        this.plugin = plugin;
        this.app = plugin.app;
    }

    public async populateDailyNoteWithScheduledItems(dailyNote: TFile): Promise<void> {
        const resolver = getDailyNoteResolver(this.app, {
            formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
        });
        const dailyNoteDateStr = resolver.parseFilenameToDateKey(dailyNote.basename);
        if (!dailyNoteDateStr) {
            return;
        }

        // Check if the note already has content - don't auto-populate if it does
        // This prevents repeated expensive scans and modifications
        const content = await this.plugin.subitemRelationshipSyncService.readMarkdownText(dailyNote);
        const lines = content.split('\n').filter(line => line.trim() && !line.trim().startsWith('---'));
        if (lines.length > 5) {
            // Note already has substantial content, skip auto-populate
            return;
        }

        const scheduledFiles: TFile[] = [];
        for (const file of this.app.vault.getMarkdownFiles()) {
            if (file.path === dailyNote.path) continue;
            const cache = this.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter;
            if (!fm) continue;

            const scheduled = String(fm.scheduled ?? '').trim();
            if (!scheduled) continue;

            const scheduledDate = (window as any).moment(scheduled);
            if (scheduledDate.isValid() && scheduledDate.format('YYYY-MM-DD') === dailyNoteDateStr) {
                // Ignore files that are themselves daily notes
                if (this.plugin.fileNamingService.isDateOnlyBasename(file.basename)) continue;
                scheduledFiles.push(file);
            }
        }

        if (scheduledFiles.length === 0) return;

        let modified = false;

        for (const childFile of scheduledFiles) {
            // Check if the file has a status field
            const cache = this.app.metadataCache.getFileCache(childFile);
            const fmKeys = Object.keys(cache?.frontmatter || {});
            const hasStatus = fmKeys.some(k => k.trim().toLowerCase() === 'status');

            const changed = await this.plugin.subitemRelationshipSyncService.insertBodyLink(
                dailyNote,
                childFile,
                hasStatus ? '[ ]' : null,
            );
            if (changed) {
                modified = true;
            }
        }

        if (modified) {
            logger.log(`[TPS GCM] Populated daily note ${dailyNote.basename} with scheduled item(s).`);
        }
    }

    async addNotesToAnotherNote(files: TFile[]) {
        try {
            if (!files.length) {
                new Notice("Select a file first");
                return;
            }

            // Fuzzy Picker to choose target note
            const picker = await new Promise<TFile | null>((resolve) => {
                let settled = false;
                const finish = (val: TFile | null) => {
                    if (settled) return;
                    settled = true;
                    resolve(val);
                };

                class Picker extends FuzzySuggestModal<TFile> {
                    constructor(app: App) {
                        super(app);
                        this.setPlaceholder("Choose note to append to...");
                    }

                    getItems(): TFile[] {
                        return this.app.vault.getMarkdownFiles();
                    }

                    getItemText(file: TFile): string {
                        return file.path;
                    }

                    onChooseItem(item: TFile, evt: MouseEvent | KeyboardEvent) {
                        finish(item);
                    }

                    onClose() {
                        finish(null);
                    }
                }
                new Picker(this.app).open();
            });

            if (!picker) return;

            const sections: string[] = [];
            const appendedSources: TFile[] = [];
            for (const file of files) {
                try {
                    const section = await this.buildSectionForNote(file);
                    sections.push(section);
                    appendedSources.push(file);
                } catch (err) {
                    logger.error("Failed to build section for", file.path, err);
                }
            }

            if (!sections.length) {
                new Notice("Nothing to append");
                return;
            }

            const existing = await this.app.vault.read(picker);
            logger.log(`[NoteOperationService] Prepending ${sections.length} note(s) → "${picker.basename}"`);
            await this.app.vault.modify(picker, this.insertContentAtTopOfBody(existing, sections.join("\n")));

            const archiveResult = await this.archiveSourceNotes(appendedSources, new Set([picker.path]));
            const archivedSuffix = archiveResult.archived > 0
                ? ` and archived ${archiveResult.archived} source note(s)`
                : "";
            new Notice(`Added ${sections.length} note(s) to ${picker.basename}${archivedSuffix}`);

        } catch (err) {
            logger.error("Add to note failed", err);
            new Notice("Unable to add to note");
        }
    }

    async addNotesToDailyNotes(files: TFile[]) {
        try {
            if (!files.length) {
                new Notice("Select a file first");
                return;
            }

            const mode = await this.promptDailyMode();
            if (!mode) return;

            const grouped = new Map<string, Array<{ source: TFile; section: string }>>();

            for (const file of files) {
                const parts = await this.extractNoteParts(file);
                const date = this.pickDailyDate(mode, parts.frontmatter, file);
                if (!date) {
                    logger.warn("No daily date for file", file.path, mode);
                    continue;
                }
                const section = await this.buildSectionForNote(file, parts);
                if (grouped.has(date)) {
                    grouped.get(date)?.push({ source: file, section });
                } else {
                    grouped.set(date, [{ source: file, section }]);
                }
            }

            if (!grouped.size) {
                new Notice(`No usable ${mode} dates found`);
                return;
            }

            const appendedSourcePaths = new Set<string>();
            const dailyTargetPaths = new Set<string>();

            for (const [date, items] of grouped.entries()) {
                try {
                    const daily = await this.ensureDailyNote(date);
                    if (!daily) continue;
                    dailyTargetPaths.add(daily.path);

                    const existing = await this.app.vault.read(daily);
                    await this.app.vault.modify(
                        daily,
                        this.insertContentAtTopOfBody(existing, items.map((item) => item.section).join("\n")),
                    );
                    for (const item of items) {
                        appendedSourcePaths.add(item.source.path);
                    }
                } catch (err) {
                logger.error("Failed to prepend to daily note", date, err);
                }
            }

            if (appendedSourcePaths.size === 0) {
            new Notice("Unable to add notes to daily notes");
                return;
            }

            const appendedSources = files.filter((file) => appendedSourcePaths.has(file.path));
            const archiveResult = await this.archiveSourceNotes(appendedSources, dailyTargetPaths);
            const archivedSuffix = archiveResult.archived > 0
                ? ` and archived ${archiveResult.archived} source note(s)`
                : "";
            new Notice(`Added ${appendedSourcePaths.size} note(s) to daily notes by ${mode} date${archivedSuffix}`);

        } catch (err) {
            logger.error("Add to daily note failed", err);
            new Notice("Unable to add to daily note");
        }
    }

    private async extractNoteParts(file: TFile) {
        const raw = await this.app.vault.read(file);
        const cache = this.app.metadataCache.getFileCache(file);
        let frontmatter: any = {};
        let body = raw;
        const cacheFrontmatter = cache?.frontmatter ? this.cloneFrontmatterObject(cache.frontmatter) : {};

        try {
            if (cache?.frontmatter?.position) {
                const { start, end } = cache.frontmatter.position;
                const lines = raw.split("\n");
                const slice = lines.slice(start.line + 1, end.line).join("\n");
                frontmatter = parseYaml(slice) || {};
                body = lines.slice(end.line + 1).join("\n");
            }
        } catch (err) {
            logger.error("Failed to parse frontmatter for", file.path, err);
        }

        // Fallback: parse YAML frontmatter directly from file text when metadata cache
        // positions are unavailable or stale.
        if (!this.hasKeys(frontmatter)) {
            const parsed = this.extractYamlFrontmatter(raw);
            if (parsed) {
                frontmatter = parsed.frontmatter;
                body = parsed.body;
            } else if (this.hasKeys(cacheFrontmatter)) {
                frontmatter = cacheFrontmatter;
            }
        }

        return { frontmatter, body };
    }

    private async buildSectionForNote(file: TFile, parts?: { frontmatter: any, body: string }) {
        if (!parts) {
            parts = await this.extractNoteParts(file);
        }
        const title = file.basename || file.name;
        const fmBlock = this.serializeFrontmatterForSection(parts.frontmatter || {});
        let bodyBlock = this.demoteHeadingsForEmbed((parts.body || "").trim());

        if (!bodyBlock.trim()) bodyBlock = "_(empty)_";

        return `## ${title}\n\n### Frontmatter\n${fmBlock}\n\n### Body\n${bodyBlock}\n`;
    }

    private insertContentAtTopOfBody(content: string, inserted: string): string {
        const normalizedContent = String(content || "").replace(/\r\n/g, "\n");
        const normalizedInserted = String(inserted || "").replace(/\r\n/g, "\n").trimEnd();
        if (!normalizedContent) return `${normalizedInserted}\n`;
        if (!normalizedInserted) return normalizedContent;

        const lines = normalizedContent.split("\n");
        if (lines[0]?.trim() !== '---') {
            const separator = normalizedContent.endsWith('\n') ? '' : '\n';
            return `${normalizedInserted}${separator}${normalizedContent}`;
        }

        let frontmatterEndIndex = -1;
        for (let i = 1; i < lines.length; i += 1) {
            if (lines[i]?.trim() === '---') {
                frontmatterEndIndex = i;
                break;
            }
        }

        if (frontmatterEndIndex < 0) {
            const separator = normalizedContent.endsWith('\n') || normalizedContent.length === 0 ? '' : '\n';
            return `${normalizedContent}${separator}${normalizedInserted}\n`;
        }

        const beforeInsert = lines.slice(0, frontmatterEndIndex + 1);
        const afterFrontmatter = lines.slice(frontmatterEndIndex + 1);
        const hasLeadingBlank = afterFrontmatter.length > 0 && afterFrontmatter[0]?.trim() === '';
        const remaining = hasLeadingBlank ? afterFrontmatter.slice(1) : afterFrontmatter;
        const resultLines = [...beforeInsert, '', normalizedInserted];
        if (remaining.length > 0) {
            resultLines.push('');
            resultLines.push(...remaining);
        }
        let result = resultLines.join('\n');
        if (!result.endsWith('\n')) result += '\n';
        return result;
    }

    private serializeFrontmatterForSection(fm: any): string {
        if (!fm || typeof fm !== "object" || !Object.keys(fm).length) {
            return "```yaml\n# (none)\n```";
        }
        const yaml = stringifyYaml(fm).trimEnd();
        return `\`\`\`yaml\n${yaml}\n\`\`\``;
    }


    private demoteHeadingsForEmbed(text: string): string {
        if (!text) return "";
        let inFence = false;
        return text.split("\n").map(line => {
            const trimmed = line.trimStart();
            if (trimmed.startsWith("```")) {
                inFence = !inFence;
                return line;
            }
            if (inFence) return line;

            const match = line.match(/^(#{1,6})\s+(.*)$/);
            if (!match) return line;

            const level = match[1].length;
            const content = match[2];
            // Demote significantly to avoid messing up target note outline
            const newLevel = Math.min(6, level + 3);
            return `${"#".repeat(newLevel)} ${content}`;
        }).join("\n");
    }

    private pickDailyDate(mode: 'created' | 'edited', fm: any, file: TFile): string | null {
        return mode === 'created'
            ? this.pickDateFromFrontmatterOrStat(
                fm,
                ["createddate", "datecreated", "created"],
                file.stat.ctime,
            )
            : this.pickDateFromFrontmatterOrStat(
                fm,
                ["modifieddate", "datemodified", "modified", "updated", "dateupdated"],
                file.stat.mtime,
            );
    }

    private pickDateFromFrontmatterOrStat(
        fm: any,
        normalizedKeys: string[],
        statFallback: number,
    ): string | null {
        const candidates: any[] = [];
        fm = fm || {};

        // Check frontmatter keys
        for (const [key, val] of Object.entries(fm)) {
            const norm = key.replace(/\s+/g, "").toLowerCase();
            if (normalizedKeys.includes(norm)) {
                candidates.push(val);
            }
        }

        const momentLib = (window as any).moment;
        for (const val of candidates) {
            try {
                if (momentLib) {
                    const m = momentLib(val);
                    if (m?.isValid && m.isValid()) return m.format("YYYY-MM-DD");
                }
                const parsed = Date.parse(`${val}`);
                if (!Number.isNaN(parsed)) {
                    const d = new Date(parsed);
                    // Simple ISO format
                    return d.toISOString().split("T")[0];
                }
            } catch { }
        }

        // Fallback to file stat time
        if (statFallback) {
            const d = new Date(statFallback);
            return d.toISOString().split("T")[0];
        }
        return null;
    }

    private async promptDailyMode(): Promise<'created' | 'edited' | null> {
        return await new Promise<'created' | 'edited' | null>((resolve) => {
            const modal = new DailyModeModal(this.app, resolve);
            modal.open();
        });
    }

    private async ensureDailyNote(dateStr: string): Promise<TFile | null> {
        const targetDate = (window as any)?.moment?.(dateStr, "YYYY-MM-DD", true);
        if (!targetDate?.isValid?.()) return null;

        const resolver = getDailyNoteResolver(this.app, {
            formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
        });
        const date = targetDate.toDate();
        const folder = resolver.folder || "System/Dailynotes";
        let templatePath = resolver.template || "System/Dailynotes/Daily Note Template.md";
        if (templatePath && !templatePath.endsWith(".md")) templatePath += ".md";
        const titleValue = resolver.formatFilename(date);
        const path = resolver.buildPath(date, "md");
        const adapter = this.app.vault.adapter;

        if (await adapter.exists(path)) {
            const existing = this.app.vault.getAbstractFileByPath(path);
            if (existing instanceof TFile) {
                await this.normalizeCreatedDailyNote(existing, titleValue, folder, dateStr);
                return existing;
            }
            return null;
        }

        const createdViaShared = await ensureDailyNoteFile(this.app as any, date, {
            formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
        });
        if (createdViaShared instanceof TFile) {
            await this.normalizeCreatedDailyNote(createdViaShared, titleValue, folder, dateStr);
            return createdViaShared;
        }

        // Create if missing
        // Ensure folder exists
        if (!(await adapter.exists(folder))) {
            await this.ensureFolderPath(folder);
        }

        let content = "";
        let hasFrontmatter = false;
        let shouldWriteTitleViaFrontmatterApi = false;

        try {
            const normalizedTemplatePath = normalizePath(templatePath);
            if (await adapter.exists(normalizedTemplatePath)) {
                content = await adapter.read(normalizedTemplatePath);
                hasFrontmatter = content.trimStart().startsWith("---");
            }
        } catch {
            content = "";
        }

        if (!content) {
            content = `---\ntitle: ${titleValue}\ntags: [dailynote]\n---\n\n`;
        } else if (hasFrontmatter) {
            // Preserve template text exactly; update title via processFrontMatter after create.
            shouldWriteTitleViaFrontmatterApi = true;
        } else {
            content = `---\ntitle: ${titleValue}\ntags: [dailynote]\n---\n\n${content}`;
        }

        let created: TFile | null = null;
        try {
            created = await this.app.vault.create(path, content);
        } catch (err: any) {
            const msg = err instanceof Error ? err.message : String(err);
            if (typeof msg === 'string' && msg.toLowerCase().includes('already exists')) {
                const existing = this.app.vault.getAbstractFileByPath(path);
                if (existing instanceof TFile) {
                    created = existing;
                }
            }
            if (!created) throw err;
        }

        // Run Templater explicitly so <% tp.* %> expressions are evaluated.
        // This is safe to call even when Templater is not installed.
        await this.runTemplaterOnFile(created);

        if (shouldWriteTitleViaFrontmatterApi) {
            try {
                await this.plugin.frontmatterMutationService.process(created, (fm: any) => {
                    fm.title = titleValue;
                });
            } catch (error) {
                logger.warn("Failed setting daily note title via processFrontMatter", error);
            }
        }

        await this.normalizeCreatedDailyNote(created, titleValue, folder, dateStr);

        return created;
    }

    private async normalizeCreatedDailyNote(file: TFile, titleValue: string, folder: string, scheduledDateKey?: string): Promise<void> {
        const targetFolder = String(folder || file.parent?.path || '/').trim() || '/';
        const resolver = getDailyNoteResolver(this.app, {
            formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
        });
        const resolvedScheduledDateKey = scheduledDateKey
            || resolver.parseFilenameToDateKey(file.basename)
            || resolver.parseFilenameToDateKey(titleValue)
            || '';

        await this.normalizeLeadingWhitespaceBeforeFrontmatter(file);

        try {
            await this.plugin.frontmatterMutationService.process(file, (fm: any) => {
                fm.title = titleValue;
                const mergedTags = mergeNormalizedTags(fm.tags, "dailynote");
                setValueCaseInsensitive(fm, 'tags', mergedTags);
                if (this.plugin.settings.enableDailyNoteScheduledNormalization !== false) {
                    const existingScheduled = String((fm?.scheduled ?? fm?.Scheduled ?? '')).trim();
                    const existingScheduledMoment = existingScheduled ? window.moment(existingScheduled) : null;
                    const existingScheduledKey = existingScheduledMoment?.isValid()
                        ? existingScheduledMoment.format('YYYY-MM-DD')
                        : '';
                    const shouldNormalizeScheduled =
                        !!resolvedScheduledDateKey && (
                            !existingScheduled
                            || /<%[\s\S]*%>/.test(existingScheduled)
                            || /\{\{[\s\S]*\}\}/.test(existingScheduled)
                            || !existingScheduledMoment?.isValid?.()
                            || existingScheduledKey !== resolvedScheduledDateKey
                        );
                    if (shouldNormalizeScheduled) {
                        setValueCaseInsensitive(fm, 'scheduled', resolvedScheduledDateKey);
                    }
                }
                fm.folderPath = targetFolder;
            });
        } catch (error) {
            logger.warn('Failed normalizing created daily note frontmatter', { file: file.path, error });
        }

        try {
            await this.plugin.fileNamingService.processFileOnOpen(file, { bypassCreationGrace: true });
        } catch (error) {
            logger.warn('Failed running file naming normalization for created daily note', { file: file.path, error });
        }

        try {
            const companion = (this.app as any)?.plugins?.plugins?.['tps-notebook-navigator-companion'];
            await companion?.api?.applyRulesToFile?.(file);
        } catch (error) {
            logger.warn('Failed applying NN rules to created daily note', { file: file.path, error });
        }

        try {
            await this.plugin.frontmatterMutationService.process(file, (fm: any) => {
                const tags = Array.isArray(fm?.tags)
                    ? fm.tags.map((value: unknown) => String(value || '').trim().replace(/^#/, '').toLowerCase()).filter(Boolean)
                    : typeof fm?.tags === 'string'
                        ? fm.tags.split(/[\s,]+/).map((value: string) => value.trim().replace(/^#/, '').toLowerCase()).filter(Boolean)
                        : [];
                const status = String(fm?.status ?? '').trim().toLowerCase();
                if (tags.includes('dailynote') && status === 'note') {
                    delete fm.status;
                }
            });
        } catch (error) {
            logger.warn('Failed clearing unintended daily note status', { file: file.path, error });
        }
    }

    /**
     * Explicitly invoke Templater's "Replace templates in file" on a newly-created
     * file so <% tp.* %> expressions are evaluated in-place.
     * Safe no-op when Templater is not installed.
     *
     * Uses overwrite_file_commands(file, false) — same code path as "Replace templates
     * in the active file" but works on any file object without an active editor view.
     */
    private async runTemplaterOnFile(file: TFile): Promise<void> {
        const templater = (this.app as any)?.plugins?.plugins?.['templater-obsidian'];
        if (!templater?.templater) return;
        try {
            await templater.templater.overwrite_file_commands(file, false);
            await this.normalizeLeadingWhitespaceBeforeFrontmatter(file);
        } catch (e) {
            logger.warn('[NoteOperationService] Templater failed to process file (non-fatal):', file.path, e);
        }
    }

    private async normalizeLeadingWhitespaceBeforeFrontmatter(file: TFile): Promise<void> {
        let content = '';
        try {
            content = await this.app.vault.cachedRead(file);
        } catch {
            return;
        }

        if (!content) return;

        const normalized = content.replace(/\r\n/g, '\n');
        const bom = normalized.startsWith('\uFEFF') ? '\uFEFF' : '';
        const body = bom ? normalized.slice(1) : normalized;
        if (body.startsWith('---\n')) return;

        const trimmedLeading = body.replace(/^\s*/, '');
        const leadingOffset = body.length - trimmedLeading.length;
        if (leadingOffset <= 0 || !trimmedLeading.startsWith('---\n')) return;

        const prefix = body.slice(0, leadingOffset);
        if (/\S/.test(prefix)) return;

        const liveFile = this.app.vault.getAbstractFileByPath(file.path);
        if (!(liveFile instanceof TFile)) return;

        await this.app.vault.modify(liveFile, `${bom}${trimmedLeading}`);
    }

    private hasKeys(value: unknown): boolean {
        return !!value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0;
    }

    private cloneFrontmatterObject(frontmatter: Record<string, unknown>): Record<string, unknown> {
        const cloned: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(frontmatter || {})) {
            if (key === "position") continue;
            cloned[key] = value;
        }
        return cloned;
    }

    private extractYamlFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } | null {
        const normalized = String(raw || "").replace(/\r\n/g, "\n");
        if (!normalized.startsWith("---\n")) {
            return null;
        }

        const closingMarker = normalized.indexOf("\n---\n", 4);
        const closingMarkerAtEnd = normalized.endsWith("\n---") ? normalized.length - 4 : -1;
        const closingIndex = closingMarker >= 0 ? closingMarker : closingMarkerAtEnd;
        if (closingIndex < 0) {
            return null;
        }

        const yamlBlock = normalized.slice(4, closingIndex);
        const bodyStart = closingMarker >= 0 ? closingIndex + 5 : normalized.length;
        const body = normalized.slice(bodyStart);

        try {
            const parsed = parseYaml(yamlBlock);
            const frontmatter = this.cloneFrontmatterObject((parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>);
            return { frontmatter, body };
        } catch (err) {
            logger.warn("Failed to parse YAML frontmatter block", err);
            return { frontmatter: {}, body };
        }
    }

    private async ensureFolderPath(path: string): Promise<void> {
        const clean = normalizePath(path).trim();
        if (!clean) return;
        const segments = clean.split("/").filter(Boolean);
        let current = "";
        for (const segment of segments) {
            current = current ? `${current}/${segment}` : segment;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                await this.app.vault.createFolder(current);
            }
        }
    }

    private getArchiveTargetInfo(file: TFile, archiveFolder: string): { targetFolder: string; targetPath: string } {
        const mode = normalizeArchiveFolderMode(
            this.plugin.settings.archiveFolderMode ?? (this.plugin.settings.archiveUseDailyFolder ? "daily" : "none")
        );
        const archiveBucket = getArchiveBucketPath(archiveFolder, mode);
        const { targetFolder, targetPath } = resolveArchiveTargetInfo(
            file,
            archiveBucket,
            (path) => !!this.app.vault.getAbstractFileByPath(path),
        );
        return { targetFolder, targetPath };
    }

    private getEffectiveArchiveFolder(baseArchiveFolder: string): string {
        return getArchiveBucketPath(
            baseArchiveFolder,
            normalizeArchiveFolderMode(this.plugin.settings.archiveFolderMode ?? (this.plugin.settings.archiveUseDailyFolder ? "daily" : "none"))
        );
    }

    private flattenTagValues(value: unknown): string[] {
        if (typeof value === "string") {
            return value.split(",").map((entry) => entry.trim()).filter(Boolean);
        }
        if (Array.isArray(value)) {
            return value.flatMap((entry) => this.flattenTagValues(entry));
        }
        return [];
    }

    private fileHasArchiveTag(file: TFile, archiveTag: string): boolean {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const tags = this.flattenTagValues(frontmatter?.tags);
        return tags.some((tag) => {
            const normalized = normalizeTagValue(tag);
            return normalized === archiveTag || normalized.startsWith(`${archiveTag}/`);
        });
    }

    async sweepArchiveTaggedFiles(reason: "startup-catchup" | "scheduled" | "manual" = "manual"): Promise<{ archived: number; scanned: number }> {
        const archiveTag = normalizeTagValue(this.plugin.settings.archiveTag || "archive");
        const archiveRoot = this.plugin.getArchiveFolderPath();
        if (!archiveTag || !archiveRoot) {
            logger.warn("[TPS GCM] Archive sweep skipped: archive tag/folder settings are not configured");
            return { archived: 0, scanned: 0 };
        }

        const filesToArchive = this.app.vault.getMarkdownFiles().filter((file) => {
            if (file.path.startsWith(`${archiveRoot}/`)) return false;
            return this.fileHasArchiveTag(file, archiveTag);
        });

        if (filesToArchive.length === 0) {
            logger.log(`[TPS GCM] Archive sweep (${reason}) found no tagged files`);
            return { archived: 0, scanned: 0 };
        }

        const targetArchiveFolder = this.getEffectiveArchiveFolder(archiveRoot);
        await this.ensureFolderPath(targetArchiveFolder);

        let archived = 0;
        await this.plugin.runQueuedMove(filesToArchive, async () => {
            for (const file of filesToArchive) {
                const existing = this.app.vault.getAbstractFileByPath(file.path);
                const liveFile = existing instanceof TFile ? existing : file;
                if (liveFile.path.startsWith(`${archiveRoot}/`)) {
                    continue;
                }

                try {
                    if (liveFile.extension?.toLowerCase() === "md") {
                        try {
                            await this.plugin.frontmatterMutationService.process(liveFile, (frontmatter: any) => {
                                const originalFolder = liveFile.parent?.path ?? "";
                                if (!Array.isArray(frontmatter.activity)) {
                                    frontmatter.activity = [];
                                }
                                frontmatter.activity.push({
                                    type: "archive",
                                    folder: originalFolder,
                                    ts: Math.floor(Date.now() / 1000),
                                });
                            });
                        } catch (err) {
                            logger.error("[TPS GCM] Failed recording archive activity during sweep", liveFile.path, err);
                        }
                    }

                    const { targetFolder, targetPath } = this.getArchiveTargetInfo(liveFile, archiveRoot);
                    await this.ensureFolderPath(targetFolder);
                    await this.app.fileManager.renameFile(liveFile, targetPath);
                    archived += 1;
                } catch (err) {
                    logger.error("[TPS GCM] Failed moving archive-tagged file during sweep", liveFile.path, err);
                }
            }
        });

        logger.log(`[TPS GCM] Archive sweep (${reason}) moved ${archived}/${filesToArchive.length} file(s) to "${targetArchiveFolder}"`);
        return { archived, scanned: filesToArchive.length };
    }

    private async archiveSourceNotes(files: TFile[], excludePaths: Set<string> = new Set()): Promise<{ archived: number }> {
        const archiveTag = normalizeTagValue(this.plugin.settings.archiveTag || "archive");
        const archiveRoot = this.plugin.getArchiveFolderPath();
        if (!archiveTag || !archiveRoot) {
            logger.warn("[TPS GCM] Archive skipped: archive tag/folder settings are not configured");
            return { archived: 0 };
        }
        const archiveFolder = this.getEffectiveArchiveFolder(archiveRoot);

        await this.ensureFolderPath(archiveFolder);

        const byPath = new Map<string, TFile>();
        for (const file of files) {
            if (!(file instanceof TFile)) continue;
            byPath.set(file.path, file);
        }

        let archived = 0;
        await this.plugin.runQueuedMove(Array.from(byPath.values()), async () => {
            for (const [path, file] of byPath.entries()) {
                if (excludePaths.has(path)) {
                    continue;
                }

                const existing = this.app.vault.getAbstractFileByPath(path);
                const liveFile = existing instanceof TFile ? existing : file;
                if (excludePaths.has(liveFile.path)) {
                    continue;
                }

                if (liveFile.extension?.toLowerCase() === "md") {
                    try {
                        await this.plugin.frontmatterMutationService.process(liveFile, (frontmatter: any) => {
                            const mergedTags = mergeNormalizedTags(frontmatter.tags, archiveTag);
                            setValueCaseInsensitive(frontmatter, 'tags', mergedTags);
                            const originalFolder = liveFile.parent?.path ?? "";
                            if (!Array.isArray(frontmatter.activity)) {
                                frontmatter.activity = [];
                            }
                            frontmatter.activity.push({
                                type: "archive",
                                folder: originalFolder,
                                ts: Math.floor(Date.now() / 1000),
                            });
                        });
                    } catch (err) {
                        logger.error("[TPS GCM] Failed adding archive tag after add-to-note", liveFile.path, err);
                    }
                }

                if (liveFile.path.startsWith(`${archiveRoot}/`)) {
                    archived += 1;
                    continue;
                }

                try {
                    const { targetFolder, targetPath } = this.getArchiveTargetInfo(liveFile, archiveRoot);
                    await this.ensureFolderPath(targetFolder);
                    await this.app.fileManager.renameFile(liveFile, targetPath);
                    archived += 1;
                } catch (err) {
                    logger.error("[TPS GCM] Failed moving source note to archive", liveFile.path, err);
                }
            }
        });

        logger.log(`[NoteOperationService] Archive complete: ${archived}/${files.length} file(s) moved to "${archiveFolder}"`);
        return { archived };
    }
}

class DailyModeModal extends Modal {
    private resolved = false;
    private readonly onResolve: (value: 'created' | 'edited' | null) => void;

    constructor(app: App, onResolve: (value: 'created' | 'edited' | null) => void) {
        super(app);
        this.onResolve = onResolve;
    }

    onOpen(): void {
        this.modalEl.addClass('mod-tps-gcm');
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: 'Add To Daily Note By' });

        const desc = contentEl.createEl('p', {
            text: 'Choose which timestamp should map each note to a daily note.',
        });
        desc.style.marginBottom = '12px';

        const actions = contentEl.createDiv();
        actions.style.display = 'flex';
        actions.style.gap = '8px';

        const createdBtn = actions.createEl('button', { text: 'Created' });
        createdBtn.addClass('mod-cta');
        createdBtn.onclick = () => this.finish('created');

        const editedBtn = actions.createEl('button', { text: 'Edited' });
        editedBtn.onclick = () => this.finish('edited');
    }

    onClose(): void {
        this.contentEl.empty();
        if (!this.resolved) {
            this.onResolve(null);
        }
    }

    private finish(value: 'created' | 'edited'): void {
        this.resolved = true;
        this.onResolve(value);
        this.close();
    }
}
