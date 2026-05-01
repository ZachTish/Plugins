# Plugins Repo Audit Findings

Date: 2026-04-27
Repo: `.obsidian/plugins`
Commit audited: `94de9b5`

## Scope

- Full repository scan of `.obsidian/plugins`.
- Deeper review of all seven `*(Dev)` plugin folders.
- Focus area for this session: reduce repository footprint and improve feature reliability.

## Executive Summary

The current repo is carrying much more dependency and generated-output weight than authored source. Reliability risk is concentrated in a small number of very large source files, frequent `as any` / private-API reach-ins, and timer/DOM coordination patterns that are hard to reason about and hard to test. Runtime state is also mixed into plugin source folders, which blurs the line between code and live vault state. Shared helper logic is duplicated across plugins, which increases both maintenance cost and bug drift.

If the goal is to shrink footprint and improve reliability in the same session stream, the highest-return order is:

1. Stop tracking dependency trees and generated artifacts.
2. Remove tracked runtime state from source control.
3. Consolidate duplicated utilities.
4. Break up the largest monolith files.
5. Add a minimum test harness outside the companion plugin.

## Key Metrics

All counts below are from the current working tree at commit `94de9b5`.

- Tracked `node_modules` files across the repo: `16883`
- Source-only `as any` occurrences, excluding `node_modules` and `dist`: `745`
- Source-only `@ts-ignore` occurrences, excluding `node_modules` and `dist`: `23`
- Source-only `setTimeout(` occurrences: `206`
- Source-only `setInterval(` occurrences: `27`
- Source-only `document.querySelector` occurrences: `27`
- Source-only `MutationObserver` occurrences: `48`
- First-party test files in the repo: `3`
- `.gitignore` files present in the entire repo: `2`
- Repo-level `package-lock.json` packages object: empty

## Finding 1: The Repository Footprint Is Dominated By Tracked Dependencies

The current git footprint is mostly vendored dependency trees and generated outputs, not authored plugin source.

### Dev plugin tracked-file breakdown

| Dev plugin | Tracked files | Tracked `node_modules` files | Tracked build-like files |
| --- | ---: | ---: | ---: |
| `TPS-Auto-Base-Embed (Dev)` | 948 | 937 | 153 |
| `TPS-Calendar-Base (Dev)` | 74 | 0 | 2 |
| `TPS-Controller (Dev)` | 4177 | 4127 | 1548 |
| `TPS-Global-Context-Menu (Dev)` | 116 | 0 | 1 |
| `TPS-Kanban (Dev)` | 826 | 805 | 159 |
| `TPS-Notebook-Navigator-Companion (Dev)` | 7000 | 6956 | 657 |
| `TPS-Notifier (Dev)` | 4079 | 4058 | 1502 |

### Evidence

- The largest tracked files in the repo are vendored TypeScript server files and esbuild binaries under `node_modules`, not plugin code.
- Example heavy trees:
  - `TPS-Notebook-Navigator-Companion (Dev)/node_modules`
  - `TPS-Controller (Dev)/node_modules`
  - `TPS-Notifier (Dev)/node_modules`
  - `TPS-Auto-Base-Embed (Dev)/node_modules`
- There is no repo-root `.gitignore`. The only ignore files found were:
  - `TPS-Calendar-Base (Dev)/.gitignore`
  - `TPS-Global-Context-Menu (Dev)/.gitignore`

### Impact

- Clone/fetch cost is much larger than it needs to be.
- Review noise is high because dependency churn and generated artifacts sit beside source.
- Per-plugin cleanup policies are inconsistent, so bloat prevention is not enforced repo-wide.

## Finding 2: Generated Build Artifacts Are Tracked Beside Source

Several dev plugins track compiled output and build products directly in git.

### Evidence

- Tracked outputs include:
  - `TPS-Auto-Base-Embed (Dev)/main.js`
  - `TPS-Controller (Dev)/main.js`
  - `TPS-Calendar-Base (Dev)/styles.css`
  - `TPS-Auto-Base-Embed (Dev)/dist/tsconfig.tsbuildinfo`
  - `TPS-Kanban (Dev)/dist/main.js`
  - `TPS-Kanban (Dev)/dist/views/KanbanView.js`
  - `TPS-Notebook-Navigator-Companion (Dev)/dist/tsconfig.tsbuildinfo`
- `TPS-Calendar-Base (Dev)/.gitignore` excludes `node_modules`, `main.js`, and `data.json`, but the repo still tracks generated outputs such as `styles.css` and `tsconfig.tsbuildinfo`.
- `TPS-Global-Context-Menu (Dev)/.gitignore` excludes `node_modules/`, `dist/`, `main.js`, and logs, but that policy is local to one plugin and does not protect the repo as a whole.

### Impact

- Generated files obscure real changes during review.
- Rebuilds can dirty the repo for reasons unrelated to source changes.
- The repo currently mixes source-of-truth files with derived artifacts.

## Finding 3: Runtime State Is Committed Or Co-Located With Source

Several dev plugins keep live runtime state in the same folders as source, and some of that state is tracked in git.

### Tracked runtime-state files

