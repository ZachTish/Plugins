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
