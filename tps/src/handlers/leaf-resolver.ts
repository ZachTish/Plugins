/**
 * Pure utilities for resolving compatible Markdown workspace leaves.
 * Extracted from PersistentMenuManager to keep that class focused on menu lifecycle.
 */
import { App, MarkdownView, WorkspaceLeaf } from 'obsidian';

export function isCompatibleMarkdownView(view: unknown): view is MarkdownView {
  if (!view || typeof view !== 'object') return false;
  const candidate = view as MarkdownView;
  const viewType =
    typeof (candidate as any).getViewType === 'function'
      ? (candidate as any).getViewType()
      : (candidate as any).viewType;
  return (
    viewType === 'markdown' &&
    !!(candidate as any).contentEl &&
    typeof (candidate as any).contentEl.querySelector === 'function'
  );
}

export function getViewMode(view: MarkdownView): 'preview' | 'source' | null {
  const anyView = view as any;

  try {
    if (typeof anyView.getMode === 'function') {
      const mode = anyView.getMode();
      if (mode === 'preview' || mode === 'source') return mode;
    }
  } catch {
    // ignore and continue with structural detection
  }

  if (typeof anyView.mode === 'string') {
    if (anyView.mode === 'preview' || anyView.mode === 'source') return anyView.mode;
  }

  if (typeof anyView.currentMode === 'string') {
    if (anyView.currentMode === 'preview' || anyView.currentMode === 'source') return anyView.currentMode;
  }

  const root = anyView.contentEl as HTMLElement | undefined;
  if (root?.querySelector('.markdown-source-view')) return 'source';
  if (root?.querySelector('.markdown-preview-view')) return 'preview';
  return null;
}

export function getCompatibleMarkdownViewFromLeaf(leaf: WorkspaceLeaf | null | undefined): MarkdownView | null {
  if (!leaf) return null;
  const view = (leaf as any).view;
  if (!isCompatibleMarkdownView(view)) return null;
  return view;
}

export function resolvePrimaryMarkdownView(app: App): MarkdownView | null {
  const activeMarkdownView = app.workspace.getActiveViewOfType(MarkdownView);
  if (isCompatibleMarkdownView(activeMarkdownView) && activeMarkdownView.file) {
    return activeMarkdownView;
  }

  const allLeaves = app.workspace.getLeavesOfType('markdown');
  const leaves = allLeaves.filter((leaf) => !!getCompatibleMarkdownViewFromLeaf(leaf));
  if (!leaves.length) return null;

  const activeLeaf = app.workspace.activeLeaf;
  const activeView = getCompatibleMarkdownViewFromLeaf(activeLeaf);
  if (activeView && activeView.file && isLeafVisible(activeLeaf as WorkspaceLeaf)) {
    return activeView;
  }

  const activeFile = app.workspace.getActiveFile();
  if (activeFile) {
    const matchingLeaves = leaves.filter((leaf) => {
      const view = getCompatibleMarkdownViewFromLeaf(leaf);
      if (!view) return false;
      return !!view?.file && view.file.path === activeFile.path;
    });
    const preferred = pickBestMarkdownLeaf(matchingLeaves, activeLeaf) ?? pickBestMarkdownLeaf(leaves, activeLeaf);
    const preferredView = getCompatibleMarkdownViewFromLeaf(preferred);
    if (preferredView) return preferredView;
  }

  const fallback = pickBestMarkdownLeaf(leaves, activeLeaf);
  return getCompatibleMarkdownViewFromLeaf(fallback);
}

export function pickBestMarkdownLeaf(
  candidates: WorkspaceLeaf[],
  activeLeaf: WorkspaceLeaf | null
): WorkspaceLeaf | null {
  if (!candidates.length) return null;

  const scored = candidates.map((leaf, index) => ({
    leaf,
    index,
    score: scoreMarkdownLeaf(leaf, activeLeaf),
  }));

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });

  return scored[0]?.leaf ?? null;
}

export function scoreMarkdownLeaf(leaf: WorkspaceLeaf, activeLeaf: WorkspaceLeaf | null): number {
  let score = 0;

  if (leaf === activeLeaf) score += 1000;
  if (isLeafActiveInDom(leaf)) score += 500;
  if (!isSideDockLeaf(leaf)) score += 250;
  if (isLeafVisible(leaf)) score += 150;

  const view = getCompatibleMarkdownViewFromLeaf(leaf);
  if (!view) return -1;
  if (view?.file) score += 25;
  if (getViewMode(view) === 'preview') score += 10;

  return score;
}

export function isLeafActiveInDom(leaf: WorkspaceLeaf): boolean {
  const container = (leaf as any)?.containerEl as HTMLElement | undefined;
  if (!container || !container.isConnected) return false;

  if (container.classList.contains('mod-active')) return true;

  const workspaceLeaf = container.closest<HTMLElement>('.workspace-leaf');
  if (workspaceLeaf?.classList.contains('mod-active')) return true;

  const activeElement = document.activeElement as HTMLElement | null;
  return !!activeElement && container.contains(activeElement);
}

export function isLeafVisible(leaf: WorkspaceLeaf): boolean {
  const container = (leaf as any)?.containerEl as HTMLElement | undefined;
  if (!container || !container.isConnected) return false;

  const rect = container.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 40) return false;

  const style = window.getComputedStyle(container);
  if (style.display === 'none' || style.visibility === 'hidden') return false;

  return true;
}

export function isSideDockLeaf(leaf: WorkspaceLeaf): boolean {
  const container = (leaf as any)?.containerEl as HTMLElement | undefined;
  if (!container) return false;
  return !!container.closest('.workspace-sidedock, .workspace-split.mod-left-split, .workspace-split.mod-right-split');
}
