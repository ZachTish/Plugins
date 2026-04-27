import { MarkdownView, Notice, TFile } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import type { BodySubitemLink, ReconcileResult } from './subitem-types';
import { resolveLinkTargetToFile } from './link-target-service';
import { getCompatibleMarkdownViewFromLeaf, pickBestMarkdownLeaf } from './leaf-resolver';
import { getFileDisplayTitle } from '../utils/file-display-title';

export class SubitemRelationshipSyncService {
  private bodyWriteChains = new Map<string, Promise<void>>();

  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  async reconcileMarkdownParent(parentFile: TFile): Promise<ReconcileResult> {
    if (!(parentFile instanceof TFile) || parentFile.extension?.toLowerCase() !== 'md') {
      return { addedParents: 0, removedParents: 0, touchedChildren: [] };
    }

    let raw = await this.readMarkdownText(parentFile);
    if (this.hasSuspiciousBrokenSubitemLine(raw)) {
      await this.repairBrokenBodyLinksForParent(parentFile);
      raw = await this.readMarkdownText(parentFile);
      if (this.hasSuspiciousBrokenSubitemLine(raw)) {
        console.warn('[TPS GCM] Skipping destructive parent reconcile for suspicious broken parent body', {
          file: parentFile.path,
          raw,
        });
        return { addedParents: 0, removedParents: 0, touchedChildren: [] };
      }
    }

    const bodyLinks = this.plugin.bodySubitemLinkService.scanText(parentFile, raw);
    return await this.reconcileMarkdownParentLinks(parentFile, bodyLinks, { removeStaleParents: true });
  }

  async reconcileMarkdownParentText(parentFile: TFile, raw: string): Promise<ReconcileResult> {
    if (!(parentFile instanceof TFile) || parentFile.extension?.toLowerCase() !== 'md') {
      return { addedParents: 0, removedParents: 0, touchedChildren: [] };
    }

    if (this.hasSuspiciousBrokenSubitemLine(raw)) {
      return { addedParents: 0, removedParents: 0, touchedChildren: [] };
    }

    const bodyLinks = this.plugin.bodySubitemLinkService.scanText(parentFile, raw);
    // Live editor reconciliation is additive-only so temporary line removals
    // during reorder/move operations do not strip childOf links mid-edit.
    return await this.reconcileMarkdownParentLinks(parentFile, bodyLinks, { removeStaleParents: false });
  }

  async repairBrokenBodyLinksForParent(parentFile: TFile): Promise<number> {
    if (!(parentFile instanceof TFile) || parentFile.extension?.toLowerCase() !== 'md') return 0;

    let repairedCount = 0;
    await this.mutateMarkdownBody(parentFile, async (lines, raw) => {
      const brokenIndexes = this.getSuspiciousBrokenSubitemLineIndexes(lines);
      if (brokenIndexes.length === 0) return false;

      const existingLinks = this.plugin.bodySubitemLinkService.scanText(parentFile, raw);
      const existingChildPaths = new Set(existingLinks.map((entry) => entry.childPath));
      const missingChildren = this.getMarkdownChildrenForParent(parentFile)
        .filter((childFile) => !existingChildPaths.has(childFile.path))
        .filter((childFile) => !this.isCalendarManagedPromotedChild(childFile));

      if (missingChildren.length === 0) return false;

      let changed = false;
      let insertedCount = 0;

      for (const index of brokenIndexes) {
        const nextChild = missingChildren.shift();
        if (!nextChild) break;
        const placeholderState =
          this.getBrokenSubitemPlaceholderCheckboxState(lines[index] || '') ??
          this.resolveCheckboxStateForChild(nextChild) ??
          '[ ]';
        lines[index] = this.buildBodyLinkLine(parentFile, nextChild, placeholderState);
        repairedCount += 1;
        changed = true;
      }

      if (missingChildren.length > 0) {
        let nextRaw = lines.join('\n');
        let nextLinks = this.plugin.bodySubitemLinkService.scanText(parentFile, nextRaw);
        for (const childFile of missingChildren) {
          nextRaw = this.insertLineAfterSubitemBlock(
            nextRaw,
            this.buildBodyLinkLine(parentFile, childFile, this.resolveCheckboxStateForChild(childFile)),
            nextLinks,
          );
          nextLinks = this.plugin.bodySubitemLinkService.scanText(parentFile, nextRaw);
          insertedCount += 1;
        }
        if (insertedCount > 0) {
          lines.splice(0, lines.length, ...nextRaw.split('\n'));
          repairedCount += insertedCount;
          changed = true;
        }
      }

      return changed;
    });

    return repairedCount;
  }

