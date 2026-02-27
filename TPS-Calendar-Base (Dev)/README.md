# TPS Calendar Base

A FullCalendar-powered time-grid calendar view that renders inside Obsidian **Bases**. Displays vault notes as events, supports external iCal feeds, and lets you create new events directly from the calendar.

---

## What It Does

### Calendar View (Bases Integration)
- Registers a custom **Bases view type** — drop it into any Base layout to show a time-grid calendar.
- Renders notes as events using configurable frontmatter fields (date, startTime, endTime, title, etc.).
- Supports week, day, and continuous-scroll display modes.
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

### Style Rules
- Define visual rules in settings: match frontmatter conditions → apply a color or CSS class.
- `StyleRuleService` evaluates rules at render time for per-event styling without modifying files.

### Embed Renderer
- Register a markdown post-processor so `calendar` code blocks in notes render a mini calendar embed.

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
