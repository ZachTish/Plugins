import { Plugin } from "obsidian";
import { PageView, PageViewType } from "./page-view";

/**
 * TPS Page Base Plugin
 *
 * Displays all Base entries as a seamless scrollable page.
 * Each entry appears as an H2-titled section with the note body rendered below.
 * Clicking an H2 title opens a hover editor for inline editing.
 */
export default class PageBasePlugin extends Plugin {
  async onload() {
    this.registerBasesView(PageViewType, {
      name: "Page",
      icon: "lucide-file-text",
      factory: (controller, containerEl) =>
        new PageView(controller, containerEl, this.app),
      options: () => PageView.getOptions(),
    });
  }

  async onunload() {
    // Cleanup handled in PageView.onunload()
  }
}
