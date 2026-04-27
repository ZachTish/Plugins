import { Notice, TFile } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import type { SubitemRelationshipMismatch } from './subitem-types';
import {
  SubitemRelationshipMismatchModal,
  type SubitemRelationshipMismatchResolution,
} from '../modals/subitem-relationship-mismatch-modal';
import { getDailyNoteResolver } from '../../../TPS-Controller (Dev)/src/utils/daily-note-resolver';

export class SubitemRelationshipGuardService {
  private processingPaths = new Set<string>();

  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  async handleFileOpen(file: TFile): Promise<void> {
    if (!(file instanceof TFile) || file.extension?.toLowerCase() !== 'md') return;
    if (this.processingPaths.has(file.path)) return;

    this.processingPaths.add(file.path);
    try {
      const mismatches = await this.collectMismatchesForFile(file);
      console.debug?.('[TPS GCM] [RelationshipGuard] file-open scan', {
        file: file.path,
        mismatchCount: mismatches.length,
        mismatches: mismatches.map((mismatch) => ({
          kind: mismatch.kind,
          parentFile: mismatch.parentFile.path,
          childFile: mismatch.childFile.path,
        })),
      });
      for (const mismatch of mismatches) {
        if (!(await this.mismatchStillExists(mismatch))) continue;
        const resolution = await this.promptForMismatchResolution(mismatch);
        if (resolution === 'cancel' || resolution === 'snooze') break;
        await this.applyResolution(mismatch, resolution);
      }
    } finally {
      this.processingPaths.delete(file.path);
    }
  }

