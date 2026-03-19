import { MarkdownView, WorkspaceLeaf } from 'obsidian';

export function resolveLeafForFile(_file: any): WorkspaceLeaf | null {
  return null;
}

export function scoreMarkdownLeaf(_leaf: WorkspaceLeaf, _activeLeaf: WorkspaceLeaf | null = null): number {
  return 0;
}

export function isLeafActiveInDom(_leaf: WorkspaceLeaf): boolean {
  return false;
}

export function isLeafVisible(_leaf: WorkspaceLeaf): boolean {
  return false;
}

export function isSideDockLeaf(_leaf: WorkspaceLeaf): boolean {
  return false;
}

export function pickBestMarkdownLeaf(_leaves: WorkspaceLeaf[]): WorkspaceLeaf | null {
  return null;
}

export function resolvePrimaryMarkdownView(_app: any): MarkdownView | null {
  return null;
}

export function getCompatibleMarkdownViewFromLeaf(_leaf: WorkspaceLeaf): MarkdownView | null {
  return null;
}

export function isCompatibleMarkdownView(_view: any): _view is MarkdownView {
  return false;
}

export function getViewMode(_view: MarkdownView): string {
  return 'source';
}
