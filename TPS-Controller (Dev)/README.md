# TPS Controller

The central orchestration hub for the TPS plugin suite. All background services and cross-plugin coordination run through this plugin.

---

## What It Does

### Device Role Management
Designates each Obsidian device as either **Controller** or **Replica**.
- **Controller** — runs all background services (calendar sync, reminders, auto-create).
- **Replica** — read-only participant; skips CPU-intensive vault-wide operations.

Role is determined by a device identifier stored in `data.json` and surfaced in the status bar.

---

## Services

### External Calendar Sync (`external-calendar-service.ts`)
- Fetches iCal feeds (`.ics` URLs) on a configurable polling interval.
- Parses events via `ical-parser-service.ts` with timezone normalization.
- Deduplicates against existing vault notes using `externaleventid` frontmatter.

### Auto-Create Service (`auto-create-service.ts`)
- When a new calendar event is detected, creates a note from a configurable template.
- Resolves template variables (title, date, location, description) via `template-variable-service.ts`.
- Writes parent-child links between the created note and its source event.

### Reminder Engine (`reminder-engine.ts`)
- Polls vault files on an interval and evaluates frontmatter against reminder rules.
- Delegates firing to the **TPS-Notifier** plugin via cross-plugin API call.
- Shared reminder rule definitions live in `types.ts`.

### Sync Conflict Watcher (`sync-conflict-watcher.ts`)
- Monitors for Obsidian Sync conflict copies and surfaces them as notices.

### Sync Request Service (`sync-request-service.ts`)
- Coordinates inter-device sync triggers via a `.sync-request.json` sentinel file.

---

## Cross-Plugin API

Exposes a typed API surface consumed by other TPS plugins:
- `getRole()` — returns current device role.
- `getExternalCalendarService()` — provides the calendar service to Calendar-Base.
- `sendNotification()` — delegates to Notifier.
- `applyRulesToAllFiles()` / `applyRulesToFile()` — delegates to Notebook Navigator Companion.

---

## Source Layout

```
src/
  main.ts                  — Plugin entry, wires all services together
  device-role-manager.ts   — Controller / Replica role logic
  settings-tab.ts          — Settings UI
  types.ts                 — Shared types (roles, calendar, reminders)
  utils.ts                 — URL/tag normalization helpers
  logger.ts                — Debug logging wrapper
  services/
    auto-create-service.ts           — Note creation from calendar events
    external-calendar-service.ts     — iCal feed fetching & caching
    ical-parser-service.ts           — .ics parsing with timezone support
    reminder-engine.ts               — Frontmatter-based reminder scheduling
    sync-conflict-watcher.ts         — Obsidian Sync conflict detection
    sync-request-service.ts          — Inter-device sync coordination
    controller-lock-service.ts       — Controller lock file management
    template-resolution-service.ts
    template-variable-service.ts
    time-calculation-service.ts
    parent-child-link.ts
    external-event-modal.ts
    tag-utils.ts
    activity-tracker.ts
```

---

## Known Issues & Planned Improvements

### Critical
- **`pollMinutes: 0.5` default** — 30-second polling is extremely aggressive. Default should be `2.0` (2 minutes). Better: switch to event-driven evaluation using `metadataCache:changed` with a 5-minute fallback timer.
- **`endProperty: "timeEstimate"` semantic mismatch** — `timeEstimate` is a duration, not an end time. Default should be `"timeEnd"` or `"scheduledEnd"` to match GCM frontmatter conventions.
- **Duplicate services** — `external-calendar-service.ts`, `ical-parser-service.ts`, `parent-child-link.ts`, `template-resolution-service.ts`, and `tag-utils.ts` all exist in both this plugin and TPS-Calendar-Base. Controller should be the canonical source; Calendar-Base should consume them through the typed API.

### Medium
- **No typed API interface** — Other plugins access Controller via `(this.app as any).plugins?.getPlugin?.("tps-controller")` with no type contract. Define and export a formal `TPSControllerAPI` interface (see `Examples/notebook-navigator/src/api/` for reference pattern).
- **`(window as any).TPS` global** — Not cleaned up in `onunload()`. Add `delete (window as any).TPS` to prevent stale reference after plugin disabled.
- **No `onExternalSettingsChange()`** — Device role changes and reminder config synced via Obsidian Sync don't take effect until vault reload.
- **Auto-create service has no rate limit** — On first scan, could create many files rapidly.

### Low
- **`app.workspace.activeLeaf` (deprecated)** — Replace throughout with `getActiveViewOfType()`.
- **`getAbstractFileByPath` usage** — Replace with `vault.getFileByPath()` (v1.5.7+).
- **No `onUserEnable()` hook** — First-time setup (folder creation, role selection) should use this instead of running every `onload()`.

### Planned
- Formal `TPSControllerAPI` class with versioning and typed sub-modules (RemindersAPI, CalendarAPI, DeviceRoleAPI).
- `removeCommand()` usage to dynamically un-register commands that don't apply to current device role.
- Per-device named profiles ("Work Mac", "iPad") for device-specific settings.
- Event-driven reminders: evaluate files immediately on `metadataCache:changed` instead of polling.

---

## Integration with TPS Suite

| Plugin | Relationship |
|--------|-------------|
| TPS-Calendar-Base | Shares 4 service files (currently duplicated — to be consolidated) |
| TPS-Notifier | Drives Notifier's reminder dispatch; owns the `ReminderEngine` |
| TPS-NNC | NNC queries Controller for device role via plugin API |
| TPS-GCM | GCM reads device role from Controller (optional) |

> For full analysis, see `TPS-ANALYSIS.md` in the plugins root.

---

## Shared Utility Files (Intentional Duplication)

The following source files are deliberately copied across multiple TPS plugins. Each plugin remains fully self-contained to avoid build-time cross-plugin dependencies. When updating logic in one of these files, mirror the change to the other plugins that carry a copy:

| File | Also in |
|------|---------|
| `src/utils/tag-utils.ts` | TPS-Calendar-Base, TPS-GCM |
| `src/utils/template-resolution-service.ts` | TPS-Calendar-Base |
| `src/utils/template-variable-service.ts` | TPS-Calendar-Base |
| `src/utils/time-calculation-service.ts` | TPS-Notifier |
| `src/ui/list-renderer.ts` | TPS-Calendar-Base, TPS-GCM |
| `src/ui/section-helpers.ts` | TPS-Calendar-Base, TPS-GCM |
