export type TagPageFileType = "canvas" | "markdown" | "base";

export interface NotebookNavigatorCompanionSettings {
  metadataDebounceMs: number;
  syncTitleFromFilename: boolean;
  syncFilenameFromTitle: boolean;
  statusClickFlow: string[];
  tagPageFolder: string;
  tagPageFileType: TagPageFileType;
  createTagPageOnOpen: boolean;
  propertyPageFolder: string;
  propertyPageFileType: TagPageFileType;
  createPropertyPageOnOpen: boolean;
  upstreamLinkKeys: string[]; // Keys that trigger updates on the linked note when this note changes
  frontmatterWriteExclusions: string;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: NotebookNavigatorCompanionSettings = {
  metadataDebounceMs: 150,
  syncTitleFromFilename: false,
  syncFilenameFromTitle: false,
  statusClickFlow: [],
  tagPageFolder: "Tag Pages",
  tagPageFileType: "canvas",
  createTagPageOnOpen: true,
  propertyPageFolder: "Property Pages",
  propertyPageFileType: "canvas",
  createPropertyPageOnOpen: false,
  upstreamLinkKeys: ["childOf"],
  frontmatterWriteExclusions: "",
  debugLogging: false,
};
