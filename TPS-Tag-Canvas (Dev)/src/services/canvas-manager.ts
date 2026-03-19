import { App, TFile, normalizePath } from "obsidian";
import {
  CanvasData,
  CanvasFileNode,
  CanvasNode,
  TagCanvasSettings,
} from "../types";

export class CanvasManager {
  private static readonly ROOT_TAG_PAGE = "__nn_tags_root__";

  constructor(
    private app: App,
    private getSettings: () => TagCanvasSettings,
  ) {}

  // ─── Tag / file queries ────────────────────────────────────────────────────

  /**
   * Returns all tags present in the vault (without leading #),
   * minus any that match settings.excludedTags.
   */
  getAllTags(): string[] {
    const settings = this.getSettings();
    const raw: Record<string, number> =
      (this.app.metadataCache as any).getTags?.() ?? {};

    return Object.keys(raw)
      .map(t => t.replace(/^#/, ""))
      .filter(t => !this.isTagExcluded(t, settings.excludedTags))
      .sort();
  }

  /**
   * Returns all markdown files that carry the given tag (without #).
   * Checks both inline tags and frontmatter tags.
   */
  getFilesForTag(tag: string): TFile[] {
    const settings = this.getSettings();
    const normalizedTag = this.normalizeTagInput(tag);
    const needle = this.getCanonicalTagPageKey(normalizedTag);
    const result: TFile[] = [];

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.isFileExcluded(file, settings.excludedFolders)) continue;

      const cache = this.app.metadataCache.getFileCache(file);
      if (!cache) continue;

      const fileTags = this.extractTags(cache);
      if (needle === CanvasManager.ROOT_TAG_PAGE) {
        if (fileTags.length === 0 && !this.isArchivedCandidate(file)) {
          result.push(file);
        }
        continue;
      }

      if (fileTags.some(t => this.getCanonicalTagPageKey(t) === needle)) {
        result.push(file);
      }
    }

    return result.sort((a, b) => a.path.localeCompare(b.path));
  }

  // ─── Path helpers ──────────────────────────────────────────────────────────