  async ensureBodyLinksForChild(childFile: TFile): Promise<number> {
    if (!(childFile instanceof TFile) || childFile.extension?.toLowerCase() !== 'md') return 0;

    // Check if child file should be ignored based on folder or tag
    if (this.shouldIgnoreForAutoEmbed(childFile)) return 0;

    let inserted = 0;
    const parents = this.plugin.parentLinkResolutionService.getParentsForChild(childFile);
    const checkboxState = this.resolveCheckboxStateForChild(childFile);

    for (const entry of parents) {
      const parentFile = entry.file;
      if (!(parentFile instanceof TFile) || parentFile.path === childFile.path) continue;
      if (entry.kind !== 'markdown-parent') continue;
      const changed = await this.insertBodyLink(parentFile, childFile, checkboxState);
      if (changed) inserted += 1;
    }

    return inserted;
  }

  async readMarkdownText(file: TFile): Promise<string> {
    if (!(file instanceof TFile) || file.extension?.toLowerCase() !== 'md') return '';
    const openView = this.getOpenMarkdownViewForFile(file);
    if (openView) {
      return this.readViewSource(openView) ?? await this.plugin.app.vault.read(file);
    }
    return await this.plugin.app.vault.read(file);
  }

  private async reconcileMarkdownParentLinks(
    parentFile: TFile,
    bodyLinks: BodySubitemLink[],
    options: { removeStaleParents: boolean },
  ): Promise<ReconcileResult> {
    const desiredChildren = new Map(bodyLinks.map((entry) => [entry.childPath, entry.childFile]));
    const touchedChildren = new Map<string, TFile>();
    let addedParents = 0;
    let removedParents = 0;

    for (const childFile of desiredChildren.values()) {
      if (!(await this.plugin.bulkEditService.canMutateFrontmatterSafely(childFile))) continue;
      const changed = await this.plugin.parentLinkResolutionService.addParentToChild(childFile, parentFile);
      if (changed) {
        addedParents += 1;
        touchedChildren.set(childFile.path, childFile);
      }
    }

    if (options.removeStaleParents) {
      for (const file of this.plugin.app.vault.getMarkdownFiles()) {
        if (file.path === parentFile.path) continue;
        if (!this.plugin.parentLinkResolutionService.hasParent(file, parentFile)) continue;
        if (desiredChildren.has(file.path)) continue;
        if (!(await this.plugin.bulkEditService.canMutateFrontmatterSafely(file))) continue;
        const changed = await this.plugin.parentLinkResolutionService.removeParentFromChild(file, parentFile);
        if (changed) {
          removedParents += 1;
          touchedChildren.set(file.path, file);
        }
      }
    }

    const statusSyncCandidates = new Map<string, TFile>();
    for (const childFile of desiredChildren.values()) {
      statusSyncCandidates.set(childFile.path, childFile);
    }
    for (const childFile of touchedChildren.values()) {
      statusSyncCandidates.set(childFile.path, childFile);
    }
    for (const childFile of statusSyncCandidates.values()) {
      const currentParentReferences = bodyLinks.filter((entry) => entry.childPath === childFile.path);
      const savedReferences = await this.plugin.subitemReferenceIndexService.getReferencesForChild(childFile);
      const mergedReferences = [
        ...savedReferences.filter((entry) => entry.parentPath !== parentFile.path),
        ...currentParentReferences,
      ];
      await this.plugin.linkedSubitemCheckboxService.syncDerivedStatusForChildFromReferences(childFile, mergedReferences);
    }

    return {
      addedParents,
      removedParents,
      touchedChildren: Array.from(touchedChildren.values()),
    };
  }

