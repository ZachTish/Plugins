export function casefold(value: string): string {
  return String(value ?? "").trim().toLowerCase();
}

export function findKeyCaseInsensitive(target: Record<string, unknown>, key: string): string | null {
  const normalized = casefold(key);
  if (!normalized) {
    return null;
  }

  for (const candidate of Object.keys(target ?? {})) {
    if (casefold(candidate) === normalized) {
      return candidate;
    }
  }

  return null;
}

export function setValueCaseInsensitive(target: Record<string, unknown>, key: string, value: unknown): void {
  const existing = findKeyCaseInsensitive(target, key);
  const destination = existing ?? key;
  target[destination] = value;
  if (existing && existing !== key && key in target) {
    delete target[key];
  }
}

export function deleteValueCaseInsensitive(target: Record<string, unknown>, key: string): void {
  const existing = findKeyCaseInsensitive(target, key);
  if (!existing) {
    return;
  }
  delete target[existing];
}

export function keysMatchCaseInsensitive(left: string, right: string): boolean {
  return casefold(left) === casefold(right);
}
