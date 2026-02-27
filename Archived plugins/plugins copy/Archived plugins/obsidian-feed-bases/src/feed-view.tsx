import {
  App,
  BasesEntry,
  BasesPropertyId,
  BasesView,
  Menu,
  Modal,
  Notice,
  QueryController,
  TFile,
  TFolder,
  EventRef,
  normalizePath,
  MarkdownView,
} from "obsidian";
import { createRoot, Root } from "react-dom/client";
import { FeedReactView, FeedItem } from "./FeedReactView";
import { AppContext } from "./context";
import * as logger from "./logger";
import { applyTemplateVars, buildTemplateVars } from "./template-variable-service";

export const FeedViewType = "feed";
export const NoteViewType = "note";

type UnknownRecord = Record<string, unknown>;
type ViewConfigLike = {
  getGroup?: () => unknown;
  get?: (key: string) => unknown;
  group?: unknown;
  groups?: unknown;
  source?: { group?: unknown; groups?: unknown };
  groupBy?: unknown;
  filtersAll?: unknown;
  filters?: unknown;
  viewFilters?: unknown;
};
type TruthyLike = { isTruthy?: () => boolean; valueOf?: () => unknown };
type FileManagerLike = {
  getNewFileParent: (path: string) => { path: string };
};
function getTemplaterRoot(app: App): string | null {
  const pluginMap = (app as App & { plugins?: { plugins?: Record<string, unknown> } }).plugins?.plugins;
  const templater = pluginMap?.["templater-obsidian"] as { settings?: { templates_folder?: string } } | undefined;
  const folder = templater?.settings?.templates_folder;
  if (typeof folder === "string" && folder.trim()) {
    return normalizePath(folder.trim());
  }
  return "System/Templates";
}

async function resolveTemplateFile(app: App, path: string | null): Promise<TFile | null> {
  if (!path) return null;
  const normalized = normalizePath(path);
  const direct = app.vault.getAbstractFileByPath(normalized);
  if (direct instanceof TFile) return direct;
  if (!normalized.toLowerCase().endsWith(".md")) {
    const fallback = app.vault.getAbstractFileByPath(`${normalized}.md`);
    if (fallback instanceof TFile) return fallback;
  }
  const templaterRoot = getTemplaterRoot(app);
  if (templaterRoot) {
    const joined = app.vault.getAbstractFileByPath(`${templaterRoot}/${normalized}`);
    if (joined instanceof TFile) return joined;
    if (!normalized.toLowerCase().endsWith(".md")) {
      const joinedFallback = app.vault.getAbstractFileByPath(`${templaterRoot}/${normalized}.md`);
      if (joinedFallback instanceof TFile) return joinedFallback;
    }
    const basename = normalized.split("/").pop();
    if (basename) {
      const matches = app.vault.getMarkdownFiles().filter((f) =>
        f.path.startsWith(templaterRoot + "/") &&
        (f.basename === basename || f.name === basename || f.name === `${basename}.md`)
      );
      if (matches.length === 1) return matches[0];
    }
  }
  return null;
}

async function processTemplate(app: App, templateFile: TFile, targetFile: TFile | null): Promise<string | null> {
  try {
    const raw = await app.vault.read(templateFile);
    return applyTemplateVars(raw, buildTemplateVars(targetFile));
  } catch (e) {
    logger.warn("Template processing failed", e);
    return null;
  }
}

export class FeedView extends BasesView {
  type = FeedViewType;
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  root: Root | null = null;

  private items: FeedItem[] = [];
  protected integratedMode = false;
  protected manualOrderEnabled = false;
  private pendingUpdate = false;
  private flushScheduled = false;
  private isEditingInView = false;
  private renderLocked = false;
  private pendingRender = false;
  private updateDebounceTimer: number | null = null;
  private readonly UPDATE_DEBOUNCE_MS = 2000;

