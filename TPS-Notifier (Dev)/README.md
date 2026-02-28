# TPS Notifier

Sends push notifications from the vault to any device using **ntfy.sh** (or a self-hosted ntfy server). Also surfaces overdue items in an in-vault panel and supports snoozing reminders by writing back to frontmatter.

---

## What It Does

### Push Notifications (ntfy)
- Delivers notifications to any phone or desktop via the ntfy.sh HTTP API.
- Configurable server URL, topic, and priority (1–5).
- Notification payload includes the note title, a time-remaining or overdue label, and an action link back into Obsidian.

### Notification View
- Registers a sidebar leaf (`NOTIFICATION_VIEW_TYPE`) showing all pending and recently fired reminders.
- Command: **View Notifications** — opens the sidebar panel.
- Command: **Send Custom Notification** — opens a modal to send a one-off message.

### Overdue Items Modal (`OverdueItemsModal`)
- Lists all vault files whose reminder date has passed.
- Actions per item: open note, snooze, dismiss.

### Snooze System
- Snoozing writes a `reminderSnooze` (configurable key) timestamp to the file's frontmatter.
- `TimeCalculationService` respects the snooze offset when evaluating whether a reminder is due.
- Snooze durations are configurable (default: 15 min, 1 hr, 4 hr, 1 day).

### Time Calculation Service (`time-calculation-service.ts`)
- Parses date/time frontmatter values with flexible format support.
- `parseTimeRange` — extracts start/end from a single string field.
- `parseDuration` — converts human strings ("2h", "30m") to milliseconds.
- `getEffectiveEndTime` — resolves end time from duration or explicit field.
- `checkStopCondition` — skips reminders for notes whose status indicates completion.
- `formatRemaining` — produces human-readable "in 2 hours" / "3 hours ago" labels.

### Controller Integration
- Reminder rules and polling intervals are defined in **TPS-Controller** settings.
- The Controller calls `sendNotification()` / `snoozeFile()` on this plugin via the cross-plugin API.
- Notifier itself does not poll; it is driven by the Controller's `ReminderEngine`.

---

## Source Layout

```
src/
  main.ts                  — Plugin entry, registers view & commands
  notification-view.ts     — Sidebar leaf showing pending reminders
  settings-tab.ts          — Settings UI (ntfy server, topic, snooze options)
  types.ts                 — TPSNotifierSettings, PropertyReminder, OverdueItem
  logger.ts                — Debug logging wrapper
  modals/
    overdue-modal.ts       — Modal listing overdue items with actions
    snooze-modal.ts        — Duration picker for snoozing a reminder
  services/
    time-calculation-service.ts — Date/time parsing and reminder evaluation
  ui/
    list-renderer.ts
    section-helpers.ts
```

---

## Known Issues & Planned Improvements

### Critical
- **`time-calculation-service.ts` is a duplicate** — This file (276 lines) is a copy of `TPS-Controller (Dev)/src/services/time-calculation-service.ts` (286 lines) that has silently diverged. Since Controller owns the `ReminderEngine`, Notifier should import these utilities from Controller's typed API and delete its local copy.
- **`PropertyReminder` type duplicated** — Defined identically in both `types.ts` here and in Controller's `types.ts`. Notifier should import from Controller.

### Medium
- **`pollMinutes: 0.5` default** — 30-second polling is too aggressive. Default should be `2.0`. (Note: Notifier itself does not poll — this legacy field exists in settings but is unused at runtime.)
- **Legacy dead fields in `TPSNotifierSettings`** — `deviceRole?`, `pollMinutes?`, `reminders?`, `alertState?` are retained for migration compat but never read. Either clean them up (with migration guard) or document explicitly with `/** @deprecated */` JSDoc tags.
- **No retry on failed ntfy.sh push** — A failed HTTP push is silently dropped. Should retry 2-3 times with brief delay before giving up.
- **ntfy.sh URL has no validation** — Free-text field should validate `http://`/`https://` prefix and optionally ping on save.

### Low
- **No `onExternalSettingsChange()`** — ntfy.sh topic/server changes synced via Obsidian Sync don't reload until restart.
- **Snooze property not auto-cleared** — Check whether `reminderSnooze` frontmatter is cleared after the snooze time passes. If not, stale snooze values will perpetually block re-notification.
- **No reminder delivery history** — Failed or sent notifications are not logged. A small rolling log (50 entries) in settings would help with debugging missed alerts.

### Planned
- Delete local `time-calculation-service.ts` and import from Controller API.
- Import `PropertyReminder` type from Controller.
- Add retry logic with 3-attempt exponential backoff for ntfy.sh pushes.
- URL validation + connection test button in settings.
- Reminder delivery history log.

---

## Integration with TPS Suite

| Plugin | Relationship |
|--------|-------------|
| TPS-Controller | **Primary dependency** — Controller drives all reminder evaluation and calls `sendNotification()` on this plugin |
| TPS-GCM | GCM writes `reminderSnooze` frontmatter that Notifier/Controller reads |
| TPS-Calendar-Base | Independent |
| TPS-NNC | Independent |

> For full analysis, see `TPS-ANALYSIS.md` in the plugins root.

---

## Shared Utility Files (Intentional Duplication)

The following source file is deliberately copied from TPS-Controller. Each plugin is self-contained to avoid build-time cross-plugin dependencies. When updating logic, mirror the change to all copies:

| File | Also in |
|------|---------|
| `src/utils/time-calculation-service.ts` | TPS-Controller |

**Note:** `PropertyReminder` is defined in TPS-Controller as the canonical source. Notifier carries a local copy in `src/utils/time-calculation-service.ts` solely for its overdue-scan evaluation logic. Reminder *configuration* lives only in Controller settings.
