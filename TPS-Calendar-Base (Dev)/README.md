# TPS Calendar Base

A FullCalendar-powered time-grid calendar view that renders inside Obsidian **Bases**. Displays vault notes as events, supports external iCal feeds, and lets you create new events directly from the calendar.

---

## What It Does

### Calendar View (Bases Integration)
- Registers a custom **Bases view type** — drop it into any Base layout to show a time-grid calendar.
- Renders notes as events using configurable frontmatter fields (date, startTime, endTime, title, etc.).
- Supports week, day, continuous-scroll, and **filter-based** display modes.
- Navigation controls (previous/next/today) and condensed event display levels.

### External Calendar Sync
- Reads iCal feed configurations from **TPS-Controller** settings (no duplicate config).
- `ExternalCalendarService` fetches and caches remote `.ics` feeds.
- `ical-parser-service.ts` handles timezone normalization and recurring event expansion.
- Synced events appear alongside vault notes without creating files (display-only by default).

### Event Creation
- Click a time slot to open `NewEventService`, which creates a new note using a configurable template.
- `ExternalEventModal` allows manually importing an external event as a vault note.
- Parent-child links are written to the new note's frontmatter via `parent-child-link.ts`.

### Task Items
- Toggle on in Settings → 📋 Task Items to show inline checkbox tasks as all-day calendar events.
- Parses Tasks-plugin emoji date annotations: 📅 due, ⏳ scheduled, 🛫 start.
- Configurable: choose which date field to use (any / due / scheduled / start), whether to show completed tasks, a custom color, and an optional folder filter.
- Task events appear in the all-day row with a □ icon; clicking opens the source note.
- Uses Obsidian's metadata cache for a fast pre-filter (only files with checkbox list items are read).

### Unscheduled Notes Sidebar
- A dedicated sidebar view (icon: calendar-x) listing all notes in the current Base's filter that have no start date set.
- Activated by clicking the calendar-x icon button that appears in the calendar header when the Base is open.
- Can also be opened via the command "Open unscheduled notes sidebar".
- The list auto-refreshes whenever the calendar data updates (e.g. after any frontmatter change).
- Toggle the header button on/off in Settings → 🔄 General → "Show unscheduled notes button" (default: on).
- Clicking any entry in the sidebar opens that note in the main editor.

### Style Rules
- Define visual rules in settings: match frontmatter conditions → apply a color or CSS class.
- `StyleRuleService` evaluates rules at render time for per-event styling without modifying files.

### Embed Renderer
- Register a markdown post-processor so `calendar` code blocks in notes render a mini calendar embed.

### Filter-Based View Mode
- New view mode option that automatically adjusts the calendar display based on your filtered data range.
- When selected, the calendar analyzes the date range of visible events and chooses the optimal view (day, 3d, 4d, 5d, 7d, week, or month).
- Unlike the legacy "Auto view mode from visible local events" toggle, filter-based mode doesn't persist manual view changes — it always recalculates the best view based on current data.
- Particularly useful for filtered views where you want the calendar to adapt to the time span of your query results.

---

## Source Layout

```
src/
  main.ts                  — Plugin entry, registers view & commands
  calendar-view.tsx         — Bases view host, mounts React tree
  CalendarReactView.tsx     — Top-level React component
  context.tsx               — React context for shared plugin state
  hooks.tsx                 — Custom React hook entry point
  embed-renderer.ts         — Markdown code-block embed support
  plugin-interface.ts       — Typed bridge between plugin & view
  settings-migration.ts     — Upgrades persisted settings across versions
  settings-tab.ts           — Settings UI
  types.ts                  — All TypeScript types
  utils.ts                  — URL normalization, date helpers
  logger.ts                 — Debug logging wrapper
  services/
    external-calendar-service.ts     — iCal feed fetch & caching
    new-event-service.ts             — Creates vault notes from calendar clicks
    style-rule-service.ts            — Evaluates per-event color/style rules
    visual-builder.ts                — FullCalendar event object builder & style editor UI
    parent-child-link.ts             — Writes parent link frontmatter
    ical-parser-service.ts           — .ics parsing with timezone support
    type-folder-service.ts           — Resolves note type → folder mapping
    template-resolution-service.ts
    template-variable-service.ts
    tag-utils.ts
    all-day-events-modal.ts          — All-day event overflow handler
  modals/
    external-event-modal.ts          — UI for importing external events as notes
  components/
    CalendarNavigation.tsx           — Prev/Next/Today toolbar
    ContinuousScrollView.tsx         — Infinite-scroll day layout
    EventRenderer.tsx                — Single event tile rendering
  hooks/                             — Custom React hooks (zoom, scroll, events)
  ui/
    section-helpers.ts
    list-renderer.ts
```

