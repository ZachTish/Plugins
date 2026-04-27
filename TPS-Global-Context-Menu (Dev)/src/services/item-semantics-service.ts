import type TPSGlobalContextMenuPlugin from '../main';
import { CheckboxPatterns } from '../core';

const INLINE_PROPERTY_RE = /\[([a-zA-Z0-9_-]+)::\s*([^\]]+)\]/g;

export interface ParsedMarkdownLine {
  kind: 'task' | 'bullet' | 'heading' | 'other';
  checkboxState: string | null;
  body: string;
}

export interface ParsedTaskLine extends ParsedMarkdownLine {
  text: string;
  inlineProperties: Record<string, string>;
  scheduledDateToken: string | null;
  scheduledTimeToken: string | null;
}

export class ItemSemanticsService {
  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  normalizeStatus(raw: unknown): string {
    return String(raw || '').trim().toLowerCase();
  }

  getCheckboxMappings(): Array<{ checkboxState: string; statuses: string[]; toggleTargetStatus?: string; icon?: string; label?: string }> {
    return this.plugin.settings.linkedSubitemCheckboxMappings || [];
  }

  mapStatusToCheckboxState(status: string): string {
    const normalized = this.normalizeStatus(status);
    for (const mapping of this.getCheckboxMappings()) {
      if (mapping.statuses.some((value) => this.normalizeStatus(value) === normalized)) {
        return mapping.checkboxState;
      }
    }
    return this.plugin.settings.linkedSubitemDefaultOpenState || '[ ]';
  }

  parseInlineProperties(text: string): Record<string, string> {
    const properties: Record<string, string> = {};
    INLINE_PROPERTY_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_PROPERTY_RE.exec(String(text || ''))) !== null) {
      const key = String(match[1] || '').trim().toLowerCase();
      const value = String(match[2] || '').trim();
      if (!key || !value) continue;
      properties[key] = value;
    }
    return properties;
  }

  extractInlineProperty(text: string, ...keys: string[]): string | null {
    const keySet = new Set(keys.map((key) => String(key || '').trim().toLowerCase()).filter(Boolean));
    if (keySet.size === 0) return null;
    const properties = this.parseInlineProperties(text);
    for (const key of keySet) {
      if (properties[key]) return properties[key];
    }
    return null;
  }

  extractInlineNumberProperty(text: string, ...keys: string[]): number | null {
    const value = this.extractInlineProperty(text, ...keys);
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  stripInlineProperties(text: string): string {
    return String(text || '').replace(/\s*\[[a-zA-Z0-9_-]+::\s*[^\]]+\]/g, '').trim();
  }

  cleanTaskText(raw: string): string {
    return String(raw || '')
      .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/🛫\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/@@\{[^}]+\}/g, '')
      .replace(/@\{[^}]+\}/g, '')
      .replace(/✅\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/➕\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/❌\s*\d{4}-\d{2}-\d{2}/g, '')
      .replace(/🔁\s*\S+/g, '')
      .replace(/\[[a-zA-Z0-9_-]+::\s*[^\]]+\]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  parseMarkdownLine(line: string): ParsedMarkdownLine {
    const taskMatch = String(line || '').match(CheckboxPatterns.ANY_CHECKBOX_CONTENT);
    if (taskMatch) {
      return {
        kind: 'task',
        checkboxState: `[${String(taskMatch[1] || '').trim()}]`,
        body: String(taskMatch[2] || ''),
      };
    }
    const headingMatch = String(line || '').match(/^[\t ]*(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      return {
        kind: 'heading',
        checkboxState: null,
        body: String(headingMatch[2] || ''),
      };
    }
    const bulletMatch = String(line || '').match(/^[\t ]*[-*+]\s+(.*)$/);
    if (bulletMatch) {
      return {
        kind: 'bullet',
        checkboxState: null,
        body: String(bulletMatch[1] || ''),
      };
    }
    return { kind: 'other', checkboxState: null, body: String(line || '') };
  }

  parseTaskLine(line: string): ParsedTaskLine | null {
    const raw = String(line || '');
    const taskMatch = raw.match(/^[\t ]*(?:[-*+]|\d+\.)\s+\[([^\]]*)\]\s+(.*)$/);
    const bulletMatch = taskMatch ? null : raw.match(/^[\t ]*(?:[-*+]|\d+\.)\s+(?!\[[^\]]+\]\s)(.*)$/);
    if (!taskMatch && !bulletMatch) return null;

    const body = String(taskMatch ? taskMatch[2] : bulletMatch?.[1] ?? '');
    return {
      kind: taskMatch ? 'task' : 'bullet',
      checkboxState: taskMatch ? `[${String(taskMatch[1] || '').trim()}]` : null,
      body,
      text: this.cleanTaskText(body),
      inlineProperties: this.parseInlineProperties(body),
      scheduledDateToken: body.match(/@\{([^}]+)\}/)?.[1]?.trim() || null,
      scheduledTimeToken: body.match(/@@\{([^}]+)\}/)?.[1]?.trim() || null,
    };
  }

}
