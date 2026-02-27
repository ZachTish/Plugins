# Comprehensive TPS Plugin Audit Results - TPS-Global-Context-Menu

Audit date: 2026-02-25  
Scope: `src/**/*.ts` plus build verification (`npm run -s build`)

## Validation Summary
- `npm run -s build` passes.
- Prior build/runtime API drift has been fixed (missing service wiring and missing plugin API methods).
- Type-safety debt remains high: `338` explicit `any` usages (`: any` / `as any`).

## Implemented Optimizations (Completed)

### 1) Build/API contract restoration (critical)
- Added/initialized missing `fieldInitializationService`.
- Restored missing plugin API methods used by other modules:
  - `suppressViewModeSwitchForPathUntilFocusChange(...)`
  - `shouldSkipViewModeSwitch()`
  - `shouldIgnoreAutoFrontmatterWrite(...)`
  - `matchesAutoFrontmatterExclusionPattern(...)`
- Added missing `installConsoleErrorFilter()` export.
- Evidence:
  - `src/main.ts:28`
  - `src/main.ts:55`
  - `src/main.ts:432`
  - `src/main.ts:437`
  - `src/main.ts:443`
  - `src/main.ts:454`
  - `src/compat.ts:1`

### 2) Strict mode removal alignment (per confirmed behavior)
- Runtime contextmenu interception no longer depends on strict-mode setting.
- Stale strict-mode settings UI note replaced.
- Evidence:
  - `src/main.ts:220`
  - `src/main.ts:226`
  - `src/settings-tab.ts:1095`

### 3) Recurrence modal deadlock fix
- Added idempotent settlement guard and guaranteed cancel-settle in modal `onClose()`.
- Prevents global recurrence prompt lock if modal closes via ESC/X.
- Evidence:
  - `src/recurrence-service.ts:459`
  - `src/recurrence-service.ts:541`
  - `src/recurrence-service.ts:554`

## Remaining Findings (Ordered by Severity)

### 1) High - Global `Menu.prototype` monkey patch remains
- Evidence:
  - `src/main.ts:285`
  - `src/main.ts:357`
  - `src/main.ts:362`
  - `src/main.ts:368`
- Risk:
  - Global load-order conflicts with other plugins patching the same methods.
- Best fix:
  - Move to per-menu ordering logic and remove global prototype mutation.

### 2) Medium - Global `Date.prototype` mutation remains
- Evidence:
  - `src/compat.ts:12`
  - `src/compat.ts:15`
- Risk:
  - Process-wide behavior mutation and cross-plugin compatibility risk.
- Best fix:
  - Replace with local helper function(s) and remove prototype extension.

### 3) Medium - Read-modify-write append paths remain non-serialized
- Evidence:
  - `src/note-operation-service.ts:75`
  - `src/note-operation-service.ts:77`
  - `src/note-operation-service.ts:132`
  - `src/note-operation-service.ts:134`
- Risk:
  - Concurrent edits can overwrite content when multiple operations hit same target file.
- Best fix:
  - Add file-path keyed mutation queue/mutex for append operations.

### 4) Medium - High explicit `any` usage in core paths
- Evidence:
  - `338` explicit `any` tokens across plugin source.
- Risk:
  - Reduced compile-time guarantees in mutation and UI orchestration paths.
- Best fix:
  - Start with typing plugin API boundaries and service interaction contracts.

## Confirmed Behavior Decisions Applied
1. Strict mode is obsolete and removed from active behavior.
2. Appearance sync ownership remains with controller plugin.
3. Add-to-note flow archives source notes by default.
4. Recurrence prompt is tied to typing-driven edits.

## Next Recommended Fix Sequence
1. Replace `Menu.prototype` patch with instance-scoped menu ordering.
2. Remove `Date.prototype` mutation and migrate call sites.
3. Add per-target write serialization for append workflows.
4. Reduce `any` usage at service boundaries (`main.ts`, `note-operation-service.ts`, `menu-builder.ts`).
