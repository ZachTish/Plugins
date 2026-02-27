/**
 * Centralized logging utility for TPS Smart Explorer plugin
 */

let loggingEnabled = false;

export function setLoggingEnabled(value: boolean): void {
  loggingEnabled = !!value;
}

export function log(message?: any, ...optionalParams: any[]): void {
  if (!loggingEnabled) return;
  console.log(`[Smart Explorer] ${message}`, ...optionalParams);
}

export function debug(message?: any, ...optionalParams: any[]): void {
  if (!loggingEnabled) return;
  console.debug(`[Smart Explorer] ${message}`, ...optionalParams);
}

export function info(message?: any, ...optionalParams: any[]): void {
  if (!loggingEnabled) return;
  console.info(`[Smart Explorer] ${message}`, ...optionalParams);
}

export function warn(message?: any, ...optionalParams: any[]): void {
  if (!loggingEnabled) return;
  console.warn(`[Smart Explorer] ${message}`, ...optionalParams);
}

export function error(message?: any, ...optionalParams: any[]): void {
  // Always log errors, even when logging is disabled
  console.error(`[Smart Explorer] ${message}`, ...optionalParams);
}
