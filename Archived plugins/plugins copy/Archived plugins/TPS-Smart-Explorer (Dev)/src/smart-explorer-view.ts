import {
    ItemView,
    WorkspaceLeaf,
    TFile,
    TFolder,
    Notice,
    FuzzySuggestModal,
    setIcon,
    normalizePath,
    parseYaml,
    Menu,
    Modal,
    Platform
} from "obsidian";
import type ExplorerPlugin from "./main";
import { normalizeSortDef } from "./sorting";
import { DeleteConfirmationModal, QuickAddNoteModal, NamePromptModal } from "./modals";
import {
    STYLE_CATEGORIES,
    createBuilderId,
    normalizeSingleSortDef,
    normalizeBucketSortDef,
    normalizeBuilderRule,
    normalizeBuilderDefinition,
    normalizeBuilderMap,
    normalizeStyleProfileMap,
    normalizeStyleAssignmentEntry,
    normalizeStyleAssignmentMap,
    normalizeStyleAssignments,
    normalizeServiceConfig,
    SUPPORTED_BASE_FILTER_PATTERNS,
    parseBaseFilterNode,
    parseBaseSort
} from "./normalizers";
import { SortEngine } from "./sorting";
import { applyTemplateVars, buildTemplateVars } from "./template-variable-service";

export const VIEW_TYPE_SMART_EXPLORER = "explorer-2";
const DRAG_TYPE_SMART_NOTE = "application/x-tps-smart-note";

const PRIORITY_RANKS: Record<string, number> = {
    "high": 3,
    "medium": 2,
    "normal": 1,
    "low": 0,
    "none": -1
};

const STATUS_RANKS: Record<string, number> = {
    "doing": 5,
    "working": 5,
    "in progress": 5,
    "open": 4,
    "todo": 4,
    "blocked": 3,
    "complete": 2,
    "done": 2,
    "wont-do": 1,
    "archive": 0
};

class TemplateFileSuggest extends FuzzySuggestModal<TFile> {
    items: TFile[];
    onChoose: (file: TFile) => void;
    constructor(app: any, items: TFile[], onChoose: (file: TFile) => void) {
        super(app);
        this.items = items;
        this.onChoose = onChoose;
    }
    getItems() { return this.items; }
    getItemText(item: TFile) { return item.path; }
    onChooseItem(item: TFile) { this.onChoose(item); }
}

// Helper functions for rendering
function renderSection(container: ParentNode, options: any) {
    if (!container) return null;
    // const { setIcon: obsidianSetIcon } = require("obsidian");
    let sectionEl = document.createElement("div");
    sectionEl.className = "tree-item nav-folder explorer2-section";
    if (options && options.collapsed) sectionEl.classList.add("is-collapsed");
    if (options && options.key) {
        sectionEl.dataset.path = `explorer2-section://${options.key}`;
        sectionEl.dataset.linkPath = `explorer2-section://${options.key}`;
        sectionEl.dataset.sectionKey = options.key;
    }

    let titleEl = document.createElement("div");
    titleEl.className = "nav-folder-title tree-item-self explorer2-section-title";
    if (options && options.key) {
        titleEl.dataset.path = `explorer2-section://${options.key}`;
        titleEl.dataset.linkPath = `explorer2-section://${options.key}`;
        titleEl.dataset.sectionKey = options.key;
    }

    let collapseIconEl = document.createElement("div");
    collapseIconEl.className = "tree-item-icon collapse-icon nav-folder-collapse-indicator";
    try {
        collapseIconEl.style.position = "static";
        collapseIconEl.style.transform = "none";
        collapseIconEl.style.marginRight = "4px";
        collapseIconEl.style.display = "inline-flex";
        collapseIconEl.style.alignItems = "center";
        collapseIconEl.style.justifyContent = "center";
    } catch { }
    setIcon(collapseIconEl, options && options.collapsed ? "chevron-right" : "chevron-down");
    titleEl.appendChild(collapseIconEl);

    let folderIconEl = document.createElement("div");
    folderIconEl.className = "tree-item-icon nav-folder-icon explorer2-icon";
    try {
        folderIconEl.style.position = "static";
        folderIconEl.style.transform = "none";
        folderIconEl.style.marginRight = "2px";
        folderIconEl.style.display = "inline-flex";
        folderIconEl.style.alignItems = "center";
        folderIconEl.style.justifyContent = "center";
        folderIconEl.style.transform = "scale(1.05)";
        folderIconEl.style.transformOrigin = "left center";
    } catch { }
    setIcon(folderIconEl, "folder");
    titleEl.appendChild(folderIconEl);

    let nameEl = document.createElement("div");
    nameEl.className = "nav-folder-title-content explorer2-name tree-item-inner";
    nameEl.textContent = options && options.label ? options.label : "";
    try {
        nameEl.style.flex = "1 1 auto";
        nameEl.style.marginLeft = "0";
    } catch { }
    titleEl.appendChild(nameEl);

    try {
        titleEl.style.setProperty("--explorer2-depth", "0");
    } catch { }

    if (options && typeof options.badge == "number") {
        let badgeEl = document.createElement("div");
        badgeEl.className = "explorer2-count";
        badgeEl.textContent = String(options.badge);
        titleEl.appendChild(badgeEl);
    }

    let toggleHandler = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof options?.onToggle == "function") options.onToggle();
    };

    collapseIconEl.addEventListener("click", toggleHandler);
    titleEl.addEventListener("click", toggleHandler);
    if (typeof options?.onContextMenu == "function") {
        titleEl.addEventListener("contextmenu", (e: MouseEvent) => {
            e.preventDefault();
            options.onContextMenu(e);
        });
    }

    sectionEl.appendChild(titleEl);
    let childrenEl = document.createElement("div");
    childrenEl.className = "tree-item-children nav-folder-children explorer2-section-children";
    if (options && options.collapsed) childrenEl.style.display = "none";
    if (options && options.key) childrenEl.dataset.sectionKey = options.key;

    sectionEl.appendChild(childrenEl);
    container.appendChild(sectionEl);
    return { container: sectionEl, childrenEl: childrenEl };
}

function renderTreeItem(container: HTMLElement, options: any) {
    const isMobile = Platform.isMobile || Platform.isMobileApp;
    const doubleClickDelay = isMobile ? 140 : 60;
    const sanitizeInlineTagName = (value: string): string => {
        let text = value || "";
        text = text.replace(/(^|\s)(?:[*+•·‣\-–—]|\d+[.)])?\s*\[\s*[xX]?\s*\]\s*/g, " ");
        text = text.replace(/(^|\s)[☐☑✅✔️✔]\s*/g, " ");
        text = text.replace(/#\S+/g, "");
        return text.replace(/\s+/g, " ").trim();
    };

    let itemEl = document.createElement("div");
    itemEl.className = `tree-item ${options.isFolder ? "nav-folder" : "nav-file"}`;
    if (options.isFolder) {
        if (options.isCollapsed) itemEl.classList.add("is-collapsed");
    }

    if (options.path) {
        itemEl.dataset.path = options.path;
        itemEl.dataset.linkPath = options.path;
    }
    if (options.sectionKey) itemEl.dataset.sectionKey = options.sectionKey;
    if (options.itemType) itemEl.dataset.itemType = options.itemType;
    if (options.selectable) itemEl.classList.add("explorer2-selectable");

    let tags = Array.isArray(options.tags) ? options.tags.filter((t: any) => !!t) : null;
    let tagString = tags && tags.length ? tags.map((t: string) => `#${t.replace(/^#/, "")}`).join(" ") : "";
    if (tagString) {
        itemEl.dataset.tags = tagString;
        itemEl.dataset.linkTags = tagString;
    }

    if (Array.isArray(options.extraClasses)) {
        options.extraClasses.forEach((cls: string) => {
            if (cls) itemEl.classList.add(cls);
        });
    }

    if (options.isFolder && options.depth === 0) itemEl.classList.add("mod-root");

    let selfEl = document.createElement("div");
    selfEl.className = (options.isFolder ? "nav-folder-title" : "nav-file-title") + " tree-item-self explorer2-row";
    if (options.selectable) selfEl.classList.add("explorer2-selectable");

    try {
        selfEl.style.setProperty("--explorer2-depth", `${options.depth}`);
    } catch {
        selfEl.style.paddingLeft = `${37 + options.depth * 14}px`;
    }

    if (options.path) {
        selfEl.setAttr?.("data-path", options.path);
        if (!selfEl.getAttribute("data-path")) selfEl.setAttribute("data-path", options.path);
        selfEl.dataset.path = options.path;
        selfEl.dataset.linkPath = options.path;
    }
    if (options.sectionKey) selfEl.dataset.sectionKey = options.sectionKey;
    if (tagString) {
        selfEl.dataset.tags = tagString;
        selfEl.dataset.linkTags = tagString;
    }

    let isDragInProgress = false;
    let longPressTimer: any = null;
    let startX = 0;
    let startY = 0;
    let clickTimer: any = null;
    let clickHandled = false;

    const clearLongPress = () => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    };

    const handleSingleClick = (e: MouseEvent) => {
        if (options.onClick) {
            options.onClick(e);
        }
    };

    selfEl.addEventListener("mousedown", (e: MouseEvent) => {
        if (e.button !== 0) return;
        if (isDragInProgress) return;
        const targetEl = e.target as HTMLElement | null;
        const isIconButton = !!targetEl?.closest?.(".explorer2-icon-btn");
        const isActionElement = !!targetEl?.closest?.("button, a, [role='button']");
        const isDraggableTarget = !!targetEl?.closest?.('[draggable="true"]');
        if (isDraggableTarget || isIconButton || isActionElement) return;
        clickHandled = true;
        e.preventDefault();
        handleSingleClick(e);
    });

    selfEl.addEventListener("click", (e: MouseEvent) => {
        // console.log("SmartExplore: click on item", options.path);
        if (clickHandled) {
            clickHandled = false;
            return;
        }
        if (isDragInProgress) {
            isDragInProgress = false;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        e.preventDefault();
        handleSingleClick(e);
    });

    selfEl.addEventListener("contextmenu", (e: MouseEvent) => {
        e.preventDefault();
        if (options.onContextMenu) options.onContextMenu(e);
    });



    if (!isMobile && options.fileRef && options.path) {
        const setupDraggable = (el: HTMLElement) => {
            try {
                el.setAttribute("draggable", "true");
                el.addEventListener("dragstart", (e: DragEvent) => handleDragStart(e, options.path, options.fileRef));
                el.addEventListener("dragend", handleDragEnd);
            } catch { }
        };
        setupDraggable(itemEl);
        setupDraggable(selfEl);
    }

    // Drag and Drop into Folders (Types section)
    if (options.isFolder && options.sectionKey === "types" && options.path) {
        const setupDropTarget = (el: HTMLElement) => {
            el.addEventListener("dragover", (e: DragEvent) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                el.classList.add("is-being-dragged-over");
            });
            el.addEventListener("dragleave", () => el.classList.remove("is-being-dragged-over"));
            el.addEventListener("drop", async (e: DragEvent) => {
                e.preventDefault();
                e.stopPropagation();
                el.classList.remove("is-being-dragged-over");
                if ((el as any)._dropInProgress) return;
                (el as any)._dropInProgress = true;
                try {
                    const dragDataRaw = e.dataTransfer?.getData(DRAG_TYPE_SMART_NOTE);
                    const dragData = dragDataRaw ? JSON.parse(dragDataRaw) : null;
                    const dragPath = dragData?.path || e.dataTransfer?.getData("text/plain");
                    if (!dragPath) return;
                    const view = (window as any).app?.workspace?.getLeavesOfType?.(VIEW_TYPE_SMART_EXPLORER)?.[0]?.view;
                    if (!view) return;
                    const selectedFiles = view.getSelectedFiles?.() || [];
                    const draggedFile = (window as any).app?.vault?.getAbstractFileByPath?.(dragPath);
                    const filesToMove = selectedFiles.length > 0 ? selectedFiles : (draggedFile ? [draggedFile] : []);

                    for (const f of filesToMove) {
                        if (f?.path) await view.moveFileToFolder?.(f, options.path);
                    }
                    view.clearSelection?.();
                } catch (err) {
                    console.error("Drop failed:", err);
                } finally {
                    (el as any)._dropInProgress = false;
                }
            });
        };
        setupDropTarget(itemEl);
        setupDropTarget(selfEl);
    }

    // Drag and Drop into Tags
    if (options.isFolder && options.sectionKey === "tags" && options.fullTag) {
        const setupTagDropTarget = (el: HTMLElement) => {
            el.addEventListener("dragover", (e: DragEvent) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
                el.classList.add("is-being-dragged-over");
            });
            el.addEventListener("dragleave", () => el.classList.remove("is-being-dragged-over"));
            el.addEventListener("drop", async (e: DragEvent) => {
                e.preventDefault();
                e.stopPropagation();
                el.classList.remove("is-being-dragged-over");
                if ((el as any)._dropInProgress) return;
                (el as any)._dropInProgress = true;
                try {
                    const dragDataRaw = e.dataTransfer?.getData(DRAG_TYPE_SMART_NOTE);
                    const dragData = dragDataRaw ? JSON.parse(dragDataRaw) : null;
                    const dragPath = dragData?.path || e.dataTransfer?.getData("text/plain");
                    if (!dragPath) return;
                    const view = (window as any).app?.workspace?.getLeavesOfType?.(VIEW_TYPE_SMART_EXPLORER)?.[0]?.view as SmartExplorerView;
                    if (!view) return;
                    const selectedFiles = view.getSelectedFiles?.() || [];
                    const draggedFile = (window as any).app?.vault?.getAbstractFileByPath?.(dragPath);
                    const filesToTag = selectedFiles.length > 0 ? selectedFiles : (draggedFile ? [draggedFile] : []);

                    const tag = options.fullTag.replace(/^#/, "");
                    await view.bulkUpdateFrontmatter?.(filesToTag, (fm: any) => {
                        fm.tags = view.mergeTagInputs?.(fm.tags, tag) || fm.tags;
                    });
                    view.clearSelection?.();
                    view.ensureRefreshSoon?.();
                } catch (err) {
                    console.error("Tag drop failed:", err);
                } finally {
                    (el as any)._dropInProgress = false;
                }
            });
        };
        setupTagDropTarget(itemEl);
        setupTagDropTarget(selfEl);
    }

    // Drag and Drop into Filters
    if (options.isFolder && options.sectionKey === "filters" && options.path && options.path.startsWith("explorer2-filter://")) {
        const setupFilterDropTarget = (el: HTMLElement) => {
            el.addEventListener("dragover", (e: DragEvent) => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
                el.classList.add("is-being-dragged-over");
            });
            el.addEventListener("dragleave", () => el.classList.remove("is-being-dragged-over"));
            el.addEventListener("drop", async (e: DragEvent) => {
                e.preventDefault();
                e.stopPropagation();
                el.classList.remove("is-being-dragged-over");
                if ((el as any)._dropInProgress) return;
                (el as any)._dropInProgress = true;
                try {
                    const dragDataRaw = e.dataTransfer?.getData(DRAG_TYPE_SMART_NOTE);
                    const dragData = dragDataRaw ? JSON.parse(dragDataRaw) : null;
                    const dragPath = dragData?.path || e.dataTransfer?.getData("text/plain");
                    if (!dragPath) return;
                    const view = (window as any).app?.workspace?.getLeavesOfType?.(VIEW_TYPE_SMART_EXPLORER)?.[0]?.view as SmartExplorerView;
                    if (!view) return;
                    const selectedFiles = view.getSelectedFiles?.() || [];
                    const draggedFile = (window as any).app?.vault?.getAbstractFileByPath?.(dragPath);
                    const filesToUpdate = selectedFiles.length > 0 ? selectedFiles : (draggedFile ? [draggedFile] : []);

                    const filterId = options.path.replace("explorer2-filter://", "");
                    const props = view.extractPropertiesFromFilter?.(filterId);
                    if (!props) return;

                    await view.bulkUpdateFrontmatter?.(filesToUpdate, (fm: any) => {
                        if (props.tags && props.tags.length > 0) {
                            fm.tags = view.mergeTagInputs?.(fm.tags, props.tags) || fm.tags;
                        }
                        if (props.frontmatter) Object.assign(fm, props.frontmatter);
                    });
                    view.clearSelection?.();
                    view.ensureRefreshSoon?.();
                } catch (err) {
                    console.error("Filter drop failed:", err);
                } finally {
                    (el as any)._dropInProgress = false;
                }
            });
        };
        setupFilterDropTarget(itemEl);
        setupFilterDropTarget(selfEl);
    }

    // Caret / Collapse Indicator
    if (options.isFolder && options.showCaret !== false) {
        let caretEl = document.createElement("div");
        caretEl.className = "tree-item-icon collapse-icon nav-folder-collapse-indicator";
        try {
            caretEl.style.position = "static";
            caretEl.style.transform = "none";
            caretEl.style.marginRight = "4px";
            caretEl.style.display = "inline-flex";
            caretEl.style.alignItems = "center";
            caretEl.style.justifyContent = "center";
        } catch { }
        setIcon(caretEl, options.isCollapsed ? "chevron-right" : "chevron-down");
        caretEl.addEventListener("click", (e: MouseEvent) => {
            e.stopPropagation();
            if (options.onCaretClick) options.onCaretClick();
        });
        selfEl.appendChild(caretEl);
    } else if (options.isFolder) {
        let spacerEl = document.createElement("div");
        spacerEl.className = "tree-item-icon collapse-icon nav-folder-collapse-indicator";
        spacerEl.style.visibility = "hidden";
        try {
            spacerEl.style.display = "inline-flex";
            spacerEl.style.alignItems = "center";
            spacerEl.style.justifyContent = "center";
            spacerEl.style.marginRight = "4px";
        } catch { }
        selfEl.appendChild(spacerEl);
    }

    // Icon
    let iconEl = document.createElement("div");
    iconEl.className = `tree-item-icon ${options.isFolder ? "nav-folder-icon" : "nav-file-icon"} explorer2-icon`;
    try {
        iconEl.style.position = "static";
        iconEl.style.transform = "none";
        iconEl.style.marginRight = "2px";
        iconEl.style.display = "inline-flex";
        iconEl.style.alignItems = "center";
        iconEl.style.justifyContent = "center";
        if (options.isFolder) {
            iconEl.style.transform = "scale(1.05)";
            iconEl.style.transformOrigin = "left center";
        }
    } catch { }

    let iconId = options.iconId;
    if (iconId) {
        const candidates = [iconId];
        if (/^lucide-/.test(iconId)) candidates.push(iconId.replace(/^lucide-/, ""));
        let success = false;
        for (const c of candidates) {
            try {
                setIcon(iconEl, c);
                success = true;
                break;
            } catch { }
        }
        if (!success) {
            if (iconId.length <= 3) iconEl.textContent = iconId;
            else setIcon(iconEl, options.isFolder ? "folder" : "file");
        }
    } else {
        setIcon(iconEl, options.isFolder ? "folder" : "file");
    }

    if (options.iconColor) iconEl.style.color = options.iconColor;
    selfEl.appendChild(iconEl);

    // Name / Content
    let nameEl = document.createElement("div");
    nameEl.className = (options.isFolder ? "nav-folder-title-content" : "nav-file-title-content") + " explorer2-name tree-item-inner";
    try {
        nameEl.style.flex = "1 1 auto";
        nameEl.style.marginLeft = "0";
    } catch { }
    const rawName = options.name || "";
    nameEl.textContent = options.itemType === "inline-tag-line" ? sanitizeInlineTagName(rawName) : rawName;
    if (options.path) {
        nameEl.dataset.linkPath = options.path;
        nameEl.dataset.path = options.path;
    }
    if (tagString) {
        nameEl.dataset.tags = tagString;
        nameEl.dataset.linkTags = tagString;
    }
    selfEl.appendChild(nameEl);

    if (options.textStyle) {
        const styleText = Array.isArray(options.textStyle)
            ? options.textStyle.join(";")
            : (typeof options.textStyle === "string" ? options.textStyle : "");
        styleText.split(";").map((s: string) => s.trim()).filter(Boolean).forEach((s: string) => {
            const parts = s.split(":");
            if (parts.length >= 2) {
                const prop = parts[0].trim();
                const val = parts.slice(1).join(":").trim();
                if (prop && val) (nameEl.style as any)[prop] = val;
            }
        });
    }

    // Badge / Count
    if (options.badge != null) {
        let badgeEl = document.createElement("div");
        badgeEl.className = "explorer2-count";
        badgeEl.textContent = String(options.badge);
        selfEl.appendChild(badgeEl);
    }

    itemEl.appendChild(selfEl);
    let childrenEl: HTMLElement | null = null;
    if (options.isFolder) {
        childrenEl = document.createElement("div");
        childrenEl.className = "tree-item-children nav-folder-children";
        if (options.isCollapsed) childrenEl.style.display = "none";
        itemEl.appendChild(childrenEl);
    }

    container.appendChild(itemEl);
    return { outer: itemEl, childContainer: childrenEl, titleEl: selfEl };
}

