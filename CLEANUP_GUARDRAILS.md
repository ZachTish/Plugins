# Cleanup Guardrails

This repo can be cleaned up without degrading behavior, but only if every change is constrained by the same validation loop.

## Rules For Cleanup And Logic Improvements

1. Cleanup and refactors should be done in small slices, not large repo-wide rewrites.
2. Every slice should preserve the current public behavior of the touched plugin.
3. No cleanup change should be considered safe unless validation is run before and after the change.
4. Runtime-state removal and footprint reduction should be separated from logic rewrites whenever possible.
5. Shared utility extraction should start with byte-identical helpers so behavior stays unchanged.

## Baseline Validation

Run this from `.obsidian/plugins` before and after each cleanup slice:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\validate-dev-components.ps1
```

What it currently checks:

- `npm run build` in every `*(Dev)` plugin that has a `package.json`
- `npm run test` where a test script exists

## Current Known Baseline

As of 2026-04-27, the baseline is:

- Builds pass for all current `*(Dev)` plugins.
- `TPS-Notebook-Navigator-Companion (Dev)` has pre-existing test failures.
- Those current failures are in `tests/rule-engine.test.ts` and `tests/daily-note-resolver.test.ts`.
- Cleanup work should not add new build failures, and it should not worsen the current test baseline.

That means the default non-regression rule for cleanup is:

1. All builds must remain green.
2. `TPS-Notebook-Navigator-Companion (Dev)` must not gain additional failing tests.
3. If cleanup touches logic in that plugin, the failing test baseline should be fixed first or replaced with a narrower scoped test gate for the touched code path.

## Practical Workflow

1. Run the validation script to establish a clean baseline.
2. Make one narrow cleanup or refactor.
3. Rerun the same validation script immediately.
4. If behavior-sensitive code moved, add or expand a test before continuing.
5. Only after the slice is stable should the next cleanup target be touched.

## Priority Order That Minimizes Regression Risk

1. Remove tracked dependency trees and generated artifacts.
2. Stop tracking runtime JSON state.
3. Extract exact-duplicate helpers.
4. Refactor large source files only after the above steps reduce noise.

## Current Limitation

Only `TPS-Notebook-Navigator-Companion (Dev)` currently has first-party tests. For the other dev plugins, `npm run build` is a smoke gate, not full behavioral proof. If we begin logic improvements in Calendar Base, Auto Base Embed, or Global Context Menu, the next safety step should be to add targeted tests around the exact code paths being changed.