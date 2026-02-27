import { TFile, Notice, normalizePath } from 'obsidian';
import TPSGlobalContextMenuPlugin from './main';
import { RRule } from 'rrule';
import * as logger from "./logger";
import { normalizeTagValue, normalizeTagList, parseTagInput, mergeNormalizedTags } from './tag-utils';
import { stripDateSuffix } from './date-suffix-utils';
import { ChecklistHandler } from './checklist-handler';
import { ParentLinkHandler } from './parent-link-handler';
import { buildParentLinkValue } from './parent-link-format';
import {
    casefold,
    deleteValueCaseInsensitive,
    findKeyCaseInsensitive,
    mutateFrontmatterTagFields,
    removeInlineTagsSafely,
    runInBatches,
    setValueCaseInsensitive,
    showNotice,
} from './core';

export class BulkEditService {
    plugin: TPSGlobalContextMenuPlugin;
    private recurrenceCreationInProgress: Set<string> = new Set();
    private frontmatterWriteChains: Map<string, Promise<void>> = new Map();
    private malformedFrontmatterWarnedPaths: Set<string> = new Set();
    private checklistHandler: ChecklistHandler;
    private parentLinkHandler: ParentLinkHandler;
    private recurrenceOpStateLoaded = false;
    private recurrenceOpState: {
        version: number;
        ops: Record<string, { state: 'creating' | 'complete'; targetPath: string; updatedAt: number }>;
    } = { version: 1, ops: {} };

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        this.plugin = plugin;
        this.checklistHandler = new ChecklistHandler(plugin.app);
        this.parentLinkHandler = new ParentLinkHandler(plugin.app, () => plugin.settings);
    }

    private getRecurrenceStatePath(): string {
        return `${this.plugin.manifest.dir}/recurrence-create-state.json`;
    }

    private async loadRecurrenceOpState(): Promise<void> {
        if (this.recurrenceOpStateLoaded) return;
        this.recurrenceOpStateLoaded = true;

        try {
            const path = this.getRecurrenceStatePath();
            const exists = await this.plugin.app.vault.adapter.exists(path);
            if (!exists) return;
            const raw = await this.plugin.app.vault.adapter.read(path);
            const parsed = JSON.parse(raw);
            if (parsed && parsed.version === 1 && parsed.ops && typeof parsed.ops === 'object') {
                this.recurrenceOpState = {
                    version: 1,
                    ops: parsed.ops,
                };
            }
        } catch (error) {
            logger.warn('[TPS GCM] Failed loading recurrence create state:', error);
        }
    }

    private async saveRecurrenceOpState(): Promise<void> {
        try {
            const path = this.getRecurrenceStatePath();
            await this.plugin.app.vault.adapter.write(path, JSON.stringify(this.recurrenceOpState, null, 2));
        } catch (error) {
            logger.warn('[TPS GCM] Failed saving recurrence create state:', error);
        }
    }

    private pruneRecurrenceOpState(now: number = Date.now()): void {
        // Keep completed entries for 14 days (idempotency across device sync delay).
        const completeTtlMs = 14 * 24 * 60 * 60 * 1000;
        // Treat in-flight entries older than 10 minutes as stale.
        const creatingTtlMs = 10 * 60 * 1000;

        for (const [key, op] of Object.entries(this.recurrenceOpState.ops)) {
            if (!op || !op.updatedAt) {
                delete this.recurrenceOpState.ops[key];
                continue;
            }
            const age = now - op.updatedAt;
            if (op.state === 'complete' && age > completeTtlMs) {
                delete this.recurrenceOpState.ops[key];
                continue;
            }
            if (op.state === 'creating' && age > creatingTtlMs) {
                delete this.recurrenceOpState.ops[key];
            }
        }
    }

    private resolveRecurrenceChainId(file: TFile, frontmatter: any, recurrenceRule: string): string {
        const explicitKey = this.findFrontmatterKeyCaseInsensitive(frontmatter || {}, 'recurrenceChainId');
        const explicit = explicitKey ? String(frontmatter?.[explicitKey] ?? '').trim() : '';
        if (explicit) return explicit;

        const baseName = stripDateSuffix(file.basename || '').trim().toLowerCase();
        return baseName;
    }

    private buildRecurrenceOpKey(chainId: string, scheduled: string): string {
        return `${chainId}|${scheduled}`;
    }

    private async beginRecurrenceOp(opKey: string, targetPath: string): Promise<'acquired' | 'exists' | 'inflight'> {
        await this.loadRecurrenceOpState();
        const now = Date.now();
        this.pruneRecurrenceOpState(now);

        const normalizedTarget = normalizePath(targetPath);
        const existing = this.recurrenceOpState.ops[opKey];
        if (!existing) {
            this.recurrenceOpState.ops[opKey] = {
                state: 'creating',
                targetPath: normalizedTarget,
                updatedAt: now,
            };
            await this.saveRecurrenceOpState();
            return 'acquired';
        }

        if (existing.state === 'complete') {
            return 'exists';
        }

        const inflightAge = now - existing.updatedAt;
        if (inflightAge < 10 * 60 * 1000) {
            return 'inflight';
        }

        // Stale in-flight op; reclaim lock.
        this.recurrenceOpState.ops[opKey] = {
            state: 'creating',
            targetPath: normalizedTarget,
            updatedAt: now,
        };
        await this.saveRecurrenceOpState();
        return 'acquired';
    }

    private async completeRecurrenceOp(opKey: string, targetPath: string): Promise<void> {
        await this.loadRecurrenceOpState();
        this.recurrenceOpState.ops[opKey] = {
            state: 'complete',
            targetPath: normalizePath(targetPath),
            updatedAt: Date.now(),
        };
        this.pruneRecurrenceOpState();
        await this.saveRecurrenceOpState();
    }

    private async failRecurrenceOp(opKey: string): Promise<void> {
        await this.loadRecurrenceOpState();
        const existing = this.recurrenceOpState.ops[opKey];
        if (existing?.state === 'creating') {
            delete this.recurrenceOpState.ops[opKey];
            await this.saveRecurrenceOpState();
        }
    }

    private getRecurrenceOpTarget(opKey: string): string | null {
        const existing = this.recurrenceOpState.ops[opKey];
        return existing?.targetPath ? normalizePath(existing.targetPath) : null;
    }

    private normalizeFrontmatterKey(key: string): string {
        return casefold(String(key || ''));
    }

    private normalizeStatusValue(value: unknown): string {
        return String(value ?? '').trim().toLowerCase();
    }

    private getProtectedIdentityKeys(): Set<string> {
        const keys = new Set<string>(['externaleventid', 'tpscalendaruid']);
        const pluginsApi: any = (this.plugin.app as any)?.plugins;
        const controller: any = pluginsApi?.getPlugin?.('tps-controller');
        const calendarBase: any = pluginsApi?.getPlugin?.('tps-calendar-base');

        const addIfString = (value: unknown) => {
            const normalized = this.normalizeFrontmatterKey(String(value ?? ''));
            if (normalized) keys.add(normalized);
        };

        addIfString(controller?.settings?.eventIdKey);
        addIfString(controller?.settings?.uidKey);
        addIfString(calendarBase?.settings?.eventIdKey);
        addIfString(calendarBase?.settings?.uidKey);

        return keys;
    }

    private isProtectedIdentityKey(key: string): boolean {
        const normalized = this.normalizeFrontmatterKey(key);
        if (!normalized) return false;
        return this.getProtectedIdentityKeys().has(normalized);
    }

    private findFrontmatterKeyCaseInsensitive(target: Record<string, any>, key: string): string | null {
        return findKeyCaseInsensitive(target || {}, key);
    }

    private setFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string, value: any): void {
        setValueCaseInsensitive(target, key, value);
    }

    private deleteFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string): void {
        deleteValueCaseInsensitive(target, key);
    }

    private isTagFrontmatterKey(key: string): boolean {
        const normalized = this.normalizeFrontmatterKey(key);
        return normalized === 'tags' || normalized === 'tag';
    }

    private isAliasFrontmatterKey(key: string): boolean {
        const normalized = this.normalizeFrontmatterKey(key);
        return normalized === 'alias' || normalized === 'aliases';
    }

    private filterTagsForRemoval(rawValue: unknown, normalizedTags: Set<string>): { changed: boolean; nextValue?: string[] } {
        const currentTags = normalizeTagList(rawValue);
        if (!currentTags.length) {
            return { changed: false, nextValue: currentTags };
        }

        const filtered = currentTags.filter((rawTag) => !normalizedTags.has(normalizeTagValue(rawTag)));
        if (filtered.length === currentTags.length) {
            return { changed: false, nextValue: currentTags };
        }

        if (filtered.length === 0) {
            return { changed: true };
        }

        return { changed: true, nextValue: filtered };
    }

    private notifyFilesChanged(files: TFile[]): void {
        try {
            const paths = files.map((f) => f.path);
            this.plugin.app.workspace.trigger('tps-gcm-files-updated' as any, paths);
        } catch (e) {
            logger.warn('[TPS GCM] Failed to trigger files-updated event:', e);
        }
    }

    async runSerializedFrontmatterWrite(file: TFile, action: () => Promise<void>): Promise<void> {
        const key = file.path;
        const previous = this.frontmatterWriteChains.get(key) ?? Promise.resolve();

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        this.frontmatterWriteChains.set(
            key,
            previous.then(() => gate).catch(() => gate),
        );

        try {
            await previous;
            await action();
        } finally {
            release();
            if (this.frontmatterWriteChains.get(key) === gate) {
                this.frontmatterWriteChains.delete(key);
            }
        }
    }

    async canMutateFrontmatterSafely(file: TFile): Promise<boolean> {
        if (!(file instanceof TFile)) return false;
        if (file.extension?.toLowerCase() !== 'md') return false;

        if (!(await this.hasDuplicateLeadingFrontmatter(file))) {
            return true;
        }

        if (!this.malformedFrontmatterWarnedPaths.has(file.path)) {
            this.malformedFrontmatterWarnedPaths.add(file.path);
            new Notice(`Skipped frontmatter update for "${file.basename}" (duplicate YAML blocks detected).`);
            logger.warn('[TPS GCM] Skipping frontmatter mutation: duplicate leading frontmatter blocks detected', {
                file: file.path,
            });
        }
        return false;
    }

    private async hasDuplicateLeadingFrontmatter(file: TFile): Promise<boolean> {
        let content = '';
        try {
            content = await this.plugin.app.vault.cachedRead(file);
        } catch (error) {
            logger.warn('[TPS GCM] Failed reading file for frontmatter safety check', { file: file.path, error });
            return false;
        }

        if (!content) return false;
        const normalized = content.replace(/\r\n/g, '\n');
        const bomOffset = normalized.startsWith('\uFEFF') ? 1 : 0;
        const startsWithFrontmatter = normalized.startsWith('---\n', bomOffset);
        if (!startsWithFrontmatter) return false;

        const firstClose = normalized.indexOf('\n---\n', bomOffset + 4);
        if (firstClose === -1) return false;

        const afterFirst = normalized.slice(firstClose + '\n---\n'.length);
        const trimmedAfterFirst = afterFirst.replace(/^\s*/, '');
        if (!trimmedAfterFirst.startsWith('---\n')) return false;

        const secondClose = trimmedAfterFirst.indexOf('\n---\n', 4);
        if (secondClose === -1) return false;

        const secondBody = trimmedAfterFirst.slice(4, secondClose);
        const hasYamlLikeEntry = secondBody
            .split('\n')
            .some((line) => /^[A-Za-z0-9_"'.-]+\s*:/.test(line.trim()));

        return hasYamlLikeEntry;
    }

    async applyToFiles(files: TFile[], callback: (fm: any, file: TFile) => void): Promise<number> {
        let count = 0;
        const updatedFiles: TFile[] = [];

        await runInBatches(files, async (file) => {
            try {
                if (file.extension?.toLowerCase() !== 'md') return;
                if (!(await this.canMutateFrontmatterSafely(file))) return;
                await this.runSerializedFrontmatterWrite(file, async () => {
                    this.plugin.recurrenceService?.markFileAsModified(file.path);
                    await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
                        callback(fm, file);
                    });
                });
                updatedFiles.push(file);
                count++;
            } catch (e) {
                logger.error(`[TPS GCM] Failed to update ${file.path}:`, e);
            }
        }, 40);

        setTimeout(() => {
            for (const file of updatedFiles) {
                this.plugin.persistentMenuManager?.refreshMenusForFile(file);
            }
        }, 350);

        if (updatedFiles.length > 0) {
            this.notifyFilesChanged(updatedFiles);
        }

        return count;
    }

    async updateFrontmatter(files: TFile[], updates: Record<string, any>): Promise<number> {
        const blockedKeys = Object.keys(updates).filter((key) => this.isProtectedIdentityKey(key));
        if (blockedKeys.length > 0) {
            blockedKeys.forEach((key) => delete updates[key]);
            new Notice(`Blocked protected key edit: ${blockedKeys.join(', ')}`);
            logger.warn('[TPS GCM] Blocked protected identity key edit', { keys: blockedKeys });
            if (Object.keys(updates).length === 0) {
                return 0;
            }
        }

        // Checklist Prompt Logic (Single file only to avoid spam)
        if (
            this.plugin.settings.checkOpenChecklistItems &&
            updates.status === 'complete' &&
            files.length === 1
        ) {
            const canProceed = await this.checklistHandler.handleChecklistCompletion(files[0]);
            if (!canProceed) {
                return 0;
            }
        }

        // Check if any files have recurrence rules (if prompting is enabled)
        if (this.plugin.settings.enableRecurrence && this.plugin.settings.promptOnRecurrenceEdit) {
            for (const file of files) {
                const cache = this.plugin.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;

                if (fm && (fm.recurrenceRule || fm.recurrence)) {
                    if (fm.status === 'complete' || fm.status === 'wont-do') continue;

                    const changeKeys = Object.keys(updates);
                    if (changeKeys.includes('status')) continue;

                    let changeDesc = 'updating';
                    if (changeKeys.includes('scheduled')) changeDesc = 'changing the scheduled time of';
                    else if (changeKeys.includes('priority')) changeDesc = 'changing the priority of';
                    else if (changeKeys.some(k => k.includes('tag'))) changeDesc = 'modifying tags on';

                    const result = await this.plugin.recurrenceService.promptForFrontmatterChange(file, changeDesc);

                    if (result === 'cancel') {
                        return 0;
                    }
                }
            }
        }

        const recurrenceStatuses = this.plugin.settings.recurrenceCompletionStatuses?.length
            ? this.plugin.settings.recurrenceCompletionStatuses
            : ['complete', 'wont-do'];
        const recurrenceCompletionSet = new Set(
            recurrenceStatuses.map((status) => this.normalizeStatusValue(status)).filter(Boolean),
        );
        const hasStatusUpdate = Object.prototype.hasOwnProperty.call(updates, 'status');
        const targetStatus = hasStatusUpdate ? this.normalizeStatusValue(updates.status) : '';
        const shouldCreateRecurrenceOnStatusUpdate =
            this.plugin.settings.enableRecurrence &&
            hasStatusUpdate &&
            recurrenceCompletionSet.has(targetStatus);

        const recurrenceCandidates: Array<{ file: TFile; frontmatter: any; previousStatus: string | null }> = [];
        if (shouldCreateRecurrenceOnStatusUpdate) {
            for (const file of files) {
                const cache = this.plugin.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;
                if (!fm || (!fm.recurrenceRule && !fm.recurrence)) continue;

                const previousStatus = this.normalizeStatusValue(fm.status);
                if (recurrenceCompletionSet.has(previousStatus)) continue;

                recurrenceCandidates.push({
                    file,
                    frontmatter: fm,
                    previousStatus: typeof fm.status === 'string' ? fm.status : null,
                });
            }
        }

        const count = await this.applyToFiles(files, (fm) => {
            for (const [key, value] of Object.entries(updates)) {
                if (value === null || value === undefined) {
                    this.deleteFrontmatterValueCaseInsensitive(fm, key);
                    continue;
                }

                if (this.isTagFrontmatterKey(key)) {
                    const normalizedTags = normalizeTagList(value);
                    if (!normalizedTags.length) {
                        this.deleteFrontmatterValueCaseInsensitive(fm, key);
                    } else {
                        this.setFrontmatterValueCaseInsensitive(fm, key, normalizedTags);
                    }
                    continue;
                }

                this.setFrontmatterValueCaseInsensitive(fm, key, value);
            }
        });

        if (count > 0 && recurrenceCandidates.length > 0) {
            for (const candidate of recurrenceCandidates) {
                const handled = await this.createNextRecurrenceInstance(
                    candidate.file,
                    candidate.frontmatter,
                    candidate.previousStatus,
                );
                if (!handled) {
                    await this.clearRecurrenceRule(candidate.file);
                }
            }
        }

        const keys = Object.keys(updates);
        if (count > 0 && keys.length > 0) {
            void this.plugin.viewModeManager?.handlePotentialFrontmatterChange(files, keys);
        }
        return count;
    }

    async setStatus(files: TFile[], status: string): Promise<number> {
        // Parent link prompt (single file to avoid spam)
        if (
            this.plugin.settings.checkParentLinkStatuses &&
            this.parentLinkHandler.isCompletionStatus(status) &&
            files.length === 1
        ) {
            const canProceed = await this.parentLinkHandler.handleParentLinkCompletion(
                files[0],
                !!this.plugin.settings.enableLogging
            );
            if (!canProceed) {
                return 0;
            }
        }

        // Checklist Prompt Logic (Single file only to avoid spam)
        if (
            this.plugin.settings.checkOpenChecklistItems &&
            status === 'complete' &&
            files.length === 1
        ) {
            const canProceed = await this.checklistHandler.handleChecklistCompletion(files[0]);
            if (!canProceed) {
                return 0;
            }
        }

        const updates: Record<string, any> = { status };

        if (status === 'complete') {
            const now = window.moment().format('YYYY-MM-DDTHH:mm:ss');
            updates.completedDate = now;
        } else if (status === 'open' || status === 'working' || status === 'blocked') {
            updates.completedDate = null; // Clears the key
        }

        return this.updateFrontmatter(files, updates);
    }

    async setPriority(files: TFile[], priority: string): Promise<number> {
        return this.updateFrontmatter(files, { priority });
    }

    async addTag(files: TFile[], tag: string, key: string = 'tags'): Promise<number> {
        if (this.isProtectedIdentityKey(key)) {
            new Notice(`Blocked protected key edit: ${key}`);
            logger.warn('[TPS GCM] Blocked protected identity key edit in addTag', { key });
            return 0;
        }

        const normalizedTags = parseTagInput(tag);
        if (!normalizedTags.length) return 0;
        const storedTags = normalizedTags.map((value) => `#${value}`);

        if (this.plugin.settings.enableRecurrence && this.plugin.settings.promptOnRecurrenceEdit) {
            for (const file of files) {
                const cache = this.plugin.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;

                if (fm && (fm.recurrenceRule || fm.recurrence) && fm.status !== 'complete' && fm.status !== 'wont-do') {
                    const result = await this.plugin.recurrenceService.promptForFrontmatterChange(file, `adding tag(s) "${storedTags.join(', ')}" to`);
                    if (result === 'cancel') {
                        return 0;
                    }
                    break;
                }
            }
        }

        return this.applyToFiles(files, (fm) => {
            const targetKey = this.findFrontmatterKeyCaseInsensitive(fm, key) || key;
            fm[targetKey] = mergeNormalizedTags(fm[targetKey], normalizedTags);
            if (targetKey !== key && key in fm) {
                delete fm[key];
            }
        });
    }

    async removeTag(files: TFile[], tag: string, key: string = 'tags'): Promise<number> {
        if (this.isProtectedIdentityKey(key)) {
            new Notice(`Blocked protected key edit: ${key}`);
            logger.warn('[TPS GCM] Blocked protected identity key edit in removeTag', { key });
            return 0;
        }

        const normalizedTags = parseTagInput(tag);
        if (!normalizedTags.length) return 0;

        if (this.plugin.settings.enableRecurrence && this.plugin.settings.promptOnRecurrenceEdit) {
            for (const file of files) {
                const cache = this.plugin.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;

                if (fm && (fm.recurrenceRule || fm.recurrence) && fm.status !== 'complete' && fm.status !== 'wont-do') {
                    const result = await this.plugin.recurrenceService.promptForFrontmatterChange(
                        file,
                        `removing tag(s) "${normalizedTags.map((value) => `#${value}`).join(', ')}" from`
                    );
                    if (result === 'cancel') {
                        return 0;
                    }
                    break;
                }
            }
        }

        const normalizedTagSet = new Set(normalizedTags);
        const normalizedField = this.normalizeFrontmatterKey(key);
        const updatedFiles: TFile[] = [];
        let count = 0;

        await runInBatches(files, async (file) => {
            try {
                if (file.extension?.toLowerCase() !== 'md') return;
                if (!(await this.canMutateFrontmatterSafely(file))) return;

                await this.runSerializedFrontmatterWrite(file, async () => {
                    this.plugin.recurrenceService?.markFileAsModified(file.path);

                    await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
                        if (!fm || typeof fm !== 'object') return;

                        if (this.isTagFrontmatterKey(normalizedField) || this.isAliasFrontmatterKey(normalizedField)) {
                            mutateFrontmatterTagFields(fm, (field) => {
                                if (field.lowerKey !== normalizedField && !(normalizedField === 'tags' && field.lowerKey === 'tag')) {
                                    return;
                                }

                                const result = this.filterTagsForRemoval(field.value, normalizedTagSet);
                                if (!result.changed) {
                                    return;
                                }
                                if (!result.nextValue || result.nextValue.length === 0) {
                                    field.remove();
                                    return;
                                }
                                field.set(result.nextValue);
                            });
                            return;
                        }

                        const targetKey = this.findFrontmatterKeyCaseInsensitive(fm, key) || key;
                        const result = this.filterTagsForRemoval(fm[targetKey], normalizedTagSet);
                        if (!result.changed) {
                            return;
                        }
                        if (!result.nextValue || result.nextValue.length === 0) {
                            delete fm[targetKey];
                        } else {
                            fm[targetKey] = result.nextValue;
                        }
                        if (targetKey !== key && key in fm) {
                            delete fm[key];
                        }
                    });

                    const content = await this.plugin.app.vault.read(file);
                    const nextContent = removeInlineTagsSafely(content, normalizedTags);
                    if (nextContent !== content) {
                        await this.plugin.app.vault.modify(file, nextContent);
                    }
                });

                updatedFiles.push(file);
                count++;
            } catch (e) {
                logger.error(`[TPS GCM] Failed to remove tag from ${file.path}:`, e);
            }
        }, 40);

        setTimeout(() => {
            for (const file of updatedFiles) {
                this.plugin.persistentMenuManager?.refreshMenusForFile(file);
            }
        }, 100);

        if (updatedFiles.length > 0) {
            this.notifyFilesChanged(updatedFiles);
        }

        return count;
    }

    async setRecurrence(files: TFile[], rule: string | null): Promise<number> {
        const count = await this.applyToFiles(files, (fm) => {
            if (rule) {
                this.setFrontmatterValueCaseInsensitive(fm, 'recurrenceRule', rule);
                this.deleteFrontmatterValueCaseInsensitive(fm, 'recurrence');
            } else {
                this.deleteFrontmatterValueCaseInsensitive(fm, 'recurrenceRule');
                this.deleteFrontmatterValueCaseInsensitive(fm, 'recurrence');
            }
        });

        if (rule && this.plugin.settings.enableRecurrence) {
            const recurrenceStatuses = this.plugin.settings.recurrenceCompletionStatuses?.length
                ? this.plugin.settings.recurrenceCompletionStatuses
                : ['complete', 'wont-do'];

            for (const file of files) {
                setTimeout(async () => {
                    const cache = this.plugin.app.metadataCache.getFileCache(file);
                    const fm = cache?.frontmatter;
                    if (fm && recurrenceStatuses.includes(fm.status)) {
                        await this.createNextRecurrenceInstance(file, fm);
                    }
                }, 200);
            }
        }

        return count;
    }

    async setScheduled(files: TFile[], date: string | null): Promise<number> {
        return this.applyToFiles(files, (fm) => {
            if (date) {
                this.setFrontmatterValueCaseInsensitive(fm, 'scheduled', date);
            } else {
                this.deleteFrontmatterValueCaseInsensitive(fm, 'scheduled');
            }
        });
    }

    async updateScheduledDetails(files: TFile[], scheduled: string | null, timeEstimate: number | null, allDay: boolean, key: string = 'scheduled'): Promise<number> {
        return this.applyToFiles(files, (fm) => {
            if (scheduled) {
                this.setFrontmatterValueCaseInsensitive(fm, key, scheduled);
            } else {
                this.deleteFrontmatterValueCaseInsensitive(fm, key);
            }

            if (timeEstimate !== null && timeEstimate !== undefined && !isNaN(timeEstimate)) {
                this.setFrontmatterValueCaseInsensitive(fm, 'timeEstimate', timeEstimate);
            } else {
                this.deleteFrontmatterValueCaseInsensitive(fm, 'timeEstimate');
            }

            if (allDay) {
                this.setFrontmatterValueCaseInsensitive(fm, 'allDay', true);
            } else {
                this.deleteFrontmatterValueCaseInsensitive(fm, 'allDay');
            }
        });
    }

    showNotice(action: string, detail: string, suffix: string, count: number): void {
        const msg = `${detail} ${suffix} on ${count} file${count !== 1 ? 's' : ''}`;
        showNotice(msg);
    }

    // --- Recurrence ---

    getNextOccurrence(recurrenceRule: string, currentDate?: string): Date | null {
        try {
            const startDate = currentDate
                ? new Date(currentDate)
                : new Date();

            const options = RRule.parseString(recurrenceRule);
            options.dtstart = startDate;

            const rule = new RRule(options);
            const nextDate = rule.after(startDate, false);

            return nextDate;
        } catch (error) {
            logger.error('[TPS GCM] Failed to calculate next recurrence:', error);
            return null;
        }
    }

    private advanceOccurrenceToFuture(recurrenceRule: string, seedDate: string | undefined): Date | null {
        const now = new Date();
        let nextDate = this.getNextOccurrence(recurrenceRule, seedDate);
        if (!nextDate) return null;

        // If the next computed recurrence is still in the past, keep advancing until
        // we land on a future instance. This prevents startup/device-open scans from
        // creating historical "open" notes that can retrigger reminders.
        let guard = 0;
        while (nextDate && nextDate <= now && guard < 500) {
            nextDate = this.getNextOccurrence(recurrenceRule, nextDate.toISOString());
            guard += 1;
        }

        if (guard >= 500) {
            logger.warn('[TPS GCM] Recurrence advance guard reached while seeking future occurrence');
        }

        return nextDate;
    }

    async createNextRecurrenceInstance(file: TFile, frontmatter: any, carryStatus?: string | null): Promise<boolean> {
        if (this.recurrenceCreationInProgress.has(file.path)) {
            logger.warn('[TPS GCM] Recurrence creation already in progress:', file.path);
            return true;
        }

        this.recurrenceCreationInProgress.add(file.path);

        try {
            const recurrenceRule = frontmatter.recurrenceRule || frontmatter.recurrence;
            if (!recurrenceRule) return false;

            const currentScheduled = frontmatter.scheduled;
            const nextDate = this.advanceOccurrenceToFuture(recurrenceRule, currentScheduled);

            if (!nextDate) {
                logger.warn('[TPS GCM] Could not calculate next recurrence date for', file.path, '- rule:', recurrenceRule, 'scheduled:', currentScheduled);
                await this.clearRecurrenceRule(file);
                new Notice('Could not calculate next recurrence date. Recurrence rule cleared.');
                return true;
            }

            const baseName = stripDateSuffix(file.basename);
            const dateStr = window.moment(nextDate).format('YYYY-MM-DD');
            const newFileName = `${baseName} ${dateStr}.md`;
            const newFilePath = file.parent ? `${file.parent.path}/${newFileName}` : newFileName;
            const chainId = this.resolveRecurrenceChainId(file, frontmatter, recurrenceRule);
            const newScheduled = window.moment(nextDate).format('YYYY-MM-DDTHH:mm:ss');
            const recurrenceOpKey = this.buildRecurrenceOpKey(chainId, newScheduled);

            const opStatus = await this.beginRecurrenceOp(recurrenceOpKey, newFilePath);
            if (opStatus !== 'acquired') {
                const opTarget = this.getRecurrenceOpTarget(recurrenceOpKey);
                if (opTarget && await this.plugin.app.vault.adapter.exists(opTarget)) {
                    logger.log('[TPS GCM] Next recurrence already created at', opTarget);
                    await this.clearRecurrenceRule(file);
                    return true;
                }
                if (await this.plugin.app.vault.adapter.exists(newFilePath)) {
                    logger.log('[TPS GCM] Next recurrence already exists at', newFilePath);
                    await this.completeRecurrenceOp(recurrenceOpKey, newFilePath);
                    await this.clearRecurrenceRule(file);
                    return true;
                }
                // Another device/process is likely creating this recurrence.
                logger.log('[TPS GCM] Recurrence operation already in flight for', newFilePath, '- status:', opStatus);
                return true;
            }

            if (await this.plugin.app.vault.adapter.exists(newFilePath)) {
                logger.warn('[TPS GCM] Next recurrence already exists, skipping creation:', newFilePath);
                await this.completeRecurrenceOp(recurrenceOpKey, newFilePath);
                await this.clearRecurrenceRule(file);
                new Notice(`Next recurrence already exists: ${newFileName}`);
                return true;
            }

            const content = await this.plugin.app.vault.read(file);
            await this.plugin.app.vault.create(newFilePath, content);

            const newFile = this.plugin.app.vault.getAbstractFileByPath(newFilePath);
            if (!(newFile instanceof TFile)) {
                logger.error('[TPS GCM] Could not get newly created file');
                return false;
            }

            const newStatus = this.plugin.settings.recurrenceDefaultStatus || 'open';

            // Validate inputs before writing to frontmatter
            if (!newScheduled || typeof newScheduled !== 'string') {
                throw new Error(`Invalid scheduled value: ${newScheduled}`);
            }
            if (!baseName || typeof baseName !== 'string' || baseName.length > 255) {
                throw new Error(`Invalid title value: ${baseName}`);
            }
            if (!newStatus || typeof newStatus !== 'string') {
                throw new Error(`Invalid status value: ${newStatus}`);
            }

            await this.plugin.app.fileManager.processFrontMatter(newFile, (fm) => {
                this.setFrontmatterValueCaseInsensitive(fm, 'scheduled', newScheduled);
                this.setFrontmatterValueCaseInsensitive(fm, 'title', baseName);
                this.setFrontmatterValueCaseInsensitive(fm, 'status', newStatus);
            });

            await this.completeRecurrenceOp(recurrenceOpKey, newFilePath);
            await this.clearRecurrenceRule(file);

            new Notice(`Created next recurrence: ${newFileName}`);
            return true;
        } catch (error) {
            const recurrenceRule = frontmatter?.recurrenceRule || frontmatter?.recurrence;
            const currentScheduled = frontmatter?.scheduled;
            const nextDate = recurrenceRule ? this.advanceOccurrenceToFuture(recurrenceRule, currentScheduled) : null;
            if (nextDate && recurrenceRule) {
                const chainId = this.resolveRecurrenceChainId(file, frontmatter, recurrenceRule);
                const newScheduled = window.moment(nextDate).format('YYYY-MM-DDTHH:mm:ss');
                const recurrenceOpKey = this.buildRecurrenceOpKey(chainId, newScheduled);
                await this.failRecurrenceOp(recurrenceOpKey);
            }
            logger.error('[TPS GCM] Failed to create next recurrence instance for', file.path, ':', error);
            logger.error('[TPS GCM] Error details - Rule:', recurrenceRule, 'Scheduled:', currentScheduled, 'Error type:', error instanceof Error ? error.constructor.name : typeof error);
            if (error instanceof Error && error.stack) {
                logger.error('[TPS GCM] Stack trace:', error.stack);
            }
            new Notice(`Failed to create next recurrence instance. Check console for details.`);
            return false;
        } finally {
            this.recurrenceCreationInProgress.delete(file.path);
        }
    }

    async checkMissingRecurrences(): Promise<void> {
        if (!this.plugin.settings.enableRecurrence) return;

        const files = this.plugin.app.vault.getMarkdownFiles();
        let createdCount = 0;

        const recurrenceStatuses = this.plugin.settings.recurrenceCompletionStatuses?.length
            ? this.plugin.settings.recurrenceCompletionStatuses
            : ['complete', 'wont-do'];

        for (const file of files) {
            const cache = this.plugin.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter;

            if (!fm) continue;

            const hasRule = fm.recurrenceRule || fm.recurrence;
            const isCompleted = recurrenceStatuses.includes(fm.status);

            if (hasRule && isCompleted) {
                const handled = await this.createNextRecurrenceInstance(file, fm);
                if (handled) {
                    createdCount++;
                }
            }
        }

        if (createdCount > 0) {
            logger.log(`[TPS GCM] Healed ${createdCount} recurring event chains.`);
        }
    }

    async clearRecurrenceRule(file: TFile): Promise<void> {
        await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
            this.deleteFrontmatterValueCaseInsensitive(fm, 'recurrenceRule');
            this.deleteFrontmatterValueCaseInsensitive(fm, 'recurrence');
        });
    }

    // --- Link operations (delegated to parent-link-handler) ---

    private async tagParentsForLinkedChildren(parentFiles: TFile[]): Promise<void> {
        const parentTags = parseTagInput(this.plugin.settings.parentTagOnChildLink || '');
        if (!parentTags.length) return;

        const dedupedParents = Array.from(
            new Map(
                parentFiles
                    .filter((file): file is TFile => file instanceof TFile)
                    .map((file) => [file.path, file]),
            ).values(),
        );

        if (!dedupedParents.length) return;

        const updatedFiles: TFile[] = [];

        await runInBatches(dedupedParents, async (parentFile) => {
            try {
                if (parentFile.extension?.toLowerCase() !== 'md') return;
                if (!(await this.canMutateFrontmatterSafely(parentFile))) return;

                let didChange = false;
                await this.runSerializedFrontmatterWrite(parentFile, async () => {
                    await this.plugin.app.fileManager.processFrontMatter(parentFile, (fm) => {
                        if (!fm || typeof fm !== 'object') return;

                        const existingTagKey = this.findFrontmatterKeyCaseInsensitive(fm, 'tags');
                        const existingRaw = existingTagKey ? fm[existingTagKey] : undefined;
                        const existingTags = normalizeTagList(existingRaw);
                        const mergedTags = mergeNormalizedTags(existingRaw, parentTags);
                        const unchanged =
                            existingTags.length === mergedTags.length &&
                            existingTags.every((tag, index) => tag === mergedTags[index]);

                        if (unchanged) return;

                        this.setFrontmatterValueCaseInsensitive(fm, 'tags', mergedTags);
                        didChange = true;
                    });
                });

                if (didChange) {
                    updatedFiles.push(parentFile);
                }
            } catch (error) {
                logger.error(`[TPS GCM] Failed tagging parent ${parentFile.path} after child link:`, error);
            }
        }, 20);

        if (!updatedFiles.length) return;

        setTimeout(() => {
            for (const file of updatedFiles) {
                this.plugin.persistentMenuManager?.refreshMenusForFile(file);
            }
        }, 200);

        this.notifyFilesChanged(updatedFiles);
        void this.plugin.viewModeManager?.handlePotentialFrontmatterChange(updatedFiles, ['tags']);
    }

    async linkToParent(files: TFile[], parentFile: TFile): Promise<number> {
        const parentKey = this.parentLinkHandler.normalizeParentKey();
        const format = this.parentLinkHandler.normalizeParentLinkFormat();
        const count = await this.applyToFiles(files, (fm, file) => {
            const parentLink = buildParentLinkValue(this.plugin.app, parentFile, file.path, format);
            this.setFrontmatterValueCaseInsensitive(fm, parentKey, parentLink);
            if (this.plugin.settings.autoSaveFolderPath) {
                this.setFrontmatterValueCaseInsensitive(fm, 'folderPath', file.parent?.path || '/');
            }
        });
        if (count > 0) {
            await this.tagParentsForLinkedChildren([parentFile]);
            void this.plugin.viewModeManager?.handlePotentialFrontmatterChange(files, [parentKey]);
        }
        return count;
    }

    async linkChildren(currentFile: TFile, childFiles: TFile[]): Promise<number> {
        const parentKey = this.parentLinkHandler.normalizeParentKey();
        const format = this.parentLinkHandler.normalizeParentLinkFormat();
        const count = await this.applyToFiles(childFiles, (fm, file) => {
            const parentLink = buildParentLinkValue(this.plugin.app, currentFile, file.path, format);
            this.setFrontmatterValueCaseInsensitive(fm, parentKey, parentLink);
            if (this.plugin.settings.autoSaveFolderPath) {
                this.setFrontmatterValueCaseInsensitive(fm, 'folderPath', file.parent?.path || '/');
            }
        });
        if (count > 0) {
            await this.tagParentsForLinkedChildren([currentFile]);
            void this.plugin.viewModeManager?.handlePotentialFrontmatterChange(childFiles, [parentKey]);
        }
        return count;
    }

    async linkAttachments(currentFile: TFile, attachmentFiles: TFile[]): Promise<number> {
        let added = 0;
        await this.plugin.app.fileManager.processFrontMatter(currentFile, (frontmatter: any) => {
            const ATTACHMENTS_KEY = 'attachments';
            const existingRaw = frontmatter[ATTACHMENTS_KEY];
            const values: string[] = [];
            const seen = new Set<string>();

            const pushValue = (raw: any) => {
                if (typeof raw !== 'string') return;
                const trimmed = raw.trim();
                if (!trimmed) return;
                const key = trimmed.toLowerCase();
                if (seen.has(key)) return;
                seen.add(key);
                values.push(trimmed);
            };

            if (Array.isArray(existingRaw)) {
                existingRaw.forEach(pushValue);
            } else if (existingRaw) {
                pushValue(existingRaw);
            }

            const startCount = values.length;
            attachmentFiles.forEach((file) => {
                if (file.path === currentFile.path) return;
                // Use generateMarkdownLink to handle aliases/paths if needed, or fallback to simple link
                const link = this.plugin.app.fileManager.generateMarkdownLink(file, currentFile.path);
                pushValue(link);
            });

            added = values.length - startCount;
            if (added > 0) {
                frontmatter[ATTACHMENTS_KEY] = values;
            }
        });
        return added;
    }
}
