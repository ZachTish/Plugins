import { TFile } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import type { VaultQueryService } from '../services/files/vault-query-service';
import type { TaskIdentityService } from '../services/files/task-identity-service';

/**
 * Attaches the inter-plugin API object to the plugin instance as `plugin.api`.
 * Extracted from `onload` to keep main.ts concise.
 */
export function setupPluginApi(plugin: TPSGlobalContextMenuPlugin): void {
    (plugin as any).api = {
        // ── Vault querying ────────────────────────────────────────────────────
        /** Synchronously query vault files by structured criteria. */
        queryFiles: (criteria: Parameters<VaultQueryService['query']>[0]) =>
            plugin.vaultQueryService.query(criteria),
        /** Async batched vault query — yields to event loop between batches. */
        queryFilesAsync: (criteria: Parameters<VaultQueryService['queryAsync']>[0]) =>
            plugin.vaultQueryService.queryAsync(criteria),
        /** Return the first matching file, or null. */
        queryOneFile: (criteria: Parameters<VaultQueryService['queryOne']>[0]) =>
            plugin.vaultQueryService.queryOne(criteria),
        /** Count matching files without building a result set. */
        countFiles: (criteria: Parameters<VaultQueryService['count']>[0]) =>
            plugin.vaultQueryService.count(criteria),
        /** Resolve a single file by vault path with pre-fetched frontmatter. */
        getFile: (path: string) =>
            plugin.vaultQueryService.getFile(path),

        // ── Task identity ─────────────────────────────────────────────────────
        /** Classify a file and return a full ItemIdentity. */
        identifyItem: (
            file: Parameters<TaskIdentityService['identify']>[0],
            fm: Parameters<TaskIdentityService['identify']>[1],
            settings?: Parameters<TaskIdentityService['identify']>[2],
        ) => plugin.taskIdentityService.identify(file, fm, settings),
        /** Normalize a raw status value to lowercase-trimmed form. */
        normalizeStatus: (raw: unknown) => plugin.taskIdentityService.normalizeStatus(raw),
        /** Extract all normalized status strings from a frontmatter record. */
        getStatuses: (fm: Record<string, unknown>, property?: string) =>
            plugin.taskIdentityService.getStatuses(fm, property),
        /** True if a value represents an all-day (date-only) event. */
        isAllDayValue: (value: unknown, fm?: Record<string, unknown>) =>
            plugin.taskIdentityService.isAllDayValue(value, fm),

        // ── Frontmatter mutations ─────────────────────────────────────────────
        /** Bulk-update frontmatter on one or more files. */
        updateFrontmatter: (
            files: TFile[],
            updates: Record<string, unknown>,
        ) => plugin.bulkEditService.updateFrontmatter(files, updates),
    };
}
