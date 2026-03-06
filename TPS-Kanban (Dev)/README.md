TPS Kanban (Dev)

A Kanban board view that integrates with Obsidian's **Bases** plugin. It appears as a selectable view type alongside Table, Calendar, etc. in any `.base` file.

## Features

- **Lanes are driven by the base's Group By setting** — one lane per distinct value of the grouped property
- Cards inside each lane are the base's query results, sorted by the base's multi-level Sort setting
- Click a card to open the linked note
- **Drag a card between lanes** — updates the groupBy frontmatter property on the note to the new lane's value
- Right-click a card for quick open and move-to-lane actions
- **Add card** button per lane creates a new note pre-populated with the lane's property value
- Re-renders automatically whenever the base data or configuration changes
- **Card icon** — shows a Lucide icon on each card read from a configurable frontmatter property (default: `icon`)
- **Card color accent** — applies a left-border color strip to each card from a configurable frontmatter property (default: `color`)
- **Ungrouped lane position** — configure whether cards with no group-by value appear in the first or last lane

## Usage

1. Enable **TPS Kanban (Dev)** in Obsidian community plugins.
2. Open or create a `.base` file (*File → New base*).
3. In the view toolbar, click the view-type selector and choose **Kanban**.
4. Use the base toolbar's **Group By** picker to select which property defines the lanes (e.g. `status`, `priority`).
5. Use the base toolbar's **Sort** picker to control the order of cards within each lane.
6. Drag cards between lanes — this writes the new value back to the note's frontmatter.

## Settings

| Setting | Default | Description |
|---|---|---|
| Icon property | `icon` | Frontmatter key holding a Lucide icon name to show on the card |
| Color property | `color` | Frontmatter key holding a CSS color value (hex, rgb, named) for the card's left-border accent |
| Ungrouped lane position | `Last` | Whether cards with no group-by value appear before or after the keyed lanes |

The `icon` and `color` defaults match the keys written by Notebook Navigator Companion, so cards automatically pick up whatever styling NNC has applied to each note.

## Notes

- Lanes are read-only columns: they are determined by the distinct values of the Group By property in the base. To add a new lane, use a property value that doesn't exist yet.
- If no Group By is configured, the board shows a single ungrouped lane.
- Only `frontmatter` properties support drag-to-move. Computed or file properties are displayed but dragging between lanes is disabled when the Group By targets a non-frontmatter property.