  async linkExistingChildToParent(childFile: TFile, parentFile: TFile, options?: { insertBodyLink?: boolean; checkboxState?: string | null }): Promise<boolean> {
    let changed = false;
    if (parentFile.extension?.toLowerCase() === 'md' && options?.insertBodyLink !== false) {
      const checkboxState = options?.checkboxState !== undefined ? options.checkboxState : this.resolveCheckboxStateForChild(childFile);
      changed = (await this.insertBodyLink(parentFile, childFile, checkboxState)) || changed;
    }
    changed = (await this.plugin.parentLinkResolutionService.addParentToChild(childFile, parentFile)) || changed;
    return changed;
  }

  async unlinkChildFromParent(childFile: TFile, parentFile: TFile): Promise<{ childChanged: boolean; parentChanged: boolean }> {
    const childChanged = await this.plugin.parentLinkResolutionService.removeParentFromChild(childFile, parentFile);
    let parentChanged = false;
    if (parentFile.extension?.toLowerCase() === 'md') {
      parentChanged = await this.removeBodyLink(parentFile, childFile);
    }
    return { childChanged, parentChanged };
  }

  async removeBodyLinkOnly(parentFile: TFile, childFile: TFile): Promise<boolean> {
    if (parentFile.extension?.toLowerCase() !== 'md') return false;
    return await this.removeBodyLink(parentFile, childFile);
  }

  async detachBodyLinkOnly(parentFile: TFile, childFile: TFile): Promise<boolean> {
    if (parentFile.extension?.toLowerCase() !== 'md') return false;
    return await this.mutateMarkdownBody(parentFile, async (lines) => {
      let changed = false;
      for (let index = 0; index < lines.length; index += 1) {
        const raw = String(lines[index] || '');
        if (this.plugin.bodySubitemLinkService.isDetachedSubitemLine(raw)) continue;
        const parsed = this.plugin.bodySubitemLinkService.parseLine(raw);
        if (!parsed) continue;
        const resolved = resolveLinkTargetToFile(this.plugin.app, parsed.linkTarget, parentFile.path);
        if (!(resolved instanceof TFile) || resolved.path !== childFile.path) continue;
        const next = this.plugin.bodySubitemLinkService.appendDetachedMarker(raw);
        if (next !== raw) {
          lines[index] = next;
          changed = true;
        }
      }
      return changed;
    });
  }

  public async insertBodyLink(
    parentFile: TFile,
    childFile: TFile,
    checkboxState?: string | null,
    options?: { insertionMode?: 'after-subitem-block' | 'after-frontmatter' },
  ): Promise<boolean> {
    return await this.mutateMarkdownBody(parentFile, async (lines, raw) => {
      const existing = this.plugin.bodySubitemLinkService.scanText(parentFile, raw);
      if (existing.some((entry) => entry.childPath === childFile.path)) {
        console.debug?.('[TPS GCM] [RelationshipSync] insertBodyLink skipped existing', {
          parentFile: parentFile.path,
          childFile: childFile.path,
        });
        return false;
      }

      const line = this.buildBodyLinkLine(parentFile, childFile, checkboxState);

      const repaired = this.replaceBrokenPlaceholderWithLine(raw, line);
      const insertionMode = options?.insertionMode || 'after-subitem-block';
      const normalized =
        repaired !== raw
          ? repaired
          : insertionMode === 'after-frontmatter'
            ? this.insertLineAfterFrontmatter(raw, line)
            : this.insertLineAfterSubitemBlock(raw, line, existing);
      if (normalized === raw) {
        console.debug?.('[TPS GCM] [RelationshipSync] insertBodyLink no-op', {
          parentFile: parentFile.path,
          childFile: childFile.path,
          line,
          insertionMode,
        });
        return false;
      }

      const nextLines = normalized.split('\n');
      lines.splice(0, lines.length, ...nextLines);
      console.debug?.('[TPS GCM] [RelationshipSync] insertBodyLink prepared write', {
        parentFile: parentFile.path,
        childFile: childFile.path,
        line,
        insertionMode,
      });
      return true;
    });
  }