  private async collectMismatchesForFile(file: TFile): Promise<SubitemRelationshipMismatch[]> {
    const output: SubitemRelationshipMismatch[] = [];
    const seen = new Set<string>();

    const addMismatch = (mismatch: SubitemRelationshipMismatch) => {
      const key = `${mismatch.kind}|${mismatch.parentFile.path}|${mismatch.childFile.path}`;
      if (seen.has(key)) return;
      seen.add(key);
      output.push(mismatch);
    };

    const bodyLinks = await this.plugin.bodySubitemLinkService.scanFile(file);
    const parentIsDailyNote = this.plugin.fileNamingService.isDateOnlyBasename(file.basename);
    for (const link of bodyLinks) {
      if (!this.plugin.parentLinkResolutionService.hasParent(link.childFile, file)) {
        if (parentIsDailyNote) continue;
        if (this.isScheduledDateMatch(file, link.childFile)) continue;
        addMismatch({
          kind: 'body-only',
          parentFile: file,
          childFile: link.childFile,
          line: link.line,
          rawLine: link.rawLine,
        });
      }
    }

    for (const candidateChild of this.plugin.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path))) {
      if (candidateChild.path === file.path) continue;
      if (!this.plugin.parentLinkResolutionService.hasParent(candidateChild, file)) continue;
      if (this.isCalendarManagedPromotedChild(candidateChild)) continue;
      if (await this.plugin.bodySubitemLinkService.isBodyLinkedSubitem(file, candidateChild)) continue;
      addMismatch({
        kind: 'frontmatter-only',
        parentFile: file,
        childFile: candidateChild,
      });
    }

    return output;
  }

  private async mismatchStillExists(mismatch: SubitemRelationshipMismatch): Promise<boolean> {
    if (mismatch.kind === 'body-only') {
      if (this.plugin.fileNamingService.isDateOnlyBasename(mismatch.parentFile.basename)) return false;
      if (this.isScheduledDateMatch(mismatch.parentFile, mismatch.childFile)) return false;
      return (
        await this.plugin.bodySubitemLinkService.isBodyLinkedSubitem(mismatch.parentFile, mismatch.childFile)
      ) && !this.plugin.parentLinkResolutionService.hasParent(mismatch.childFile, mismatch.parentFile);
    }

    return (
      this.plugin.parentLinkResolutionService.hasParent(mismatch.childFile, mismatch.parentFile) &&
      !this.isCalendarManagedPromotedChild(mismatch.childFile) &&
      !(await this.plugin.bodySubitemLinkService.isBodyLinkedSubitem(mismatch.parentFile, mismatch.childFile))
    );
  }

  private async promptForMismatchResolution(
    mismatch: SubitemRelationshipMismatch,
  ): Promise<SubitemRelationshipMismatchResolution> {
    return await new Promise<SubitemRelationshipMismatchResolution>((resolve) => {
      new SubitemRelationshipMismatchModal(this.plugin.app, mismatch, resolve).open();
    });
  }

  private async applyResolution(
    mismatch: SubitemRelationshipMismatch,
    resolution: SubitemRelationshipMismatchResolution,
  ): Promise<void> {
    console.debug?.('[TPS GCM] [RelationshipGuard] applying resolution', {
      resolution,
      kind: mismatch.kind,
      parentFile: mismatch.parentFile.path,
      childFile: mismatch.childFile.path,
    });

    switch (resolution) {
      case 'restore-parent-link':
        await this.plugin.parentLinkResolutionService.addParentToChild(mismatch.childFile, mismatch.parentFile);
        new Notice(`Restored parent link on "${mismatch.childFile.basename}".`);
        break;
      case 'remove-body-link':
        await this.plugin.subitemRelationshipSyncService.removeBodyLinkOnly(mismatch.parentFile, mismatch.childFile);
        new Notice(`Removed body subitem link from "${mismatch.parentFile.basename}".`);
        break;
      case 'detach-body-link':
        await this.plugin.parentLinkResolutionService.removeParentFromChild(mismatch.childFile, mismatch.parentFile);
        await this.plugin.subitemRelationshipSyncService.detachBodyLinkOnly(mismatch.parentFile, mismatch.childFile);
        new Notice(`Detached managed subitem behavior for "${mismatch.childFile.basename}".`);
        break;
      case 'restore-body-link': {
        const changed = await this.plugin.subitemRelationshipSyncService.insertBodyLink(
          mismatch.parentFile,
          mismatch.childFile,
          undefined,
          { insertionMode: 'after-frontmatter' },
        );
        console.debug?.('[TPS GCM] [RelationshipGuard] restore-body-link result', {
          parentFile: mismatch.parentFile.path,
          childFile: mismatch.childFile.path,
          changed,
        });
        new Notice(
          changed
            ? `Restored body subitem link in "${mismatch.parentFile.basename}".`
            : `Body subitem link was not written in "${mismatch.parentFile.basename}".`,
        );
        break;
      }
      case 'remove-parent-link':
        await this.plugin.parentLinkResolutionService.removeParentFromChild(mismatch.childFile, mismatch.parentFile);
        new Notice(`Removed parent link from "${mismatch.childFile.basename}".`);
        break;
      default:
        return;
    }

    await this.refreshAffectedFiles(mismatch);
  }

  private async refreshAffectedFiles(mismatch: SubitemRelationshipMismatch): Promise<void> {
    await this.plugin.linkedSubitemCheckboxService?.refreshReferencesForChild(mismatch.childFile);
    this.plugin.linkedSubitemCheckboxService?.ensureForAllMarkdownViews();
    this.plugin.linkedSubitemCheckboxService?.refreshLivePreviewEditors();
    this.plugin.persistentMenuManager?.refreshMenusForFile(mismatch.parentFile, true);
    this.plugin.persistentMenuManager?.refreshMenusForFile(mismatch.childFile, true);
  }

  /**
   * Returns true when the parent is a daily note and the child's `scheduled`
   * date matches the daily note's date.  In this case the relationship is
   * implicitly established via the scheduled date rather than an explicit
   * parent frontmatter link, so the guard should not flag it as a mismatch.
   */
  private isScheduledDateMatch(parentFile: TFile, childFile: TFile): boolean {
    // Only applies when the parent is a daily note
    if (!this.plugin.fileNamingService.isDateOnlyBasename(parentFile.basename)) return false;

    const parentDateStr = getDailyNoteResolver(this.plugin.app, {
      formatOverride: (this.plugin as any)?.settings?.dailyNoteDateFormat,
    }).parseFilenameToDateKey(parentFile.basename);
    if (!parentDateStr) return false;

    // Read the child's scheduled date from frontmatter
    const childCache = this.plugin.app.metadataCache.getFileCache(childFile);
    const childFm = childCache?.frontmatter as Record<string, unknown> | undefined;
    if (!childFm) return false;

    const rawScheduled = childFm['scheduled'] ?? childFm['Scheduled'];
    if (rawScheduled == null) return false;
    const scheduledStr = String(rawScheduled).trim();
    if (!scheduledStr) return false;

    const m = (window as any).moment;
    const scheduledParsed = m(scheduledStr);
    if (!scheduledParsed?.isValid?.()) return false;

    return scheduledParsed.format('YYYY-MM-DD') === parentDateStr;
  }

  /**
   * Promoted calendar items intentionally keep the child frontmatter backlink
   * while removing the original list item from the parent body. That leaves a
   * frontmatter-only relationship by design, so the guard must not treat it as
   * a broken subitem pair.
   */
  private isCalendarManagedPromotedChild(childFile: TFile): boolean {
    const cache = this.plugin.app.metadataCache.getFileCache(childFile);
    const frontmatter = (cache?.frontmatter || {}) as Record<string, unknown>;
    const hasCalendarIdentity = ['externalEventId', 'tpsCalendarUid', 'tpsCalendarSourceUrl'].some((key) =>
      this.hasFrontmatterValue(frontmatter, key),
    );
    return hasCalendarIdentity;
  }

  private hasFrontmatterValue(frontmatter: Record<string, unknown>, key: string): boolean {
    const actualKey = Object.keys(frontmatter || {}).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (!actualKey) return false;
    const value = frontmatter[actualKey];
    if (Array.isArray(value)) return value.length > 0;
    return String(value ?? '').trim().length > 0;
  }
}
