import { TFile, Notice, normalizePath } from 'obsidian';
import TPSGlobalContextMenuPlugin from '../main';
import { RRule } from 'rrule';
import * as logger from "../logger";
import { normalizeTagValue, normalizeTagList, parseTagInput, mergeNormalizedTags } from '../utils/tag-utils';
import { stripDateSuffix } from '../utils/date-suffix-utils';
import { ChecklistHandler } from '../handlers/checklist-handler';
import { ParentLinkHandler } from '../handlers/parent-link-handler';
import { buildParentLinkValue, linkValueMatchesFile, extractLinkTarget, resolveLinkValueToFile } from '../handlers/parent-link-format';
import {
    casefold,
    deleteValueCaseInsensitive,
    findKeyCaseInsensitive,
    mutateFrontmatterTagFields,
    removeInlineTagsSafely,
    runInBatches,
    setValueCaseInsensitive,
    showNotice,
} from '../core';

export class BulkEditService {
    plugin: TPSGlobalContextMenuPlugin;
    private recurrenceCreationInProgress: Set<string> = new Set();
    private checkMissingRecurrencesRunning = false;
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

    private getDailyNoteDateFormat(): string {
        try {
            const periodicNotes = (this.plugin.app as any)?.plugins?.getPlugin?.("periodic-notes");
            const periodicFormat = periodicNotes?.settings?.daily?.format;
            if (typeof periodicFormat === "string" && periodicFormat.trim()) {
                return periodicFormat.trim();
            }
            const dailyNotes = (this.plugin.app as any)?.internalPlugins?.getPluginById?.("daily-notes");
            const coreFormat = dailyNotes?.instance?.options?.format;
            if (typeof coreFormat === "string" && coreFormat.trim()) {
                return coreFormat.trim();
            }
        } catch {
            // ignore
        }
        return "YYYY-MM-DD";
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

    private buildRecurrenceTemplateLink(templateFile: TFile, instanceFile: TFile, seriesBaseName: string): string {
        try {
            const linktext = this.plugin.app.metadataCache.fileToLinktext(templateFile, instanceFile.path, true);
            if (linktext && linktext.trim()) {
                return `[[${linktext}]]`;
            }
        } catch {
            // Fall back below
        }
        return `[[${seriesBaseName}]]`;
    }

    private frontmatterReferencesSeriesTemplate(frontmatter: any, seriesName: string, templateFile?: TFile | null): boolean {
        if (!frontmatter) return false;
        const rawLink = String(frontmatter.recurrenceTemplate ?? frontmatter.recurrencetemplate ?? '').trim();
        if (!rawLink) return false;

        const normalizedSeries = String(seriesName || '').trim().toLowerCase();
        const target = extractLinkTarget(rawLink).toLowerCase();
        const templatePath = templateFile?.path ? normalizePath(templateFile.path).toLowerCase() : '';

        if (templatePath && (target === templatePath || target.endsWith(`/${templatePath.split('/').pop()}`))) {
            return true;
        }

        if (!target) {
            return rawLink.toLowerCase().includes(`[[${normalizedSeries}]]`);
        }

        const targetBase = target.split('/').pop()?.replace(/\.md$/i, '') || '';
        return targetBase === normalizedSeries;
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
            await this.normalizeLeadingWhitespaceBeforeFrontmatter(file);
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

        await this.normalizeLeadingWhitespaceBeforeFrontmatter(file);
        const issue = await this.getUnsafeFrontmatterIssue(file);
        if (!issue) {
            return true;
        }

        if (!this.malformedFrontmatterWarnedPaths.has(file.path)) {
            this.malformedFrontmatterWarnedPaths.add(file.path);
            const message = issue === 'frontmatter-not-at-top'
                ? `Skipped frontmatter update for "${file.basename}" (frontmatter is not at the top of the note).`
                : `Skipped frontmatter update for "${file.basename}" (duplicate YAML blocks detected).`;
            new Notice(message);
            logger.warn('[TPS GCM] Skipping frontmatter mutation: unsafe frontmatter structure detected', {
                file: file.path,
                issue,
            });
        }
        return false;
    }

    private async getUnsafeFrontmatterIssue(file: TFile): Promise<'frontmatter-not-at-top' | 'duplicate-frontmatter' | null> {
        let content = '';
        try {
            content = await this.plugin.app.vault.cachedRead(file);
        } catch (error) {
            logger.warn('[TPS GCM] Failed reading file for frontmatter safety check', { file: file.path, error });
            return null;
        }

        if (!content) return null;
        const normalized = content.replace(/\r\n/g, '\n');
        const bomOffset = normalized.startsWith('\uFEFF') ? 1 : 0;
        const body = normalized.slice(bomOffset);

        const trimmedLeading = body.replace(/^\s*/, '');
        const leadingOffset = body.length - trimmedLeading.length;
        const leadingWhitespaceOnly = leadingOffset > 0 && !/\S/.test(body.slice(0, leadingOffset));
        const frontmatterCandidate = body.startsWith('---\n')
            ? body
            : leadingWhitespaceOnly && trimmedLeading.startsWith('---\n')
                ? trimmedLeading
                : null;

        if (frontmatterCandidate) {
            const firstBlock = this.findFrontmatterBlock(frontmatterCandidate, 0);
            if (!firstBlock) return null;

            const trimmedAfterFirst = frontmatterCandidate.slice(firstBlock.end).replace(/^\s*/, '');
            if (!trimmedAfterFirst.startsWith('---\n')) return null;

            const secondBlock = this.findFrontmatterBlock(trimmedAfterFirst, 0);
            if (secondBlock && this.looksLikeYamlFrontmatter(secondBlock.body)) {
                return 'duplicate-frontmatter';
            }

            return null;
        }

        if (trimmedLeading.startsWith('---\n')) {
            const nestedBlock = this.findFrontmatterBlock(body, leadingOffset);
            if (nestedBlock && this.looksLikeYamlFrontmatter(nestedBlock.body)) {
                return 'frontmatter-not-at-top';
            }
        }

        return null;
    }

    private async normalizeLeadingWhitespaceBeforeFrontmatter(file: TFile): Promise<void> {
        let content = '';
        try {
            content = await this.plugin.app.vault.cachedRead(file);
        } catch {
            return;
        }

        if (!content) return;

        const normalized = content.replace(/\r\n/g, '\n');
        const bom = normalized.startsWith('\uFEFF') ? '\uFEFF' : '';
        const body = bom ? normalized.slice(1) : normalized;
        if (body.startsWith('---\n')) return;

        const trimmedLeading = body.replace(/^\s*/, '');
        const leadingOffset = body.length - trimmedLeading.length;
        if (leadingOffset <= 0 || !trimmedLeading.startsWith('---\n')) return;

        const prefix = body.slice(0, leadingOffset);
        if (/\S/.test(prefix)) return;

        const liveFile = this.plugin.app.vault.getAbstractFileByPath(file.path);
        if (!(liveFile instanceof TFile)) return;

        await this.plugin.app.vault.modify(liveFile, `${bom}${trimmedLeading}`);
    }

    private findFrontmatterBlock(content: string, startIndex: number): { body: string; end: number } | null {
        if (!content.startsWith('---\n', startIndex)) {
            return null;
        }

        const closeIndex = content.indexOf('\n---\n', startIndex + 4);
        if (closeIndex === -1) {
            return null;
        }

        return {
            body: content.slice(startIndex + 4, closeIndex),
            end: closeIndex + '\n---\n'.length,
        };
    }

    private looksLikeYamlFrontmatter(body: string): boolean {
        return body
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .some((line) => /^[A-Za-z0-9_"'.-]+\s*:/.test(line));
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

        // Log the operation for debugging
        const _updateKeys = Object.keys(updates);
        const _fileLabel = files.length <= 3
            ? files.map(f => f.basename).join(', ')
            : `${files[0].basename}… (+${files.length - 1} more)`;
        logger.log(`[BulkEditService] updateFrontmatter ×${files.length}: [${_updateKeys.join(', ')}] on: ${_fileLabel}`);
        if (updates.status !== undefined) {
            logger.log(`[BulkEditService] Status change → "${updates.status}" on: ${_fileLabel}`);
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

        if (hasStatusUpdate) {
            if (targetStatus === 'complete') {
                updates.completedDate = window.moment().format('YYYY-MM-DD HH:mm:ss');
            } else if (targetStatus === 'open' || targetStatus === 'working' || targetStatus === 'blocked') {
                updates.completedDate = null;
            }
        }

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

        return this.updateFrontmatter(files, { status });
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

    async setRecurrence(files: TFile[], rule: string | null, endsOn?: string | null): Promise<number> {
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

            // Copy files to recurring template folder (creates template on first set)
            await this.ensureRecurrenceTemplate(files);
        }

        return count;
    }

    /**
     * Copies recurring event files to the recurring template folder the first time
     * a recurrence rule is set on them, if the folder is configured. The template
     * is a permanent reference copy with `isRecurrenceTemplate: true` in its frontmatter.
     * Instance files gain a `recurrenceTemplate` link pointing to the template.
     */
    async ensureRecurrenceTemplate(files: TFile[]): Promise<void> {
        const templateFolder = (this.plugin.settings.recurringTemplateFolder || '').trim();
        if (!templateFolder) return;

        for (const file of files) {
            try {
                const cache = this.plugin.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;
                // Skip if this is already a template
                if (fm?.isRecurrenceTemplate) continue;

                // Build destination path — template is named after the series (date suffix stripped)
                // so all instances of the same recurring event share one template.
                const seriesBaseName = stripDateSuffix(file.basename).trim();
                const destFolderPath = normalizePath(templateFolder);
                const destFilePath = normalizePath(`${destFolderPath}/${seriesBaseName}.md`);

                // Create folder if needed
                const folderExists = await this.plugin.app.vault.adapter.exists(destFolderPath);
                if (!folderExists) {
                    await this.plugin.app.vault.createFolder(destFolderPath);
                }

                // Skip if template already exists
                const templateExists = await this.plugin.app.vault.adapter.exists(destFilePath);
                if (templateExists) {
                    const existingTemplate = this.plugin.app.vault.getAbstractFileByPath(destFilePath);
                    // Just ensure the instance links to the series template if not already
                    if (fm && existingTemplate instanceof TFile && !this.frontmatterReferencesSeriesTemplate(fm, seriesBaseName, existingTemplate)) {
                        if (await this.canMutateFrontmatterSafely(file)) {
                            await this.runSerializedFrontmatterWrite(file, async () => {
                                await this.plugin.app.fileManager.processFrontMatter(file, (fmw) => {
                                    this.setFrontmatterValueCaseInsensitive(
                                        fmw,
                                        'recurrenceTemplate',
                                        this.buildRecurrenceTemplateLink(existingTemplate, file, seriesBaseName),
                                    );
                                });
                            });
                        }
                    }
                    continue;
                }

                // Copy file content to template location
                const content = await this.plugin.app.vault.read(file);
                await this.plugin.app.vault.create(destFilePath, content);

                const templateFile = this.plugin.app.vault.getAbstractFileByPath(destFilePath);
                if (!(templateFile instanceof TFile)) continue;

                // Mark the template copy — strip all instance-specific fields so it
                // represents a clean "blueprint" for every future instance in this series.
                await this.plugin.app.fileManager.processFrontMatter(templateFile, (fmw) => {
                    this.setFrontmatterValueCaseInsensitive(fmw, 'isRecurrenceTemplate', true);
                    // Remove fields that belong to a specific instance, not the series
                    this.deleteFrontmatterValueCaseInsensitive(fmw, 'scheduled');
                    this.deleteFrontmatterValueCaseInsensitive(fmw, 'status');
                    this.deleteFrontmatterValueCaseInsensitive(fmw, 'completedDate');
                    this.deleteFrontmatterValueCaseInsensitive(fmw, 'recurrenceTemplate'); // template doesn't link to itself
                    // Strip Companion display properties — recalculated fresh for each instance
                    for (const key of Object.keys(fmw)) {
                        if (['sort', 'hidden', 'icon', 'color'].includes(key.toLowerCase())) {
                            delete fmw[key];
                        }
                    }
                    // Explicitly store the recurrence rule — the copied content may not yet be
                    // flushed to disk when vault.read runs, so read it from the metadata cache.
                    const rule = fm?.recurrenceRule || fm?.recurrence;
                    if (rule) {
                        this.setFrontmatterValueCaseInsensitive(fmw, 'recurrenceRule', rule);
                        this.deleteFrontmatterValueCaseInsensitive(fmw, 'recurrence');
                    }
                });

                // Add back-link from instance to the series template
                if (await this.canMutateFrontmatterSafely(file)) {
                    await this.runSerializedFrontmatterWrite(file, async () => {
                        await this.plugin.app.fileManager.processFrontMatter(file, (fmw) => {
                            this.setFrontmatterValueCaseInsensitive(
                                fmw,
                                'recurrenceTemplate',
                                this.buildRecurrenceTemplateLink(templateFile, file, seriesBaseName),
                            );
                        });
                    });
                }

                logger.log(`[TPS GCM] Created series template for ${file.path} at ${destFilePath}`);
                new Notice(`Recurring series template created: ${seriesBaseName}.md`);
            } catch (err) {
                logger.error(`[TPS GCM] Failed to create recurring template for ${file.path}:`, err);
            }
        }
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
            // Use moment to parse so date-only strings (e.g. "2026-03-02") are
            // interpreted as local midnight rather than UTC midnight. Without this,
            // in timezones behind UTC the "next" occurrence can fall on the same
            // local calendar day as the seed date.
            const startDate = currentDate
                ? window.moment(currentDate).toDate()
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

    private isFileInRecurrenceTemplateFolder(file: TFile): boolean {
        const templateFolder = normalizePath((this.plugin.settings.recurringTemplateFolder || '').trim());
        if (!templateFolder) return false;
        const filePath = normalizePath(file.path);
        return filePath === templateFolder || filePath.startsWith(`${templateFolder}/`);
    }

    private getFirstOccurrenceFromToday(recurrenceRule: string): Date | null {
        try {
            const todayStart = window.moment().startOf('day').toDate();
            const options = RRule.parseString(recurrenceRule);
            options.dtstart = todayStart;
            const rule = new RRule(options);
            return rule.after(todayStart, true);
        } catch (error) {
            logger.error('[TPS GCM] Failed to calculate first occurrence from today:', error);
            return null;
        }
    }

    private async bootstrapTemplateInstanceFromToday(templateFile: TFile, frontmatter: any): Promise<boolean> {
        const recurrenceRule = frontmatter?.recurrenceRule || frontmatter?.recurrence;
        if (!recurrenceRule) return false;

        const seriesBaseName = stripDateSuffix(templateFile.basename).trim();
        if (!seriesBaseName) return false;

        const existingInstances = this.plugin.app.vault.getMarkdownFiles().filter((candidate) => {
            if (candidate.path === templateFile.path) return false;
            const cache = this.plugin.app.metadataCache.getFileCache(candidate);
            const fm = cache?.frontmatter;
            if (!fm || fm.isRecurrenceTemplate) return false;
            return this.frontmatterReferencesSeriesTemplate(fm, seriesBaseName, templateFile);
        });

        if (existingInstances.length > 0) {
            return false;
        }

        const firstOccurrence = this.getFirstOccurrenceFromToday(recurrenceRule);
        if (!firstOccurrence) return false;

        const dateStr = window.moment(firstOccurrence).format(this.getDailyNoteDateFormat());
        const newFileName = `${seriesBaseName} ${dateStr}.md`;
        const parentPath = templateFile.parent?.path || '';
        const newFilePath = normalizePath(parentPath ? `${parentPath}/${newFileName}` : newFileName);

        const exists = this.plugin.app.vault.getAbstractFileByPath(newFilePath);
        if (exists instanceof TFile) {
            return false;
        }

        const content = await this.plugin.app.vault.read(templateFile);
        const created = await this.plugin.app.vault.create(newFilePath, content);
        if (!(created instanceof TFile)) return false;

        const scheduled = window.moment(firstOccurrence).format('YYYY-MM-DD HH:mm:ss');
        await this.plugin.app.fileManager.processFrontMatter(created, (fmw) => {
            this.setFrontmatterValueCaseInsensitive(fmw, 'scheduled', scheduled);
            this.setFrontmatterValueCaseInsensitive(
                fmw,
                'recurrenceTemplate',
                this.buildRecurrenceTemplateLink(templateFile, created, seriesBaseName),
            );
            this.deleteFrontmatterValueCaseInsensitive(fmw, 'isRecurrenceTemplate');
            this.deleteFrontmatterValueCaseInsensitive(fmw, 'completedDate');
            this.deleteFrontmatterValueCaseInsensitive(fmw, 'status');
        });

        logger.log(`[TPS GCM] Bootstrapped recurring series from template ${templateFile.path} -> ${created.path}`);
        return true;
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

            // Prefer the series template as the content source so each new instance
            // starts from a clean blueprint rather than cloning the completing file.
            const recurrenceTemplateFolderSetting = (this.plugin.settings.recurringTemplateFolder || '').trim();
            let contentSource: TFile = file;
            let seriesTemplateFile: TFile | null = null;
            if (recurrenceTemplateFolderSetting) {
                const templatePath = normalizePath(`${recurrenceTemplateFolderSetting}/${baseName}.md`);
                const existingTemplate = this.plugin.app.vault.getAbstractFileByPath(templatePath);
                if (existingTemplate instanceof TFile) {
                    seriesTemplateFile = existingTemplate;
                    contentSource = seriesTemplateFile;
                    logger.log('[TPS GCM] Using series template for next recurrence instance:', templatePath);
                } else {
                    logger.log('[TPS GCM] No series template found at', templatePath, '— creating/relinking template now');
                    await this.ensureRecurrenceTemplate([file]);
                    const createdTemplate = this.plugin.app.vault.getAbstractFileByPath(templatePath);
                    if (createdTemplate instanceof TFile) {
                        seriesTemplateFile = createdTemplate;
                        contentSource = seriesTemplateFile;
                    } else {
                        logger.log('[TPS GCM] Template still missing after ensureRecurrenceTemplate, cloning completing instance instead');
                    }
                }
            }

            const dateStr = window.moment(nextDate).format(this.getDailyNoteDateFormat());
            const newFileName = `${baseName} ${dateStr}.md`;
            const newFilePath = file.parent ? `${file.parent.path}/${newFileName}` : newFileName;
            const chainId = this.resolveRecurrenceChainId(file, frontmatter, recurrenceRule);
            const newScheduled = window.moment(nextDate).format('YYYY-MM-DD HH:mm:ss');
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

            const content = await this.plugin.app.vault.read(contentSource);
            const newFile = await this.plugin.app.vault.create(newFilePath, content);

            if (!(newFile instanceof TFile)) {
                logger.error('[TPS GCM] Could not get newly created file');
                return false;
            }

            // Only use a configured default status — never fall back to a hardcoded value.
            // If the setting is empty the new instance inherits whatever the template had
            // (or nothing, if the template has no status field).
            const newStatus = (this.plugin.settings.recurrenceDefaultStatus || '').trim();

            // Validate inputs before writing to frontmatter
            if (!newScheduled || typeof newScheduled !== 'string') {
                throw new Error(`Invalid scheduled value: ${newScheduled}`);
            }
            if (!baseName || typeof baseName !== 'string' || baseName.length > 255) {
                throw new Error(`Invalid title value: ${baseName}`);
            }

            await this.plugin.app.fileManager.processFrontMatter(newFile, (fm) => {
                this.setFrontmatterValueCaseInsensitive(fm, 'scheduled', newScheduled);
                // Only write status if a default was explicitly configured
                if (newStatus) {
                    this.setFrontmatterValueCaseInsensitive(fm, 'status', newStatus);
                } else {
                    // Ensure no stale status is inherited from the template file content
                    this.deleteFrontmatterValueCaseInsensitive(fm, 'status');
                }

                // Restore the recurrenceTemplate back-link (may be absent if content
                // was read from the series template which intentionally omits it).
                if (recurrenceTemplateFolderSetting && seriesTemplateFile instanceof TFile) {
                    this.setFrontmatterValueCaseInsensitive(
                        fm,
                        'recurrenceTemplate',
                        this.buildRecurrenceTemplateLink(seriesTemplateFile, newFile, baseName),
                    );
                }

                // Strip all stale/computed fields so the new instance starts clean.
                for (const key of Object.keys(fm)) {
                    if (['sort', 'hidden', 'icon', 'color', 'isrecurrencetemplate', 'completeddate'].includes(key.toLowerCase())) {
                        delete fm[key];
                    }
                }
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
                const newScheduled = window.moment(nextDate).format('YYYY-MM-DD HH:mm:ss');
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

    /**
     * Propagate changes from an edited series template to all open (non-completed)
     * instances that reference it via `recurrenceTemplate: [[SeriesName]]`.
     *
     * Only fields that belong to the series (not the individual instance) are copied.
     * Instance-specific fields such as scheduled, status, completedDate, sort, icon,
     * color, dateCreated, dateModified, and the template meta-fields are never touched.
     */
    async applyTemplateToOpenInstances(templateFile: TFile): Promise<number> {
        const templateCache = this.plugin.app.metadataCache.getFileCache(templateFile);
        const templateFm = templateCache?.frontmatter;
        if (!templateFm) return 0;

        const seriesName = templateFile.basename.toLowerCase();

        // Fields that must NEVER be copied from the template to instances
        const SKIP_KEYS = new Set([
            'isrecurrencetemplate', 'recurrencestarted', 'recurrenceends',
            'recurrencetemplate', 'scheduled', 'status', 'completeddate',
            'sort', 'icon', 'color', 'hidden', 'datecreated', 'datemodified',
        ]);

        // Build propagatable update set from the template's frontmatter
        const updates: Record<string, any> = {};
        for (const [key, value] of Object.entries(templateFm)) {
            if (!SKIP_KEYS.has(key.toLowerCase())) {
                updates[key] = value;
            }
        }
        if (Object.keys(updates).length === 0) return 0;

        // Completion statuses — instances in these states are skipped
        const completionSet = new Set(
            (this.plugin.settings.recurrenceCompletionStatuses?.length
                ? this.plugin.settings.recurrenceCompletionStatuses
                : ['complete', 'wont-do']
            ).map((s: string) => s.trim().toLowerCase())
        );

        // Find all open instances that reference this series template
        const openInstances: TFile[] = [];
        for (const file of this.plugin.app.vault.getMarkdownFiles()) {
            if (file.path === templateFile.path) continue;

            const cache = this.plugin.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter;
            if (!fm) continue;

            // Check recurrenceTemplate link — value may be wikilink format [[Name]]
            if (!this.frontmatterReferencesSeriesTemplate(fm, seriesName, templateFile)) continue;

            // Skip completed/wont-do instances
            const status = String(fm.status ?? '').trim().toLowerCase();
            if (completionSet.has(status)) continue;

            openInstances.push(file);
        }

        if (openInstances.length === 0) return 0;

        return this.applyToFiles(openInstances, (fm) => {
            for (const [key, value] of Object.entries(updates)) {
                if (value === null || value === undefined) {
                    this.deleteFrontmatterValueCaseInsensitive(fm, key);
                } else {
                    this.setFrontmatterValueCaseInsensitive(fm, key, value);
                }
            }
        });
    }

    async checkMissingRecurrences(): Promise<void> {
        if (this.checkMissingRecurrencesRunning) return;
        if (!this.plugin.settings.enableRecurrence) return;

        this.checkMissingRecurrencesRunning = true;
        try {
            const files = this.plugin.app.vault.getMarkdownFiles();
            let createdCount = 0;

            const recurrenceStatuses = (this.plugin.settings.recurrenceCompletionStatuses?.length
                ? this.plugin.settings.recurrenceCompletionStatuses
                : ['complete', 'wont-do']
            ).map((s: string) => s.trim().toLowerCase());

            // Collect active recurring notes that are missing a series template
            const needsTemplate: TFile[] = [];
            const needsRelink: Array<{ file: TFile; templateFile: TFile; seriesBaseName: string }> = [];

            for (const file of files) {
                const cache = this.plugin.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;

                if (!fm) continue;

                const hasRule = fm.recurrenceRule || fm.recurrence;
                if (!hasRule) continue;

                if (this.isFileInRecurrenceTemplateFolder(file)) {
                    if (!fm.isRecurrenceTemplate) {
                        if (await this.canMutateFrontmatterSafely(file)) {
                            await this.runSerializedFrontmatterWrite(file, async () => {
                                await this.plugin.app.fileManager.processFrontMatter(file, (fmw) => {
                                    this.setFrontmatterValueCaseInsensitive(fmw, 'isRecurrenceTemplate', true);
                                    this.deleteFrontmatterValueCaseInsensitive(fmw, 'scheduled');
                                    this.deleteFrontmatterValueCaseInsensitive(fmw, 'status');
                                    this.deleteFrontmatterValueCaseInsensitive(fmw, 'completedDate');
                                    this.deleteFrontmatterValueCaseInsensitive(fmw, 'recurrenceTemplate');
                                });
                            });
                        }
                    }
                    const bootstrapped = await this.bootstrapTemplateInstanceFromToday(file, fm);
                    if (bootstrapped) {
                        createdCount++;
                    }
                    continue;
                }

                // Skip template files themselves
                if (fm.isRecurrenceTemplate) continue;

                const isCompleted = recurrenceStatuses.includes(
                    String(fm.status ?? '').trim().toLowerCase()
                );

                if (isCompleted) {
                    const handled = await this.createNextRecurrenceInstance(file, fm);
                    if (handled) {
                        createdCount++;
                    }
                } else {
                    // Active instance — check if its series template is missing
                    const templateFolderSetting = (this.plugin.settings.recurringTemplateFolder || '').trim();
                    if (templateFolderSetting) {
                        const seriesBaseName = stripDateSuffix(file.basename).trim();
                        const templatePath = normalizePath(`${templateFolderSetting}/${seriesBaseName}.md`);
                        const templateEntry = this.plugin.app.vault.getAbstractFileByPath(templatePath);
                        if (!(templateEntry instanceof TFile)) {
                            needsTemplate.push(file);
                        } else if (!this.frontmatterReferencesSeriesTemplate(fm, seriesBaseName, templateEntry)) {
                            needsRelink.push({ file, templateFile: templateEntry, seriesBaseName });
                        }
                    }
                }
            }

            if (createdCount > 0) {
                logger.log(`[TPS GCM] Healed ${createdCount} recurring event chains.`);
            }

            // Create any missing series templates (deduped by series name)
            if (needsTemplate.length > 0) {
                const seen = new Set<string>();
                const deduped = needsTemplate.filter(f => {
                    const key = stripDateSuffix(f.basename).trim().toLowerCase();
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });
                await this.ensureRecurrenceTemplate(deduped);
                logger.log(`[TPS GCM] Created ${deduped.length} missing series template(s).`);
            }

            if (needsRelink.length > 0) {
                for (const row of needsRelink) {
                    const { file, templateFile, seriesBaseName } = row;
                    if (!(await this.canMutateFrontmatterSafely(file))) continue;
                    await this.runSerializedFrontmatterWrite(file, async () => {
                        await this.plugin.app.fileManager.processFrontMatter(file, (fmw) => {
                            this.setFrontmatterValueCaseInsensitive(
                                fmw,
                                'recurrenceTemplate',
                                this.buildRecurrenceTemplateLink(templateFile, file, seriesBaseName),
                            );
                        });
                    });
                }
                logger.log(`[TPS GCM] Relinked ${needsRelink.length} recurrence instance(s) to series templates.`);
            }
        } finally {
            this.checkMissingRecurrencesRunning = false;
        }
    }

    async clearRecurrenceRule(file: TFile): Promise<void> {
        if (!(await this.canMutateFrontmatterSafely(file))) return;
        await this.runSerializedFrontmatterWrite(file, async () => {
            await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
                this.deleteFrontmatterValueCaseInsensitive(fm, 'recurrenceRule');
                this.deleteFrontmatterValueCaseInsensitive(fm, 'recurrence');
            });
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
        const childKey = this.parentLinkHandler.normalizeChildKey();
        const format = this.parentLinkHandler.normalizeParentLinkFormat();
        const previousParentsByChild = new Map<string, TFile[]>();
        for (const file of files) {
            const raw = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
            const key = raw ? this.findFrontmatterKeyCaseInsensitive(raw as Record<string, any>, parentKey) : null;
            const parentValue = key && raw ? (raw as Record<string, any>)[key] : undefined;
            previousParentsByChild.set(file.path, this.resolveLinkedFilesFromFrontmatterValue(parentValue, file.path));
        }

        const count = await this.applyToFiles(files, (fm, file) => {
            const parentLink = buildParentLinkValue(this.plugin.app, parentFile, file.path, format);
            this.setFrontmatterValueCaseInsensitive(fm, parentKey, parentLink);
            if (this.plugin.settings.autoSaveFolderPath) {
                this.setFrontmatterValueCaseInsensitive(fm, 'folderPath', file.parent?.path || '/');
            }
        });
        if (count > 0) {
            // Write reverse childKey into parentFile listing child links
            if (await this.canMutateFrontmatterSafely(parentFile)) {
                await this.runSerializedFrontmatterWrite(parentFile, async () => {
                    await this.plugin.app.fileManager.processFrontMatter(parentFile, (fm) => {
                        const existingKey = this.findFrontmatterKeyCaseInsensitive(fm, childKey);
                        const existingRaw = existingKey ? fm[existingKey] : undefined;
                        let children: string[] = [];
                        if (Array.isArray(existingRaw)) {
                            children = existingRaw.map(String);
                        } else if (typeof existingRaw === 'string' && existingRaw.trim()) {
                            children = [existingRaw];
                        }
                        for (const file of files) {
                            const childLink = buildParentLinkValue(this.plugin.app, file, parentFile.path, format);
                            const linkLower = childLink.toLowerCase();
                            if (!children.some((l) => l.toLowerCase() === linkLower)) {
                                children.push(childLink);
                            }
                        }
                        this.setFrontmatterValueCaseInsensitive(fm, childKey, children);
                    });
                });
            }
            await this.ensureParentSelfLink(parentFile, parentKey, format);
            const updatedOldParents: TFile[] = [];
            for (const file of files) {
                const previousParents = previousParentsByChild.get(file.path) || [];
                for (const previousParent of previousParents) {
                    if (previousParent.path === parentFile.path) continue;
                    const changed = await this.removeChildFromParentReverseList(previousParent, file, childKey);
                    if (changed) updatedOldParents.push(previousParent);
                }
            }
            await this.tagParentsForLinkedChildren([parentFile]);
            void this.plugin.viewModeManager?.handlePotentialFrontmatterChange(files, [parentKey]);
            void this.plugin.viewModeManager?.handlePotentialFrontmatterChange([parentFile], [childKey, parentKey]);
            if (updatedOldParents.length > 0) {
                const unique = Array.from(new Map(updatedOldParents.map((f) => [f.path, f])).values());
                setTimeout(() => unique.forEach((file) => this.plugin.persistentMenuManager?.refreshMenusForFile(file)), 200);
                this.notifyFilesChanged(unique);
                void this.plugin.viewModeManager?.handlePotentialFrontmatterChange(unique, [childKey]);
            }
        }
        return count;
    }

    async linkChildren(currentFile: TFile, childFiles: TFile[]): Promise<number> {
        const parentKey = this.parentLinkHandler.normalizeParentKey();
        const childKey = this.parentLinkHandler.normalizeChildKey();
        const format = this.parentLinkHandler.normalizeParentLinkFormat();
        const previousParentsByChild = new Map<string, TFile[]>();
        for (const file of childFiles) {
            const raw = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
            const key = raw ? this.findFrontmatterKeyCaseInsensitive(raw as Record<string, any>, parentKey) : null;
            const parentValue = key && raw ? (raw as Record<string, any>)[key] : undefined;
            previousParentsByChild.set(file.path, this.resolveLinkedFilesFromFrontmatterValue(parentValue, file.path));
        }

        const count = await this.applyToFiles(childFiles, (fm, file) => {
            const parentLink = buildParentLinkValue(this.plugin.app, currentFile, file.path, format);
            this.setFrontmatterValueCaseInsensitive(fm, parentKey, parentLink);
            if (this.plugin.settings.autoSaveFolderPath) {
                this.setFrontmatterValueCaseInsensitive(fm, 'folderPath', file.parent?.path || '/');
            }
        });
        if (count > 0) {
            // Write reverse childKey into currentFile listing child links
            if (await this.canMutateFrontmatterSafely(currentFile)) {
                await this.runSerializedFrontmatterWrite(currentFile, async () => {
                    await this.plugin.app.fileManager.processFrontMatter(currentFile, (fm) => {
                        const existingKey = this.findFrontmatterKeyCaseInsensitive(fm, childKey);
                        const existingRaw = existingKey ? fm[existingKey] : undefined;
                        let children: string[] = [];
                        if (Array.isArray(existingRaw)) {
                            children = existingRaw.map(String);
                        } else if (typeof existingRaw === 'string' && existingRaw.trim()) {
                            children = [existingRaw];
                        }
                        for (const file of childFiles) {
                            const childLink = buildParentLinkValue(this.plugin.app, file, currentFile.path, format);
                            const linkLower = childLink.toLowerCase();
                            if (!children.some((l) => l.toLowerCase() === linkLower)) {
                                children.push(childLink);
                            }
                        }
                        this.setFrontmatterValueCaseInsensitive(fm, childKey, children);
                    });
                });
            }
            await this.ensureParentSelfLink(currentFile, parentKey, format);
            const updatedOldParents: TFile[] = [];
            for (const file of childFiles) {
                const previousParents = previousParentsByChild.get(file.path) || [];
                for (const previousParent of previousParents) {
                    if (previousParent.path === currentFile.path) continue;
                    const changed = await this.removeChildFromParentReverseList(previousParent, file, childKey);
                    if (changed) updatedOldParents.push(previousParent);
                }
            }
            await this.tagParentsForLinkedChildren([currentFile]);
            void this.plugin.viewModeManager?.handlePotentialFrontmatterChange(childFiles, [parentKey]);
            void this.plugin.viewModeManager?.handlePotentialFrontmatterChange([currentFile], [childKey, parentKey]);
            if (updatedOldParents.length > 0) {
                const unique = Array.from(new Map(updatedOldParents.map((f) => [f.path, f])).values());
                setTimeout(() => unique.forEach((file) => this.plugin.persistentMenuManager?.refreshMenusForFile(file)), 200);
                this.notifyFilesChanged(unique);
                void this.plugin.viewModeManager?.handlePotentialFrontmatterChange(unique, [childKey]);
            }
        }
        return count;
    }

    async reconcileParentChildLinksForParent(parentFile: TFile): Promise<number> {
        if (!(parentFile instanceof TFile)) return 0;
        if (parentFile.extension?.toLowerCase() !== 'md') return 0;

        const parentKey = this.parentLinkHandler.normalizeParentKey();
        const childKey = this.parentLinkHandler.normalizeChildKey();
        const format = this.parentLinkHandler.normalizeParentLinkFormat();

        const allMarkdownFiles = this.plugin.app.vault.getMarkdownFiles();
        const parentListedChildren: TFile[] = (() => {
            const parentFm = (this.plugin.app.metadataCache.getFileCache(parentFile)?.frontmatter || {}) as Record<string, any>;
            const raw = this.findFrontmatterKeyCaseInsensitive(parentFm, childKey)
                ? parentFm[this.findFrontmatterKeyCaseInsensitive(parentFm, childKey)!]
                : undefined;
            return this.resolveLinkedFilesFromFrontmatterValue(raw, parentFile.path);
        })();

        const childrenNeedingParentLink: TFile[] = [];
        const validatedParentChildren = new Map<string, TFile>();

        for (const child of parentListedChildren) {
            if (child.path === parentFile.path) continue;
            const childFm = (this.plugin.app.metadataCache.getFileCache(child)?.frontmatter || {}) as Record<string, any>;
            const parentValueKey = this.findFrontmatterKeyCaseInsensitive(childFm, parentKey);
            const parentRaw = parentValueKey ? childFm[parentValueKey] : undefined;
            const childParents = this.resolveLinkedFilesFromFrontmatterValue(parentRaw, child.path);
            const hasParent = childParents.some((candidate) => candidate.path === parentFile.path);

            if (hasParent) {
                validatedParentChildren.set(child.path, child);
                continue;
            }

            // If a child is listed in parentOf but has no explicit parent, restore the missing childOf link.
            if (childParents.length === 0) {
                childrenNeedingParentLink.push(child);
                validatedParentChildren.set(child.path, child);
            }
        }

        let changes = 0;
        if (childrenNeedingParentLink.length > 0) {
            const updated = await this.applyToFiles(childrenNeedingParentLink, (fm, file) => {
                const parentLink = buildParentLinkValue(this.plugin.app, parentFile, file.path, format);
                this.setFrontmatterValueCaseInsensitive(fm, parentKey, parentLink);
                if (this.plugin.settings.autoSaveFolderPath) {
                    this.setFrontmatterValueCaseInsensitive(fm, 'folderPath', file.parent?.path || '/');
                }
            });
            changes += updated;
        }

        // Ensure reverse list includes all children that explicitly link to this parent.
        for (const candidate of allMarkdownFiles) {
            if (candidate.path === parentFile.path) continue;
            const fm = (this.plugin.app.metadataCache.getFileCache(candidate)?.frontmatter || {}) as Record<string, any>;
            const parentValueKey = this.findFrontmatterKeyCaseInsensitive(fm, parentKey);
            const parentRaw = parentValueKey ? fm[parentValueKey] : undefined;
            const parents = this.resolveLinkedFilesFromFrontmatterValue(parentRaw, candidate.path);
            if (parents.some((entry) => entry.path === parentFile.path)) {
                validatedParentChildren.set(candidate.path, candidate);
            }
        }

        const finalChildren = Array.from(validatedParentChildren.values());
        if (await this.canMutateFrontmatterSafely(parentFile)) {
            let parentChanged = false;
            await this.runSerializedFrontmatterWrite(parentFile, async () => {
                await this.plugin.app.fileManager.processFrontMatter(parentFile, (fm) => {
                    const existingKey = this.findFrontmatterKeyCaseInsensitive(fm, childKey);
                    const existingRaw = existingKey ? fm[existingKey] : undefined;
                    const existingChildren = this.resolveLinkedFilesFromFrontmatterValue(existingRaw, parentFile.path);
                    const existingSet = new Set(existingChildren.map((child) => child.path));
                    const finalSet = new Set(finalChildren.map((child) => child.path));

                    let equivalent = existingSet.size === finalSet.size;
                    if (equivalent) {
                        for (const path of existingSet.values()) {
                            if (!finalSet.has(path)) {
                                equivalent = false;
                                break;
                            }
                        }
                    }
                    if (equivalent) return;

                    const childLinks = finalChildren.map((child) =>
                        buildParentLinkValue(this.plugin.app, child, parentFile.path, format),
                    );
                    if (childLinks.length > 0) {
                        this.setFrontmatterValueCaseInsensitive(fm, childKey, childLinks);
                    } else {
                        this.deleteFrontmatterValueCaseInsensitive(fm, childKey);
                    }
                    parentChanged = true;
                });
            });

            if (parentChanged) {
                changes += 1;
                setTimeout(() => this.plugin.persistentMenuManager?.refreshMenusForFile(parentFile), 200);
                this.notifyFilesChanged([parentFile]);
                void this.plugin.viewModeManager?.handlePotentialFrontmatterChange([parentFile], [childKey]);
            }
        }

        const selfLinkChanged = await this.ensureParentSelfLink(parentFile, parentKey, format);
        if (selfLinkChanged) {
            changes += 1;
            setTimeout(() => this.plugin.persistentMenuManager?.refreshMenusForFile(parentFile), 200);
            this.notifyFilesChanged([parentFile]);
            void this.plugin.viewModeManager?.handlePotentialFrontmatterChange([parentFile], [parentKey]);
        }

        if (changes > 0) {
            const uniqueParents = Array.from(new Map([[parentFile.path, parentFile]]).values());
            await this.tagParentsForLinkedChildren(uniqueParents);
        }

        return changes;
    }

    async ensureParentSelfLinkForParent(parentFile: TFile): Promise<boolean> {
        if (!(parentFile instanceof TFile) || parentFile.extension?.toLowerCase() !== 'md') {
            return false;
        }
        const parentKey = this.parentLinkHandler.normalizeParentKey();
        const format = this.parentLinkHandler.normalizeParentLinkFormat();
        const changed = await this.ensureParentSelfLink(parentFile, parentKey, format);
        if (!changed) {
            return false;
        }
        setTimeout(() => this.plugin.persistentMenuManager?.refreshMenusForFile(parentFile), 200);
        this.notifyFilesChanged([parentFile]);
        void this.plugin.viewModeManager?.handlePotentialFrontmatterChange([parentFile], [parentKey]);
        return true;
    }

    private async ensureParentSelfLink(
        parentFile: TFile,
        parentKey: string,
        format: 'wikilink' | 'markdown-title',
    ): Promise<boolean> {
        if (!this.plugin.settings.autoSelfLinkParentInParentKey) {
            return false;
        }
        if (!(await this.canMutateFrontmatterSafely(parentFile))) {
            return false;
        }
        let changed = false;
        await this.runSerializedFrontmatterWrite(parentFile, async () => {
            await this.plugin.app.fileManager.processFrontMatter(parentFile, (fm) => {
                const existingKey = this.findFrontmatterKeyCaseInsensitive(fm, parentKey);
                const existingRaw = existingKey ? fm[existingKey] : undefined;
                const currentValues: string[] = [];
                if (Array.isArray(existingRaw)) {
                    currentValues.push(...existingRaw.map(String).map((v) => v.trim()).filter(Boolean));
                } else if (existingRaw != null && String(existingRaw).trim()) {
                    currentValues.push(String(existingRaw).trim());
                }

                const selfLink = buildParentLinkValue(this.plugin.app, parentFile, parentFile.path, format);
                const hasSelf = currentValues.some((value) =>
                    linkValueMatchesFile(this.plugin.app, value, parentFile.path, parentFile),
                );
                if (hasSelf) {
                    return;
                }
                currentValues.push(selfLink);
                this.setFrontmatterValueCaseInsensitive(
                    fm,
                    parentKey,
                    currentValues.length === 1 ? currentValues[0] : currentValues,
                );
                changed = true;
            });
        });
        return changed;
    }

    private resolveLinkedFilesFromFrontmatterValue(value: unknown, sourcePath: string): TFile[] {
        const values = Array.isArray(value) ? value : (value != null ? [value] : []);
        const files: TFile[] = [];
        const seen = new Set<string>();
        for (const raw of values) {
            const file = resolveLinkValueToFile(this.plugin.app, raw, sourcePath);
            if (!(file instanceof TFile)) continue;
            if (seen.has(file.path)) continue;
            seen.add(file.path);
            files.push(file);
        }
        return files;
    }

    private async removeChildFromParentReverseList(parentFile: TFile, childFile: TFile, childKey: string): Promise<boolean> {
        if (!(await this.canMutateFrontmatterSafely(parentFile))) return false;
        let changed = false;
        await this.runSerializedFrontmatterWrite(parentFile, async () => {
            await this.plugin.app.fileManager.processFrontMatter(parentFile, (fm) => {
                const key = Object.keys(fm).find((k) => k.toLowerCase() === childKey.toLowerCase());
                if (!key) return;
                const raw = fm[key];
                const arr: any[] = Array.isArray(raw) ? raw : (raw != null ? [raw] : []);
                const filtered = arr.filter((v: any) => !linkValueMatchesFile(this.plugin.app, v, parentFile.path, childFile));
                if (filtered.length === arr.length) return;
                changed = true;
                if (filtered.length === 0) {
                    delete fm[key];
                } else {
                    fm[key] = filtered;
                }
            });
        });
        return changed;
    }

    async linkAttachments(currentFile: TFile, attachmentFiles: TFile[]): Promise<number> {
        if (!(await this.canMutateFrontmatterSafely(currentFile))) return 0;

        const ATTACHMENTS_KEY = 'attachments';
        const format = this.parentLinkHandler.normalizeParentLinkFormat();
        let added = 0;

        await this.runSerializedFrontmatterWrite(currentFile, async () => {
            this.plugin.recurrenceService?.markFileAsModified(currentFile.path);
            await this.plugin.app.fileManager.processFrontMatter(currentFile, (fm: any) => {
                const existingKey = this.findFrontmatterKeyCaseInsensitive(fm, ATTACHMENTS_KEY);
                const existingRaw = existingKey ? fm[existingKey] : undefined;
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
                    const link = buildParentLinkValue(this.plugin.app, file, currentFile.path, format);
                    pushValue(link);
                });

                added = values.length - startCount;
                if (added > 0) {
                    this.setFrontmatterValueCaseInsensitive(fm, ATTACHMENTS_KEY, values);
                }
            });
        });

        if (added > 0) {
            setTimeout(() => this.plugin.persistentMenuManager?.refreshMenusForFile(currentFile), 350);
            this.notifyFilesChanged([currentFile]);
            void this.plugin.viewModeManager?.handlePotentialFrontmatterChange([currentFile], [ATTACHMENTS_KEY]);
        }

        return added;
    }

    /**
     * Removes a frontmatter key+value from each of the given files.
     * The key match is case-insensitive so it works regardless of casing variation.
     */
    async removeFrontmatterKey(files: TFile[], key: string): Promise<number> {
        let count = 0;
        for (const file of files) {
            try {
                await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
                    const actualKey = Object.keys(fm).find(k => k.toLowerCase() === key.toLowerCase()) ?? key;
                    if (actualKey in fm) {
                        delete fm[actualKey];
                        count++;
                    }
                });
            } catch (err) {
                logger.warn(`[TPS GCM] removeFrontmatterKey failed for ${file.path}:`, err);
            }
        }
        return count;
    }

    /**
     * Removes the bidirectional parent↔child link between childFile and parentFile.
     * - Removes the selected parent reference from childFile's parent key (`childOf` by default)
     * - Removes childFile from the `parentOf` array in parentFile's frontmatter
     */
    async unlinkFromParent(childFile: TFile, parentFile: TFile): Promise<void> {
        const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'childOf').trim() || 'childOf';
        const childKey = String(this.plugin.settings.childLinkFrontmatterKey || 'parentOf').trim() || 'parentOf';
        const changedFiles: TFile[] = [];

        if (await this.canMutateFrontmatterSafely(childFile)) {
            let childChanged = false;
            await this.runSerializedFrontmatterWrite(childFile, async () => {
                await this.plugin.app.fileManager.processFrontMatter(childFile, (fm) => {
                    const key = Object.keys(fm).find((k) => k.toLowerCase() === parentKey.toLowerCase());
                    if (!key) return;
                    const raw = fm[key];
                    const arr: any[] = Array.isArray(raw) ? raw : (raw != null ? [raw] : []);
                    const filtered = arr.filter((v: any) => !linkValueMatchesFile(this.plugin.app, v, childFile.path, parentFile));
                    if (filtered.length === arr.length) return;
                    childChanged = true;
                    if (filtered.length === 0) {
                        delete fm[key];
                    } else if (filtered.length === 1) {
                        fm[key] = filtered[0];
                    } else {
                        fm[key] = filtered;
                    }
                });
            });
            if (childChanged) {
                changedFiles.push(childFile);
            }
        }

        if (await this.canMutateFrontmatterSafely(parentFile)) {
            let parentChanged = false;
            await this.runSerializedFrontmatterWrite(parentFile, async () => {
                await this.plugin.app.fileManager.processFrontMatter(parentFile, (fm) => {
                    const key = Object.keys(fm).find((k) => k.toLowerCase() === childKey.toLowerCase());
                    if (!key) return;
                    const raw = fm[key];
                    const arr: any[] = Array.isArray(raw) ? raw : (raw != null ? [raw] : []);
                    const filtered = arr.filter((v: any) => !linkValueMatchesFile(this.plugin.app, v, parentFile.path, childFile));
                    if (filtered.length === arr.length) return;
                    parentChanged = true;
                    if (filtered.length === 0) {
                        delete fm[key];
                    } else if (filtered.length === 1) {
                        fm[key] = filtered[0];
                    } else {
                        fm[key] = filtered;
                    }
                });
            });
            if (parentChanged) {
                changedFiles.push(parentFile);
            }
        }

        if (changedFiles.length > 0) {
            const unique = Array.from(new Map(changedFiles.map((file) => [file.path, file])).values());
            setTimeout(() => unique.forEach((file) => this.plugin.persistentMenuManager?.refreshMenusForFile(file)), 200);
            this.notifyFilesChanged(unique);
            void this.plugin.viewModeManager?.handlePotentialFrontmatterChange(unique, [parentKey, childKey]);
        }
    }

    async unlinkFromAllParents(childFile: TFile): Promise<number> {
        const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'childOf').trim() || 'childOf';
        const childKey = String(this.plugin.settings.childLinkFrontmatterKey || 'parentOf').trim() || 'parentOf';
        const cache = this.plugin.app.metadataCache.getFileCache(childFile);
        const fm = (cache?.frontmatter || {}) as Record<string, any>;
        const parentKeyMatch = this.findFrontmatterKeyCaseInsensitive(fm, parentKey);
        const parentRaw = parentKeyMatch ? fm[parentKeyMatch] : undefined;
        const parents = this.resolveLinkedFilesFromFrontmatterValue(parentRaw, childFile.path);
        if (!parents.length) {
            return 0;
        }

        for (const parent of parents) {
            await this.unlinkFromParent(childFile, parent);
        }
        void this.plugin.viewModeManager?.handlePotentialFrontmatterChange([childFile], [parentKey, childKey]);
        return parents.length;
    }

    /**
     * Removes an attachment from the parent file's `attachments` frontmatter array.
     */
    async unlinkAttachment(parentFile: TFile, attachmentFile: TFile): Promise<void> {
        const attachmentsKey = 'attachments';
        await this.plugin.app.fileManager.processFrontMatter(parentFile, (fm) => {
            const key = Object.keys(fm).find(k => k.toLowerCase() === attachmentsKey.toLowerCase());
            if (!key) return;
            const raw = fm[key];
            const arr: any[] = Array.isArray(raw) ? raw : (raw != null ? [raw] : []);
            const filtered = arr.filter((v: any) => !linkValueMatchesFile(this.plugin.app, v, parentFile.path, attachmentFile));
            if (filtered.length === 0) {
                delete fm[key];
            } else {
                fm[key] = filtered;
            }
        });
    }

    /**
     * Scans all vault markdown files and removes stale parent/child/attachment links
     * that pointed to the given deleted file. Called from the vault delete handler.
     */
    async cleanupLinksForDeletedFile(deletedPath: string, deletedBasename: string): Promise<void> {
        const parentKey = String(this.plugin.settings.parentLinkFrontmatterKey || 'childOf').trim() || 'childOf';
        const childKey = String(this.plugin.settings.childLinkFrontmatterKey || 'parentOf').trim() || 'parentOf';
        const attachmentsKey = 'attachments';

        const isMatch = (linkValue: any): boolean => {
            if (linkValue == null) return false;
            const target = extractLinkTarget(String(linkValue));
            if (!target) return false;
            const norm = (s: string) => normalizePath(s).toLowerCase();
            return target === deletedBasename ||
                norm(target) === norm(deletedPath) ||
                norm(target) === norm(deletedBasename);
        };

        const files = this.plugin.app.vault.getMarkdownFiles();
        for (const file of files) {
            const cache = this.plugin.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter;
            if (!fm) continue;

            const hasPk = Object.keys(fm).some(k => k.toLowerCase() === parentKey.toLowerCase());
            const hasCk = Object.keys(fm).some(k => k.toLowerCase() === childKey.toLowerCase());
            const hasAk = Object.keys(fm).some(k => k.toLowerCase() === attachmentsKey.toLowerCase());
            if (!hasPk && !hasCk && !hasAk) continue;

            try {
                await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
                    // Clean childOf (single parent ref)
                    const pk = Object.keys(frontmatter).find(k => k.toLowerCase() === parentKey.toLowerCase());
                    if (pk && isMatch(frontmatter[pk])) {
                        delete frontmatter[pk];
                    }

                    // Clean parentOf array
                    const ck = Object.keys(frontmatter).find(k => k.toLowerCase() === childKey.toLowerCase());
                    if (ck) {
                        const raw = frontmatter[ck];
                        const arr: any[] = Array.isArray(raw) ? raw : (raw != null ? [raw] : []);
                        const filtered = arr.filter(v => !isMatch(v));
                        if (filtered.length !== arr.length) {
                            if (filtered.length === 0) delete frontmatter[ck];
                            else frontmatter[ck] = filtered;
                        }
                    }

                    // Clean attachments array
                    const ak = Object.keys(frontmatter).find(k => k.toLowerCase() === attachmentsKey.toLowerCase());
                    if (ak) {
                        const raw = frontmatter[ak];
                        const arr: any[] = Array.isArray(raw) ? raw : (raw != null ? [raw] : []);
                        const filtered = arr.filter(v => !isMatch(v));
                        if (filtered.length !== arr.length) {
                            if (filtered.length === 0) delete frontmatter[ak];
                            else frontmatter[ak] = filtered;
                        }
                    }
                });
            } catch (err) {
                logger.warn(`[TPS GCM] cleanupLinksForDeletedFile: failed to clean ${file.path}:`, err);
            }
        }
    }
}
