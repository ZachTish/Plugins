import { Component, TFile, WorkspaceLeaf, setIcon, normalizePath, Notice } from "obsidian";
import TPSGlobalContextMenuPlugin from "../main";
import * as logger from "../logger";

export class DailyNoteNavManager extends Component {
    plugin: TPSGlobalContextMenuPlugin;
    currentNav: HTMLElement | null = null;
    private currentHost: HTMLElement | null = null;
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private _layoutRetryTimers: ReturnType<typeof setTimeout>[] = [];
    private _navAbortController: AbortController | null = null;
    private _currentLeaf: WorkspaceLeaf | null = null;

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        super();
        this.plugin = plugin;
    }

    onload() {
        this.registerEvent(
            this.plugin.app.workspace.on("active-leaf-change", () => this._scheduleRefresh())
        );
        this.registerEvent(
            this.plugin.app.workspace.on("file-open", () => this._scheduleRefresh())
        );
        this.registerEvent(
            this.plugin.app.workspace.on("layout-change", () => this._scheduleRefresh())
        );
        this.plugin.app.workspace.onLayoutReady(() => {
            for (const delay of [100, 500, 1200]) {
                const timer = setTimeout(() => {
                    this._layoutRetryTimers = this._layoutRetryTimers.filter((candidate) => candidate !== timer);
                    this._scheduleRefresh();
                }, delay);
                this._layoutRetryTimers.push(timer);
            }
        });
        // Initial refresh
        this.refresh();
    }

    /** Debounce rapid back-to-back events (active-leaf-change + file-open fire together). */
    private _scheduleRefresh() {
        if (this._refreshTimer !== null) clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            this.refresh();
        }, 30);
    }

    onunload() {
        if (this._refreshTimer !== null) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        for (const timer of this._layoutRetryTimers) clearTimeout(timer);
        this._layoutRetryTimers = [];
        this._navAbortController?.abort();
        this._navAbortController = null;
    }

    getDailyNoteSettings() {
        try {
            // 1. Try Periodic Notes plugin (community plugin)
            // @ts-ignore
            const periodicNotes = this.plugin.app.plugins.getPlugin("periodic-notes");
            if (periodicNotes && periodicNotes.settings?.daily) {
                return {
                    format: periodicNotes.settings.daily.format || "YYYY-MM-DD",
                    folder: periodicNotes.settings.daily.folder || "",
                    template: periodicNotes.settings.daily.template || ""
                };
            }

            // 2. Try Core Daily Notes plugin (internal plugin)
            // @ts-ignore - internal API
            const internalPlugins = (this.plugin.app as any).internalPlugins;
            const dailyNotes = internalPlugins.getPluginById("daily-notes");
            if (dailyNotes && dailyNotes.instance && dailyNotes.instance.options) {
                return {
                    format: dailyNotes.instance.options.format || "YYYY-MM-DD",
                    folder: dailyNotes.instance.options.folder || "",
                    template: dailyNotes.instance.options.template || ""
                };
            }
        } catch (e) {
            logger.error("Failed to load daily note settings", e);
        }
        return { format: "YYYY-MM-DD", folder: "", template: "" };
    }

    refresh() {
        // Abort listeners on the previous nav and remove it
        this._navAbortController?.abort();
        this._navAbortController = null;
        if (this.currentNav) {
            this.currentNav.remove();
            this.currentNav = null;
        }
        if (this.currentHost) {
            this.currentHost.removeClass("tps-daily-note-nav-host");
            this.currentHost.removeClass("tps-daily-note-nav-anchor");
            this.currentHost.style.removeProperty("--tps-daily-nav-reserved-width");
        }
        this.currentHost = null;
        this._currentLeaf = null;

        if (!this.plugin.settings.enableDailyNoteNav) return;

        const leaf = this.getTargetLeaf();
        if (!leaf || !leaf.view) return;

        // Check if it's a markdown view
        if (leaf.getViewState().type !== "markdown") return;

        const file = (leaf.view as any).file;
        if (!(file instanceof TFile)) return;

        const { format } = this.getDailyNoteSettings();
        const m = (window as any).moment;

        // Strict folder check was causing issues if user moved files or had mixed settings.
        // Let's rely primarily on the date format matching the filename.
        // We still fetch 'folder' for goToDate, but for *detection*, matching the format is usually enough context
        // combined with the fact that it's a valid date.

        // Check format
        const date = m(file.basename, format, true);
        if (!date.isValid()) return;

        // It's a daily note! Inject the UI.
        this._currentLeaf = leaf;
        this.injectNav(leaf, date.format("YYYY-MM-DD"));
    }

    private getTargetLeaf(): WorkspaceLeaf | null {
        const activeLeaf = this.plugin.app.workspace.activeLeaf;
        if (activeLeaf?.getViewState().type === "markdown") {
            return activeLeaf;
        }

        const activeMarkdownLeaf = this.plugin.app.workspace.getLeavesOfType("markdown")
            .find((candidate) => candidate === this.plugin.app.workspace.activeLeaf);
        if (activeMarkdownLeaf) return activeMarkdownLeaf;

        return null;
    }

    injectNav(leaf: WorkspaceLeaf, isoDateStr: string) {
        const view = leaf.view as any;
        const container = view?.contentEl as HTMLElement | undefined;
        if (!container) return;

        // Fresh AbortController for this nav's event listeners
        this._navAbortController = new AbortController();

        // Prefer placing the controls beside the actual note title row (inline title or first H1).
        const titleAnchor = this.resolveTitleAnchor(leaf);
        const host = container;
        this.currentHost = host;

        // Create the nav element
        const nav = document.createElement("div");
        nav.className = "tps-daily-note-nav";
        this.hardenNavControl(nav);
        if (titleAnchor) {
            nav.addClass("tps-daily-note-nav--under-title");
            host.addClass("tps-daily-note-nav-anchor");
            titleAnchor.insertAdjacentElement("beforebegin", nav);
        } else {
            nav.addClass("tps-daily-note-nav--floating");
            host.appendChild(nav);
        }
        this.currentNav = nav;

        // Mark as always-interactive when rest opacity > 0
        if ((this.plugin.settings.dailyNavRestOpacity ?? 0) > 0) {
            nav.dataset.restVisible = "true";
        }

        const m = (window as any).moment;
        const activeDate = m(isoDateStr, "YYYY-MM-DD");
        const weekStart = activeDate.clone().isoWeekday(1);

        const timeline = nav.createDiv({ cls: "tps-daily-nav-timeline" });
        this.hardenNavControl(timeline);
        for (let offset = 0; offset < 7; offset++) {
            const day = weekStart.clone().add(offset, "days");
            const dayIso = day.format("YYYY-MM-DD");
            const dayBtn = timeline.createEl("button", {
                cls: "tps-daily-nav-day",
                text: day.format("ddd D")
            });
            dayBtn.type = "button";
            dayBtn.toggleClass("is-active", dayIso === isoDateStr);
            dayBtn.setAttribute("aria-label", `Open ${day.format("dddd, MMMM D, YYYY")}`);
            dayBtn.setAttribute("aria-current", dayIso === isoDateStr ? "date" : "false");
            this.hardenNavControl(dayBtn);
            dayBtn.onclick = (e) => {
                this.suppressNavEvent(e);
                this.goToDate(dayIso, 0, leaf);
            };
            dayBtn.addEventListener("touchend", (e) => {
                this.suppressNavEvent(e);
                this.goToDate(dayIso, 0, leaf);
            }, { passive: false });
        }

        const controls = nav.createDiv({ cls: "tps-daily-nav-controls" });
        this.hardenNavControl(controls);

        // Left Arrow (Prev)
        const prevBtn = controls.createEl("button", { cls: "tps-daily-nav-btn" });
        prevBtn.type = "button";
        setIcon(prevBtn, "chevron-left");
        this.hardenNavControl(prevBtn);
        prevBtn.onclick = (e) => {
            this.suppressNavEvent(e);
            this.goToDate(isoDateStr, -1, leaf);
        };
        prevBtn.addEventListener("touchend", (e) => {
            this.suppressNavEvent(e);
            this.goToDate(isoDateStr, -1, leaf);
        }, { passive: false });

        // Today Button (optional)
        if (this.plugin.settings.dailyNavShowToday !== false) {
            const todayBtn = controls.createEl("button", {
                cls: "tps-daily-nav-today",
                text: "Today"
            });
            todayBtn.type = "button";
            this.hardenNavControl(todayBtn);
            todayBtn.onclick = (e) => {
                this.suppressNavEvent(e);
                this.goToDate(null, 0, leaf); // Go to actual today
            };
            todayBtn.addEventListener("touchend", (e) => {
                this.suppressNavEvent(e);
                this.goToDate(null, 0, leaf);
            }, { passive: false });
        }

        // Right Arrow (Next)
        const nextBtn = controls.createEl("button", { cls: "tps-daily-nav-btn" });
        nextBtn.type = "button";
        setIcon(nextBtn, "chevron-right");
        this.hardenNavControl(nextBtn);
        nextBtn.onclick = (e) => {
            this.suppressNavEvent(e);
            this.goToDate(isoDateStr, 1, leaf);
        };
        nextBtn.addEventListener("touchend", (e) => {
            this.suppressNavEvent(e);
            this.goToDate(isoDateStr, 1, leaf);
        }, { passive: false });
    }

    private resolveTitleAnchor(leaf: WorkspaceLeaf): HTMLElement | null {
        const view = leaf.view as any;
        const container = view?.contentEl as HTMLElement | undefined;
        const root = view?.containerEl as HTMLElement | undefined;
        const file = view?.file as TFile | undefined;
        if (!container) return null;

        const scopedRoot = root ?? container;
        const expectedTitleValues = new Set<string>();
        const normalizeForCompare = (value: string): string => String(value || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '')
            .trim();
        if (file?.basename) expectedTitleValues.add(normalizeForCompare(file.basename));
        if (file) {
            const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, any> | undefined;
            const fmTitle = typeof fm?.title === "string" ? fm.title.trim() : "";
            if (fmTitle) expectedTitleValues.add(normalizeForCompare(fmTitle));
        }
        const matchesExpectedTitle = (el: HTMLElement | null): boolean => {
            if (!el) return false;
            if (expectedTitleValues.size === 0) return true;
            const text = normalizeForCompare(el.textContent || "");
            return !!text && expectedTitleValues.has(text);
        };

        const inlineTitles = Array.from(scopedRoot.querySelectorAll<HTMLElement>(".inline-title"));
        const previewH1Candidates = Array.from(
            scopedRoot.querySelectorAll<HTMLElement>(
                ".markdown-preview-view .markdown-preview-sizer > h1, .markdown-reading-view .markdown-preview-sizer > h1, .markdown-preview-view h1"
            )
        );
        const titleCandidates = [...inlineTitles, ...previewH1Candidates]
            .filter((el) => {
                const text = String(el.textContent || '').trim().toLowerCase();
                return text.length > 0 && !text.includes('subitems');
            })
            .sort((a, b) => {
                const pos = a.compareDocumentPosition(b);
                return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
            });

        const matchedCandidate = titleCandidates.find((el) => matchesExpectedTitle(el));
        if (matchedCandidate) return matchedCandidate;
        if (titleCandidates.length > 0) return titleCandidates[0];

        const sourceHeading =
            scopedRoot.querySelector<HTMLElement>(".markdown-source-view .cm-line.HyperMD-header-1") ||
            scopedRoot.querySelector<HTMLElement>(".markdown-source-view .cm-header-1");
        if (sourceHeading) {
            return sourceHeading.classList.contains("cm-line")
                ? sourceHeading
                : (sourceHeading.closest<HTMLElement>(".cm-line") || sourceHeading);
        }

        return null;
    }

    private suppressNavEvent(event: Event): void {
        event.preventDefault();
        event.stopPropagation();
        if (typeof (event as any).stopImmediatePropagation === "function") {
            (event as any).stopImmediatePropagation();
        }
    }

    private hardenNavControl(el: HTMLElement): void {
        el.setAttribute("contenteditable", "false");
        el.setAttribute("spellcheck", "false");
        el.setAttribute("draggable", "false");
        el.tabIndex = -1;
        el.addClass("tps-daily-note-nav-control");

        const signal = this._navAbortController?.signal;
        const suppressPointerDown = (event: Event) => this.suppressNavEvent(event);
        el.addEventListener("pointerdown", suppressPointerDown, { capture: true, signal });
        el.addEventListener("mousedown", suppressPointerDown, { capture: true, signal });
        el.addEventListener("touchstart", suppressPointerDown, { capture: true, passive: false, signal } as any);
    }

    private async ensureFolderPath(path: string): Promise<void> {
        const clean = normalizePath(path).trim();
        if (!clean) return;
        const parts = clean.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.plugin.app.vault.getAbstractFileByPath(current)) {
                await this.plugin.app.vault.createFolder(current);
            }
        }
    }

    private async createViaCorePlugin(targetDate: any): Promise<TFile | null> {
        try {
            // Try core Daily Notes internal plugin first
            const internalPlugins = (this.plugin.app as any).internalPlugins;
            const dailyNotes = internalPlugins?.getPluginById("daily-notes");
            if (dailyNotes?.instance?.createNote) {
                const file = await dailyNotes.instance.createNote(targetDate);
                if (file instanceof TFile) return file;
            }

            // Try Periodic Notes community plugin
            // @ts-ignore
            const periodicNotes = this.plugin.app.plugins.getPlugin("periodic-notes");
            if (periodicNotes?.createDailyNote) {
                const file = await periodicNotes.createDailyNote(targetDate);
                if (file instanceof TFile) return file;
            }
        } catch (err) {
            logger.warn("Core plugin daily note creation failed, falling back to manual", err);
        }
        return null;
    }

    private async ensureDailyNoteExists(targetPath: string, titleValue: string, targetDate: any): Promise<TFile | null> {
        const normalizedPath = normalizePath(targetPath);
        const existing = this.plugin.app.vault.getAbstractFileByPath(normalizedPath);
        if (existing instanceof TFile) {
            const slash = normalizedPath.lastIndexOf("/");
            const folder = slash >= 0 ? normalizedPath.substring(0, slash) : "";
            await this.normalizeCreatedDailyNote(existing, titleValue, folder);
            return existing;
        }

        // Prefer delegating to the core/periodic plugin so folder, template, and
        // Templater/Dataview hooks are all respected correctly.
        const coreFile = await this.createViaCorePlugin(targetDate);
        if (coreFile instanceof TFile) {
            const slash = normalizedPath.lastIndexOf("/");
            const folder = slash >= 0 ? normalizedPath.substring(0, slash) : "";
            await this.normalizeCreatedDailyNote(coreFile, titleValue, folder);
            return coreFile;
        }

        // Fallback: manual creation
        const slash = normalizedPath.lastIndexOf("/");
        const folder = slash >= 0 ? normalizedPath.substring(0, slash) : "";
        if (folder) {
            await this.ensureFolderPath(folder);
        }

        const { template } = this.getDailyNoteSettings();
        let content = "";
        let hasFrontmatter = false;
        let shouldWriteTitleViaFrontmatterApi = false;
        const adapter = this.plugin.app.vault.adapter as any;

        try {
            // Core plugin stores template path without .md extension — resolve both forms
            let templatePath = normalizePath(template || "");
            if (templatePath) {
                const withMd = templatePath.endsWith(".md") ? templatePath : templatePath + ".md";
                const resolvedPath = (await adapter.exists(withMd)) ? withMd
                    : (await adapter.exists(templatePath)) ? templatePath
                    : null;
                if (resolvedPath) {
                    content = await adapter.read(resolvedPath);
                    hasFrontmatter = content.trimStart().startsWith("---");
                }
            }
        } catch (err) {
            logger.warn("Failed reading daily note template", err);
        }

        if (!content) {
            content = `---\ntitle: ${titleValue}\ntags: [dailynote]\n---\n\n`;
        } else if (hasFrontmatter) {
            // Preserve template text exactly; update title via processFrontMatter after create.
            shouldWriteTitleViaFrontmatterApi = true;
        } else {
            content = `---\ntitle: ${titleValue}\ntags: [dailynote]\n---\n\n${content}`;
        }

        try {
            const created = await this.plugin.app.vault.create(normalizedPath, content);

            // Run Templater explicitly so <% tp.* %> expressions in the template are evaluated.
            await this.runTemplaterOnFile(created);

            if (shouldWriteTitleViaFrontmatterApi) {
                try {
                    await this.plugin.app.fileManager.processFrontMatter(created, (fm) => {
                        fm.title = titleValue;
                    });
                } catch (error) {
                    logger.warn("Failed to set daily note title via processFrontMatter", error);
                }
            }
            await this.normalizeCreatedDailyNote(created, titleValue, folder);
            return created;
        } catch (err) {
            logger.error("Failed creating daily note from template", normalizedPath, err);
            return null;
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
        const templater = (this.plugin.app as any)?.plugins?.plugins?.['templater-obsidian'];
        if (!templater?.templater) return;
        try {
            await templater.templater.overwrite_file_commands(file, false);
            await this.normalizeLeadingWhitespaceBeforeFrontmatter(file);
        } catch (e) {
            logger.warn('[DailyNoteNavManager] Templater failed to process file (non-fatal):', file.path, e);
        }
    }

    private async normalizeCreatedDailyNote(file: TFile, titleValue: string, folder: string): Promise<void> {
        const targetFolder = String(folder || file.parent?.path || '/').trim() || '/';

        await this.normalizeLeadingWhitespaceBeforeFrontmatter(file);

        try {
            await this.plugin.app.fileManager.processFrontMatter(file, (fm: any) => {
                fm.title = titleValue;
                const scheduled = String(fm?.scheduled ?? '').trim();
                if (!scheduled || /<%[\s\S]*%>/.test(scheduled) || /\{\{[\s\S]*\}\}/.test(scheduled)) {
                    fm.scheduled = titleValue;
                }
                fm.folderPath = targetFolder;
            });
        } catch (error) {
            logger.warn('Failed normalizing daily note after creation', { file: file.path, error });
        }

        try {
            await this.plugin.fileNamingService.processFileOnOpen(file, { bypassCreationGrace: true });
        } catch (error) {
            logger.warn('Failed running file naming normalization for daily note', { file: file.path, error });
        }

        try {
            const companion = (this.plugin.app as any)?.plugins?.plugins?.['tps-notebook-navigator-companion'];
            await companion?.api?.applyRulesToFile?.(file);
        } catch (error) {
            logger.warn('Failed applying NN rules to daily note', { file: file.path, error });
        }
    }

    private async normalizeLeadingWhitespaceBeforeFrontmatter(file: TFile): Promise<void> {
        let content = '';
        try {
            content = await this.plugin.app.vault.cachedRead(file);
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

        const liveFile = this.plugin.app.vault.getAbstractFileByPath(file.path);
        if (!(liveFile instanceof TFile)) return;

        await this.plugin.app.vault.modify(liveFile, `${bom}${trimmedLeading}`);
    }

    async goToDate(baseIsoDateStr: string | null, offset: number, sourceLeaf?: WorkspaceLeaf | null) {
        try {
            const m = (window as any).moment;
            const targetDate = baseIsoDateStr === null
                ? m().startOf("day")
                : m(baseIsoDateStr, "YYYY-MM-DD").add(offset, "days");

            const { format, folder } = this.getDailyNoteSettings();
            const targetFilename = targetDate.format(format);

            // 1. Construct the canonical path
            let targetPath = folder ? `${folder}/${targetFilename}` : targetFilename;
            if (!targetPath.endsWith(".md")) targetPath += ".md";
            targetPath = normalizePath(targetPath);

            // 2. Exact vault path lookup (correct API — avoids cross-folder collisions)
            let file: TFile | null =
                (this.plugin.app.vault.getAbstractFileByPath(targetPath) as TFile | null) ?? null;

            // 3. Fallback: search by filename only (handles files moved out of configured folder)
            if (!(file instanceof TFile)) {
                const justName = targetFilename + ".md";
                const found = this.plugin.app.metadataCache.getFirstLinkpathDest(justName, folder || "");
                file = found instanceof TFile ? found : null;
            }

            if (!(file instanceof TFile)) {
                file = await this.ensureDailyNoteExists(targetPath, targetFilename, targetDate);
            }

            if (file instanceof TFile) {
                const targetLeaf = sourceLeaf ?? this.getTargetLeaf() ?? this._currentLeaf;
                if (targetLeaf) {
                    try {
                        await targetLeaf.openFile(file, { active: true } as any);
                        return;
                    } catch (error) {
                        logger.warn("[DailyNoteNavManager] Failed to open daily note in source leaf, falling back", error);
                    }
                }
                {
                    const leaf = this.plugin.app.workspace.getLeaf(false);
                    if (!leaf) return;
                    await leaf.openFile(file, { active: true } as any);
                }
            } else {
                new Notice(`Failed to open daily note: ${targetPath}`);
            }
        } catch (err) {
            logger.error("goToDate failed", err);
            new Notice("Failed to navigate to daily note.");
        }
    }
}
