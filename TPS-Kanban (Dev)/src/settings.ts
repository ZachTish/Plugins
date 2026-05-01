export interface KanbanSettings {
  /** Frontmatter key that holds a Lucide icon name (e.g. "icon") */
  iconKey: string;
  /** Frontmatter key that holds a CSS color value (e.g. "color") */
  colorKey: string;
  /** Where frontmatter color should apply */
  frontmatterColorTarget: "card" | "icon" | "both" | "off";
  /** Where to render the ungrouped lane relative to keyed lanes */
  ungroupedPosition: 'first' | 'last';
  /** Default creation mode for new cards */
  defaultCreateMode: 'note' | 'task';
  /** Default creation destination for new cards */
  defaultCreateDestination: string;
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
  defaultCreateMode: 'note',
  defaultCreateDestination: '',
  laneOrderByView: {},
  kanbanTaskCardPosition: 'bottom',
  scale: 1,
  layoutModeByView: {},
  dynamicEmptyLaneWidth: false,
  enableKanbanTaskCards: true,
  laneLabelAliasesByView: {},
};

const SCALE_MIN = 0.7;
const SCALE_MAX = 1.4;

export function normalizeKanbanScale(value: unknown): number {
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.scale;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, n));
}

function normStr(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s || fallback;
}

function normBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function normRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

export function sanitizeKanbanSettings(raw: Partial<KanbanSettings> | Record<string, unknown>): KanbanSettings {
  const r = raw as Record<string, unknown>;
  const colorTargets: KanbanSettings['frontmatterColorTarget'][] = ['card', 'icon', 'both', 'off'];
  const positions: KanbanSettings['ungroupedPosition'][] = ['first', 'last'];
  const createModes: KanbanSettings['defaultCreateMode'][] = ['note', 'task'];
  const cardPositions: KanbanSettings['kanbanTaskCardPosition'][] = ['top', 'bottom'];

  const frontmatterColorTarget = colorTargets.includes(r.frontmatterColorTarget as KanbanSettings['frontmatterColorTarget'])
    ? r.frontmatterColorTarget as KanbanSettings['frontmatterColorTarget']
    : DEFAULT_SETTINGS.frontmatterColorTarget;
  const ungroupedPosition = positions.includes(r.ungroupedPosition as KanbanSettings['ungroupedPosition'])
    ? r.ungroupedPosition as KanbanSettings['ungroupedPosition']
    : DEFAULT_SETTINGS.ungroupedPosition;
  const defaultCreateMode = createModes.includes(r.defaultCreateMode as KanbanSettings['defaultCreateMode'])
    ? r.defaultCreateMode as KanbanSettings['defaultCreateMode']
    : DEFAULT_SETTINGS.defaultCreateMode;
  const kanbanTaskCardPosition = cardPositions.includes(r.kanbanTaskCardPosition as KanbanSettings['kanbanTaskCardPosition'])
    ? r.kanbanTaskCardPosition as KanbanSettings['kanbanTaskCardPosition']
    : DEFAULT_SETTINGS.kanbanTaskCardPosition;

  return {
    iconKey: normStr(r.iconKey, DEFAULT_SETTINGS.iconKey),
    colorKey: normStr(r.colorKey, DEFAULT_SETTINGS.colorKey),
    frontmatterColorTarget,
    ungroupedPosition,
    defaultCreateMode,
    defaultCreateDestination: typeof r.defaultCreateDestination === 'string' ? r.defaultCreateDestination.trim() : DEFAULT_SETTINGS.defaultCreateDestination,
    laneOrderByView: normRecord(r.laneOrderByView) as Record<string, string[]>,
    kanbanTaskCardPosition,
    scale: normalizeKanbanScale(r.scale),
    layoutModeByView: normRecord(r.layoutModeByView) as Record<string, 'board' | 'list'>,
    dynamicEmptyLaneWidth: normBool(r.dynamicEmptyLaneWidth, DEFAULT_SETTINGS.dynamicEmptyLaneWidth),
    enableKanbanTaskCards: normBool(r.enableKanbanTaskCards, DEFAULT_SETTINGS.enableKanbanTaskCards),
    laneLabelAliasesByView: normRecord(r.laneLabelAliasesByView) as Record<string, Record<string, string>>,
  };
}
