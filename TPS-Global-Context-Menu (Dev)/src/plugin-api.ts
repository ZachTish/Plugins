import { TFile } from 'obsidian';
import type TPSGlobalContextMenuPlugin from './main';
import type { VaultQueryService } from './services/vault-query-service';
import type { TaskIdentityService } from './services/task-identity-service';
import type { BodySubitemLink, ResolvedParentLink } from './services/subitem-types';

/**
 * Attaches the inter-plugin API object to the plugin instance as `plugin.api`.
 * Extracted from `onload` to keep main.ts concise.
 */
export function setupPluginApi(plugin: TPSGlobalContextMenuPlugin): void {
    const frontmatterApi = {
        process: (
            file: TFile,
            mutator: (frontmatter: Record<string, unknown>) => void | Promise<void>,
        ) => plugin.frontmatterMutationService.process(file, mutator),
        setValues: (
            files: TFile[],
            updates: Record<string, unknown>,
        ) => plugin.frontmatterMutationService.updateValues(files, updates),
        setListValues: (
            files: TFile[],
            key: string,
            values: unknown[],
        ) => plugin.frontmatterMutationService.setListValues(files, key, values),
        addListValues: (
            files: TFile[],
            key: string,
            values: unknown[],
        ) => plugin.frontmatterMutationService.addValuesToList(files, key, values),
        removeListValues: (
            files: TFile[],
            key: string,
            values: unknown[],
        ) => plugin.frontmatterMutationService.removeValuesFromList(files, key, values),
        setDateValue: (
            files: TFile[],
            key: string,
            value: string | null,
        ) => plugin.frontmatterMutationService.setDateValue(files, key, value),
        deleteKeys: (
            files: TFile[],
            keys: string[],
        ) => plugin.frontmatterMutationService.deleteKeys(files, keys),
    };

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
        /** Canonical frontmatter mutation entrypoint with sorting/repair. */
        processFrontmatter: frontmatterApi.process,
        /** Replace one or more scalar/list values by key. */
        setFrontmatterValues: frontmatterApi.setValues,
        /** Replace an entire list field. */
        setFrontmatterListValues: frontmatterApi.setListValues,
        /** Append values to a list field without duplicating entries. */
        addFrontmatterListValues: frontmatterApi.addListValues,
        /** Remove values from a list field. */
        removeFrontmatterListValues: frontmatterApi.removeListValues,
        /** Set or clear a date/datetime field. */
        setFrontmatterDateValue: frontmatterApi.setDateValue,
        /** Delete one or more frontmatter keys. */
        deleteFrontmatterKeys: frontmatterApi.deleteKeys,
        /** Structured frontmatter API for other TPS plugins. */
        frontmatter: frontmatterApi,
        scanBodySubitemLinks: (file: TFile): Promise<BodySubitemLink[]> =>
            plugin.bodySubitemLinkService.scanFile(file),
        reconcileMarkdownParentSubitems: (file: TFile) =>
            plugin.subitemRelationshipSyncService.reconcileMarkdownParent(file),
        addParentToChild: (child: TFile, parent: TFile) =>
            plugin.parentLinkResolutionService.addParentToChild(child, parent),
        removeParentFromChild: (child: TFile, parent: TFile) =>
            plugin.parentLinkResolutionService.removeParentFromChild(child, parent),
        getParentsForChild: (child: TFile): ResolvedParentLink[] =>
            plugin.parentLinkResolutionService.getParentsForChild(child),
        isBodyLinkedSubitem: (parent: TFile, child: TFile) =>
            plugin.bodySubitemLinkService.isBodyLinkedSubitem(parent, child),
        refreshLinkedSubitemReferences: (child: TFile) =>
            plugin.linkedSubitemCheckboxService.refreshReferencesForChild(child),
    };
}
