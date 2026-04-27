import { App, normalizePath, TFile } from "obsidian";
import * as logger from "../logger";

/**
 * File-based sync request mechanism for user → controller communication.
 *
 * Replicas write a request file into the shared vault; the controller's
 * periodic sync loop picks it up and fulfills it.
 */

export interface SyncRequest {
    requestedAt: number;
    requestedBy: string;   // vault-scoped device hint
    scope: ("calendar" | "companion" | "reminders")[];
}

export class SyncRequestService {
    private app: App;
    private requestPath: string;

    constructor(app: App, pluginDir: string) {
        this.app = app;
        this.requestPath = normalizePath(`${pluginDir}/.sync-request.json`);
    }

    private getRequestFile(): TFile | null {
        const file = this.app.vault.getAbstractFileByPath(this.requestPath);
        return file instanceof TFile ? file : null;
    }

    /** Write a sync request (called by users). */
    async writeRequest(scope: SyncRequest["scope"]): Promise<void> {
        const request: SyncRequest = {
            requestedAt: Date.now(),
            requestedBy: this.app.vault.getName(),
            scope,
        };
        const content = JSON.stringify(request, null, 2);

        const existing = this.getRequestFile();
        if (existing) {
            await this.app.vault.modify(existing, content);
        } else {
            try {
                await this.app.vault.create(this.requestPath, content);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.toLowerCase().includes("already exists")) {
                    // Race: another process created the file between the check and create.
                    const nowExisting = this.getRequestFile();
                    if (nowExisting) {
                        await this.app.vault.modify(nowExisting, content);
                    }
                } else {
                    throw e;
                }
            }
        }

        logger.log(`Sync request written: ${scope.join(", ")}`);
    }

    /** Read pending request (called by controller). Returns null if none. */
    async readRequest(): Promise<SyncRequest | null> {
        const file = this.getRequestFile();
        if (!file) return null;

        try {
            const content = await this.app.vault.read(file);
            const parsed = JSON.parse(content) as SyncRequest;
            if (parsed.requestedAt && Array.isArray(parsed.scope)) {
                return parsed;
            }
        } catch (e) {
            logger.warn("Failed to parse sync request file:", e);
        }

        return null;
    }

    /** Delete the request file after fulfilling it (called by controller). */
    async clearRequest(): Promise<void> {
        const file = this.getRequestFile();
        if (file) {
            try {
                await this.app.vault.delete(file);
                logger.log("Sync request fulfilled and cleared.");
            } catch (e) {
                logger.warn("Failed to delete sync request file:", e);
            }
        }
    }
}
