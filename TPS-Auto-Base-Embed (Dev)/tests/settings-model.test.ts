import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  DEFAULT_SETTINGS,
  sanitizeAutoBaseEmbedSettings,
} from '../src/settings-model.js';

test('sanitizeAutoBaseEmbedSettings restores manual expansion state and removes legacy rules', () => {
  const { settings, didChange } = sanitizeAutoBaseEmbedSettings(
    {
      manualExpansionState: null,
      rules: [
        { id: 'keep', basePath: 'Bases/Keep.base', enabled: true, conditions: {}, renderPlacement: 'floating' },
        { id: 'migrated-1', basePath: 'Bases/Old.base', enabled: true, conditions: {} },
      ],
    },
    (rule) => rule.id.startsWith('migrated-'),
  );

  assert.equal(didChange, true);
  assert.deepEqual(settings.manualExpansionState, {});
  assert.equal(settings.rules.length, 1);
  assert.equal(settings.rules[0]?.id, 'keep');
});

test('sanitizeAutoBaseEmbedSettings repairs invalid render placements from legacy inline mode', () => {
  const { settings, didChange } = sanitizeAutoBaseEmbedSettings(
    {
      renderMode: 'inline',
      inlinePlacement: 'after-title',
      rules: [
        { id: 'rule-1', basePath: 'Bases/Keep.base', enabled: true, conditions: {}, renderPlacement: 'sideways' },
      ],
    },
    () => false,
  );

  assert.equal(didChange, true);
  assert.equal(settings.rules[0]?.renderPlacement, 'after-title');
  assert.equal(settings.rules[0]?.kind, 'base');
  assert.equal(settings.rules[0]?.dataviewjsCode, '');
});

test('sanitizeAutoBaseEmbedSettings preserves dataviewjs rules and repairs invalid kinds', () => {
  const { settings, didChange } = sanitizeAutoBaseEmbedSettings(
    {
      rules: [
        { id: 'dv-1', kind: 'dataviewjs', basePath: '', dataviewjsCode: 'dv.paragraph("ok")', enabled: true, conditions: {}, renderPlacement: 'floating' },
        { id: 'bad-1', kind: 'something-else', basePath: 'Bases/Keep.base', enabled: true, conditions: {}, renderPlacement: 'floating' },
      ],
    },
    () => false,
  );

  assert.equal(didChange, true);
  assert.equal(settings.rules[0]?.kind, 'dataviewjs');
  assert.equal(settings.rules[0]?.dataviewjsCode, 'dv.paragraph("ok")');
  assert.equal(settings.rules[1]?.kind, 'base');
  assert.equal(settings.rules[1]?.dataviewjsCode, '');
});

test('sanitizeAutoBaseEmbedSettings removes legacy fields and preserves valid settings', () => {
  const { settings, didChange } = sanitizeAutoBaseEmbedSettings(
    {
      enabled: false,
      basePath: 'Legacy.base',
      basePaths: 'LegacyA.base,LegacyB.base',
      excludeFolders: 'Archive',
      rules: [],
    },
    () => false,
  );

  assert.equal(didChange, true);
  assert.equal(settings.enabled, false);
  assert.equal('basePath' in settings, false);
  assert.equal('basePaths' in settings, false);
  assert.equal('excludeFolders' in settings, false);
});

test('sanitizeAutoBaseEmbedSettings leaves already-clean settings unchanged', () => {
  const { settings, didChange } = sanitizeAutoBaseEmbedSettings(
    {
      ...DEFAULT_SETTINGS,
      rules: [
        { id: 'rule-1', kind: 'base', basePath: 'Bases/Keep.base', dataviewjsCode: '', enabled: true, conditions: {}, renderPlacement: 'floating' },
      ],
    },
    () => false,
  );

  assert.equal(didChange, false);
  assert.equal(settings.rules[0]?.renderPlacement, 'floating');
});