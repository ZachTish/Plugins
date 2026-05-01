import { TextComponent } from "obsidian";

export type BindCommittedText = (
  text: TextComponent,
  initialValue: string,
  commit: (value: string) => Promise<void>,
  refreshOnCommit?: boolean,
  applyToActiveFileOnCommit?: boolean
) => void;
