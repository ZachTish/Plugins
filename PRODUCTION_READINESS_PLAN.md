# TPS Plugin Suite — Production Readiness Plan

## Executive Summary

After auditing all 7 TPS plugins, I found **systemic architectural issues** shared across the suite, plus plugin-specific bugs. The most critical problems fall into 5 categories:

1. **Cross-plugin compile-time imports** — Every plugin imports source directly from sibling `(Dev)` folders. This makes the suite un-distributable.
2. **Global prototype pollution** — Calendar, GCM, and Auto-Base-Embed all monkey-patch global prototypes (`Element`, `WorkspaceLeaf`, `Date`), affecting all other plugins.
3. **Full-vault scans on hot paths** — Multiple plugins iterate every file in the vault on debounced events, creating O(n²) behavior in large vaults.
4. **Leaked timers and observers** — Untracked `setTimeout`/`setInterval` calls that survive plugin unload, causing memory leaks and stale callbacks.
5. **God objects** — CalendarView (7200 lines), KanbanView (4100 lines), Auto-Base-Embed main (3689 lines) are unmaintainable monoliths.

---

## Phase 0: Critical Security Fix (Do First)

| Plugin | Issue | Fix |
|--------|-------|-----|
| **Auto-Base-Embed** | XSS via `innerHTML` with unsanitized `displayLabel` from filenames | Use `textContent` or `createEl` instead of string interpolation into `innerHTML` |

---

## Phase 1: Architectural Foundation (Unblocks Everything Else)

### 1.1 Eliminate Cross-Plugin Source Imports

**Affects:** ALL plugins

**Problem:** Every TPS plugin does `import { X } from '../../../TPS-Controller (Dev)/src/...'`. This:
- Hardcodes a dev-only folder layout
- Creates undeclared version coupling
- Makes individual plugin distribution impossible

**Solution:** Create a shared package (`tps-shared` or `@tps/core`) containing:
- `daily-note-resolver.ts`
- `daily-note-create.ts`  
- `daily-file-date.ts`
- Shared types (`RuleEvaluationContext`, etc.)
- Logger utility

