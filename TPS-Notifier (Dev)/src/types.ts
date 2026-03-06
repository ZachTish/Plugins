export interface TPSMessagerSettings {
    ntfyServer: string;
    ntfyTopic: string;
    ntfyPriority: number;
    enableLogging: boolean;
    // Legacy fields retained for data.json migration compat — not used at runtime:
    /** @deprecated */
    deviceRole?: string;
    /** @deprecated */
    pollMinutes?: number;
    /** @deprecated */
    snoozeProperty?: string;
    /** @deprecated */
    snoozeOptions?: { label: string; minutes: number }[];
    /** @deprecated */
    alertState?: Record<string, any>;
    /** @deprecated */
    ignorePaths?: string[];
    /** @deprecated */
    ignoreTags?: string[];
    /** @deprecated */
    ignoreStatuses?: string[];
    /** @deprecated */
    batchNotifications?: boolean;
}
