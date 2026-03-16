export interface KanbanSettings {
  /** Frontmatter key that holds a Lucide icon name (e.g. "icon") */
  iconKey: string;
  /** Frontmatter key that holds a CSS color value (e.g. "color") */
  colorKey: string;
  /** Where frontmatter color should apply */
  frontmatterColorTarget: "card" | "icon" | "both" | "off";
  /** Where to render the ungrouped lane relative to keyed lanes */
  ungroupedPosition: 'first' | 'last';
  /** Persisted manual lane order keyed by "<basePath>::<viewName>" */
  laneOrderByView: Record<string, string[]>;
  /** Where task-level cards from Kanban board checkboxes render relative to the board note card */
  kanbanTaskCardPosition: 'top' | 'bottom';
  /** Global visual scale for the kanban board */
  scale: number;
  /** Per-view layout mode: board (columns) or list (stacked lanes) */
  layoutModeByView: Record<string, 'board' | 'list'>;
  /** In board mode, shrink empty lanes to a narrower width */
  dynamicEmptyLaneWidth: boolean;
  /** Render line-level task cards parsed from kanban board notes */
  enableKanbanTaskCards: boolean;
  /** Per-view lane label overrides keyed by lane id */
  laneLabelAliasesByView: Record<string, Record<string, string>>;
}

export const DEFAULT_SETTINGS: KanbanSettings = {
  iconKey: 'icon',
  colorKey: 'color',
  frontmatterColorTarget: 'both',
  ungroupedPosition: 'last',
  laneOrderByView: {},
  kanbanTaskCardPosition: 'bottom',
  scale: 1,
  layoutModeByView: {},
  dynamicEmptyLaneWidth: false,
  enableKanbanTaskCards: true,
  laneLabelAliasesByView: {},
};
