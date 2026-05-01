import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  normalizeKanbanScale,
  sanitizeKanbanSettings,
} from '../src/settings.js';

test('normalizeKanbanScale clamps out-of-range values', () => {
  assert.equal(normalizeKanbanScale(0.1), 0.7);
  assert.equal(normalizeKanbanScale(3), 1.4);
});

test('normalizeKanbanScale falls back for non-numeric input', () => {
  assert.equal(normalizeKanbanScale('invalid'), DEFAULT_SETTINGS.scale);
});

test('sanitizeKanbanSettings trims strings and restores invalid enums', () => {
  const settings = sanitizeKanbanSettings({
    iconKey: '  status-icon  ',
    colorKey: '',
    frontmatterColorTarget: 'nope',
    ungroupedPosition: 'middle',
    defaultCreateMode: 'task',
    defaultCreateDestination: '  Projects/Kanban  ',
    kanbanTaskCardPosition: 'sideways',
  });

  assert.equal(settings.iconKey, 'status-icon');
  assert.equal(settings.colorKey, DEFAULT_SETTINGS.colorKey);
  assert.equal(settings.frontmatterColorTarget, DEFAULT_SETTINGS.frontmatterColorTarget);
  assert.equal(settings.ungroupedPosition, DEFAULT_SETTINGS.ungroupedPosition);
  assert.equal(settings.defaultCreateMode, 'task');
  assert.equal(settings.defaultCreateDestination, 'Projects/Kanban');
  assert.equal(settings.kanbanTaskCardPosition, DEFAULT_SETTINGS.kanbanTaskCardPosition);
});

test('sanitizeKanbanSettings restores object and boolean defaults for invalid persisted values', () => {
  const settings = sanitizeKanbanSettings({
    laneOrderByView: 'bad',
    layoutModeByView: null,
    laneLabelAliasesByView: 42,
    dynamicEmptyLaneWidth: 'yes',
    enableKanbanTaskCards: 'no',
    scale: '1.25',
  });

  assert.deepEqual(settings.laneOrderByView, {});
  assert.deepEqual(settings.layoutModeByView, {});
  assert.deepEqual(settings.laneLabelAliasesByView, {});
  assert.equal(settings.dynamicEmptyLaneWidth, false);
  assert.equal(settings.enableKanbanTaskCards, true);
  assert.equal(settings.scale, 1.25);
});