import { App, Component, MarkdownRenderer } from "obsidian";

export interface FrontmatterSplit {
  frontmatter: string;
  body: string;
}

/**
 * Service for handling note content rendering and frontmatter processing.
 */
export class ContentRenderer {
  private app: App;
  private activeComponents = new Map<string, Component>();

  constructor(app: App) {
    this.app = app;
  }

  /**
   * Split note content into frontmatter and body.
   * Matches Feed plugin's pattern from FeedReactView.tsx lines 512-524.
   */
  splitFrontmatter(raw: string): FrontmatterSplit {
    const normalized = raw.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) {
      return { frontmatter: "", body: normalized };
    }

    const lines = normalized.split("\n");
    let endLine = -1;
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === "---" || line === "...") {
        endLine = i;
        break;
      }
    }

    if (endLine === -1) {
      return { frontmatter: "", body: normalized };
    }

    const frontmatter = lines.slice(0, endLine + 1).join("\n");
    const body = lines.slice(endLine + 1).join("\n");
    return { frontmatter, body };
  }

  /**
   * Strip frontmatter from content, returning only the body.
   * Matches Feed plugin's pattern from FeedReactView.tsx lines 399-409.
   */
  stripFrontmatter(raw: string): string {
    const { frontmatter, body } = this.splitFrontmatter(raw);
    if (!frontmatter) {
      return raw;
    }
    return body;
  }

  /**
   * Render markdown content to a container element.
   * Manages Component lifecycle for automatic cleanup.
   */
  async renderMarkdown(
    markdown: string,
    containerEl: HTMLElement,
    sourcePath: string
  ): Promise<Component> {
    const component = new Component();
    this.activeComponents.set(sourcePath, component);

    await MarkdownRenderer.render(
      this.app,
      markdown,
      containerEl,
      sourcePath,
      component
    );

    return component;
  }

  /**
   * Clean up all active components and clear tracking.
   * Call this in onunload() to prevent memory leaks.
   */
  cleanup(): void {
    for (const component of this.activeComponents.values()) {
      component.unload();
    }
    this.activeComponents.clear();
  }
}
