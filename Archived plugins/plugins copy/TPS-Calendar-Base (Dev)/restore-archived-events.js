#!/usr/bin/env node

/**
 * Script to restore incorrectly archived external calendar events
 * 
 * This script:
 * 1. Scans the System/Archive folder for files with externalEventId or tpsCalendarUid
 * 2. Checks if the event date is in the future or recent past (within 30 days)
 * 3. Moves those files back to their original folder (or default to 01 Action Items/Events)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ARCHIVE_FOLDER = '/Users/zachtisherman/TishOS/System/Archive';
const DEFAULT_EVENTS_FOLDER = '/Users/zachtisherman/TishOS/01 Action Items/Events';
const DRY_RUN = process.argv.includes('--dry-run');

// Parse frontmatter from markdown file
function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return null;

    const frontmatter = {};
    const lines = match[1].split('\n');
    let currentKey = null;

    for (const line of lines) {
        if (line.match(/^[a-zA-Z]/)) {
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                currentKey = line.substring(0, colonIndex).trim();
                const value = line.substring(colonIndex + 1).trim();
                frontmatter[currentKey] = value;
            }
        }
    }

    return frontmatter;
}

// Check if file is an external calendar event
function isExternalEvent(frontmatter) {
    return !!(frontmatter.externalEventId || frontmatter.tpsCalendarUid);
}

// Check if event should be restored (future or recent past)
function shouldRestore(frontmatter) {
    const scheduled = frontmatter.scheduled || frontmatter.date;
    if (!scheduled) return false;

    const eventDate = new Date(scheduled);
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Restore if event is in the future or within the last 30 days
    return eventDate >= thirtyDaysAgo;
}

// Main function
async function restoreEvents() {
    console.log('🔍 Scanning archive folder for external calendar events...\n');

    const files = fs.readdirSync(ARCHIVE_FOLDER);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    let restoredCount = 0;
    let skippedCount = 0;
    const restored = [];
    const skipped = [];

    for (const filename of mdFiles) {
        const filePath = path.join(ARCHIVE_FOLDER, filename);
        const content = fs.readFileSync(filePath, 'utf8');
        const frontmatter = parseFrontmatter(content);

        if (!frontmatter) {
            skippedCount++;
            continue;
        }

        if (!isExternalEvent(frontmatter)) {
            skippedCount++;
            continue;
        }

        if (!shouldRestore(frontmatter)) {
            console.log(`⏭️  Skipping old event: ${filename} (${frontmatter.scheduled || 'no date'})`);
            skippedCount++;
            skipped.push({ filename, reason: 'old event' });
            continue;
        }

        // Determine target folder
        let targetFolder = frontmatter.folderPath?.trim();
        if (!targetFolder) {
            targetFolder = DEFAULT_EVENTS_FOLDER;
        } else {
            targetFolder = path.join('/Users/zachtisherman/TishOS', targetFolder);
        }

        // Ensure target folder exists
        if (!fs.existsSync(targetFolder)) {
            console.log(`📁 Creating folder: ${targetFolder}`);
            if (!DRY_RUN) {
                fs.mkdirSync(targetFolder, { recursive: true });
            }
        }

        const targetPath = path.join(targetFolder, filename);

        console.log(`✅ Restoring: ${filename}`);
        console.log(`   From: ${ARCHIVE_FOLDER}`);
        console.log(`   To:   ${targetFolder}`);
        console.log(`   Date: ${frontmatter.scheduled || frontmatter.date}`);
        console.log('');

        if (!DRY_RUN) {
            // Check if file already exists at target
            if (fs.existsSync(targetPath)) {
                console.log(`   ⚠️  File already exists at target, skipping: ${targetPath}\n`);
                skippedCount++;
                skipped.push({ filename, reason: 'already exists at target' });
                continue;
            }

            fs.renameSync(filePath, targetPath);
        }

        restoredCount++;
        restored.push({ filename, targetFolder, date: frontmatter.scheduled || frontmatter.date });
    }

    console.log('\n' + '='.repeat(60));
    console.log('📊 Summary:');
    console.log('='.repeat(60));
    console.log(`✅ Restored: ${restoredCount} files`);
    console.log(`⏭️  Skipped: ${skippedCount} files`);
    console.log(`📁 Total scanned: ${mdFiles.length} files`);

    if (DRY_RUN) {
        console.log('\n⚠️  DRY RUN MODE - No files were actually moved');
        console.log('   Run without --dry-run to perform the actual restore');
    }

    if (restored.length > 0) {
        console.log('\n📋 Restored files:');
        restored.forEach(({ filename, targetFolder, date }) => {
            console.log(`   • ${filename} (${date})`);
        });
    }

    if (skipped.length > 0 && skipped.some(s => s.reason === 'already exists at target')) {
        console.log('\n⚠️  Files that already exist at target:');
        skipped.filter(s => s.reason === 'already exists at target').forEach(({ filename }) => {
            console.log(`   • ${filename}`);
        });
    }
}

// Run the script
restoreEvents().catch(err => {
    console.error('❌ Error:', err);
    process.exit(1);
});
