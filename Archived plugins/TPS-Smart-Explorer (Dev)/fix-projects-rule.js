#!/usr/bin/env node

// Fix the overly broad "Projects" icon rule
const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, 'data.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// Find and fix the Projects rule (rule index 1)
const iconRules = data.serviceConfig.builders.icon.default.rules;
const projectsRule = iconRules[1];

if (projectsRule && projectsRule.name === 'Projects') {
    // Find the nested group with the empty tag condition
    const nestedGroup = projectsRule.rules[0];
    if (nestedGroup && nestedGroup.type === 'group') {
        const tagCondition = nestedGroup.rules[0];
        if (tagCondition && tagCondition.source === 'tag' && tagCondition.value === '') {
            // Change empty string to "project"
            tagCondition.value = 'project';
            console.log('✓ Fixed Projects rule: changed tag condition from "" to "project"');
        }
    }
}

// Write back
fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
console.log('✓ Data saved. Please reload Obsidian.');
