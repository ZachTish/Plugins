import { App, WorkspaceLeaf } from "obsidian";

type OpenTagCanvasFn = (tag: string) => Promise<void>;

const GRAPH_VIEW_TYPES = ["graph", "localgraph"] as const;

export class GraphIntegrationService {
  private clickHandler: ((event: MouseEvent) => void) | null = null;

  constructor(
    private readonly app: App,
    private readonly openTagCanvas: OpenTagCanvasFn,
  ) {}

  start(): void {
    if (this.clickHandler) return;

    this.clickHandler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const leaf = this.resolveGraphLeaf(target);
      if (!leaf) return;

      const tag = this.extractTagFromTarget(target, leaf.view.containerEl);
      if (!tag) return;

      event.preventDefault();
      event.stopPropagation();
      void this.openTagCanvas(tag);
    };

    document.addEventListener("click", this.clickHandler, true);
  }

  stop(): void {
    if (!this.clickHandler) return;
    document.removeEventListener("click", this.clickHandler, true);
    this.clickHandler = null;
  }

  private resolveGraphLeaf(target: Element): WorkspaceLeaf | null {
    for (const type of GRAPH_VIEW_TYPES) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const container = (leaf as WorkspaceLeaf).view?.containerEl;
        if (container instanceof HTMLElement && container.contains(target)) {
          return leaf as WorkspaceLeaf;
        }
      }
    }
    return null;
  }

  private extractTagFromTarget(target: Element, boundary: HTMLElement): string | null {
    let current: Element | null = target;
    while (current && current !== boundary) {
      const tag = this.extractTagText(current) ?? this.extractTagFromNodeGroup(current);
      if (tag) return tag;
      current = current.parentElement;
    }
    return this.extractTagText(boundary) ?? this.extractTagFromNodeGroup(boundary);
  }

  private extractTagText(node: Element): string | null {
    return this.matchTag(node.textContent);
  }

  private extractTagFromNodeGroup(node: Element): string | null {
    const graphNode =
      node.closest("g.node, g[class*='node'], .graph-node, .node, [class*='graph-node']");
    if (!graphNode) return null;

    const directText = this.matchTag(graphNode.textContent);
    if (directText) return directText;

    const labelEl = graphNode.querySelector("text, title, [aria-label], [data-path], [data-id]");
    if (!labelEl) return null;

    const attrText =
      labelEl.getAttribute("aria-label")
      ?? labelEl.getAttribute("data-path")
      ?? labelEl.getAttribute("data-id")
      ?? labelEl.textContent;
    return this.matchTag(attrText);
  }

  private matchTag(raw: string | null | undefined): string | null {
    const text = String(raw ?? "").trim();
    if (!text || text.length > 256) return null;

    const exact = text.match(/^#([^\s#][^\s]*)$/);
    if (exact) return exact[1];

    const embedded = text.match(/(?:^|\s)#([A-Za-z0-9/_-]+)(?:$|\s)/);
    if (embedded) return embedded[1];

    return null;
  }
}
