const fs = require('fs');
const { DEFAULT_ICON_RULES } = require('./src/default-icon-rules.ts');

function createBuilderRule(rule, isFolder) {
    const conditions = [];

    // Add extension check
    if (isFolder) {
        conditions.push({
            type: "condition",
            source: "extension",
            operator: "!exists",
            value: ""
        });
    } else {
        const hasExtCheck = rule.conditions.some(c => c.source === "extension");
        if (!hasExtCheck) {
            conditions.push({
                type: "condition",
                source: "extension",
                operator: "exists",
                value: ""
            });
        }
    }

    // Convert conditions
    for (const cond of rule.conditions) {
        let source = cond.source;
        let operator = cond.operator;
        let value = cond.value || "";
        let field = "";

        if (source === "tree") {
            source = "path";
        } else if (source === "tags") {
            source = "tag";
            if (operator === "includes") operator = "contains";
            if (operator === "!includes") operator = "!contains";
        } else if (source.startsWith("property:")) {
            field = source.split(":")[1];
            source = "frontmatter";
            if (operator === "hasValue") operator = "exists";
            if (operator === "!hasValue") operator = "!exists";
        }

        if (operator === "startsWith") operator = "starts";
        if (operator === "!startsWith") operator = "!starts";

        conditions.push({
            type: "condition",
            source,
            field,
            operator,
            value
        });
    }

    return {
        type: "group",
        match: rule.match || "all",
        active: true,
        rules: conditions,
        id: rule.id
    };
}

// Process rules
const iconRules = [];
const colorRules = [];

for (const rule of DEFAULT_ICON_RULES.fileRules || []) {
    if (!rule.enabled) continue;
    const group = createBuilderRule(rule, false);

    if (rule.icon) {
        iconRules.push({ ...group, visualValue: rule.icon });
    }
    if (rule.color) {
        colorRules.push({ ...group, visualValue: rule.color });
    }
}

for (const rule of DEFAULT_ICON_RULES.folderRules || []) {
    if (!rule.enabled) continue;
    const group = createBuilderRule(rule, true);

    if (rule.icon) {
        iconRules.push({ ...group, visualValue: rule.icon });
    }
    if (rule.color) {
        colorRules.push({ ...group, visualValue: rule.color });
    }
}

const data = {
    migratedFEPPRules: false,
    migratedIconicRules: true,
    settings: {
        filters: [],
        serviceConfig: {
            builders: {
                sort: {
                    default: {
                        id: "default-sort",
                        type: "group",
                        active: false,
                        match: "all",
                        rules: [],
                        sort: []
                    },
                    sections: {},
                    filters: {}
                },
                hide: {
                    default: {
                        id: "default-hide",
                        type: "group",
                        active: false,
                        match: "all",
                        rules: [],
                        sort: []
                    },
                    sections: {},
                    filters: {}
                },
                pin: {
                    default: {
                        id: "default-pin",
                        type: "group",
                        active: false,
                        match: "all",
                        rules: [],
                        sort: []
                    },
                    sections: {},
                    filters: {}
                },
                icon: {
                    default: {
                        id: "default-icon",
                        type: "group",
                        active: true,
                        match: "all",
                        rules: iconRules,
                        sort: []
                    },
                    sections: {},
                    filters: {}
                },
                color: {
                    default: {
                        id: "default-color",
                        type: "group",
                        active: true,
                        match: "all",
                        rules: colorRules,
                        sort: []
                    },
                    sections: {},
                    filters: {}
                },
                text: {
                    default: {
                        id: "default-text",
                        type: "group",
                        active: false,
                        match: "all",
                        rules: [],
                        sort: []
                    },
                    sections: {},
                    filters: {}
                }
            }
        }
    }
};

fs.writeFileSync('data.json', JSON.stringify(data, null, 2));
console.log('Generated data.json with', iconRules.length, 'icon rules and', colorRules.length, 'color rules');
