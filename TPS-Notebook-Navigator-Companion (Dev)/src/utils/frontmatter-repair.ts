export interface FrontmatterRepairResult {
  content: string;
  changed: boolean;
  fixes: string[];
}

interface FrontmatterBlock {
  bom: string;
  lineEnding: string;
  body: string;
  blockEnd: number;
  closingSuffix: string;
}

interface FrontmatterEntry {
  key: string | null;
  lines: string[];
  index: number;
}

const FRONTMATTER_BLOCK_PATTERN = /^(\uFEFF)?---(\r?\n)([\s\S]*?)(\r?\n)---(\r?\n|$)/;
const TOP_LEVEL_KEY_PATTERN = /^((?:"[^"]+")|(?:'[^']+')|[A-Za-z0-9_.-]+)\s*:(.*)$/;

export function repairFrontmatterText(content: string): FrontmatterRepairResult {
  const block = extractFrontmatterBlock(content);
  if (!block) {
    return {
      content,
      changed: false,
      fixes: []
    };
  }

  const entries = splitEntries(block.body);
  const { entries: dedupedEntries, deduped } = dedupeTopLevelKeys(entries);
  const sanitized = sanitizeDanglingScalarLines(dedupedEntries);
  const quoted = quoteUnsafeScalarValues(dedupedEntries);

  if (!deduped && !quoted && !sanitized) {
    return {
      content,
      changed: false,
      fixes: []
    };
  }

  const rebuiltBody = dedupedEntries.flatMap((entry) => entry.lines).join(block.lineEnding);
  const rebuiltBlock = `${block.bom}---${block.lineEnding}${rebuiltBody}${block.lineEnding}---${block.closingSuffix}`;
  const repairedContent = rebuiltBlock + content.slice(block.blockEnd);

  const fixes: string[] = [];
  if (deduped) {
    fixes.push("deduped-keys");
  }
  if (sanitized) {
    fixes.push("removed-dangling-lines");
  }
  if (quoted) {
    fixes.push("quoted-colon-values");
  }

  return {
    content: repairedContent,
    changed: repairedContent !== content,
    fixes
  };
}

function extractFrontmatterBlock(content: string): FrontmatterBlock | null {
  const match = FRONTMATTER_BLOCK_PATTERN.exec(content);
  if (!match) {
    return null;
  }

  return {
    bom: match[1] ?? "",
    lineEnding: match[2] ?? "\n",
    body: match[3] ?? "",
    blockEnd: match[0].length,
    closingSuffix: match[5] ?? ""
  };
}

function splitEntries(body: string): FrontmatterEntry[] {
  const lines = body.split(/\r?\n/);
  const entries: FrontmatterEntry[] = [];
  let active: FrontmatterEntry | null = null;

  for (const line of lines) {
    const key = getTopLevelKey(line);
    if (key) {
      active = {
        key,
        lines: [line],
        index: entries.length
      };
      entries.push(active);
      continue;
    }

    if (!active) {
      entries.push({
        key: null,
        lines: [line],
        index: entries.length
      });
      continue;
    }

    active.lines.push(line);
  }

  if (entries.length === 0) {
    entries.push({
      key: null,
      lines: [""],
      index: 0
    });
  }

  return entries;
}

function dedupeTopLevelKeys(entries: FrontmatterEntry[]): { entries: FrontmatterEntry[]; deduped: boolean } {
  const lastIndexByKey = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.key) {
      continue;
    }
    lastIndexByKey.set(entry.key, entry.index);
  }

  let deduped = false;
  const keptEntries: FrontmatterEntry[] = [];
  for (const entry of entries) {
    if (!entry.key) {
      keptEntries.push(entry);
      continue;
    }

    if (lastIndexByKey.get(entry.key) !== entry.index) {
      deduped = true;
      continue;
    }

    keptEntries.push(entry);
  }

  return {
    entries: keptEntries,
    deduped
  };
}

function quoteUnsafeScalarValues(entries: FrontmatterEntry[]): boolean {
  let changed = false;

  for (const entry of entries) {
    if (!entry.key || entry.lines.length === 0) {
      continue;
    }

    const firstLine = entry.lines[0];
    const parsed = parseTopLevelKeyValue(firstLine);
    if (!parsed) {
      continue;
    }

    const quotedValue = quoteScalarIfNeeded(parsed.value);
    if (!quotedValue) {
      continue;
    }

    const rewritten = `${parsed.key}: ${quotedValue}`;
    if (rewritten !== firstLine) {
      entry.lines[0] = rewritten;
      changed = true;
    }
  }

  return changed;
}

function sanitizeDanglingScalarLines(entries: FrontmatterEntry[]): boolean {
  let changed = false;

  for (const entry of entries) {
    if (!entry.key || entry.lines.length < 2) {
      continue;
    }

    const firstLine = entry.lines[0];
    const parsed = parseTopLevelKeyValue(firstLine);
    if (!parsed) {
      continue;
    }

    if (isStructuredYamlValue(parsed.value)) {
      continue;
    }

    const keptLines = [firstLine];
    for (let idx = 1; idx < entry.lines.length; idx += 1) {
      const line = entry.lines[idx] ?? "";
      if (line.trim().length === 0) {
        keptLines.push(line);
        continue;
      }
      if (line.startsWith(" ") || line.startsWith("\t")) {
        keptLines.push(line);
        continue;
      }
      if (line.startsWith("#")) {
        keptLines.push(line);
        continue;
      }
      if (line.startsWith("- ")) {
        keptLines.push(line);
        continue;
      }

      changed = true;
    }

    entry.lines = keptLines;
  }

  return changed;
}

function parseTopLevelKeyValue(line: string): { key: string; value: string } | null {
  const match = TOP_LEVEL_KEY_PATTERN.exec(line);
  if (!match) {
    return null;
  }

  return {
    key: match[1] ?? "",
    value: (match[2] ?? "").trim()
  };
}

function getTopLevelKey(line: string): string | null {
  const match = TOP_LEVEL_KEY_PATTERN.exec(line);
  if (!match) {
    return null;
  }

  return match[1] ?? null;
}

function quoteScalarIfNeeded(value: string): string | null {
  if (!value || !/:\s/.test(value)) {
    return null;
  }

  if (
    value.startsWith('"') ||
    value.startsWith("'") ||
    value.startsWith("[") ||
    value.startsWith("{") ||
    value.startsWith("|") ||
    value.startsWith(">") ||
    value.startsWith("&") ||
    value.startsWith("*") ||
    value.startsWith("!")
  ) {
    return null;
  }

  return JSON.stringify(value);
}

function isStructuredYamlValue(value: string): boolean {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }

  return (
    normalized === "|" ||
    normalized === ">" ||
    normalized.startsWith("|") ||
    normalized.startsWith(">") ||
    normalized === "[]" ||
    normalized === "{}" ||
    normalized.startsWith("[") ||
    normalized.startsWith("{") ||
    normalized.startsWith("&") ||
    normalized.startsWith("*") ||
    normalized.startsWith("!")
  );
}
