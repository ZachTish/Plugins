import type { TFile } from 'obsidian';

export type ParentLinkKind = 'markdown-parent' | 'base-parent' | 'other-parent';
export type BodySubitemLineKind = 'bare' | 'bullet' | 'checkbox';

export interface BodySubitemLink {
  parentPath: string;
  childPath: string;
  line: number;
  kind: BodySubitemLineKind;
  checkboxState: string | null;
  wikilink: string;
  rawLine: string;
  parentFile: TFile;
  childFile: TFile;
}

export interface ResolvedParentLink {
  file: TFile;
  kind: ParentLinkKind;
  source: 'body-derived' | 'child-frontmatter';
}

export interface ReconcileResult {
  addedParents: number;
  removedParents: number;
  touchedChildren: TFile[];
}
