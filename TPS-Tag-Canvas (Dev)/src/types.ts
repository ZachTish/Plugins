export interface TagCanvasSettings {
  /** Vault-relative folder where .canvas files are created */
  canvasFolder: string;
  /** Tags (without #) to skip when syncing */
  excludedTags: string[];
  /** Folder paths whose notes should be ignored when scanning tags */
  excludedFolders: string[];
  /** Tags (without #) that mark a note as archived/hidden across canvases */
  archiveTriggerTags: string[];
  /** Folder paths that mark notes as archived/hidden across canvases */
  archiveTriggerFolders: string[];
  /** Automatically re-sync canvases when notes change */
  autoSync: boolean;
  /** Debounce delay (ms) before flushing pending syncs */
  syncDelayMs: number;
  /** Width of each file node (px) */
  nodeWidth: number;
  /** Height of each file node (px) */
  nodeHeight: number;
  /** Number of columns in the initial grid layout */
  columns: number;
  /** Gap between nodes (px) */
  gap: number;
  /** Log debug output to the console */
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: TagCanvasSettings = {
  canvasFolder: "Tag Canvases",
  excludedTags: [],
  excludedFolders: [],
  archiveTriggerTags: ["hide", "archive"],
  archiveTriggerFolders: ["Archive"],
  autoSync: true,
  syncDelayMs: 2000,
  nodeWidth: 400,
  nodeHeight: 300,
  columns: 3,
  gap: 30,
  debugLogging: false,
};

// ─── canvas JSON types ───────────────────────────────────────────────────────

export interface CanvasFileNode {
  id: string;
  type: "file";
  file: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasTextNode {
  id: string;
  type: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasGroupNode {
  id: string;
  type: "group";
  label?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasNode = CanvasFileNode | CanvasTextNode | CanvasGroupNode;

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide: string;
  toNode: string;
  toSide: string;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