function handleDragStart(e: DragEvent, path: string, file: TFile) {
    try {
        if (!e.dataTransfer || !path) return;
        const app = (window as any).app;

        let duration: number | null = null;
        let isAllDay = false;
        try {
            const fm = app?.metadataCache?.getFileCache?.(file)?.frontmatter || {};
            const estimate = Array.isArray(fm.timeEstimate) ? fm.timeEstimate[0] : (fm.timeEstimate ?? fm.duration ?? fm.Duration);
            const parsed = parseInt(estimate, 10);
            if (Number.isFinite(parsed) && parsed > 0) duration = parsed;
            if (fm.allDay === true) isAllDay = true;
        } catch { }

        const dragData = { path, duration, allDay: isAllDay };
        e.dataTransfer.setData(DRAG_TYPE_SMART_NOTE, JSON.stringify(dragData));
        try {
            e.dataTransfer.setData("text/plain", path);
        } catch { }
        e.dataTransfer.effectAllowed = "copyMove";

        if (typeof e.dataTransfer.setDragImage === "function") {
            const dragImg = document.createElement("div");
            dragImg.textContent = file.name || path.split("/").pop() || "";
            dragImg.className = "explorer2-drag-image";
            document.body.appendChild(dragImg);
            e.dataTransfer.setDragImage(dragImg, 12, 12);
            requestAnimationFrame(() => dragImg.remove());
        }
    } catch (err) {
        console.error("Drag start failed", err);
    }
}

function handleDragEnd() {
    (window as any)._tpsSmartFolderDrag = null;
}

function matchServiceFilters(view: SmartExplorerView, group: any, item: any, isFolder: boolean) {
    try {
        if (!group || typeof group != "object") return false;
        const strictPathsExact =
            !!group.hideStrictPathFilters ||
            !!group.strictPathFilters ||
            !!group.strictPathsExact;
        const normalizePath = (p: string) =>
            typeof p == "string" ? p.replace(/^\/+/, "") : "";
        const path = item?.path || "/";
        const rel = normalizePath(path);
        const parent = (() => {
            if (!rel) return "";
            const idx = rel.lastIndexOf("/");
            return idx === -1 ? "" : rel.slice(0, idx);
        })();
        const ancestors = (() => {
            const values = [];
            let cursor = parent;
            while (cursor) {
                values.push(cursor);
                const idx = cursor.lastIndexOf("/");
                if (idx === -1) break;
                cursor = cursor.slice(0, idx);
            }
            return values;
        })();
        const fileLike = isFolder ? null : item;
        const frontmatter =
            (!isFolder && fileLike
                ? view.app.metadataCache.getFileCache(fileLike)?.frontmatter || null
                : null) || null;
        const tags = !isFolder && fileLike ? view._collectTags(fileLike) : [];

        // Case-insensitive frontmatter lookup helper
        const getFrontmatterVal = (key: string) => {
            if (!frontmatter || !key) return undefined;
            // Try exact match first
            if (Object.prototype.hasOwnProperty.call(frontmatter, key)) return frontmatter[key];
            // Then case-insensitive match
            const lower = key.toLowerCase();
            for (const [k, v] of Object.entries(frontmatter)) {
                if (String(k).toLowerCase() === lower) return v;
            }
            return undefined;
        };
        const matchesPath = (pattern: string, patternType: string, opts: any = {}) => {
            const {
                includeFiles = true,
                includeFolders = true,
                treatDescendants = true,
            } = opts;
            if (!pattern) return false;
            const type = (patternType || "STRICT").toUpperCase();
            if (type === "REGEX") {
                try {
                    const regex = new RegExp(pattern);
                    if (includeFolders && isFolder && regex.test(rel)) return true;
                    if (includeFiles && !isFolder && regex.test(rel)) return true;
                    if (!isFolder && treatDescendants) {
                        if (parent && regex.test(parent)) return true;
                        if (ancestors.some((a) => regex.test(a))) return true;
                    }
                    return false;
                } catch {
                    return false;
                }
            }
            const strictPattern = normalizePath(pattern);
            if (!strictPattern && pattern !== "") return false;
            const matchStrict = (value: string, allowPrefix: boolean) => {
                if (!value && strictPattern) return false;
                const normalized = normalizePath(value);
                if (normalized === strictPattern) return true;
                if (
                    !strictPathsExact &&
                    allowPrefix &&
                    strictPattern &&
                    normalized.startsWith(`${strictPattern}/`)
                )
                    return true;
                return false;
            };
            if (includeFolders && isFolder && matchStrict(rel, true)) return true;
            if (includeFiles && !isFolder && matchStrict(rel, true)) return true;
            if (!isFolder && treatDescendants) {
                if (matchStrict(parent, true)) return true;
                if (!strictPathsExact && ancestors.some((a) => matchStrict(a, true)))
                    return true;
            }
            return false;
        };
        if (Array.isArray(group.paths)) {
            for (const pathConfig of group.paths) {
                if (!pathConfig || pathConfig.active === false) continue;
                const type = (pathConfig.type || "ALL").toUpperCase();
                const includeFiles =
                    type === "ALL" || type === "FILES" || type === "DIRECTORIES";
                const includeFolders = type === "ALL" || type === "DIRECTORIES";
                const treatDescendants = type === "DIRECTORIES" || type === "ALL";
                if (
                    matchesPath(pathConfig.pattern || "", pathConfig.patternType, {
                        includeFiles: !isFolder && includeFiles,
                        includeFolders: isFolder && includeFolders,
                        treatDescendants: !isFolder && treatDescendants,
                    })
                )
                    return true;
            }
        }
        if (!isFolder && Array.isArray(group.tags)) {
            for (const tagConfig of group.tags) {
                if (!tagConfig || tagConfig.active === false) continue;
                const pattern = tagConfig.pattern || tagConfig.name || "";
                if (!pattern) continue;
                if ((tagConfig.patternType || "STRICT").toUpperCase() === "REGEX")
                    try {
                        if (new RegExp(pattern).test(tags.join(" "))) return true;
                    } catch { }
                else if (tags.includes(pattern) || tags.includes(`#${pattern}`))
                    return true;
            }
        }
        if (!isFolder && Array.isArray(group.frontMatter)) {
            for (const fmConfig of group.frontMatter) {
                if (!fmConfig || fmConfig.active === false) continue;
                const key = fmConfig.path || fmConfig.key || "";
                if (!key) continue;
                const value = getFrontmatterVal(key);
                const values = Array.isArray(value)
                    ? value.map((v) => `${v}`)
                    : [`${value ?? ""}`];
                if ((fmConfig.patternType || "STRICT").toUpperCase() === "REGEX") {
                    try {
                        const re = new RegExp(fmConfig.pattern || "");
                        if (values.some((v) => re.test(v))) return true;
                    } catch { }
                } else if (values.some((v) => v === (fmConfig.pattern || "")))
                    return true;
            }
        }
        if (Array.isArray(group.compound)) {
            for (const compound of group.compound) {
                if (!compound || compound.active === false) continue;
                const target = (
                    compound.target ||
                    compound.scope ||
                    compound.type ||
                    "ALL"
                ).toUpperCase();
                if (
                    (target === "FILES" && isFolder) ||
                    (target === "DIRECTORIES" && !isFolder)
                )
                    continue;
                const matches = (compound.criteria || []).every((criterion: any) => {
                    if (!criterion) return false;
                    const criterionType = (criterion.type || "").toUpperCase();
                    if (criterionType === "PATH") {
                        const sense = (
                            criterion.target ||
                            criterion.scope ||
                            criterion.appliesTo ||
                            "ALL"
                        ).toUpperCase();
                        const includeFiles = !isFolder && sense !== "DIRECTORIES";
                        const includeFolders = isFolder && sense !== "FILES";
                        return matchesPath(criterion.pattern || "", criterion.patternType, {
                            includeFiles,
                            includeFolders,
                            treatDescendants: !isFolder,
                        });
                    }
                    if (criterionType === "FRONTMATTER") {
                        if (isFolder) return false;
                        const key = criterion.path || criterion.key || "";
                        if (!key) return false;
                        const value = getFrontmatterVal(key);
                        const candidateValues = Array.isArray(value)
                            ? value.map((v) => `${v}`)
                            : [`${value ?? ""}`];
                        if ((criterion.patternType || "STRICT").toUpperCase() === "REGEX") {
                            try {
                                const re = new RegExp(criterion.pattern || "");
                                return candidateValues.some((v) => re.test(v));
                            } catch {
                                return false;
                            }
                        }
                        return candidateValues.some((v) => v === (criterion.pattern || ""));
                    }
                    return false;
                });
                if (matches) return true;
            }
        }
    } catch { }
    return false;
}

export class SmartExplorerView extends ItemView {
    plugin: ExplorerPlugin;
    headerEl: HTMLElement | null;
    toolbarEl: HTMLElement | null;
    listEl: HTMLElement | null;
    filterQuery: string;
    sortMode: { key: string; dir: string; foldersFirst: boolean };

    filterMatchVersion: number = 0;
    visualMatchVersion: number = 0;

    filterMatchesCache: Map<string, { version: number; files: any[] }> = new Map();
    visualMatchCache: Map<string, any> = new Map();
    serviceMatchCache: Map<string, any> = new Map();
    fileTagCache: Map<string, string[]> = new Map();
    inlineTagLinesCache: Map<string, { line: number; text: string }[]> = new Map();
    inlineTagLinesPending: Set<string> = new Set();
    frontmatterCache: Map<string, any> = new Map();
    folderCountCache: Map<string, number> = new Map();
    folderFilterMatchCache: Map<string, boolean> = new Map();
    sortValueCache: Map<string, any> = new Map();

    sectionOrders: Record<string, any[]> = {};
    _scheduledRender: any = null;
    _pendingRename: any = null;
    _pendingRenameTimer: any = null;
    _activeRename: { path: string; input: HTMLInputElement; textEl: HTMLElement; cleanup: () => void } | null = null;
    _activeRenameCommitting: boolean = false;
    _superchargedFrame: any = null;
    lastSelectedPath: string | null = null;
    lastEditorChangeAt: number = 0;
    metadataRefreshTimer: number | null = null;
    typingQuietWindowMs: number = 4000;

    menuOutsideHandler: ((e: PointerEvent) => void) | null = null;
    menuKeyHandler: ((e: KeyboardEvent) => void) | null = null;
    activeMenuEl: HTMLElement | null = null;
    activeMenuContext: string | null = null;

    // New sorting engine
    sortEngine: SortEngine;



    constructor(leaf: WorkspaceLeaf, plugin: ExplorerPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.headerEl = null;
        this.toolbarEl = null;
        this.listEl = null;
        this.filterQuery = "";
        this.sortMode = { key: "name", dir: "asc", foldersFirst: true };

        // Initialize new sorting engine
        this.sortEngine = new SortEngine({ app: this.app });
    }

