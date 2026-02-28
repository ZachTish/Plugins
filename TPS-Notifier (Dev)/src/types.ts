import { TFile } from "obsidian";
import type { PropertyReminder } from './utils/time-calculation-service';

// PropertyReminder is defined in utils/time-calculation-service.ts.
// Re-exported here so other modules can import it from this central types file.
export type { PropertyReminder };

export interface TPSNotifierSettings {
    ntfyServer: string;
    ntfyTopic: string;
    ntfyPriority: number;
    enableLogging: boolean;
    snoozeProperty: string;
    snoozeOptions: { label: string; minutes: number }[];
    // Legacy fields kept for data.json backward compat — not used at runtime:
    deviceRole?: string;
    pollMinutes?: number;
    alertState?: Record<string, any>;
    ignorePaths?: string[];
    ignoreTags?: string[];
    ignoreStatuses?: string[];
    batchNotifications?: boolean;
}

export interface OverdueItem {
    file: TFile;
    reminder: PropertyReminder;
    propertyTime: number;
    diff: string;
    id: string;
    title?: string;
    body?: string; // Added body
    snoozedUntil?: number; // Added snooze tracking
}
