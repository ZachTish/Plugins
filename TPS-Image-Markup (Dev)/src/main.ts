import { MarkdownView, Notice, Platform, Plugin, TFile, WorkspaceLeaf, setIcon } from "obsidian";

const STYLE_ID = "tps-image-markup-style";
const BUTTON_CLASS = "tps-image-markup-button";
const HOST_ATTR = "data-tps-image-markup-host";
const FILE_ATTR = "data-tps-image-markup-path";
const IMAGE_SELECTORS = [
  ".internal-embed.image-embed",
  ".image-embed",
  ".media-embed",
  ".cm-embed-block .internal-embed",
  "img",
].join(", ");

const IMAGE_EXTENSIONS = new Set([
  "apng",
  "avif",
  "bmp",
  "gif",
  "heic",
  "heif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
]);

export default class TPSImageMarkupPlugin extends Plugin {
  private styleEl: HTMLStyleElement | null = null;
  private leafObservers = new WeakMap<WorkspaceLeaf, MutationObserver>();
  private refreshTimer: number | null = null;

  async onload(): Promise<void> {
    this.injectStyles();

    this.registerMarkdownPostProcessor((el, ctx) => {
      this.decorateImageEmbeds(el, ctx.sourcePath);
    });

    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.workspace.on("file-open", () => {
      this.scheduleRefresh();
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.scheduleRefresh();
    }));

    this.app.workspace.onLayoutReady(() => {
      this.refreshAll();
    });
  }

  onunload(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      this.disconnectObserver(leaf);
    }

    this.styleEl?.remove();
    this.styleEl = null;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }

    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refreshAll();
    }, 60);
  }

  private refreshAll(): void {
    const markdownLeaves = this.app.workspace.getLeavesOfType("markdown");

    for (const leaf of markdownLeaves) {
      this.observeLeaf(leaf);

      const view = leaf.view;
      if (view instanceof MarkdownView) {
        const sourcePath = view.file?.path ?? "";
        this.decorateImageEmbeds(view.containerEl, sourcePath);
      }
    }
  }

  private observeLeaf(leaf: WorkspaceLeaf): void {
    if (this.leafObservers.has(leaf)) {
      return;
    }

    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      return;
    }

    const observer = new MutationObserver(() => {
      const sourcePath = view.file?.path ?? "";
      this.decorateImageEmbeds(view.containerEl, sourcePath);
    });

    observer.observe(view.containerEl, {
      childList: true,
      subtree: true,
    });

    this.leafObservers.set(leaf, observer);
    this.register(() => this.disconnectObserver(leaf));
  }

  private disconnectObserver(leaf: WorkspaceLeaf): void {
    const observer = this.leafObservers.get(leaf);
    if (!observer) {
      return;
    }

    observer.disconnect();
    this.leafObservers.delete(leaf);
  }

  private decorateImageEmbeds(root: ParentNode, sourcePath: string): void {
    const nodes = root.querySelectorAll<HTMLElement>(IMAGE_SELECTORS);

    for (const node of Array.from(nodes)) {
      const embed = this.resolveHostElement(node);
      if (!embed) {
        continue;
      }

      const file = this.resolveImageFile(embed, sourcePath);
      if (!file) {
        continue;
      }

      if (embed.getAttribute(HOST_ATTR) !== "true") {
        embed.setAttribute(HOST_ATTR, "true");
        embed.addClass("tps-image-markup-host");
      }

      const existing = embed.querySelector<HTMLButtonElement>(`.${BUTTON_CLASS}`);
      if (existing) {
        existing.setAttribute(FILE_ATTR, file.path);
        existing.setAttribute("aria-label", this.getButtonLabel());
        existing.title = this.getButtonLabel();
        continue;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = BUTTON_CLASS;
      button.setAttribute(FILE_ATTR, file.path);
      button.setAttribute("aria-label", this.getButtonLabel());
      button.title = this.getButtonLabel();
      setIcon(button, "pen-tool");

      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const latestPath = button.getAttribute(FILE_ATTR);
        const latestFile = latestPath
          ? this.app.vault.getAbstractFileByPath(latestPath)
          : null;

        if (!(latestFile instanceof TFile)) {
          new Notice("Image file not found.");
          return;
        }

        await this.openForMarkup(latestFile);
      });

      embed.appendChild(button);
    }
  }

  private resolveHostElement(node: HTMLElement): HTMLElement | null {
    if (node instanceof HTMLImageElement) {
      return node.closest<HTMLElement>(".internal-embed, .image-embed, .media-embed, .cm-embed-block")
        ?? node.parentElement;
    }

    return node;
  }

  private resolveImageFile(embed: HTMLElement, sourcePath: string): TFile | null {
    const src = this.extractEmbedSrc(embed);
    if (!src) {
      return null;
    }

    const resolved = this.app.metadataCache.getFirstLinkpathDest(src, sourcePath);
    if (!(resolved instanceof TFile)) {
      return null;
    }

    if (!IMAGE_EXTENSIONS.has(resolved.extension.toLowerCase())) {
      return null;
    }

    return resolved;
  }

  private extractEmbedSrc(embed: HTMLElement): string | null {
    const directSrc = embed.getAttribute("src");
    if (directSrc) {
      return directSrc;
    }

    const img = embed.querySelector<HTMLImageElement>("img");
    if (!img) {
      return null;
    }

    return img.getAttribute("src") ?? img.currentSrc ?? null;
  }

  private getButtonLabel(): string {
    if (Platform.isIosApp) {
      return "Open image for Markup";
    }

    return "Open image in default app";
  }

  private async openForMarkup(file: TFile): Promise<void> {
    try {
      const appAny = this.app as any;

      if (Platform.isDesktop) {
        await appAny.openWithDefaultApp(file.path);
        return;
      }

      await (this.app.vault.adapter as any).open(file.path);
    } catch (error) {
      console.error("[TPS Image Markup] Failed to open image", error);
      new Notice("Could not open the image.");
    }
  }

  private injectStyles(): void {
    if (this.styleEl) {
      return;
    }

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .tps-image-markup-host {
        position: relative;
      }

      .tps-image-markup-host:hover .${BUTTON_CLASS},
      .tps-image-markup-host:focus-within .${BUTTON_CLASS} {
        opacity: 1;
      }

      .${BUTTON_CLASS} {
        position: absolute;
        top: 10px;
        right: 10px;
        z-index: 3;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        border: 1px solid var(--background-modifier-border);
        border-radius: 999px;
        background: color-mix(in srgb, var(--background-primary) 84%, transparent);
        color: var(--text-normal);
        box-shadow: var(--shadow-s);
        opacity: 0.92;
        transition: opacity 120ms ease, background-color 120ms ease, transform 120ms ease;
      }

      .${BUTTON_CLASS}:hover,
      .${BUTTON_CLASS}:focus-visible {
        opacity: 1;
        background: var(--background-primary);
        transform: scale(1.04);
      }

      body.is-mobile .${BUTTON_CLASS} {
        opacity: 0.92;
        width: 36px;
        height: 36px;
      }
    `;

    document.head.appendChild(style);
    this.styleEl = style;
    this.register(() => {
      style.remove();
      if (this.styleEl === style) {
        this.styleEl = null;
      }
    });
  }
}
