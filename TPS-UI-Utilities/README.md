# TPS UI Utilities

A shared internal library — **not a standalone plugin**. Provides reusable UI components and a shared CSS stylesheet consumed by all other TPS plugins.

---

## What It Provides

### Section Helpers (`src/ui/section-helpers.ts`)
Utility functions for building collapsible settings sections in Obsidian's settings tab API.
- Creates styled container elements with a header, toggle, and animated expand/collapse.
- Used by every TPS plugin settings tab to keep long settings pages organized.

### List Renderer (`src/ui/list-renderer.ts`)
A generic list rendering helper for settings UI and modal panels.
- Renders arrays of items as styled rows with action buttons (edit, delete, reorder).
- Handles empty-state messaging and add-item affordances.

### Shared CSS (`src/styles/shared.css`)
- Common class definitions for TPS plugin UI: notice styles, badge chips, modal layouts, snooze buttons.
- Each plugin copies or imports this file as `styles-ui.css` and injects it at runtime via a `<style>` tag.

---

## Usage

Other TPS plugins import directly from this package in their TypeScript source:

```typescript
import { buildSection, buildCollapsibleSection } from "../../TPS-UI-Utilities/src";
import { renderList } from "../../TPS-UI-Utilities/src";
```

The shared stylesheet is referenced at build time and bundled into each plugin's `styles-ui.css`.

---

## Source Layout

```
src/
  index.ts           — Re-exports all public symbols
  ui/
    section-helpers.ts   — Collapsible settings section builders
    list-renderer.ts     — Generic list row renderer for settings UIs
  styles/
    shared.css           — Common styles shared across all TPS plugins
```
