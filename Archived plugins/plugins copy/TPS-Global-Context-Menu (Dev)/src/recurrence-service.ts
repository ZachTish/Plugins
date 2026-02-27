import { App, TFile, TFolder, Modal, Notice } from 'obsidian';
import TPSGlobalContextMenuPlugin from './main';
import * as logger from "./logger";
import { RecurrenceModal } from './recurrence-modal';

/**
 * Tracks which files have been modified in this session to avoid repeated prompts.
 * Now persists to disk and syncs across devices.
 */
class SessionTracker {
    private modifiedFiles: Map<string, number> = new Map();
    private sessionDuration: number;
    private plugin: TPSGlobalContextMenuPlugin;
    private cacheFilePath: string;
    private saveDebounceTimer: number | null = null;

    constructor(plugin: TPSGlobalContextMenuPlugin, durationMinutes: number = 5) {
        this.plugin = plugin;
        this.sessionDuration = durationMinutes * 60 * 1000;
        this.cacheFilePath = `${plugin.manifest.dir}/recurrence-session.json`;
    }

    async load(): Promise<void> {
        try {
            const exists = await this.plugin.app.vault.adapter.exists(this.cacheFilePath);
            if (!exists) {
                logger.log('[SessionTracker] No cache file found, starting fresh');
                return;
            }

            const content = await this.plugin.app.vault.adapter.read(this.cacheFilePath);
            const data = JSON.parse(content);

            if (data.version === 1 && data.sessions) {
                // Load sessions and filter out expired ones
                const now = Date.now();
                let loadedCount = 0;
                for (const [path, timestamp] of Object.entries(data.sessions)) {
                    if (typeof timestamp === 'number' && now - timestamp < this.sessionDuration) {
                        this.modifiedFiles.set(path, timestamp);
                        loadedCount++;
                    }
                }
                logger.log(`[SessionTracker] Loaded ${loadedCount} active sessions from cache (${Object.keys(data.sessions).length - loadedCount} expired)`);
            }
        } catch (error) {
            logger.warn('[SessionTracker] Failed to load session cache:', error);
        }
    }

    private async save(): Promise<void> {
        // Debounce saves to avoid excessive writes
        if (this.saveDebounceTimer !== null) {
            window.clearTimeout(this.saveDebounceTimer);
        }

        this.saveDebounceTimer = window.setTimeout(async () => {
            try {
                // Clean up expired entries before saving
                const now = Date.now();
                const sessions: Record<string, number> = {};

                for (const [path, timestamp] of this.modifiedFiles.entries()) {
                    if (now - timestamp < this.sessionDuration) {
                        sessions[path] = timestamp;
                    } else {
                        // Remove expired entries from memory
                        this.modifiedFiles.delete(path);
                    }
                }

                const data = {
                    version: 1,
                    sessions
                };

                await this.plugin.app.vault.adapter.write(
                    this.cacheFilePath,
                    JSON.stringify(data, null, 2)
                );

                logger.log(`[SessionTracker] Saved ${Object.keys(sessions).length} sessions to cache`);
            } catch (error) {
                logger.warn('[SessionTracker] Failed to save session cache:', error);
            } finally {
                this.saveDebounceTimer = null;
            }
        }, 1000); // 1 second debounce
    }

    updateDuration(durationMinutes: number): void {
        this.sessionDuration = durationMinutes * 60 * 1000;
    }

    markAsModified(filePath: string): void {
        this.modifiedFiles.set(filePath, Date.now());
        void this.save(); // Async save (debounced)
    }

    wasRecentlyModified(filePath: string): boolean {
        const lastModified = this.modifiedFiles.get(filePath);
        if (!lastModified) return false;

        const elapsed = Date.now() - lastModified;
        if (elapsed > this.sessionDuration) {
            this.modifiedFiles.delete(filePath);
            return false;
        }
        return true;
    }

    clear(): void {
        this.modifiedFiles.clear();
        void this.save();
    }
}

/**
 * Service to handle recurrence logic, including creating next instances,
 * stripping rules, and prompting users on edit.
 */
