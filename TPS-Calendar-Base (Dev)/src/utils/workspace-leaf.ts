import { App, WorkspaceLeaf } from "obsidian";

interface ResolveMainAreaLeafOptions {
  preferNewTab?: boolean;
  excludedViewTypes?: string[];
}

export function isSideDockLeaf(leaf: WorkspaceLeaf | null | undefined): boolean {
  const container = (leaf as any)?.containerEl as HTMLElement | undefined;
  if (!container) return false;
  return !!container.closest('.workspace-sidedock, .workspace-split.mod-left-split, .workspace-split.mod-right-split');
}

export function resolveMainAreaLeaf(
  app: App,
  options: ResolveMainAreaLeafOptions = {},
): WorkspaceLeaf | null {
  const { preferNewTab = false, excludedViewTypes = [] } = options;
  if (preferNewTab) {
    return app.workspace.getLeaf("tab");
  }

  const excluded = new Set(excludedViewTypes.map((viewType) => String(viewType || "").trim()));
  const workspaceAny = app.workspace as any;

  const isAllowedLeaf = (leaf: WorkspaceLeaf | null | undefined): leaf is WorkspaceLeaf => {
    if (!leaf || isSideDockLeaf(leaf)) return false;
    const viewType = String(leaf.view?.getViewType?.() || "").trim();
    return !excluded.has(viewType);
  };

  const activeLeaf = workspaceAny?.activeLeaf as WorkspaceLeaf | null | undefined;
  if (isAllowedLeaf(activeLeaf)) {
    return activeLeaf;
  }

  const centerMarkdownLeaf = app.workspace.getLeavesOfType("markdown").find((leaf) => isAllowedLeaf(leaf)) ?? null;
  if (centerMarkdownLeaf) {
    return centerMarkdownLeaf;
  }

  const recentLeaf =
    typeof workspaceAny?.getMostRecentLeaf === "function"
      ? (workspaceAny.getMostRecentLeaf() as WorkspaceLeaf | null)
      : null;
  if (isAllowedLeaf(recentLeaf)) {
    return recentLeaf;
  }

  return app.workspace.getLeaf("tab");
}