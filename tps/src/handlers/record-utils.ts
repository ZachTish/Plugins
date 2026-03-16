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
  const normalized = casefold(key);
  if (!normalized) {
    return;
  }

  for (const candidate of Object.keys(target ?? {})) {
    if (casefold(candidate) === normalized) {
      delete target[candidate];
    }
  }

  target[key] = value;
}

export function deleteValueCaseInsensitive(target: Record<string, unknown>, key: string): void {
  const normalized = casefold(key);
  if (!normalized) {
    return;
  }

  for (const candidate of Object.keys(target ?? {})) {
    if (casefold(candidate) === normalized) {
      delete target[candidate];
    }
  }
}

export function keysMatchCaseInsensitive(left: string, right: string): boolean {
  return casefold(left) === casefold(right);
}
