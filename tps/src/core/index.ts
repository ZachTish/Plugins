// Lightweight proxy for core utilities used across the codebase.
export function getPluginById(...args: any[]): any {
  return undefined as any;
}

// Accepts both (id) and (app, id) call forms from different plugin contexts.
export function executeCommandById(...args: any[]): any {
  return undefined as any;
}

export function hasCommand(...args: any[]): boolean {
  return false;
}
/**
 * Core module exports
 */

export * from './type-guards';
export * from './error-utils';
