import { App, Notice, Plugin, SuggestModal, TAbstractFile, TFile } from "obsidian";
import { DEFAULT_SETTINGS, TagCanvasSettings } from "./types";
import { CanvasManager } from "./services/canvas-manager";
import { NNIntegrationService } from "./services/nn-integration";
import { TagCanvasSettingTab } from "./settings-tab";

// Global window property under which the plugin API is exposed.
// Other plugins (e.g. TPS-Notebook-Navigator-Companion) can call:
//   window._tps_tagCanvas.openForTag("project/coding")
const API_PROP = "_tps_tagCanvas";
const ROOT_TAG_PAGE = "__nn_tags_root__";

// ─── Tag suggester modal ───────────────────────────────────────────────────

class TagSuggestModal extends SuggestModal<string> {
  constructor(
    app: App,
    private tags: string[],
    private onChoose: (tag: string) => void,
  ) {
    super(app);
    this.setPlaceholder("Type a tag name …");
  }

  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.tags.filter(t => t.toLowerCase().includes(q));
  }

  renderSuggestion(tag: string, el: HTMLElement): void {
    el.createSpan({ text: "#" + tag });
  }

  onChooseSuggestion(tag: string): void {
    this.onChoose(tag);
  }
}

// ─── Plugin ────────────────────────────────────────────────────────────────

export default class TagCanvasPlugin extends Plugin {
  settings: TagCanvasSettings = { ...DEFAULT_SETTINGS };
  canvasManager!: CanvasManager;
  private nnIntegration!: NNIntegrationService;

  /** Tags pending a sync flush */
  private pendingTags = new Set<string>();
  /** Debounce timer handle */
  private syncTimer: number | null = null;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();

    this.canvasManager = new CanvasManager(this.app, () => this.settings);
    this.nnIntegration = new NNIntegrationService(
      this.app,
      this.canvasManager,
      (tag) => this.canvasManager.openTagCanvas(tag),
    );

    this.addSettingTab(new TagCanvasSettingTab(this.app, this));
    this.registerVaultEvents();
    this.addCommands();
    this.addRibbonIcon("layers-3", "Tag Canvas: Sync all tag canvases", () =>
      this.cmdSyncAll(),
    );
    this.exposePluginApi();

    // Start NN integration and run a passive full sync after layout is ready.
    // This keeps tag canvases up-to-date on app load even before any edits happen.
    this.app.workspace.onLayoutReady(() => {
      this.nnIntegration.start();
      this.scheduleFullSync();
    });

