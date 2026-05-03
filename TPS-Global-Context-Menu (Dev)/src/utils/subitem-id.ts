export const SUBITEM_ID_KEY = 'tpsId';
export const LEGACY_SUBITEM_ID_KEY = 'subitemId';

export function normalizeSubitemId(value: unknown): string {
  return String(value || '').trim();
}

export function generateSubitemId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `si_${timestamp}${random}`;
}

export function getSubitemIdFromRecord(record: Record<string, unknown> | null | undefined): string {
  if (!record || typeof record !== 'object') return '';
  const acceptedKeys = new Set([
    SUBITEM_ID_KEY.toLowerCase(),
    LEGACY_SUBITEM_ID_KEY.toLowerCase(),
  ]);
  for (const [key, value] of Object.entries(record)) {
    if (!acceptedKeys.has(String(key || '').trim().toLowerCase())) continue;
    const normalized = normalizeSubitemId(value);
    if (normalized) return normalized;
  }
  return '';
}