- `TPS-Auto-Base-Embed (Dev)/data.json`
- `TPS-Controller (Dev)/.sync-request.json`
- `TPS-Controller (Dev)/data.json`
- `TPS-Global-Context-Menu (Dev)/data.json`
- `TPS-Global-Context-Menu (Dev)/recurrence-create-state.json`
- `TPS-Global-Context-Menu (Dev)/recurrence-session.json`
- `TPS-Kanban (Dev)/data.json`
- `TPS-Notebook-Navigator-Companion (Dev)/data.json`
- `TPS-Notifier (Dev)/data.json`

### Evidence

- `TPS-Global-Context-Menu (Dev)/recurrence-create-state.json` contains concrete operation keys, target note paths, and timestamps such as `Markdown/Action Items/...` and `updatedAt` values.
- `TPS-Controller (Dev)/.sync-request.json` contains environment-specific request metadata, including `requestedBy: "TishOS Testing Vault"`.
- `TPS-Calendar-Base (Dev)/data.json` is not currently tracked, but it exists locally and contains live external calendar endpoints. That is a good example of the right direction for git hygiene, but it also shows the need for explicit sanitized example configs.

### Impact

- Source control history risks filling with vault-specific state.
- Debugging and reproduction become harder because code and live runtime state are tangled together.
- Contributors can accidentally couple plugin behavior to one vault's local history or settings.

## Finding 4: Monolithic Source Files Are Concentrating Complexity

A small set of files carry a disproportionate amount of behavior and branching.

### Largest high-risk files

- `TPS-Calendar-Base (Dev)/src/calendar-view.tsx`: `6935` lines
- `TPS-Global-Context-Menu (Dev)/src/menu/panel-builder.ts`: `3828` lines
- `TPS-Auto-Base-Embed (Dev)/src/main.ts`: `3498` lines
- `TPS-Global-Context-Menu (Dev)/src/services/linked-subitem-checkbox-service.ts`: `2232` lines

### Why this matters

- These files are too large to reason about safely in a single review pass.
- Feature changes in them are more likely to create regressions in unrelated behavior.
- Testing them in isolation is harder because responsibilities are mixed together.

### Likely first refactor targets

- `TPS-Calendar-Base (Dev)/src/calendar-view.tsx`
- `TPS-Global-Context-Menu (Dev)/src/menu/panel-builder.ts`
- `TPS-Auto-Base-Embed (Dev)/src/main.ts`

## Finding 5: Type-Safety Bypasses And Private-API Reach-Ins Are Common

The repo is relying heavily on type escapes and private/internal API access instead of explicit interfaces.

### Source-only counts

- `as any`: `745`
- `@ts-ignore`: `23`

### Top `as any` hotspots

- `TPS-Calendar-Base (Dev)/src/calendar-view.tsx`: `179`
- `TPS-Kanban (Dev)/src/views/KanbanView.ts`: `39`
- `TPS-Auto-Base-Embed (Dev)/src/main.ts`: `35`
- `TPS-Calendar-Base (Dev)/src/CalendarReactView.tsx`: `31`
- `TPS-Global-Context-Menu (Dev)/src/handlers/daily-note-nav-manager.ts`: `24`
- `TPS-Global-Context-Menu (Dev)/src/main.ts`: `23`

### Concrete examples

- `TPS-Auto-Base-Embed (Dev)/src/main.ts:163` uses `const view = leaf.view as any;`
- `TPS-Auto-Base-Embed (Dev)/src/main.ts:279` uses `(this.app.workspace as any).on("view-registered", ...)`
- `TPS-Auto-Base-Embed (Dev)/src/main.ts:2328` reaches into `(this.app as any).embedRegistry`
- `TPS-Auto-Base-Embed (Dev)/src/main.ts:3245` uses `(leaf.view as any)?.canvas as any`
- `TPS-Auto-Base-Embed (Dev)/src/main.ts:3484` passes `null as any` into `MarkdownRenderer.render(...)`

### Impact

- Plugin behavior depends on undocumented or weakly typed surfaces.
- Reliability improvements are blocked because compile-time checks are being bypassed.
- Refactors have a higher chance of failing at runtime instead of at build time.

## Finding 6: Timer-Heavy And DOM-Heavy Coordination Is A Reliability Risk

The current source leans heavily on timers, direct DOM access, and mutation observation, which usually means lifecycle races, stale references, and cleanup bugs become common.

### Source-only counts

- `setTimeout(`: `206`
- `setInterval(`: `27`
- `document.querySelector`: `27`
- `MutationObserver`: `48`

### Top timer-heavy source files

- `TPS-Global-Context-Menu (Dev)/src/menu/panel-builder.ts`: `18`
- `TPS-Calendar-Base (Dev)/src/CalendarReactView.tsx`: `14`
- `TPS-Notebook-Navigator-Companion (Dev)/src/main.ts`: `13`
- `TPS-Auto-Base-Embed (Dev)/src/main.ts`: `13`
- `TPS-Calendar-Base (Dev)/src/calendar-view.tsx`: `12`
- `TPS-Global-Context-Menu (Dev)/src/services/bulk-edit-service.ts`: `11`

