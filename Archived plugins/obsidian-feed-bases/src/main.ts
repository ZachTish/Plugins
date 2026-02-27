import { Plugin, MarkdownView } from "obsidian";
import { FeedView, FeedViewType, NoteView, NoteViewType } from "./feed-view";

export default class ObsidianFeedPlugin extends Plugin {
  private readableLineWidthTimer: number | null = null;

  async onload() {
    this.updateReadableLineLengthClass();

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (!this.isEditorFocused()) {
          this.updateReadableLineLengthClass();
        }
      })
    );

    this.readableLineWidthTimer = window.setInterval(() => {
      if (!this.isEditorFocused()) {
        this.updateReadableLineLengthClass();
      }
    }, 2000);

    this.registerInterval(this.readableLineWidthTimer);

    this.registerBasesView(FeedViewType, {
      name: "Feed",
      icon: "lucide-newspaper",
      factory: (controller, containerEl) =>
        new FeedView(controller, containerEl),
      options: () => [
        {
          key: "showProperties",
          type: "toggle",
          displayName: "Show note properties (Experimental)",
          default: false,
        },
        {
          key: "newNoteFolder",
          type: "text",
          displayName: "New note folder (optional)",
          default: "",
        },
        {
          key: "newNoteTemplate",
          type: "text",
          displayName: "New note template path (optional)",
          default: "",
        },
      ],
    });

    this.registerBasesView(NoteViewType, {
      name: "Note",
      icon: "lucide-file-text",
      factory: (controller, containerEl) =>
        new NoteView(controller, containerEl),
      options: () => [
        {
          key: "showProperties",
          type: "toggle",
          displayName: "Show note properties (Experimental)",
          default: false,
        },
        {
          key: "newNoteFolder",
          type: "text",
          displayName: "New note folder (optional)",
          default: "",
        },
        {
          key: "newNoteTemplate",
          type: "text",
          displayName: "New note template path (optional)",
          default: "",
        },
      ],
    });

  }

  onunload() {
    document.body.classList.remove("tps-readable-line-width");
  }

  private updateReadableLineLengthClass(): void {
    const vault = this.app.vault as unknown as {
      getConfig?: (key: string) => unknown;
      config?: { readableLineLength?: unknown };
    };
    const readable =
      typeof vault?.getConfig === "function"
        ? vault.getConfig("readableLineLength")
        : vault?.config?.readableLineLength;

    document.body.classList.toggle("tps-readable-line-width", Boolean(readable));
  }

  private isEditorFocused(): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor as unknown as { hasFocus?: () => boolean } | undefined;
    if (!editor) return false;
    try {
      return typeof editor.hasFocus === "function" ? editor.hasFocus() : false;
    } catch {
      return false;
    }
  }
}