  /**
   * Insert a line at the top of the body, immediately after frontmatter when present.
   */
  private insertLineAfterSubitemBlock(content: string, line: string, existingLinks: BodySubitemLink[]): string {
    return this.insertLineAfterFrontmatter(content, line);
  }

  /**
   * Insert a line after frontmatter, or at the top if no frontmatter exists.
   * This ensures subitem links appear at a consistent location in the note body.
   */
  private insertLineAfterFrontmatter(content: string, line: string): string {
    const lines = content.split('\n');
    
    // Check for frontmatter (starts with --- on first line)
    if (lines[0]?.trim() !== '---') {
      // No frontmatter - insert at the top
      if (content.length === 0) return `${line}\n`;
      if (content.endsWith('\n')) return `${line}\n${content}`;
      return `${line}\n${content}`;
    }

    // Find the closing ---
    let frontmatterEndIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        frontmatterEndIndex = i;
        break;
      }
    }

    if (frontmatterEndIndex === -1) {
      // Unclosed frontmatter - append to end as fallback
      if (content.endsWith('\n') || content.length === 0) return `${content}${line}\n`;
      return `${content}\n${line}\n`;
    }

    // Insert after frontmatter closing ---
    // Keep the restored/inserted subitem as the first body line, but preserve
    // a blank separator before the remaining body so headings/paragraphs do not
    // collapse into the list item.
    const afterFrontmatter = lines.slice(frontmatterEndIndex + 1);
    const hasBlankLineAfter = afterFrontmatter.length > 0 && afterFrontmatter[0]?.trim() === '';
    
    // Build the new content
    const beforeInsert = lines.slice(0, frontmatterEndIndex + 1);
    const resultLines = [...beforeInsert, '', line];
    
    // Add remaining content, skipping leading blank line if we already added one
    const remainingContent = hasBlankLineAfter ? afterFrontmatter.slice(1) : afterFrontmatter;
    if (remainingContent.length > 0) {
      resultLines.push('');
      resultLines.push(...remainingContent);
    }
    
    // Ensure trailing newline
    let result = resultLines.join('\n');
    if (!result.endsWith('\n')) result += '\n';
    return result;
  }

  private buildBodyLinkLine(parentFile: TFile, childFile: TFile, checkboxState?: string | null): string {
    const wikilink = this.buildWikilink(parentFile, childFile);
    return checkboxState
      ? `- ${checkboxState} ${wikilink}`
      : `- ${wikilink}`;
  }

  private buildWikilink(parentFile: TFile, childFile: TFile): string {
    const sourcePath = this.plugin.app.metadataCache.fileToLinktext(childFile, parentFile.path, true) || childFile.path;
    const displayTitle = getFileDisplayTitle(this.plugin.app, childFile);
    return `[[${sourcePath}|${displayTitle}]]`;
  }

  private resolveCheckboxStateForChild(childFile: TFile): string | null {
    const statusKey = String(this.plugin.settings.properties?.find((prop) => prop.id === 'status')?.key || 'status').trim() || 'status';
    const frontmatter = (this.plugin.app.metadataCache.getFileCache(childFile)?.frontmatter || {}) as Record<string, unknown>;
    const actualKey = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === statusKey.toLowerCase());
    const status = String(actualKey ? frontmatter[actualKey] : '').trim().toLowerCase();
    const mappings = this.plugin.settings.linkedSubitemCheckboxMappings || [];
    const mapping = mappings.find((entry) =>
      (entry.statuses || []).some((value) => String(value || '').trim().toLowerCase() === status),
    );
    if (mapping?.checkboxState) return mapping.checkboxState;
    return (actualKey || status) ? (this.plugin.settings.linkedSubitemDefaultOpenState || '[ ]') : null;
  }

  private async removeBodyLink(parentFile: TFile, childFile: TFile): Promise<boolean> {
    return await this.mutateMarkdownBody(parentFile, async (lines) => {
      let changed = false;
      for (let index = lines.length - 1; index >= 0; index--) {
        const parsed = this.plugin.bodySubitemLinkService.parseLine(lines[index] || '');
        if (!parsed) continue;
        const resolved = resolveLinkTargetToFile(this.plugin.app, parsed.linkTarget, parentFile.path);
        if (!(resolved instanceof TFile) || resolved.path !== childFile.path) continue;
        lines.splice(index, 1);
        changed = true;
      }
      return changed;
    });
  }

  async mutateMarkdownBody(
    file: TFile,
    mutator: (lines: string[], raw: string) => boolean | Promise<boolean>,
  ): Promise<boolean> {
    if (!(file instanceof TFile) || file.extension?.toLowerCase() !== 'md') return false;

    let changed = false;
    await this.runSerializedBodyMutation(file, async () => {
      const openViews = this.getOpenMarkdownViewsForFile(file);
      const raw = await this.readMarkdownText(file);
      const lines = raw.split('\n');
      const didChange = await mutator(lines, raw);
      if (!didChange) return;

      const next = lines.join('\n');
      if (next === raw) return;
      if (!this.hasSuspiciousBrokenSubitemLine(raw) && this.hasSuspiciousBrokenSubitemLine(next)) {
        new Notice(`Skipped suspicious subitem body write for "${file.basename}".`);
        console.warn('[TPS GCM] Refusing to write suspicious broken subitem line', {
          file: file.path,
          raw,
          next,
          stack: new Error().stack,
        });
        return;
      }

      if (openViews.length > 0) {
        await this.writeOpenMarkdownViews(file, next, openViews);
      } else {
        await this.plugin.app.vault.modify(file, next);
      }
      changed = true;
    });

    return changed;
  }

  private shouldIgnoreForAutoEmbed(file: TFile): boolean {
    // Check if file is in an ignored folder
    const ignoreFolders = this.plugin.settings.autoEmbedIgnoreFolders || [];
    const filePath = file.path.toLowerCase();
    for (const folder of ignoreFolders) {
      const normalizedFolder = folder.trim().toLowerCase();
      if (!normalizedFolder) continue;
      if (filePath.startsWith(normalizedFolder + '/') || filePath.startsWith(normalizedFolder)) {
        return true;
      }
    }

    // Check if file has an ignored tag
    const ignoreTags = this.plugin.settings.autoEmbedIgnoreTags || [];
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const fm = (cache?.frontmatter || {}) as Record<string, unknown>;
    const tagsKey = Object.keys(fm).find((k) => k.toLowerCase() === 'tags');
    const fileTags = Array.isArray(fm[tagsKey || 'tags']) ? fm[tagsKey || 'tags'] as string[] : [];
    
    for (const ignoreTag of ignoreTags) {
      const normalizedTag = ignoreTag.trim().toLowerCase().replace(/^#/, '');
      if (!normalizedTag) continue;
      for (const fileTag of fileTags) {
        if (String(fileTag).trim().toLowerCase().replace(/^#/, '') === normalizedTag) {
          return true;
        }
      }
    }

    return false;
  }

  private async runSerializedBodyMutation(file: TFile, action: () => Promise<void>): Promise<void> {
    const key = file.path;
    const previous = this.bodyWriteChains.get(key) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.bodyWriteChains.set(key, previous.then(() => gate).catch(() => gate));

    try {
      await previous;
      await action();
    } finally {
      release();
      if (this.bodyWriteChains.get(key) === gate) {
        this.bodyWriteChains.delete(key);
      }
    }
  }

  private getOpenMarkdownViewForFile(file: TFile): MarkdownView | null {
    return this.getOpenMarkdownViewsForFile(file)[0] ?? null;
  }

  private hasSuspiciousBrokenSubitemLine(text: string): boolean {
    return String(text || '').split('\n').some((line) => this.isSuspiciousBrokenSubitemLine(line));
  }

  private getSuspiciousBrokenSubitemLineIndexes(lines: string[]): number[] {
    const output: number[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (this.isSuspiciousBrokenSubitemLine(lines[index] || '')) {
        output.push(index);
      }
    }
    return output;
  }

  private isSuspiciousBrokenSubitemLine(line: string): boolean {
    return /^[ \t]*(?:[-*+]|\d+\.)\s+(?:\[[^\]]+]\s+)?\[\[$/.test(String(line || '').trimEnd());
  }

  private getBrokenSubitemPlaceholderCheckboxState(line: string): string | null {
    const match = String(line || '').trimEnd().match(/^[ \t]*(?:[-*+]|\d+\.)\s+(\[[^\]]+])\s+\[\[$/);
    return match?.[1] ? String(match[1]).trim() : null;
  }

  private replaceBrokenPlaceholderWithLine(content: string, replacementLine: string): string {
    const lines = content.split('\n');
    const brokenIndex = lines.findIndex((line) => this.isSuspiciousBrokenSubitemLine(line));
    if (brokenIndex < 0) return content;
    lines[brokenIndex] = replacementLine;
    let result = lines.join('\n');
    if (!result.endsWith('\n')) result += '\n';
    return result;
  }

  private isCalendarManagedPromotedChild(file: TFile): boolean {
    const cache = this.plugin.app.metadataCache.getFileCache(file);
    const frontmatter = (cache?.frontmatter || {}) as Record<string, unknown>;
    return ['externalEventId', 'tpsCalendarUid', 'tpsCalendarSourceUrl'].some((key) => {
      const actualKey = Object.keys(frontmatter || {}).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      if (!actualKey) return false;
      const value = frontmatter[actualKey];
      if (Array.isArray(value)) return value.length > 0;
      return String(value ?? '').trim().length > 0;
    });
  }

  private getMarkdownChildrenForParent(parentFile: TFile): TFile[] {
    return this.plugin.app.vault
      .getMarkdownFiles()
      .filter((file) =>
        this.plugin.parentLinkResolutionService
          .getParentsForChild(file)
          .some((entry) => entry.kind === 'markdown-parent' && entry.file.path === parentFile.path),
      )
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private getOpenMarkdownViewsForFile(file: TFile): MarkdownView[] {
    const leaves = [];
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      if (view.file?.path !== file.path) continue;
      leaves.push(leaf);
    }
    if (leaves.length === 0) return [];

    const activeLeaf = this.plugin.app.workspace.activeLeaf ?? null;
    const bestLeaf = pickBestMarkdownLeaf(leaves, activeLeaf);
    const orderedLeaves = bestLeaf
      ? [bestLeaf, ...leaves.filter((leaf) => leaf !== bestLeaf)]
      : leaves;

    return orderedLeaves
      .map((leaf) => getCompatibleMarkdownViewFromLeaf(leaf))
      .filter((view): view is MarkdownView => view instanceof MarkdownView);
  }

  private readViewData(view: MarkdownView): string {
    const anyView = view as any;
    const editor = anyView.editor;
    if (typeof editor?.getValue === 'function') {
      return String(editor.getValue() || '');
    }
    if (typeof anyView.getViewData === 'function') {
      const data = anyView.getViewData();
      if (typeof data === 'string') return data;
    }
    return String(anyView.data || '');
  }

  private readViewSource(view: MarkdownView): string | null {
    const anyView = view as any;
    const editor = anyView.editor;
    if (typeof editor?.getValue === 'function') {
      return String(editor.getValue() || '');
    }
    return null;
  }

  private async writeOpenMarkdownViews(file: TFile, next: string, views: MarkdownView[]): Promise<void> {
    const editorViews = views.filter((view) => {
      const editor = (view as any)?.editor;
      return typeof editor?.setValue === 'function';
    });

    if (editorViews.length === 0) {
      await this.plugin.app.vault.modify(file, next);
      return;
    }

    for (const view of editorViews) {
      const editor = (view as any).editor;
      editor.setValue(next);
    }

    const primaryView = editorViews[0] as any;
    if (typeof primaryView?.requestSave === 'function') {
      try {
        primaryView.requestSave();
      } catch (error) {
        // Fall through to direct persistence below.
      }
    }
    else if (typeof primaryView?.save === 'function') {
      try {
        await primaryView.save(false);
      } catch (error) {
        // Fall through to direct persistence below.
      }
    }

    await this.plugin.app.vault.modify(file, next);
  }
}
