/**
 * Centralized logging utility for TPS Global Context Menu plugin
 */

let loggingEnabled = false;
const recentMessages = new Map<string, number>();
const DUPLICATE_WINDOW_MS = 3000;

export function setLoggingEnabled(value: boolean): void {
  loggingEnabled = !!value;
}

function shouldLog(level: "log" | "warn" | "error", message?: any, optionalParams: any[] = []): boolean {
  const head = typeof message === "string" ? message : String(message ?? "");
  const tail = optionalParams
    .map((item) => {
      if (item instanceof Error) return item.message;
      if (typeof item === "string") return item;
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .join("|");
  const key = `${level}:${head}:${tail}`;
  const now = Date.now();
  const last = recentMessages.get(key);
  if (last && now - last < DUPLICATE_WINDOW_MS) {
    return false;
  }
  recentMessages.set(key, now);
  if (recentMessages.size > 300) {
    for (const [entryKey, timestamp] of recentMessages.entries()) {
      if (now - timestamp > DUPLICATE_WINDOW_MS) {
        recentMessages.delete(entryKey);
      }
    }
  }
  return true;
}

export function log(message?: any, ...optionalParams: any[]): void {
  if (!loggingEnabled) return;
  if (!shouldLog("log", message, optionalParams)) return;
  console.log(`[Global Context Menu] ${message}`, ...optionalParams);
}

export function warn(message?: any, ...optionalParams: any[]): void {
  if (!loggingEnabled) return;
  if (!shouldLog("warn", message, optionalParams)) return;
  console.warn(`[Global Context Menu] ${message}`, ...optionalParams);
}

export function error(message?: any, ...optionalParams: any[]): void {
  // Always log errors, even when logging is disabled
  if (!shouldLog("error", message, optionalParams)) return;
  console.error(`[Global Context Menu] ${message}`, ...optionalParams);
}
