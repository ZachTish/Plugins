import * as logger from "../logger";
import type { TPSControllerSettings } from "../types";

interface CompanionPluginAPI {
    applyRulesToAllFiles?(silent?: boolean): Promise<void | number>;
}

/**
 * Manages the companion plugin startup scan and recurring sync interval.
 * Holds its own timer/interval IDs so they don't pollute the main plugin class.
 */
export class CompanionAutomationService {
    private companionStartupTimerId: number | null = null;
    private companionSyncIntervalId: number | null = null;

    constructor(
        private getSettings: () => TPSControllerSettings,
        private getCompanionPlugin: () => CompanionPluginAPI | null,
        private isController: () => boolean
    ) {}

    start(): void {
        this.stopStartup();
        const settings = this.getSettings();
        if (!settings.companionStartupScanEnabled) {
            logger.log("🤝 Companion startup scan DISABLED in settings");
            return;
        }

        const delay = Math.max(500, settings.companionStartupDelayMs);
        logger.log(`🤝 Scheduling companion startup scan after ${delay}ms...`);
        this.companionStartupTimerId = window.setTimeout(() => {
            logger.log("🤝 Companion startup timer triggered");
            void this.runScan();
            this.startSyncInterval();
        }, delay);
    }

    stop(): void {
        this.stopStartup();
        this.stopSyncInterval();
    }

    private stopStartup(): void {
        if (this.companionStartupTimerId !== null) {
            window.clearTimeout(this.companionStartupTimerId);
            this.companionStartupTimerId = null;
        }
    }

    private startSyncInterval(): void {
        this.stopSyncInterval();
        const minutes = Math.max(1, this.getSettings().syncIntervalMinutes || 5);
        const intervalMs = minutes * 60 * 1000;
        logger.log(`🤝 Companion scan interval: ${minutes} min`);
        this.companionSyncIntervalId = window.setInterval(() => {
            logger.log("⏲️ COMPANION TICK");
            void this.runScan();
        }, intervalMs);
    }

    private stopSyncInterval(): void {
        if (this.companionSyncIntervalId !== null) {
            window.clearInterval(this.companionSyncIntervalId);
            this.companionSyncIntervalId = null;
        }
    }

    async runScan(): Promise<void> {
        logger.log("🤝 COMPANION SCAN: Starting...");
        if (!this.isController()) {
            logger.log("🤝 Skipping companion scan (not controller)");
            return;
        }

        const companion = this.getCompanionPlugin();
        if (!companion) {
            logger.log("🤝 Companion plugin not found, skipping vault scan.");
            return;
        }

        if (!companion.applyRulesToAllFiles) {
            logger.warn("⚠️ Companion plugin API missing applyRulesToAllFiles");
            return;
        }

        try {
            const changedCount = await companion.applyRulesToAllFiles(true); // silent=true
            logger.log(`✅ COMPANION SCAN COMPLETED: ${changedCount} files updated`);
        } catch (error) {
            logger.error("❌ Companion scan failed", error);
        }
    }
}