  constructor(controller: QueryController, scrollEl: HTMLElement) {
    super(controller);
    this.scrollEl = scrollEl;
    this.containerEl = scrollEl.createDiv({
      cls: "bases-feed-container is-loading",
      attr: { tabIndex: 0 },
    });

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.flushPendingUpdate();
      }),
    );

    this.registerDomEvent(document, "focusin", () => {
      this.flushPendingUpdate();
    });

    this.registerDomEvent(this.containerEl, "focusin", (evt) => {
      const target = evt.target as HTMLElement | null;
      if (target?.closest(".bases-feed-entry-editor")) {
        this.markEditorActivity();
      }
    });

    this.registerDomEvent(this.containerEl, "focusout", () => {
      window.setTimeout(() => {
        const active = document.activeElement as HTMLElement | null;
        const stillInEditor = !!active?.closest(".bases-feed-entry-editor");
        this.isEditingInView = stillInEditor;
        this.renderLocked = stillInEditor;
        if (!stillInEditor) {
          this.scheduleDebouncedUpdate();
          this.flushPendingUpdate();
          if (this.pendingRender) {
            this.pendingRender = false;
            this.renderReactFeed();
          }
        }
      }, 0);
    });

    this.registerDomEvent(document, "selectionchange", () => {
      const selection = document.getSelection();
      const anchorNode = selection?.anchorNode;
      if (!anchorNode) return;
      const anchorEl =
        anchorNode instanceof HTMLElement ? anchorNode : anchorNode.parentElement;
      if (!anchorEl) return;
      if (!this.containerEl.contains(anchorEl)) return;
      if (!anchorEl.closest(".bases-feed-entry-editor")) return;
      this.markEditorActivity();
    });

    // @ts-ignore - editor-change is emitted by Obsidian but not in type defs
    this.registerEvent(
      (this.app.workspace as unknown as { on: (event: string, cb: (view: MarkdownView) => void) => EventRef }).on("editor-change", (view: MarkdownView) => {
        if (!view?.containerEl) return;
        if (!this.containerEl.contains(view.containerEl)) return;
        this.markEditorActivity();
      }),
    );
  }

  onload(): void {
    // React components will handle their own lifecycle
  }

  onunload() {
    if (this.updateDebounceTimer) {
      window.clearTimeout(this.updateDebounceTimer);
      this.updateDebounceTimer = null;
    }
    if (this.root) {
      this.root.unmount();
      this.root = null;
    }
    this.items = [];
  }

  onResize(): void {
    // Feed view should adapt to resizing automatically
  }

  public focus(): void {
    this.containerEl.focus({ preventScroll: true });
  }

  public onDataUpdated(): void {
    this.containerEl.removeClass("is-loading");
    this.pendingUpdate = true;
    if (this.isEditorFocusedInView()) return;
    this.scheduleDebouncedUpdate();
  }

  private isEditorFocusedInView(): boolean {
    if (this.isEditingInView) return true;
    const active = document.activeElement as HTMLElement | null;
    if (!active) return false;
    if (!this.containerEl.contains(active)) return false;
    const isInput =
      active.tagName === "INPUT" ||
      active.tagName === "TEXTAREA" ||
      active.isContentEditable;
    const inEditor =
      !!active.closest(".markdown-source-view") ||
      !!active.closest(".cm-editor");
    return isInput || inEditor;
  }

  private flushPendingUpdate(): void {
    if (!this.pendingUpdate) return;
    if (this.isEditorFocusedInView()) return;
    this.pendingUpdate = false;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    window.setTimeout(() => {
      this.flushScheduled = false;
      if (!this.isEditorFocusedInView()) {
        this.updateFeed();
      } else {
        this.pendingUpdate = true;
      }
    }, 120);
  }

  private scheduleDebouncedUpdate(): void {
    if (this.updateDebounceTimer) {
      window.clearTimeout(this.updateDebounceTimer);
    }
    this.updateDebounceTimer = window.setTimeout(() => {
      this.updateDebounceTimer = null;
      if (!this.pendingUpdate) return;
      if (this.isEditorFocusedInView()) return;
      this.pendingUpdate = false;
      this.updateFeed();
    }, this.UPDATE_DEBOUNCE_MS);
  }

  private markEditorActivity(): void {
    this.isEditingInView = true;
    this.renderLocked = true;
  }

  private updateFeed(): void {
    if (this.isEditorFocusedInView()) {
      this.pendingUpdate = true;
      return;
    }
    if (!this.data) {
      this.root?.unmount();
      this.root = null;
      this.containerEl.empty();
      this.containerEl.createDiv("bases-feed-empty").textContent =
        "No entries to display";
      return;
    }

    const entries = [...this.data.data].filter(
      (entry) => entry.file.extension === "md",
    );

    const sort = this.config.getSort();
    const cfgAny = this.config as unknown as ViewConfigLike;
    const group = (typeof cfgAny.getGroup === 'function')
      ? cfgAny.getGroup()
      : (cfgAny.group || cfgAny.groups || cfgAny.source?.group || cfgAny.source?.groups || cfgAny.groupBy);

    const sortProp = sort?.[0]?.property;
    const sortDir = sort?.[0]?.direction ?? "ASC";

    let groupProp = null;
    let groupDir: "ASC" | "DESC" = "ASC";

    if (Array.isArray(group) && group.length > 0) {
      groupProp = group[0].property;
      groupDir = group[0].direction ?? "ASC";
    } else if (group && typeof group === "object") {
      const groupObj = group as { property?: BasesPropertyId; direction?: "ASC" | "DESC" };
      if (groupObj.property) {
        groupProp = groupObj.property;
        groupDir = groupObj.direction ?? "ASC";
      }
    }

    // Sort entries by secondary sort first (within groups)
    const entryComparator = this.getEntryComparator(sortProp, sortDir);
    entries.sort(entryComparator);

    // Build groups
    if (groupProp) {
      const groups: {
        key: string;
        label: string;
        value: unknown;
        entries: BasesEntry[];
      }[] = [];
      const groupMap = new Map<string, (typeof groups)[number]>();

      for (const entry of entries) {
        let rawVal = this.getPropertyValue(entry, groupProp);

        // Special handling for 'folder' if it returns null, try file.parent.path
        if (rawVal === null && (groupProp === 'folder' || groupProp === 'file.folder')) {
          rawVal = entry.file.parent ? entry.file.parent.path : '/';
        }

        const label = rawVal === null ? "No value" : String(rawVal);
        const key = `${label}`; // stable key for collapsible state

        let groupBucket = groupMap.get(key);
        if (!groupBucket) {
          groupBucket = { key, label, value: rawVal, entries: [] };
          groupMap.set(key, groupBucket);
          groups.push(groupBucket);
        }
        groupBucket.entries.push(entry);
      }

      // Sort groups by value/direction
      groups.sort((a, b) =>
        this.compareRawValues(a.value, b.value, groupDir),
      );

      const manualOrder = this.manualOrderEnabled ? this.getManualOrder() : [];
      const useManualOrder = this.manualOrderEnabled && manualOrder.length > 0;
      let orderedAll: BasesEntry[] = [];

      // Flatten to feed items: header + entries
      this.items = [];
      for (const groupBucket of groups) {
        const groupEntries = useManualOrder
          ? this.applyManualOrder(groupBucket.entries, manualOrder)
          : groupBucket.entries;
        orderedAll = orderedAll.concat(groupEntries);
        this.items.push({
          type: "header",
          label: groupBucket.label,
          id: `group-${groupBucket.key}`,
          count: groupEntries.length,
        });
        for (const entry of groupEntries) {
          this.items.push({
            type: "entry",
            entry,
            id: entry.file.path,
          });
        }
      }
      if (useManualOrder) {
        this.persistManualOrderIfNeeded(entries, manualOrder, orderedAll);
      }
    } else {
      const manualOrder = this.manualOrderEnabled ? this.getManualOrder() : [];
      const useManualOrder = this.manualOrderEnabled && manualOrder.length > 0;
      const ordered = useManualOrder ? this.applyManualOrder(entries, manualOrder) : entries;
      // Flat list if no grouping
      this.items = ordered.map((entry) => ({
        type: "entry",
        entry,
        id: entry.file.path,
      }));
      if (useManualOrder) {
        this.persistManualOrderIfNeeded(entries, manualOrder, ordered);
      }
    }

    this.renderReactFeed();
  }

  // Build a comparator for entries based on an optional property and direction.
  // If no property is provided, defaults to sorting by file title (basename) A–Z.
  private getEntryComparator(
    property?: BasesPropertyId,
    direction: "ASC" | "DESC" = "ASC",
  ): (a: BasesEntry, b: BasesEntry) => number {
    if (property) {
      return (a: BasesEntry, b: BasesEntry) => {
        const valueA = this.getPropertyValue(a, property);
        const valueB = this.getPropertyValue(b, property);

        let compareValue = 0;
        if (valueA === null && valueB === null) {
          compareValue = 0;
        } else if (valueA === null) {
          compareValue = 1; // nulls last
        } else if (valueB === null) {
          compareValue = -1; // nulls last
        } else if (typeof valueA === "number" && typeof valueB === "number") {
          compareValue = valueA - valueB;
        } else {
          compareValue = String(valueA).localeCompare(
            String(valueB),
            undefined,
            {
              numeric: true,
              sensitivity: "base",
            },
          );
        }

        return direction === "ASC" ? compareValue : -compareValue;
      };
    }

    // Default: sort by file title (basename) A–Z, case-insensitive, numeric-aware
    return (a: BasesEntry, b: BasesEntry) =>
      a.file.basename.localeCompare(b.file.basename, undefined, {
        numeric: true,
        sensitivity: "base",
      });
  }

  private compareRawValues(
    valueA: unknown,
    valueB: unknown,
    direction: "ASC" | "DESC" = "ASC",
  ): number {
    let compareValue = 0;
    if (valueA === null && valueB === null) {
      compareValue = 0;
    } else if (valueA === null) {
      compareValue = 1;
    } else if (valueB === null) {
      compareValue = -1;
    } else if (typeof valueA === "number" && typeof valueB === "number") {
      compareValue = valueA - valueB;
    } else {
      compareValue = String(valueA).localeCompare(String(valueB), undefined, {
        numeric: true,
        sensitivity: "base",
      });
    }
    return direction === "ASC" ? compareValue : -compareValue;
  }

  private getPropertyValue(entry: BasesEntry, propId: BasesPropertyId): unknown {
    // Special case for folder
    if ((propId as string) === 'folder' || (propId as string) === 'file.folder') {
      return entry.file.parent ? entry.file.parent.path : '/';
    }

    try {
      const value = entry.getValue(propId);
      if (value === null || value === undefined) return null;
      // Handle Bases wrapped values
      const valueObj = value as TruthyLike;
      if (typeof value === "object" && typeof valueObj.isTruthy === "function") {
        if (!valueObj.isTruthy()) return null;
      }

      // Try to get a comparable value
      if (valueObj instanceof Date) return valueObj.getTime();
      if (typeof valueObj === "object" && valueObj.valueOf) {
        return valueObj.valueOf();
      }
      const str = String(value);
      return str && str.trim().length > 0 ? str : null;
    } catch {
      return null;
    }
  }

  private renderReactFeed(): void {
    if (this.renderLocked) {
      this.pendingRender = true;
      return;
    }
    if (!this.root) {
      this.root = createRoot(this.containerEl);
    }

    const showProperties =
      (this.config.get("showProperties") as boolean | undefined) ?? false;
    const handleEditorActivity = () => {
      this.markEditorActivity();
    };

    this.root.render(
      <AppContext.Provider value={this.app}>
        <FeedReactView
          items={this.items}
          showProperties={showProperties}
          onEntryClick={(entry: BasesEntry, isModEvent: boolean) => {
            void this.app.workspace.openLinkText(
              entry.file.path,
              "",
              isModEvent,
            );
          }}
          onEntryContextMenu={(evt: React.MouseEvent, entry: BasesEntry) => {
            evt.preventDefault();
            this.showEntryContextMenu(evt.nativeEvent as MouseEvent, entry);
          }}
          integratedMode={this.integratedMode}
          onEditorActivity={handleEditorActivity}
          onReorder={
            this.manualOrderEnabled
              ? (order) => {
                  this.updateManualOrder(order);
                  this.updateFeed();
                }
              : undefined
          }
        />
      </AppContext.Provider>,
    );
  }

  private getManualOrder(): string[] {
    const raw = this.config.get("manualOrder");
    if (Array.isArray(raw)) {
      return raw.filter((item) => typeof item === "string") as string[];
    }
    return [];
  }

  private applyManualOrder(entries: BasesEntry[], order: string[]): BasesEntry[] {
    const byPath = new Map(entries.map((entry) => [entry.file.path, entry]));
    const ordered: BasesEntry[] = [];

    for (const path of order) {
      const entry = byPath.get(path);
      if (entry) {
        ordered.push(entry);
        byPath.delete(path);
      }
    }

    for (const entry of entries) {
      if (byPath.has(entry.file.path)) {
        ordered.push(entry);
        byPath.delete(entry.file.path);
      }
    }

    return ordered;
  }

  private persistManualOrderIfNeeded(
    entries: BasesEntry[],
    order: string[],
    ordered: BasesEntry[],
  ): void {
    const entrySet = new Set(entries.map((entry) => entry.file.path));
    const nextOrder = order.filter((path) => entrySet.has(path));
    for (const entry of ordered) {
      if (!nextOrder.includes(entry.file.path)) {
        nextOrder.push(entry.file.path);
      }
    }
    if (nextOrder.length !== order.length) {
      this.updateManualOrder(nextOrder);
    }
  }

  private updateManualOrder(order: string[]): void {
    this.config.set("manualOrder", order);
  }

  // Override creating file to prompt for title
  async createFileForView(
    baseFileName?: string,
    frontmatterProcessor?: (frontmatter: Record<string, unknown>) => void
  ): Promise<void> {
    const defaultName = baseFileName || "Untitled";
    const folderOverrideRaw = (this.config.get("newNoteFolder") as string | undefined)?.trim();
    const templatePathRaw = (this.config.get("newNoteTemplate") as string | undefined)?.trim();
    const filterFolder = this.getFilterCreationFolder();

    let allocatedName = defaultName;
    // Simple prompt modal
    const name = await new Promise<string | null>((resolve) => {
      const modal = new FileNameModal(this.app, defaultName, resolve);
      modal.open();
    });

    if (!name) return; // User cancelled

    allocatedName = name;

    // Determine folder
    let folderPath = "";
    try {
      if (folderOverrideRaw) {
        folderPath = normalizePath(folderOverrideRaw);
      } else if (filterFolder) {
        folderPath = normalizePath(filterFolder);
      } else {
        // Use Obsidian's new file location setting
        // @ts-ignore - access internal/public API
        const fileManager = this.app.fileManager as unknown as FileManagerLike;
        const p = fileManager.getNewFileParent("");
        folderPath = p.path;
      }

      if (folderPath === "/") folderPath = "";
      if (folderPath) {
        const existing = this.app.vault.getAbstractFileByPath(folderPath);
        if (!existing) {
          await this.app.vault.createFolder(folderPath);
        } else if (!(existing instanceof TFolder)) {
          new Notice(`New note folder "${folderPath}" is not a folder.`);
          return;
        }
      }
    } catch {
      folderPath = "/";
    }

    // Sanitize and check existence
    const normalizedName = allocatedName.endsWith(".md") ? allocatedName : `${allocatedName}.md`;
    const fullPath = folderPath === "/" ? normalizedName : `${folderPath}/${normalizedName}`;

    // Normalize path just in case
    // @ts-ignore
    if (this.app.vault.getAbstractFileByPath(fullPath)) {
      // If exists, reject or append?
      // For now, straightforward notification
      new Notice(`File "${fullPath}" already exists.`);
      return;
    }

    try {
      let templateFile: TFile | null = null;

      if (templatePathRaw) {
        templateFile = await resolveTemplateFile(this.app, templatePathRaw);
        if (!templateFile) {
          logger.warn("Template not found", templatePathRaw);
        }
      }

      const file = await this.app.vault.create(fullPath, "");

      if (templateFile) {
        await this.delay(300);
        let templateContent = "";
        try {
          templateContent = await this.app.vault.read(templateFile);
        } catch (err) {
          logger.warn("Failed to read template", err);
        }
        if (templateContent) {
          await this.app.vault.modify(file, templateContent);
        }
        const processed = await processTemplate(this.app, templateFile, file);
        if (processed !== null) {
          await this.app.vault.modify(file, processed);
        }
      }

      // Apply frontmatter if provided (e.g. filters)
      if (frontmatterProcessor) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          if (templateFile) {
            const before: Record<string, unknown> = { ...fm };
            const beforeKeys = new Set(Object.keys(before));
            frontmatterProcessor(fm);
            for (const key of beforeKeys) {
              fm[key] = before[key];
            }
          } else {
            frontmatterProcessor(fm);
          }
        });
      }

      // Open the new file
      // @ts-ignore
      await this.app.workspace.getLeaf().openFile(file);
    } catch (err) {
      new Notice(`Failed to create file: ${err}`);
      logger.error("Failed to create file", err);
    }
  }

  private showEntryContextMenu(evt: MouseEvent, entry: BasesEntry): void {
    const file = entry.file;
    const menu = new Menu();
    this.app.workspace.trigger("file-menu", menu, file, "file-explorer");
    this.app.workspace.handleLinkContextMenu(menu, file.path, "");
    menu.showAtMouseEvent(evt);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getFilterCreationFolder(): string | null {
    const cfgAny = this.config as unknown as ViewConfigLike;
    const filtersAll =
      this.config.get?.("filters") ??
      (cfgAny.filtersAll as unknown) ??
      ((cfgAny.filters as UnknownRecord | undefined)?.all as unknown) ??
      this.config.get?.("filtersAll") ??
      null;
    const viewFilters =
      cfgAny.viewFilters ??
      this.config.get?.("filters") ??
      cfgAny.filters ??
      null;

    const folderFromAll = this.extractFolderFromFilters(filtersAll);
    const folderFromView = folderFromAll ? null : this.extractFolderFromFilters(viewFilters);
    return folderFromAll || folderFromView;
  }

  private extractFolderFromFilters(filters: unknown): string | null {
    const conditions = this.collectFilterConditions(filters);
    for (const condition of conditions) {
      const property = condition.property.toLowerCase();
      if (!property.includes("folder")) continue;
      if (!this.isPositiveEqualityOp(condition.operator)) continue;
      const value = this.normalizeFilterValue(condition.value);
      if (!value) continue;
      return normalizePath(value);
    }
    return null;
  }

  private collectFilterConditions(filters: unknown): Array<{ property: string; operator: string; value: unknown }> {
    const conditions: Array<{ property: string; operator: string; value: unknown }> = [];
    const visit = (node: unknown) => {
      if (!node) return;
      if (typeof node === "object" && "data" in node) {
        visit((node as UnknownRecord).data);
        return;
      }
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (typeof node !== "object") return;
      const nodeObj = node as UnknownRecord;
      if (Array.isArray(nodeObj.children)) {
        nodeObj.children.forEach(visit);
        return;
      }

      const property = String(nodeObj.property || nodeObj.field || "").trim();
      if (!property) return;
      let value = nodeObj.value ?? nodeObj.pattern ?? nodeObj.match;
      if (value && typeof value === "object" && "value" in value) {
        value = (value as UnknownRecord).value;
      }
      const operator = String(nodeObj.op || nodeObj.operator || "").trim();
      conditions.push({ property, operator, value });
    };
    visit(filters);
    return conditions;
  }

  private isPositiveEqualityOp(operator: string): boolean {
    const op = operator.toLowerCase().replace(/\s+/g, "");
    if (!op) return true;
    if (op.includes("not") || op.includes("!=") || op.includes("doesnot")) return false;
    return op.includes("is") || op.includes("equals") || op === "=";
  }

  private normalizeFilterValue(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return null;
  }
}

