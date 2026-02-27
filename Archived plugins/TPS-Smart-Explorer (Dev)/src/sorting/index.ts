/**
 * Sorting System Public API
 * 
 * This is the main entry point for the sorting system.
 * Import from this file to use the sorting functionality.
 */

// Export types
export type {
    SortKeyType,
    SortDirection,
    UnmatchedBehavior,
    NullBehavior,
    SortDefinition,
    SortValue,
    SortableItem,
    ComparisonResult,
    ValueExtractor as IValueExtractor,
    Comparator
} from "./types";

// Export engine
export {
    SortEngine,
    SortEngineConfig,
    createDefaultSortDef,
    validateSortDef,
    normalizeSortDef
} from "./engine";

// Export utilities for advanced usage
export {
    ExtractorFactory,
    ValueExtractor,
    NameExtractor,
    CreatedDateExtractor,
    ModifiedDateExtractor,
    FrontmatterExtractor,
    FrontmatterDateExtractor,
    createNullValue,
    createStringValue,
    createNumberValue
} from "./extractors";

export {
    SortValueComparator
} from "./comparator";

/**
 * Example Usage:
 * 
 * ```typescript
 * import { SortEngine, createDefaultSortDef } from "./sorting";
 * 
 * // Create engine
 * const engine = new SortEngine({ app });
 * 
 * // Simple sort
 * const sortDef = createDefaultSortDef({
 *     keyType: "name",
 *     dir: "asc"
 * });
 * engine.sort(files, sortDef);
 * 
 * // Multi-level sort
 * const sortDefs = [
 *     createDefaultSortDef({ keyType: "frontmatter", key: "priority", dir: "desc" }),
 *     createDefaultSortDef({ keyType: "name", dir: "asc" })
 * ];
 * engine.multiLevelSort(files, sortDefs);
 * 
 * // Custom order
 * const customSort = createDefaultSortDef({
 *     keyType: "frontmatter",
 *     key: "status",
 *     customOrder: ["doing", "todo", "blocked", "done"],
 *     unmatchedBehavior: "end"
 * });
 * engine.sort(files, customSort);
 * ```
 */
