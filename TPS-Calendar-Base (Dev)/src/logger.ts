/**
 * Centralized logging utility for TPS Calendar Base plugin
 */

let loggingEnabled = false;

export function setLoggingEnabled(value: boolean): void {
  loggingEnabled = !!value;
}

export function log(message?: any, ...optionalParams: any[]): void {
  if (!loggingEnabled) return;
  console.log(`[Calendar Base] ${message}`, ...optionalParams);
}

export function warn(message?: any, ...optionalParams: any[]): void {
  if (!loggingEnabled) return;
  console.warn(`[Calendar Base] ${message}`, ...optionalParams);
}

export function error(message?: any, ...optionalParams: any[]): void {
  // Always log errors, even when logging is disabled
  console.error(`[Calendar Base] ${message}`, ...optionalParams);
}
