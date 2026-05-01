import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    matchesExclusionPattern,
    matchesRequiredPath,
    normalizeCalendarTag,
    normalizeCalendarUrl,
    parseFrontmatterDate,
} from '../src/utils';

test('normalizeCalendarUrl converts webcal links to https', () => {
    assert.equal(normalizeCalendarUrl('  webcal://calendar.example.com/feed  '), 'https://calendar.example.com/feed');
});

test('normalizeCalendarTag trims prefixes and lowercases', () => {
    assert.equal(normalizeCalendarTag('  ##Project/Active  '), 'project/active');
});

test('parseFrontmatterDate parses local frontmatter timestamps deterministically', () => {
    const value = parseFrontmatterDate('2026-04-27 08:15:30');
    assert.ok(value instanceof Date);
    assert.equal(value?.getFullYear(), 2026);
    assert.equal(value?.getMonth(), 3);
    assert.equal(value?.getDate(), 27);
    assert.equal(value?.getHours(), 8);
    assert.equal(value?.getMinutes(), 15);
    assert.equal(value?.getSeconds(), 30);
});

test('matchesExclusionPattern supports regex and folder rules', () => {
    assert.equal(matchesExclusionPattern('projects/archive/note.md', 'note.md', 're:^projects/archive/'), true);
    assert.equal(matchesExclusionPattern('projects/archive/note.md', 'note.md', 'projects/archive/'), true);
    assert.equal(matchesExclusionPattern('projects/active/note.md', 'note.md', 'projects/archive/'), false);
});

test('matchesRequiredPath matches nested folders regardless of leading vault segments', () => {
    assert.equal(matchesRequiredPath('Markdown/Action Items/Sub/task.md', 'Action Items'), true);
    assert.equal(matchesRequiredPath('Markdown/Projects/task.md', 'Action Items'), false);
});