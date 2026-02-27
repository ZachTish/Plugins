import { App, normalizePath } from "obsidian";
import * as logger from "./logger";

/**
 * Controller Lock Service
 *
 * Ensures only one device in a synced vault can be in controller mode at a time.
 * Uses a lock file in the vault that persists across sync methods (Obsidian Sync,
 * iCloud, Dropbox, etc).
 */

export interface ControllerLock {
    deviceId: string;       // Unique device identifier
    vaultName: string;      // Vault name for clarity
    lockedAt: number;       // Timestamp when lock was acquired
    lastHeartbeat: number;  // Last heartbeat update (proves controller is alive)
}

const LOCK_PATH = normalizePath(
    ".obsidian/.controller-lock.json"
);

const HEARTBEAT_INTERVAL_MS = 10000;  // Update heartbeat every 10 seconds
const LOCK_TIMEOUT_MS = 30000;        // Consider lock stale after 30 seconds without heartbeat

export class ControllerLockService {
    private app: App;
    private deviceId: string;
    private heartbeatIntervalId: number | null = null;

    constructor(app: App) {
        this.app = app;
        // Generate a unique device ID based on vault name + timestamp + random
        // This persists in localStorage so the same device has the same ID across sessions
        const storageKey = `tps-controller-device-id-${app.vault.getName()}`;
        let stored = window.localStorage.getItem(storageKey);
        if (!stored) {
            stored = `${app.vault.getName()}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            window.localStorage.setItem(storageKey, stored);
        }
        this.deviceId = stored;
    }

    /**
     * Try to acquire the controller lock.
     * Returns true if successful, false if another controller holds the lock.
     */
    async tryAcquireLock(): Promise<{ success: boolean; currentHolder?: string }> {
        logger.log("Checking for existing lock file...");
        const existingLock = await this.readLock();

        if (existingLock) {
            const isStale = Date.now() - existingLock.lastHeartbeat > LOCK_TIMEOUT_MS;

            if (!isStale && existingLock.deviceId !== this.deviceId) {
                // Lock is held by another active controller
                logger.warn(`Controller lock held by: ${existingLock.deviceId}`);
                return {
                    success: false,
                    currentHolder: `${existingLock.vaultName} (${existingLock.deviceId})`
                };
            }

            // Lock is either stale or we already own it
            if (isStale) {
                logger.log(`Controller lock was stale, taking over. Previous holder: ${existingLock.deviceId}`);
            } else {
                logger.log(`We already own the lock, refreshing it.`);
            }
        } else {
            logger.log("No existing lock found, creating new lock.");
        }

        // Create or update the lock (never delete, just write/modify)
        const lock: ControllerLock = {
            deviceId: this.deviceId,
            vaultName: this.app.vault.getName(),
            lockedAt: Date.now(),
            lastHeartbeat: Date.now(),
        };

        await this.writeLock(lock);

        // Start heartbeat to keep lock alive
        this.startHeartbeat();

        logger.log(`✅ Controller lock acquired by: ${this.deviceId}`);
        return { success: true };
    }

    /**
     * Release the controller lock (if we hold it)
     */
    async releaseLock(): Promise<void> {
        this.stopHeartbeat();

        const existingLock = await this.readLock();
        if (existingLock && existingLock.deviceId === this.deviceId) {
            await this.deleteLock();
            logger.log(`Controller lock released by: ${this.deviceId}`);
        }
    }

    /**
     * Check if we currently hold the lock
     */
    async doWeHoldLock(): Promise<boolean> {
        const lock = await this.readLock();
        return lock !== null && lock.deviceId === this.deviceId;
    }

    /**
     * Start heartbeat interval to prove we're still alive
     */
    private startHeartbeat() {
        this.stopHeartbeat();

        this.heartbeatIntervalId = window.setInterval(async () => {
            const lock = await this.readLock();

            // Only update if we still hold the lock
            if (lock && lock.deviceId === this.deviceId) {
                lock.lastHeartbeat = Date.now();
                await this.writeLock(lock);
                // Reduced logging: only log every 6 heartbeats (1 minute)
                // logger.log("Controller lock heartbeat updated");
            } else {
                // We lost the lock somehow - stop heartbeat
                logger.warn("Lost controller lock, stopping heartbeat");
                this.stopHeartbeat();
            }
        }, HEARTBEAT_INTERVAL_MS);

        logger.log("Controller lock heartbeat started");
    }

    /**
     * Stop heartbeat interval
     */
    private stopHeartbeat() {
        if (this.heartbeatIntervalId !== null) {
            window.clearInterval(this.heartbeatIntervalId);
            this.heartbeatIntervalId = null;
        }
    }

    /**
     * Read the lock file
     */
    private async readLock(): Promise<ControllerLock | null> {
        const file = this.app.vault.getAbstractFileByPath(LOCK_PATH);
        if (!file) return null;

        try {
            const content = await this.app.vault.read(file as any);
            const parsed = JSON.parse(content) as ControllerLock;
            if (parsed.deviceId && parsed.lockedAt && parsed.lastHeartbeat) {
                return parsed;
            }
        } catch (e) {
            logger.warn("Failed to parse controller lock file:", e);
        }

        return null;
    }

    /**
     * Write the lock file
     */
    private async writeLock(lock: ControllerLock): Promise<void> {
        const content = JSON.stringify(lock, null, 2);

        // Try up to 3 times with delays to handle race conditions
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const existing = this.app.vault.getAbstractFileByPath(LOCK_PATH);
                if (existing) {
                    // File already exists, modify it
                    await this.app.vault.modify(existing as any, content);
                    logger.log(`Lock file modified successfully (attempt ${attempt})`);
                    return;
                } else {
                    // No file exists, create it
                    await this.app.vault.create(LOCK_PATH, content);
                    logger.log(`Lock file created successfully (attempt ${attempt})`);
                    return;
                }
            } catch (e) {
                // Handle race condition: file was created/deleted between check and operation
                if (e instanceof Error && e.message.includes("already exists")) {
                    logger.warn(`Lock file appeared during create (attempt ${attempt}), retrying...`);
                    // Wait a bit and retry
                    await new Promise(resolve => setTimeout(resolve, 50 * attempt));
                    continue;
                } else if (e instanceof Error && e.message.includes("not found")) {
                    logger.warn(`Lock file disappeared during modify (attempt ${attempt}), retrying...`);
                    // Wait a bit and retry
                    await new Promise(resolve => setTimeout(resolve, 50 * attempt));
                    continue;
                } else {
                    // Unknown error
                    logger.error(`Failed to write controller lock file (attempt ${attempt}):`, e);
                    if (attempt === 3) {
                        throw e;
                    }
                    await new Promise(resolve => setTimeout(resolve, 50 * attempt));
                }
            }
        }

        throw new Error("Failed to write lock file after 3 attempts");
    }

    /**
     * Delete the lock file
     */
    private async deleteLock(): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(LOCK_PATH);
        if (file) {
            try {
                await this.app.vault.delete(file as any);
            } catch (e) {
                logger.warn("Failed to delete controller lock file:", e);
            }
        }
    }
}
