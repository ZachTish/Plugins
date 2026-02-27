/**
 * Smart Explorer Normalizers
 * Functions for normalizing settings, rules, and configurations
 */

export const STYLE_CATEGORIES = ["sort", "hide", "icon", "color", "text"];

// === ID Generation ===

export const createBuilderId = () =>
    `builder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// === Sort Definition Normalizers ===

export const normalizeSingleSortDef = (raw: any = {}) => {
    const keyType = (raw?.keyType || "service").toLowerCase();
    const dir = (raw?.dir || "asc").toLowerCase();
    return {
        keyType: ["service", "name", "created", "modified", "frontmatter", "frontmatter-date"].includes(keyType)
            ? keyType
            : "service",
        dir: dir === "desc" ? "desc" : "asc",
        key: raw?.key?.trim ? raw.key.trim() : raw?.key || "",
        customOrder: Array.isArray(raw?.customOrder) ? raw.customOrder : [],
    };
};

export const normalizeBucketSortDef = (raw: any) => {
    if (Array.isArray(raw)) {
        return raw.map(normalizeSingleSortDef);
    }
    return [normalizeSingleSortDef(raw || {})];
};

// === Builder Rule Normalizers ===

export const normalizeBuilderRule = (raw: any): any => {
    if (!raw || typeof raw !== "object") return null;

    if ((raw.type || "").toLowerCase() === "group") {
        return {
            ...raw,
            type: "group",
            id: raw.id || createBuilderId(),
            match: raw.match || "all",
            rules: Array.isArray(raw.rules)
                ? raw.rules.map(normalizeBuilderRule).filter((rule: any) => rule != null)
                : [],
            sort: normalizeBucketSortDef(raw.sort),
        };
    }

    return {
        ...raw,
        type: "condition",
        id: raw.id || createBuilderId(),
        sort: normalizeBucketSortDef(raw.sort),
    };
};

export const normalizeBuilderDefinition = (raw: any = {}) => {
    const base = {
        ...raw,
        id: raw.id || createBuilderId(),
        type: "group",
        active: raw.active !== false,
        match: raw.match || "all",
        rules: [] as any[],
        sort: normalizeBucketSortDef(raw.sort),
    };

    if (Array.isArray(raw.rules)) {
        base.rules = raw.rules.map(normalizeBuilderRule).filter((rule: any) => rule != null);
    }
    return base;
};

export const normalizeBuilderMap = (raw: any = {}) => {
    if (!raw || typeof raw !== "object") return {};
    const normalized: Record<string, any> = {};
    for (const key of Object.keys(raw)) {
        normalized[key] = normalizeBuilderDefinition(raw[key]);
    }
    return normalized;
};

// === Style Profile Normalizers ===

export const normalizeStyleProfileMap = (raw: any = {}) => {
    const base = {} as Record<string, Record<string, any>>;
    for (const type of STYLE_CATEGORIES) {
        base[type] = {};
        const source = raw?.[type];
        if (!source || typeof source !== "object") continue;
        let idx = 0;
        for (const key of Object.keys(source)) {
            const entry = source[key] || {};
            const id = entry.id || key;
            base[type][id] = {
                id,
                name: entry.name || id,
                builder: normalizeBuilderDefinition(entry.builder || entry),
                folderBuilder: normalizeBuilderDefinition(entry.folderBuilder || {}),
                order: typeof entry.order === "number" ? entry.order : idx++,
            };
        }
    }
    return base;
};

export const normalizeStyleAssignmentEntry = (raw: any = {}) => {
    const entry: any = {};
    for (const type of STYLE_CATEGORIES) {
        const val = raw?.[type];
        entry[type] = typeof val === "string" && val.trim() ? val.trim() : null;
    }
    return entry;
};

export const normalizeStyleAssignmentMap = (raw: any = {}) => {
    const map: any = {};
    if (!raw || typeof raw !== "object") return map;
    for (const key of Object.keys(raw)) {
        map[key] = normalizeStyleAssignmentEntry(raw[key]);
    }
    return map;
};

export const normalizeStyleAssignments = (raw: any = {}) => ({
    default: normalizeStyleAssignmentEntry(raw?.default || {}),
    sections: normalizeStyleAssignmentMap(raw?.sections || {}),
    filters: normalizeStyleAssignmentMap(raw?.filters || {}),
});

// === Service Config Normalizer ===

export const normalizeServiceConfig = (raw: any = {}) => ({
    builders: {
        sort: {
            default: normalizeBuilderDefinition(raw.builders?.sort?.default || raw.sort?.default),
            sections: normalizeBuilderMap(raw.builders?.sort?.sections || raw.sort?.sections),
            filters: normalizeBuilderMap(raw.builders?.sort?.filters || raw.sort?.filters),
        },
        hide: {
            default: normalizeBuilderDefinition(raw.builders?.hide?.default || raw.hide?.default),
            sections: normalizeBuilderMap(raw.builders?.hide?.sections || raw.hide?.sections),
            filters: normalizeBuilderMap(raw.builders?.hide?.filters || raw.hide?.filters),
        },
        icon: {
            default: normalizeBuilderDefinition(raw.builders?.icon?.default || raw.visual?.icon),
            file: normalizeBuilderDefinition(raw.builders?.icon?.file),
            folder: normalizeBuilderDefinition(raw.builders?.icon?.folder),
            line: normalizeBuilderDefinition(raw.builders?.icon?.line),
            sections: normalizeBuilderMap(raw.builders?.icon?.sections),
            filters: normalizeBuilderMap(raw.builders?.icon?.filters),
        },
        color: {
            default: normalizeBuilderDefinition(raw.builders?.color?.default || raw.visual?.color),
            file: normalizeBuilderDefinition(raw.builders?.color?.file),
            folder: normalizeBuilderDefinition(raw.builders?.color?.folder),
            line: normalizeBuilderDefinition(raw.builders?.color?.line),
            sections: normalizeBuilderMap(raw.builders?.color?.sections),
            filters: normalizeBuilderMap(raw.builders?.color?.filters),
        },
        text: {
            default: normalizeBuilderDefinition(raw.builders?.text?.default || raw.visual?.text),
            file: normalizeBuilderDefinition(raw.builders?.text?.file),
            folder: normalizeBuilderDefinition(raw.builders?.text?.folder),
            line: normalizeBuilderDefinition(raw.builders?.text?.line),
            sections: normalizeBuilderMap(raw.builders?.text?.sections),
            filters: normalizeBuilderMap(raw.builders?.text?.filters),
        },
    },
    styleProfiles: normalizeStyleProfileMap(raw.styleProfiles),
    styleAssignments: normalizeStyleAssignments(raw.styleAssignments),
});

// === Base File Parsers ===

export const SUPPORTED_BASE_FILTER_PATTERNS = [
    {
        re: /^file\.path\.startsWith\(["'](.+?)["']\)\s*$/i,
        toRule: (val: string) => ({ type: "condition", source: "path", operator: "starts", value: val }),
    },
    {
        re: /^file\.name\.contains\(["'](.+?)["']\)\s*$/i,
        toRule: (val: string) => ({ type: "condition", source: "name", operator: "contains", value: val }),
    },
    {
        re: /^file\.path\.contains\(["'](.+?)["']\)\s*$/i,
        toRule: (val: string) => ({ type: "condition", source: "path", operator: "contains", value: val }),
    },
    {
        re: /^file\.folder\.contains\(["'](.+?)["']\)\s*$/i,
        toRule: (val: string) => ({ type: "condition", source: "folder", operator: "contains", value: val }),
    },
    {
        re: /^file\.folder\s*[=]+\s*["'](.+?)["']\s*$/i,
        toRule: (val: string) => ({ type: "condition", source: "folder", operator: "is", value: val }),
    },
    {
        re: /^file\.tags\.contains\(["'](.+?)["']\)\s*$/i,
        toRule: (val: string) => ({
            type: "condition", source: "tag", operator: "contains",
            value: val.startsWith("#") ? val : `#${val}`,
        }),
    },
    {
        re: /^file\.tags\.includes\(["'](.+?)["']\)\s*$/i,
        toRule: (val: string) => ({
            type: "condition", source: "tag", operator: "contains",
            value: val.startsWith("#") ? val : `#${val}`,
        }),
    },
    {
        re: /^status\.containsAny\(["'](.+?)["']\)\s*$/i,
        toRule: (val: string) => ({
            type: "condition", source: "frontmatter", field: "status",
            operator: "is", value: val,
        }),
    },
    {
        re: /^!status\.containsAny\(["'](.+?)["']\)\s*$/i,
        toRule: (val: string) => ({
            type: "condition", source: "frontmatter", field: "status",
            operator: "!is", value: val,
        }),
    },
];

export const parseBaseFilterNode = (node: any): any => {
    if (!node) return null;

    if (typeof node === "string") {
        for (const { re, toRule } of SUPPORTED_BASE_FILTER_PATTERNS) {
            const match = node.match(re);
            if (match) return toRule(match[1]);
        }
        return null;
    }

    if (Array.isArray(node)) {
        const rules = node.map(parseBaseFilterNode).filter(Boolean);
        if (!rules.length) return null;
        return { type: "group", match: "all", rules };
    }

    if (typeof node === "object") {
        if (node.and || node.or) {
            const childKey = node.and ? "and" : "or";
            const match = childKey === "and" ? "all" : "any";
            const rules = (node[childKey] || []).map(parseBaseFilterNode).filter(Boolean);
            if (!rules.length) return null;
            return { type: "group", match, rules };
        }
    }

    return null;
};

export const parseBaseSort = (sortConfig: any): any[] => {
    const results: any[] = [];
    const normalizeDir = (dir: any) =>
        String(dir || "ASC").toUpperCase() === "DESC" ? "desc" : "asc";

    if (Array.isArray(sortConfig)) {
        for (const entry of sortConfig) {
            if (!entry) continue;
            const prop = entry.property || entry.key;
            if (!prop) continue;
            results.push({
                keyType: prop.startsWith("file.") ? "name" : "frontmatter",
                key: prop === "file.name" ? "name" : prop.startsWith("file.") ? prop.replace(/^file\./, "") : prop,
                dir: normalizeDir(entry.direction),
            });
        }
    } else if (Array.isArray(sortConfig?.order)) {
        for (const entry of sortConfig.order) {
            if (typeof entry !== "string") continue;
            const prop = entry.trim();
            if (!prop) continue;
            results.push({
                keyType: prop.startsWith("file.") ? "name" : "frontmatter",
                key: prop === "file.name" ? "name" : prop.startsWith("file.") ? prop.replace(/^file\./, "") : prop,
                dir: "asc",
            });
        }
    }
    return results;
};