    this.log("Tag Canvas plugin loaded.");
  }

  onunload(): void {
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.nnIntegration.stop();
    delete (window as any)[API_PROP];
    this.log("Tag Canvas plugin unloaded.");
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const saved = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ── Vault event listeners ─────────────────────────────────────────────────

  private registerVaultEvents(): void {
    // A markdown file's metadata changed → sync affected tags
    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile) => {
        if (!this.settings.autoSync) return;
        if (file.extension !== "md") return;
        this.scheduleFileSync(file);
      }),
    );

    // A file was deleted → do a full sync so removed notes leave all canvases
    this.registerEvent(
      this.app.vault.on("delete", (abstract: TAbstractFile) => {
        if (!this.settings.autoSync) return;
        if (!(abstract instanceof TFile) || abstract.extension !== "md") return;
        this.scheduleFullSync();
      }),
    );

    // A file was renamed → full sync (old and new path may differ in tags)
    this.registerEvent(
      this.app.vault.on("rename", (abstract: TAbstractFile) => {
        if (!this.settings.autoSync) return;
        if (!(abstract instanceof TFile) || abstract.extension !== "md") return;
        this.scheduleFullSync();
      }),
    );
  }

  // ── Debounced sync ────────────────────────────────────────────────────────

  private scheduleFileSync(file: TFile): void {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return;

    this.pendingTags.add(ROOT_TAG_PAGE);

    // Inline tags
    cache.tags?.forEach(t => this.pendingTags.add(t.tag.replace(/^#/, "")));

    // Frontmatter tags
    const fm = cache.frontmatter;
    if (fm?.tags) {
      const fmTags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
      fmTags.forEach((t: any) => this.pendingTags.add(String(t).replace(/^#/, "")));
    }

    this.debounce();
  }

  private scheduleFullSync(): void {
    this.pendingTags.add("__ALL__");
    this.debounce();
  }

  private debounce(): void {
    if (this.syncTimer !== null) window.clearTimeout(this.syncTimer);

    this.syncTimer = window.setTimeout(async () => {
      this.syncTimer = null;

      if (this.pendingTags.has("__ALL__")) {
        this.pendingTags.clear();
        this.log("Auto-sync: full vault sync triggered.");
        await this.canvasManager.syncAll();
      } else {
        const tags = [...this.pendingTags];
        this.pendingTags.clear();
        this.log(`Auto-sync: syncing tags: ${tags.join(", ")}`);
        for (const tag of tags) {
          await this.canvasManager.syncTag(tag);
        }
      }
      // Refresh NN indicators after any sync
      this.nnIntegration.refresh();
    }, this.settings.syncDelayMs);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private addCommands(): void {
    this.addCommand({
      id: "sync-all-tag-canvases",
      name: "Sync all tag canvases",
      callback: () => this.cmdSyncAll(),
    });

    this.addCommand({
      id: "open-tag-canvas",
      name: "Open tag canvas …",
      callback: () => this.cmdPickAndOpen(),
    });

    this.addCommand({
      id: "sync-tag-canvas-for-active-file",
      name: "Sync tag canvases for active file",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.cmdSyncForFile(file);
        return true;
      },
    });
  }

  private async cmdSyncAll(): Promise<void> {
    new Notice("Tag Canvas: syncing …");
    try {
      const { synced, errors } = await this.canvasManager.syncAll();
      this.nnIntegration.refresh();
      if (errors.length > 0) {
        console.error("[TPS-TagCanvas] Sync errors:", errors);
        new Notice(`Tag Canvas: synced ${synced} tags (${errors.length} error(s) — see console).`);
      } else {
        new Notice(`Tag Canvas: synced ${synced} tag canvas${synced !== 1 ? "es" : ""}.`);
      }
    } catch (e) {
      console.error("[TPS-TagCanvas] Sync failed:", e);
      new Notice("Tag Canvas: sync failed — see console.");
    }
  }

  private cmdPickAndOpen(): void {
    const tags = this.canvasManager.getAllTags();
    if (tags.length === 0) {
      new Notice("Tag Canvas: no tags found in vault.");
      return;
    }
    new TagSuggestModal(this.app, tags, async tag => {
      await this.canvasManager.openTagCanvas(tag);
    }).open();
  }

  private async cmdSyncForFile(file: TFile): Promise<void> {
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = new Set<string>();

    cache?.tags?.forEach(t => tags.add(t.tag.replace(/^#/, "")));
    const fm = cache?.frontmatter;
    if (fm?.tags) {
      const fmTags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
      fmTags.forEach((t: any) => tags.add(String(t).replace(/^#/, "")));
    }

    if (tags.size === 0) {
      new Notice("Tag Canvas: active file has no tags.");
      return;
    }

    for (const tag of tags) await this.canvasManager.syncTag(tag);
    this.nnIntegration.refresh();
    new Notice(`Tag Canvas: synced ${tags.size} tag canvas${tags.size !== 1 ? "es" : ""}.`);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Plugin API — accessible as:
   *   app.plugins.plugins["tps-tag-canvas"].api.openForTag("mytag")
   *   window._tps_tagCanvas.openForTag("mytag")
   */
  readonly api = {
    /** Open (and sync) the canvas for `tag` (without leading #). */
    openForTag: (tag: string) => this.canvasManager.openTagCanvas(tag),
    /** Sync (create/update) the canvas for `tag` without opening it. */
    syncForTag: (tag: string) => this.canvasManager.syncTag(tag),
    /** Sync all tag canvases in the vault. */
    syncAll: () => this.canvasManager.syncAll(),
    /** Returns all non-excluded tags present in the vault. */
    getTagsInVault: () => this.canvasManager.getAllTags(),
    /** Returns the vault-relative path of the canvas file for `tag`. */
    getCanvasPath: (tag: string) => this.canvasManager.getCanvasPath(tag),
    /** Special page token used for Notebook Navigator's top-level Tags item. */
    rootTagPage: ROOT_TAG_PAGE,
  };

  private exposePluginApi(): void {
    (window as any)[API_PROP] = this.api;
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  private log(msg: string): void {
    if (this.settings.debugLogging) console.log(`[TPS-TagCanvas] ${msg}`);
  }
}
