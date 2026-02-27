const recentMessages = new Map<string, number>();
const DUPLICATE_WINDOW_MS = 3000;

function shouldLog(level: "warn" | "error", message?: unknown, optionalParams: unknown[] = []): boolean {
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
  if (last && now - last < DUPLICATE_WINDOW_MS) return false;
  recentMessages.set(key, now);
  if (recentMessages.size > 200) {
    for (const [entryKey, timestamp] of recentMessages.entries()) {
      if (now - timestamp > DUPLICATE_WINDOW_MS) {
        recentMessages.delete(entryKey);
      }
    }
  }
  return true;
}

export function warn(message?: unknown, ...optionalParams: unknown[]): void {
  if (!shouldLog("warn", message, optionalParams)) return;
  console.warn(`[Feed Bases] ${message}`, ...optionalParams);
}

export function error(message?: unknown, ...optionalParams: unknown[]): void {
  if (!shouldLog("error", message, optionalParams)) return;
  console.error(`[Feed Bases] ${message}`, ...optionalParams);
}
