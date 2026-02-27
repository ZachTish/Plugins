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
