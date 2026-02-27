# TPS Global Context Menu

A richly featured context menu and note management system that attaches to every note link in the vault. Think of it as the primary interaction layer for creating, scheduling, tagging, and managing notes without ever leaving the current view.

---

## What It Does

### Context Menu
- Intercepts Obsidian's native file/link menus (`file-menu`, `url-menu`, editor context).
- `MenuController` builds the menu dynamically based on the target note's frontmatter.
- `MenuBuilder` and `PanelBuilder` assemble menu sections: actions, scheduling, tags, recurrence.
- `PersistentMenuManager` allows the menu to be pinned as a sidebar panel.

### Note Operations (`NoteOperationService`)
- Create child notes (with configurable templates and parent-link injection).
- Rename files using structured naming rules via `FileNamingService`.
- Move notes to type-specific folders.
- Archive or delete notes with confirmation.

### Scheduling & Recurrence
- `ScheduledModal` — sets a `scheduled` date frontmatter property.
- `RecurrenceService` + `RecurrenceModal` — defines repeating tasks (daily, weekly, monthly, custom).
- On task completion, auto-advances the scheduled date to the next recurrence and optionally clones the note.

### Checklist Management (`ChecklistHandler`)
- Reorders checklist items on drag or button press.
- Prompt to carry over incomplete checklist items to the next recurrence.
- `ChecklistPromptModal` handles the interactive selection.

### Bulk Edit (`BulkEditService`)
- Apply a frontmatter property change to many notes at once.
- Detect notes with missing or broken recurrence links and repair them.

### Tag Management
- `AddTagModal` — inline tag picker for adding/removing tags.
- `TagUtils` — reads and writes both frontmatter and inline tags cleanly.

### View Mode Manager
- Switches notes between Reading and Editing mode based on their status.
- Suppresses auto-switch for specific paths (e.g., daily notes).

### Mobile & Gesture Support
- `GestureHandler` — long-press on mobile triggers the context menu.
- Keyboard visibility detection suppresses menu pop-ups when the soft keyboard is open.

---

## Source Layout

```
src/
  main.ts              — Plugin entry, wires all services
  types.ts             — All TypeScript types
  constants.ts         — Plugin-wide constants & injected CSS
  resolve-profiles.ts  — Maps note types to configuration profiles
  settings-tab.ts      — Settings UI
  compat.ts            — Polyfills and console error filtering
  logger.ts            — Debug logging wrapper
  menu/
    menu-controller.ts        — Dispatches context menus and inline panels
    menu-builder.ts           — Constructs menu action sections/items
    panel-builder.ts          — Builds the persistent sidebar panel UI
    persistent-menu-manager.ts — Manages pinned panel lifecycle
    badge-renderer.ts         — Status badge overlays on file list items
  services/
    bulk-edit-service.ts            — Multi-note frontmatter batch editing
    recurrence-service.ts           — Recurrence logic and auto-scheduling
    file-naming-service.ts          — Template-based file rename rules
    note-operation-service.ts       — Create, move, archive, delete notes
    field-initialization-service.ts — Default frontmatter on new notes
    context-target-service.ts       — Resolves the target note for menu actions
    view-mode-service.ts            — Reading/editing mode evaluation
    property-row-service.ts         — Renders individual property rows in panel
  handlers/
    checklist-handler.ts       — Checklist reorder & carry-over logic
    parent-link-handler.ts     — Reads/writes parent note links
    parent-link-format.ts      — Formatting rules for parent link values
    view-mode-manager.ts       — Registers view mode automation
    daily-note-nav-manager.ts  — Prev/Next navigation for daily notes
    gesture-handler.ts         — Long-press gesture for mobile context menu
  modals/
    recurrence-modal.ts          — Define repeating task rules
    scheduled-modal.ts           — Date picker for scheduling
    snooze-modal.ts              — Snooze duration picker
    add-tag-modal.ts             — Tag picker
    checklist-prompt-modal.ts    — Carry-over checklist item selection
    parent-link-prompt-modal.ts  — Parent note selector
    property-profile-modal.ts    — Property profile editor
    FileSuggestModal.ts          — File picker with autocomplete
    MultiFileSelectModal.ts      — Multi-file selection
    folder-selection-modal.ts    — Folder picker
    text-input-modal.ts          — Reusable single text input modal
  utils/
    tag-utils.ts           — Frontmatter & inline tag read/write helpers
    date-suffix-utils.ts   — Date-based filename suffix parsing
  core/
    command-queue-service.ts   — Serializes async UI operations
    async-utils.ts
    error-utils.ts
    frontmatter-tag-mutator.ts
    inline-tag-utils.ts
    notice-utils.ts
    operation-batch-utils.ts
    record-utils.ts
    type-guards.ts
  ui/
    section-helpers.ts   — Collapsible settings section builders
    list-renderer.ts     — Generic settings list row renderer
```
