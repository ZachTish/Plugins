# TPS Quick Start Guide

## Current Status

✅ **Phase 1 Complete**: Infrastructure and build system working
🔄 **Phase 2 In Progress**: Services consolidation (10% complete)

## What Works Right Now

- ✅ Plugin builds successfully
- ✅ Core framework in place (types, logger, constants)
- ✅ Shared utilities merged (9 files)
- ✅ Basic plugin skeleton loads

## Quick Build Commands

```bash
cd /Users/zachtisherman/TishOS/.obsidian/plugins/tps

# Install dependencies (first time only)
npm install

# Build for production
npm run build

# Watch mode during development
npm run dev
```

## Remaining Work (Priority Order)

### 1. Complete Shared Utilities (30 min)
- [ ] Copy inline-tag-utils.ts ✅ (done)
- [ ] Copy frontmatter-tag-mutator.ts ✅ (done)
- [ ] Copy async-utils.ts ✅ (done)
- [ ] Copy template-resolution-service.ts ✅ (done)
- [ ] Copy template-variable-service.ts ✅ (done)

### 2. Migrate Services (8-12 hours)
Each service needs to be:
1. Copied from source plugin
2. Updated imports to use new paths
3. Tested for compilation
4. Documented in IMPLEMENTATION_LOG.md

**Priority Order:**
1. Template services (template-resolution, template-variable)
2. Calendar services (external-calendar, ical-parser)
3. Reminder services (time-calculation, reminder-engine)
4. Relationship services (parent-child-link)
5. Sync services (sync-conflict-watcher, sync-request)
6. Notification services (notifier, ntfy-client)
7. Context menu services
8. Property services
9. Rule engine services
10. View services

### 3. Create Feature Modules (4-6 hours)
Each original plugin becomes a feature module:
- features/controller/controller-feature.ts
- features/context-menu/context-menu-feature.ts
- features/calendar/calendar-feature.ts
- etc.

### 4. Migrate UI Components (8-10 hours)
- Views (calendar-view, kanban-view)
- Modals (20+ modal files)
- Settings tab (massive file)

### 5. Settings Migration (2-3 hours)
- Migration service to read old plugin settings
- Transform to new unified format
- Save to data.json

### 6. Testing (4-6 hours)
- Load plugin in Obsidian
- Test each feature
- Fix bugs

## File Reference Guide

### Duplicated Services (Must Merge)
| Service | Source Files | Target |
|---------|-------------|--------|
| external-calendar-service | Controller, Calendar-Base | src/services/calendar/ |
| ical-parser-service | Controller, Calendar-Base | src/services/calendar/ |
| parent-child-link | Controller, Calendar-Base | src/services/relationships/ |
| time-calculation-service | Controller, Notifier | src/services/reminders/ |

### Unique Services (Just Copy)
| Service | Source | Target |
|---------|--------|--------|
| reminder-engine | Controller | src/services/reminders/ |
| auto-create-service | Controller | src/services/templates/ |
| sync-conflict-watcher | Controller | src/services/sync/ |
| property-editor | GCM | src/services/properties/ |
| rule-engine | NN Companion | src/services/rules/ |

## Import Path Updates

When copying files, update imports:

```typescript
// OLD (from Controller)
import { logger } from "../logger";
import { ExternalCalendarEvent } from "../types";

// NEW (unified TPS)
import { logger } from "../../logger";
import { ExternalCalendarEvent } from "../../types";
```

## Testing Checklist

After each service migration:
- [ ] `npm run build` succeeds
- [ ] No TypeScript errors
- [ ] Import paths correct
- [ ] Service compiles to main.js

## Quick Reference: File Counts

```
Original Plugins:
- Controller: 32 files
- Calendar-Base: 33 files
- GCM: 69 files
- NN Companion: 20 files
- Notifier: 8 files
- Kanban: 5 files
- Auto-Embed: 2 files
Total: 169 files

Unified TPS (target):
- Core: 5 files ✅
- Utils: 14 files ✅
- Services: ~60 files (pending)
- UI: ~50 files (pending)
- Features: ~15 files (pending)
Total target: ~144 files (15% reduction)
```

## Next Action

Pick one service from the "Priority Order" list above and migrate it. Start with smaller services like template services before tackling large ones like calendar or context menu.

**Recommended First Steps:**
1. Migrate template services (already copied, just need to verify)
2. Migrate sync services (small, simple)
3. Test build
4. Then tackle larger services

Good luck! 🚀
