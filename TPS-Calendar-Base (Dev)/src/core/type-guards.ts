/**
 * type-guards.ts — Safe typed accessors for Obsidian's private plugin registry.
 */
import type { App, Plugin } from 'obsidian';

interface AppWithPluginsRegistry extends App {
    plugins?: {
        getPlugin?: (id: string) => Plugin | null;
        plugins?: Record<string, Plugin>;
        enabledPlugins?: Set<string> | string[];
    };
}

/**
 * Look up a community plugin by its manifest ID.
 * Returns null when the plugin is not installed or not yet loaded.
 */
export function getPluginById<T extends Plugin = Plugin>(
    app: App,
    pluginId: string,
): T | null {
    const reg = app as AppWithPluginsRegistry;
    const direct = reg.plugins?.getPlugin?.(pluginId);
    if (direct) return direct as T;
    return (reg.plugins?.plugins?.[pluginId] as T) ?? null;
}

/**
 * Retrieve the settings object of a community plugin.
 * Returns an empty record when the plugin or its settings are unavailable.
 */
export function getPluginSettings<T extends Record<string, unknown> = Record<string, unknown>>(
    app: App,
    pluginId: string,
): T {
    const plugin = getPluginById(app, pluginId);
    const settings = (plugin as any)?.settings;
    return (settings && typeof settings === 'object' ? settings : {}) as T;
}

/** Returns true when `value` is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