    getViewType(): string {
        return VIEW_TYPE_SMART_EXPLORER;
    }

    getDisplayText(): string {
        return "Smart Explorer";
    }

    getIcon(): string {
        return "folder-search";
    }

    private getInlineTagEntries(file: TFile, tag: string): any[] {
        const cache = this.app.metadataCache.getFileCache(file);
        const tags = cache?.tags || [];
        const frontmatterEnd = cache?.frontmatterPosition?.end?.line ?? -1;
        const normalizedTag = this.normalizeTag(tag);
        const inlineTags = tags.filter((t: any) => {
            const line = t?.position?.start?.line;
            const tagValue = typeof t?.tag === "string" ? t.tag : String(t?.tag ?? t);
            return (
                typeof line === "number" &&
                line > frontmatterEnd &&
                this.normalizeTag(tagValue) === normalizedTag
            );
        });
        return inlineTags || [];
    }

    private getInlineTagLines(
        file: TFile,
        tag: string
    ): { hasInlineTag: boolean; lines: { line: number; text: string }[]; isCrossedOut?: boolean; isFilteredOut?: boolean } {
        const inlineTags = this.getInlineTagEntries(file, tag);
        const hasInlineTag = inlineTags.length > 0;
        const cacheKey = `${file.path}::${this.normalizeTag(tag)}::${this.getInlineTagCacheSignature()}`;
        if (!hasInlineTag) {
            this.inlineTagLinesCache.delete(cacheKey);
            return { hasInlineTag: false, lines: [] };
        }

        const cached = this.inlineTagLinesCache.get(cacheKey);
        if (cached) {
            const cachedMarker = cached.length === 1 ? cached[0]?.text : "";
            const isCrossedOut = cachedMarker === "__CROSSED_OUT__";
            const isFilteredOut = cachedMarker === "__FILTERED__";
            const shouldHide = isCrossedOut || isFilteredOut;
            if (shouldHide) {
                return { hasInlineTag: true, lines: [], isCrossedOut, isFilteredOut };
            }
            const sanitized = cached
                .map((entry) => ({
                    ...entry,
                    text: this.sanitizeInlineTagDisplay(entry.text || ""),
                }))
                .filter((entry) => entry.text);
            if (sanitized.length !== cached.length) {
                this.inlineTagLinesCache.set(cacheKey, sanitized);
            }
            return {
                hasInlineTag: true,
                lines: sanitized,
                isCrossedOut,
                isFilteredOut
            };
        }

        if (!this.inlineTagLinesPending.has(cacheKey)) {
            this.inlineTagLinesPending.add(cacheKey);
            this.computeInlineTagLines(file, tag)
                .catch(() => { })
                .finally(() => {
                    this.inlineTagLinesPending.delete(cacheKey);
                });
        }

        return { hasInlineTag: true, lines: [] };
    }

    private getInlineTagDisplay(file: TFile, tag: string): { hasInlineTag: boolean; title?: string; isCrossedOut?: boolean; isFilteredOut?: boolean } {
        const inlineInfo = this.getInlineTagLines(file, tag);
        if (!inlineInfo.hasInlineTag) {
            return { hasInlineTag: false };
        }
        if (inlineInfo.isCrossedOut || inlineInfo.isFilteredOut) {
            return {
                hasInlineTag: true,
                title: inlineInfo.isCrossedOut ? "__CROSSED_OUT__" : "__FILTERED__",
                isCrossedOut: inlineInfo.isCrossedOut,
                isFilteredOut: inlineInfo.isFilteredOut
            };
        }
        const first = inlineInfo.lines[0]?.text;
        if (first) {
            return { hasInlineTag: true, title: first };
        }
        return { hasInlineTag: true };
    }

