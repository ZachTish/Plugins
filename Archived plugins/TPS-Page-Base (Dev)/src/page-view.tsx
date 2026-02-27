import {
  App,
  BasesEntry,
  BasesEntryGroup,
  BasesView,
  QueryController,
} from "obsidian";
import { StrictMode } from "react";
import { createRoot, Root } from "react-dom/client";
import { PageEntry, GroupedPageEntries, PageViewContent } from "./types";
import { ContentRenderer } from "./content-renderer";
import { AppContext } from "./context";
import { PageReactView } from "./PageReactView";

export const PageViewType = "page";

/**
 * BasesView implementation for the Page view.
 * Manages data transformation and React rendering lifecycle.
 */
export class PageView extends BasesView {
  type = PageViewType;
  scrollEl: HTMLElement;
  containerEl: HTMLElement;
  app: App;
  root: Root | null = null;
  controller: QueryController;

  private content: PageViewContent = [];
  private baseTitle: string = "";
  private renderToken: number = 0;
  private contentRenderer: ContentRenderer;
  private groupProperty: string | null = null;

  constructor(
    controller: QueryController,
    scrollEl: HTMLElement,
    app: App
  ) {
    super(controller);
    this.controller = controller;
    this.scrollEl = scrollEl;
    this.app = app;
    this.contentRenderer = new ContentRenderer(app);
    this.containerEl = scrollEl.createDiv({
      cls: "bases-page-container is-loading",
      attr: { tabIndex: 0 },
    });
  }

  onload(): void {
    // Lifecycle managed via onDataUpdated and onunload
  }

  onunload(): void {
    this.root?.unmount();
    this.root = null;
    this.contentRenderer.cleanup();
  }

  onDataUpdated(): void {
    this.containerEl.removeClass("is-loading");
    this.renderToken++;
    void this.updatePage();
  }

  onResize(): void {
    // Page view adapts automatically
  }

  focus(): void {
    this.containerEl.focus({ preventScroll: true });
  }

  /**
   * Main update orchestration.
   * Reads all entries and transforms them, then renders React.
   */
  private async updatePage(): Promise<void> {
    const token = this.renderToken;

    try {
      // Get base title from heading or basename
      this.baseTitle = await this.getBaseTitle();

      // Transform entries: read content, strip frontmatter
      // Data structure is this.data.data with array of BasesEntry
      // Following pattern from Feed plugin line 265
      let pageEntries: PageEntry[] = [];
      const entryByPath = new Map<string, PageEntry>();
      if (this.data && Array.isArray(this.data.data)) {
        pageEntries = await Promise.all(this.data.data.map((entry: BasesEntry) => this.transformEntry(entry)));
        for (const pageEntry of pageEntries) {
          entryByPath.set(pageEntry.file.path, pageEntry);
        }
      }

      // Check if cancelled during async operations
      if (token !== this.renderToken) return;

      const configuredGroupProperty = this.resolveConfiguredGroupProperty();
      const groupedData = this.getGroupedData();
      const shouldRenderGrouped = groupedData.length > 0 && (Boolean(configuredGroupProperty) || groupedData.length > 1);
      if (shouldRenderGrouped) {
        this.groupProperty = configuredGroupProperty || "__grouped__";
        this.content = await this.buildGroupedContent(groupedData, entryByPath);
      } else {
        this.groupProperty = null;
        this.content = pageEntries;
      }

      if (token !== this.renderToken) return;
      this.renderReact();
    } catch (error) {
      console.error("[PageBase] Error updating page:", error);
      this.containerEl.addClass("is-error");
    }
  }

  /**
   * Resolve grouping config from Bases internals.
   */
  private resolveConfiguredGroupProperty(): string | null {
    const cfgAny = this.config as unknown as any;
    const groupConfig =
      typeof cfgAny.getGroup === "function"
        ? cfgAny.getGroup()
        : (cfgAny.groupBy ?? cfgAny.group ?? cfgAny.groups);

    const activeGroup = Array.isArray(groupConfig)
      ? groupConfig[0]
      : groupConfig && typeof groupConfig === "object"
        ? groupConfig
        : null;

    const property = String(
      activeGroup?.property ?? activeGroup?.field ?? activeGroup?.key ?? ""
    ).trim();

    return property || null;
  }

  /**
   * Read grouped data directly from Bases so labels/order match core behavior.
   */
  private getGroupedData(): BasesEntryGroup[] {
    const dataAny = this.data as unknown as any;
    if (!dataAny) {
      return [];
    }
    const grouped = dataAny.groupedData;
    return Array.isArray(grouped) ? (grouped as BasesEntryGroup[]) : [];
  }

  private async buildGroupedContent(
    groupedData: BasesEntryGroup[],
    entryByPath: Map<string, PageEntry>
  ): Promise<GroupedPageEntries[]> {
    const result: GroupedPageEntries[] = [];

    for (const group of groupedData) {
      const groupedEntries: PageEntry[] = [];
      for (const baseEntry of group.entries) {
        const existing = entryByPath.get(baseEntry.file.path);
        if (existing) {
          groupedEntries.push(existing);
          continue;
        }
        groupedEntries.push(await this.transformEntry(baseEntry));
      }

      result.push({
        groupLabel: this.formatGroupLabel(group?.key),
        groupValue: group?.key,
        entries: groupedEntries,
      });
    }

    return result;
  }

