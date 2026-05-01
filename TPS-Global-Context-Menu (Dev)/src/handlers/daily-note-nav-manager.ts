import { Component, MarkdownView, Platform, TFile, WorkspaceLeaf, setIcon, normalizePath, Notice } from "obsidian";
import TPSGlobalContextMenuPlugin from "../main";
import * as logger from "../logger";
import { mergeNormalizedTags } from "../utils/tag-utils";
import { setValueCaseInsensitive } from "../core/record-utils";
import { getDailyNoteResolver } from "../../../TPS-Controller (Dev)/src/utils/daily-note-resolver";
import { ensureDailyNoteFile } from "../../../TPS-Controller (Dev)/src/utils/daily-note-create";

export class DailyNoteNavManager extends Component {
    plugin: TPSGlobalContextMenuPlugin;
    currentNav: HTMLElement | null = null;
    private currentHost: HTMLElement | null = null;
    private currentReplacedHeaderEl: HTMLElement | null = null;
    private currentHiddenHeaderEls: HTMLElement[] = [];
    private currentHeaderWrapper: HTMLElement | null = null;
    private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private _navAbortController: AbortController | null = null;
    private _currentLeaf: WorkspaceLeaf | null = null;
    private _displayedIsoDate: string | null = null;
    private _queuedTargetIsoDate: string | null = null;
    private _navInFlight = false;
    private _queuedSourceLeaf: WorkspaceLeaf | null = null;
    private _mobileScrollHideState: { targets: HTMLElement[]; listener: (evt: Event) => void; lastTop: number; accum: number } | null = null;
    private clearCurrentNavState() {
        this._navAbortController?.abort();
        this._navAbortController = null;
        this.detachMobileScrollHideTracking();
        if (this.currentNav) {
            this.currentNav.remove();
            this.currentNav = null;
        }
        if (this.currentHeaderWrapper) {
            this.currentHeaderWrapper.remove();
            this.currentHeaderWrapper = null;
        }
        if (this.currentHost) {
            this.currentHost.removeClass("tps-daily-note-nav-host");
            this.currentHost.removeClass("tps-daily-note-nav-anchor");
            this.currentHost.style.removeProperty("--tps-daily-nav-reserved-width");
        }
        if (this.currentReplacedHeaderEl) {
            this.currentReplacedHeaderEl.style.removeProperty("display");
            this.currentReplacedHeaderEl = null;
        }
        for (const el of this.currentHiddenHeaderEls) {
            el.style.removeProperty("display");
        }
        this.currentHiddenHeaderEls = [];
        this.currentHost = null;
    }