For runtime plugin communication (getting another plugin's API), create a typed accessor:
```typescript
// tps-shared/plugin-bridge.ts
export function getControllerAPI(app: App): ControllerAPI | null {
  const plugin = (app as any).plugins?.plugins?.['tps-controller'];
  return plugin?.api ?? null;
}
```

**Effort:** Medium — mostly moving files and updating imports  
**Risk:** Low — no logic changes

### 1.2 Remove Global Prototype Pollution

**Affects:** Calendar-Base, Global-Context-Menu, Auto-Base-Embed

| Plugin | Polluted Global | Alternative |
|--------|----------------|-------------|
| Calendar-Base | `Element.prototype.getBoundingClientRect` | Scope the fix to only calendar container elements using a targeted `ResizeObserver` or element-specific wrapper |
| GCM | `WorkspaceLeaf.prototype.openFile/open/setViewState` | Use `workspace.on('file-open')` with `evt.preventDefault()` pattern, or a single `around()` patch with proper `this.register()` cleanup |
| GCM | `Date.prototype.contains` | Remove entirely — find the one call site and use a normal utility function |

**Effort:** Medium-High (Calendar BCR patch is deeply integrated)  
**Risk:** Medium — must regression-test drag-and-drop on canvas

---

## Phase 2: Performance & Stability

### 2.1 Eliminate Unbounded Vault Scans

| Plugin | Hot Path | Current Cost | Fix |
|--------|----------|-------------|-----|
| Calendar-Base | `collectSuppressedExternalEventState` | O(all files) per render | Maintain an incremental index; update only on file-change events for affected files |
| Calendar-Base | `parseAllTaskItems` / `parseAllSessionHeadings` | O(all files) on load | Cache results; invalidate per-file on `metadataCache.changed` |
| Controller | `evaluateReminders` (every 30s) | O(all files × rules) | Cache last-evaluated state; only re-evaluate files whose metadata changed since last tick |
| Controller | `getOverdueItems` (every 15s) | O(all files) | Share scan results with reminder engine; don't duplicate the work |
| GCM | `SubitemReferenceIndexService.getReferencesForChild` | O(all files) per call, no cache | Build and maintain an inverted index on `metadataCache.resolved`; update incrementally |
| Kanban | `buildScheduledTaskFallbackGroups` | O(all files) inside `renderAsync` | Pre-build an index of scheduled tasks; update on file-change events |
| NN-Companion | Backlink scan in `buildRuleContext` | O(all resolvedLinks) per file = O(n²) total | Use `metadataCache.getBacklinksForFile()` (Obsidian API) instead of manual iteration |

**Effort:** High  
**Risk:** Medium — requires careful cache invalidation

### 2.2 Fix Race Conditions

| Plugin | Race | Fix |
|--------|------|-----|
| Calendar-Base | Concurrent `updateCalendar()` calls overwriting each other | Add a generation counter; discard results if generation has advanced |
| Controller | `SyncConflictWatcher` reads metadata cache before it's populated | Add `await metadataCache.resolvedPromise` or delay processing by 1 tick |
| Controller | `runReminderCheck` — one failed notification kills the batch | Wrap each `sendNotification` in individual try/catch |
| Kanban | TOCTOU on file line edits (read → modify → write) | Use `vault.process()` (atomic read-modify-write) or `app.fileManager.processFrontMatter()` |
| GCM | `FrontmatterMutationService.runSerialized` chain map leak | Simplify: use a per-file `Mutex` class with proper cleanup |

**Effort:** Medium  
**Risk:** Low-Medium

### 2.3 Track and Clear All Timers

**Affects:** ALL plugins

**Pattern to adopt:**
```typescript
// In plugin class:
private timers: Set<number> = new Set();

safeTimeout(fn: () => void, ms: number): number {
  const id = window.setTimeout(() => { this.timers.delete(id); fn(); }, ms);
  this.timers.add(id);
  return id;
}

onunload() {
  this.timers.forEach(id => window.clearTimeout(id));
}
```

**Specific leaks to fix:**

| Plugin | Leaked Timer |
|--------|-------------|
| Calendar-Base | `pollInterval` in constructor, `fastRefreshLogTimer`, `highlightEventEmbed` interval |
| Calendar-Base | Global `window.addEventListener` for pointer events (never removed on unload) |
| Auto-Base-Embed | Stabilization timeouts (3 per leaf), `focusout` 120ms timer, `queuedRefreshAllTimer` |
| NN-Companion | `queueTagPageMenuAugment` triple setTimeout, `appliedRuleSummaryTimer` |
| GCM | `pendingSubitemTimers`, `pendingRecurrenceAdvanceTimers`, `pendingRefreshTimers` in function-scoped Maps |
| Controller | `timeoutPromise` in external-calendar-service (minor) |

**Effort:** Low-Medium  
**Risk:** Low

### 2.4 Replace Aggressive MutationObservers

| Plugin | Observer Scope | Fix |
|--------|---------------|-----|
| Auto-Base-Embed | `document.body` with `subtree: true` (modal detection) | Observe only the modal container element, or use `workspace.on('layout-change')` |
| NN-Companion | `document.body` with `subtree: true` (tag affordances) | Observe only `.notebook-navigator` containers, not the entire DOM |
| Auto-Base-Embed | `querySelectorAll("*")` in `updateBottomObstructionOffset` | Use `position: fixed` selector or maintain a registry of known obstruction elements |

**Effort:** Medium  
**Risk:** Low

---

## Phase 3: Code Quality & Maintainability

### 3.1 Break Up God Objects

| Plugin | File | Lines | Suggested Decomposition |
|--------|------|-------|------------------------|
| Calendar-Base | `calendar-view.tsx` | 7200+ | → `CalendarDataService` (fetching, caching, dedup), `CalendarEventMapper` (entry → FC event), `CalendarFilterEngine` (inline expressions), `CalendarDragHandler` (DnD logic), `TaskItemService` (parse/CRUD), `SessionHeadingService`, `ExternalEventSuppressor` |
| Kanban | `KanbanView.ts` | 4100+ | → `KanbanDataService` (file reading, task expansion), `KanbanRenderer` (DOM building), `KanbanDragDrop` (lane/card drops), `KanbanFileOps` (create/rename/move), `VisualStyleResolver` |
| Auto-Base-Embed | `main.ts` | 3689 | → `EmbedRenderer` (panel building), `LeafStateManager` (the 20+ WeakMaps → single Map<Leaf, State>), `CanvasEmbedService`, `BottomBarService`, `GestureHandler` |
| GCM | `main.ts` + `register-events.ts` | ~3000 combined | → Already partially decomposed into services; finish by extracting `CanvasOpenGuard`, `InlineFieldClickHandler`, `ViewModeManager` |

**Effort:** High  
**Risk:** Medium — requires comprehensive testing

### 3.2 Delete Dead Code

| Plugin | Dead Files/Code |
|--------|----------------|
| Auto-Base-Embed | `source-end-embed-widget.ts`, `debounce.ts`, `settings-modals.ts`, `headerSyncTimers` field, `lastEditorFocused` field, `syncBaseHeader()`, `attachHeaderObserver()`, `getBaseHeaderTitle()` |
| Notifier | `send-notification-modal.ts`, `transport-utils.ts`, `utils/list-renderer.ts`, `utils/section-helpers.ts`, `utils/settings-layout.ts` |
| Kanban | `EditCardModal.ts`, exported `sanitizeKanbanSettings` (only in unused tests) |
| NN-Companion | `title-sync-service.ts.backup`, `title-sync-service.ts.bak` |
| Controller | `CompanionAutomationService.runScan()` (always no-ops) |

**Effort:** Low  
**Risk:** Low

### 3.3 Centralize Common Patterns

Replace per-plugin implementations with shared utilities:

| Pattern | Current State | Target |
|---------|--------------|--------|
| Logger with dedup | Copy-pasted in 5+ plugins, each with 300-entry map that leaks | Single shared logger with bounded LRU, proper cleanup |
| `(this.app as any).plugins.plugins[id]` | Scattered across 30+ files | Single typed `getPlugin<T>(app, id)` utility |
| `formatDateTimeForFrontmatter` | Duplicated 3x in Calendar-Base alone | Single canonical utility in shared package |
| Settings sanitization | Each plugin has `sanitize*Settings` with duplicate boilerplate | Shared `sanitizeSettings(raw, defaults, migrations)` utility |
| Scale normalization | 4 copies in Kanban | Single `clamp(value, min, max)` utility |

**Effort:** Medium  
**Risk:** Low

### 3.4 Extract Magic Numbers to Named Constants

Every plugin has dozens of unnamed numeric literals (timeouts, thresholds, ranges). Create a `constants.ts` per plugin:

```typescript
// Example: calendar-base/src/constants.ts
export const PENDING_UPDATE_EXPIRY_MS = 5000;
export const TYPING_QUIET_WINDOW_MS = 4000;
export const RRULE_EXPANSION_PAST_DAYS = 30;
export const RRULE_EXPANSION_FUTURE_DAYS = 60;
export const MAX_INIT_RETRIES = 40;
```

**Effort:** Low  
**Risk:** None

---

## Phase 4: Error Handling & Resilience

### 4.1 Add Error Boundaries

| Plugin | Gap | Fix |
|--------|-----|-----|
| Calendar-Base | `loadConfig()` has no try/catch; throws crash the view | Wrap in try/catch, show user-facing Notice |
| Calendar-Base | External calendar fetch — no retry | Add exponential backoff (1s, 4s, 16s) with max 3 retries |
| Controller | Migration runs before source plugins loaded | Defer migration to `workspace.onLayoutReady` callback |
| Controller | One failed `sendNotification` kills batch | Per-item try/catch in the notification loop |
| Kanban | `vault.create` failure in `createNoteCardAtDestination` | Try/catch with `new Notice("Failed to create note: ...")` |
| Notifier | No user-facing error on send failure | Show `new Notice("Notification failed: " + reason)` |
| Notifier | `ntfyTopic` not URL-encoded | `encodeURIComponent(topic)` in URL construction |
| NN-Companion | `file.parent.path` without null check | Add `file.parent?.path ?? ""` guard |

**Effort:** Low-Medium  
**Risk:** Low

### 4.2 Add Graceful Degradation

- Calendar-Base: If Controller plugin is not installed, show a clear message instead of crashing on null controller
- All plugins: If a cross-plugin API call fails, degrade gracefully (disable the feature) rather than throwing

---

## Phase 5: Polish & Distribution Prep

### 5.1 Fix Naming & Metadata

| Plugin | Issue |
|--------|-------|
| Notifier | package.json says "Telegram notifications" — should say "ntfy notifications" |
| Notifier | Class is `TPSMessager` (typo) — should be `TPSMessenger` or `TPSNotifier` |
| Notifier | Folder, package name, class name all differ — pick one canonical name |
| All plugins | Remove `(Dev)` suffix from folder names for production builds |

### 5.2 Prune Accumulated State

| Plugin | Issue | Fix |
|--------|-------|-----|
| Auto-Base-Embed | `manualExpansionState` grows unbounded in `data.json` | Prune entries for deleted/renamed rules on save |
| Controller | `alertState: {}` always written to data.json | Remove from serialized type or don't write it |
| Controller | External calendar cache never prunes removed URLs | Clear cache entries when URL list changes in settings |
| All plugins | Deprecated settings fields never removed | After 1 major version, delete deprecated fields and bump settings version |

### 5.3 Add Unload Verification

For each plugin, audit `onunload()` to ensure it:
- Clears all registered intervals/timeouts
- Disconnects all MutationObservers
- Removes all global event listeners
- Unpatches any monkey-patched prototypes
- Clears any caches/state to allow GC

---

## Priority Execution Order

```
Phase 0 (Security)     → Immediate (1 hour)
Phase 1.1 (Shared pkg) → Week 1-2 (foundation for everything)
Phase 2.3 (Timer leaks)→ Week 1 (low effort, high impact)
Phase 2.1 (Vault scans)→ Week 2-3 (biggest perf win)
Phase 2.2 (Races)      → Week 2-3
Phase 1.2 (Prototypes) → Week 3-4 (complex, needs testing)
Phase 2.4 (Observers)  → Week 3
Phase 4.1 (Errors)     → Week 4
Phase 3.2 (Dead code)  → Week 4 (easy cleanup)
Phase 3.4 (Constants)  → Week 4
Phase 3.1 (God objects) → Week 5-8 (long-term refactor)
Phase 3.3 (Shared utils)→ Ongoing alongside Phase 3.1
Phase 5 (Polish)       → Before first public release
```

---

## Per-Plugin Severity Summary

| Plugin | Critical | High | Medium | Low |
|--------|----------|------|--------|-----|
| Calendar-Base | 2 (imports, prototype) | 3 (vault scan, race, god class) | 3 | 4 |
| Controller | 0 | 3 (dual vault scan, migration timing, batch error) | 3 | 3 |
| Global-Context-Menu | 2 (prototype pollution ×2, imports) | 2 (subitem index, canvas guard null) | 4 | 3 |
| Kanban | 1 (imports) | 3 (TOCTOU, vault scan, god class) | 2 | 4 |
| Auto-Base-Embed | 1 (XSS) | 2 (querySelectorAll("*"), timer leaks) | 3 | 4 |
| NN-Companion | 1 (imports) | 3 (MutationObserver, O(n²) backlinks, timer leaks) | 3 | 3 |
| Notifier | 0 | 2 (silent send failure, unencoded topic) | 2 | 5 |

---

## Quick Wins (< 1 Hour Each)

1. Fix XSS in Auto-Base-Embed `buildPanel` — replace `innerHTML` with safe DOM API
2. Add `encodeURIComponent` to Notifier topic URL construction
3. Delete all dead files listed in Phase 3.2
4. Add null check for `controller` in Calendar-Base constructor (throw or return)
5. Add per-item try/catch in Controller's notification loop
6. Remove `.backup`/`.bak` files from NN-Companion source
7. Fix Notifier package.json description
8. Add `file.parent?.path` null guard in NN-Companion
