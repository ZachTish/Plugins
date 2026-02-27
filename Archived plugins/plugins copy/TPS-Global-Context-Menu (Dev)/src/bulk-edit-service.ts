import { TFile, Notice, normalizePath } from 'obsidian';
import TPSGlobalContextMenuPlugin from './main';
import { RRule } from 'rrule';
import * as logger from "./logger";
import { normalizeTagValue, normalizeTagList, parseTagInput, mergeNormalizedTags } from './tag-utils';
import { stripDateSuffix } from './date-suffix-utils';
import { ChecklistHandler } from './checklist-handler';
import { ParentLinkHandler } from './parent-link-handler';

export class BulkEditService {
    plugin: TPSGlobalContextMenuPlugin;
    private recurrenceCreationInProgress: Set<string> = new Set();
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

    private hashString(input: string): string {
        let hash = 2166136261;
        for (let i = 0; i < input.length; i++) {
            hash ^= input.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    private resolveRecurrenceChainId(file: TFile, frontmatter: any, recurrenceRule: string): string {
        const explicitKey = this.findFrontmatterKeyCaseInsensitive(frontmatter || {}, 'recurrenceChainId');
        const explicit = explicitKey ? String(frontmatter?.[explicitKey] ?? '').trim() : '';
        if (explicit) return explicit;

        const baseName = stripDateSuffix(file.basename || '').trim().toLowerCase();
        const seed = `${baseName}|${String(recurrenceRule || '').trim().toLowerCase()}`;
        return `rc-${this.hashString(seed)}`;
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
        return String(key || '').trim().toLowerCase();
    }

    private findFrontmatterKeyCaseInsensitive(target: Record<string, any>, key: string): string | null {
        const normalized = this.normalizeFrontmatterKey(key);
        if (!normalized) return null;
        return Object.keys(target || {}).find((candidate) => this.normalizeFrontmatterKey(candidate) === normalized) || null;
    }

    private setFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string, value: any): void {
        const existing = this.findFrontmatterKeyCaseInsensitive(target, key);
        const targetKey = existing || key;
        target[targetKey] = value;
        if (existing && existing !== key && key in target) {
            delete target[key];
        }
    }

    private deleteFrontmatterValueCaseInsensitive(target: Record<string, any>, key: string): void {
        const existing = this.findFrontmatterKeyCaseInsensitive(target, key);
        if (!existing) return;
        delete target[existing];
    }

    private isTagFrontmatterKey(key: string): boolean {
        const normalized = this.normalizeFrontmatterKey(key);
        return normalized === 'tags' || normalized === 'tag';
    }

    private notifyFilesChanged(files: TFile[]): void {
        try {
            const paths = files.map((f) => f.path);
            this.plugin.app.workspace.trigger('tps-gcm-files-updated' as any, paths);
        } catch (e) {
            logger.warn('[TPS GCM] Failed to trigger files-updated event:', e);
        }
    }

    async applyToFiles(files: TFile[], callback: (fm: any, file: TFile) => void): Promise<number> {
        let count = 0;
        for (const file of files) {
            try {
                if (file.extension?.toLowerCase() !== 'md') continue;
                this.plugin.recurrenceService?.markFileAsModified(file.path);
                await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
                    callback(fm, file);
                });
                count++;
            } catch (e) {
                logger.error(`[TPS GCM] Failed to update ${file.path}:`, e);
            }
        }

        setTimeout(() => {
            for (const file of files) {
                this.plugin.persistentMenuManager?.refreshMenusForFile(file);
            }
        }, 350);

        if (count > 0) {
            this.notifyFilesChanged(files);
        }

