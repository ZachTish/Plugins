import type { App, Plugin } from "obsidian";

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface InternalPlugin {
  enabled?: boolean;
  instance?: unknown;
}

interface AppWithInternalPlugins extends App {
  internalPlugins?: {
    getPluginById?: (id: string) => InternalPlugin | undefined;
    plugins?: Record<string, InternalPlugin>;
  };
}

interface AppWithCommands extends App {
  commands?: {
    executeCommandById?: (id: string) => boolean;
    findCommand?: (id: string) => unknown;
  };
}

interface AppWithPluginsRegistry extends App {
  plugins?: {
    getPlugin?: (id: string) => Plugin | null;
    plugins?: Record<string, Plugin>;
    enabledPlugins?: Set<string>;
  };
}

export function getInternalPlugin<T = InternalPlugin>(app: App, pluginId: string): T | undefined {
  const source = app as AppWithInternalPlugins;
  const byId = source.internalPlugins?.getPluginById?.(pluginId);
  if (byId) {
    return byId as T;
  }
  const fromRecord = source.internalPlugins?.plugins?.[pluginId];
  if (fromRecord) {
    return fromRecord as T;
  }
  return undefined;
}

export function executeCommandById(app: App, commandId: string): boolean {
  const withCommands = app as AppWithCommands;
  try {
    return withCommands.commands?.executeCommandById?.(commandId) ?? false;
  } catch {
    return false;
  }
}

export function hasCommand(app: App, commandId: string): boolean {
  const withCommands = app as AppWithCommands;
  try {
    return Boolean(withCommands.commands?.findCommand?.(commandId));
  } catch {
    return false;
  }
}

export function getPluginById<T extends Plugin = Plugin>(app: App, pluginId: string): T | null {
  const withPlugins = app as AppWithPluginsRegistry;

  const direct = withPlugins.plugins?.getPlugin?.(pluginId);
  if (direct) {
    return direct as T;
  }

  return (withPlugins.plugins?.plugins?.[pluginId] as T) ?? null;
}
