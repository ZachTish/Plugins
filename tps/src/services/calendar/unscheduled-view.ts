import { ItemView, TFile, WorkspaceLeaf } from "obsidian";

export const UNSCHEDULED_VIEW_TYPE = "tps-calendar-unscheduled";

export class UnscheduledView extends ItemView {
  private plugin: any;

  constructor(leaf: WorkspaceLeaf, plugin: any) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return UNSCHEDULED_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Unscheduled Notes";
  }

  getIcon(): string {
    return "calendar-x";
  }

  async onOpen(): Promise<void> {
    this.refresh();
  }

  async onClose(): Promise<void> {
    // nothing to clean up
  }

  refresh(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    Object.assign(container.style, {
      padding: "8px",
      overflowY: "auto",
      display: "flex",
      flexDirection: "column",
      gap: "0",
    });

    const entries: { file: TFile; title: string }[] = this.plugin.unscheduledEntries ?? [];

    if (entries.length === 0) {
      const empty = container.createEl("p");
      empty.textContent = "No unscheduled notes in the current base.";
      Object.assign(empty.style, {
        color: "var(--text-muted)",
        fontSize: "0.85em",
        padding: "8px 4px",
        margin: "0",
      });
      return;
    }

    const header = container.createEl("div");
    header.textContent = `${entries.length} unscheduled note${entries.length === 1 ? "" : "s"}`;
    Object.assign(header.style, {
      fontSize: "0.75em",
      fontWeight: "600",
      color: "var(--text-muted)",
      textTransform: "uppercase",
      letterSpacing: "0.05em",
      padding: "4px 4px 8px",
      marginBottom: "2px",
    });

    for (const { file, title } of entries) {
      const item = container.createEl("div");
      let suppressNextClick = false;
      let clearSuppressTimer: number | null = null;

      const scheduleSuppressReset = () => {
        if (clearSuppressTimer != null) {
          window.clearTimeout(clearSuppressTimer);
        }
        clearSuppressTimer = window.setTimeout(() => {
          suppressNextClick = false;
          clearSuppressTimer = null;
        }, 300);
      };

      Object.assign(item.style, {
        padding: "6px 10px",
        borderRadius: "4px",
        background: "var(--background-secondary)",
        borderLeft: "3px solid var(--interactive-accent)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: "6px",
        marginBottom: "3px",
        fontSize: "0.83em",
        color: "var(--text-normal)",
        overflow: "hidden",
        whiteSpace: "nowrap",
        textOverflow: "ellipsis",
        transition: "background-color 0.1s ease",
        userSelect: "none",
      });
      item.setAttribute("draggable", "true");
      item.setAttribute("title", file.path);

      const titleSpan = item.createEl("span");
      titleSpan.textContent = title;
      Object.assign(titleSpan.style, {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        flex: "1",
        fontWeight: "500",
        pointerEvents: "none",
      });

      item.addEventListener("mouseover", () => {
        item.style.backgroundColor = "var(--background-modifier-hover)";
      });
      item.addEventListener("mouseout", () => {
        item.style.backgroundColor = "var(--background-secondary)";
      });

      item.addEventListener("click", (e) => {
        e.preventDefault();
        if (suppressNextClick) {
          e.stopPropagation();
          suppressNextClick = false;
          if (clearSuppressTimer != null) {
            window.clearTimeout(clearSuppressTimer);
            clearSuppressTimer = null;
          }
          return;
        }
        const leaf = (e.ctrlKey || e.metaKey)
          ? (this.app.workspace.getLeaf(true) ?? this.app.workspace.getLeaf(false))
          : this.app.workspace.getLeaf(false);
        if (!leaf) return;
        void leaf.openFile(file);
      });

      // Drag onto the calendar — the calendar's handleExternalDrop reads "obsidian/file"
      item.addEventListener("dragstart", (e: DragEvent) => {
        if (!e.dataTransfer) return;
        suppressNextClick = true;
        scheduleSuppressReset();
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("obsidian/file", file.path);
        e.dataTransfer.setData("text/plain", file.path);
        item.style.opacity = "0.5";
      });

      item.addEventListener("dragend", () => {
        item.style.opacity = "1";
        scheduleSuppressReset();
      });
    }
  }
}
