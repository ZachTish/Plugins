/**
 * Centralized logging utility for TPS Notifier plugin
 */

let loggingEnabled = false;

export function setLoggingEnabled(value: boolean): void {
  loggingEnabled = !!value;
}

export function log(message?: any, ...optionalParams: any[]): void {
  if (!loggingEnabled) return;
  console.log(`[TPS Notifier] ${message}`, ...optionalParams);
}

export function warn(message?: any, ...optionalParams: any[]): void {
  if (!loggingEnabled) return;
  console.warn(`[TPS Notifier] ${message}`, ...optionalParams);
}

export function error(message?: any, ...optionalParams: any[]): void {
  // Always log errors, even when logging is disabled
  console.error(`[TPS Notifier] ${message}`, ...optionalParams);
}
