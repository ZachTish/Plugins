import { App, TFile, Notice, FuzzySuggestModal, Modal, parseYaml, stringifyYaml, normalizePath } from "obsidian";
import TPSGlobalContextMenuPlugin from "./main";
import * as logger from "./logger";
import { mergeNormalizedTags, normalizeTagValue } from "./tag-utils";

export class NoteOperationService {
    app: App;
    plugin: TPSGlobalContextMenuPlugin;

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        this.plugin = plugin;
        this.app = plugin.app;
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
            const spacer = existing.endsWith("\n") ? "\n" : "\n\n";
            await this.app.vault.modify(picker, `${existing}${spacer}${sections.join("\n")}`);

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
                    const spacer = existing.endsWith("\n") ? "\n" : "\n\n";
                    await this.app.vault.modify(
                        daily,
                        `${existing}${spacer}${items.map((item) => item.section).join("\n")}`,
                    );
                    for (const item of items) {
                        appendedSourcePaths.add(item.source.path);
                    }
                } catch (err) {
                    logger.error("Failed to append to daily note", date, err);
                }
            }

            if (appendedSourcePaths.size === 0) {
                new Notice("Unable to append notes to daily notes");
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
        // Read from Core Daily Notes plugin settings
        let folder = "System/Dailynotes";
        let templatePath = "System/Dailynotes/Daily Note Template.md";

        try {
            const dailyNotesPlugin = (this.app as any).internalPlugins?.plugins?.["daily-notes"];
            if (dailyNotesPlugin?.enabled && dailyNotesPlugin?.instance?.options) {
                const opts = dailyNotesPlugin.instance.options;
                if (opts.folder) folder = opts.folder;
                if (opts.template) templatePath = opts.template;
                if (!templatePath.endsWith(".md")) templatePath += ".md";
            }
        } catch (err) {
            logger.warn("Failed to read core Daily Notes settings", err);
        }

        const path = normalizePath(`${folder}/${dateStr}.md`);
        const adapter = this.app.vault.adapter;

        if (await adapter.exists(path)) {
            const existing = this.app.vault.getAbstractFileByPath(path);
            if (existing instanceof TFile) return existing;
            return null;
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
            content = `---\ntitle: ${dateStr}\ntags: [dailynote]\n---\n\n`;
        } else if (hasFrontmatter) {
            // Preserve template text exactly; update title via processFrontMatter after create.
            shouldWriteTitleViaFrontmatterApi = true;
        } else {
            content = `---\ntitle: ${dateStr}\ntags: [dailynote]\n---\n\n${content}`;
        }

        const created = await this.app.vault.create(path, content);
        if (shouldWriteTitleViaFrontmatterApi) {
            try {
                await this.app.fileManager.processFrontMatter(created, (fm: any) => {
                    fm.title = dateStr;
                });
            } catch (error) {
                logger.warn("Failed setting daily note title via processFrontMatter", error);
            }
        }

        return created;
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

    private getUniqueArchiveTargetPath(file: TFile, archiveFolder: string): string {
        const targetBase = normalizePath(`${archiveFolder}/${file.name}`);
        let targetPath = targetBase;
        let counter = 1;
        while (this.app.vault.getAbstractFileByPath(targetPath)) {
            targetPath = normalizePath(`${archiveFolder}/${file.basename} ${counter}.${file.extension}`);
            counter += 1;
        }
        return targetPath;
    }

    private async archiveSourceNotes(files: TFile[], excludePaths: Set<string> = new Set()): Promise<{ archived: number }> {
        const archiveTag = normalizeTagValue(this.plugin.settings.archiveTag || "archive");
        const archiveFolder = this.plugin.getArchiveFolderPath();
        if (!archiveTag || !archiveFolder) {
            logger.warn("[TPS GCM] Archive skipped: archive tag/folder settings are not configured");
            return { archived: 0 };
        }

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
                        await this.app.fileManager.processFrontMatter(liveFile, (frontmatter: any) => {
                            frontmatter.tags = mergeNormalizedTags(frontmatter.tags, archiveTag);
                        });
                    } catch (err) {
                        logger.error("[TPS GCM] Failed adding archive tag after add-to-note", liveFile.path, err);
                    }
                }

                if (liveFile.path.startsWith(`${archiveFolder}/`)) {
                    archived += 1;
                    continue;
                }

                try {
                    const targetPath = this.getUniqueArchiveTargetPath(liveFile, archiveFolder);
                    await this.app.fileManager.renameFile(liveFile, targetPath);
                    archived += 1;
                } catch (err) {
                    logger.error("[TPS GCM] Failed moving source note to archive", liveFile.path, err);
                }
            }
        });

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
