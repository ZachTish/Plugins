# TPS Plugin Suite — Comprehensive Analysis
> Generated: 2026-02-27 | Obsidian v1.12.4 current | Scope: All 5 TPS dev plugins

---

## Contents
1. [Executive Summary](#1-executive-summary)
2. [Critical Issues — Duplicated Code](#2-critical-issues--duplicated-code)
3. [Architecture & Pattern Issues](#3-architecture--pattern-issues)
4. [Deprecated & Outdated API Usage](#4-deprecated--outdated-api-usage)
5. [Type System Issues](#5-type-system-issues)
6. [Settings Issues](#6-settings-issues)
7. [Obsidian API Opportunities (New Features)](#7-obsidian-api-opportunities-new-features)
8. [Per-Plugin Deep Dive](#8-per-plugin-deep-dive)
9. [Cross-Plugin Integration Improvements](#9-cross-plugin-integration-improvements)
10. [New Feature Proposals](#10-new-feature-proposals)
11. [Refactoring Roadmap (Priority Order)](#11-refactoring-roadmap-priority-order)

---

## 1. Executive Summary

The TPS suite consists of **5 plugins totalling ~43,000 lines of TypeScript** across **132+ files**. The plugins are well-built and functionally sophisticated, but have accumulated substantial duplication, fragile inter-plugin communication patterns, and several deprecated API usages as Obsidian has moved from v1.4 to v1.12 during active development.

**The single biggest structural problem** is that Calendar-Base and Controller share at least **6 entire service files** that have silently diverged. Any fix to one is not applied to the other. These need to be consolidated immediately.

**The second biggest problem** is that plugin-to-plugin communication still uses raw `(this.app as any).plugins?.getPlugin?.("tps-controller")` duck-typing with no contract or version gate. The Examples/notebook-navigator folder in this vault demonstrates the correct production pattern to follow.

---

## 2. Critical Issues — Duplicated Code

### 2.1 Services Duplicated Between Calendar-Base and Controller

These files exist in **both** `TPS-Calendar-Base (Dev)/src/services/` and `TPS-Controller (Dev)/src/services/` and have **diverged**:

| File | Calendar-Base | Controller | Divergence |
|------|--------------|------------|------------|
| `external-calendar-service.ts` | 131 lines | 143 lines | +12 lines in Controller |
| `ical-parser-service.ts` | 519 lines | 534 lines | +15 lines in Controller |
| `parent-child-link.ts` | 356 lines | 383 lines | +27 lines in Controller |
| `template-resolution-service.ts` | 82 lines | 82 lines | Identical — easy merge |

**Impact**: Any bug fixed or feature added in one copy is silently missing in the other. Already confirmed that `parent-child-link.ts` has drifted 27 lines. This will keep getting worse.

**Fix**: Controller should be the **canonical source** for all of these since it is the orchestration hub. Calendar-Base should import from Controller's published API (or from a shared utility). Shortest path: move them to Controller, re-export through a typed interface, and have Calendar-Base import from `(app.plugins.getPlugin("tps-controller") as ControllerPlugin).services.parentChildLink`.

### 2.2 `time-calculation-service.ts` Duplicated Between Controller and Notifier

| File | Controller | Notifier | Divergence |
|------|-----------|---------|------------|
| `time-calculation-service.ts` | 286 lines | 276 lines | 10 lines differ |

Notifier's copy has slightly fewer features. The Controller already **owns** the reminder engine (`reminder-engine.ts`), so Notifier should be consuming Controller's time-calculation service, not maintaining its own.

**Fix**: Notifier's `time-calculation-service.ts` should be deleted. Notifier gets the functions it needs from Controller's typed API.

### 2.3 `tag-utils.ts` Duplicated in THREE Plugins

`tag-utils.ts` exists in:
- `TPS-Calendar-Base (Dev)/src/services/tag-utils.ts`
- `TPS-Controller (Dev)/src/services/tag-utils.ts`
- `TPS-Global-Context-Menu (Dev)/src/` (some location)

Three independent copies of tag normalization logic. If a new tag format is added, all three need updating.

**Fix**: Move to Controller service and export through typed API or separate shared npm package.

### 2.4 CSS Loading Pattern Duplicated in All 4 Plugins

This exact block appears verbatim in Calendar-Base, Controller, Notifier, and NNC `onload()`:

```typescript
const cssPath = `${this.manifest.dir}/styles-ui.css`;
const cssContent = await this.app.vault.adapter.read(cssPath);
const styleEl = document.head.createEl('style', { attr: { id: 'tps-...-styles' } });
styleEl.textContent = cssContent;
this.register(() => document.head.querySelector('style#tps-...-styles')?.remove());
```

**Issues**:
- `vault.adapter.read()` is async and can fail silently if the file is missing at plugin activation time
- No error handling — a missing CSS file throws uncaught promise rejection
- The `this.register()` cleanup call order matters; if thrown before register, memory leaks
- Needs error boundary + fallback

**Fix**: Extract to a shared `loadPluginStyles(plugin, styleId)` utility function used by all 4. Add try/catch with console warning on missing file.

### 2.5 `PropertyReminder` Interface Defined Twice Identically

`PropertyReminder` is defined in both:
- `TPS-Notifier (Dev)/src/types.ts`
- `TPS-Controller (Dev)/src/types.ts`

They are **identical**. Since Controller owns the reminder engine, Notifier should simply import the type from Controller's public API types.

---

## 3. Architecture & Pattern Issues

### 3.1 Fragile Inter-Plugin Communication (No API Contract)

**Current pattern** (used in NNC, and internally in several places):
```typescript
const controller = (this.app as any).plugins?.getPlugin?.("tps-controller");
if (controller) {
  const role = controller.getRole();
}
```

**Problems**:
- No TypeScript types — any refactor of Controller's method names silently breaks callers
- No version checking — if Controller's API changes, consumer gets runtime crash
- `(this.app as any)` breaks type narrowing throughout the file

**Correct pattern** (as demonstrated in `Examples/notebook-navigator/src/api/NotebookNavigatorAPI.ts`):
1. Define a typed `TPSControllerAPI` interface in a shared location
2. Controller exposes it as a typed property: `this.api: TPSControllerAPI`
3. Consumers import the interface type and do:
```typescript
import type { TPSControllerAPI } from "../types/tps-controller-api";

function getControllerAPI(app: App): TPSControllerAPI | null {
  const plugin = app.plugins.getPlugin("tps-controller");
  return plugin ? (plugin as { api: TPSControllerAPI }).api : null;
}
```

**Reference**: The `notebook-navigator` example in this vault has a full structured API with sub-modules (NavigationAPI, MetadataAPI, SelectionAPI, MenusAPI), versioning (`API_VERSION`), and typed event system.

### 3.2 `(window as any).TPS` Global Pollution

In Controller `main.ts`:
```typescript
(window as any).TPS = { controller: api };
```

**Problems**:
- Overwrites any existing `window.TPS` on re-enable (no guard)
- No cleanup on `onunload()` — `window.TPS` persists even after plugin disabled
- Namespace collision risk (`TPS` is a fairly generic key)
- Bypasses Obsidian's plugin loading system

**Fix**:
- Add cleanup in `onunload()`: `delete (window as any).TPS`
- Guard against clobbering on re-load
- Long term: remove the global entirely; consumers should use the typed API pattern

### 3.3 Settings Mutation Pattern (Missing Abstraction)

Every single settings change across all plugins follows:
```typescript
.onChange(async (value) => {
  this.plugin.settings.someKey = value;
  await this.plugin.saveSettings();
})
```

This is repeated **hundreds of times** across 5 settings tabs. A helper factory would eliminate 90% of this boilerplate:

```typescript
function bindSetting<K extends keyof Settings>(plugin, key: K) {
  return async (value: Settings[K]) => {
    plugin.settings[key] = value;
    await plugin.saveSettings();
  };
}
```

### 3.4 Inline CSS Styles in Settings Tab

`TPS-Global-Context-Menu (Dev)/src/settings-tab.ts` uses inline style manipulation:
```typescript
details.style.border = '1px solid var(--background-modifier-border)';
details.style.borderRadius = '6px';
details.style.padding = '10px';
details.style.marginBottom = '10px';
summary.style.fontWeight = 'bold';
summary.style.cursor = 'pointer';
```

**Issue**: These styles belong in `styles-ui.css` under `.tps-gcm-settings-group` / `.tps-gcm-settings-popout`. Inline styles override CSS themes and can't be overridden by users. 

**Fix**: Add CSS classes for `tps-gcm-settings-group`, `tps-gcm-settings-group-content`, `tps-gcm-settings-popout` to the CSS file and remove all inline styling from `settings-tab.ts`.

### 3.5 `fileMatchesIgnoreRules` Logic Duplicated Inline

Similar ignore-rule evaluation logic appears multiple times across GCM services and likely in NNC rule-engine. This should be a single shared utility function called consistently.

### 3.6 Encoding Artifact in `persistent-menu-manager.ts`

Line 17 of `persistent-menu-manager.ts` contains:
```
// scroll-direction hide/reveal is handled inline â€" no gesture-handler import needed.
```

`â€"` is a UTF-8 mojibake for `–` (en-dash). The file was saved with wrong encoding. **Fix**: Replace `â€"` with `–` or just `--`.

---

## 4. Deprecated & Outdated API Usage

### 4.1 `app.workspace.activeLeaf` — Deprecated Since v1.x

`app.workspace.activeLeaf` is present in at least one file per plugin (confirmed 1 hit each in GCM, Calendar-Base, Controller, NNC, Notifier via glob search at last session).

**Deprecated replacement**:
```typescript
// OLD (deprecated)
const leaf = this.app.workspace.activeLeaf;

// NEW — get the view directly
const view = this.app.workspace.getActiveViewOfType(MarkdownView);

// OR for canvas-awareness
const { activeEditor } = this.app.workspace; // since v1.1.1
```

### 4.2 `vault.getAbstractFileByPath()` — Superseded in v1.5.7

All plugins use `getAbstractFileByPath()` followed by `instanceof TFile` checks. Should be replaced with:
```typescript
// OLD
const file = vault.getAbstractFileByPath(path);
if (file instanceof TFile) { ... }

// NEW (v1.5.7+)
const file = vault.getFileByPath(path);   // returns TFile | null
const folder = vault.getFolderByPath(path); // returns TFolder | null
```

### 4.3 `prepareQuery` / `fuzzySearch` — Removed in API v1.8.x

The API removed `prepareQuery` and `fuzzySearch`. Migration:
```typescript
// OLD
let pq = prepareQuery(q);
fuzzySearch(pq, text);

// NEW
let fuzzy = prepareFuzzySearch(q);
fuzzy(text);
```

Search for any remaining usages of `prepareQuery` or `fuzzySearch` across all plugins.

### 4.4 `SliderComponent` Behavior Changed in v1.5.9

The slider now only fires `onChange` when released, not during drag. If any settings use sliders that depended on instant feedback, add `.setInstant(true)` (but check if the method exists first for backwards compat).

### 4.5 Deferred Tabs Not Handled (v1.7.2+)

Since Obsidian v1.7.2, workspace tabs are **deferred by default** — they don't fully load until activated. Any code that eagerly accesses `leaf.view` on startup may get a deferred view shell with no real content.

**New API**:
```typescript
if (leaf.isDeferred) {
  await leaf.loadIfDeferred();
}
```

All plugins that iterate workspace leaves or restore views on startup should guard with this check.

### 4.6 `Plugin#onUserEnable` Not Implemented (v1.8+)

New callback `onUserEnable()` fires once when user explicitly enables the plugin (not on every vault open). This is the ideal place to run first-time setup (e.g., create default folders, initialize persistent views) rather than doing it every time in `onload()`.

### 4.7 `Plugin#removeCommand` Not Used (v1.8+)

Controller and GCM dynamically change behavior based on device role and settings, but commands once registered stay registered even if they're no longer applicable. `removeCommand(id)` is now available for dynamic command management.

### 4.8 `Plugin#onExternalSettingsChange` Not Implemented (v1.5.7+)

When settings are synced via Obsidian Sync or edited externally, none of the TPS plugins react. `onExternalSettingsChange()` fires when `data.json` changes on disk:
```typescript
async onExternalSettingsChange() {
  await this.loadSettings();
  // re-apply any dynamic behavior that depends on settings
}
```

This is especially important for Controller and Notifier which users may configure on multiple devices.

---

## 5. Type System Issues

### 5.1 `sheduledEnd` Typo in `FrontmatterData`

In GCM `types.ts`, the `FrontmatterData` interface has:
```typescript
sheduledEnd?: string;  // TYPO — should be scheduledEnd
```

This means any code reading `fm.scheduledEnd` gets `undefined` silently because the property is misspelled in type definitions. **Critical data-loss bug potential.**

### 5.2 `endProperty: "timeEstimate"` Semantic Mismatch in Controller Defaults

In `DEFAULT_CONTROLLER_SETTINGS`:
```typescript
endProperty: "timeEstimate"
```

`timeEstimate` is a **duration** (how long something takes), not an **end time**. An "end property" should store an absolute time like `endTime` or `timeEnd`. This semantic mismatch could cause time arithmetic errors in the reminder engine and calendar display.

**Correct default**: `endProperty: "timeEnd"` or `endProperty: "scheduledEnd"` to match the GCM frontmatter convention.

### 5.3 Dead Legacy Fields in Notifier Types

`TPSNotifierSettings` in Notifier's `types.ts` retains:
```typescript
deviceRole?: string;      // legacy — ignored at runtime
pollMinutes?: number;     // legacy — ignored at runtime  
reminders?: any[];        // legacy — ignored at runtime
alertState?: any;         // legacy — ignored at runtime
```

These are kept for migration compat but never read. Should be moved to a `_migrated` block comment or removed after confirming no existing data.json files rely on them.

### 5.4 Overuse of `any` Casts

Patterns found across all plugins:
```typescript
(leaf as any).view
(anyView as any).getMode()
(this.app as any).plugins
(this as any).api
```

Each `any` cast disables TypeScript typechecking for the entire expression chain. The Obsidian API changelog (v1.8.x) explicitly moved from `any` to `unknown` for stronger typing. TPS should follow:
- Use `unknown` + type narrowing instead of silent `any`
- Create proper type declaration files for Obsidian internals (like `(leaf as WorkspaceLeaf & { view: ItemView })`)
- Use the typed API pattern for cross-plugin access

### 5.5 `ExternalCalendarConfig` Defined in Two Places

Defined in both `TPS-Calendar-Base (Dev)/src/types.ts` and `TPS-Controller (Dev)/src/types.ts`. The Controller version should be canonical; Calendar-Base should import it.

---

## 6. Settings Issues

### 6.1 GCM Settings Object is One Massive Flat Interface

`TPSGlobalContextMenuSettings` has ~50+ fields with no sub-grouping. Finding any specific setting requires scanning the entire object. This makes:
- Default values hard to audit
- Settings migration error-prone
- TypeScript autocomplete noisy

**Fix**: Break into nested sub-objects:
```typescript
interface TPSGlobalContextMenuSettings {
  general: GeneralSettings;
  inlineUI: InlineUISettings;
  persistentMenu: PersistentMenuSettings;
  recurrence: RecurrenceSettings;
  viewMode: ViewModeSettings;
  fileNaming: FileNamingSettings;
  properties: PropertySettings;
  appearance: AppearanceSettings;
}
```

`settings-tab.ts` already uses `createSection()` groups — the data model should match the UI structure.

### 6.2 `pollMinutes: 0.5` Default is 30-Second Polling

In Controller's `DEFAULT_CONTROLLER_SETTINGS`:
```typescript
pollMinutes: 0.5  // = 30 seconds
```

30-second polling of all markdown files is extremely aggressive. For 1000+ note vaults this means:
- `getMarkdownFiles()` + metadata reads every 30 seconds
- Constant background I/O even when idle
- Battery/CPU impact on mobile

**Recommended default**: `1.0` (1 minute) or `2.0` (2 minutes) with a note in settings. Better: implement **event-driven** polling that only re-evaluates when `metadataCache:changed` fires for a file that has relevant properties, and use the timer only as a fallback.

### 6.3 GCM's `archiveTag` Setting Should Validate Against Vault Tag List

The archive tag is a free-text field. It should ideally offer autocomplete from `app.metadataCache.getTags()` to prevent typos. This is achievable with a custom `SuggestModal`-backed text field.

### 6.4 Controller's `snoozeProperty` Has No Default in UI

The `snoozeProperty` setting (defaults to `"reminderSnooze"`) exists in Controller but there's no UI affordance explaining what frontmatter key this expects or how snooze works. Should have a description and example.

### 6.5 Notifier's ntfy.sh Server Field Not Validated

The `serverUrl` field for ntfy.sh accepts free text. Should:
- Validate it starts with `http://` or `https://`
- Ping the server on save and show a green checkmark / red X
- Show a link to ntfy.sh signup

### 6.6 View Mode Rules Have No Preview/Test Functionality

The view mode rule builder in GCM settings lets users define complex conditions, but there's no way to test them against a real file without actually switching views. A "Test against current file" button would dramatically reduce configuration guesswork.

### 6.7 Property Profiles Modal (GCM) — No Import/Export

The `PropertyProfilesModal` exists but property profile configurations are stored only locally in data.json. Users on multiple devices using Obsidian Sync will get them synced, but there's no way to share profiles between vaults or back them up as human-readable JSON.

---

## 7. Obsidian API Opportunities (New Features)

### 7.1 `app.fileManager.processFrontMatter()` — Already Available

GCM likely uses manual frontmatter string manipulation in several places. `processFrontMatter()` (stable since v1.1.0) provides **atomic read-modify-write** with no risk of corruption. Verify all frontmatter writes go through this.

### 7.2 `getFrontMatterInfo()` Utility (v1.5.7+)

Available for getting exact byte offsets of where frontmatter ends and content starts. Useful for any GCM operation that inserts content after frontmatter.

### 7.3 `View.scope` Now Public (v1.5.7+)

`View.scope` is now public. This means GCM and Calendar-Base can register **view-scoped hotkeys** that only activate when the specific view is focused, rather than relying on global commands. Especially useful for:
- Calendar navigation (next/prev month, jump to today)
- Inline menu keyboard shortcuts (close panel, cycle status)

### 7.4 `FileManager.getAvailablePathForAttachment()` (v1.5.7+)

When GCM creates attachment notes or subitems, it should use this instead of manual path construction. It respects user's vault attachment settings.

### 7.5 `Workspace.ensureSideLeaf()` Now Public (v1.7.2+)

Calendar-Base and NNC open side panel views. They should use `ensureSideLeaf()` instead of manually checking for existing leaves — it handles the case where the leaf already exists correctly.

### 7.6 `Plugin.onUserEnable()` for First-Time Setup (v1.8+)

Use this for:
- Creating default folder structures on first install
- Showing a welcome/setup wizard
- Registering the initial persistent view state

### 7.7 Deferred View Loading Guard (v1.7.2+)

```typescript
// In any view-access code
const leaf = this.app.workspace.getMostRecentLeaf();
if (leaf?.isDeferred) await leaf.loadIfDeferred();
```

### 7.8 `app.workspace.activeEditor` (v1.1.1+) — Canvas-Aware

GCM currently uses `getActiveViewOfType(MarkdownView)` which returns null when a Canvas is active. `app.workspace.activeEditor` correctly points to the embedded editor in a Canvas card, allowing GCM operations to work inside Canvas file cards.

### 7.9 Properties Panel Integration (v1.4+)

Since Obsidian v1.4, frontmatter properties have first-class UI. TPS plugins that display/edit properties (GCM's property rows, inline panels) should integrate with or at least not conflict with the native Properties panel. Consider:
- Using `app.metadataCache.getFileCache(file)?.frontmatter` consistently (already done)
- Not duplicating the Properties panel functionality unnecessarily
- Offering to open the native Properties panel as an action

### 7.10 `setTooltip()` for All Icon Buttons

GCM's inline menu buttons likely use `title` attributes or no tooltips. `setTooltip(element, text, { placement: 'top' })` provides styled, position-aware tooltips consistent with Obsidian's native UI.

---

## 8. Per-Plugin Deep Dive

### 8.1 TPS-Global-Context-Menu (Dev) — 21,049 lines / 56 files

**Biggest plugin by far. Core issues:**

| Issue | Severity | Description |
|-------|----------|-------------|
| `sheduledEnd` typo | 🔴 Critical | Silent data bug in FrontmatterData interface |
| `tag-utils.ts` 3rd copy | 🟠 High | Three copies of tag normalization — see §2.3 |
| `settings-tab.ts` inline styles | 🟡 Medium | 1368-line settings tab with inline CSS — move to stylesheet |
| No view-scoped hotkeys | 🟡 Medium | Panel navigation has no keyboard shortcuts |
| `activeLeaf` usage | 🟡 Medium | Deprecated API — replace with `getActiveViewOfType` |
| `PanelBuilder.ts` ~3965 lines | 🟡 Medium | Single file too large — should be split further |
| Archive tag no autocomplete | 🟢 Low | Free text field, should suggest from vault tags |
| No test for ViewMode rules | 🟢 Low | No preview functionality in rule builder |
| Encoding artifact line 17 | 🟢 Low | `â€"` mojibake in persistent-menu-manager.ts |

**Settings tab structure** (already has sections): General → Inline UI → Persistent Menu → Subitems → References → Properties → View Modes → Appearance → File Naming → Advanced. This is good. The data model should match (see §6.1).

**Specific improvements**:
- `PersistentMenuManager` should use `leaf.isDeferred` / `leaf.loadIfDeferred()` when iterating leaves
- Archive sweep at 12:05am should use `window.setTimeout` with wakeup detection, not just a fixed interval
- The "Enable in specific views" toggles (3 toggles in one Setting row) loses labels — use a proper `addToggle` with `setName` per toggle or a custom component

### 8.2 TPS-Calendar-Base (Dev) — 6,554 lines / 29 files

| Issue | Severity | Description |
|-------|----------|-------------|
| 4 duplicate services | 🔴 Critical | See §2.1 — external-calendar, ical-parser, parent-child, template |
| `registerBasesView()` stability | 🟠 High | Bases API is semi-experimental — needs version guard |
| `activeLeaf` usage | 🟡 Medium | Deprecated — replace |
| React + FullCalendar bundle size | 🟡 Medium | React adds significant weight; consider alternatives |
| No `ensureSideLeaf()` | 🟢 Low | Should use new public API for side panel |
| No `onExternalSettingsChange` | 🟢 Low | Multi-device iCal URLs won't reload when synced |

**CalendarView.ts** is reportedly ~4088 lines after refactor. Still very large — consider splitting into `CalendarEventService`, `CalendarRenderService`, `CalendarStateManager`.

**iCal sync**: The external calendar service fetches URLs that could be slow/fail. Add:
- Request timeout (currently missing?)
- Exponential backoff on failure
- Cache with stale-while-revalidate pattern

### 8.3 TPS-Controller (Dev) — 6,245 lines / 22 files

| Issue | Severity | Description |
|-------|----------|-------------|
| `pollMinutes: 0.5` default | 🔴 Critical | 30s polling is too aggressive — see §6.2 |
| Owns duplicated services | 🟠 High | Should be canonical source; Calendar-Base should depend on Controller |
| `(window as any).TPS` global | 🟠 High | No cleanup on unload, no version guard — see §3.2 |
| `endProperty: "timeEstimate"` | 🟠 High | Semantic mismatch in defaults — see §5.2 |
| No `onExternalSettingsChange` | 🟡 Medium | Device role changes not reflected when synced |
| Auto-create service has no rate limit | 🟡 Medium | Could create many files rapidly on first scan |
| No typed API interface published | 🟡 Medium | Other plugins use `any` casts to access — see §3.1 |

**API exposure improvement** — define and export:
```typescript
// tps-controller-api.d.ts (publish this alongside plugin)
export interface TPSControllerAPI {
  readonly version: string;
  isController(): boolean;
  getRole(): "controller" | "user" | "standalone";
  getSettings(): Readonly<TPSControllerSettings>;
  getReminders(): PropertyReminder[];
  services: {
    parentChildLink: ParentChildLinkService;
    timeCalculation: TimeCalculationService;
    externalCalendar: ExternalCalendarService;
  };
}
```

### 8.4 TPS-Notebook-Navigator-Companion (Dev) — 7,441 lines / 15 files

| Issue | Severity | Description |
|-------|----------|-------------|
| `getPlugin("tps-controller")` duck-typing | 🟠 High | No typed contract — see §3.1 |
| Rule engine 1010 lines | 🟡 Medium | `rule-engine.ts` is large but well-structured |
| No `onExternalSettingsChange` | 🟡 Medium | Rules configured on one device don't apply until restart on another |
| Device role not reactive | 🟡 Medium | Role change requires vault reload |
| Vault scanner has no progress indicator | 🟢 Low | Full-vault scans show no UI feedback |

**Icon-as-folder-title** pattern: NNC replaces display names with rule-matched icons. This could now tie into `setTooltip()` to show the full folder name on hover for accessibility.

### 8.5 TPS-Notifier (Dev) — 1,748 lines / 10 files

| Issue | Severity | Description |
|-------|----------|-------------|
| `time-calculation-service.ts` duplicate | 🔴 Critical | Delete and import from Controller — see §2.2 |
| `PropertyReminder` duplicate type | 🟠 High | Import from Controller types — see §2.5 |
| Legacy fields in `TPSNotifierSettings` | 🟡 Medium | Dead code, confusing — see §5.3 |
| `pollMinutes: 0.5` default | 🔴 Critical | 30s polling — see §6.2 |
| ntfy.sh URL not validated | 🟡 Medium | See §6.5 |
| No retry on failed ntfy.sh push | 🟡 Medium | Failed notifications silently dropped |
| No `onExternalSettingsChange` | 🟢 Low | ntfy.sh topic change on another device not reloaded |

**Snooze UX**: The snooze system writes a frontmatter property directly to the note. This is the correct approach but should also:
- Clear the snooze property when the trigger time passes (currently? — check)
- Support per-device snooze (snoozing on phone shouldn't affect desktop)

---

## 9. Cross-Plugin Integration Improvements

### 9.1 Define a Formal `TPSControllerAPI` Interface

As described in §3.1 and §8.3, Controller should publish a typed interface that all other TPS plugins (and potentially third-party plugins) consume. Pattern from `notebook-navigator`:

```
TPS-Controller/src/api/
  TPSControllerAPI.ts      ← main class
  types.ts                 ← exported types
  version.ts               ← API_VERSION constant
  modules/
    RemindersAPI.ts
    CalendarAPI.ts
    DeviceRoleAPI.ts
```

### 9.2 Shared Service Resolution Pattern

Replace all `getPlugin("tps-controller")?.someMethod()` calls with a shared utility:

```typescript
// In a shared file imported by all TPS plugins
export function getControllerAPI(app: App): TPSControllerAPI | null {
  const plugin = app.plugins.getPlugin("tps-controller");
  if (!plugin || !("api" in plugin)) return null;
  const api = (plugin as { api: unknown }).api;
  // version check
  if (!isTPSControllerAPI(api)) return null;
  return api;
}

function isTPSControllerAPI(obj: unknown): obj is TPSControllerAPI {
  return typeof obj === "object" && obj !== null && "version" in obj && "getRole" in obj;
}
```

### 9.3 NNC ↔ GCM Icon Sync

NNC assigns icons to folders. GCM likely shows folder context menus. These should share state:
- GCM could display the NNC-assigned icon in folder menu headers
- NNC rule changes could trigger GCM icon refresh

### 9.4 Controller ↔ Calendar Unified Event Source

Currently Calendar-Base has its own copy of external calendar sync. Controller also has a copy. All calendar events should flow through Controller as the single source of truth, and Calendar-Base should be a view-only consumer.

### 9.5 Notifier ↔ GCM Status Sync

When a reminder fires in Notifier and the user snoozes/dismisses, GCM's inline panel for that note should reflect the state change (e.g., highlight the snooze time, dim the scheduled property). Currently these are independent.

---

## 10. New Feature Proposals

### 10.1 Event-Driven Reminder Polling (Replace Timer Poll)

Instead of polling every 30s/60s, subscribe to `metadataCache:changed` and only re-evaluate files that actually changed:

```typescript
this.registerEvent(this.app.metadataCache.on('changed', (file) => {
  this.reminderEngine.evaluateFile(file, this.settings);
}));
// Keep a 5-minute fallback timer for time-based triggers (no file change)
```

This would essentially eliminate idle CPU/battery usage while making reminders **instant** (fires the moment a file with a matching property is saved).

### 10.2 Command Palette Search for Frontmatter By Property

GCM can already modify properties, but there's no quick way to find all notes matching a property value from the command palette. Add a `Search by property` command that uses `prepareFuzzySearch()` (new API) and `metadataCache` to show a fuzzy-searchable list of values.

### 10.3 Per-Device Settings Profiles in Controller

Controller already has device role ("controller" / "user"). Extend this to support **named device profiles** (e.g., "Work Mac", "iPad", "Windows PC") where certain settings (poll rate, notification server, ignore paths) differ per device but vault structure settings are shared.

### 10.4 Drag-to-Reorder in GCM's Subitems Panel

The subitems panel shows child items but likely requires manual reordering via context menu. Add native HTML5 drag-and-drop (or the Obsidian drag token pattern) for direct reordering.

### 10.5 NNC Rule Testing from Context Menu

Right-click a file → "Test NNC Rules" → show which icon/color/sort rules match and why (rule ID, condition matched). Currently debugging NNC rules requires guesswork.

### 10.6 Calendar "Quick Add" from Natural Language

Calendar-Base could integrate a natural language date/time parser (already have `time-calculation-service.ts`) to support typing "meeting tomorrow at 2pm" in a modal that creates a note with correct frontmatter.

### 10.7 Reminder Delivery History Log

Notifier fires and forgets. A small persistent log (`alertHistory` in settings, max 50 entries) showing what was sent, when, and to which ntfy.sh topic would help debug missed notifications.

### 10.8 GCM Bulk Property Edit (Across Multiple Files)

GCM has bulk operations. Extend to allow: select multiple files in file explorer → right-click → "Bulk set property" → edit a frontmatter field value across all selected files simultaneously. Uses `processFrontMatter()` atomically per file.

### 10.9 View Mode Rules: CSS Class Injection

Currently view mode rules switch between Reading/Edit/Preview. Extend the action to also **inject CSS classes** onto the note container (e.g., `data-tps-mode="focus"`) that themes can respond to — essentially providing a lightweight "distraction-free mode per note type" feature.

### 10.10 Canvas-Aware GCM (Use `activeEditor`)

Use `app.workspace.activeEditor` (stable since v1.1.1) to make GCM context menu operations work inside Canvas embedded file cards. Currently, opening a context menu on a Canvas card likely fails because `activeLeaf` is the canvas, not a MarkdownView.

---

## 11. Refactoring Roadmap (Priority Order)

### Phase 1 — Critical Fixes (Do First, Lowest Risk)
| # | Task | Effort | Impact |
|---|------|--------|--------|
| 1.1 | Fix `sheduledEnd` → `scheduledEnd` typo in GCM types + all references | S | 🔴 data bug |
| 1.2 | Fix encoding artifact `â€"` in persistent-menu-manager.ts line 17 | XS | cosmetic |
| 1.3 | Add `delete (window as any).TPS` to Controller `onunload()` | XS | 🟠 memory leak |
| 1.4 | Add try/catch around CSS load in all 4 plugins | S | reliability |
| 1.5 | Change `pollMinutes` default from `0.5` to `2.0` in both Controller and Notifier | XS | 🔴 performance |
| 1.6 | Fix `endProperty` default from `"timeEstimate"` to `"timeEnd"` or `"scheduledEnd"` | XS | 🟠 semantic |

### Phase 2 — Consolidation (High Value, Medium Effort)
| # | Task | Effort | Impact |
|---|------|--------|--------|
| 2.1 | Delete `template-resolution-service.ts` from Calendar-Base (identical to Controller) | S | duplication |
| 2.2 | Consolidate `time-calculation-service.ts` — delete Notifier's copy, import from Controller API | M | duplication |
| 2.3 | Consolidate `tag-utils.ts` — pick one canonical location (Controller), remove other 2 copies | M | duplication |
| 2.4 | Import `PropertyReminder` type in Notifier from Controller types | S | type drift |
| 2.5 | Import `ExternalCalendarConfig` in Calendar-Base from Controller types | S | type drift |
| 2.6 | Extract CSS loading into shared `loadPluginStyles()` utility | S | duplication |
| 2.7 | Extract `bindSetting()` factory for settings tab onChange boilerplate | M | readability |

### Phase 3 — API Modernization (Medium Effort, Future-Proof)
| # | Task | Effort | Impact |
|---|------|--------|--------|
| 3.1 | Replace all `activeLeaf` with `getActiveViewOfType` / `activeEditor` | M | deprecated |
| 3.2 | Replace `getAbstractFileByPath` with `getFileByPath` / `getFolderByPath` | M | deprecated |
| 3.3 | Add `leaf.isDeferred` / `loadIfDeferred()` guards in view-iterating code | M | v1.7.2 compat |
| 3.4 | Implement `onExternalSettingsChange()` in all 5 plugins | M | sync compat |
| 3.5 | Implement `onUserEnable()` for first-time setup in Controller and GCM | S | UX |
| 3.6 | Use `View.scope` for view-scoped hotkeys in Calendar and GCM panels | M | UX |
| 3.7 | Use `setTooltip()` for all icon buttons and NNC folder icons | M | UX |

### Phase 4 — Architecture (High Effort, High Long-Term Value)
| # | Task | Effort | Impact |
|---|------|--------|--------|
| 4.1 | Define and publish formal `TPSControllerAPI` typed interface | L | architecture |
| 4.2 | Move `external-calendar-service.ts` and `ical-parser-service.ts` to Controller canonical | L | duplication |
| 4.3 | Move `parent-child-link.ts` to Controller canonical; Calendar-Base uses API | L | duplication |
| 4.4 | Implement event-driven reminder polling (replace 30s timer with metadataCache listener) | L | performance |
| 4.5 | Break GCM `TPSGlobalContextMenuSettings` flat object into nested sub-objects | L | maintainability |
| 4.6 | Move inline styles from GCM settings-tab.ts to CSS classes | M | maintainability |
| 4.7 | Split `CalendarView.ts` (~4088 lines) into CalendarEventService + CalendarRenderService | L | maintainability |

### Phase 5 — New Features (After Stabilization)
| # | Feature | Effort |
|---|---------|--------|
| 5.1 | Per-device settings profiles in Controller | L |
| 5.2 | Canvas-aware GCM via `activeEditor` | M |
| 5.3 | NNC rule tester from context menu | M |
| 5.4 | Reminder delivery history log | S |
| 5.5 | Bulk property edit across multiple files | M |
| 5.6 | Calendar natural language quick-add | L |
| 5.7 | Search by property command (fuzzy) | M |
| 5.8 | Event-driven reminders (instant trigger on file save) | L |

---

## Appendix A — Duplicate Service Inventory

| File | Calendar-Base | Controller | Notifier | GCM | Notes |
|------|:---:|:---:|:---:|:---:|-------|
| `external-calendar-service.ts` | 131 | 143 | — | — | Diverged +12 |
| `ical-parser-service.ts` | 519 | 534 | — | — | Diverged +15 |
| `parent-child-link.ts` | 356 | 383 | — | — | Diverged +27 |
| `template-resolution-service.ts` | 82 | 82 | — | — | Identical |
| `time-calculation-service.ts` | — | 286 | 276 | — | Diverged -10 |
| `tag-utils.ts` | ✓ | ✓ | — | ✓ | 3 copies |
| `list-renderer.ts` | ✓ | ✓ | — | — | To verify |
| `section-helpers.ts` | ✓ | ✓ | — | — | To verify |

## Appendix B — Obsidian API Version Reference

| Version | Key New APIs |
|---------|-------------|
| v1.1.0 | `processFrontMatter()`, `registerHoverLinkSource`, `activeEditor` |
| v1.1.1 | `activeEditor` canvas-aware, `file-open` on canvas cards |
| v1.4.0 | Properties panel, `frontmatterLinks` in CachedMetadata |
| v1.5.7 | `getFileByPath`, `getFolderByPath`, `getFrontMatterInfo`, `getAvailablePathForAttachment`, `View.scope` public, `onExternalSettingsChange` |
| v1.7.2 | `isDeferred`, `loadIfDeferred`, `ensureSideLeaf()` public |
| v1.8.x | `onUserEnable()`, `removeCommand()`, prefer `unknown` over `any` |
| v1.8.x | Removed `prepareQuery`/`fuzzySearch` → use `prepareFuzzySearch` |
| v1.12.x | Current stable (Feb 2026) |

---

*Analysis complete. See Refactoring Roadmap §11 for prioritized implementation order.*
