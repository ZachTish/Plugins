import { Component, TFile, WorkspaceLeaf, setIcon, normalizePath, Notice } from "obsidian";
import TPSGlobalContextMenuPlugin from "./main";
import * as logger from "./logger";

export class DailyNoteNavManager extends Component {
    plugin: TPSGlobalContextMenuPlugin;
    currentNav: HTMLElement | null = null;
    private currentHost: HTMLElement | null = null;
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private _navAbortController: AbortController | null = null;

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

        if (!this.plugin.settings.enableDailyNoteNav) return;

        const leaf = this.plugin.app.workspace.getMostRecentLeaf();
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
        this.injectNav(leaf, date.format("YYYY-MM-DD"));
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
            nav.addClass("tps-daily-note-nav--title-floating");
            host.addClass("tps-daily-note-nav-anchor");
            host.appendChild(nav);
        } else {
            nav.addClass("tps-daily-note-nav--floating");
            host.appendChild(nav);
        }
        this.currentNav = nav;

        // Mark as always-interactive when rest opacity > 0
        if ((this.plugin.settings.dailyNavRestOpacity ?? 0) > 0) {
            nav.dataset.restVisible = "true";
        }

        // Left Arrow (Prev)
        const prevBtn = nav.createEl("button", { cls: "tps-daily-nav-btn" });
        prevBtn.type = "button";
        setIcon(prevBtn, "chevron-left");
        this.hardenNavControl(prevBtn);
        prevBtn.onclick = (e) => {
            this.suppressNavEvent(e);
            this.goToDate(isoDateStr, -1);
        };
        prevBtn.addEventListener("touchend", (e) => {
            this.suppressNavEvent(e);
            this.goToDate(isoDateStr, -1);
        }, { passive: false });

        // Today Button (optional)
        if (this.plugin.settings.dailyNavShowToday !== false) {
            const todayBtn = nav.createEl("button", {
                cls: "tps-daily-nav-today",
                text: "Today"
            });
            todayBtn.type = "button";
            this.hardenNavControl(todayBtn);
            todayBtn.onclick = (e) => {
                this.suppressNavEvent(e);
                this.goToDate(null, 0); // Go to actual today
            };
            todayBtn.addEventListener("touchend", (e) => {
                this.suppressNavEvent(e);
                this.goToDate(null, 0);
            }, { passive: false });
        }

        // Right Arrow (Next)
        const nextBtn = nav.createEl("button", { cls: "tps-daily-nav-btn" });
        nextBtn.type = "button";
        setIcon(nextBtn, "chevron-right");
        this.hardenNavControl(nextBtn);
        nextBtn.onclick = (e) => {
            this.suppressNavEvent(e);
            this.goToDate(isoDateStr, 1);
        };
        nextBtn.addEventListener("touchend", (e) => {
            this.suppressNavEvent(e);
            this.goToDate(isoDateStr, 1);
        }, { passive: false });

        if (titleAnchor) {
            this.positionNavNearTitle(nav, titleAnchor, host);
        }
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

    private positionNavNearTitle(nav: HTMLElement, inlineTitle: HTMLElement, host: HTMLElement): void {
        // Defer until after the browser has laid out the nav so navRect has real dimensions.
        requestAnimationFrame(() => {
            if (!nav.isConnected) return;
            const hostRect = host.getBoundingClientRect();
            const titleRect = inlineTitle.getBoundingClientRect();
            const navHeight = nav.offsetHeight || 32;

            const top = Math.max(8, (titleRect.top - hostRect.top) + Math.max(0, (titleRect.height - navHeight) / 2));
            nav.style.top = `${Math.round(top)}px`;
            nav.style.right = "12px";
            nav.style.left = "auto";
            nav.style.transform = "none";
        });
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
        if (existing instanceof TFile) return existing;

        // Prefer delegating to the core/periodic plugin so folder, template, and
        // Templater/Dataview hooks are all respected correctly.
        const coreFile = await this.createViaCorePlugin(targetDate);
        if (coreFile instanceof TFile) return coreFile;

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
            if (shouldWriteTitleViaFrontmatterApi) {
                try {
                    await this.plugin.app.fileManager.processFrontMatter(created, (fm) => {
                        fm.title = titleValue;
                    });
                } catch (error) {
                    logger.warn("Failed to set daily note title via processFrontMatter", error);
                }
            }
            return created;
        } catch (err) {
            logger.error("Failed creating daily note from template", normalizedPath, err);
            return null;
        }
    }

    async goToDate(baseIsoDateStr: string | null, offset: number) {
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
                await this.plugin.app.workspace.openLinkText(file.path, "", false);
            } else {
                new Notice(`Failed to open daily note: ${targetPath}`);
            }
        } catch (err) {
            logger.error("goToDate failed", err);
            new Notice("Failed to navigate to daily note.");
        }
    }
}
