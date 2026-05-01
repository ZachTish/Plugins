import type { TFile } from 'obsidian';
import type { TPSMessagerSettings } from './types';

type TransportSettings = Pick<TPSMessagerSettings, 'enabled' | 'ntfyServer' | 'ntfyTopic' | 'ntfyPriority'>;

export type NotificationSendReadiness = 'disabled' | 'missing-config' | 'ready';

export function buildObsidianLink(vaultName: string, file?: TFile): string {
    if (!file) return '';
    return `obsidian://tps-messager?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(file.path)}`;
}

export function buildNtfyUrl(server: string, topic: string): string | null {
    const base = String(server || '').replace(/\/+$/, '');
    const cleanTopic = String(topic || '').trim();
    if (!base || !cleanTopic) return null;
    return `${base}/${cleanTopic}`;
}

export function sanitizeNotificationTitle(title?: string): string {
    return String(title || 'TPS Messager').replace(/[^\x00-\xFF]/g, '');
}

export function getNotificationSendReadiness(settings: TransportSettings): NotificationSendReadiness {
    if (!settings.enabled) return 'disabled';
    return buildNtfyUrl(settings.ntfyServer, settings.ntfyTopic) ? 'ready' : 'missing-config';
}

export function buildNtfyHeaders(settings: TransportSettings, title?: string, clickLink?: string): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Title': sanitizeNotificationTitle(title),
        'Priority': String(settings.ntfyPriority || 3),
        'Markdown': 'yes',
    };

    if (clickLink) {
        headers.Click = clickLink;
    }

    return headers;
}