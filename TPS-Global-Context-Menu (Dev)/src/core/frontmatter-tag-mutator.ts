export interface FrontmatterTagField {
  key: string;
  lowerKey: string;
  isAlias: boolean;
  value: string | unknown[];
  set(nextValue: string | unknown[]): void;
  remove(): void;
}

export type FrontmatterTagMutator = (field: FrontmatterTagField) => void;

export function mutateFrontmatterTagFields(frontmatter: Record<string, unknown>, mutator: FrontmatterTagMutator): boolean {
  let changed = false;

  const visit = (key: string, lowerKey: string, current: string | unknown[]) => {
    const field: FrontmatterTagField = {
      key,
      lowerKey,
      isAlias: lowerKey === "aliases" || lowerKey === "alias",
      value: current,
      set: (nextValue: string | unknown[]) => {
        const existing = frontmatter[key];
        if (Array.isArray(existing) && Array.isArray(nextValue)) {
          if (existing.length === nextValue.length && existing.every((entry, index) => entry === nextValue[index])) {
            return;
          }
        } else if (existing === nextValue) {
          return;
        }
        frontmatter[key] = nextValue;
        changed = true;
      },
      remove: () => {
        if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
          delete frontmatter[key];
          changed = true;
        }
      },
    };

    mutator(field);
  };

  for (const key of Object.keys(frontmatter)) {
    const value = frontmatter[key];
    if (typeof value !== "string" && !Array.isArray(value)) {
      continue;
    }

    const lowerKey = key.toLowerCase();
    if (lowerKey === "tags" || lowerKey === "tag" || lowerKey === "alias" || lowerKey === "aliases") {
      visit(key, lowerKey, value);
    }
  }

  return changed;
}
