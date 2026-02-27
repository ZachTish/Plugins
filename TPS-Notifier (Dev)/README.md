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
