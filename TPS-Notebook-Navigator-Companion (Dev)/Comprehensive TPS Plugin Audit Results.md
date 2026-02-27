# Comprehensive TPS Plugin Audit Results - TPS-Notebook-Navigator-Companion

Audit date: 2026-02-25  
Scope: `src/**/*.ts` plus verification (`npm run -s build`)

## Validation Summary
- `npm run -s build` passes.
- Realtime processing scope has been narrowed to active + directly linked files.
- Type-safety debt is moderate/low compared to other TPS plugins: `10` explicit `any` usages.

## Implemented Optimizations (Completed)

### 1) Realtime metadata scope restriction (performance + race reduction)
- Metadata-change and GCM bulk-edit handlers now process only:
  - active file
  - directly linked files (forward/backward resolved links)
- Evidence:
  - `src/main.ts:168`
  - `src/main.ts:225`
  - `src/main.ts:757`

### 2) Title/filename sync now consistently respects ignore rules
- Rename-triggered filename/title sync and metadata-triggered title sync now early-return when exclusion rules match.
- Evidence:
  - `src/main.ts:193`
  - `src/main.ts:1060`
  - `src/main.ts:1081`

### 3) Conditional context evaluation for rule engine
- Body content and backlink computation now run only when enabled rules actually use those sources.
- Eliminates unnecessary full-body reads and reverse-link scans for common rule sets.
- Evidence:
  - `src/main.ts:431`
  - `src/main.ts:652`
  - `src/main.ts:683`
  - `src/main.ts:690`

### 4) Removed unconditional runtime `console.log` in backlink evaluation path
- Removed hot-path debug logging in rule-engine backlink source resolution.
- Evidence:
  - `src/services/rule-engine.ts` (no active `console.log` in backlink branch)

## Remaining Findings (Ordered by Severity)

### 1) High - Raw regex exclusion mode remains vulnerable to pathological patterns (accepted risk for now)
- Evidence:
  - `src/main.ts:843`
  - `src/main.ts:849`
- Risk:
  - User-provided catastrophic regex can stall evaluation in large vaults.
- Best fix:
  - Keep `re:` support, but enforce max pattern length and reject known unsafe structures.

### 2) Medium - Mutation queue is unbounded under sustained event bursts
- Evidence:
  - `src/services/metadata-manager.ts:42`
  - `src/services/metadata-manager.ts:84`
- Risk:
  - Queue growth increases memory and latency under heavy churn.
- Best fix:
  - Add coalescing by path/reason and a bounded queue cap.

### 3) Medium - Self-write and parse-failure maps are only cleaned on access/dispose
- Evidence:
  - `src/services/metadata-manager.ts:43`
  - `src/services/metadata-manager.ts:44`
  - `src/services/metadata-manager.ts:99`
  - `src/services/metadata-manager.ts:263`
- Risk:
  - Stale keys can accumulate in long sessions with many touched files.
- Best fix:
  - Add periodic sweep or map-size bounds.

### 4) Medium - Regex compilation occurs per file check
- Evidence:
  - `src/main.ts:849`
  - `src/main.ts:891`
- Risk:
  - Repeated `RegExp` construction costs in high-frequency change paths.
- Best fix:
  - Precompile/ cache parsed exclusion patterns when settings change.

## Confirmed Behavior Decisions Applied
1. Process only active file + linked items for realtime updates.
2. Auto title sync remains enabled, but must respect ignore/template exclusions.
3. Simplicity and correctness prioritized over heavy optimization complexity.
4. Tests are not a required gate for this phase.
5. Raw regex support remains enabled (per explicit preference).

## Next Recommended Fix Sequence
1. Add bounded + coalesced queue handling in `MetadataManager`.
2. Introduce cached compiled exclusion patterns for `frontmatterWriteExclusions`.
3. Add safe-regex guardrails while retaining `re:` support.
4. Continue reducing `any` at API boundaries.
