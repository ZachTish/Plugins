import type { TFile } from 'obsidian';

export type ParentLinkKind = 'markdown-parent' | 'base-parent' | 'other-parent';
export type BodySubitemLineKind = 'bare' | 'bullet' | 'checkbox' | 'heading';
export const DETACHED_SUBITEM_MARKER = '<!-- tps-gcm:detached-subitem -->';

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

export type SubitemRelationshipMismatchKind = 'body-only' | 'frontmatter-only';

export interface SubitemRelationshipMismatch {
  kind: SubitemRelationshipMismatchKind;
  parentFile: TFile;
  childFile: TFile;
  line?: number;
  rawLine?: string;
}
