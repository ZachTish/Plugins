export interface KanbanSettings {
  /** Frontmatter key that holds a Lucide icon name (e.g. "icon") */
  iconKey: string;
  /** Frontmatter key that holds a CSS color value (e.g. "color") */
  colorKey: string;
  /** Where to render the ungrouped lane relative to keyed lanes */
  ungroupedPosition: 'first' | 'last';
}

export const DEFAULT_SETTINGS: KanbanSettings = {
  iconKey: 'icon',
  colorKey: 'color',
  ungroupedPosition: 'last',
};
