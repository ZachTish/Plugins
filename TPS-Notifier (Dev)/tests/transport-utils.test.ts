import { test } from 'node:test';
import * as assert from 'node:assert/strict';

import {
    buildNtfyHeaders,
    buildNtfyUrl,
    getNotificationSendReadiness,
    sanitizeNotificationTitle,
} from '../src/transport-utils';

test('buildNtfyUrl trims topic and strips trailing slashes', () => {
    assert.equal(buildNtfyUrl('https://ntfy.sh///', ' alerts '), 'https://ntfy.sh/alerts');
});

test('sanitizeNotificationTitle removes non latin-1 characters', () => {
    assert.equal(sanitizeNotificationTitle('Hello ✓ world'), 'Hello  world');
});

test('getNotificationSendReadiness reports disabled before config validation', () => {
    assert.equal(
        getNotificationSendReadiness({
            enabled: false,
            ntfyServer: '',
            ntfyTopic: '',
            ntfyPriority: 3,
        }),
        'disabled',
    );
});

test('buildNtfyHeaders includes click link when present', () => {
    assert.deepEqual(
        buildNtfyHeaders(
            {
                enabled: true,
                ntfyServer: 'https://ntfy.sh',
                ntfyTopic: 'alerts',
                ntfyPriority: 5,
            },
            'Title ✓',
            'obsidian://tps-messager?vault=Vault&file=Note.md',
        ),
        {
            'Content-Type': 'text/plain; charset=utf-8',
            'Title': 'Title ',
            'Priority': '5',
            'Markdown': 'yes',
            'Click': 'obsidian://tps-messager?vault=Vault&file=Note.md',
        },
    );
});