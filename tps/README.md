# TPS - Unified Productivity Suite

**Version**: 2.0.0 (Development)
**Status**: 🚧 Under Active Consolidation

## Overview

TPS is a unified Obsidian plugin consolidating 7 separate TPS plugins into a single, cohesive productivity suite. This consolidation eliminates code duplication, improves maintainability, and provides a better user experience.

## Features (In Progress)

The following plugins are being consolidated:

1. **TPS-Controller** - Device role management, calendar sync, reminders
2. **TPS-Global-Context-Menu** - Universal context menus, inline UI panels
3. **TPS-Calendar-Base** - Calendar views with FullCalendar integration
4. **TPS-Notebook-Navigator-Companion** - Automated folder icons and colors
5. **TPS-Notifier** - Push notifications via ntfy.sh
6. **TPS-Kanban** - Kanban board views
7. **TPS-Auto-Base-Embed** - Automatic Base embedding

## Installation

**⚠️ NOT READY FOR USE YET - DEVELOPMENT IN PROGRESS**

This plugin is currently under active development. Do not install in your production vault.

## Development

### Build

```bash
npm install
npm run build
```

### Watch Mode

```bash
npm run dev
```

## Architecture

```
src/
├── core/           # Plugin framework
├── services/       # Business logic (12 domains)
├── utils/          # Shared utilities
├── handlers/       # Event responders
├── ui/             # Views, modals, settings
├── modals/         # All modal dialogs
├── features/       # Feature orchestration
└── styles/         # Component styles
```

## Progress

See `IMPLEMENTATION_LOG.md` for detailed progress tracking.

## License

MIT

## Author

Zach Tisherman
