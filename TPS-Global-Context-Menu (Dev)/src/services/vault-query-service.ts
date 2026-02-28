/**
 * VaultQueryService — Central vault file scanning and structured querying.
 *
 * Provides configurable, criteria-based querying of vault files using only the
 * metadata cache (no disk reads). Designed to be consumed by GCM features and
 * exposed via GCM's inter-plugin API so that Controller / Notifier / Companion
 * can delegate their vault-scanning loops here instead of reimplementing them.
 *
 * All heavy lifting uses the metadata cache — never reads file content.
 */
import { App, TFile, CachedMetadata } from 'obsidian';
import { runInBatches } from '../core/operation-batch-utils';
import * as logger from '../logger';

// ─────────────────────────────────────────────────────────────────────────────
// Filter types
// ─────────────────────────────────────────────────────────────────────────────

/** Filter by vault folder path prefix. */
export interface FolderQueryFilter {
    /**
     * Only return files whose vault path starts with one of these prefixes.
     * A trailing "/" is added automatically if missing.
     */
    include?: string[];
    /**
     * Skip files whose vault path starts with one of these prefixes.
     * A trailing "/" is added automatically if missing.
     */
    exclude?: string[];
}

/** Filter by the normalized value of a status frontmatter property. */
export interface StatusQueryFilter {
    /**
     * Case-insensitive statuses to require.
     * A file is excluded unless its resolved status matches at least one entry.
     */
    include?: string[];
    /**
     * Case-insensitive statuses to reject.
     * A file is excluded if its resolved status matches any entry.
     */
    exclude?: string[];
    /** Frontmatter key used as the status field. Default: 'status'. */
    property?: string;
}

/** Filter by frontmatter / cache tags. */
export interface TagQueryFilter {
    /**
     * File must have at least one of these tags.
     * Leading "#" is stripped before comparison (case-insensitive).
     */
    include?: string[];
    /**
     * File must NOT have any of these tags.
     */
    exclude?: string[];
}

/** Supported comparison operators for a single frontmatter property. */
export type PropertyOperator =
    | 'exists'
    | 'missing'
    | 'equals'
    | 'not-equals'
    | 'contains'
    | 'starts-with'
    | 'ends-with';

/** Filter by a specific frontmatter property value. */
export interface PropertyQueryFilter {
    /** Frontmatter key to inspect. */
    key: string;
    /** Comparison operator. */
    operator: PropertyOperator;
    /**
     * Comparison value (not used for 'exists' / 'missing').
     * Converted to lowercase string before comparison.
     */
    value?: string | number | boolean;
}

/** Filter by a date/time frontmatter property within a Unix-ms range. */
export interface DateRangeQueryFilter {
    /** Frontmatter key whose value is read as a date/time string or Unix ms. */
    property: string;
    /** Inclusive start — only files where the property timestamp >= start. */
    start?: number;
    /** Inclusive end — only files where the property timestamp <= end. */
    end?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Criteria + result types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Composite query criteria for `VaultQueryService`.
 * All specified filters must match (AND logic).
 */
export interface VaultQueryCriteria {
    folders?: FolderQueryFilter;
    statuses?: StatusQueryFilter;
    tags?: TagQueryFilter;
    /**
     * All entries must match.
     * Multiple entries use AND logic.
     */
    properties?: PropertyQueryFilter[];
    dateRange?: DateRangeQueryFilter;
    /**
     * Maximum results to return (applied after filtering).
     * 0 or undefined means no limit.
     */
    limit?: number;
}

/** One matching vault file with its pre-fetched metadata. */
export interface QueryResult {
    file: TFile;
    /** Frontmatter record (empty object when file has no frontmatter). */
    frontmatter: Record<string, unknown>;
    /** Full cached metadata (may be null for files not yet indexed). */
    metadata: CachedMetadata | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────────────────────────────────────

export class VaultQueryService {
    constructor(private readonly app: App) {}

    // ── Public query methods ─────────────────────────────────────────────────