export class RecurrenceService {
    plugin: TPSGlobalContextMenuPlugin;
    sessionTracker: SessionTracker;
    private activePrompts: Set<string> = new Set();
    private activeSplits: Set<string> = new Set();
    private lastEditorChangeAt: number = 0;
    private typingQuietWindowMs: number = 3000;
    private pendingModifyTimers: Map<string, number> = new Map();
    private vaultOpenedAt: number = 0;
    private readonly startupGracePeriodMs: number = 3000; // 3 seconds
    private globalModalOpen: boolean = false;

    constructor(plugin: TPSGlobalContextMenuPlugin) {
        this.plugin = plugin;
        this.sessionTracker = new SessionTracker(plugin, plugin.settings.recurrencePromptTimeout);
    }

    async initialize(): Promise<void> {
        await this.sessionTracker.load();
    }

    updateSettings(): void {
        this.sessionTracker.updateDuration(this.plugin.settings.recurrencePromptTimeout);
    }

    markFileAsModified(filePath: string): void {
        this.sessionTracker.markAsModified(filePath);
    }

    /**
     * Start listening for edits to recurring files.
     * Replaces the old "Focus Prompt" with a passive "Edit Listener".
     */
    setup(): void {
        // Remove old listeners if any
        this.cleanup();

        // Track when vault opened
        this.vaultOpenedAt = Date.now();

        // Mark all open recurring notes on startup to prevent modal spam
        this.plugin.app.workspace.onLayoutReady(() => {
            this.markOpenRecurringNotesOnStartup();
        });

        this.plugin.registerEvent(
            this.plugin.app.workspace.on('editor-change', () => {
                this.lastEditorChangeAt = Date.now();
            })
        );

        // 1. Listen for Active Leaf Change (Focus Prompt)
        this.plugin.registerEvent(
            this.plugin.app.workspace.on('active-leaf-change', async (leaf) => {
                const file = this.plugin.app.workspace.getActiveFile();
                if (file instanceof TFile && file.extension === 'md') {
                    await this.handleFileFocus(file);
                }
            })
        );

        // 2. Listen for File Modification (Edit Prompt)
        // We listen to the vault modify event globally.
        this.plugin.registerEvent(
            this.plugin.app.vault.on('modify', async (file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    const recentlyTyping = this.lastEditorChangeAt && Date.now() - this.lastEditorChangeAt < this.typingQuietWindowMs;
                    if (recentlyTyping) {
                        return;
                    }
                    await this.handleFileModification(file);
                }
            })
        );
    }

    cleanup(): void {
        this.sessionTracker.clear();
        for (const timer of this.pendingModifyTimers.values()) {
            window.clearTimeout(timer);
        }
        this.pendingModifyTimers.clear();
        // Global listener is registered to plugin, so it cleans up automatically on plugin unload.
    }

    /**
     * Handle a file modification event.
     * Checks if the file is recurring and if we should prompt the user.
     */
    /**
     * Handle a file focus event.
     * Checks if the file is recurring and prompts if not recently interacted with.
     */
    private async handleFileFocus(file: TFile): Promise<void> {
        // 0. Skip during startup grace period to prevent modal spam on vault open
        const timeSinceStartup = Date.now() - this.vaultOpenedAt;
        if (timeSinceStartup < this.startupGracePeriodMs) {
            logger.log(`[RecurrenceService] Skipping focus prompt during startup grace period (${timeSinceStartup}ms)`);
            return;
        }

        // 1. Quick check: Is this file currently being tracked/ignored by session?
        if (this.sessionTracker.wasRecentlyModified(file.path)) return;

        // 2. Check for Recurrence Rule
        const cache = this.plugin.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (!fm || (!fm.recurrenceRule && !fm.recurrence)) return;

        // 3. Ignore completed/wont-do items
        if (fm.status === 'complete' || fm.status === 'wont-do') return;

        // 4. Prompt the user
        // We use a specific "Focus" prompt logic
        await this.promptOnFocus(file);
    }

    /**
     * Prompt when focusing a recurring note
     */
    async promptOnFocus(file: TFile): Promise<void> {
        const result = await this.promptUser('focus', file);
        if (result === 'update-all') {
            this.sessionTracker.markAsModified(file.path);
        } else if (result === 'split') {
            await this.splitInstance(file);
            this.sessionTracker.markAsModified(file.path);
        } else if (result === 'cancel') {
            this.sessionTracker.markAsModified(file.path);
        }
    }

    private async handleFileModification(file: TFile): Promise<void> {
        // 1. Quick check: Is this file currently being tracked/ignored by session?
        if (this.sessionTracker.wasRecentlyModified(file.path)) return;

        // 2. Check for Recurrence Rule
        const cache = this.plugin.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (!fm || (!fm.recurrenceRule && !fm.recurrence)) return;

        // 3. Ignore completed/wont-do items
        if (fm.status === 'complete' || fm.status === 'wont-do') return;

        // 4. Prompt the user
        await this.promptForContentChange(file);
    }

    /**
     * Mark all open recurring notes on startup to prevent modal spam.
     * Called once when vault layout is ready.
     */
    private markOpenRecurringNotesOnStartup(): void {
        const leaves = this.plugin.app.workspace.getLeavesOfType('markdown');

        for (const leaf of leaves) {
            const view = leaf.view as any;
            const file = view?.file;

            if (!(file instanceof TFile)) continue;

            const cache = this.plugin.app.metadataCache.getFileCache(file);
            const fm = cache?.frontmatter;

            if (fm && (fm.recurrenceRule || fm.recurrence)) {
                // Ignore completed/wont-do items
                if (fm.status === 'complete' || fm.status === 'wont-do') continue;

                // Mark as modified to suppress modal
                this.sessionTracker.markAsModified(file.path);
                logger.log(`[RecurrenceService] Marked open recurring note on startup: ${file.path}`);
            }
        }
    }

    /**
     * Prompt user about content changes to recurring task.
     */
    async promptForContentChange(file: TFile): Promise<void> {
        const result = await this.promptUser('editing', file);

        if (result === 'update-all') {
            // User chose to edit the series. Mark as modified so we don't ask again.
            this.sessionTracker.markAsModified(file.path);
        } else if (result === 'split') {
            // User chose to split. 
            // We create the next recurrence (clone original), 
            // and then STRIP the recurrence from THIS file (the one being edited).
            await this.splitInstance(file);
            this.sessionTracker.markAsModified(file.path);
        }
        else {
            // Cancel logic? Or just treat as "update-all" implicitly if they keep typing?
            // Usually cancel means "I didn't mean to edit", but we can't easily undo the edit here without text buffer access.
            // For now, we assume they acknowledge the prompt. We won't mark as modified, so next edit triggers again?
            // That might be annoying. Let's assume Cancel = "Don't do anything special, but stop bugging me for a bit"
            // or actually, maybe we just mark as modified to suppress further prompts for this session.
            this.sessionTracker.markAsModified(file.path);
        }
    }

    /**
     * Prompt user about frontmatter changes to recurring task
     */
    async promptForFrontmatterChange(file: TFile, changeDescription: string): Promise<'update-all' | 'split' | 'cancel'> {
        // Don't prompt if already modified in this session
        if (this.sessionTracker.wasRecentlyModified(file.path)) {
            return 'update-all'; // Allow the change without prompting
        }

        const result = await this.promptUser(changeDescription, file);

        if (result === 'update-all') {
            this.sessionTracker.markAsModified(file.path);
        } else if (result === 'split') {
            await this.splitInstance(file);
            this.sessionTracker.markAsModified(file.path);
        }

        return result;
    }

    /**
     * Split this instance: Create NEXT recurrence now, and remove recurrence info from CURRENT file.
     */
    async splitInstance(file: TFile): Promise<void> {
        if (this.activeSplits.has(file.path)) {
            return;
        }
        this.activeSplits.add(file.path);

        const cache = this.plugin.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (!fm) {
            this.activeSplits.delete(file.path);
            return;
        }

        try {
            // 1. Create the NEXT instance (clone of this one, moved to next date)
            await this.plugin.bulkEditService.createNextRecurrenceInstance(file, fm);

            // 2. Remove recurrence rule from THIS file (making it a single instance exception)
            // createNextRecurrenceInstance checks 'status', but here we are splitting an *active* task.
            // We just want to remove the rrule.
            await this.plugin.bulkEditService.updateFrontmatter([file], {
                recurrenceRule: null,
                recurrence: null
            });

            new Notice(`Split recurring event. Next instance created.`);
        } finally {
            this.activeSplits.delete(file.path);
        }
    }

    /**
     * Show modal to prompt user
     */
    private promptUser(changeType: string, file: TFile): Promise<'update-all' | 'split' | 'cancel'> {
        return new Promise((resolve) => {
            if (this.activePrompts.has(file.path)) {
                resolve('cancel');
                return;
            }

            // Global modal limit: only allow one modal at a time
            if (this.globalModalOpen) {
                logger.log(`[RecurrenceService] Skipping prompt for ${file.path} - another modal is already open`);
                resolve('cancel');
                return;
            }

            this.globalModalOpen = true;
            this.activePrompts.add(file.path);
            new RecurrenceUpdateModal(this.plugin.app, changeType, (result) => {
                this.activePrompts.delete(file.path);
                this.globalModalOpen = false;
                resolve(result);
            }).open();
        });
    }
}

