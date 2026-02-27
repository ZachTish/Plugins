/**
 * Sorting Engine
 * 
 * Main sorting orchestrator that combines extractors and comparators
 * to provide a clean sorting API.
 */

import { App } from "obsidian";
import { SortableItem, SortDefinition, ComparisonResult } from "./types";
import { ExtractorFactory } from "./extractors";
import { SortValueComparator } from "./comparator";

/**
 * Configuration for the sorting engine
 */
export interface SortEngineConfig {
    /** Obsidian app instance */
    app: App;
}

/**
 * Main sorting engine
 */
export class SortEngine {
    private extractorFactory: ExtractorFactory;
    private comparator: SortValueComparator;

    constructor(config: SortEngineConfig) {
        this.extractorFactory = new ExtractorFactory(config.app);
        this.comparator = new SortValueComparator();
    }

    /**
     * Creates a comparator function for sorting arrays
     */
    createComparator(sortDef: SortDefinition): (a: SortableItem, b: SortableItem) => number {
        return (a: SortableItem, b: SortableItem) => {
            return this.compare(a, b, sortDef);
        };
    }

    /**
     * Creates a multi-level comparator function
     */
    createMultiLevelComparator(sortDefs: SortDefinition[]): (a: SortableItem, b: SortableItem) => number {
        return (a: SortableItem, b: SortableItem) => {
            // Try each sort definition in order
            for (const sortDef of sortDefs) {
                const result = this.compare(a, b, sortDef);
                if (result !== 0) {
                    return result;
                }
            }

            // All sort definitions resulted in equality
            return 0;
        };
    }

    /**
     * Compares two items according to a sort definition
     */
    compare(
        a: SortableItem,
        b: SortableItem,
        sortDef: SortDefinition
    ): ComparisonResult {
        // Extract values
        const valueA = this.extractorFactory.extract(a, sortDef);
        const valueB = this.extractorFactory.extract(b, sortDef);

        // Compare values
        return this.comparator.compare(valueA, valueB, sortDef);
    }

    /**
     * Sorts an array of items in place
     */
    sort(items: SortableItem[], sortDef: SortDefinition): void {
        items.sort(this.createComparator(sortDef));
    }

    /**
     * Sorts an array of items with multiple sort levels
     */
    multiLevelSort(items: SortableItem[], sortDefs: SortDefinition[]): void {
        if (sortDefs.length === 0) {
            return;
        }

        items.sort(this.createMultiLevelComparator(sortDefs));
    }

    /**
     * Returns a sorted copy of the array
     */
    sorted(items: SortableItem[], sortDef: SortDefinition): SortableItem[] {
        const copy = [...items];
        this.sort(copy, sortDef);
        return copy;
    }

    /**
     * Returns a sorted copy with multiple sort levels
     */
    multiLevelSorted(items: SortableItem[], sortDefs: SortDefinition[]): SortableItem[] {
        const copy = [...items];
        this.multiLevelSort(copy, sortDefs);
        return copy;
    }
}

/**
 * Creates a default sort definition
 */
export function createDefaultSortDef(overrides?: Partial<SortDefinition>): SortDefinition {
    return {
        keyType: "name",
        dir: "asc",
        nullBehavior: "end",
        unmatchedBehavior: "end",
        ...overrides
    };
}

/**
 * Validates a sort definition
 */
export function validateSortDef(sortDef: any): sortDef is SortDefinition {
    if (!sortDef || typeof sortDef !== "object") {
        return false;
    }

    // Check required fields
    if (!sortDef.keyType || !sortDef.dir) {
        return false;
    }

    // Validate keyType
    const validKeyTypes = ["name", "created", "modified", "frontmatter", "frontmatter-date"];
    if (!validKeyTypes.includes(sortDef.keyType)) {
        return false;
    }

    // Validate direction
    if (sortDef.dir !== "asc" && sortDef.dir !== "desc") {
        return false;
    }

    // Frontmatter types need a key
    if ((sortDef.keyType === "frontmatter" || sortDef.keyType === "frontmatter-date") && !sortDef.key) {
        return false;
    }

    return true;
}

/**
 * Normalizes a sort definition to ensure all fields are present
 */
export function normalizeSortDef(raw: any): SortDefinition {
    const base = createDefaultSortDef();

    if (!raw || typeof raw !== "object") {
        return base;
    }

    return {
        keyType: raw.keyType ?? base.keyType,
        dir: raw.dir ?? base.dir,
        key: raw.key,
        customOrder: Array.isArray(raw.customOrder) ? raw.customOrder : undefined,
        unmatchedBehavior: raw.unmatchedBehavior ?? base.unmatchedBehavior,
        nullBehavior: raw.nullBehavior ?? base.nullBehavior
    };
}
