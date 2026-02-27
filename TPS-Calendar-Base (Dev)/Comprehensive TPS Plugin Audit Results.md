# Comprehensive TPS Plugin Audit Results - TPS-Calendar-Base

Audit date: 2026-02-25  
Scope: `src/**/*.ts` plus build verification (`npm run -s build`)

## Validation Summary
- `npm run -s build` passes.
- View/config architecture was simplified: Configure View now focuses on data mapping and display basics.
- Type-safety debt remains significant: `206` explicit `any` usages (`: any` / `as any`).

## Implemented Optimizations (Completed)

### 1) Configure View bloat reduction
- Removed behavior-heavy groups from Bases Configure View:
  - removed `View mode` group controls
  - removed `Time range` group controls
  - removed `New events` folder override control
- Configure View now keeps essentials (`Properties`, `Display`, per-calendar visibility).
- Evidence:
  - `src/calendar-view.tsx:3670`
  - `src/calendar-view.tsx:3735`

### 2) Moved navigation/time behavior controls to plugin settings (global)
- Added global settings and migration for:
  - default `viewMode`
  - `filterRangeAuto`
  - `contextDateEnabled`
  - `weekStartDay`
  - `navStep`
  - `showNavButtons`
  - `minHour` / `maxHour`
  - `showHiddenHoursToggle`
- Added full settings UI section: `Calendar View Defaults`.
- Evidence:
  - `src/types.ts:106`
  - `src/settings-migration.ts:43`
  - `src/settings-tab.ts:206`

### 3) Calendar runtime now reads global behavior settings
- `loadConfig()` now uses plugin settings for view/navigation/time-range behavior.
- `refreshFromPluginSettings()` now reloads config before refresh so global changes apply immediately.
- Evidence:
  - `src/calendar-view.tsx:471`
  - `src/calendar-view.tsx:487`
  - `src/calendar-view.tsx:500`
  - `src/calendar-view.tsx:3627`

### 4) Folder override removed from event creation path
- Removed `folderOverride` from new-event creation options.
- Event creation target now flows from filter-derived defaults + optional type picker override.
- Added broader folder extraction from filter conditions, including path-based conditions.
- Evidence:
  - `src/new-event-service.ts:39`
  - `src/new-event-service.ts:145`
  - `src/calendar-view.tsx:1425`
  - `src/calendar-view.tsx:3292`

### 5) Auto view mode now behaves on visible local events only
- Auto-range computation excludes external/virtual entries.
- Added explicit 4-day mode support for ranges like yesterday/today/tomorrow/next day.
- Evidence:
  - `src/calendar-view.tsx:1076`
  - `src/calendar-view.tsx:1091`
  - `src/calendar-view.tsx:1145`
  - `src/CalendarReactView.tsx:48`
  - `src/CalendarReactView.tsx:1376`

### 6) Navigation lock when auto-range mode is active
- Added `navigationLockedByAutoRange` in view state.
- Prev/Next/Today/date-picker navigation is disabled when auto range is actively controlling the viewport.
- Evidence:
  - `src/calendar-view.tsx:94`
  - `src/calendar-view.tsx:2421`
  - `src/CalendarReactView.tsx:1206`
  - `src/components/CalendarNavigation.tsx:7`

### 7) Hidden-hours toggle is now real UI (not dead config)
- Implemented `Hours` toggle button in desktop/mobile navigation.
- Wired to `hiddenTimeVisible` state and respects global `showHiddenHoursToggle`.
- Evidence:
  - `src/CalendarReactView.tsx:1496`
  - `src/components/CalendarNavigation.tsx:193`
  - `src/components/CalendarNavigation.tsx:315`

### 8) Prior critical fixes retained
- Parent-link prompt restored.
- Recurrence expansion hard cap reduced.
- Dedupe key corrected.
- Listener lifecycle cleanup for calendar event/day handlers.
- External fetch/cache hardening with in-flight dedupe + timeout cleanup.

## Remaining Findings (Ordered by Severity)

### 1) High - Delete handler still scales as O(deleted_files * markdown_files)
- Evidence:
  - `src/main.ts:92`
  - `src/main.ts:95`
  - `src/main.ts:97`
- Risk:
  - Bulk delete operations can stall UI on large vaults.
- Best fix:
  - Maintain reverse child-link index and update incrementally instead of full-vault scan per delete.

### 2) Medium - External/local event matching still performs repeated nested scans
- Evidence:
  - `src/calendar-view.tsx:805`
  - `src/calendar-view.tsx:823`
  - `src/calendar-view.tsx:1032`
- Risk:
  - High CPU cost with many local entries + many external events.
- Best fix:
  - Pre-index external events by `id` and `uid+slot`, then use O(1)/bounded lookups.

### 3) Medium - High explicit `any` usage in core calendar view/services
- Evidence:
  - `206` explicit `any` tokens across plugin source.
- Risk:
  - Weaker type guarantees in drag/drop, event wrappers, and view interop.
- Best fix:
  - Type `CalendarEntry` extended props and FullCalendar callback payloads first.

### 4) Accepted risk - Tokenized external calendar URLs remain in plugin settings
- Evidence:
  - `src/types.ts:64`
  - `src/main.ts:139`
- Risk:
  - Plaintext settings storage remains readable by local processes/plugins.
- Status:
  - Explicitly accepted for now.

## Confirmed Behavior Decisions Applied
1. Parent linking remains available in creation flow.
2. Any local note with matching event identity suppresses external recreation/display.
3. Recurrence completeness does not override responsiveness.
4. Simplicity and reliability are prioritized over unnecessary complexity.
5. Plaintext URL storage remains accepted for now.

## Next Recommended Fix Sequence
1. Replace delete full-scan with indexed parent/child reference tracking.
2. Add indexed external/local matching pipeline.
3. Continue reducing `any` in `calendar-view.tsx` and `CalendarReactView.tsx`.
4. Optionally add secure-token mode later if storage constraints change.