        return count;
    }

    async updateFrontmatter(files: TFile[], updates: Record<string, any>): Promise<number> {
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
        const keys = Object.keys(updates);
        if (count > 0 && keys.length > 0) {
            void this.plugin.viewModeManager?.handlePotentialFrontmatterChange(files, keys);
        }
        return count;
    }

    async setStatus(files: TFile[], status: string): Promise<number> {
        const recurrenceStatuses = this.plugin.settings.recurrenceCompletionStatuses?.length
            ? this.plugin.settings.recurrenceCompletionStatuses
            : ['complete', 'wont-do'];

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

        if (this.plugin.settings.enableRecurrence && recurrenceStatuses.includes(status)) {
            for (const file of files) {
                const cache = this.plugin.app.metadataCache.getFileCache(file);
                const fm = cache?.frontmatter;

                if (fm && (fm.recurrenceRule || fm.recurrence)) {
                    const previousStatus = fm.status || null;
                    const handled = await this.createNextRecurrenceInstance(file, fm, previousStatus);
                    if (!handled) {
                        await this.clearRecurrenceRule(file);
                    }
                }
            }
        }

        return this.updateFrontmatter(files, { status });
    }

    async setPriority(files: TFile[], priority: string): Promise<number> {
        return this.updateFrontmatter(files, { priority });
    }

    async addTag(files: TFile[], tag: string, key: string = 'tags'): Promise<number> {
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

        let count = 0;
        for (const file of files) {
            try {
                if (file.extension?.toLowerCase() !== 'md') continue;
                this.plugin.recurrenceService?.markFileAsModified(file.path);
                await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
                    const targetKey = this.findFrontmatterKeyCaseInsensitive(fm, key) || key;
                    if (!fm[targetKey]) return;
                    const tags = normalizeTagList(fm[targetKey]);
                    const filtered = tags.filter((t: any) => {
                        const normalized = normalizeTagValue(String(t));
                        return !normalizedTags.includes(normalized);
                    });
                    if (filtered.length === 0) {
                        delete fm[targetKey];
                    } else {
                        fm[targetKey] = filtered;
                    }
                    if (targetKey !== key && key in fm) {
                        delete fm[key];
                    }
                });

                const content = await this.plugin.app.vault.read(file);
                let nextContent = content;
                for (const normalizedTag of normalizedTags) {
                    const regex = new RegExp(`#${normalizedTag.replace(/\//g, "\\/")}(?![\\w/-])`, "g");
                    nextContent = nextContent.replace(regex, '');
                }
                if (nextContent !== content) {
                    await this.plugin.app.vault.modify(file, nextContent);
                }
                count++;
            } catch (e) {
                logger.error(`[TPS GCM] Failed to remove tag from ${file.path}:`, e);
            }
        }

        setTimeout(() => {
            for (const file of files) {
                this.plugin.persistentMenuManager?.refreshMenusForFile(file);
            }
        }, 100);

        if (count > 0) {
            this.notifyFilesChanged(files);
        }

        return count;
    }

    async setRecurrence(files: TFile[], rule: string | null): Promise<number> {
        const count = await this.applyToFiles(files, (fm) => {
            if (rule) {
                fm.recurrenceRule = rule;
                delete fm.recurrence;
            } else {
                delete fm.recurrenceRule;
                delete fm.recurrence;
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
                fm.scheduled = date;
            } else {
                delete fm.scheduled;
            }
        });
    }

    async updateScheduledDetails(files: TFile[], scheduled: string | null, timeEstimate: number | null, allDay: boolean, key: string = 'scheduled'): Promise<number> {
        return this.applyToFiles(files, (fm) => {
            if (scheduled) {
                fm[key] = scheduled;
            } else {
                delete fm[key];
            }

            if (timeEstimate !== null && timeEstimate !== undefined && !isNaN(timeEstimate)) {
                fm.timeEstimate = timeEstimate;
            } else {
                delete fm.timeEstimate;
            }

            if (allDay) {
                fm.allDay = true;
            } else {
                delete fm.allDay;
            }
        });
    }

    showNotice(action: string, detail: string, suffix: string, count: number): void {
        const msg = `${detail} ${suffix} on ${count} file${count !== 1 ? 's' : ''}`;
        new Notice(msg);
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
                logger.warn('[TPS GCM] Could not calculate next recurrence date');
                await this.clearRecurrenceRule(file);
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
                    await this.clearRecurrenceRule(file);
                    return true;
                }
                if (await this.plugin.app.vault.adapter.exists(newFilePath)) {
                    await this.completeRecurrenceOp(recurrenceOpKey, newFilePath);
                    await this.clearRecurrenceRule(file);
                    return true;
                }
                // Another device/process is likely creating this recurrence.
                return true;
            }

            if (await this.plugin.app.vault.adapter.exists(newFilePath)) {
                logger.warn('[TPS GCM] Next recurrence already exists, skipping creation:', newFilePath);
                await this.completeRecurrenceOp(recurrenceOpKey, newFilePath);
                await this.clearRecurrenceRule(file);
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

            await this.plugin.app.fileManager.processFrontMatter(newFile, (fm) => {
                fm.scheduled = newScheduled;
                fm.title = baseName;
                fm.status = newStatus;
                fm.recurrenceChainId = chainId;
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
            logger.error('[TPS GCM] Failed to create next recurrence instance:', error);
            new Notice('Failed to create next recurrence instance');
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
            delete fm.recurrenceRule;
            delete fm.recurrence;
        });
    }

    stringifyFrontmatter(fm: any): string {
        const lines: string[] = [];

        for (const key in fm) {
            const value = fm[key];

            if (value === null || value === undefined) {
                continue;
            }

            if (Array.isArray(value)) {
                lines.push(`${key}:`);
                value.forEach((item: any) => {
                    lines.push(`  - ${item}`);
                });
            } else if (typeof value === 'object') {
                continue;
            } else if (typeof value === 'string') {
                if (value.includes(':') || value.includes('#') || value.includes('\n')) {
                    lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
                } else {
                    lines.push(`${key}: ${value}`);
                }
            } else {
                lines.push(`${key}: ${value}`);
            }
        }

        return lines.join('\n') + '\n';
    }

    // --- Link operations (delegated to parent-link-handler) ---

    async linkToParent(files: TFile[], parentFile: TFile): Promise<number> {
        const parentKey = this.parentLinkHandler.normalizeParentKey();
        const parentLink = `[[${parentFile.basename}]]`;
        return this.updateFrontmatter(files, { [parentKey]: parentLink });
    }

    async linkChildren(currentFile: TFile, childFiles: TFile[]): Promise<number> {
        const parentKey = this.parentLinkHandler.normalizeParentKey();
        const parentLink = `[[${currentFile.basename}]]`;
        return this.updateFrontmatter(childFiles, { [parentKey]: parentLink });
    }
}
