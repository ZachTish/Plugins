/**
 * Value Extraction Module
 * 
 * Responsible for extracting sortable values from files and folders.
 * Each extractor is a pure function that returns a normalized SortValue.
 */

import { TFile, TFolder, App } from "obsidian";
import { SortValue, SortDefinition, SortableItem } from "./types";

/**
 * Creates a null SortValue
 */
export function createNullValue(raw?: any): SortValue {
    return {
        value: null,
        type: "null",
        isNull: true,
        raw
    };
}

/**
 * Creates a string SortValue
 */
export function createStringValue(value: string, raw?: any): SortValue {
    return {
        value: value.toLowerCase(),
        type: "string",
        isNull: false,
        raw: raw ?? value
    };
}

/**
 * Creates a number SortValue
 */
export function createNumberValue(value: number, raw?: any): SortValue {
    return {
        value,
        type: "number",
        isNull: false,
        raw: raw ?? value
    };
}

/**
 * Base value extractor class
 */
export abstract class ValueExtractor {
    constructor(protected app: App) { }

    abstract extract(item: SortableItem, sortDef: SortDefinition): SortValue;
}

/**
 * Extracts name-based sort values
 */
export class NameExtractor extends ValueExtractor {
    extract(item: SortableItem, sortDef: SortDefinition): SortValue {
        if (item instanceof TFolder) {
            return createStringValue(item.name);
        }
        return createStringValue(item.basename);
    }
}

/**
 * Extracts creation date sort values
 */
export class CreatedDateExtractor extends ValueExtractor {
    extract(item: SortableItem, sortDef: SortDefinition): SortValue {
        if (item instanceof TFolder) {
            return createNumberValue(0); // Folders don't have reliable timestamps
        }
        const timestamp = item.stat?.ctime ?? 0;
        return createNumberValue(timestamp);
    }
}

/**
 * Extracts modification date sort values
 */
export class ModifiedDateExtractor extends ValueExtractor {
    extract(item: SortableItem, sortDef: SortDefinition): SortValue {
        if (item instanceof TFolder) {
            return createNumberValue(0);
        }
        const timestamp = item.stat?.mtime ?? 0;
        return createNumberValue(timestamp);
    }
}

/**
 * Extracts frontmatter field values
 */
export class FrontmatterExtractor extends ValueExtractor {
    extract(item: SortableItem, sortDef: SortDefinition): SortValue {
        // Folders don't have frontmatter
        if (item instanceof TFolder) {
            return createNullValue();
        }

        // Need a field key
        if (!sortDef.key) {
            return createNullValue();
        }

        // Get frontmatter
        const cache = this.app.metadataCache.getFileCache(item);
        const frontmatter = cache?.frontmatter;
        if (!frontmatter) {
            return createNullValue();
        }

        // Get the value
        const value = frontmatter[sortDef.key];
        if (value === undefined || value === null) {
            return createNullValue();
        }

        // Handle custom order
        if (sortDef.customOrder && sortDef.customOrder.length > 0) {
            return this.extractCustomOrderValue(value, sortDef);
        }

        // Return as-is (will be compared as string or number)
        if (typeof value === "number") {
            return createNumberValue(value);
        }

        return createStringValue(String(value), value);
    }

    /**
     * Extracts value based on custom order
     */
    private extractCustomOrderValue(value: any, sortDef: SortDefinition): SortValue {
        const normalizedValue = String(value).toLowerCase().trim();
        const index = sortDef.customOrder!.findIndex(
            item => item.toLowerCase().trim() === normalizedValue
        );

        if (index !== -1) {
            // Found in custom order - return the index
            return createNumberValue(index, value);
        }

        // Not found - handle based on unmatchedBehavior
        const behavior = sortDef.unmatchedBehavior ?? "end";

        switch (behavior) {
            case "start":
                // Use negative index to put at start
                return createNumberValue(-1, value);

            case "alphabetical":
                // Use the string value for alphabetical sorting
                // Add a large offset to ensure it sorts after matched items
                return createStringValue(String(value), value);

            case "end":
            default:
                // Return null to push to end
                return createNullValue(value);
        }
    }
}

/**
 * Extracts frontmatter date field values
 */
export class FrontmatterDateExtractor extends ValueExtractor {
    extract(item: SortableItem, sortDef: SortDefinition): SortValue {
        // Folders don't have frontmatter
        if (item instanceof TFolder) {
            return createNullValue();
        }

        // Need a field key
        if (!sortDef.key) {
            return createNullValue();
        }

        // Get frontmatter
        const cache = this.app.metadataCache.getFileCache(item);
        const frontmatter = cache?.frontmatter;
        if (!frontmatter) {
            return createNullValue();
        }

        // Get the value
        const value = frontmatter[sortDef.key];
        if (value === undefined || value === null) {
            return createNullValue();
        }

        // Parse as date
        const timestamp = this.parseDate(value);
        if (timestamp === null) {
            return createNullValue(value);
        }

        return createNumberValue(timestamp, value);
    }

    /**
     * Parses various date formats to timestamp
     */
    private parseDate(value: any): number | null {
        // Already a Date object
        if (value instanceof Date) {
            const time = value.getTime();
            return isNaN(time) ? null : time;
        }

        // Try to parse as date
        try {
            const parsed = new Date(value);
            const time = parsed.getTime();
            return isNaN(time) ? null : time;
        } catch {
            return null;
        }
    }
}

/**
 * Factory for creating value extractors
 */
export class ExtractorFactory {
    private extractors: Map<string, ValueExtractor>;

    constructor(app: App) {
        this.extractors = new Map([
            ["name", new NameExtractor(app)],
            ["created", new CreatedDateExtractor(app)],
            ["modified", new ModifiedDateExtractor(app)],
            ["frontmatter", new FrontmatterExtractor(app)],
            ["frontmatter-date", new FrontmatterDateExtractor(app)]
        ]);
    }

    /**
     * Gets the appropriate extractor for a sort definition
     */
    getExtractor(sortDef: SortDefinition): ValueExtractor {
        const extractor = this.extractors.get(sortDef.keyType);
        if (!extractor) {
            // Fallback to name extractor
            return this.extractors.get("name")!;
        }
        return extractor;
    }

    /**
     * Extracts a sort value using the appropriate extractor
     */
    extract(item: SortableItem, sortDef: SortDefinition): SortValue {
        const extractor = this.getExtractor(sortDef);
        return extractor.extract(item, sortDef);
    }
}
