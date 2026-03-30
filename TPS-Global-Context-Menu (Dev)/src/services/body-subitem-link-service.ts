import { TFile } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import type { BodySubitemLink, BodySubitemLineKind } from './subitem-types';
import { resolveLinkTargetToFile } from './link-target-service';

type ParsedLine = {
  kind: BodySubitemLineKind;
  checkboxState: string | null;
  wikilink: string;
  linkTarget: string;
};

const WIKILINK_ONLY_REGEX = /^\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]$/;
const BULLET_OR_NUMBER_REGEX = /^(?:[-*+]|\d+\.)$/;

export class BodySubitemLinkService {
  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  async scanFile(file: TFile): Promise<BodySubitemLink[]> {
    if (file.extension?.toLowerCase() !== 'md') return [];
    const raw = this.plugin.subitemRelationshipSyncService
      ? await this.plugin.subitemRelationshipSyncService.readMarkdownText(file)
      : await this.plugin.app.vault.cachedRead(file);
    return this.scanText(file, raw);
  }

  scanText(parentFile: TFile, raw: string): BodySubitemLink[] {
    const lines = String(raw || '').split('\n');
    const output: BodySubitemLink[] = [];
    for (let index = 0; index < lines.length; index++) {
      const parsed = this.parseLine(lines[index] || '');
      if (!parsed) continue;
      const childFile = resolveLinkTargetToFile(this.plugin.app, parsed.linkTarget, parentFile.path);
      if (!(childFile instanceof TFile) || childFile.extension?.toLowerCase() !== 'md' || childFile.path === parentFile.path) {
        continue;
      }
      output.push({
        parentPath: parentFile.path,
        childPath: childFile.path,
        line: index,
        kind: parsed.kind,
        checkboxState: parsed.checkboxState,
        wikilink: parsed.wikilink,
        rawLine: lines[index] || '',
        parentFile,
        childFile,
      });
    }
    return output;
  }

  parseLine(rawLine: string): ParsedLine | null {
    const trimmed = String(rawLine || '').trim();
    if (!trimmed) return null;

    const malformedCheckbox = this.matchMalformedCheckboxLink(trimmed);
    if (malformedCheckbox) {
      return malformedCheckbox;
    }

    const bareCheckboxMatch = this.matchCheckboxPrefix(trimmed);
    if (bareCheckboxMatch) {
      const link = this.extractSingleWikilink(bareCheckboxMatch.remainder);
      if (link) {
        return {
          kind: 'checkbox',
          checkboxState: bareCheckboxMatch.token,
          wikilink: link.full,
          linkTarget: link.target,
        };
      }
    }

    const bare = this.extractSingleWikilink(trimmed);
    if (bare) {
      return {
        kind: 'bare',
        checkboxState: null,
        wikilink: bare.full,
        linkTarget: bare.target,
      };
    }

    const bulletMatch = trimmed.match(/^((?:[-*+]|\d+\.)\s+)(.+)$/);
    if (!bulletMatch) return null;
    const remainder = String(bulletMatch[2] || '').trim();
    const checkboxMatch = this.matchCheckboxPrefix(remainder);
    if (checkboxMatch) {
      const link = this.extractSingleWikilink(checkboxMatch.remainder);
      if (!link) return null;
      return {
        kind: 'checkbox',
        checkboxState: checkboxMatch.token,
        wikilink: link.full,
        linkTarget: link.target,
      };
    }

    const link = this.extractSingleWikilink(remainder);
    if (!link) return null;
    return {
      kind: 'bullet',
      checkboxState: null,
      wikilink: link.full,
      linkTarget: link.target,
    };
  }

  async isBodyLinkedSubitem(parentFile: TFile, childFile: TFile): Promise<boolean> {
    const links = await this.scanFile(parentFile);
    return links.some((entry) => entry.childPath === childFile.path);
  }

  getConfiguredCheckboxStates(): string[] {
    const configured = (this.plugin.settings.linkedSubitemCheckboxMappings || [])
      .map((entry) => String(entry.checkboxState || '').trim())
      .filter(Boolean);
    return configured.length > 0 ? configured : ['[ ]', '[x]', '[\\]', '[?]', '[-]'];
  }

  private extractSingleWikilink(text: string): { full: string; target: string } | null {
    const matches = Array.from(text.matchAll(/\[\[[^\]]+\]\]/g));
    if (matches.length !== 1) return null;
    const full = String(matches[0]?.[0] || '').trim();
    if (text !== full) return null;
    const parsed = full.match(WIKILINK_ONLY_REGEX);
    if (!parsed) return null;
    return {
      full,
      target: String(parsed[1] || '').trim(),
    };
  }

  private matchCheckboxPrefix(text: string): { token: string; remainder: string } | null {
    for (const state of this.getConfiguredCheckboxStates()) {
      if (text.startsWith(`${state} `)) {
        return {
          token: state,
          remainder: text.slice(state.length).trim(),
        };
      }
      if (text.startsWith(state) && /^\[\[[^\]]+\]\]$/.test(text.slice(state.length).trim())) {
        return {
          token: state,
          remainder: text.slice(state.length).trim(),
        };
      }
    }
    return null;
  }

  private matchMalformedCheckboxLink(text: string): ParsedLine | null {
    const bulletMatch = text.match(/^((?:[-*+]|\d+\.)\s+)\[(?!\[)([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]$/);
    if (!bulletMatch) return null;
    return {
      kind: 'checkbox',
      checkboxState: '[ ]',
      wikilink: `[[${String(bulletMatch[2] || '').trim()}${bulletMatch[3] ? `|${String(bulletMatch[3]).trim()}` : ''}]]`,
      linkTarget: String(bulletMatch[2] || '').trim(),
    };
  }
}
