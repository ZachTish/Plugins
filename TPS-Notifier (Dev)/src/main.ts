import { Notice, Plugin, TFile, Modal, App } from 'obsidian';
import * as logger from "./logger";
import { TPSMessagerSettings } from './types';
import { TPSMessagerSettingTab } from './settings-tab';

// ============================================================================
// DEFAULTS
// ============================================================================

const DEFAULT_SETTINGS: TPSMessagerSettings = {
    ntfyServer: 'https://ntfy.sh',
    ntfyTopic: '',
    ntfyPriority: 3,
    enableLogging: false,
};

// ============================================================================
// MAIN PLUGIN CLASS
// ============================================================================

export default class TPSMessager extends Plugin {
    settings: TPSMessagerSettings;

    async onload() {
        logger.log('[TPS Messager] onload() started');
        try {
            await this.loadSettings();
            logger.log('[TPS Messager] Settings loaded');

            // Add Command to manually send a notification
            this.addCommand({
                id: 'send-custom-notification',
                name: 'Send Custom Notification',
                callback: () => {
                    this.openSendNotificationModal();
                },
            });

            // Add Settings Tab
            this.addSettingTab(new TPSMessagerSettingTab(this.app, this));

            // Register URL protocol handler for obsidian://tps-messager
            this.registerObsidianProtocolHandler('tps-messager', async (params) => {
                logger.log('[TPS Messager] Protocol handler triggered', params);
                // Open the file referenced in params if provided
                if (params.file) {
                    const file = this.app.vault.getAbstractFileByPath(decodeURIComponent(params.file));
                    if (file instanceof TFile) {
                        const leaf = this.app.workspace.getLeaf(false);
                        if (leaf) await leaf.openFile(file);
                    }
                }
            });

            // Expose API for other TPS plugins
            (this as any).api = {
                sendNotification: (title: string, body: string, file?: TFile) => this.sendMessage(body, file, title),
                sendMessage: (text: string, file?: TFile, title?: string) => this.sendMessage(text, file, title),
            };

        } catch (error) {
            logger.error('[TPS Messager] Failed to load plugin:', error);
            new Notice('TPS Messager failed to load. Check console.');
        }
        logger.log('[TPS Messager] onload() completed');
    }

    onunload() {
        logger.log('[TPS Messager] onunload()');
        delete (this as any).api;
    }

    async loadSettings() {
        try {
            const data = await this.loadData();
            this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

            if (this.settings.enableLogging) {
                logger.setLoggingEnabled(true);
            }
        } catch (e) {
            logger.error('[TPS Messager] Error in loadSettings:', e);
            this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        }
    }

    async saveSettings() {
        logger.setLoggingEnabled(this.settings.enableLogging);
        await this.saveData(this.settings);
    }

    log(message: string, ...args: any[]) {
        logger.log(`[TPS Messager] ${message}`, ...args);
    }

    // ========================================================================
    // NOTIFICATION SENDING
    // ========================================================================

    buildObsidianLink(file?: TFile): string {
        if (!file) return '';
        const vaultName = encodeURIComponent(this.app.vault.getName());
        const filePath = encodeURIComponent(file.path);
        return `obsidian://tps-messager?vault=${vaultName}&file=${filePath}`;
    }

    getNtfyUrl(): string | null {
        const base = (this.settings.ntfyServer || '').replace(/\/+$/, '');
        const topic = (this.settings.ntfyTopic || '').trim();
        if (!base || !topic) return null;
        return `${base}/${topic}`;
    }

    async sendMessage(text: string, file?: TFile, title?: string) {
        const url = this.getNtfyUrl();
        if (!url) {
            new Notice('Configure ntfy server and topic first.');
            return;
        }

        const clickLink = this.buildObsidianLink(file);

        // Sanitize title â€” HTTP headers must only contain ISO-8859-1 characters
        const sanitizedTitle = (title || 'TPS Messager')
            .replace(/[^\x00-\xFF]/g, '');

        const headers: Record<string, string> = {
            'Content-Type': 'text/plain; charset=utf-8',
            'Title': sanitizedTitle,
            'Priority': String(this.settings.ntfyPriority || 3),
            'Markdown': 'yes',
        };

        if (clickLink) {
            headers['Click'] = clickLink;
        }

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: text || '(empty message)',
            });

            if (response.ok) {
                this.log(`Notification sent: ${title}`);
            } else {
                const err = await response.text();
                logger.error('[TPS Messager] Ntfy error:', err);
            }
        } catch (error) {
            logger.error('[TPS Messager] Failed to send notification:', error);
        }
    }

    // ========================================================================
    // MANUAL SEND MODAL
    // ========================================================================

    openSendNotificationModal() {
        const modal = new (class extends Modal {
            title = '';
            body = '';
            plugin: TPSMessager;

            constructor(app: App, plugin: TPSMessager) {
                super(app);
                this.plugin = plugin;
            }

            onOpen() {
                const { contentEl } = this;
                contentEl.empty();
                contentEl.createEl('h2', { text: 'Send Custom Notification' });

                const container = contentEl.createDiv();
                container.style.display = 'flex';
                container.style.flexDirection = 'column';
                container.style.gap = '10px';

                // Title Input
                const titleBlock = container.createDiv();
                titleBlock.createEl('label', { text: 'Title', cls: 'tps-messager-label' });
                const titleInput = titleBlock.createEl('input', { type: 'text', placeholder: 'Notification Title' });
                titleInput.style.width = '100%';
                titleInput.addEventListener('input', (e) => this.title = (e.target as HTMLInputElement).value);

                // Body Input
                const bodyBlock = container.createDiv();
                bodyBlock.createEl('label', { text: 'Message', cls: 'tps-messager-label' });
                const bodyInput = bodyBlock.createEl('textarea', { placeholder: 'Message Body' });
                bodyInput.style.width = '100%';
                bodyInput.rows = 4;
                bodyInput.addEventListener('input', (e) => this.body = (e.target as HTMLTextAreaElement).value);

                // Buttons
                const btnContainer = container.createDiv();
                btnContainer.style.display = 'flex';
                btnContainer.style.justifyContent = 'flex-end';
                btnContainer.style.marginTop = '15px';
                btnContainer.style.gap = '10px';

                const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
                cancelBtn.addEventListener('click', () => this.close());

                const sendBtn = btnContainer.createEl('button', { text: 'Send', cls: 'mod-cta' });
                sendBtn.addEventListener('click', async () => {
                    if (!this.title && !this.body) {
                        new Notice('Please provide a title or message body.');
                        return;
                    }
                    await this.plugin.sendMessage(this.body, undefined, this.title);
                    new Notice('Notification Sent');
                    this.close();
                });
            }

            onClose() {
                this.contentEl.empty();
            }
        })(this.app, this);

        modal.open();
    }
}