---

## Recent Improvements

### Filter-Based View Mode (New)
- Added new `"filter-based"` view mode option that always auto-calculates the optimal view based on filtered data range.
- Resolves issue where manual navigation would persist and override auto-viewmode behavior.
- When selected, the calendar continuously adapts to show the best time span for your filtered events.

### Continuous View Enhancements
- Improved current day highlighting with subtle background tint and enhanced "Today" badge.
- Better initial scroll positioning that centers on today's date when loading.
- Enhanced current time indicator (red line) visibility and styling.
- Smoother scroll behavior for better user experience.

---

## Known Issues & Planned Improvements

### Critical
- **4 duplicate services** — `external-calendar-service.ts` (131 vs 143 lines), `ical-parser-service.ts` (519 vs 534 lines), `parent-child-link.ts` (356 vs 383 lines), and `template-resolution-service.ts` (82 lines, identical) all exist in both this plugin and TPS-Controller. These have **silently diverged**. Controller should be the canonical source; Calendar-Base should consume them through the typed API.
- **`ExternalCalendarConfig` type duplicated** — Defined independently in both this plugin's `types.ts` and Controller's `types.ts`. Should import from Controller.

### Medium
- **`registerBasesView()` stability** — The Bases API is cutting-edge and semi-experimental. A version guard checking `app.internalPlugins` or checking for API existence before registration would prevent crashes on older Obsidian versions.
- **`app.workspace.activeLeaf` (deprecated)** — Replace with `getActiveViewOfType()` / `ensureSideLeaf()` (public since v1.7.2).
- **`CalendarView.ts` still large** — ~4088 lines after last refactor. Consider splitting into `CalendarEventService`, `CalendarRenderService`, `CalendarStateManager`.
- **iCal sync missing retry logic** — Failed fetch attempts are dropped silently. Add exponential backoff and stale-while-revalidate caching.
- **No `onExternalSettingsChange()`** — iCal URL changes synced via Obsidian Sync don't apply until vault reload.

### Low
- **No `ensureSideLeaf()`** — Open/reveal commands should use the now-public `Workspace#ensureSideLeaf()` for correct behavior when the leaf already exists.
- **React bundle weight** — FullCalendar + React adds significant bundle size. Not necessarily a problem, but worth profiling load time.

### Planned
- Calendar-Base becomes a view-consumer of Controller's canonical calendar service.
- Natural language "quick add" event creation via the time-calculation service.
- Use `View.scope` for calendar navigation hotkeys (next/prev period, jump to today).

---

## Integration with TPS Suite

| Plugin | Relationship |
|--------|-------------|
| TPS-Controller | Reads iCal config; shares 4 service files (to be consolidated) |
| TPS-GCM | Independent — both render the same vault notes |
| TPS-Notifier | Independent |
| TPS-NNC | Independent |

> For full analysis, see `TPS-ANALYSIS.md` in the plugins root.

---

## Shared Utility Files (Intentional Duplication)

The following source files are deliberately copied from TPS-Controller. Each plugin is self-contained to avoid build-time cross-plugin dependencies. When updating logic, mirror the change to all copies:

| File | Also in |
|------|---------|
| `src/utils/tag-utils.ts` | TPS-Controller, TPS-GCM |
| `src/utils/template-resolution-service.ts` | TPS-Controller |
| `src/utils/template-variable-service.ts` | TPS-Controller |
| `src/ui/list-renderer.ts` | TPS-Controller, TPS-GCM |
| `src/ui/section-helpers.ts` | TPS-Controller, TPS-GCM |