  /**
   * Returns the vault-relative path for the canvas that represents `tag`.
   * Sub-tags are flattened to a single page by leaf segment:
   *   "project/coding" and "personal/coding" → "Tag Canvases/coding.canvas"
   */
  getCanvasPath(tag: string): string {
    const settings = this.getSettings();
    const pageKey = this.getCanonicalTagPageKey(tag);
    // Remove characters illegal in file names on common OSes
    const safe = (pageKey === CanvasManager.ROOT_TAG_PAGE ? "Tags" : pageKey)
      .replace(/[\\:*?"<>|]/g, "-");
    return normalizePath(`${settings.canvasFolder}/${safe}.canvas`);
  }

  // ─── Canvas build / sync ───────────────────────────────────────────────────

  /**
   * Creates or updates the canvas file for `tag`.
   * Existing node positions are preserved; removed files are pruned;
   * new files are appended in a grid below existing nodes.
   */
  async syncTag(tag: string): Promise<void> {
    const files = this.getFilesForTag(tag);
    const canvasPath = this.getCanvasPath(tag);

    // Load existing canvas (if present)
    let existing: CanvasData = { nodes: [], edges: [] };
    const existingFile = this.app.vault.getAbstractFileByPath(canvasPath);
    if (existingFile instanceof TFile) {
      try {
        existing = JSON.parse(await this.app.vault.read(existingFile));
      } catch {
        existing = { nodes: [], edges: [] };
      }
    }

    if (files.length === 0 && !(existingFile instanceof TFile)) {
      return; // don't create new empty canvases
    }

    const updated = this.buildCanvasData(tag, files, existing);
    const json = JSON.stringify(updated, null, 2);

    // Ensure parent folder exists
    await this.ensureFolder(canvasPath);

    if (existingFile instanceof TFile) {
      await this.app.vault.modify(existingFile, json);
    } else {
      await this.app.vault.create(canvasPath, json);
    }
  }

  /**
   * Syncs every non-excluded tag that has at least one file.
   */
  async syncAll(): Promise<{ synced: number; errors: string[] }> {
    const tags = Array.from(new Set([
      ...this.getAllTags().map(tag => this.getCanonicalTagPageKey(tag)),
      CanvasManager.ROOT_TAG_PAGE,
    ]));
    let synced = 0;
    const errors: string[] = [];

    for (const tag of tags) {
      try {
        await this.syncTag(tag);
        synced++;
      } catch (e) {
        errors.push(`${tag}: ${e}`);
      }
    }

    return { synced, errors };
  }

  /**
   * Syncs the canvas for `tag` and then opens it in a new tab.
   */
  async openTagCanvas(tag: string): Promise<void> {
    await this.syncTag(tag);
    const canvasPath = this.getCanvasPath(tag);
    const file = this.app.vault.getAbstractFileByPath(canvasPath);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true });
      try {
        this.app.workspace.revealLeaf(leaf);
      } catch (_) {
        // revealLeaf may not be present in all runtime versions — ignore failures
      }
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Merges `currentFiles` into `existing` canvas data:
   * - Keeps non-file nodes (text / group) untouched.
   * - Keeps file nodes that still have the tag (preserving user positions).
   * - Removes file nodes for files that no longer have the tag.
   * - Appends new file nodes in a grid below the existing content.
   */
  private buildCanvasData(
    canvasTag: string,
    currentFiles: TFile[],
    existing: CanvasData,
  ): CanvasData {
    const settings = this.getSettings();
    const { nodeWidth, nodeHeight, columns, gap } = settings;

    // Index existing file nodes by vault path
    const existingByPath = new Map<string, CanvasFileNode>();
    for (const node of existing.nodes) {
      if (node.type === "file") {
        existingByPath.set((node as CanvasFileNode).file, node as CanvasFileNode);
      }
    }

    const currentPaths = new Set(currentFiles.map(f => f.path));
    const currentByPath = new Map(currentFiles.map(f => [f.path, f] as const));

    // Non-file nodes stay as-is
    const preserved: CanvasNode[] = existing.nodes.filter(n => n.type !== "file");

    // Existing file nodes that still have the tag — keep them, but
    // reorganize any unprotected (non-colored/grouped/linked) file nodes
    // into a neat grid. Protected nodes retain their positions.
    const keptRaw: CanvasFileNode[] = [];
    for (const [path, node] of existingByPath) {
      if (!currentPaths.has(path)) {
        if (this.shouldKeepUnmanagedFileNode(path)) keptRaw.push(node);
        continue;
      }
      const file = currentByPath.get(path);
      if (!file) continue;

      const archived = this.isArchivedCandidate(file);
      const exemptCanvas = this.isArchiveCanvas(canvasTag);
      const protectedNode = this.isProtectedNode(node, existing);
      if (archived && !exemptCanvas && !protectedNode) continue;

      keptRaw.push(node);
    }

    // New files that aren't in the canvas yet
    const newFiles = currentFiles.filter(f => {
      if (existingByPath.has(f.path)) return false;
      const archived = this.isArchivedCandidate(f);
      const exemptCanvas = this.isArchiveCanvas(canvasTag);
      if (archived && !exemptCanvas) return false;
      return true;
    });

    // Split kept nodes into protected (keep pos) and unprotected (reflow)
    const protectedKept: CanvasFileNode[] = [];
    const unprotectedKept: CanvasFileNode[] = [];
    for (const n of keptRaw) {
      if (this.isProtectedNode(n, existing)) protectedKept.push(n);
      else unprotectedKept.push(n);
    }

    // Determine Y-start for grid placement (below preserved + protected nodes)
    let startY = 0;
    const allExisting = [...preserved, ...protectedKept];
    if (allExisting.length > 0) {
      startY = Math.max(...allExisting.map(n => n.y + n.height)) + gap;
    }

    // Build grid for unprotected kept nodes followed by new files so both
    // get neat positions. Preserve stable ids for existing nodes.
    const gridCount = unprotectedKept.length + newFiles.length;
    const reflowedKept: CanvasFileNode[] = [];
    const added: CanvasFileNode[] = [];

    for (let i = 0; i < gridCount; i++) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      const x = col * (nodeWidth + gap);
      const y = startY + row * (nodeHeight + gap);

      if (i < unprotectedKept.length) {
        const k = unprotectedKept[i];
        reflowedKept.push({
          ...k,
          x,
          y,
          width: nodeWidth,
          height: nodeHeight,
        });
      } else {
        const file = newFiles[i - unprotectedKept.length];
        added.push({
          id: this.stableId(file.path),
          type: "file",
          file: file.path,
          x,
          y,
          width: nodeWidth,
          height: nodeHeight,
        });
      }
    }

    const nodes: CanvasNode[] = [...preserved, ...protectedKept, ...reflowedKept, ...added];
    const keptIds = new Set(nodes.map(n => n.id));
    const edges = (existing.edges || []).filter(e => keptIds.has(e.fromNode) && keptIds.has(e.toNode));

    return { nodes, edges };
  }