    private async computeInlineTagLines(file: TFile, tag: string): Promise<void> {
        const tagEntries = this.getInlineTagEntries(file, tag);
        const cacheKey = `${file.path}::${this.normalizeTag(tag)}::${this.getInlineTagCacheSignature()}`;
        if (!tagEntries || tagEntries.length === 0) {
            this.inlineTagLinesCache.delete(cacheKey);
            return;
        }

        const content = await this.app.vault.cachedRead(file);
        const lines = content.split(/\r?\n/);
        const lineIndexes = Array.from(
            new Set(
                tagEntries
                    .map((entry: any) => entry?.position?.start?.line)
                    .filter((line: any) => typeof line === "number")
            )
        ).sort((a, b) => a - b);

        const results: { line: number; text: string }[] = [];
        let skippedCrossedOut = 0;
        let skippedChecked = 0;

        for (const lineIndex of lineIndexes) {
            const rawLine = lines[lineIndex] ?? "";
            if (!this.plugin?.globallyShowHiddenItems && this.plugin?.settings?.hideInlineTagCrossedOut !== false) {
                if (this.isInlineTagLineCrossedOut(rawLine)) {
                    skippedCrossedOut++;
                    continue;
                }
            }
            if (!this.plugin?.globallyShowHiddenItems && this.plugin?.settings?.hideInlineTagChecked !== false) {
                if (this.isInlineTagLineChecked(rawLine, file, lineIndex)) {
                    skippedChecked++;
                    continue;
                }
            }

            const cleanedLine = this.cleanInlineTagLine(rawLine);
            const trimmed = cleanedLine.trim();
            if (!trimmed) {
                continue;
            }

            const withoutTags = trimmed
                .replace(/(^|\\s)#[^\\s#]+/g, " ")
                .replace(/#[-_\\w/]+/g, "")
                .replace(/#\\S+/g, "")
                .replace(/\\s+/g, " ")
                .trim();
            if (withoutTags) {
                results.push({ line: lineIndex, text: this.sanitizeInlineTagDisplay(withoutTags) });
            }
        }

        if (!this.plugin?.globallyShowHiddenItems && results.length === 0 && (skippedCrossedOut > 0 || skippedChecked > 0)) {
            const marker =
                skippedChecked > 0 && this.plugin?.settings?.hideInlineTagChecked !== false
                    ? "__FILTERED__"
                    : "__CROSSED_OUT__";
            this.inlineTagLinesCache.set(cacheKey, [{ line: -1, text: marker }]);
            this.scheduleRenderRefresh();
            return;
        }

        this.inlineTagLinesCache.set(cacheKey, results);
        this.scheduleRenderRefresh();
    }

    private cleanInlineTagLine(rawLine: string): string {
        let line = rawLine.trim();
        // Remove common list/quote prefixes
        line = line.replace(/^(>\\s*)+/, "");
        // Remove leading bullets/numbering (repeatable)
        line = line.replace(/^(\\s*[*+•·‣\\-–—]|\\s*\\d+[.)])+\\s*/g, "");
        // Remove task checkbox prefix (with or without a list marker)
        line = line.replace(/^\\s*(?:[*+•·‣\\-–—]|\\d+[.)])?\\s*\\[\\s*[xX]?\\s*\\]\\s*/, "");
        // Remove unicode checkbox markers
        line = line.replace(/^\\s*[☐☑✅✔️✔]\\s*/, "");
        // Clean any leftover bullets after checkbox stripping
        line = line.replace(/^(\\s*[*+•·‣\\-–—])+\\s*/g, "");
        return line;
    }

    private isInlineTagLineCrossedOut(rawLine: string): boolean {
        const line = rawLine.trim();
        return /~~.*~~/.test(line);
    }

    private isInlineTagLineChecked(rawLine: string, file?: TFile, lineIndex?: number): boolean {
        const line = rawLine.trim();
        if (
            /^([*+•·‣\\-–—]|\\d+[.)])?\\s*\\[\\s*[xX]\\s*\\]/.test(line) ||
            /^\\s*[☑✅✔️✔]/.test(line) ||
            /^\\s*-\s*\\[\\s*[xX]\\s*\\]/.test(line)
        ) {
            return true;
        }
        if (!file) return false;
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache?.listItems?.length) return false;
        if (typeof lineIndex !== "number") return false;
        return cache.listItems.some((item: any) => item?.task === "x" && item?.position?.start?.line === lineIndex);
    }

    private getInlineTagCacheSignature(): string {
        const hideCrossedOut = this.plugin?.settings?.hideInlineTagCrossedOut !== false;
        const hideChecked = this.plugin?.settings?.hideInlineTagChecked !== false;
        const showHidden = this.plugin?.globallyShowHiddenItems ? "1" : "0";
        return `c:${hideCrossedOut ? "1" : "0"};k:${hideChecked ? "1" : "0"};s:${showHidden};v4`;
    }

    private sanitizeInlineTagDisplay(line: string): string {
        let text = line;
        // Remove any remaining checkbox tokens
        text = text.replace(/(^|\\s)(?:[*+•·‣\\-–—]|\\d+[.)])?\\s*\\[\\s*[xX]?\\s*\\]\\s*/g, " ");
        text = text.replace(/(^|\\s)[☐☑✅✔️✔]\\s*/g, " ");
        // Remove any tags
        text = text.replace(/#\\S+/g, "");
        text = text.replace(/\\s+/g, " ").trim();
        return text;
    }

    private getFilterTagValues(definition: any): string[] {
        const values: string[] = [];
        const visit = (rule: any) => {
            if (!rule || typeof rule !== "object") return;
            if (Array.isArray(rule.rules)) {
                rule.rules.forEach((r) => visit(r));
                return;
            }
            const source = String(rule.source || "").toLowerCase();
            if (source === "tag") {
                const raw = Array.isArray(rule.value) ? rule.value : [rule.value];
                raw.forEach((v) => {
                    if (v == null) return;
                    values.push(String(v));
                });
            }
        };
        visit(definition);
        return values;
    }

    private filterHasNonTagRules(definition: any): boolean {
        let found = false;
        const visit = (rule: any) => {
            if (!rule || typeof rule !== "object" || found) return;
            if (Array.isArray(rule.rules)) {
                rule.rules.forEach((r) => visit(r));
                return;
            }
            const source = String(rule.source || "").toLowerCase();
            if (source && source !== "tag") {
                found = true;
            }
        };
        visit(definition);
        return found;
    }

    private fileHasFrontmatterTag(file: TFile, tags: string[]): boolean {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter || {};
        const raw = fm.tags;
        if (!raw) return false;
        const values = Array.isArray(raw)
            ? raw.map(String)
            : String(raw).split(/[\s,]+/).filter(Boolean);
        const normalized = values.map((t) => this.normalizeTag(String(t)));
        return tags.some((tag) => normalized.includes(this.normalizeTag(tag)));
    }

    private getInlineTagLinesForTags(file: TFile, tags: string[]): { lineMap: Map<number, string>; allHidden: boolean } {
        const lineMap = new Map<number, string>();
        let anyInline = false;
        let anyVisible = false;
        let anyHidden = false;
        for (const tag of tags) {
            const inlineInfo = this.getInlineTagLines(file, tag);
            if (inlineInfo.hasInlineTag) {
                anyInline = true;
            }
            if (inlineInfo.isCrossedOut || inlineInfo.isFilteredOut) {
                anyHidden = true;
            }
            if (inlineInfo.lines.length > 0) {
                anyVisible = true;
                for (const lineItem of inlineInfo.lines) {
                    if (!lineItem?.text || lineItem.line < 0) continue;
                    lineMap.set(lineItem.line, lineItem.text);
                }
            }
        }
        return { lineMap, allHidden: anyInline && !anyVisible && anyHidden };
    }

    async onOpen() {
        this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
            if (evt.key === "Delete" || evt.key === "Backspace") {
                if (this.app.workspace.getActiveViewOfType(SmartExplorerView) !== this) return;

                // Exclude if user is renaming (check active rename or input focus)
                if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;

                const selectedFiles = this.getSelectedFiles();
                if (selectedFiles.length === 0) return;

                evt.preventDefault();
                new DeleteConfirmationModal(this.app, selectedFiles).open();
            }
        });

        // Ribbon actions
        this.addAction("plus", "Create New Note", async () => {
            try {
                const file = await this.createNoteUsingTemplate({
                    baseName: "New Note",
                    startRename: true,
                    clearName: true,
                    shouldOpen: true
                });
                if (file) new Notice("Note created");
            } catch (err) {
                console.error("Failed to create note:", err);
                new Notice("Failed to create note");
            }
        });

        const content = this.contentEl;
        content.empty();
        this.ensureDragDropStyles();

        const root = content.createDiv({ cls: "explorer2-root" });
        try {
            root.classList.add("nav-files-container");
        } catch { }

        this.headerEl = root.createDiv({ cls: "explorer2-header" });
        this.headerEl.style.display = "flex";
        this.listEl = root.createDiv({ cls: "explorer2-list" });

        this.clearSelection(true);
        this.listEl.addEventListener("click", (e) => {
            if (e.target === this.listEl) {
                this.clearSelection();
                this.lastSelectedPath = null;
            }
        });

        this.renderHeader();
        this.renderTree("");

        // Subscriptions
        this.registerEvent(this.app.vault.on("create", () => this.scheduleRenderRefresh()));
        this.registerEvent(this.app.vault.on("delete", () => this.scheduleRenderRefresh()));
        this.registerEvent(this.app.vault.on("rename", () => this.scheduleRenderRefresh()));
        const handleMetadataChange = (file: TFile) => {
            this.plugin.filterService?.invalidateFileCache(file.path);
            this.frontmatterCache.delete(file.path);
            this.fileTagCache.delete(file.path);
            for (const key of this.inlineTagLinesCache.keys()) {
                if (key.startsWith(`${file.path}::`)) {
                    this.inlineTagLinesCache.delete(key);
                }
            }
            for (const key of this.inlineTagLinesPending.values()) {
                if (key.startsWith(`${file.path}::`)) {
                    this.inlineTagLinesPending.delete(key);
                }
            }
            this.scheduleRenderRefresh();
        };

        this.registerEvent(
            this.app.workspace.on("editor-change", () => {
                this.lastEditorChangeAt = Date.now();
            })
        );

        this.registerEvent(
            this.app.metadataCache.on("changed", (file) => {
                const recentlyTyping = this.lastEditorChangeAt && Date.now() - this.lastEditorChangeAt < this.typingQuietWindowMs;
                if (recentlyTyping) {
                    return;
                }
                if (typeof (this.plugin as any)?.isEditorFocused === "function" && (this.plugin as any).isEditorFocused()) {
                    return;
                }
                handleMetadataChange(file);
            })
        );

        // Header styles injection
        let styles = document.getElementById("explorer2-header-styles");
        if (!styles) {
            styles = document.createElement("style");
            styles.id = "explorer2-header-styles";
            document.head.appendChild(styles);
        }
        styles.textContent = `
            .explorer2-root {
                display: flex !important;
                flex-direction: column !important;
                height: 100% !important;
                width: 100% !important;
                overflow: hidden !important;
            }
            .explorer2-header {
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                padding: 6px 4px !important;
                min-height: unset !important;
                flex-shrink: 0 !important;
                background-color: transparent !important;
                border: none !important;
                box-shadow: none !important;
                z-index: 10;
            }
            .explorer2-list {
                flex: 1 !important;
                overflow-y: auto !important;
                overflow-x: hidden !important;
                padding-bottom: 20px;
            }
            .explorer2-header-actions {
                display: flex;
                gap: 2px;
            }
            .explorer2-icon-btn {
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                border-radius: var(--radius-s);
                color: var(--text-muted);
                background: transparent !important;
                border: none !important;
                height: 26px;
                width: 26px;
                padding: 0;
            }
            .explorer2-row:not(:hover) .explorer2-icon-btn {
                opacity: 0;
                pointer-events: none;
            }
            .explorer2-row:hover .explorer2-icon-btn {
                opacity: 1;
                pointer-events: auto;
            }
            .explorer2-icon-btn:hover {
                color: var(--text-normal);
                background-color: var(--background-modifier-hover);
            }
            .explorer2-icon-btn svg {
                width: 18px;
                height: 18px;
            }
        `;
    }

    async onClose() {
        this.clearSelection(true);
        this.closeFileDetailMenu();
        if (this._superchargedFrame) {
            cancelAnimationFrame(this._superchargedFrame);
            this._superchargedFrame = null;
        }
        if (this._pendingRenameTimer) {
            clearTimeout(this._pendingRenameTimer);
            this._pendingRenameTimer = null;
        }
        this._pendingRename = null;
        if (this._scheduledRender) {
            clearTimeout(this._scheduledRender);
            this._scheduledRender = null;
        }
        this.cancelInlineRename();
    }

    renderTree(query: string) {
        if (!this.listEl) return;
        this.plugin.debugLog("renderTree", { filterQuery: query });

        if (this._scheduledRender) {
            clearTimeout(this._scheduledRender);
            this._scheduledRender = null;
        }

        this.cancelInlineRename();
        this.listEl.empty();
        this.filterQuery = query;
        this.sectionOrders = {};

        this.visualMatchCache.clear();
        this.serviceMatchCache.clear();
        this.sortValueCache.clear();
        this.folderCountCache.clear();
        this.folderFilterMatchCache.clear();

        this.renderHeader();
        try {
            this.renderTreeInternal(query);
            this.applySelectionToDOM();
        } catch (err) {
            console.error("Explorer 2 failed to render", err);
            const errorEl = this.listEl.createDiv({ text: "Explorer 2 failed to load." });
            errorEl.style.padding = "12px 16px";
            errorEl.style.color = "var(--text-muted)";
        }
    }

    scheduleRenderRefresh() {
        if (!this.listEl) return;

        if (this._scheduledRender) {
            clearTimeout(this._scheduledRender);
        }

        const recentlyTyping = this.lastEditorChangeAt && Date.now() - this.lastEditorChangeAt < this.typingQuietWindowMs;
        if (recentlyTyping) {
            return;
        }
        if (typeof (this.plugin as any)?.isEditorFocused === "function" && (this.plugin as any).isEditorFocused()) {
            return;
        }
        const delay = 500;

        this._scheduledRender = setTimeout(() => {
            this._scheduledRender = null;

            if (!this.containerEl?.isShown?.()) {
                return;
            }

            this.invalidateFilterMatches();
            try {
                this.renderTree(this.filterQuery);
            } catch (err) {
                console.warn("Explorer 2: scheduled render failed", err);
            }
        }, delay);
    }

    invalidateFilterMatches() {
        this.plugin.debugLog("invalidateFilterMatches");
        this.filterMatchVersion += 1;
        this.filterMatchesCache.clear();
        this.visualMatchVersion += 1;
        this.visualMatchCache.clear();
        this.serviceMatchCache.clear();
        this.fileTagCache.clear();
        this.frontmatterCache.clear();
        this.folderCountCache.clear();
        this.folderFilterMatchCache.clear();
        this.sortValueCache.clear();
    }

    getSelectedFiles(): TFile[] {
        const paths = this.getSelectedFilePaths();
        return paths.map(p => this.app.vault.getAbstractFileByPath(p)).filter(f => f instanceof TFile) as TFile[];
    }

    getSelectedFilePaths(): string[] {
        const selected = this.listEl?.querySelectorAll(".tree-item-self.explorer2-row.is-selected") || [];
        return Array.from(selected).map((el: any) => el.dataset.path).filter(Boolean);
    }

    clearSelection(skipDOM: boolean = false) {
        if (!skipDOM) {
            this.listEl?.querySelectorAll(".tree-item-self.explorer2-row.is-selected").forEach(el => {
                this.setRowSelected(el as HTMLElement, false);
            });
        }
    }

    toggleSelection(path: string, event: MouseEvent | null) {
        const isShift = !!event?.shiftKey;
        const isAdditive = !!(event?.ctrlKey || event?.metaKey);

        if (isShift) {
            if (!this.lastSelectedPath) {
                if (!isAdditive) this.clearSelection();
                this.addToSelection(path);
                this.lastSelectedPath = path;
                return;
            }
            if (!isAdditive) this.clearSelection();
            this.selectRange(this.lastSelectedPath, path);
            return;
        }

        if (!isAdditive) this.clearSelection();

        const item = this.listEl?.querySelector(`.tree-item-self.explorer2-row.explorer2-selectable[data-path="${path}"]`);
        if (item) {
            const shouldSelect = isAdditive ? !item.classList.contains("is-selected") : true;
            this.setRowSelected(item as HTMLElement, shouldSelect);
        }
        this.lastSelectedPath = path;
    }

    applySelectionToDOM() {
        // Selection state is currently stored in the DOM classes themselves
        // In the future we might want a backing set.
    }

    ensureRefreshSoon() {
        this.scheduleRenderRefresh();
    }

    renderHeader() {
        if (!this.headerEl) return;
        this.headerEl.empty();

        const actions = this.headerEl.createDiv({ cls: "explorer2-header-actions" });

        // New Note
        const addBtn = actions.createEl("button", {
            cls: "explorer2-icon-btn",
            attr: { "aria-label": "New note" }
        });
        setIcon(addBtn, "plus");
        addBtn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.quickAddNoteFromHeader();
        });

        // Collapse/Expand
        const isCollapsed = this.isExplorerMostlyCollapsed();
        const collapseBtn = actions.createEl("button", {
            cls: "explorer2-icon-btn",
            attr: { "aria-label": isCollapsed ? "Expand all" : "Collapse all" }
        });

        const collapseIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 19l4-4 4 4"/><path d="M8 5l4 4 4-4"/></svg>`;
        const expandIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3l4 4 4-4"/><path d="M8 21l4-4 4 4"/></svg>`;
        collapseBtn.innerHTML = isCollapsed ? expandIcon : collapseIcon;

        collapseBtn.addEventListener("click", () => {
            if (this.isExplorerMostlyCollapsed()) {
                this.expandAllItems();
            } else {
                this.plugin.state.collapsed = {};
            }
            this.plugin.savePluginState();
            this.plugin.refreshAllExplorers();
        });

        // Show/Hide Hidden
        const eyeBtn = actions.createEl("button", {
            cls: "explorer2-icon-btn",
            attr: { "aria-label": this.plugin.globallyShowHiddenItems ? "Hide Hidden Items" : "Show Hidden Items" }
        });

        const eyeOpen = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
        const eyeOff = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
        eyeBtn.innerHTML = this.plugin.globallyShowHiddenItems ? eyeOpen : eyeOff;

        eyeBtn.addEventListener("click", () => {
            this.plugin.globallyShowHiddenItems = !this.plugin.globallyShowHiddenItems;
            this.inlineTagLinesCache.clear();
            this.inlineTagLinesPending.clear();
            this.plugin.refreshAllExplorers();
        });
    }

    isExplorerMostlyCollapsed(): boolean {
        const collapsed = this.plugin.state.collapsed || {};
        const expandedCount = Object.values(collapsed).filter(v => v === false).length;
        return expandedCount < 2;
    }

    expandAllItems() {
        const collapsed: Record<string, boolean> = {};
        const sections = ["folders", "tags", "filters", "all-files", "untagged"];
        sections.forEach(s => collapsed[s] = false);

        const filterDefs = this.plugin.getFilterDefinitions?.() || [];
        filterDefs.forEach((f: any) => {
            if (f.id) collapsed[`filter:${f.id}`] = false;
        });

        const allTags = Object.keys((this.app.metadataCache as any).getTags?.() || {});
        allTags.forEach((tag: string) => {
            const tagKey = tag.startsWith("#") ? tag.substring(1) : tag;
            collapsed[tagKey] = false;
            collapsed[`tag:${tagKey}`] = false;
        });

        this.plugin.state.collapsed = { ...this.plugin.state.collapsed, ...collapsed };
    }

    async quickAddNoteFromHeader() {
        const result = await this.promptQuickAddNote();
        if (!result) return;
        try {
            const created = await this.createQuickAddNote(result);
            created && new Notice(`Created ${created.basename}`);
        } catch (err) {
            console.error("Explorer 2 quick add failed", err);
            new Notice("Unable to create note");
        }
    }

    private async promptQuickAddNote(): Promise<{ title: string; folderPath: string } | null> {
        const modal = new QuickAddNoteModal(this.app, {
            titlePlaceholder: "Title",
            folderOptions: this.getQuickAddTypeFolderOptions(),
        });

        return await new Promise<{ title: string; folderPath: string } | null>((resolve) => {
            const originalClose = modal.close.bind(modal);
            modal.close = () => {
                originalClose();
                resolve((modal as any).result);
            };
            modal.open();
        });
    }

    private async createQuickAddNote(result: { title: string; folderPath: string }): Promise<TFile | null> {
        return await this.createNoteUsingTemplate({
            baseName: result.title,
            targetFolderPath: result.folderPath || "",
            startRename: false,
            clearName: false,
            shouldOpen: true,
        });
    }

    private async applyTagsToFile(file: TFile, tags: string[]) {
        if (!tags.length) return;
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            fm.tags = this.mergeTagInputs(fm.tags, tags);
        });
    }

    private getQuickAddTypeFolderOptions(): Array<{ label: string; value: string }> {
        const root = this.app.vault.getRoot();
        const options: Array<{ label: string; value: string }> = [
            { label: "Default location", value: "" },
        ];

        const context = { sectionKey: "types" };
        const folders: TFolder[] = [];

        const collectFolders = (folder: TFolder) => {
            folders.push(folder);
            for (const child of folder.children) {
                if (child instanceof TFolder) collectFolders(child);
            }
        };
        collectFolders(root);

        const folderHasMarkdownDirect = (folder: TFolder): boolean => {
            for (const child of folder.children) {
                if (child instanceof TFile && child.extension === "md") return true;
            }
            return false;
        };

        const hasNotesDirect = new Map<TFolder, boolean>();
        for (const f of folders) hasNotesDirect.set(f, folderHasMarkdownDirect(f));

        const descendantHasNotesDirect = new Map<TFolder, boolean>();
        const computeDescendantFlag = (folder: TFolder): boolean => {
            if (descendantHasNotesDirect.has(folder)) return descendantHasNotesDirect.get(folder)!;
            let flag = false;
            for (const child of folder.children) {
                if (child instanceof TFolder) {
                    if (hasNotesDirect.get(child) || computeDescendantFlag(child)) {
                        flag = true;
                        break;
                    }
                }
            }
            descendantHasNotesDirect.set(folder, flag);
            return flag;
        };
        for (const f of folders) computeDescendantFlag(f);

        for (const f of folders) {
            if (f === root) continue;
            if ((this as any).isHidden(f, true, context)) continue;
            if (!f.path) continue;

            if (!hasNotesDirect.get(f)) continue;
            if (descendantHasNotesDirect.get(f)) continue;

            options.push({ label: f.path, value: f.path });
        }

        return [options[0], ...options.slice(1).sort((a, b) => a.label.localeCompare(b.label))];
    }


    renderTreeInternal(query: string) {
        if (!this.listEl) return;

        const root = this.app.vault.getRoot();
        const collapsed = this.plugin.state.collapsed || {};
        const fragment = document.createDocumentFragment();


        // 2. Filters Section
        this.renderFiltersSection(fragment, collapsed);

        // 3. Tags Section
        this.renderTagsSection(fragment, collapsed);

        // 4. Types Section
        this.renderTypesSection(fragment, root, collapsed);

        this.listEl.appendChild(fragment);
        this.applySuperchargedLinksStyling();
        this.tryApplyPendingRename();
    }


    private renderFiltersSection(container: DocumentFragment, collapsed: any) {
        const isCollapsed = collapsed["section:filters"] !== false;
        const filterDefs = this.plugin.getFilterDefinitions?.() || [];

        const filtersWithMatches = filterDefs.map((def: any) => {
            const matches = this.getCachedFilterFiles(def.definition, def.id);
            return { ...def, matches };
        });

        const totalMatches = filtersWithMatches.reduce((sum: number, f: any) => sum + f.matches.length, 0);

        const section = renderSection(container, {
            label: "Filters",
            key: "filters",
            collapsed: isCollapsed,
            badge: totalMatches,
            onToggle: () => {
                this.plugin.state.collapsed["section:filters"] = !isCollapsed;
                this.plugin.savePluginState();
                this.renderTree(this.filterQuery);
            }
        });

        if (section && !isCollapsed) {
            for (const filter of filtersWithMatches) {
                this.renderFilterItem(section.childrenEl, filter, 1, collapsed);
            }
        }
    }

    private renderFilterItem(container: HTMLElement, filter: any, depth: number, collapsed: any) {
        const filterKey = `filter:${filter.id}`;
        const isCollapsed = collapsed[filterKey] !== false;

        const item = renderTreeItem(container, {
            name: filter.name,
            path: `explorer2-filter://${filter.id}`,
            isFolder: true,
            isCollapsed: isCollapsed,
            depth: depth,
            iconId: filter.icon || "filter",
            badge: filter.matches.length,
            onCaretClick: () => {
                this.plugin.state.collapsed[filterKey] = !isCollapsed;
                this.plugin.savePluginState();
                this.renderTree(this.filterQuery);
            },
            onClick: () => {
                this.plugin.state.collapsed[filterKey] = !isCollapsed;
                this.plugin.savePluginState();
                this.renderTree(this.filterQuery);
            }
        });

        // Add Create Button ONLY if filter has BOTH template and folder configured
        const defaultFm = filter.definition?.defaultFrontmatter;
        if (defaultFm && defaultFm._targetFolder && defaultFm._templatePath) {
            const addBtn = document.createElement("div");
            addBtn.className = "explorer2-icon-btn";
            addBtn.style.marginRight = "6px";
            addBtn.setAttribute("aria-label", "Create new note");

            setIcon(addBtn, "plus");

            addBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                e.stopPropagation();

                const newName = await this.promptForName("New Note", "Untitled");
                if (!newName) return;

                this.createNoteUsingTemplate({
                    baseName: newName,
                    targetFolderPath: defaultFm._targetFolder,
                    templatePath: defaultFm._templatePath,
                    startRename: false,
                    shouldOpen: true
                });
            });

            const countEl = item.titleEl.querySelector(".explorer2-count");
            if (countEl) {
                item.titleEl.insertBefore(addBtn, countEl);
            } else {
                item.titleEl.appendChild(addBtn);
            }
        }

        if (!isCollapsed && item.childContainer) {
            const tagNeedles = this.getFilterTagValues(filter.definition);
            for (const file of filter.matches) {
                this.renderFileWithMatch(item.childContainer, file, depth + 1, filter.id, undefined, tagNeedles, filter.definition);
            }
        }
    }

    private renderFileWithMatch(
        container: HTMLElement,
        file: TFile,
        depth: number,
        filterId?: string,
        query?: string,
        inlineTags?: string[],
        filterDefinition?: any
    ) {
        const layering = this.evaluateFileLayering(file, query || this.filterQuery, filterId);
        if (!layering.isMatch) return;

        const visuals = this.resolveIconicFor(file.path, false, file);
        const normalizedTags = (inlineTags || [])
            .map((t) => this.normalizeTag(String(t)))
            .filter(Boolean);
        if (normalizedTags.length > 0) {
            const inlineInfo = this.getInlineTagLinesForTags(file, normalizedTags);
            const lineMap = inlineInfo.lineMap;
            if (lineMap.size > 0) {
                const inlineKey = `inline-filter:${filterId || "unknown"}:${file.path}`;
                const isInlineCollapsed = this.plugin.state.collapsed[inlineKey] !== false;
                const inlineBadge = lineMap.size;
                const inlineFolder = renderTreeItem(container, {
                    name: file.basename,
                    path: file.path,
                    isFolder: true,
                    isCollapsed: isInlineCollapsed,
                    depth: depth,
                    sectionKey: "filters",
                    iconId: visuals.id || "file",
                    badge: inlineBadge,
                    onCaretClick: () => {
                        this.plugin.state.collapsed[inlineKey] = !isInlineCollapsed;
                        this.plugin.savePluginState();
                        this.renderTree(this.filterQuery);
                    },
                    onClick: () => {
                        this.plugin.state.collapsed[inlineKey] = !isInlineCollapsed;
                        this.plugin.savePluginState();
                        this.renderTree(this.filterQuery);
                    },
                    onContextMenu: (e: MouseEvent) => {
                        const menu = new Menu();
                        const targets = this.getContextMenuTargets(file);
                        const targetFile = targets[0] ?? file;

                        if (targets.length > 1) {
                            this.app.workspace.trigger('files-menu', menu, targets, 'file-explorer');
                        } else {
                            this.app.workspace.trigger('file-menu', menu, targetFile, 'file-explorer');
                        }

                        menu.showAtMouseEvent(e);
                    }
                });

                if (!isInlineCollapsed && inlineFolder.childContainer) {
                    const lineItems = Array.from(lineMap.entries())
                        .map(([line, text]) => ({ line, text }))
                        .sort((a, b) => a.line - b.line);
                    for (const lineItem of lineItems) {
                        const displayText = this.sanitizeInlineTagDisplay(lineItem.text);
                        if (!displayText) continue;
                        renderTreeItem(inlineFolder.childContainer, {
                            name: displayText,
                            path: `${file.path}#L${lineItem.line + 1}`,
                            isFolder: false,
                            depth: depth + 1,
                            selectable: false,
                            itemType: "inline-tag-line",
                            iconId: "dot",
                            onClick: () => this.openFileAtLine(file, lineItem.line),
                        });
                    }
                }
                return;
            }
            const hasFrontmatterTag = this.fileHasFrontmatterTag(file, normalizedTags);
            if (!this.plugin?.globallyShowHiddenItems && inlineInfo.allHidden && !hasFrontmatterTag) {
                return;
            }
        }

        renderTreeItem(container, {
            name: file.basename,
            path: file.path,
            isFolder: false,
            isCollapsed: true,
            depth: depth,
            selectable: true,
            iconId: visuals.id,
            iconColor: visuals.color,
            textStyle: visuals.textStyle,
            fileRef: file,
            onClick: (e: MouseEvent) => {
                this.handleItemActivation(file, e);
            },
            onContextMenu: (e: MouseEvent) => {
                const menu = new Menu();
                const targets = this.getContextMenuTargets(file);
                const targetFile = targets[0] ?? file;

                if (targets.length > 1) {
                    this.app.workspace.trigger('files-menu', menu, targets, 'file-explorer');
                } else {
                    this.app.workspace.trigger('file-menu', menu, targetFile, 'file-explorer');
                }

                menu.showAtMouseEvent(e);
            }
        });
    }

    private renderTagsSection(container: DocumentFragment, collapsed: any) {
        const isCollapsed = collapsed["section:tags"] !== false;
        const tagTreeNodes = this.orderTagTree(this.getTagTreeNodes());

        let totalBadge = 0;
        tagTreeNodes.forEach(node => totalBadge += this.computeTagNodeCount(node));
        const untagged = this.getUntaggedFiles();
        totalBadge += untagged.length;

        const section = renderSection(container, {
            label: "Tags",
            key: "tags",
            collapsed: isCollapsed,
            badge: totalBadge,
            onToggle: () => {
                this.plugin.state.collapsed["section:tags"] = !isCollapsed;
                this.plugin.savePluginState();
                this.renderTree(this.filterQuery);
            }
        });

        if (section && !isCollapsed) {
            if (untagged.length > 0) {
                this.renderUntaggedNode(section.childrenEl, untagged, 1, collapsed);
            }
            for (const node of tagTreeNodes) {
                // Skip empty tags (no files and no children with files)
                if (this.computeTagNodeCount(node) === 0) continue;
                this.renderTagNodeRecursive(section.childrenEl, node, 1, collapsed);
            }
        }
    }

    private renderUntaggedNode(container: HTMLElement, files: TFile[], depth: number, collapsed: any) {
        const isCollapsed = collapsed["untagged"] !== false;
        const item = renderTreeItem(container, {
            name: "Untagged",
            path: "explorer2-tag://untagged",
            isFolder: true,
            isCollapsed: isCollapsed,
            depth: depth,
            iconId: "tag",
            badge: files.length,
            onCaretClick: () => {
                this.plugin.state.collapsed["untagged"] = !isCollapsed;
                this.plugin.savePluginState();
                this.renderTree(this.filterQuery);
            },
            onClick: () => {
                this.plugin.state.collapsed["untagged"] = !isCollapsed;
                this.plugin.savePluginState();
                this.renderTree(this.filterQuery);
            }
        });

        if (!isCollapsed && item.childContainer) {
            files.sort((a, b) => a.basename.localeCompare(b.basename));
            for (const file of files) {
                this.renderFileItem(item.childContainer, file, depth + 1);
            }
        }
    }

    private renderTagNodeRecursive(container: HTMLElement, node: any, depth: number, collapsed: any) {
        const tagKey = `tag:${node.fullTag}`;
        const isCollapsed = collapsed[tagKey] !== false;
        const badge = this.computeTagNodeCount(node);

        const item = renderTreeItem(container, {
            name: node.display,
            path: `explorer2-tag://${node.fullTag}`,
            isFolder: true,
            isCollapsed: isCollapsed,
            depth: depth,
            sectionKey: "tags",
            fullTag: node.fullTag,
            iconId: "tag",
            badge: badge,
            onCaretClick: () => {
                this.plugin.state.collapsed[tagKey] = !isCollapsed;
                this.plugin.savePluginState();
                this.renderTree(this.filterQuery);
            },
            onClick: () => {
                // CHANGED: Only toggle, don't open tag page
                this.plugin.state.collapsed[tagKey] = !isCollapsed;
                this.plugin.savePluginState();
                this.renderTree(this.filterQuery);
            },
            onContextMenu: (e: MouseEvent) => {
                const menu = new Menu();
                const normalizedTag = this.normalizeTag(node.fullTag);
                const displayTag = `#${normalizedTag}`;

                menu.addItem((item) =>
                    item
                        .setTitle(`New Note with ${displayTag}`)
                        .setIcon("file-plus")
                        .onClick(async () => {
                            const result = await this.promptQuickAddNote();
                            if (!result) return;
                            const created = await this.createQuickAddNote(result);
                            if (!created) return;
                            try {
                                await this.applyTagsToFile(created, [displayTag]);
                            } catch (err) {
                                console.error("Failed to apply tag to new note:", err);
                                new Notice(`Failed to apply ${displayTag}`);
                            }
                        })
                );

                // Rename tag (internal)
                menu.addItem((item) =>
                    item
                        .setTitle("Rename tag")
                        .setIcon("pencil")
                        .onClick(async () => {
                            await this.renameTag(normalizedTag);
                        })
                );

                // NEW: Add delete tag option
                menu.addItem((item) =>
                    item
                        .setTitle("Delete tag")
                        .setIcon("trash")
                        .onClick(async () => {
                            await this.deleteTag(node.fullTag);
                        })
                );

                menu.showAtMouseEvent(e);
            }
        });

        if (!isCollapsed && item.childContainer) {
            for (const child of node.children) {
                // Skip empty child tags
                if (this.computeTagNodeCount(child) === 0) continue;
                this.renderTagNodeRecursive(item.childContainer, child, depth + 1, collapsed);
            }
            const sortProfile = this.plugin.getProfileBuilderForContext("sort", { sectionKey: "tags" });
            const sortedFiles = [...node.files].filter((file) => {
                const info = this.getInlineTagDisplay(file, node.fullTag);
                if (!info.hasInlineTag) return true;
                if (info.title === "__CROSSED_OUT__" && this.plugin?.settings?.hideInlineTagCrossedOut !== false) return false;
                if (info.title === "__FILTERED__" && this.plugin?.settings?.hideInlineTagChecked !== false) return false;
                return true;
            }).sort((a, b) => {
                if (sortProfile && sortProfile.rules && sortProfile.rules.length > 0) {
                    const bucketA = this.findMatchingBucket(a, sortProfile);
                    const bucketB = this.findMatchingBucket(b, sortProfile);
                    if (bucketA !== bucketB) {
                        const indexA = bucketA ? this.getBucketIndex(bucketA, sortProfile) : 9999;
                        const indexB = bucketB ? this.getBucketIndex(bucketB, sortProfile) : 9999;
                        if (indexA !== indexB) return indexA - indexB;
                    }
                }

                const aInfo = this.getInlineTagDisplay(a, node.fullTag);
                const bInfo = this.getInlineTagDisplay(b, node.fullTag);
                if (aInfo.title === "__FILTERED__" && bInfo.title !== "__FILTERED__") return 1;
                if (aInfo.title !== "__FILTERED__" && bInfo.title === "__FILTERED__") return -1;
                if (aInfo.title === "__CROSSED_OUT__" && bInfo.title !== "__CROSSED_OUT__") return 1;
                if (aInfo.title !== "__CROSSED_OUT__" && bInfo.title === "__CROSSED_OUT__") return -1;
                if (aInfo.hasInlineTag && !bInfo.hasInlineTag) return -1;
                if (!aInfo.hasInlineTag && bInfo.hasInlineTag) return 1;
                const aTitle = (aInfo.title || a.basename).toLowerCase();
                const bTitle = (bInfo.title || b.basename).toLowerCase();
                return aTitle.localeCompare(bTitle);
            });
            for (const file of sortedFiles) {
                const inlineInfo = this.getInlineTagLines(file, node.fullTag);
                if (inlineInfo.isCrossedOut || inlineInfo.isFilteredOut) continue;

                if (inlineInfo.hasInlineTag) {
                    const inlineKey = `inline:${node.fullTag}:${file.path}`;
                    const isInlineCollapsed = this.plugin.state.collapsed[inlineKey] !== false;
                    const inlineBadge = inlineInfo.lines.length || undefined;

                    const inlineFolder = renderTreeItem(item.childContainer, {
                        name: file.basename,
                        path: file.path,
                        isFolder: true,
                        isCollapsed: isInlineCollapsed,
                        depth: depth + 1,
                        sectionKey: "tags",
                        iconId: "folder",
                        badge: inlineBadge,
                        onCaretClick: () => {
                            this.plugin.state.collapsed[inlineKey] = !isInlineCollapsed;
                            this.plugin.savePluginState();
                            this.renderTree(this.filterQuery);
                        },
                        onClick: () => {
                            this.plugin.state.collapsed[inlineKey] = !isInlineCollapsed;
                            this.plugin.savePluginState();
                            this.renderTree(this.filterQuery);
                        },
                        onContextMenu: (e: MouseEvent) => {
                            const menu = new Menu();
                            this.app.workspace.trigger("file-menu", menu, file, "file-explorer");
                            menu.showAtMouseEvent(e);
                        },
                    });

                    if (!isInlineCollapsed && inlineFolder.childContainer) {
                        const lineItems = inlineInfo.lines;
                        for (const lineItem of lineItems) {
                            if (!lineItem?.text) continue;
                            const displayText = this.sanitizeInlineTagDisplay(lineItem.text);
                            if (!displayText) continue;
                            renderTreeItem(inlineFolder.childContainer, {
                                name: displayText,
                                path: `${file.path}#L${lineItem.line + 1}`,
                                isFolder: false,
                                depth: depth + 2,
                                selectable: false,
                                itemType: "inline-tag-line",
                                iconId: "dot",
                                onClick: () => this.openFileAtLine(file, lineItem.line),
                            });
                        }
                    }
                    continue;
                }

                const displayName = this.getInlineTagDisplay(file, node.fullTag).title;
                if (displayName === "__CROSSED_OUT__") continue;
                if (displayName === "__FILTERED__") continue;
                this.renderFileItem(item.childContainer, file, depth + 1, {}, displayName);
            }
        }
    }

    private renderTypesSection(container: DocumentFragment, root: TFolder, collapsed: any) {
        const isCollapsed = collapsed["section:types"] !== false;
        const typesContext = { sectionKey: "types" };

        // Calculate badge as sum of visible subfolders + files in root
        let totalBadge = 0;
        for (const child of root.children as (TFolder | TFile)[]) {
            const isFolder = child instanceof TFolder;
            const hidden = this.isHidden(child, isFolder, typesContext);

            if (!hidden) {
                if (isFolder) {
                    totalBadge += this.countFolderFiles(child as TFolder, this.filterQuery, typesContext);
                } else if (!this.filterQuery || child.name.toLowerCase().includes(this.filterQuery.toLowerCase())) {
                    totalBadge++;
                }
            }
        }

        const section = renderSection(container, {
            label: "Types",
            key: "types",
            collapsed: isCollapsed,
            badge: totalBadge,
            onToggle: () => {
                this.plugin.state.collapsed["section:types"] = !isCollapsed;
                this.plugin.savePluginState();
                this.renderTree(this.filterQuery);
            }
        });

        if (section && !isCollapsed) {
            const folders = root.children.filter((child) => child instanceof TFolder) as TFolder[];
            const files = root.children.filter((child) => child instanceof TFile) as TFile[];
            folders.sort((a, b) => a.name.localeCompare(b.name));
            files.sort(this.createContextualComparator(root, typesContext));
            for (const child of [...folders, ...files]) {
                if (child instanceof TFolder) {
                    this.renderFolderRecursive(section.childrenEl, child as TFolder, 0, collapsed, typesContext);
                } else if (child instanceof TFile) {
                    this.renderFileItem(section.childrenEl, child as TFile, 0, typesContext);
                }
            }
        }
    }


    getCachedFilterFiles(definition: any, filterId: string): TFile[] {
        const key = filterId || JSON.stringify(definition);
        const cached = this.filterMatchesCache.get(key);
        if (cached && cached.version === this.filterMatchVersion) return cached.files;

        const files = this.getFilesMatchingFilter(definition, filterId);
        this.filterMatchesCache.set(key, { version: this.filterMatchVersion, files });
        return files;
    }

    getFilesMatchingFilter(definition: any, filterId: string) {
        try {
            const files = this.app.vault.getMarkdownFiles();
            const result: TFile[] = [];
            const context = { sectionKey: "filters", filterId };
            const matchedPaths = new Set<string>();
            const fileFilterMatches = new Set<string>();

            for (const file of files) {
                if (this.isHidden(file, false, context)) continue;
                if (this.plugin.filterService.evaluateFilterRule(file, definition)) {
                    result.push(file);
                    matchedPaths.add(file.path);
                    fileFilterMatches.add(file.path);
                }
            }

            (result as any)._fileFilterMatches = fileFilterMatches;

            // SORT THE RESULTS - Check multiple locations in priority order
            let sortRules = null;

            // Priority 1: Filter definition's own sort array
            if (definition && definition.sort && Array.isArray(definition.sort) && definition.sort.length > 0) {
                sortRules = definition.sort;
                console.log('[TPS-Filter-Sort] Using filter definition sort:', JSON.stringify(sortRules));
            }
            // Priority 2: Service config builders for this specific filter
            else if (filterId) {
                const filterBuilder = this.plugin.settings?.serviceConfig?.builders?.sort?.filters?.[filterId];
                if (filterBuilder && filterBuilder.sort && Array.isArray(filterBuilder.sort) && filterBuilder.sort.length > 0) {
                    sortRules = filterBuilder.sort;
                }
            }

            if (sortRules) {
                result.sort((a, b) => {
                    for (const sortDef of sortRules) {
                        const res = this.compareByField(a, b, sortDef);
                        if (res !== 0) return res;
                    }
                    return 0;
                });
            } else {
                // Priority 3: Use Full Profile Logic (Rule-based sorting)
                result.sort(this.createContextualComparator(null as any, context));
            }

            return result;
        } catch (err) {
            console.error("Explorer 2 filter evaluation failed", err);
            return [];
        }
    }


    renderFolderRecursive(container: HTMLElement, folder: TFolder, depth: number, collapsed: any, context: any = { sectionKey: "folders" }) {
        if (this.isHidden(folder, true, context)) return;

        const folderKey = folder.path;
        const isCollapsed = collapsed[folderKey] !== false;

        const item = renderTreeItem(container, {
            name: folder.name,
            path: folder.path,
            isFolder: true,
            isCollapsed: isCollapsed,
            depth: depth,
            sectionKey: context.sectionKey,
            iconId: "folder",
            badge: this.countFolderFiles(folder, this.filterQuery, context),
            onCaretClick: () => {
                this.plugin.state.collapsed[folderKey] = !isCollapsed;
                this.plugin.savePluginState();
                this.renderTree(this.filterQuery);
            },
            onClick: (e: MouseEvent) => {
                // Toggle on click, matching other sections
                this.plugin.state.collapsed[folderKey] = !isCollapsed;
                this.plugin.savePluginState();
                this.renderTree(this.filterQuery);
            },
            onContextMenu: (e: MouseEvent) => {
                // Build menu with native folder actions, then let other plugins extend
                const menu = new Menu();

                menu.addItem((item) =>
                    item
                        .setTitle("New Note")
                        .setIcon("file-plus")
                        .onClick(async () => {
                            const newName = await this.promptForName("New Note", "Untitled");
                            if (newName) {
                                await this.createNoteUsingTemplate({
                                    baseName: newName,
                                    targetFolderPath: folder.path,
                                    shouldOpen: true
                                });
                            }
                        })
                );

                if (context.sectionKey === "types") {
                    menu.addItem((item) =>
                        item
                            .setTitle("New Folder")
                            .setIcon("folder-plus")
                            .onClick(async () => {
                                const newName = await this.promptForName("New Folder", "New Folder");
                                if (!newName) return;
                                const parentPath = folder.path === "/" ? "" : folder.path;
                                const newPath = normalizePath(parentPath ? `${parentPath}/${newName}` : newName);
                                try {
                                    await this.app.vault.createFolder(newPath);
                                } catch (err) {
                                    new Notice(`Failed to create folder: ${newName}`);
                                    console.error("Failed to create folder:", err);
                                }
                            })
                    );
                }

                menu.addItem((item) =>
                    item
                        .setTitle("Rename")
                        .setIcon("pencil")
                        .onClick(async () => {
                            const newName = await this.promptForName("Rename folder", folder.name);
                            if (newName && newName !== folder.name) {
                                const parent = folder.parent ? folder.parent.path : "";
                                const newPath = normalizePath(parent ? `${parent}/${newName}` : newName);
                                await this.app.fileManager.renameFile(folder, newPath);
                            }
                        }),
                );

                menu.addItem((item) =>
                    item
                        .setTitle("Delete")
                        .setIcon("trash")
                        .onClick(() => {
                            new DeleteConfirmationModal(this.app, [folder]).open();
                        }),
                );

                menu.addSeparator();

                // Trigger file-menu event for Global Context Menu plugin and Obsidian defaults
                this.app.workspace.trigger("file-menu", menu, folder, "file-explorer");
                menu.showAtMouseEvent(e);
            }
        });

        if (!isCollapsed && item.childContainer) {
            const children = [...folder.children].sort(this.createContextualComparator(folder, context));
            for (const child of children) {
                if (child instanceof TFolder) {
                    this.renderFolderRecursive(item.childContainer, child, depth + 1, collapsed, context);
                } else if (child instanceof TFile) {
                    this.renderFileItem(item.childContainer, child, depth + 1, context);
                }
            }
        }
    }

    renderFileItem(container: HTMLElement, file: TFile, depth: number, context: any = {}, displayName?: string) {
        if (this.isHidden(file, false, context)) return;

        const visuals = this.getVisualMatchValue(file, context);

        renderTreeItem(container, {
            name: displayName || file.basename,
            path: file.path,
            isFolder: false,
            depth: depth,
            selectable: true,
            iconId: visuals.icon || "file",
            iconColor: visuals.color,
            textStyle: visuals.text,
            fileRef: file,
            onClick: (e: MouseEvent) => {
                this.handleItemActivation(file, e);
            },
            onContextMenu: (e: MouseEvent) => {
                const menu = new Menu();
                const targets = this.getContextMenuTargets(file);
                const targetFile = targets[0] ?? file;

                if (targets.length > 1) {
                    // Multi-select: trigger files-menu event
                    this.app.workspace.trigger('files-menu', menu, targets, 'file-explorer');
                } else {
                    // Single file: trigger file-menu event
                    this.app.workspace.trigger('file-menu', menu, targetFile, 'file-explorer');
                }

                menu.showAtMouseEvent(e);
            }
        });
    }

    handleItemActivation(item: TFolder | TFile, event: MouseEvent) {
        const multi = event.shiftKey || event.ctrlKey || event.metaKey;
        if (multi) {
            this.toggleSelection(item.path, event);
            return;
        }
        if (item instanceof TFile) {
            this.openFile(item);
        }

        // Defer selection UI updates to avoid blocking openFile
        requestAnimationFrame(() => {
            this.clearSelection();
            this.addToSelection(item.path);
            this.lastSelectedPath = item.path;
        });
    }

    addToSelection(path: string) {
        const item = this.listEl?.querySelector(`.tree-item-self.explorer2-row.explorer2-selectable[data-path="${path}"]`);
        if (item) this.setRowSelected(item as HTMLElement, true);
    }

    private selectRange(fromPath: string, toPath: string) {
        const rows = Array.from(
            this.listEl?.querySelectorAll(".tree-item-self.explorer2-row.explorer2-selectable") || [],
        ) as HTMLElement[];

        const fromIndex = rows.findIndex((row) => row.dataset.path === fromPath);
        const toIndex = rows.findIndex((row) => row.dataset.path === toPath);

        if (fromIndex === -1 || toIndex === -1) {
            this.addToSelection(toPath);
            return;
        }

        const [start, end] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
        for (let i = start; i <= end; i++) {
            this.setRowSelected(rows[i], true);
        }
    }

    private setRowSelected(row: HTMLElement, selected: boolean) {
        row.classList.toggle("is-selected", selected);
        const item = row.closest(".tree-item");
        if (item instanceof HTMLElement) {
            item.classList.toggle("explorer2-selected", selected);
        }
    }

    private getContextMenuTargets(primaryFile: TFile): TFile[] {
        const selectedFiles = this.getSelectedFiles();
        if (selectedFiles.length <= 1) {
            return [primaryFile];
        }

        // If the primary file is in the selection, use the full selection
        // Otherwise, just use the primary file (user right-clicked outside selection)
        const primaryInSelection = selectedFiles.some(f => f.path === primaryFile.path);
        return primaryInSelection ? selectedFiles : [primaryFile];
    }

    openFile(file: TFile) {
        const gcm = (this.app as any)?.plugins?.plugins?.['tps-global-context-menu'];
        if (gcm && typeof gcm.suppressViewModeSwitch === "function") {
            gcm.suppressViewModeSwitch(1500);
        }
        const leaf = this.app.workspace.getLeaf(false);
        leaf.openFile(file);
        this.app.workspace.revealLeaf(leaf);
    }

    openFileAtLine(file: TFile, line: number) {
        const gcm = (this.app as any)?.plugins?.plugins?.['tps-global-context-menu'];
        if (gcm && typeof gcm.suppressViewModeSwitch === "function") {
            gcm.suppressViewModeSwitch(1500);
        }
        const leaf = this.app.workspace.getLeaf(false);
        leaf.openFile(file, { eState: { line } });
    }

    // Evaluation Logic
    isHidden(item: TFolder | TFile, isFolder: boolean, context: any = {}): boolean {
        if (this.plugin.globallyShowHiddenItems) return false;

        // Internal/Private check
        if (item.name.startsWith(".")) return true;

        // Cache check
        const cacheKey = `hide:${isFolder ? "folder" : "file"}:${item.path}:${context.sectionKey || ""}:${context.filterId || ""}`;
        if (this.serviceMatchCache.has(cacheKey)) return this.serviceMatchCache.get(cacheKey);

        const check = () => {
            // Check specific builder assigned to this context
            const builder = this.plugin.getProfileBuilderForContext("hide", { ...context, scope: isFolder ? "folder" : "file" });
            if (builder && builder.active !== false) {
                return this.plugin.filterService.evaluateFilterRule(item, builder);
            }

            // Fallback to default hide config
            const hideConfig = this.plugin.settings?.serviceConfig?.builders?.hide;
            if (hideConfig?.default?.active !== false) {
                // If there's a specific section/filter config, use it
                let group = hideConfig.default;
                if (context.sectionKey && hideConfig.sections?.[context.sectionKey]) {
                    group = hideConfig.sections[context.sectionKey];
                } else if (context.filterId && hideConfig.filters?.[context.filterId]) {
                    group = hideConfig.filters[context.filterId];
                }

                if (group && group.active !== false) {
                    return matchServiceFilters(this, group, item, isFolder);
                }
            }

            // Check legacy folder exclusions
            const exclusions = this.plugin.settings?.folderExclusions || "";
            if (exclusions) {
                const paths = exclusions.split("\n").map(p => p.trim()).filter(Boolean);
                if (paths.some(p => item.path.startsWith(p))) return true;
            }

            return false;
        };

        const result = check();
        this.serviceMatchCache.set(cacheKey, result);
        return result;
    }

    getVisualMatchValue(file: TFile, context: any = {}): any {
        const cacheKey = `${file.path}:${context.sectionKey || ''}:${context.filterId || ''}`;
        const cached = this.visualMatchCache.get(cacheKey);
        if (cached) return cached;

        const result = { icon: "file", color: null as string | null, text: null as string | null };

        const effectiveContext = {
            ...context,
            scope: context.scope || "file",
        };

        const getLegacyBuilder = (type: string) => {
            const builders = this.plugin.settings?.serviceConfig?.builders?.[type];
            if (!builders) return null;

            if (effectiveContext.filterId && builders.filters?.[effectiveContext.filterId]) {
                return builders.filters[effectiveContext.filterId];
            }
            if (effectiveContext.sectionKey && builders.sections?.[effectiveContext.sectionKey]) {
                return builders.sections[effectiveContext.sectionKey];
            }

            if (effectiveContext.scope === "folder" && builders.folder) {
                return builders.folder;
            }
            if (effectiveContext.scope === "file" && builders.file) {
                return builders.file;
            }

            return builders.default;
        };

        const getBuilder = (type: string) => {
            const profileBuilder = this.plugin.getProfileBuilderForContext(type, effectiveContext);
            if (profileBuilder) return profileBuilder;
            return getLegacyBuilder(type);
        };

        // Check icon builder
        const iconBuilder = getBuilder("icon");
        if (iconBuilder && iconBuilder.active !== false) {
            const iconMatch = this.getBuilderVisualValue(file, iconBuilder);
            if (iconMatch) result.icon = iconMatch;
        }

        // Check color builder
        const colorBuilder = getBuilder("color");
        if (colorBuilder && colorBuilder.active !== false) {
            const colorMatch = this.getBuilderVisualValue(file, colorBuilder);
            if (colorMatch) result.color = colorMatch;
        }

        // Check text builder
        const textBuilder = getBuilder("text");
        if (textBuilder && textBuilder.active !== false) {
            const textMatch = this.getBuilderVisualValue(file, textBuilder);
            if (textMatch) result.text = textMatch;
        }

        this.visualMatchCache.set(cacheKey, result);
        return result;
    }

    getBuilderVisualValue(file: TFile, builder: any): string | null {
        if (!builder || !Array.isArray(builder.rules)) return null;

        for (const rule of builder.rules) {
            if (rule.type === "group") {
                // For groups, check if all conditions match, then return the group's visualValue
                const groupMatches = this.plugin.filterService.evaluateFilterRule(file, rule);
                if (groupMatches) {
                    // Return the group's visual value if it exists
                    if (rule.visualValue) {
                        return rule.visualValue;
                    }
                    // Otherwise recursively check nested groups
                    const nestedMatch = this.getBuilderVisualValue(file, rule);
                    if (nestedMatch) return nestedMatch;
                }
            } else if (rule.type === "condition") {
                // Check if this rule matches
                if (this.plugin.filterService.evaluateFilterRule(file, rule)) {
                    if (this.plugin.settings?.enableDebugLogging) {
                        console.log(`[Visual] Condition matched:`, rule, `visualValue:`, rule.visualValue);
                    }
                    // Return the visual value if it exists
                    return rule.visualValue || null;
                }
            }
        }

        return null;
    }

    createContextualComparator(folder: TFolder, context: any = {}): (a: any, b: any) => number {
        // Get the sort profile for this context
        const sortProfile = this.plugin.getProfileBuilderForContext("sort", context);

        return (a, b) => {
            // Folders first option
            if (this.sortMode.foldersFirst) {
                if (a instanceof TFolder && !(b instanceof TFolder)) return -1;
                if (!(a instanceof TFolder) && b instanceof TFolder) return 1;
            }

            // If we have a sort profile with rules, use bucket-based sorting
            if (sortProfile && sortProfile.rules && sortProfile.rules.length > 0) {
                const bucketA = this.findMatchingBucket(a, sortProfile);
                const bucketB = this.findMatchingBucket(b, sortProfile);

                // Different buckets - sort by bucket order
                if (bucketA !== bucketB) {
                    const indexA = bucketA ? this.getBucketIndex(bucketA, sortProfile) : 9999;
                    const indexB = bucketB ? this.getBucketIndex(bucketB, sortProfile) : 9999;
                    if (indexA !== indexB) return indexA - indexB;
                }

                // Same bucket - use bucket's sort definitions, or fall back to profile sort
                const bucket = bucketA;
                let sortRules = null;

                if (bucket && bucket.sort && Array.isArray(bucket.sort) && bucket.sort.length > 0) {
                    sortRules = bucket.sort;
                } else if (sortProfile.sort && Array.isArray(sortProfile.sort) && sortProfile.sort.length > 0) {
                    sortRules = sortProfile.sort;
                }

                if (sortRules) {
                    for (const sortDef of sortRules) {
                        const result = this.compareByField(a, b, sortDef);
                        if (result !== 0) return result;
                    }
                }
            }
            // Check if root profile has sort definitions (even without rules)
            else if (sortProfile && sortProfile.sort && Array.isArray(sortProfile.sort) && sortProfile.sort.length > 0) {
                for (const sortDef of sortProfile.sort) {
                    const result = this.compareByField(a, b, sortDef);
                    if (result !== 0) return result;
                }
            }

            // Fallback: name comparison
            return a.name.localeCompare(b.name);
        };
    }

    /**
     * Finds which bucket (group rule) the item matches in the sort profile
     */
    private findMatchingBucket(item: TFolder | TFile, profile: any): any {
        if (!profile || !profile.rules || !Array.isArray(profile.rules)) return null;

        for (const rule of profile.rules) {
            if (rule.type === "group") {
                // Check if file matches this group's conditions
                if (this.plugin.filterService.evaluateFilterRule(item, rule)) {
                    return rule;
                }
            }
        }
        return null;
    }

    /**
     * Gets the index of a bucket in the profile's rules array
     */
    private getBucketIndex(bucket: any, profile: any): number {
        if (!profile || !profile.rules || !bucket) return 9999;
        const index = profile.rules.indexOf(bucket);
        return index >= 0 ? index : 9999;
    }

    /**
     * Compares two items by a sort definition
     */
    private compareByField(a: TFolder | TFile, b: TFolder | TFile, sortDef: any): number {
        // Use new sorting engine
        const migratedDef = normalizeSortDef(sortDef);
        return this.sortEngine.compare(a, b, migratedDef);
    }

    /**
     * Extracts a sortable value from a file based on the sort definition
     */
    private getSortValue(item: TFolder | TFile, sortDef: any): any {
        const { keyType, key } = sortDef || {};

        // Folders get minimal info
        if (item instanceof TFolder) {
            switch (keyType) {
                case "name":
                    return item.name.toLowerCase();
                case "created":
                case "modified":
                    return 0; // Folders don't have stat in the same way
                default:
                    return item.name.toLowerCase();
            }
        }

        const file = item as TFile;

        switch (keyType) {
            case "name":
                return file.basename.toLowerCase();
            case "created":
                return file.stat?.ctime ?? 0;
            case "modified":
                return file.stat?.mtime ?? 0;
            case "frontmatter-date":
                if (!key) return 0;
                const dateFm = this.app.metadataCache.getFileCache(file)?.frontmatter;
                if (!dateFm) return 0;
                const dVal = dateFm[key];
                if (!dVal) return 0;
                if (dVal instanceof Date) return dVal.getTime();
                try {
                    const parsed = new Date(dVal);
                    if (!isNaN(parsed.getTime())) return parsed.getTime();
                } catch { }
                return 0;
            case "frontmatter":
                if (!key) return null;
                const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
                if (!fm) return null;
                const value = fm[key];

                // If user provided a custom sort order for this specific sort definition, use it
                if (Array.isArray(sortDef.customOrder) && sortDef.customOrder.length > 0) {
                    const normalizedValue = typeof value === "string" ? value.toLowerCase() : String(value).toLowerCase();
                    const index = sortDef.customOrder.findIndex((x: string) => x.toLowerCase() === normalizedValue);
                    if (index !== -1) {
                        return index;
                    }
                    // For items NOT in the custom order, return null so compareByField pushes them to the end
                    return null;
                }

                // Custom ranking for specific semantic fields
                if (key === "priority" && typeof value === "string") {
                    const normalized = value.toLowerCase();
                    if (PRIORITY_RANKS.hasOwnProperty(normalized)) {
                        return PRIORITY_RANKS[normalized];
                    }
                }
                if (key === "status" && typeof value === "string") {
                    const normalized = value.toLowerCase();
                    if (STATUS_RANKS.hasOwnProperty(normalized)) {
                        return STATUS_RANKS[normalized];
                    }
                }

                // Try to parse as date if it looks like one
                if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
                    const parsed = new Date(value);
                    if (!isNaN(parsed.getTime())) return parsed;
                }
                return value ?? null;
            default:
                return file.basename.toLowerCase();
        }
    }

    _collectTags(file: TFile): string[] {
        const cached = this.fileTagCache.get(file.path);
        if (cached) return cached;

        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter || {};
        const tags: string[] = [];

        if (cache?.tags) {
            tags.push(...cache.tags.map(t => String(t.tag)));
        }
        if (fm.tags) {
            if (Array.isArray(fm.tags)) {
                tags.push(...fm.tags.map(String));
            } else {
                const raw = String(fm.tags);
                const parts = raw.split(/[\s,]+/).filter(Boolean);
                tags.push(...(parts.length > 0 ? parts : [raw]));
            }
        }

        const normalized = tags.map((t: any) => this.normalizeTag(String(t))).filter(Boolean);
        const unique = Array.from(new Set(normalized));

        this.fileTagCache.set(file.path, unique);
        return unique;
    }

    async openContextMenuForFolder(folder: TFolder, event: MouseEvent) {
        const menu = new Menu();

        menu.addItem(item => {
            item.setTitle("New note")
                .setIcon("plus")
                .onClick(async () => {
                    await this.createNoteUsingTemplate({
                        targetFolderPath: folder.path,
                        startRename: true,
                        shouldOpen: true
                    });
                });
        });

        menu.addItem(item => {
            item.setTitle("New folder")
                .setIcon("folder-plus")
                .onClick(async () => {
                    const name = await this.promptForName("New folder", "Folder name");
                    if (name) {
                        const path = normalizePath(`${folder.path}/${name}`);
                        await this.app.vault.createFolder(path);
                    }
                });
        });

        menu.addSeparator();

        // Add native File Explorer folder actions for real vault folders
        menu.addItem((item) => {
            item
                .setTitle("Rename")
                .setIcon("pencil")
                .onClick(async () => {
                    const newName = await this.promptForName("Rename folder", folder.name);
                    if (newName && newName !== folder.name) {
                        const parent = folder.parent ? folder.parent.path : "";
                        const newPath = normalizePath(parent ? `${parent}/${newName}` : newName);
                        await this.app.fileManager.renameFile(folder, newPath);
                    }
                });
        });

        menu.addItem((item) => {
            item
                .setTitle("Delete")
                .setIcon("trash")
                .onClick(() => {
                    // Obsidian requires file array for delete modal
                    new DeleteConfirmationModal(this.app, [folder]).open();
                });
        });

        menu.showAtMouseEvent(event);
    }

    async openContextMenuForFile(file: TFile, event: MouseEvent) {
        const menu = new Menu();

        menu.addItem(item => {
            item.setTitle("Open")
                .setIcon("file-text")
                .onClick(() => this.openFile(file));
        });

        menu.addItem(item => {
            item.setTitle("Open in new tab")
                .setIcon("file-plus")
                .onClick(() => this.app.workspace.getLeaf('tab').openFile(file));
        });

        menu.addSeparator();

        menu.addItem(item => {
            item.setTitle("Rename")
                .setIcon("pencil")
                .onClick(async () => {
                    const newName = await this.promptForName("Rename file", file.basename);
                    if (newName && newName !== file.basename) {
                        const parent = file.parent ? file.parent.path : "";
                        const extension = file.extension ? `.${file.extension}` : "";
                        const newPath = normalizePath(parent ? `${parent}/${newName}${extension}` : `${newName}${extension}`);
                        await this.app.fileManager.renameFile(file, newPath);
                    }
                });
        });

        menu.addItem(item => {
            item.setTitle("Make a copy")
                .setIcon("copy")
                .onClick(async () => {
                    const parent = file.parent ? file.parent.path : "";
                    const extension = file.extension ? `.${file.extension}` : "";
                    const newPath = normalizePath(parent ? `${parent}/${file.basename} (Copy)${extension}` : `${file.basename} (Copy)${extension}`);
                    await this.app.vault.copy(file, newPath);
                });
        });

        menu.addItem(item => {
            item.setTitle("Delete")
                .setIcon("trash")
                .onClick(() => {
                    new DeleteConfirmationModal(this.app, [file]).open();
                });
        });

        menu.showAtMouseEvent(event);
    }

    async promptForName(title: string, placeholder: string): Promise<string | null> {
        return new Promise(resolve => {
            const modal = new NamePromptModal(this.app, title, placeholder);
            const originalClose = modal.close.bind(modal);
            modal.close = () => {
                originalClose();
                resolve((modal as any).result);
            };
            modal.open();
        });
    }

    async moveFileToFolder(file: TFile | TFolder, targetFolderPath: string): Promise<void> {
        const target = this.app.vault.getAbstractFileByPath(targetFolderPath);
        if (!(target instanceof TFolder)) {
            new Notice("Target folder not found.");
            return;
        }

        const baseName = file instanceof TFile ? file.basename : file.name;
        const extension = file instanceof TFile ? `.${file.extension}` : "";
        const newPath = normalizePath(
            targetFolderPath === "/" || targetFolderPath === ""
                ? `${baseName}${extension}`
                : `${targetFolderPath}/${baseName}${extension}`,
        );

        if (file.path === newPath) return;
        let finalPath = newPath;
        if (this.app.vault.getAbstractFileByPath(finalPath)) {
            let counter = 2;
            while (this.app.vault.getAbstractFileByPath(finalPath)) {
                finalPath = normalizePath(
                    targetFolderPath === "/" || targetFolderPath === ""
                        ? `${baseName} ${counter}${extension}`
                        : `${targetFolderPath}/${baseName} ${counter}${extension}`,
                );
                counter++;
            }
        }

        await this.app.fileManager.renameFile(file, finalPath);
        this.ensureRefreshSoon();
    }

    async bulkUpdateFrontmatter(files: TFile[], callback: (fm: any) => void) {
        for (const file of files) {
            if (file.extension !== "md") continue;
            await this.app.fileManager.processFrontMatter(file, callback);
        }
    }

    normalizeTag(tag: string): string {
        return tag.replace(/^#+/, "").trim().toLowerCase();
    }

    parseTagInput(raw: any): string[] {
        const values = Array.isArray(raw)
            ? raw.flatMap((value: any) => this.parseTagInput(value))
            : typeof raw === "string"
                ? raw.split(/[\s,]+/).filter(Boolean)
                : raw == null
                    ? []
                    : [String(raw)];
        const normalized = values
            .map((value: any) => this.normalizeTag(String(value)))
            .filter(Boolean);
        return Array.from(new Set(normalized));
    }

    mergeTagInputs(existing: any, incoming: any): string[] {
        return Array.from(new Set([...this.parseTagInput(existing), ...this.parseTagInput(incoming)]));
    }

    async revealTag(fullTag: string): Promise<void> {
        const normalized = this.normalizeTag(fullTag);
        if (!normalized) return;

        // Ensure tags section is expanded
        this.plugin.state.collapsed["section:tags"] = false;

        // Expand parent tag groups for nested tags (e.g., foo/bar)
        const parts = normalized.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            this.plugin.state.collapsed[`tag:${current}`] = false;
        }
        this.plugin.state.collapsed[`tag:${normalized}`] = false;

        this.plugin.savePluginState();
        this.renderTree(this.filterQuery || "");

        requestAnimationFrame(() => {
            const selector = `.tree-item[data-path="explorer2-tag://${normalized}"] .tree-item-self`;
            const target = this.containerEl?.querySelector(selector) as HTMLElement | null;
            if (target) {
                target.scrollIntoView({ block: "center" });
                target.classList.add("explorer2-selected");
                setTimeout(() => target.classList.remove("explorer2-selected"), 1200);
            }
        });
    }

    ensureDragDropStyles() {
        // Implementation for injecting drag and drop CSS
        let styles = document.getElementById("explorer2-drag-styles");
        if (!styles) {
            styles = document.createElement("style");
            styles.id = "explorer2-drag-styles";
            document.head.appendChild(styles);
        }
        styles.textContent = `
            .is-being-dragged-over {
                background-color: var(--background-modifier-hover);
                outline: 2px dashed var(--interactive-accent);
                outline-offset: -2px;
            }
            .explorer2-drag-image {
                background-color: var(--background-primary);
                border: 1px solid var(--border-color);
                padding: 4px 8px;
                border-radius: 4px;
                box-shadow: var(--shadow-s);
                pointer-events: none;
            }
        `;
    }

    closeFileDetailMenu() {
        if (this.activeMenuEl) {
            this.activeMenuEl.remove();
            this.activeMenuEl = null;
        }
        if (this.menuOutsideHandler) {
            document.removeEventListener("pointerdown", this.menuOutsideHandler, true);
            this.menuOutsideHandler = null;
        }
        if (this.menuKeyHandler) {
            document.removeEventListener("keydown", this.menuKeyHandler, true);
            this.menuKeyHandler = null;
        }
    }

    cancelInlineRename() {
        // Implementation for stopping an active rename
        if (this._activeRename) {
            this._activeRename.cleanup();
            this._activeRename = null;
        }
    }

    evaluateFileLayering(file: TFile, query: string, filterId: string = "") {
        try {
            let displayName = file.basename;
            let isMatch = true;
            let iconOverride = null;
            let colorOverride = null;
            let textOverride = null;
            if (query || filterId) {
                const lowerQuery = (query || "").toLowerCase();
                if (query && !file.name.toLowerCase().includes(lowerQuery)) {
                    isMatch = false;
                }
            }
            return { isMatch, displayName, iconOverride, colorOverride, textOverride, matchedLine: null };
        } catch (err) {
            console.error("evaluateFileLayering error", err);
            return { isMatch: true, displayName: file.basename, iconOverride: null, colorOverride: null, textOverride: null, matchedLine: null };
        }
    }

    async createNoteUsingTemplate(options: any): Promise<TFile | null> {
        const {
            baseName = "New Note",
            targetFolderPath = "",
            startRename = false,
            clearName = false,
            shouldOpen = true,
            templatePath = ""
        } = options;

        let folder = targetFolderPath
            ? this.app.vault.getAbstractFileByPath(targetFolderPath)
            : this.getFolderForCreation();

        if (!(folder instanceof TFolder)) folder = this.app.vault.getRoot();

        const preferTypeProfiles = this.shouldUseGcmTypeProfilesForNewNotes();
        const resolvedTemplatePath = (templatePath || "").trim();
        let templateFile: TFile | null = null;
        if (!preferTypeProfiles && resolvedTemplatePath) {
            templateFile = await this.resolveTemplateSelection(resolvedTemplatePath);
            if (!templateFile) return null;
        }

        const fileName = `${baseName}.md`;
        const filePath = normalizePath(folder.path === "/" ? fileName : `${folder.path}/${fileName}`);

        try {
            const file = await this.app.vault.create(filePath, "");
            if (preferTypeProfiles) {
                await this.applyGcmTypeProfileForNewFile(file);
            } else if (templateFile) {
                const processed = await this.processTemplate(templateFile, file);
                if (processed != null) {
                    await this.app.vault.modify(file, processed);
                } else {
                    try {
                        const fallback = await this.app.vault.read(templateFile);
                        await this.app.vault.modify(file, fallback);
                    } catch (err) {
                        console.error("Failed to read template:", err);
                    }
                }
            } else {
                await this.applyFolderTemplateIfEmpty(file, folder.path);
            }
            if (shouldOpen) await this.openFile(file);
            return file;
        } catch (err) {
            console.error("Failed to create note:", err);
            return null;
        }
    }

    private async applyFolderTemplateIfEmpty(file: TFile, folderPath: string): Promise<void> {
        if (this.shouldUseGcmTypeProfilesForNewNotes()) return;

        const templatePath = (this.plugin.settings?.newNoteTemplatePath || (this.plugin as any)?.data?.newNoteTemplatePath || "").trim();
        if (!templatePath) return;

        const templateFile = await this.resolveTemplateSelection(templatePath);
        if (!templateFile) return;

        const initial = await this.app.vault.read(file);
        if (initial.trim().length !== 0) return;

        const processed = await this.processTemplate(templateFile, file);
        if (processed != null) {
            await this.app.vault.modify(file, processed);
        } else {
            try {
                const fallback = await this.app.vault.read(templateFile);
                await this.app.vault.modify(file, fallback);
            } catch (err) {
                console.error("Failed to read folder template:", err);
            }
        }
    }

    private getGcmPlugin(): any | null {
        return (this.app as any)?.plugins?.plugins?.["tps-global-context-menu"] || null;
    }

    private shouldUseGcmTypeProfilesForNewNotes(): boolean {
        const gcm = this.getGcmPlugin();
        return Boolean(gcm?.settings?.enableTypeProfiles);
    }

    private async applyGcmTypeProfileForNewFile(file: TFile): Promise<boolean> {
        const gcm = this.getGcmPlugin();
        if (!gcm) return false;

        if (typeof gcm.applyTypeProfileForFile === "function") {
            try {
                await gcm.applyTypeProfileForFile(file, { source: "tps-file-created" });
                return true;
            } catch (err) {
                console.error("[TPS Smart Explorer] Failed to apply GCM type profile:", err);
                return false;
            }
        }

        try {
            this.app.workspace.trigger("tps-file-created" as any, file, { subtypeId: null });
            return true;
        } catch (err) {
            console.error("[TPS Smart Explorer] Failed to trigger tps-file-created event:", err);
            return false;
        }
    }

    async createFileInFolder(options: {
        baseName: string;
        extension: string;
        targetFolderPath?: string;
        shouldOpen?: boolean;
        content?: string;
    }): Promise<TFile | null> {
        const {
            baseName,
            extension,
            targetFolderPath = "",
            shouldOpen = true,
            content = ""
        } = options;

        let folder = targetFolderPath
            ? this.app.vault.getAbstractFileByPath(targetFolderPath)
            : this.getFolderForCreation();

        if (!(folder instanceof TFolder)) folder = this.app.vault.getRoot();

        const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
        const fileName = baseName.endsWith(normalizedExtension)
            ? baseName
            : `${baseName}${normalizedExtension}`;
        const filePath = normalizePath(folder.path === "/" ? fileName : `${folder.path}/${fileName}`);

        try {
            const file = await this.app.vault.create(filePath, content);
            if (shouldOpen) await this.openFile(file);
            return file;
        } catch (err) {
            new Notice(`Failed to create ${fileName}`);
            console.error("Failed to create file:", err);
            return null;
        }
    }

    private resolveTemplateFile(templatePath: string): TFile | null {
        const normalized = normalizePath(templatePath);
        const direct = this.app.vault.getAbstractFileByPath(normalized);
        if (direct instanceof TFile) return direct;

        if (!normalized.toLowerCase().endsWith(".md")) {
            const fallback = this.app.vault.getAbstractFileByPath(`${normalized}.md`);
            if (fallback instanceof TFile) return fallback;
        }

        return null;
    }

    private async resolveTemplateSelection(templatePath: string): Promise<TFile | null> {
        const normalized = normalizePath(templatePath);
        const direct = this.app.vault.getAbstractFileByPath(normalized);
        if (direct instanceof TFile) return direct;
        if (direct instanceof TFolder) {
            return await this.pickTemplateFromFolder(direct.path);
        }
        if (!normalized.toLowerCase().endsWith(".md")) {
            const fallback = this.app.vault.getAbstractFileByPath(`${normalized}.md`);
            if (fallback instanceof TFile) return fallback;
        }
        if (normalized.endsWith("/")) {
            const folder = this.app.vault.getAbstractFileByPath(normalized.replace(/\/+$/, ""));
            if (folder instanceof TFolder) {
                return await this.pickTemplateFromFolder(folder.path);
            }
        }
        console.warn("Template file not found:", normalized);
        new Notice("Template file not found.");
        return null;
    }

    private async pickTemplateFromFolder(folderPath: string): Promise<TFile | null> {
        const files = this.app.vault.getMarkdownFiles()
            .filter(f => f.path.startsWith(`${folderPath}/`));
        if (!files.length) {
            new Notice("No templates found in selected folder.");
            return null;
        }
        return await new Promise((resolve) => {
            new TemplateFileSuggest(this.app, files, resolve).open();
        });
    }

    private async processTemplate(templateFile: TFile, targetFile: TFile): Promise<string | null> {
        try {
            const raw = await this.app.vault.read(templateFile);
            return applyTemplateVars(raw, buildTemplateVars(targetFile));
        } catch (e) {
            console.error("[TPS Smart Explorer] Template processing failed:", e);
            new Notice("Failed to process template.");
            return null;
        }
    }

    getFolderForCreation(): TFolder {
        return this.app.vault.getRoot();
    }

    extractPropertiesFromFilter(filterId: string) {
        const filterDef = this.plugin.getFilterDefinitions().find((f: any) => f.id === filterId);
        if (!filterDef || !filterDef.definition) return null;

        const props = {
            tags: [] as string[],
            folder: null as string | null,
            frontmatter: {} as Record<string, any>
        };

        const processRules = (rules: any[]) => {
            for (const rule of rules) {
                if (rule.type === "group" && Array.isArray(rule.rules)) {
                    processRules(rule.rules);
                    continue;
                }

                if (rule.type !== "condition" || !rule.value) continue;

                const source = (rule.source || "frontmatter").toLowerCase();
                const operator = (rule.operator || "is").toLowerCase();
                const field = rule.field?.trim();

                if (["!=", "!is", "!contains", "!exists", "does not contain", "is not"].includes(operator)) continue;

                if (source === "tag") {
                    const values = Array.isArray(rule.value) ? rule.value : [rule.value];
                    for (const val of values) {
                        const normalized = String(val).trim().replace(/^#/, '');
                        if (normalized && !props.tags.includes(normalized)) {
                            props.tags.push(normalized);
                        }
                    }
                } else if (source === "folder" || source === "path") {
                    if (!props.folder && typeof rule.value === "string") {
                        let folderPath = rule.value.trim();
                        if (operator === "starts" || operator === "starts with" || operator === "is" || operator === "contains") {
                            props.folder = folderPath;
                        }
                        if (props.folder) {
                            props.folder = props.folder.replace(/\/$/, '');
                        }
                    }
                } else if (source === "frontmatter" && field) {
                    if (field === "title") continue;
                    if (operator === "exists") {
                        if (!props.frontmatter[field]) {
                            props.frontmatter[field] = "";
                        }
                    } else if (["is", "contains", "starts", "ends", "matches"].includes(operator)) {
                        const value = Array.isArray(rule.value) && rule.value.length === 1
                            ? rule.value[0]
                            : rule.value;
                        props.frontmatter[field] = value;
                    }
                } else if (source === "date" && field) {
                    if (operator === "exists") {
                        props.frontmatter[field] = "";
                    } else if (["is", "on", "after", "before", ">=", "<="].includes(operator)) {
                        let val = rule.value;
                        if (typeof val === "string") {
                            const lower = val.toLowerCase();
                            // const { moment } = require("obsidian");
                            if (lower === "today") val = (window as any).moment().format("YYYY-MM-DDTHH:mm:ss");
                            else if (lower === "yesterday") val = (window as any).moment().subtract(1, "days").format("YYYY-MM-DDTHH:mm:ss");
                            else if (lower === "tomorrow") val = (window as any).moment().add(1, "days").format("YYYY-MM-DDTHH:mm:ss");
                        }
                        props.frontmatter[field] = val;
                    }
                }
            }
        };

        const rules = filterDef.definition.rules || [];
        processRules(rules);

        return props;
    }

    getFileDisplayName(file: TFile): string {
        return file.basename;
    }

    resolveIconicFor(path: string, isFolder: boolean, ref: any = null): any {
        // Implementation for icon/color/style resolution based on Iconic or internal rules
        const visuals = isFolder ? { icon: "folder", color: null } : this.getVisualMatchValue(ref || this.app.vault.getAbstractFileByPath(path));
        return {
            id: visuals.icon,
            color: visuals.color,
            textStyle: visuals.text
        };
    }

    countFolderFiles(folder: TFolder, query: string = "", context: any = {}): number {
        // We use a composite key for caching because isHidden depends on context
        const cacheKey = `count:${folder.path}:${context.sectionKey || ""}:${context.filterId || ""}:${query || ""}`;
        const cached = this.folderCountCache.get(cacheKey);
        if (cached !== undefined) return cached;

        let count = 0;
        const recursive = (f: TFolder) => {
            // Only skip subfolders if they are hidden in this context
            if (f !== folder && this.isHidden(f, true, context)) return;

            for (const child of f.children) {
                if (child instanceof TFile) {
                    if (!this.isHidden(child, false, context)) {
                        if (!query || child.name.toLowerCase().includes(query.toLowerCase())) {
                            count++;
                        }
                    }
                } else if (child instanceof TFolder) {
                    recursive(child);
                }
            }
        };
        recursive(folder);

        this.folderCountCache.set(cacheKey, count);
        return count;
    }

    collectFrontmatterTags(file: TFile): string[] {
        return this._collectTags(file);
    }

    getUntaggedFiles(): TFile[] {
        const markdownFiles = this.app.vault.getMarkdownFiles();
        return markdownFiles.filter(file => {
            if (this.isHidden(file, false)) return false;
            const tags = this._collectTags(file);
            return tags.length === 0;
        });
    }

    getTagTreeNodes(): any[] {
        const rootNodes: any[] = [];
        const tagMap: Map<string, any> = new Map();

        const getOrCreateNode = (fullTag: string) => {
            if (tagMap.has(fullTag)) return tagMap.get(fullTag);

            const parts = fullTag.split("/");
            const display = parts[parts.length - 1];
            const node = {
                display,
                fullTag,
                children: [],
                files: [],
                lines: []
            };
            tagMap.set(fullTag, node);

            if (parts.length > 1) {
                const parentTag = parts.slice(0, -1).join("/");
                const parentNode = getOrCreateNode(parentTag);
                parentNode.children.push(node);
            } else {
                rootNodes.push(node);
            }
            return node;
        };

        const markdownFiles = this.app.vault.getMarkdownFiles();
        for (const file of markdownFiles) {
            if (this.isHidden(file, false)) continue;
            const tags = this._collectTags(file);
            for (const tag of tags) {
                // Skip if this file is the tag page for this tag
                if (this.isTagNoteForTag(file, tag)) continue;

                const parts = tag.split("/").filter(Boolean);
                let current = "";
                for (const part of parts) {
                    current = current ? `${current}/${part}` : part;
                    const node = getOrCreateNode(current);
                    if (!node._fileSet) {
                        node._fileSet = new Set<string>();
                    }
                    if (!node._fileSet.has(file.path)) {
                        node._fileSet.add(file.path);
                        node.files.push(file);
                    }
                }
            }

        }

        return rootNodes;
    }

    private isTagNoteForTag(file: TFile, tag: string): boolean {
        void file;
        void tag;
        return false;
    }

    orderTagTree(nodes: any[]): any[] {
        nodes.sort((a, b) => a.display.localeCompare(b.display));
        for (const node of nodes) {
            if (node.children.length > 0) this.orderTagTree(node.children);
        }
        return nodes;
    }

    computeTagNodeCount(node: any): number {
        let count = 0;
        for (const file of node.files) {
            const inlineInfo = this.getInlineTagLines(file, node.fullTag);
            if (inlineInfo.isCrossedOut && this.plugin?.settings?.hideInlineTagCrossedOut !== false) {
                continue;
            }
            if (inlineInfo.isFilteredOut && this.plugin?.settings?.hideInlineTagChecked !== false) {
                continue;
            }
            if (inlineInfo.hasInlineTag && inlineInfo.lines.length > 0) {
                count += inlineInfo.lines.length;
            } else {
                count += 1;
            }
        }

        for (const child of node.children) {
            count += this.computeTagNodeCount(child);
        }
        return count;
    }

    registerSectionItem(section: string, path: string) {
        if (!this.sectionOrders[section]) this.sectionOrders[section] = [];
        this.sectionOrders[section].push(path);
    }

    applySuperchargedLinksStyling() {
        // Supercharged Links integration
        const plugin = (this.app as any).plugins?.plugins?.["supercharged-links-obsidian"];
        if (plugin?.updateContainer && this.containerEl) {
            if (this._superchargedFrame) cancelAnimationFrame(this._superchargedFrame);
            this._superchargedFrame = requestAnimationFrame(() => {
                try {
                    plugin.updateContainer(this.containerEl, plugin, ".explorer2-name");
                } catch { }
                this._superchargedFrame = null;
            });
        }
    }

    tryApplyPendingRename() {
        if (this._pendingRename) {
            const { path, options } = this._pendingRename;
            this._pendingRename = null;
            // logic for triggering inline rename
        }
    }

    private async deleteTag(tag: string): Promise<void> {
        const normalizedTag = this.normalizeTag(tag);
        const displayTag = `#${normalizedTag}`;

        // Count how many notes have this tag
        const taggedFiles = this.getAllFilesWithTag(normalizedTag);
        const count = taggedFiles.length;

        // Confirmation dialog
        const confirmed = await this.showDeleteTagConfirmation(displayTag, count);
        if (!confirmed) return;

        try {
            // Remove tag from all notes
            let removedCount = 0;
            for (const file of taggedFiles) {
                const success = await this.removeTagFromFile(file, displayTag);
                if (success) removedCount++;
            }

            new Notice(`Deleted ${displayTag}: removed from ${removedCount} note(s)`);

            // 3. Refresh the view
            this.renderTree(this.filterQuery);
        } catch (err) {
            console.error("Failed to delete tag:", err);
            new Notice(`Failed to delete ${displayTag}`);
        }
    }

    private async renameTag(tag: string): Promise<void> {
        const normalizedTag = this.normalizeTag(tag);
        const displayTag = `#${normalizedTag}`;
        const newName = await this.promptForName("Rename tag", displayTag);
        if (!newName) return;
        const normalizedNew = this.normalizeTag(newName);
        if (!normalizedNew || normalizedNew === normalizedTag) return;

        const taggedFiles = this.getAllFilesWithTag(normalizedTag);
        const oldDisplay = `#${normalizedTag}`;
        const newDisplay = `#${normalizedNew}`;

        try {
            let updatedCount = 0;
            for (const file of taggedFiles) {
                const removed = await this.removeTagFromFile(file, oldDisplay);
                if (removed) {
                    await this.applyTagsToFile(file, [newDisplay]);
                    updatedCount++;
                }
            }

            new Notice(`Renamed ${oldDisplay} → ${newDisplay} (${updatedCount} note(s))`);
            this.renderTree(this.filterQuery);
        } catch (err) {
            console.error("Failed to rename tag:", err);
            new Notice(`Failed to rename ${displayTag}`);
        }
    }

    private async showDeleteTagConfirmation(tag: string, count: number): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText("Delete Tag");

            const content = modal.contentEl;
            content.createEl("p", {
                text: `Are you sure you want to delete ${tag}?`
            });
            content.createEl("p", {
                text: `This will remove the tag from ${count} note(s).`,
                cls: "mod-warning"
            });

            const buttonContainer = content.createDiv({ cls: "modal-button-container" });

            const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
            cancelBtn.addEventListener("click", () => {
                modal.close();
                resolve(false);
            });

            const deleteBtn = buttonContainer.createEl("button", {
                text: "Delete Tag",
                cls: "mod-warning"
            });
            deleteBtn.addEventListener("click", () => {
                modal.close();
                resolve(true);
            });

            modal.open();
        });
    }

    private getAllFilesWithTag(tag: string): TFile[] {
        const files: TFile[] = [];
        const allFiles = this.app.vault.getMarkdownFiles();

        for (const file of allFiles) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache) continue;

            // Check frontmatter tags
            const fmTags = cache.frontmatter?.tags || [];
            const fmTagsArray = Array.isArray(fmTags) ? fmTags : [fmTags];
            const hasFmTag = fmTagsArray.some((t: string) =>
                this.normalizeTag(String(t)) === tag
            );

            // Check inline tags
            const inlineTags = cache.tags || [];
            const hasInlineTag = inlineTags.some((t: any) =>
                this.normalizeTag(t.tag) === tag
            );

            if (hasFmTag || hasInlineTag) {
                files.push(file);
            }
        }

        return files;
    }

    private async ensureFolderExists(path: string): Promise<void> {
        if (!path || path === "/") return;
        const existing = this.app.vault.getAbstractFileByPath(path);
        if (existing && existing instanceof TFolder) return;
        await this.app.vault.createFolder(path);
    }

    private async removeTagFromFile(file: TFile, tag: string): Promise<boolean> {
        if (file.extension !== "md") return false;
        try {
            const normalizedTag = this.normalizeTag(tag);
            let modified = false;

            // Remove from frontmatter
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                if (fm.tags) {
                    const tags = this.parseTagInput(fm.tags);
                    const filtered = tags.filter((t: string) =>
                        this.normalizeTag(String(t)) !== normalizedTag
                    );
                    if (filtered.length !== tags.length) {
                        fm.tags = filtered.length > 0 ? filtered : undefined;
                        modified = true;
                    }
                }
            });

            // Remove inline tags
            let content = await this.app.vault.read(file);
            const regex = new RegExp(`#${normalizedTag.replace(/\//g, "\\/")}(?![\\w/-])`, "g");
            const newContent = content.replace(regex, "");

            if (newContent !== content) {
                await this.app.vault.modify(file, newContent);
                modified = true;
            }

            return modified;
        } catch (err) {
            console.error(`Failed to remove tag from ${file.path}:`, err);
            return false;
        }
    }

}