class RecurrenceUpdateModal extends Modal {
    private resolve: (value: 'update-all' | 'split' | 'cancel') => void;
    private changeType: string;

    constructor(app: App, changeType: string, resolve: (value: 'update-all' | 'split' | 'cancel') => void) {
        super(app);
        this.changeType = changeType;
        this.resolve = resolve;
    }

    onOpen(): void {
        this.modalEl.addClass('mod-tps-gcm');
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('tps-recurrence-update-modal');

        let titleText = 'Update Recurring Task?';
        let msgText = `You are editing a recurring task. How should this change apply?`;
        let option1Title = 'Edit Series (All Future)';
        let option1Desc = 'Changes apply to this and all future instances.';
        let option2Title = 'Edit Only This Instance';
        let option2Desc = 'This becomes a standalone task. A new recurring instance is generated for the schedule.';

        if (this.changeType === 'focus') {
            titleText = 'Recurring Task Detected';
            msgText = 'You have opened a recurring task. What would you like to do?';
            option1Title = 'View/Edit This Series';
            option1Desc = 'Enter the note to view or make changes to the existing series.';
            option2Title = 'Create Next Instance Now';
            option2Desc = 'Mark this instance as effectively complete/split and generate the next occurrence immediately.';
        }

        contentEl.createEl('h3', { text: titleText });

        const message = contentEl.createEl('p', { text: msgText });
        message.style.marginBottom = '16px';
        message.style.color = 'var(--text-muted)';

        const optionsContainer = contentEl.createEl('div');
        optionsContainer.style.display = 'flex';
        optionsContainer.style.flexDirection = 'column';
        optionsContainer.style.gap = '8px';

        this.createOption(optionsContainer,
            option1Title,
            option1Desc,
            () => this.resolveAndClose('update-all')
        );

        this.createOption(optionsContainer,
            option2Title,
            option2Desc,
            () => this.resolveAndClose('split')
        );

        const cancelBtn = contentEl.createEl('button', { text: 'Cancel' });
        cancelBtn.style.marginTop = '10px';
        cancelBtn.style.width = '100%';
        cancelBtn.addEventListener('click', () => this.resolveAndClose('cancel'));
    }

    createOption(container: HTMLElement, title: string, desc: string, onClick: () => void) {
        const el = container.createDiv('tps-recurrence-option');
        el.style.padding = '10px';
        el.style.border = '1px solid var(--background-modifier-border)';
        el.style.borderRadius = '6px';
        el.style.cursor = 'pointer';

        const t = el.createDiv();
        t.style.fontWeight = 'bold';
        t.textContent = title;

        const d = el.createDiv();
        d.style.fontSize = '0.9em';
        d.style.color = 'var(--text-muted)';
        d.textContent = desc;

        el.addEventListener('click', onClick);
        el.addEventListener('mouseenter', () => el.style.backgroundColor = 'var(--background-modifier-hover)');
        el.addEventListener('mouseleave', () => el.style.backgroundColor = 'transparent');

        container.appendChild(el);
    }

    resolveAndClose(val: 'update-all' | 'split' | 'cancel') {
        this.resolve(val);
        this.close();
    }

    onClose() {
        this.contentEl.empty();
    }
}
