import { App, TFile, normalizePath } from 'obsidian';
import { ParentLinkPromptModal, ParentLinkIssue } from './parent-link-prompt-modal';
import * as logger from './logger';
import { extractLinkTarget, normalizeParentLinkFormat, resolveLinkValueToFile } from './parent-link-format';
import type { ParentLinkFormat } from './types';

export class ParentLinkHandler {
  private app: App;
  private getSettings: () => any;

  constructor(app: App, getSettings: () => any) {
    this.app = app;
    this.getSettings = getSettings;
  }

  isCompletionStatus(status: string): boolean {
    const list = this.getSettings().parentCompletionStatuses?.length
      ? this.getSettings().parentCompletionStatuses
      : ['complete', 'wont-do'];
    return list.map((s: string) => String(s || '').trim().toLowerCase()).includes(String(status || '').trim().toLowerCase());
  }

  normalizeParentKey(): string {
    const key = String(this.getSettings().parentLinkFrontmatterKey || 'parent').trim();
    return key || 'parent';
  }

  normalizeParentLinkFormat(): ParentLinkFormat {
    return normalizeParentLinkFormat(this.getSettings().parentLinkFormat);
  }

  private normalizeStatusValue(value: any): string {
    return String(value || '').trim().toLowerCase();
  }

  private resolveParentValueToPath(value: any, sourcePath: string): string | null {
    const resolved = resolveLinkValueToFile(this.app, value, sourcePath);
    if (resolved) return resolved.path;

    const fallback = extractLinkTarget(value);
    if (!fallback) return null;
    return normalizePath(fallback);
  }

  private parentValueMatchesTarget(value: any, sourcePath: string, target: TFile): boolean {
    const resolvedPath = this.resolveParentValueToPath(value, sourcePath);
    if (!resolvedPath) return false;
    if (resolvedPath === target.path) return true;
    if (resolvedPath === target.path.replace(/\.md$/, '')) return true;
    if (resolvedPath === target.basename) return true;
    if (resolvedPath === target.basename.replace(/\.md$/, '')) return true;
    return false;
  }

  async findParentLinkIssues(target: TFile): Promise<ParentLinkIssue[]> {
    const key = this.normalizeParentKey();
    const completionStatuses = this.getSettings().parentCompletionStatuses?.length
      ? this.getSettings().parentCompletionStatuses
      : ['complete', 'wont-do'];
    const completionSet = new Set(completionStatuses.map((s: string) => this.normalizeStatusValue(s)));

    const issues: ParentLinkIssue[] = [];
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      if (file.path === target.path) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter || {};
      if (!(key in fm)) continue;
      const raw = fm[key];
      const values = Array.isArray(raw) ? raw : [raw];
      const matches = values.some((val: any) => this.parentValueMatchesTarget(val, file.path, target));
      if (!matches) continue;
      const statusValue = this.normalizeStatusValue(fm.status);
      if (!completionSet.has(statusValue)) {
        issues.push({ path: file.path, status: statusValue || 'unset' });
      }
    }
    return issues;
  }

  /**
   * Prompt user about incomplete child tasks before completing a parent.
   * Returns true if the status change should proceed, false to abort.
   */
  async handleParentLinkCompletion(file: TFile, enableLogging: boolean): Promise<boolean> {
    if (enableLogging) {
      logger.log("[TPS GCM] Parent-link check start", {
        file: file.path,
        key: this.normalizeParentKey(),
        completionStatuses: this.getSettings().parentCompletionStatuses
      });
    }
    const issues = await this.findParentLinkIssues(file);
    if (enableLogging) {
      logger.log("[TPS GCM] Parent-link issues", { count: issues.length, issues });
    }
    if (issues.length === 0) return true;

    const userAction = await new Promise<string>((resolve) => {
      new ParentLinkPromptModal(this.app, issues, (result) => {
        resolve(result);
      }).open();
    });

    if (userAction === 'open') {
      const leaf = this.app.workspace.getLeaf(false);
      const first = issues[0];
      if (leaf && first) {
        const target = this.app.vault.getAbstractFileByPath(first.path);
        if (target instanceof TFile) {
          await leaf.openFile(target);
        }
      }
      return false;
    }

    if (userAction === 'cancel') {
      return false;
    }

    return true;
  }
}