  private shouldKeepUnmanagedFileNode(path: string): boolean {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    if (!(abstract instanceof TFile)) return true;
    return abstract.extension.toLowerCase() !== "md";
  }

  /** Deterministic short ID derived from a file path. */
  private stableId(filePath: string): string {
    let h = 0;
    for (let i = 0; i < filePath.length; i++) {
      h = Math.imul(31, h) + filePath.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h).toString(36).padStart(8, "0");
  }

  private extractTags(cache: any): string[] {
    const tags: string[] = [];
    if (!cache) return tags;

    // Inline #tags
    if (cache.tags) {
      for (const t of cache.tags) {
        tags.push(t.tag.replace(/^#/, ""));
      }
    }

    // Frontmatter tags field
    const fm = cache.frontmatter;
    if (fm?.tags) {
      const raw = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
      for (const t of raw) {
        tags.push(String(t).replace(/^#/, ""));
      }
    }

    return tags;
  }

  private isArchivedCandidate(file: TFile): boolean {
    const settings = this.getSettings();

    if (this.isInAnyFolder(file.path, settings.archiveTriggerFolders || [])) {
      return true;
    }

    const cache = this.app.metadataCache.getFileCache(file);
    const tags = this.extractTags(cache).map(t => t.toLowerCase());
    const archiveTags = (settings.archiveTriggerTags || [])
      .map(t => String(t || "").replace(/^#/, "").trim().toLowerCase())
      .filter(Boolean);

    return tags.some(tag => archiveTags.some(a => tag === a || tag.startsWith(`${a}/`)));
  }

  private isArchiveCanvas(canvasTag: string): boolean {
    const archiveTags = (this.getSettings().archiveTriggerTags || [])
      .map(t => String(t || "").replace(/^#/, "").trim().toLowerCase())
      .filter(Boolean);
    const normalized = String(canvasTag || "").replace(/^#/, "").trim().toLowerCase();
    return archiveTags.some(a => normalized === a || normalized.startsWith(`${a}/`));
  }

  private isInAnyFolder(filePath: string, folders: string[]): boolean {
    const pathLower = String(filePath || "").toLowerCase();
    return (folders || []).some(folder => {
      const clean = String(folder || "")
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase();
      if (!clean) return false;
      return pathLower === clean || pathLower.startsWith(`${clean}/`);
    });
  }

  private isProtectedNode(node: CanvasFileNode, canvas: CanvasData): boolean {
    const rawNode = node as any;
    const hasColor = rawNode.color != null && String(rawNode.color).trim() !== "";
    if (hasColor) return true;

    const linked = (canvas.edges || []).some(e => e.fromNode === node.id || e.toNode === node.id);
    if (linked) return true;

    if (rawNode.group != null || rawNode.parent != null || rawNode.parentId != null) return true;

    return this.isNodeInsideAnyGroup(node, canvas.nodes || []);
  }

  private isNodeInsideAnyGroup(node: CanvasFileNode, nodes: CanvasNode[]): boolean {
    const left = node.x;
    const right = node.x + node.width;
    const top = node.y;
    const bottom = node.y + node.height;

    for (const n of nodes) {
      if (n.type !== "group") continue;
      const gLeft = n.x;
      const gRight = n.x + n.width;
      const gTop = n.y;
      const gBottom = n.y + n.height;
      const fullyInside = left >= gLeft && right <= gRight && top >= gTop && bottom <= gBottom;
      if (fullyInside) return true;
    }

    return false;
  }

  private isTagExcluded(tag: string, excluded: string[]): boolean {
    return excluded.some(
      ex => tag === ex || tag.startsWith(ex + "/"),
    );
  }

  private normalizeTagInput(tag: string): string {
    return String(tag || "").replace(/^#/, "").trim().toLowerCase();
  }

  private getCanonicalTagPageKey(tag: string): string {
    const normalized = this.normalizeTagInput(tag);
    if (!normalized) return "";
    if (normalized === CanvasManager.ROOT_TAG_PAGE) return normalized;
    const segments = normalized.split("/").map(part => part.trim()).filter(Boolean);
    return segments[segments.length - 1] || normalized;
  }

  private isFileExcluded(file: TFile, excludedFolders: string[]): boolean {
    return excludedFolders.some(
      folder =>
        file.path === folder ||
        file.path.startsWith(folder.replace(/\/?$/, "/")),
    );
  }

  private async ensureFolder(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    parts.pop(); // remove filename
    if (parts.length === 0) return;

    const folder = parts.join("/");
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
  }
}
