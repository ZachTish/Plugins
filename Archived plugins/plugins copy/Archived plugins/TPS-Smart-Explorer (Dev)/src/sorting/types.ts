/**
 * Sorting System Type Definitions
 * 
 * This module defines all types used in the sorting system.
 * Keeping types separate ensures consistency and makes the system easier to extend.
 */

import { TFile, TFolder } from "obsidian";

/**
 * Supported sort key types
 */
export type SortKeyType =
    | "name"           // File/folder name
    | "created"        // Creation timestamp
    | "modified"       // Modification timestamp
    | "frontmatter"    // Generic frontmatter field
    | "frontmatter-date"; // Frontmatter field parsed as date

/**
 * Sort direction
 */
export type SortDirection = "asc" | "desc";

/**
 * How to handle items that don't match custom order
 */
export type UnmatchedBehavior =
    | "end"           // Put unmatched items at the end
    | "start"         // Put unmatched items at the start
    | "alphabetical"; // Sort unmatched items alphabetically among themselves

/**
 * How to handle null/missing values
 */
export type NullBehavior =
    | "end"    // Nulls always go to the end
    | "start"  // Nulls always go to the start
    | "small"  // Treat nulls as smallest value (affected by sort direction)
    | "large"; // Treat nulls as largest value (affected by sort direction)

/**
 * A single sort definition
 */
export interface SortDefinition {
    /** Type of value to sort by */
    keyType: SortKeyType;

    /** Sort direction */
    dir: SortDirection;

    /** Field name (for frontmatter types) */
    key?: string;

    /** Custom order for categorical values */
    customOrder?: string[];

    /** How to handle unmatched items in custom order */
    unmatchedBehavior?: UnmatchedBehavior;

    /** How to handle null/missing values */
    nullBehavior?: NullBehavior;
}

/**
 * Normalized sort value with type information
 */
export interface SortValue {
    /** The actual value */
    value: string | number | null;

    /** Value type for comparison */
    type: "string" | "number" | "null";

    /** Whether this is a null/missing value */
    isNull: boolean;

    /** Original raw value (for debugging) */
    raw?: any;
}

/**
 * Item that can be sorted (file or folder)
 */
export type SortableItem = TFile | TFolder;

/**
 * Comparison result
 */
export type ComparisonResult = -1 | 0 | 1;

/**
 * Value extractor function type
 */
export type ValueExtractor = (
    item: SortableItem,
    sortDef: SortDefinition
) => SortValue;

/**
 * Comparator function type
 */
export type Comparator = (
    a: SortableItem,
    b: SortableItem,
    sortDef: SortDefinition
) => ComparisonResult;
