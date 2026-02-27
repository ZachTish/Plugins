import { isRecord } from "./type-guards";

export function getErrorMessage(error: unknown, fallback = "Unknown error"): string {
  if (error instanceof Error && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  if (isRecord(error) && typeof error.message === "string" && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }

  if (isRecord(error)) {
    try {
      return JSON.stringify(error);
    } catch {
      return fallback;
    }
  }

  return fallback;
}