    /**
     * Synchronously scan all vault markdown files and return matches.
     *
     * Uses only the metadata cache — suitable for real-time operations.
     * Yields to the event loop every 50 files when `async` behaviour is needed;
     * for large vaults prefer `queryAsync()`.
     */
    query(criteria: VaultQueryCriteria = {}): QueryResult[] {
        const files = this.app.vault.getMarkdownFiles();
        const results: QueryResult[] = [];
        const limit = criteria.limit ?? 0;

        for (const file of files) {
            if (limit > 0 && results.length >= limit) break;

            const match = this.evaluate(file, criteria);
            if (match) results.push(match);
        }

        logger.log(`[VaultQueryService] query returned ${results.length} / ${files.length} files`);
        return results;
    }

    /**
     * Async batched variant — yields to the event loop between batches.
     * Prefer for background / startup scans in large vaults.
     */
    async queryAsync(criteria: VaultQueryCriteria = {}): Promise<QueryResult[]> {
        const files = this.app.vault.getMarkdownFiles();
        const results: QueryResult[] = [];
        const limit = criteria.limit ?? 0;

        await runInBatches(files, async (file) => {
            if (limit > 0 && results.length >= limit) return;
            const match = this.evaluate(file, criteria);
            if (match) results.push(match);
        });

        logger.log(`[VaultQueryService] queryAsync returned ${results.length} / ${files.length} files`);
        return results;
    }

    /**
     * Return the first match, or null. Stops scanning after the first hit.
     */
    queryOne(criteria: VaultQueryCriteria): QueryResult | null {
        const results = this.query({ ...criteria, limit: 1 });
        return results[0] ?? null;
    }

    /**
     * Count matching files without materialising the full result set.
     */
    count(criteria: VaultQueryCriteria = {}): number {
        const files = this.app.vault.getMarkdownFiles();
        let count = 0;
        for (const file of files) {
            if (this.evaluate(file, criteria)) count += 1;
        }
        return count;
    }

    /**
     * Look up a single file by its vault path and get its frontmatter.
     * Returns null if the file is not found.
     */
    getFile(path: string): QueryResult | null {
        const file = this.app.vault.getMarkdownFiles().find((f) => f.path === path);
        if (!file) return null;
        const metadata = this.app.metadataCache.getFileCache(file);
        const frontmatter = (metadata?.frontmatter as Record<string, unknown>) ?? {};
        return { file, frontmatter, metadata };
    }

    // ── Core evaluator ───────────────────────────────────────────────────────

    private evaluate(file: TFile, criteria: VaultQueryCriteria): QueryResult | null {
        const metadata = this.app.metadataCache.getFileCache(file);
        const fm: Record<string, unknown> =
            (metadata?.frontmatter as Record<string, unknown>) ?? {};

        if (criteria.folders && !this.matchesFolderFilter(file.path, criteria.folders)) return null;
        if (criteria.statuses && !this.matchesStatusFilter(fm, criteria.statuses)) return null;
        if (criteria.tags && !this.matchesTagFilter(fm, metadata, criteria.tags)) return null;

        if (criteria.properties) {
            for (const pf of criteria.properties) {
                if (!this.matchesPropertyFilter(fm, pf)) return null;
            }
        }

        if (criteria.dateRange && !this.matchesDateRangeFilter(fm, criteria.dateRange)) return null;

        return { file, frontmatter: fm, metadata };
    }

    // ── Folder filter ────────────────────────────────────────────────────────

    private matchesFolderFilter(filePath: string, filter: FolderQueryFilter): boolean {
        const normalizePrefix = (p: string) => (p.endsWith('/') ? p : `${p}/`);

        if (filter.include && filter.include.length > 0) {
            const included = filter.include.some((prefix) => {
                const norm = normalizePrefix(prefix);
                return filePath.startsWith(norm) || filePath === prefix;
            });
            if (!included) return false;
        }

        if (filter.exclude && filter.exclude.length > 0) {
            const excluded = filter.exclude.some((prefix) => {
                const norm = normalizePrefix(prefix);
                return filePath.startsWith(norm) || filePath === prefix;
            });
            if (excluded) return false;
        }

        return true;
    }

    // ── Status filter ────────────────────────────────────────────────────────

