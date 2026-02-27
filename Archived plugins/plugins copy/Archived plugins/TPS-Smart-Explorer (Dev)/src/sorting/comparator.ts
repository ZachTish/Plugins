/**
 * Comparison Module
 * 
 * Handles comparison of SortValues according to sort definitions.
 * All comparison logic is centralized here for consistency.
 */

import { SortValue, SortDefinition, ComparisonResult } from "./types";

/**
 * Compares two SortValues
 */
export class SortValueComparator {
    /**
     * Main comparison function
     */
    compare(
        valueA: SortValue,
        valueB: SortValue,
        sortDef: SortDefinition
    ): ComparisonResult {
        // Handle null values first
        const nullResult = this.compareNulls(valueA, valueB, sortDef);
        if (nullResult !== null) {
            return nullResult;
        }

        // Both values are non-null, compare by type
        let result: number;

        if (valueA.type === "number" && valueB.type === "number") {
            result = this.compareNumbers(
                valueA.value as number,
                valueB.value as number
            );
        } else if (valueA.type === "string" || valueB.type === "string") {
            // If either is a string, do string comparison
            result = this.compareStrings(
                String(valueA.value),
                String(valueB.value)
            );
        } else {
            // Fallback to string comparison
            result = this.compareStrings(
                String(valueA.value),
                String(valueB.value)
            );
        }

        // Apply sort direction
        const multiplier = sortDef.dir === "desc" ? -1 : 1;
        return this.normalizeResult(result * multiplier);
    }

    /**
     * Handles null value comparison
     * Returns null if neither value is null (continue with normal comparison)
     */
    private compareNulls(
        valueA: SortValue,
        valueB: SortValue,
        sortDef: SortDefinition
    ): ComparisonResult | null {
        const aIsNull = valueA.isNull;
        const bIsNull = valueB.isNull;

        // Both null - equal
        if (aIsNull && bIsNull) {
            return 0;
        }

        // Only one is null
        if (aIsNull || bIsNull) {
            return this.handleSingleNull(aIsNull, sortDef);
        }

        // Neither is null - continue with normal comparison
        return null;
    }

    /**
     * Determines where null values should go
     */
    private handleSingleNull(
        aIsNull: boolean,
        sortDef: SortDefinition
    ): ComparisonResult {
        const behavior = sortDef.nullBehavior ?? "end";
        const multiplier = sortDef.dir === "desc" ? -1 : 1;

        switch (behavior) {
            case "start":
                // Nulls always at start (regardless of direction)
                return aIsNull ? -1 : 1;

            case "end":
                // Nulls always at end (regardless of direction)
                return aIsNull ? 1 : -1;

            case "small":
                // Nulls treated as smallest value (affected by direction)
                return this.normalizeResult((aIsNull ? -1 : 1) * multiplier);

            case "large":
                // Nulls treated as largest value (affected by direction)
                return this.normalizeResult((aIsNull ? 1 : -1) * multiplier);

            default:
                // Default to end
                return aIsNull ? 1 : -1;
        }
    }

    /**
     * Compares two numbers
     */
    private compareNumbers(a: number, b: number): number {
        return a - b;
    }

    /**
     * Compares two strings (case-insensitive, locale-aware)
     */
    private compareStrings(a: string, b: string): number {
        return a.localeCompare(b, undefined, { sensitivity: "base" });
    }

    /**
     * Normalizes a comparison result to -1, 0, or 1
     */
    private normalizeResult(result: number): ComparisonResult {
        if (result < 0) return -1;
        if (result > 0) return 1;
        return 0;
    }
}