export class NoteView extends FeedView {
  type = NoteViewType;
  protected integratedMode = true;
  protected manualOrderEnabled = true;

  constructor(controller: QueryController, scrollEl: HTMLElement) {
    super(controller, scrollEl);
    this.containerEl.classList.add("bases-feed-note-view");
  }

  onunload() {
    this.containerEl.classList.remove("bases-feed-note-view");
    super.onunload();
  }
}


class FileNameModal extends Modal {
  private resolve: (value: string | null) => void;
  private value: string;
  private submitted = false;

  constructor(app: App, defaultValue: string, resolve: (value: string | null) => void) {
    super(app);
    this.value = defaultValue;
    this.resolve = resolve;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "New Note Title" });

    const inputDiv = contentEl.createDiv();
    const input = inputDiv.createEl("input", { type: "text", value: this.value });
    input.style.width = "100%";
    input.focus();
    input.select();

    const handleSubmit = () => {
      if (this.submitted) return;
      this.submitted = true;
      this.resolve(input.value);
      this.close();
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      }
    });

    const buttonDiv = contentEl.createDiv({ attr: { style: "margin-top: 12px; display: flex; justify-content: flex-end; gap: 8px;" } });
    const cancelBtn = buttonDiv.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const okBtn = buttonDiv.createEl("button", { text: "Create", cls: "mod-cta" });
    okBtn.addEventListener("click", handleSubmit);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.submitted) {
      this.resolve(null);
    }
  }
}
