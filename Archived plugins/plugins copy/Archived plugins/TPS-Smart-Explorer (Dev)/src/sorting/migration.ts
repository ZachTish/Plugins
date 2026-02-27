/**
 * Migration Utilities
 * 
 * Helpers for migrating from the old sorting system to the new one.
 */

import { SortDefinition, createDefaultSortDef } from "./index";

/**
 * Old sort definition format (legacy)
 */
interface LegacySortDef {
    keyType?: string;
    dir?: string;
    key?: string;
    customOrder?: string[];
}

/**
 * Migrates a legacy sort definition to the new format
 */
export function migrateLegacySortDef(legacy: LegacySortDef): SortDefinition {
    const normalized = createDefaultSortDef();

    // Map keyType
    if (legacy.keyType) {
        const validTypes = ["name", "created", "modified", "frontmatter", "frontmatter-date"];
        if (validTypes.includes(legacy.keyType)) {
            normalized.keyType = legacy.keyType as any;
        }
    }

    // Map direction
    if (legacy.dir === "desc") {
        normalized.dir = "desc";
    }

    // Map key
    if (legacy.key) {
        normalized.key = legacy.key;
    }

    // Map custom order
    if (Array.isArray(legacy.customOrder) && legacy.customOrder.length > 0) {
        normalized.customOrder = legacy.customOrder;
    }

    return normalized;
}

/**
 * Migrates an array of legacy sort definitions
 */
export function migrateLegacySortDefs(legacy: LegacySortDef[]): SortDefinition[] {
    if (!Array.isArray(legacy)) {
        return [createDefaultSortDef()];
    }

    return legacy.map(migrateLegacySortDef);
}

/**
 * Detects if a sort definition is using hardcoded priority/status ranking
 * and converts it to use custom order instead
 */
export function migrateHardcodedRankings(sortDef: SortDefinition): SortDefinition {
    if (sortDef.keyType !== "frontmatter" || !sortDef.key) {
        return sortDef;
    }

    const key = sortDef.key.toLowerCase();

    // Migrate priority
    if (key === "priority" && !sortDef.customOrder) {
        return {
            ...sortDef,
            customOrder: ["high", "medium", "normal", "low", "none"],
            dir: "desc" // High priority first
        };
    }

    // Migrate status
    if (key === "status" && !sortDef.customOrder) {
        return {
            ...sortDef,
            customOrder: [
                "doing",
                "working",
                "in progress",
                "open",
                "todo",
                "blocked",
                "complete",
                "done",
                "wont-do",
                "archive"
            ],
            dir: "asc" // Active statuses first
        };
    }

    return sortDef;
}

/**
 * Migrates bucket sort definitions to the new format
 */
export function migrateBucketSort(bucketSortDef: any): SortDefinition[] {
    if (!bucketSortDef || typeof bucketSortDef !== "object") {
        return [createDefaultSortDef()];
    }

    // If it's already an array, migrate each item
    if (Array.isArray(bucketSortDef)) {
        return bucketSortDef.map(migrateLegacySortDef);
    }

    // If it's a single definition, wrap in array
    return [migrateLegacySortDef(bucketSortDef)];
}

/**
 * Validates that a migration was successful
 */
export function validateMigration(
    legacy: any,
    migrated: SortDefinition
): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check that key fields were preserved
    if (legacy.keyType && legacy.keyType !== migrated.keyType) {
        errors.push(`keyType mismatch: ${legacy.keyType} -> ${migrated.keyType}`);
    }

    if (legacy.dir && legacy.dir !== migrated.dir) {
        errors.push(`dir mismatch: ${legacy.dir} -> ${migrated.dir}`);
    }

    if (legacy.key && legacy.key !== migrated.key) {
        errors.push(`key mismatch: ${legacy.key} -> ${migrated.key}`);
    }

    return {
        valid: errors.length === 0,
        errors
    };
}
