import { TFile } from "obsidian";

export interface PageEntry {
  file: TFile;
  title: string;
  bodyContent: string;
  rawContent: string;
  frontmatter: string;
}

export interface GroupedPageEntries {
  groupLabel: string;
  groupValue: unknown;
  entries: PageEntry[];
}

export type PageViewContent = PageEntry[] | GroupedPageEntries[];

export interface ViewOptionsConfig {
  entryTitleSource: string;
  showFullPath: boolean;
  lazyLoadThreshold: number;
}

// Removed HoverEditorOptions and EditorState for read-only view