    private isCurrentNavStillValid(leaf: WorkspaceLeaf, isoDateStr: string): boolean {
        if (!this.currentNav?.isConnected) return false;
        if (this._currentLeaf !== leaf) return false;
        if (this._displayedIsoDate !== isoDateStr) return false;

        const modeClass = this.currentNav.classList;
        if (modeClass.contains("tps-daily-note-nav--header-dates")) {
            return !!this.currentHeaderWrapper?.isConnected;
        }
        if (modeClass.contains("tps-daily-note-nav--under-title")) {
            const titleAnchor = this.resolveTitleAnchor(leaf);
            return !!titleAnchor?.isConnected && this.currentNav.previousElementSibling === titleAnchor;
        }
        if (modeClass.contains("tps-daily-note-nav--floating")) {
            const container = (leaf.view as any)?.contentEl as HTMLElement | undefined;
            return !!container?.contains(this.currentNav);
        }
        return false;
    }

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        super();
        this.plugin = plugin;
    }

    private normalizeDailyNoteStatusFrontmatter(fm: any): void {
        const tags = Array.isArray(fm?.tags)
            ? fm.tags.map((value: unknown) => String(value || '').trim().replace(/^#/, '').toLowerCase()).filter(Boolean)
            : typeof fm?.tags === 'string'
                ? fm.tags.split(/[\s,]+/).map((value: string) => value.trim().replace(/^#/, '').toLowerCase()).filter(Boolean)
                : [];
        const status = String(fm?.status ?? '').trim().toLowerCase();
        if (tags.includes('dailynote') && status === 'note') {
            delete fm.status;
        }
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
            this._scheduleRefresh();
            setTimeout(() => this._scheduleRefresh(), 500);
        });
    }

    /** Debounce rapid back-to-back events (active-leaf-change + file-open fire together). */
    private _scheduleRefresh() {
        if (this._refreshTimer !== null) clearTimeout(this._refreshTimer);
        const delay = this._navInFlight ? 120 : 30;
        this._refreshTimer = setTimeout(() => {
            this._refreshTimer = null;
            if (this._navInFlight && this._queuedTargetIsoDate) {
                return;
            }
            this.refresh();
        }, delay);
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
        const resolver = getDailyNoteResolver(this.plugin.app, {
            formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
        });
        return {
            format: resolver.displayFormat,
            folder: resolver.folder,
            template: resolver.template,
        };
    }

    refresh() {
        if (!this.plugin.settings.enableDailyNoteNav) return;

        const leaf = this.getTargetLeaf();
        if (!leaf || !leaf.view) {
            this.clearCurrentNavState();
            this._currentLeaf = null;
            return;
        }

        // Check if it's a markdown view
        if (leaf.getViewState().type !== "markdown") {
            this.clearCurrentNavState();
            this._currentLeaf = null;
            return;
        }

        const file = (leaf.view as any).file;
        if (!(file instanceof TFile)) {
            this.clearCurrentNavState();
            this._currentLeaf = null;
            return;
        }

        const resolver = getDailyNoteResolver(this.plugin.app, {
            formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
        });
        const dateKey = resolver.parseFilenameToDateKey(file.basename);
        if (!dateKey) {
            this.clearCurrentNavState();
            this._currentLeaf = null;
            return;
        }

        if (this.isCurrentNavStillValid(leaf, dateKey)) {
            return;
        }

        this.clearCurrentNavState();

        // It's a daily note! Inject the UI.
        this._currentLeaf = leaf;
        this._queuedSourceLeaf = null;
        this._displayedIsoDate = dateKey;
        this.injectNav(leaf, dateKey);
    }

    private getTargetLeaf(): WorkspaceLeaf | null {
        const activeLeaf = this.plugin.app.workspace.activeLeaf;
        if (activeLeaf?.getViewState().type === "markdown" && !this.isSidebarLeaf(activeLeaf)) {
            return activeLeaf;
        }

        const activeMarkdownLeaf = this.plugin.app.workspace.getLeavesOfType("markdown")
            .find((candidate) => candidate === this.plugin.app.workspace.activeLeaf && !this.isSidebarLeaf(candidate));
        if (activeMarkdownLeaf) return activeMarkdownLeaf;

        const contentMarkdownLeaf = this.plugin.app.workspace.getLeavesOfType("markdown")
            .find((candidate) => !this.isSidebarLeaf(candidate));
        if (contentMarkdownLeaf) return contentMarkdownLeaf;

        return null;
    }

    private isSidebarLeaf(leaf: WorkspaceLeaf | null | undefined): boolean {
        const container = (leaf as any)?.containerEl as HTMLElement | undefined;
        if (!container) return false;
        return !!container.closest('.workspace-sidedock, .workspace-split.mod-left-split, .workspace-split.mod-right-split');
    }

    injectNav(leaf: WorkspaceLeaf, isoDateStr: string) {
        const view = leaf.view as any;
        const container = view?.contentEl as HTMLElement | undefined;
        if (!container) return;
        const m = (window as any).moment;
        const viewedDate = m(isoDateStr, "YYYY-MM-DD").startOf("day");
        const anchorDate = viewedDate.clone();
        if (!anchorDate?.isValid?.()) return;

        this.clearCurrentNavState();

        // Fresh AbortController for this nav's event listeners
        this._navAbortController = new AbortController();

        // On mobile we avoid the header/title area entirely. The title row is too
        // cramped and often clipped, so we render a floating bottom bar instead.
        const isMobile = Platform.isMobile;

        // Prefer placing the controls beside the actual note title row (inline title or first H1)
        // on desktop. Mobile always uses the floating layout.
        const headerAnchor = this.resolveHeaderBreadcrumbAnchor(leaf);
        const titleAnchor = this.resolveTitleAnchor(leaf);
        const host = container;
        this.currentHost = host;

        // Mark as always-interactive when rest opacity > 0
        const restVisible = (this.plugin.settings.dailyNavRestOpacity ?? 0) > 0;

        // Build the dates row and controls row as shared helpers so both
        // header-mode and fallback-mode can reuse them.
        const buildDatesGroup = (parent: HTMLElement) => {
            const datesGroup = parent.createDiv({ cls: "tps-daily-note-nav__dates-group" });
            for (let offset = -3; offset <= 3; offset += 1) {
                const day = anchorDate.clone().add(offset, "days");
                const dayIso = day.format("YYYY-MM-DD");
                const dayBtn = datesGroup.createEl("a", { cls: "daily-note-navbar__date tps-daily-note-nav__link", href: "#" });
                dayBtn.addClass(`tps-daily-note-nav__offset-${offset}`.replace(/--/g, "-neg-"));
                this.hardenNavControl(dayBtn);
                if (offset === 0) {
                    dayBtn.addClass("daily-note-navbar__active");
                }
                if (dayIso === m().startOf("day").format("YYYY-MM-DD")) {
                    dayBtn.addClass("daily-note-navbar__current");
                }
                dayBtn.setText(`${day.format("ddd")} ${day.format("D")}`);
                dayBtn.onclick = (e) => {
                    this.suppressNavEvent(e);
                    if (offset === 0) return;
                    this.goToDate(dayIso, 0, leaf);
                };
                dayBtn.addEventListener("touchend", (e) => {
                    this.suppressNavEvent(e);
                    if (offset === 0) return;
                    this.goToDate(dayIso, 0, leaf);
                }, { passive: false });
            }
        };

        const buildControlsRow = (parent: HTMLElement) => {
            const todayIso = m().startOf("day").format("YYYY-MM-DD");
            const isViewingToday = viewedDate.format("YYYY-MM-DD") === todayIso;

            const prevBtn = parent.createEl("a", { cls: "tps-daily-nav-btn daily-note-navbar__change-week", href: "#" });
            setIcon(prevBtn, "left-arrow");
            this.hardenNavControl(prevBtn);
            prevBtn.onclick = (e) => {
                this.suppressNavEvent(e);
                this.goToDate(viewedDate.format("YYYY-MM-DD"), -1, leaf);
            };
            prevBtn.addEventListener("touchend", (e) => {
                this.suppressNavEvent(e);
                this.goToDate(viewedDate.format("YYYY-MM-DD"), -1, leaf);
            }, { passive: false });

            if (this.plugin.settings.dailyNavShowToday !== false) {
                const todayBtn = parent.createEl("a", {
                    cls: `tps-daily-nav-today daily-note-navbar__date${isViewingToday ? " tps-daily-nav-today--current" : " tps-daily-nav-today--inactive"}`,
                    text: "Today",
                    href: "#",
                });
                this.hardenNavControl(todayBtn);
                todayBtn.onclick = (e) => {
                    this.suppressNavEvent(e);
                    this.goToDate(null, 0, leaf);
                };
                todayBtn.addEventListener("touchend", (e) => {
                    this.suppressNavEvent(e);
                    this.goToDate(null, 0, leaf);
                }, { passive: false });
            }

            const nextBtn = parent.createEl("a", { cls: "tps-daily-nav-btn daily-note-navbar__change-week", href: "#" });
            setIcon(nextBtn, "right-arrow");
            this.hardenNavControl(nextBtn);
            nextBtn.onclick = (e) => {
                this.suppressNavEvent(e);
                this.goToDate(viewedDate.format("YYYY-MM-DD"), 1, leaf);
            };
            nextBtn.addEventListener("touchend", (e) => {
                this.suppressNavEvent(e);
                this.goToDate(viewedDate.format("YYYY-MM-DD"), 1, leaf);
            }, { passive: false });
        };

        // ── Mobile mode: always use the floating bottom bar above the GCM chrome ──
        if (isMobile) {
            const nav = document.createElement("div");
            nav.className = "tps-daily-note-nav daily-note-navbar";
            nav.addClass("tps-daily-note-nav--floating");
            nav.addClass("tps-daily-note-nav--mobile");
            this.hardenNavControl(nav);
            if (restVisible) nav.dataset.restVisible = "true";
            host.appendChild(nav);
            this.currentNav = nav;

            const bottomRow = nav.createDiv({ cls: "tps-daily-note-nav__bottom-row" });
            buildControlsRow(bottomRow);

            this.applyMobileNavScrollVisibility(leaf);
        }
        // ── Header-bar mode: dates inline with header, controls below ──
        else if (headerAnchor?.parentElement) {
            const headerParent = headerAnchor.parentElement;
            this.currentHost = headerParent;
            this.currentHost.addClass("tps-daily-note-nav-anchor");
            this.currentReplacedHeaderEl = headerAnchor;
            const hiddenEls = this.collectHeaderPathElements(headerAnchor);
            hiddenEls.forEach((el) => {
                el.style.display = "none";
            });
            this.currentHiddenHeaderEls = hiddenEls;

            // Dates row — goes inline inside the header title container
            const datesRow = document.createElement("div");
            datesRow.className = "tps-daily-note-nav tps-daily-note-nav--header-dates";
            this.hardenNavControl(datesRow);
            if (restVisible) datesRow.dataset.restVisible = "true";
            buildDatesGroup(datesRow);

            const firstHidden = hiddenEls[0] ?? headerParent.firstElementChild;
            if (firstHidden && firstHidden.parentElement === headerParent) {
                headerParent.insertBefore(datesRow, firstHidden);
            } else {
                headerParent.insertBefore(datesRow, headerParent.firstChild);
            }
            this.currentNav = datesRow;

            // Controls row — goes below the entire view-header
            const viewHeader = headerParent.closest<HTMLElement>(".view-header");
            if (viewHeader) {
                const controlsRow = document.createElement("div");
                controlsRow.className = "tps-daily-note-nav tps-daily-note-nav--header-controls";
                this.hardenNavControl(controlsRow);
                if (restVisible) controlsRow.dataset.restVisible = "true";
                const innerRow = controlsRow.createDiv({ cls: "tps-daily-note-nav__bottom-row" });
                buildControlsRow(innerRow);
                viewHeader.insertAdjacentElement("afterend", controlsRow);
                this.currentHeaderWrapper = controlsRow;
            }

        } else {
            // ── Fallback: single container (under-title or floating) ──
            const nav = document.createElement("div");
            nav.className = "tps-daily-note-nav daily-note-navbar";
            this.hardenNavControl(nav);
            if (restVisible) nav.dataset.restVisible = "true";

            if (titleAnchor) {
                nav.addClass("tps-daily-note-nav--under-title");
                const titleParent = titleAnchor.parentElement ?? host;
                titleParent.addClass("tps-daily-note-nav-anchor");
                titleAnchor.insertAdjacentElement("afterend", nav);
            } else {
                nav.addClass("tps-daily-note-nav--floating");
                host.appendChild(nav);
            }
            this.currentNav = nav;

            const topRow = nav.createDiv({ cls: "tps-daily-note-nav__top-row" });
            buildDatesGroup(topRow);

            const bottomRow = nav.createDiv({ cls: "tps-daily-note-nav__bottom-row" });
            buildControlsRow(bottomRow);
        }
    }

    private resolveScrollContainer(view: MarkdownView): HTMLElement | null {
        return view.contentEl?.querySelector<HTMLElement>(".cm-scroller") ??
            view.contentEl?.querySelector<HTMLElement>(".markdown-preview-view") ??
            view.contentEl?.querySelector<HTMLElement>(".markdown-source-view") ??
            view.contentEl?.querySelector<HTMLElement>(".view-content") ??
            null;
    }

    private applyMobileNavScrollVisibility(leaf: WorkspaceLeaf): void {
        if (!Platform.isMobile) return;
        const nav = this.currentNav;
        if (!nav?.isConnected) return;
        const view = leaf.view as MarkdownView | undefined;
        if (!view) return;

        const scroller = this.resolveScrollContainer(view);
        const targets = Array.from(new Set([
            scroller,
            view.contentEl ?? null,
            view.containerEl ?? null,
        ].filter((el): el is HTMLElement => !!el)));
        if (targets.length === 0) return;

        if (this._mobileScrollHideState?.targets.length === targets.length &&
            this._mobileScrollHideState.targets.every((target, index) => target === targets[index])) {
            return;
        }
        this.detachMobileScrollHideTracking();

        const state = { targets, lastTop: scroller?.scrollTop ?? 0, accum: 0, listener: (_evt: Event) => { } };
        const HIDE_THRESHOLD = 52;
        const SHOW_THRESHOLD = 24;

        const setHidden = (hidden: boolean) => {
            if (!this.currentNav?.isConnected) return;
            this.currentNav.style.opacity = hidden ? "0" : "1";
            this.currentNav.style.visibility = hidden ? "hidden" : "visible";
            this.currentNav.style.pointerEvents = hidden ? "none" : "auto";
        };

        state.listener = (evt: Event) => {
            const currentNav = this.currentNav;
            if (!currentNav?.isConnected) return;
            const target = evt.target as HTMLElement | null;
            const top = Number.isFinite(target?.scrollTop) ? target!.scrollTop : (scroller?.scrollTop ?? state.lastTop);
            const delta = top - state.lastTop;
            state.lastTop = top;
            if ((delta > 0 && state.accum < 0) || (delta < 0 && state.accum > 0)) {
                state.accum = 0;
            }
            state.accum += delta;
            if (state.accum > HIDE_THRESHOLD) {
                setHidden(true);
                state.accum = 0;
            } else if (state.accum < -SHOW_THRESHOLD) {
                setHidden(false);
                state.accum = 0;
            }
        };

        for (const target of targets) {
            target.addEventListener("scroll", state.listener, { passive: true, capture: true });
        }
        this._mobileScrollHideState = state;
    }

    private detachMobileScrollHideTracking(): void {
        const state = this._mobileScrollHideState;
        if (!state) return;
        for (const target of state.targets) {
            target.removeEventListener("scroll", state.listener, { capture: true } as any);
        }
        this._mobileScrollHideState = null;
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

    private resolveHeaderBreadcrumbAnchor(leaf: WorkspaceLeaf): HTMLElement | null {
        const view = leaf.view as any;
        const root = view?.containerEl as HTMLElement | undefined;
        if (!root) return null;

        return root.querySelector<HTMLElement>([
            '.view-header-breadcrumb',
            '.view-header-breadcrumbs',
            '.view-header-title-parent',
            '.workspace-tab-header-container .view-header-breadcrumb',
            '.workspace-tab-header-container .view-header-title-parent'
        ].join(', '));
    }

    private collectHeaderPathElements(anchor: HTMLElement): HTMLElement[] {
        const container = anchor.parentElement;
        if (!container) return [anchor];

        const candidates = Array.from(container.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
        const pathLike = candidates.filter((el) => {
            if (el === this.currentNav) return false;
            if (el.matches('.view-header-breadcrumb, .view-header-breadcrumbs, .view-header-title-parent, .view-header-title, .view-header-title-container, .view-header-title-text')) return true;
            const text = (el.textContent || '').trim();
            return !!text && text.includes(' / ');
        });

        return pathLike.length > 0 ? pathLike : [anchor];
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

        const targetJsDate = targetDate?.toDate?.() instanceof Date ? targetDate.toDate() : null;
        if (targetJsDate instanceof Date && !Number.isNaN(targetJsDate.getTime())) {
            const createdViaShared = await ensureDailyNoteFile(this.plugin.app as any, targetJsDate, {
                formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
            });
            if (createdViaShared instanceof TFile) {
                const slash = normalizedPath.lastIndexOf("/");
                const folder = slash >= 0 ? normalizedPath.substring(0, slash) : "";
                await this.normalizeCreatedDailyNote(createdViaShared, titleValue, folder);
                return createdViaShared;
            }
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
                    await this.plugin.frontmatterMutationService.process(created, (fm) => {
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
        const resolver = getDailyNoteResolver(this.plugin.app, {
            formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
        });
        const scheduledDateKey = resolver.parseFilenameToDateKey(file.basename)
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
                        !!scheduledDateKey && (
                            !existingScheduled
                            || /<%[\s\S]*%>/.test(existingScheduled)
                            || /\{\{[\s\S]*\}\}/.test(existingScheduled)
                            || !existingScheduledMoment?.isValid?.()
                            || existingScheduledKey !== scheduledDateKey
                        );
                    if (shouldNormalizeScheduled) {
                        setValueCaseInsensitive(fm, 'scheduled', scheduledDateKey);
                    }
                }
                fm.folderPath = targetFolder;
                this.normalizeDailyNoteStatusFrontmatter(fm);
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
            const { applyRulesToFile } = await import('../utils/rule-resolver');
            await applyRulesToFile(this.plugin.app, file, 'gcm-daily-note');
        } catch (error) {
            logger.warn('Failed applying NN rules to daily note', { file: file.path, error });
        }
    }

    /**
     * Syncs the `scheduled` frontmatter field to match the date encoded in the
     * daily note's filename. Called on file-open for existing daily notes so the
     * value stays correct even if it was never set, was left as a template
     * expression, or drifted out of sync.
     */
    async syncScheduledFrontmatterOnOpen(file: TFile): Promise<void> {
        if (this.plugin.settings.enableDailyNoteScheduledNormalization === false) return;

        const resolver = getDailyNoteResolver(this.plugin.app, {
            formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
        });
        const scheduledDateKey = resolver.parseFilenameToDateKey(file.basename);
        if (!scheduledDateKey) return;

        try {
            // userInitiated: true — the date key is derived from the filename, not vault
            // sync state, so this write is safe to perform even during the sync settlement
            // window. The outer file-open handler intentionally runs this before the
            // isInitialSyncSettled gate for the same reason.
            await this.plugin.frontmatterMutationService.process(file, (fm: any) => {
                const existing = String((fm?.scheduled ?? fm?.Scheduled ?? '')).trim();
                const existingMoment = existing ? window.moment(existing) : null;
                const existingKey = existingMoment?.isValid?.() ? existingMoment.format('YYYY-MM-DD') : '';
                const isTemplateDerived = /<%[\s\S]*%>/.test(existing) || /\{\{[\s\S]*\}\}/.test(existing);
                if (!existing || isTemplateDerived || !existingMoment?.isValid?.() || existingKey !== scheduledDateKey) {
                    setValueCaseInsensitive(fm, 'scheduled', scheduledDateKey);
                }
                this.normalizeDailyNoteStatusFrontmatter(fm);
            }, { userInitiated: true });
        } catch (error) {
            logger.warn('[DailyNoteNavManager] Failed syncing scheduled frontmatter on open', { file: file.path, error });
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
        const m = (window as any).moment;
        const baseIso = baseIsoDateStr === null ? null : (baseIsoDateStr ?? this._displayedIsoDate);
        const targetDate = baseIso === null
            ? m().startOf("day")
            : m(baseIso, "YYYY-MM-DD").add(offset, "days");
        const targetIso = targetDate.format("YYYY-MM-DD");
        const leafForNav = sourceLeaf ?? this.getTargetLeaf() ?? this._currentLeaf;

        this._queuedTargetIsoDate = targetIso;
        this._queuedSourceLeaf = leafForNav ?? null;
        if (this._refreshTimer !== null) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }

        if (this._navInFlight) return;
        this._navInFlight = true;
        try {
            while (this._queuedTargetIsoDate) {
                const currentTargetIso = this._queuedTargetIsoDate;
                const currentSourceLeaf = this._queuedSourceLeaf;
                this._queuedTargetIsoDate = null;
                this._queuedSourceLeaf = null;
                const currentTargetDate = m(currentTargetIso, "YYYY-MM-DD");

                const resolver = getDailyNoteResolver(this.plugin.app, {
                    formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
                });
                const targetFilename = resolver.formatFilename(currentTargetDate.toDate());
                const targetPath = resolver.buildPath(currentTargetDate.toDate(), "md");
                const folder = resolver.folder;

                let file: TFile | null =
                    (this.plugin.app.vault.getAbstractFileByPath(targetPath) as TFile | null) ?? null;

                if (!(file instanceof TFile)) {
                    const justName = targetFilename + ".md";
                    const found = this.plugin.app.metadataCache.getFirstLinkpathDest(justName, folder || "");
                    file = found instanceof TFile ? found : null;
                }

                if (!(file instanceof TFile)) {
                    file = await this.ensureDailyNoteExists(targetPath, targetFilename, currentTargetDate);
                }

                if (file instanceof TFile) {
                    const targetLeaf = currentSourceLeaf ?? this.getTargetLeaf() ?? this._currentLeaf;
                    if (targetLeaf) {
                        try {
                            await targetLeaf.openFile(file, { active: true } as any);
                            continue;
                        } catch (error) {
                            logger.warn("[DailyNoteNavManager] Failed to open daily note in source leaf, falling back", error);
                        }
                    }
                    const leaf = this.getTargetLeaf() ?? this.plugin.app.workspace.getLeaf('tab');
                    if (!leaf) continue;
                    await leaf.openFile(file, { active: true } as any);
                } else {
                    new Notice(`Failed to open daily note: ${targetPath}`);
                }
            }
        } catch (err) {
            logger.error("goToDate failed", err);
            new Notice("Failed to navigate to daily note.");
        } finally {
            this._navInFlight = false;
        }
    }
}
