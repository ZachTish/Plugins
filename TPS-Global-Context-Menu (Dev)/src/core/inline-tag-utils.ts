export interface NumericRange {
  start: number;
  end: number;
}

function mergeRanges(ranges: NumericRange[]): NumericRange[] {
  if (ranges.length === 0) {
    return [];
  }

  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: NumericRange[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) {
      merged.push({ ...range });
      continue;
    }
    if (range.end > last.end) {
      last.end = range.end;
    }
  }

  return merged;
}

function isIndexInRanges(index: number, ranges: NumericRange[]): boolean {
  for (const range of ranges) {
    if (index < range.start) {
      return false;
    }
    if (index >= range.start && index < range.end) {
      return true;
    }
  }
  return false;
}

function findFrontmatterBoundary(content: string): number {
  const frontmatterMatch = content.match(/^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  return frontmatterMatch ? frontmatterMatch[0].length : 0;
}

function findFencedCodeBlockRanges(content: string): NumericRange[] {
  const ranges: NumericRange[] = [];

  let index = 0;
  let inFence = false;
  let fenceStart = 0;
  let markerChar = "";
  let markerLength = 0;

  while (index < content.length) {
    const lineEnd = content.indexOf("\n", index);
    const segmentEnd = lineEnd === -1 ? content.length : lineEnd + 1;
    const rawLine = content.slice(index, lineEnd === -1 ? content.length : lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trimStart();

    if (!inFence) {
      const openMatch = trimmed.match(/^(`{3,}|~{3,})/);
      if (openMatch) {
        inFence = true;
        fenceStart = index;
        markerChar = openMatch[1].charAt(0);
        markerLength = openMatch[1].length;
      }
    } else {
      const closeMatch = trimmed.match(/^(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[1].charAt(0) === markerChar && closeMatch[1].length >= markerLength) {
        ranges.push({ start: fenceStart, end: segmentEnd });
        inFence = false;
        markerChar = "";
        markerLength = 0;
      }
    }

    if (lineEnd === -1) {
      break;
    }
    index = lineEnd + 1;
  }

  if (inFence) {
    ranges.push({ start: fenceStart, end: content.length });
  }

  return ranges;
}

function findInlineCodeRanges(content: string, fencedRanges: NumericRange[]): NumericRange[] {
  const ranges: NumericRange[] = [];

  let index = 0;
  while (index < content.length) {
    if (isIndexInRanges(index, fencedRanges)) {
      const fence = fencedRanges.find((range) => index >= range.start && index < range.end);
      index = fence ? fence.end : index + 1;
      continue;
    }

    if (content.charAt(index) !== "`") {
      index += 1;
      continue;
    }

    let tickLength = 1;
    while (content.charAt(index + tickLength) === "`") {
      tickLength += 1;
    }

    const marker = "`".repeat(tickLength);
    let search = index + tickLength;
    let closedAt = -1;

    while (search < content.length) {
      if (isIndexInRanges(search, fencedRanges)) {
        const fence = fencedRanges.find((range) => search >= range.start && search < range.end);
        search = fence ? fence.end : search + 1;
        continue;
      }

      if (content.startsWith(marker, search)) {
        closedAt = search;
        break;
      }
      search += 1;
    }

    if (closedAt !== -1) {
      ranges.push({ start: index, end: closedAt + tickLength });
      index = closedAt + tickLength;
    } else {
      index += tickLength;
    }
  }

  return ranges;
}

function findHtmlTagRanges(content: string): NumericRange[] {
  const ranges: NumericRange[] = [];
  const htmlPattern = /<\/?[A-Za-z](?:[\w:-]*)(?:\s[^<>]*?)?>/g;
  let match: RegExpExecArray | null;

  while ((match = htmlPattern.exec(content)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  return ranges;
}

function computeExclusionRanges(content: string): NumericRange[] {
  const fenced = findFencedCodeBlockRanges(content);
  const inline = findInlineCodeRanges(content, fenced);
  const html = findHtmlTagRanges(content);
  return mergeRanges([...fenced, ...inline, ...html]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function removeInlineTagsSafely(content: string, normalizedTags: string[]): string {
  if (!content || normalizedTags.length === 0) {
    return content;
  }

  const frontmatterBoundary = findFrontmatterBoundary(content);
  const frontmatterPart = content.slice(0, frontmatterBoundary);
  let bodyPart = content.slice(frontmatterBoundary);
  let changed = false;

  const tags = Array.from(new Set(normalizedTags.filter(Boolean))).sort((left, right) => right.length - left.length);
  for (const tag of tags) {
    if (!tag) {
      continue;
    }
    const pattern = new RegExp(`(^|\\s)#${escapeRegExp(tag)}(?![\\w/-])`, "giu");
    const exclusions = computeExclusionRanges(bodyPart);
    bodyPart = bodyPart.replace(pattern, (match: string, prefix: string, offset: number) => {
      const tagIndex = offset + (prefix?.length ?? 0);
      if (isIndexInRanges(tagIndex, exclusions)) {
        return match;
      }
      changed = true;
      return prefix ?? "";
    });
  }

  if (!changed) {
    return content;
  }

  return `${frontmatterPart}${bodyPart}`;
}