  private formatGroupLabel(key: unknown): string {
    const text = this.normalizeDisplayValue(key);
    return text || "Ungrouped";
  }

  private normalizeDisplayValue(value: unknown): string {
    if (value == null) {
      return "";
    }

    if (Array.isArray(value)) {
      const parts = value
        .map((item) => this.normalizeDisplayValue(item))
        .filter((item) => item.length > 0);
      return parts.join(", ");
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return "";
      }
      const lower = trimmed.toLowerCase();
      if (lower === "null" || lower === "undefined") {
        return "";
      }
      return trimmed;
    }

    const stringified = String(value).trim();
    if (!stringified || stringified === "[object Object]") {
      return "";
    }
    return stringified;
  }

  /**
   * Get the base title from the base file's first heading or basename.
   * Pattern from TPS-Auto-Base-Embed main.ts lines 758-776.
   */
  private async getBaseTitle(): Promise<string> {
    try {
      const baseFile =
        (this.controller as any).file || (this.controller as any).sourceFile;
      if (!baseFile) return "";

      const cache = this.app.metadataCache.getFileCache(baseFile);
      const heading = cache?.headings?.[0]?.heading;
      if (heading) return heading.trim();

      return baseFile.basename;
    } catch (error) {
      console.error("[PageBase] Error getting base title:", error);
      return "";
    }
  }

  /**
   * Transform a base entry into PageEntry format.
   * Reads file content and strips frontmatter.
   */
  private async transformEntry(entry: BasesEntry): Promise<PageEntry> {
    try {
      const rawContent = await this.app.vault.cachedRead(entry.file);
      const { frontmatter, body } =
        this.contentRenderer.splitFrontmatter(rawContent);

      const titleSource = (this.config.get("entryTitleSource") as string) || "note.sort";
      const title = this.resolveEntryTitle(entry, titleSource);

      return {
        file: entry.file,
        title,
        bodyContent: body,
        rawContent,
        frontmatter,
      };
    } catch (error) {
      console.error("[PageBase] Error transforming entry:", error);
      return {
        file: entry.file,
        title: entry.file.basename,
        bodyContent: `Error loading content: ${error instanceof Error ? error.message : String(error)}`,
        rawContent: "",
        frontmatter: "",
      };
    }
  }

  private resolveEntryTitle(entry: BasesEntry, titleSource: string): string {
    const normalizedSource = String(titleSource || "").trim() || "file.basename";
    if (normalizedSource === "file.basename" || normalizedSource === "basename") {
      const sortValue = this.readEntryValue(entry, "note.sort");
      if (sortValue) {
        return sortValue;
      }
      return entry.file.basename;
    }

    for (const candidate of this.getTitleSourceCandidates(normalizedSource)) {
      const candidateValue = this.readEntryValue(entry, candidate);
      if (candidateValue) {
        return candidateValue;
      }
    }

    const sortValue = this.readEntryValue(entry, "note.sort");
    if (sortValue) {
      return sortValue;
    }

    return entry.file.basename;
  }

  private readEntryValue(entry: BasesEntry, propertyId: string): string {
    const getValue = (entry as unknown as { getValue?: (source: string) => unknown }).getValue;
    if (typeof getValue !== "function") {
      return "";
    }

    try {
      return this.normalizeDisplayValue(getValue.call(entry, propertyId));
    } catch {
      return "";
    }
  }

  private getTitleSourceCandidates(titleSource: string): string[] {
    const source = String(titleSource || "").trim();
    const candidates = new Set<string>();
    if (source) {
      candidates.add(source);

      if (source.startsWith("note.")) {
        candidates.add(source.slice(5));
      } else if (source.startsWith("file.")) {
        candidates.add(source.slice(5));
      } else if (source.startsWith("formula.")) {
        candidates.add(source.slice(8));
      } else {
        candidates.add(`note.${source}`);
        candidates.add(`formula.${source}`);
        candidates.add(`file.${source}`);
      }
    } else {
      candidates.add("file.basename");
    }

    candidates.add("note.sort");
    candidates.add("sort");
    return Array.from(candidates);
  }

  /**
   * Render the React component tree.
   */
  private renderReact(): void {
    if (!this.root) {
      this.root = createRoot(this.containerEl);
    }

    this.root.render(
      <StrictMode>
        <AppContext.Provider value={this.app}>
          <PageReactView
            baseTitle={this.baseTitle}
            content={this.content}
            isGrouped={this.groupProperty !== null}
            lazyLoadThreshold={
              parseInt(String(this.config.get("lazyLoadThreshold"))) || 20
            }
          />
        </AppContext.Provider>
      </StrictMode>
    );
  }

  // Removed handleEditEntry for read-only view

  /**
   * ViewOptions configuration.
   */
  static getOptions(): any[] {
    return [
      {
        displayName: "Entry title source",
        type: "text",
        key: "entryTitleSource",
        default: "note.sort",
      },
      {
        displayName: "Lazy load threshold",
        type: "number",
        key: "lazyLoadThreshold",
        default: "20",
      },
    ];
  }
}
