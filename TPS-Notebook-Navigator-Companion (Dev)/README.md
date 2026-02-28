# TPS Notebook Navigator Companion

Automates icon and color assignment on notes and folders displayed by the **Notebook Navigator** plugin. Rules evaluate frontmatter conditions and write icon/color values without any manual intervention.

---

## What It Does

### Rule Engine (`RuleEngine`)
- Evaluates a prioritized list of **IconColorRules** against each file's frontmatter.
- Conditions can match: property value, tag presence, date relative to today, file path pattern.
- First matching rule wins; result is written as `icon` and `color` frontmatter keys.
- Protected keys (`externaleventid`, `tpscalendaruid`) are never overwritten.

### Metadata Manager (`MetadataManager`)
- Batched, rate-limited frontmatter writer (5 files per chunk, 10 ms yield between chunks).
- Tracks recently self-written files to suppress re-triggering the `metadataChanged` event loop.

### Vault Walker (`VaultWalker`)
- Iterates the entire vault in configurable chunks (default 100 files, 10 ms delay).
- Used for full-vault rule application on startup or manual trigger.
- Reports progress to the status bar.

### Sort Rules
- **SortSegmentRules** — define named sort "buckets" that group and order notes within a folder.
- **SortBuckets** — assign notes to buckets based on frontmatter conditions.
- Results are written as a `sort` frontmatter key consumed by Notebook Navigator.

### Hide Rules
- Mark notes as hidden in the navigator by setting a `hidden` frontmatter property.
- Conditions follow the same pattern as icon/color rules.

### System Icon/Color Override
- Optional setting to replace Notebook Navigator's built-in folder icon palette with custom CSS.
- Injected as a `<style>` tag at runtime; removed cleanly on plugin unload.

### Controller Integration
- Listens for the **TPS-Controller** API to determine device role.
- On Controller devices, startup vault scans run through the Controller's scheduler.
- On Replica devices, per-file reactive rules still apply on `metadataChanged`.

---

## Source Layout

```
src/
  main.ts                         — Plugin entry, registers events & commands
  settings-tab.ts                 — Settings UI (rules editor)
  types.ts                        — All types: rules, conditions, settings
  utils/                          — Shared utility helpers
  services/
    rule-engine.ts                — Evaluates IconColorRules against files
    metadata-manager.ts           — Batched frontmatter writer
    vault-walker.ts               — Chunked full-vault file iteration
    logger.ts                     — Scoped debug logger
    settings-manager.ts           — Loads/saves settings with migration
  settings/                       — Settings sub-components
```

---

## Known Issues & Planned Improvements

### Medium
- **Fragile Controller API access** — Uses `(this.app as any).plugins?.getPlugin?.("tps-controller")` with no type contract. Should use a typed `TPSControllerAPI` interface once Controller publishes one (see §3.1 in `TPS-ANALYSIS.md`).
- **Device role not reactive** — If device role changes in Controller, NNC doesn't respond until vault reload. Should subscribe to a Controller API event.
- **`app.workspace.activeLeaf` (deprecated)** — Replace with `getActiveViewOfType()` where applicable.
- **No `onExternalSettingsChange()`** — Rule changes synced via Obsidian Sync don't apply until restart.

### Low
- **Vault scanner has no progress indicator** — Full-vault scans are silent. Should update status bar with progress count.
- **No rule tester** — No way to right-click a file and see which rule matched and why. A "Test NNC Rules" menu item would dramatically reduce debugging time.
- **Folder icon accessibility** — Icon-only folder names lose their text label. Add `setTooltip()` with the original folder name on hover.

### Planned
- Rule debug mode: "Test against file" context menu action showing matched rule ID and condition.
- Subscribe to Controller's device role change event rather than polling on startup.
- `setTooltip()` on icon-substituted folder nodes for accessibility.

---

## Integration with TPS Suite

| Plugin | Relationship |
|--------|-------------|
| TPS-Controller | Queries device role (fragile duck-typed currently) |
| Notebook Navigator | Peer dependency — writes `icon`, `color`, `sort` frontmatter keys it reads |
| TPS-GCM | Could share icon state (NNC-assigned icons visible in GCM folder menus) |
| TPS-Calendar-Base | Independent |

> For full analysis, see `TPS-ANALYSIS.md` in the plugins root.

---

## Shared Utility Files (Intentional Duplication)

Companion is self-contained. No utility files are currently shared with other TPS plugins. If any shared helpers are extracted in the future, note them here.
