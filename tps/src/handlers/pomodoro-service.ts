import { App, TFile, Notice } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import * as logger from '../logger';

export type PomodoroState = 'idle' | 'work' | 'short-break' | 'long-break';

export class PomodoroService {
    private app: App;
    private timerInterval: number | null = null;
    public currentState: PomodoroState = 'idle';

    // Core tracking
    public remainingSeconds = 0;
    public totalDurationSeconds = 0;
    public completedWorkSessions = 0;

    // Event tracking
    public activeEventFile: TFile | null = null;

    constructor(private plugin: TPSGlobalContextMenuPlugin) {
        this.app = plugin.app;
    }

    public startSession(): void {
        if (!this.plugin.settings.enablePomodoro) {
            new Notice('Pomodoro is disabled in settings');
            return;
        }

        if (this.currentState !== 'idle') {
            this.stopSession(false); // Clean up existing
        }

        this.currentState = 'work';
        this.totalDurationSeconds = this.plugin.settings.pomodoroWorkDuration * 60;
        this.remainingSeconds = this.totalDurationSeconds;

        void this.createTrackingEvent();
        this.startTick();
        this.notify('Pomodoro Started', `Focus for ${this.plugin.settings.pomodoroWorkDuration} minutes!`);
    }

    public stopSession(finishedNormally = false): void {
        this.clearTick();

        if (this.currentState === 'work' && finishedNormally) {
            this.completedWorkSessions++;
            void this.finalizeTrackingEvent(true);
        } else if (this.currentState === 'work' && !finishedNormally) {
            // Premature stop
            void this.finalizeTrackingEvent(false);
        }

        this.currentState = 'idle';
        this.activeEventFile = null;
        this.remainingSeconds = 0;
        this.totalDurationSeconds = 0;

        this.plugin.persistentMenuManager.ensureMenus();
    }

    public startBreak(isLong = false): void {
        this.clearTick();
        this.currentState = isLong ? 'long-break' : 'short-break';
        const mins = isLong
            ? this.plugin.settings.pomodoroLongBreakDuration
            : this.plugin.settings.pomodoroBreakDuration;

        this.totalDurationSeconds = mins * 60;
        this.remainingSeconds = this.totalDurationSeconds;

        this.startTick();
        this.notify(isLong ? 'Long Break Started' : 'Short Break Started', `Take a break for ${mins} minutes.`);
    }

    private startTick(): void {
        this.clearTick();
        this.plugin.persistentMenuManager.ensureMenus(); // Initial UI update

        this.timerInterval = window.setInterval(() => {
            this.remainingSeconds--;

            if (this.remainingSeconds <= 0) {
                // UI updates on the exact tick it finishes
                this.plugin.persistentMenuManager.ensureMenus();
                this.handleSessionComplete();
            } else if (this.remainingSeconds % 60 === 0 || this.remainingSeconds < 60) {
                // Refresh UI every minute, and every second when under a minute
                this.plugin.persistentMenuManager.ensureMenus();
            }
        }, 1000);
    }

    private clearTick(): void {
        if (this.timerInterval !== null) {
            window.clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    private handleSessionComplete(): void {
        this.clearTick();

        if (this.currentState === 'work') {
            this.completedWorkSessions++;
            void this.finalizeTrackingEvent(true);

            const needsLongBreak = this.completedWorkSessions % this.plugin.settings.pomodoroLongBreakInterval === 0;
            this.notify('Work Session Complete', needsLongBreak ? 'Time for a long break!' : 'Time for a short break!');
            this.startBreak(needsLongBreak);

        } else if (this.currentState === 'short-break' || this.currentState === 'long-break') {
            this.currentState = 'idle';
            this.remainingSeconds = 0;
            this.plugin.persistentMenuManager.ensureMenus();
            this.notify('Break Complete', 'Ready to start another session?');
        }
    }

    private notify(title: string, body: string): void {
        // Send a native notice just in case
        new Notice(`${title}: ${body}`);

        // Dispatch to TPS Messager
        const notifApi = (this.app as any).plugins?.getPlugin('tps-notifier')?.api;
        if (notifApi && typeof notifApi.sendNotification === 'function') {
            notifApi.sendNotification(title, body, this.activeEventFile);
        } else {
            logger.warn('[PomodoroService] TPS Notifier plugin not found or API missing.');
        }
    }

    private async createTrackingEvent(): Promise<void> {
        const folderPath = this.plugin.settings.pomodoroEventFolder || 'Action Items/Events';
        const folder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            logger.warn('[PomodoroService] Event folder not found:', folderPath);
            return;
        }

        const dateStr = window.moment().format('YYYY-MM-DD');
        const filename = `Pomodoro Focus ${dateStr} ${Date.now()}.md`;
        const fullPath = `${folderPath}/${filename}`;

        const scheduledFormatted = window.moment().format('YYYY-MM-DD HH:mm:ss');

        // Ensure default tags are formatted correctly
        const rawTags = this.plugin.settings.pomodoroDefaultTags || 'pomodoro';
        const parsedTags = rawTags.split(',').map(t => t.trim().replace(/^#/, '')).filter(Boolean);

        const content = `---
title: Pomodoro Focus Session
scheduled: ${scheduledFormatted}
timeEstimate: ${this.plugin.settings.pomodoroWorkDuration}
status: working
tags:
${parsedTags.map(t => `  - ${t}`).join('\n')}
---
`;

        try {
            this.activeEventFile = await this.app.vault.create(fullPath, content);
        } catch (e) {
            logger.error('[PomodoroService] Failed to create event file', e);
        }
    }

    private async finalizeTrackingEvent(wasCompleted: boolean): Promise<void> {
        if (!this.activeEventFile) return;

        try {
            const updates: Record<string, any> = {};

            if (wasCompleted) {
                updates.status = 'complete';
            } else {
                updates.status = 'open'; // Revert back if cancelled
                // Recalculate duration based on how much was elapsed
                const elapsedSeconds = this.totalDurationSeconds - this.remainingSeconds;
                const elapsedMinutes = Math.max(1, Math.round(elapsedSeconds / 60));
                updates.timeEstimate = elapsedMinutes;
            }

            await this.plugin.bulkEditService.updateFrontmatter([this.activeEventFile], updates);
        } catch (e) {
            logger.error('[PomodoroService] Failed to finalize event file', e);
        }
    }

    public getFormattedRemainingTime(): string {
        const mins = Math.floor(this.remainingSeconds / 60);
        const secs = this.remainingSeconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
}
