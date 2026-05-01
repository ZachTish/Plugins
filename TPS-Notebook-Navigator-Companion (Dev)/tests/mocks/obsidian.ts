export function normalizePath(path: string): string {
  return String(path || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/(^|[^:])\/\/$/, "$1/");
}