### Impact

- Timing-based coordination tends to fail under slow startup, layout changes, or race conditions.
- DOM-query-driven behavior is harder to stabilize than view-model or event-driven behavior.
- Mutation observers usually indicate the plugin is reacting after the fact to UI changes rather than owning the state transition directly.

## Finding 7: Shared Utilities Are Duplicated Across Plugins

There are exact duplicate helper files and likely near-duplicate support modules across multiple dev plugins.

### Exact duplicates verified by SHA-256

- `src/utils/list-renderer.ts` is byte-for-byte identical across:
  - `TPS-Calendar-Base (Dev)`
  - `TPS-Controller (Dev)`
  - `TPS-Global-Context-Menu (Dev)`
- `src/utils/section-helpers.ts` is byte-for-byte identical across:
  - `TPS-Calendar-Base (Dev)`
  - `TPS-Controller (Dev)`
  - `TPS-Global-Context-Menu (Dev)`

### Additional duplicated utility surfaces

- `src/utils/tag-utils.ts`
- `src/utils/template-resolution-service.ts`
- `src/utils/template-variable-service.ts`
- `src/utils/settings-layout.ts`
- `src/logger.ts`

### Impact

- Bugs fixed in one plugin will remain in the others until manually copied.
- Behavioral drift is likely because copied utilities evolve independently.
- Footprint grows with each additional copy of shared code.

## Finding 8: Verification Is Too Thin For The Current Complexity Level

The repo complexity is much higher than its current automated test coverage.

### First-party tests found

- `TPS-Notebook-Navigator-Companion (Dev)/tests/daily-note-resolver.test.ts`
- `TPS-Notebook-Navigator-Companion (Dev)/tests/rule-engine.test.ts`
- `TPS-Notebook-Navigator-Companion (Dev)/tests/vault-walker.test.ts`

### Observations

- First-party test count is `3`.
- All first-party tests live in a single plugin: `TPS-Notebook-Navigator-Companion (Dev)`.
- The other dev plugins currently depend much more on manual validation than on repeatable verification.

### Impact

- Reliability work will be slow unless at least smoke coverage is added to the highest-risk plugins.
- Large refactors in Calendar Base, Auto Base Embed, and Global Context Menu will otherwise stay high-risk.

## Additional Structural Notes

- The repo-level `package-lock.json` is effectively empty:
  - `name: "plugins"`
  - `packages: {}`
- That lockfile is not anchoring a meaningful workspace package and currently adds noise without value.

## Recommended Remediation Order

### Phase 1: Immediate footprint reduction

1. Add a repo-root `.gitignore` covering `node_modules/`, `dist/`, `build/`, `*.tsbuildinfo`, `.DS_Store`, runtime JSON state, and local data files.
2. Stop tracking dependency trees in `TPS-Auto-Base-Embed (Dev)`, `TPS-Controller (Dev)`, `TPS-Kanban (Dev)`, `TPS-Notebook-Navigator-Companion (Dev)`, and `TPS-Notifier (Dev)`.
3. Stop tracking generated outputs unless there is a hard release requirement for them.
4. Remove the orphan root `package-lock.json` unless a real repo-level workspace is introduced.

### Phase 2: State/config hygiene

1. Move live plugin state out of git-tracked files.
2. Replace tracked runtime JSON with `.example` or fixture files only where needed.
3. Standardize which files are source, which are sample config, and which are strictly local runtime state.

### Phase 3: Reliability-first refactoring

1. Split `TPS-Calendar-Base (Dev)/src/calendar-view.tsx` into smaller modules around rendering, event loading, scheduling, and settings.
2. Split `TPS-Global-Context-Menu (Dev)/src/menu/panel-builder.ts` into a view layer plus focused services.
3. Reduce `as any` usage first in `TPS-Auto-Base-Embed (Dev)/src/main.ts` and `TPS-Calendar-Base (Dev)`.
4. Replace timer-based coordination with explicit lifecycle hooks or event-driven flows where possible.

### Phase 4: Shared core extraction

1. Consolidate exact duplicates first: `list-renderer.ts` and `section-helpers.ts`.
2. Move shared tag/template/settings/logger utilities into one internal shared module.
3. Keep plugin-specific adapters thin and typed.

### Phase 5: Verification baseline

1. Add smoke tests to `TPS-Calendar-Base (Dev)`.
2. Add smoke tests to `TPS-Auto-Base-Embed (Dev)`.
3. Add at least one integration-oriented test path for `TPS-Global-Context-Menu (Dev)`.
4. Make new refactors prove themselves with tests before additional feature work is layered on top.

## Practical Starting Point For This Session

If the next step is implementation rather than more auditing, the highest-leverage starting sequence is:

1. Put a repo-root ignore policy in place.
2. Untrack dependency trees and runtime JSON state.
3. Extract the exact-duplicate helpers into one shared location.
4. Begin splitting `TPS-Calendar-Base (Dev)/src/calendar-view.tsx` or `TPS-Auto-Base-Embed (Dev)/src/main.ts`, depending on which feature set you want to stabilize first.