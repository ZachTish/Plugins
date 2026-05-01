# Cleanup And Logic Improvement Plan

Date: 2026-04-27
Repo: `.obsidian/plugins`
Current validation baseline: all `*(Dev)` plugin builds pass, and `TPS-Notebook-Navigator-Companion (Dev)` tests pass.

## Purpose

This plan turns the latest audit into concrete cleanup and logic-improvement objectives.

Constraints for this plan:

- Do not degrade current behavior.
- Do not consolidate plugins into one another.
- Keep plugins standalone except for already-established ownership boundaries.
- Prefer small slices with validation before and after each slice.

## Current Audit Snapshot

### What improved since the earlier audit

- `TPS-Calendar-Base (Dev)/src/calendar-view.tsx` dropped from about `6935` lines to about `6155` lines.
- `TPS-Global-Context-Menu (Dev)/src/menu/panel-builder.ts` dropped from about `3828` lines to about `3332` lines.
- `TPS-Auto-Base-Embed (Dev)/src/main.ts` dropped from about `3498` lines to about `3187` lines.
- `TPS-Global-Context-Menu (Dev)/src/services/linked-subitem-checkbox-service.ts` dropped from about `2232` lines to about `2028` lines.
- Source-only `as any` usage dropped from `745` to `741`.
- Source-only `setTimeout(` usage dropped from `206` to `154`.
- Source-only `setInterval(` usage dropped from `27` to `16`.
- Source-only `MutationObserver` usage dropped from `48` to `40`.
- Source-only `document.querySelector` usage dropped from `27` to `17`.

### Current highest-risk first-party files

1. `TPS-Calendar-Base (Dev)/src/calendar-view.tsx` at about `6155` lines.
2. `TPS-Kanban (Dev)/src/views/KanbanView.ts` at about `3714` lines.
3. `TPS-Global-Context-Menu (Dev)/src/menu/panel-builder.ts` at about `3332` lines.
4. `TPS-Auto-Base-Embed (Dev)/src/main.ts` at about `3187` lines.
5. `TPS-Calendar-Base (Dev)/src/CalendarReactView.tsx` at about `2699` lines.
6. `TPS-Global-Context-Menu (Dev)/src/menu/persistent-menu-manager.ts` at about `2632` lines.
7. `TPS-Global-Context-Menu (Dev)/src/services/linked-subitem-checkbox-service.ts` at about `2028` lines.
8. `TPS-Global-Context-Menu (Dev)/src/services/bulk-edit-service.ts` at about `1976` lines.
9. `TPS-Global-Context-Menu (Dev)/src/settings-tab.ts` at about `1912` lines.
10. `TPS-Calendar-Base (Dev)/src/services/new-event-service.ts` at about `1546` lines.

### Current cross-cutting risk signals

- `as any`: `741`
- `@ts-ignore`: `23`
- `setTimeout(`: `154`
- `setInterval(`: `16`
- `MutationObserver`: `40`
- `document.querySelector`: `17`

### Current test coverage reality

- Every dev plugin has a build script.
- Only `TPS-Notebook-Navigator-Companion (Dev)` has a test script.
- The suite baseline is green, but most plugins still only have build-time smoke coverage.

## Enablers Already In Place

- Anti-monolith comments now exist at the main class and hot-method boundaries across the TPS plugins.
- Auto Base Embed already has cleaner startup wiring and named handler seams.
- Calendar Base, Controller, GCM, and Companion ownership boundaries are clearer than they were at the start of the session.
- The repo-wide validator provides a stable before-and-after gate for every cleanup slice.

## Priority Order

1. Reduce the highest-risk monoliths without changing feature ownership.
2. Replace timer and DOM fallback logic where explicit lifecycle boundaries already exist.
3. Remove stale settings, dead code paths, and compatibility shims that no longer serve a live feature.
4. Add targeted smoke tests around the specific slices being refactored.
5. Clean up repo hygiene and tracked runtime/build artifacts after logic risk is lower.

## Plugin Objectives

### TPS Auto Base Embed

Primary goal: break the refresh and host-mounting pipeline into smaller responsibilities without changing embed behavior.

Objectives:

- Extract eligibility and early-return checks from `performRefreshLeaf()` into named helpers.
- Extract reuse-signature and render-cooldown logic into a dedicated refresh-state helper section.
- Extract placement-host setup from `ensureHost()` into smaller inline-vs-floating mount helpers.
- Isolate canvas watcher scheduling and scan coordination from the main plugin runtime.
- Reduce direct private-API reach-ins where a local adapter can make intent explicit.

Acceptance criteria:

- `src/main.ts` gets smaller without changing supported render modes.
- Inline, floating, and canvas-node embeds behave the same as today.
- Plugin build remains green.

### TPS Calendar Base

Primary goal: shrink `calendar-view.tsx` by separating refresh wiring, entry generation, and note-creation flows.

Objectives:

- Split `registerRefreshListeners()` into named handler methods grouped by event source.
- Extract task-item refresh and task-entry generation out of `calendar-view.tsx`.
- Extract external-event note creation and daily-note creation flows into focused services.
- Move render-input preparation for the React view into a smaller bridge/helper layer.
- Reduce `as any` hotspots in `calendar-view.tsx` and `CalendarReactView.tsx` where stable local typing can be introduced.

Acceptance criteria:

- `calendar-view.tsx` stops owning unrelated creation, refresh, and rendering concerns in one file.
- Controller-owned mappings still remain authoritative at runtime.
- Plugin build remains green.

### TPS Global Context Menu

