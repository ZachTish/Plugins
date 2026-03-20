import { App, TFile, WorkspaceLeaf } from "obsidian";
import { CanvasManager } from "./canvas-manager";

const NN_VIEW_TYPE = "notebook-navigator-view";
const TAG_ITEM_CLASS = "nn-navitem";
const TAG_CLASS = "nn-tag";
const NAME_CLASS = "nn-navitem-name";
const HAS_CANVAS_CLASS = "tps-has-tag-canvas";
const CANVAS_ICON_CLASS = "tps-tag-canvas-icon";
const CANVAS_ICON_ARIA = "Open tag canvas";

/**
 * Watches Notebook Navigator pane(s) for tag items and enriches them with
 * a clickable canvas indicator when a tag canvas exists.
 */
export class NNIntegrationService {
  private observers = new Map<HTMLElement, MutationObserver>();
  private leafWatcherInterval: number | null = null;
  // capture-phase listeners keyed by the name span element
  private captureListeners = new Map<HTMLElement, (e: MouseEvent) => void>();

  constructor(
    private app: App,
    private canvasManager: CanvasManager,
    private openTagCanvas: (tag: string) => Promise<void>,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    // Process any already-open NN leaves immediately
    this.attachToAllLeaves();

    // Poll for new NN leaves (NN can open/close dynamically)
    this.leafWatcherInterval = window.setInterval(() => {
      this.attachToAllLeaves();
    }, 2000);

    // Also react to layout changes
    this.app.workspace.on("layout-change", () => this.attachToAllLeaves());
  }

  stop(): void {
    if (this.leafWatcherInterval !== null) {
      window.clearInterval(this.leafWatcherInterval);
      this.leafWatcherInterval = null;
    }

    for (const [, observer] of this.observers) {
      observer.disconnect();
    }
    this.observers.clear();
    this.captureListeners.clear();
  }

  /**
   * Call after a canvas file is created/deleted to refresh indicators.
   */
  refresh(): void {
    for (const [root] of this.observers) {
      this.processAllTagItems(root);
    }
  }

  // ── Leaf attachment ────────────────────────────────────────────────────────

  private attachToAllLeaves(): void {
    this.app.workspace.getLeavesOfType(NN_VIEW_TYPE).forEach(leaf => {
      const root = (leaf as WorkspaceLeaf).view.containerEl as HTMLElement;
      if (!this.observers.has(root)) {
        this.attachObserver(root);
        this.processAllTagItems(root);
      }
    });
  }

  private attachObserver(root: HTMLElement): void {
    const observer = new MutationObserver(mutations => {
      let needsProcess = false;
      for (const m of mutations) {
        if (m.type === "childList") {
          for (const node of Array.from(m.addedNodes)) {
            if (
              node instanceof HTMLElement &&
              (node.classList.contains(TAG_ITEM_CLASS) ||
                node.querySelector(`.${TAG_ITEM_CLASS}.${TAG_CLASS}`))
            ) {
              needsProcess = true;
              break;
            }
          }
        }
      }
      if (needsProcess) this.processAllTagItems(root);
    });

    observer.observe(root, { childList: true, subtree: true });
    this.observers.set(root, observer);
  }

  // ── Tag item processing ────────────────────────────────────────────────────

  private processAllTagItems(root: HTMLElement): void {
    const items = root.querySelectorAll<HTMLElement>(
      `.${TAG_ITEM_CLASS}.${TAG_CLASS}`,
    );
    items.forEach(item => this.processTagItem(item));
  }

  private processTagItem(item: HTMLElement): void {
    const tag = item.getAttribute("data-tag");
    if (!tag) return;

    const nameSpan = item.querySelector<HTMLElement>(`.${NAME_CLASS}`);
    if (!nameSpan) return;

    const canvasPath = this.canvasManager.getCanvasPath(tag);
    const canvasFile = this.app.vault.getAbstractFileByPath(canvasPath);
    const hasCanvas = canvasFile instanceof TFile;

    // All tags are shown as links — clicking opens (or creates) their canvas.
    item.classList.add(HAS_CANVAS_CLASS);
    if (hasCanvas) {
      item.classList.remove("tps-canvas-pending");
    } else {
      item.classList.add("tps-canvas-pending");
    }
    this.ensureCanvasIcon(nameSpan, tag);
    this.ensureCaptureListener(nameSpan, tag);
  }

  // ── Icon badge ─────────────────────────────────────────────────────────────

  private ensureCanvasIcon(nameSpan: HTMLElement, tag: string): void {
    if (nameSpan.querySelector(`.${CANVAS_ICON_CLASS}`)) return;

    const icon = nameSpan.createSpan({
      cls: CANVAS_ICON_CLASS,
      attr: {
        "aria-label": CANVAS_ICON_ARIA,
        role: "button",
        tabIndex: "0",
        "data-tag": tag,
      },
    });

    // The icon SVG (a simple "layers" icon inline so we have no extra deps)
    icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 22 8.5 12 15 2 8.5"/><polyline points="2 15.5 12 22 22 15.5"/><polyline points="2 12 12 18.5 22 12"/></svg>`;

    // Keyboard access
    icon.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        this.openTagCanvas(tag);
      }
    });
  }

  private removeCanvasIcon(nameSpan: HTMLElement): void {
    nameSpan.querySelector(`.${CANVAS_ICON_CLASS}`)?.remove();
  }

  // ── Capture-phase click listener ───────────────────────────────────────────

  /**
   * Attach a capture-phase click on nameSpan so our handler fires
   * before React's bubble-phase onClick on the parent content div.
   * Only clicks directly on the text portion (not the icon) will open
   * the canvas; clicks on the icon are handled above via the icon itself.
   */
  private ensureCaptureListener(nameSpan: HTMLElement, tag: string): void {
    if (this.captureListeners.has(nameSpan)) return;

    const navigateNotebookNavigatorToTag = async (rawTag: string) => {
      const cleanTag = String(rawTag || "").replace(/^#/, "").trim().toLowerCase();
      if (!cleanTag) return;
      const pluginManager = (this.app as any)?.plugins;
      const notebookNavigator =
        pluginManager?.getPlugin?.("notebook-navigator") ??
        pluginManager?.plugins?.["notebook-navigator"];
      const navigateToTag = notebookNavigator?.api?.navigation?.navigateToTag;
      if (typeof navigateToTag === "function") {
        await Promise.resolve(navigateToTag.call(notebookNavigator.api.navigation, cleanTag));
      }
    };

    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // If click was on the icon badge itself, let the icon's listener handle it
      if (target.closest(`.${CANVAS_ICON_CLASS}`)) return;
      // Otherwise open the canvas and prevent NN from selecting the tag
      e.stopPropagation();
      e.preventDefault();
      void (async () => {
        await this.openTagCanvas(tag);
        await navigateNotebookNavigatorToTag(tag);
      })();
    };

    nameSpan.addEventListener("click", handler, { capture: true });
    this.captureListeners.set(nameSpan, handler);
  }

  private removeCaptureListener(nameSpan: HTMLElement): void {
    const handler = this.captureListeners.get(nameSpan);
    if (handler) {
      nameSpan.removeEventListener("click", handler, { capture: true });
      this.captureListeners.delete(nameSpan);
    }
  }
}
