import { TFile } from "obsidian";

export interface PropertyReminder {
    id: string;
    label?: string; // Optional display label for UI organization
    property: string;
    enabled: boolean;
    offsetMinutes: number;
    mode?: 'task' | 'timeblock';
    repeatUntilComplete: boolean;
    repeatIntervalMinutes: number;
    maxRepeats: number;
    stopConditions: string[];
    title: string;
    body: string;
    ignorePaths?: string[];
    ignoreTags?: string[];
    ignoreStatuses?: string[];
    useSmartOffset?: boolean;
    smartOffsetProperty?: string;
    smartOffsetOperator?: 'add' | 'subtract';
    requiredStatuses?: string[];
    allDayFilter?: 'any' | 'true' | 'false'; // 'true' = must be allDay, 'false' = must NOT be allDay
    allDayBaseTime?: string; // e.g. "09:00"
    triggerAtEnd?: boolean; // Calculate trigger from the end of the event (start + duration)
}

export interface TPSNotifierSettings {
    ntfyServer: string;
    ntfyTopic: string;
    ntfyPriority: number;
    enableLogging: boolean;
    snoozeProperty: string;
    snoozeOptions: { label: string; minutes: number }[];
    // Legacy fields kept for data.json backward compat (ignored at runtime):
    deviceRole?: string;
    pollMinutes?: number;
    reminders?: PropertyReminder[];
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