Primary goal: split panel construction and relationship-heavy logic into smaller builders and services.

Objectives:

- Break `panel-builder.ts` into dedicated section builders for context strip, action toolbar, subitems, references, and graph content.
- Move subitem panel rendering and relationship UI behavior out of the main panel builder body.
- Continue shrinking `settings-tab.ts` by extracting section renderers where settings ownership is already stable.
- Audit `persistent-menu-manager.ts`, `bulk-edit-service.ts`, and `linked-subitem-checkbox-service.ts` for dead branches and mixed responsibilities.
- Reduce timer-based UI coordination where a more direct menu lifecycle or service callback can replace it.

Acceptance criteria:

- `panel-builder.ts` becomes an orchestration layer instead of a full UI implementation file.
- Relationship-sync behavior and Notebook Navigator ownership rules stay intact.
- Plugin build remains green.

### TPS Kanban

Primary goal: separate view startup, virtual-task behavior, and card-creation flows.

Objectives:

- Split `KanbanView.onload()` into named file/task/view event handlers.
- Extract virtual-task parsing, metadata shaping, and visual-rule evaluation into focused helpers.
- Extract note-card and task-card creation paths into separate view-local helpers or services.
- Isolate lane grouping and display-lane preparation from rendering concerns.
- Add at least a narrow test or smoke harness around settings normalization and one card-creation path.

Acceptance criteria:

- `KanbanView.ts` gets smaller and more legible without changing board behavior.
- Virtual tasks still respond correctly to metadata and file lifecycle changes.
- Plugin build remains green.

### TPS Controller

Primary goal: keep `main.ts` as orchestration only and push feature logic toward services and smaller registration helpers.

Objectives:

- Split `onload()` into service wiring, command registration, event registration, and startup automation helpers.
- Extract startup sync-settlement and guard-window behavior into a clearer controller-state helper.
- Audit reminder and calendar automation call sites for logic that still belongs in services rather than the plugin class.
- Add narrow tests around sync-request and controller-owned calendar-setting behavior.

Acceptance criteria:

- `main.ts` becomes easier to audit as a coordinator.
- Controller remains the sole authority for the already-established shared calendar ownership surface.
- Plugin build remains green.

### TPS Notebook Navigator Companion

Primary goal: continue shrinking entrypoint complexity and remove legacy fallback surfaces only when behavior safety is proven.

Objectives:

- Split `registerEvents()` into grouped DOM-event registration helpers.
- Review remaining local fallback settings for rule definitions and remove them only if GCM ownership is guaranteed in all live paths.
- Add tests around rule application triggers, settings migration, and page-creation behavior.
- Reduce remaining DOM-event branch density in `main.ts` by pushing behavior into service methods.

Acceptance criteria:

- `main.ts` keeps shrinking while GCM-owned rule definitions remain the runtime source of truth.
- Existing Companion tests stay green and new tests cover touched behavior.

### TPS Messager

Primary goal: separate transport logic from inline modal/UI logic.

Objectives:

- Move the inline manual-send modal into a dedicated modal class file.
- Extract ntfy request/header construction into a focused helper.
- Add narrow tests around URL building, title sanitization, and disabled-settings behavior.
- Keep compatibility naming unchanged while simplifying `main.ts` responsibilities.

Acceptance criteria:

- `main.ts` stops mixing plugin wiring, transport behavior, and UI implementation.
- Plugin build remains green.

## Cross-Cutting Objectives

### 1. Type-Safety Improvements

- Prioritize the top `as any` hotspots in Calendar Base, Kanban, Auto Base Embed, and GCM.
- Replace local private-API reach-ins with small adapters when direct typing is not possible.
- Avoid repo-wide type cleanup; target only the touched slice each time.

### 2. Timer And Observer Reduction

- Replace timer-based retry loops where a real lifecycle callback or explicit event is already available.
- Centralize observer setup and teardown rules per feature so cleanup is obvious.
- Treat `setTimeout`, `setInterval`, and `MutationObserver` usage as refactor triggers in the largest files.

### 3. Repo Hygiene

- Add a repo-root ignore policy that covers dependency trees, build outputs, and runtime state.
- Stop tracking runtime JSON and build outputs that are not true source-of-truth files.
- Keep sample/example config files only where a real development need exists.

### 4. Verification Expansion

- Add at least one targeted test or smoke harness to Calendar Base, Kanban, Auto Base Embed, and Controller.
- Keep Companion tests green while using them as the template for lightweight per-plugin test gates.
- Require a focused validation step immediately after each substantive refactor slice.

## Suggested Execution Sequence

### Phase 1: Safest high-return slices

1. Auto Base Embed refresh helper extraction.
2. Calendar Base refresh-listener decomposition.
3. GCM panel-builder section extraction.
4. Kanban onload listener decomposition.

### Phase 2: Logic-heavy separations

1. Calendar Base task-entry and note-creation extraction.
2. GCM subitems panel separation.
3. Kanban virtual-task pipeline extraction.
4. Controller startup wiring decomposition.

### Phase 3: Coverage and hygiene

1. Add narrow tests for touched logic in Auto Base Embed, Calendar Base, Kanban, and Controller.
2. Remove tracked runtime/build artifacts once the logic surfaces are safer to maintain.

## Non-Negotiable Guardrails

- No plugin loses standalone behavior.
- Do not move user-facing behavior across plugin ownership boundaries.
- Validate before and after every slice using the repo validator.
- If a slice changes runtime logic in a high-risk file, add or expand a narrow test before continuing.