    private matchesStatusFilter(
        fm: Record<string, unknown>,
        filter: StatusQueryFilter,
    ): boolean {
        const statuses = resolveStatuses(fm, filter.property ?? 'status');

        if (filter.include && filter.include.length > 0) {
            const normalized = filter.include.map(normalizeStatusValue);
            if (!statuses.some((s) => normalized.includes(s))) return false;
        }

        if (filter.exclude && filter.exclude.length > 0) {
            const normalized = filter.exclude.map(normalizeStatusValue);
            if (statuses.some((s) => normalized.includes(s))) return false;
        }

        return true;
    }

    // ── Tag filter ───────────────────────────────────────────────────────────

    private matchesTagFilter(
        fm: Record<string, unknown>,
        metadata: CachedMetadata | null,
        filter: TagQueryFilter,
    ): boolean {
        const tags = resolveTags(fm, metadata);
        const normalize = (t: string) => t.trim().replace(/^#/, '').toLowerCase();

        if (filter.include && filter.include.length > 0) {
            const normalized = filter.include.map(normalize);
            if (!tags.some((t) => normalized.includes(t))) return false;
        }

        if (filter.exclude && filter.exclude.length > 0) {
            const normalized = filter.exclude.map(normalize);
            if (tags.some((t) => normalized.includes(t))) return false;
        }

        return true;
    }

    // ── Property filter ──────────────────────────────────────────────────────

    private matchesPropertyFilter(
        fm: Record<string, unknown>,
        filter: PropertyQueryFilter,
    ): boolean {
        const raw = fm[filter.key];
        const str = String(raw ?? '').trim().toLowerCase();
        const compareStr = String(filter.value ?? '').trim().toLowerCase();

        switch (filter.operator) {
            case 'exists':      return raw != null && str !== '';
            case 'missing':     return raw == null || str === '';
            case 'equals':      return str === compareStr;
            case 'not-equals':  return str !== compareStr;
            case 'contains':    return str.includes(compareStr);
            case 'starts-with': return str.startsWith(compareStr);
            case 'ends-with':   return str.endsWith(compareStr);
            default:            return true;
        }
    }

    // ── Date-range filter ────────────────────────────────────────────────────

    private matchesDateRangeFilter(
        fm: Record<string, unknown>,
        filter: DateRangeQueryFilter,
    ): boolean {
        const raw = fm[filter.property];
        if (raw == null) return false;

        const ts = parseTimestampValue(raw);
        if (ts == null) return false;

        if (filter.start != null && ts < filter.start) return false;
        if (filter.end != null && ts > filter.end) return false;

        return true;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared pure utility functions (exported for use elsewhere in GCM)
// ─────────────────────────────────────────────────────────────────────────────

/** Normalize a status value: trim + lowercase. */
function normalizeStatusValue(raw: unknown): string {
    return String(raw ?? '').trim().toLowerCase();
}

/** Resolve all status strings from a frontmatter record. */
function resolveStatuses(fm: Record<string, unknown>, property = 'status'): string[] {
    const raw = fm[property];
    if (raw == null) return [];
    if (Array.isArray(raw)) return raw.map(normalizeStatusValue).filter(Boolean);
    const single = normalizeStatusValue(raw);
    return single ? [single] : [];
}

/** Collect all tags: prefer metadata cache (handles inline tags), fall back to frontmatter. */
function resolveTags(fm: Record<string, unknown>, metadata: CachedMetadata | null): string[] {
    const cacheTags =
        metadata?.tags?.map((t) => t.tag.replace(/^#/, '').toLowerCase()) ?? [];
    if (cacheTags.length > 0) return cacheTags;

    const raw = fm['tags'];
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : String(raw).split(',');
    return arr.map((t) => String(t).trim().replace(/^#/, '').toLowerCase()).filter(Boolean);
}

/**
 * Parse a frontmatter value into a Unix-millisecond timestamp.
 * Accepts ISO date strings, datetime strings, and plain numeric ms values.
 * Returns null if the value cannot be parsed.
 */
export function parseTimestampValue(value: unknown): number | null {
    if (value == null) return null;
    const str = String(value).trim();
    if (!str) return null;

    // Already a numeric timestamp
    const asNum = Number(str);
    if (Number.isFinite(asNum) && asNum > 0) return asNum;

    // Date/datetime string (ISO 8601, "YYYY-MM-DD HH:mm", etc.)
    const ms = Date.parse(str);
    return isNaN(ms) ? null : ms;
}
