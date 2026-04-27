import { App, Menu, TFile, Notice, normalizePath } from 'obsidian';
import TPSGlobalContextMenuPlugin from '../main';
import { TextInputModal } from '../modals/text-input-modal';
import { FileSuggestModal } from '../modals/FileSuggestModal';
import { MultiFileSelectModal } from '../modals/MultiFileSelectModal';
import { mergeNormalizedTags, normalizeTagValue } from '../utils/tag-utils';
import { setValueCaseInsensitive } from '../core/record-utils';
import { getArchiveBucketPath, normalizeArchiveFolderMode, resolveArchiveTargetInfo } from '../utils/archive-path';
import * as logger from '../logger';
import { resolveCustomProperties } from '../resolve-profiles';
import { ViewModeService } from '../services/view-mode-service';
import { parseLinksFromFrontmatterValue } from '../services/link-target-service';
import { promptAndCreateSubitemForParent } from '../services/subitem-creation-service';

export class MenuBuilder {
  private plugin: TPSGlobalContextMenuPlugin;
  private delegates: {
    createFileEntries: (files: TFile[]) => any[];
    openAddTagModal: (entries: any[], key?: string) => void;
    openScheduledModal: (entries: any[], key?: string) => void;
    openRecurrenceModalNative: (entries: any[]) => void;
    openSnoozeModal: (entries: any[], key?: string) => void;
    getRecurrenceValue: (fm: any) => string;
    moveFiles: (entries: any[], folderPath: string) => Promise<void>;
    getTypeFolderOptions: () => { path: string; label: string }[];
  };

  constructor(
    plugin: TPSGlobalContextMenuPlugin,
    delegates: MenuBuilder['delegates']
  ) {
    this.plugin = plugin;
    this.delegates = delegates;
  }

  private get app(): App {
    return this.plugin.app;
  }

  private getValueCaseInsensitive(frontmatter: any, key: string): any {
    if (!frontmatter || !key) return undefined;
    if (key in frontmatter) return frontmatter[key];
    const lowerKey = key.toLowerCase();
    const match = Object.keys(frontmatter).find(k => k.toLowerCase() === lowerKey);
    return match ? frontmatter[match] : undefined;
  }

  private hasKeyCaseInsensitive(frontmatter: any, key: string): boolean {
    if (!frontmatter || !key) return false;
    if (key in frontmatter) return true;
    const lowerKey = key.toLowerCase();
    return Object.keys(frontmatter).some((k) => k.toLowerCase() === lowerKey);
  }

  private resolveParentFilesFor(file: TFile): TFile[] {
    const parents = new Map<string, TFile>();
    for (const entry of this.plugin.parentLinkResolutionService.getParentsForChild(file)) {
      if (entry.file.path !== file.path) parents.set(entry.file.path, entry.file);
    }
    return Array.from(parents.values());
  }

  private resolveChildFilesFor(file: TFile): TFile[] {
    const children = new Map<string, TFile>();
    const indexed = this.plugin.app.vault.getMarkdownFiles().filter((candidate) =>
      this.plugin.parentLinkResolutionService.hasParent(candidate, file),
    );
    for (const child of indexed) {
      if (child.path !== file.path) children.set(child.path, child);
    }

    return Array.from(children.values());
  }

  private getFileDisplayTitle(file: TFile): string {
    const frontmatter = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
    const titleValue = this.getValueCaseInsensitive(frontmatter, 'title');
    const title = typeof titleValue === 'string' ? titleValue.trim() : '';
    return title || file.basename;
  }

  private getFileIconMeta(file: TFile): { icon: string; color?: string } {
    const frontmatter = (this.app.metadataCache.getFileCache(file)?.frontmatter || {}) as Record<string, any>;
    const rawIcon = typeof frontmatter.icon === 'string' ? frontmatter.icon.trim() : '';
    const rawColor = typeof frontmatter.color === 'string' ? frontmatter.color.trim() : '';
    const icon = rawIcon.replace(/^lucide:/i, '') || 'file-text';
    return {
      icon,
      color: rawColor || undefined,
    };
  }

  private populateParentRelationSubmenu(menu: Menu, file: TFile): void {
    const parentFiles = this.resolveParentFilesFor(file);

    menu.addItem((sub) => {
      sub.setTitle(parentFiles.length > 0 ? 'Replace parent...' : 'Link existing parent...')
        .setIcon('plus')
        .onClick(() => {
          new FileSuggestModal(this.app, async (parentFile: TFile) => {
            await this.plugin.bulkEditService.linkToParent([file], parentFile);
            new Notice(`Linked to parent: ${parentFile.basename}`);
          }, { extensions: ['md', 'base'] }).open();
        });
    });

    menu.addSeparator();

    if (parentFiles.length === 0) {
      menu.addItem((sub) => {
        sub.setTitle('No linked parents')
          .setIcon('info')
          .setDisabled(true);
      });
      return;
    }

    parentFiles.forEach((parentFile) => {
      menu.addItem((sub) => {
        sub.setTitle(this.getFileDisplayTitle(parentFile))
          .setIcon(this.getFileIconMeta(parentFile).icon || 'file-text')
          .onClick(() => {
            void this.plugin.openFileInLeaf(parentFile, false, () => this.app.workspace.getLeaf(false), {
              revealLeaf: true,
              ignoreCanvasDragGuard: true,
            });
          });
      });

      menu.addItem((sub) => {
        sub.setTitle(this.getFileDisplayTitle(parentFile))
          .setIcon('x')
          .onClick(async () => {
            await this.plugin.bulkEditService.unlinkFromParent(file, parentFile);
            new Notice(`Removed parent link: ${this.getFileDisplayTitle(parentFile)}`);
          });
      });
    });
  }

  private populateChildRelationSubmenu(menu: Menu, file: TFile): void {
    const childFiles = this.resolveChildFilesFor(file);

    menu.addItem((sub) => {
      sub.setTitle('Create new child...')
        .setIcon('plus')
        .onClick(() => {
          void promptAndCreateSubitemForParent(this.plugin, file);
        });
    });

    menu.addItem((sub) => {
      sub.setTitle('Link existing child...')
        .setIcon('link')
        .onClick(() => {
          new MultiFileSelectModal(this.app, async (childFilesToAdd: TFile[]) => {
            if (childFilesToAdd.length > 0) {
              await this.plugin.bulkEditService.linkChildren(file, childFilesToAdd);
              new Notice(`Linked ${childFilesToAdd.length} children to this note.`);
            }
          }).open();
        });
    });

    menu.addItem((sub) => {
      sub.setTitle('Migrate linked children...')
        .setIcon('move-right')
        .onClick(() => {
          void this.plugin.linkedSubitemMigrationService.promptAndMigrateLinkedChildren(file);
        });
    });

    menu.addSeparator();

    if (childFiles.length === 0) {
      menu.addItem((sub) => {
        sub.setTitle('No linked children')
          .setIcon('info')
          .setDisabled(true);
      });
      return;
    }

    childFiles.forEach((childFile) => {
      menu.addItem((sub) => {
        sub.setTitle(this.getFileDisplayTitle(childFile))
          .setIcon(this.getFileIconMeta(childFile).icon || 'file-text')
          .onClick(() => {
            void this.plugin.openFileInLeaf(childFile, false, () => this.app.workspace.getLeaf(false), {
              revealLeaf: true,
              ignoreCanvasDragGuard: true,
            });
          });
      });

      menu.addItem((sub) => {
        sub.setTitle(this.getFileDisplayTitle(childFile))
          .setIcon('x')
          .onClick(async () => {
            await this.plugin.bulkEditService.unlinkFromParent(childFile, file);
            new Notice(`Removed child link: ${this.getFileDisplayTitle(childFile)}`);
          });
      });
    });
  }

  private async ensureFolderPath(path: string): Promise<void> {
    const clean = normalizePath(path).trim();
    if (!clean) return;
    const segments = clean.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private setFrontmatterValueCaseInsensitive(frontmatter: Record<string, any>, key: string, value: any): void {
    if (!frontmatter || typeof frontmatter !== 'object') return;
    if (key in frontmatter) {
      frontmatter[key] = value;
      return;
    }
    const lowerKey = key.toLowerCase();
    const existingKey = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === lowerKey);
    frontmatter[existingKey ?? key] = value;
  }

  private getArchiveTargetInfo(file: TFile, archiveFolder: string): { targetFolder: string; targetPath: string } {
    const mode = normalizeArchiveFolderMode(
      this.plugin.settings.archiveFolderMode ?? (this.plugin.settings.archiveUseDailyFolder ? 'daily' : 'none')
    );
    const archiveBucket = getArchiveBucketPath(archiveFolder, mode);
    const { targetFolder, targetPath } = resolveArchiveTargetInfo(file, archiveBucket, (path) => !!this.app.vault.getAbstractFileByPath(path));
    return { targetFolder, targetPath };
  }

  private async archiveFiles(files: TFile[]): Promise<void> {
    const archiveTag = normalizeTagValue(this.plugin.settings.archiveTag || 'archive');
    const archiveFolder = this.plugin.getArchiveFolderPath();
    if (!archiveTag || !archiveFolder) {
      new Notice('Archive tag/folder settings are not configured.');
      return;
    }

    const archiveTargetRoot = getArchiveBucketPath(
      archiveFolder,
      normalizeArchiveFolderMode(this.plugin.settings.archiveFolderMode ?? (this.plugin.settings.archiveUseDailyFolder ? 'daily' : 'none'))
    );
    await this.ensureFolderPath(archiveTargetRoot);

    let archivedCount = 0;
    await this.plugin.runQueuedMove(files, async () => {
      for (const file of files) {
        if (!(file instanceof TFile)) continue;

        // Skip if already in archive
        if (file.path.startsWith(`${archiveFolder}/`)) {
          archivedCount += 1;
          continue;
        }

        const originalFolder = file.parent?.path ?? '';

        // Add tag and log activity
        if (file.extension?.toLowerCase() === 'md') {
          try {
           await this.plugin.frontmatterMutationService.process(file, (frontmatter: any) => {
              const mergedTags = mergeNormalizedTags(frontmatter.tags, archiveTag);
              setValueCaseInsensitive(frontmatter, 'tags', mergedTags);

              // Lightweight activity log: only store what's needed for recovery
              if (!Array.isArray(frontmatter.activity)) {
                frontmatter.activity = [];
              }
              frontmatter.activity.push({
                type: 'archive',
                folder: originalFolder, // Store pre-archive folder for recovery
                ts: Math.floor(Date.now() / 1000)
              });
            });
          } catch (err) {
            logger.error('[TPS GCM] Failed adding archive tag', file.path, err);
          }
        }

        // Move to archive
        try {
          const { targetFolder, targetPath } = this.getArchiveTargetInfo(file, archiveFolder);
          await this.ensureFolderPath(targetFolder);
          await this.app.fileManager.renameFile(file, targetPath);
          archivedCount += 1;
        } catch (err) {
          logger.error('[TPS GCM] Failed moving archived file', file.path, err);
        }
      }
    });

    new Notice(archivedCount === 1 ? 'Archived 1 file' : `Archived ${archivedCount} files`);
  }

  private async unarchiveFiles(files: TFile[]): Promise<void> {
    const archiveTag = normalizeTagValue(this.plugin.settings.archiveTag || 'archive');
    const archiveFolder = this.plugin.getArchiveFolderPath();
    if (!archiveTag || !archiveFolder) {
      new Notice('Archive tag/folder settings are not configured.');
      return;
    }

    let unarchivedCount = 0;
    await this.plugin.runQueuedMove(files, async () => {
      for (const file of files) {
        if (!(file instanceof TFile)) continue;
        if (!file.path.startsWith(`${archiveFolder}/`)) {
          continue; // Skip files not in archive
        }

        let originalFolder = '';

        // Remove tag and find original folder from activity
        if (file.extension?.toLowerCase() === 'md') {
          try {
           await this.plugin.frontmatterMutationService.processUserInitiated(file, (frontmatter: any) => {
              // Find most recent archive entry with stored folder
              if (Array.isArray(frontmatter.activity)) {
                for (let i = frontmatter.activity.length - 1; i >= 0; i--) {
                  const entry = frontmatter.activity[i];
                  if (entry.type === 'archive' && entry.folder !== undefined) {
                    originalFolder = entry.folder;
                    break;
                  }
                }
              }

              // Remove archive tag
             const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
              const filteredTags = tags.filter((tag: any) => {
                const normalized = normalizeTagValue(String(tag));
                return normalized !== archiveTag;
              });
              setValueCaseInsensitive(frontmatter, 'tags', filteredTags);

              // No need to log unarchive - the archive entry already tells us the history
            });
          } catch (err) {
            logger.error('[TPS GCM] Failed processing frontmatter during unarchive', file.path, err);
            continue;
          }
        }

        // Validate and restore to original folder
        try {
          let targetFolder = originalFolder;

          // Check if original folder still exists, fallback to root if not
          if (targetFolder && !this.app.vault.getAbstractFileByPath(targetFolder)) {
            logger.log(`[TPS GCM] Original folder "${targetFolder}" no longer exists, restoring to root`);
            targetFolder = '';
          }

          const targetPath = targetFolder ? normalizePath(`${targetFolder}/${file.name}`) : file.name;

          // Ensure target folder exists
          if (targetFolder) {
            await this.ensureFolderPath(targetFolder);
          }

          await this.app.fileManager.renameFile(file, targetPath);
          unarchivedCount += 1;
        } catch (err) {
          logger.error('[TPS GCM] Failed moving unarchived file', file.path, err);
        }
      }
    });

    new Notice(unarchivedCount === 1 ? 'Unarchived 1 file' : `Unarchived ${unarchivedCount} files`);
  }

  private isFileInArchive(files: TFile[]): boolean {
    const archiveFolder = this.plugin.getArchiveFolderPath();
    if (!archiveFolder) return false;
    return files.some(file => file instanceof TFile && file.path.startsWith(`${archiveFolder}/`));
  }

  private buildRenameTargetPath(file: TFile, rawName: string): string | null {
    const trimmed = String(rawName || '').trim();
    if (!trimmed) return null;

    let baseName = trimmed.replace(/[\\/]/g, ' ').trim();
    if (!baseName) return null;

    if (file.extension) {
      const extSuffix = `.${file.extension.toLowerCase()}`;
      if (baseName.toLowerCase().endsWith(extSuffix)) {
        baseName = baseName.slice(0, -extSuffix.length).trim();
      }
    }
    if (!baseName) return null;

    const targetName = file.extension ? `${baseName}.${file.extension}` : baseName;
    const parentPath = file.parent?.path ?? '';
    return normalizePath(parentPath ? `${parentPath}/${targetName}` : targetName);
  }

  private async promptRenameFile(file: TFile): Promise<void> {
    const fileManager: any = this.app.fileManager as any;
    if (typeof fileManager?.promptForFileRename === 'function') {
      fileManager.promptForFileRename(file);
      return;
    }

    new TextInputModal(this.app, 'Name', file.basename, async (value) => {
      const targetPath = this.buildRenameTargetPath(file, value);
      if (!targetPath) {
        new Notice('Name cannot be empty.');
        return;
      }
      if (targetPath === file.path) return;
      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing) {
        new Notice('A file with that name already exists.');
        return;
      }
      try {
        await this.plugin.runQueuedMove([file], async () => {
          await this.app.fileManager.renameFile(file, targetPath);
        });
      } catch (error) {
        logger.error('[TPS GCM] Rename failed:', error);
        new Notice('Rename failed.');
      }
    }).open();
  }

  addToNativeMenu(menu: Menu, files: TFile[]) {
    // Prevent duplicate additions to the same menu instance
    if ((menu as any)._tpsHandled) return;
    (menu as any)._tpsHandled = true;

    // Capture initial item count to allow reordering later
    const initialItemCount = (menu as any).items ? (menu as any).items.length : 0;

    // Delegate resolution to service
    const resolvedFiles = this.plugin.contextTargetService.resolveTargets(files);

    // Create entries for ALL resolved files
    const entries = this.delegates.createFileEntries(resolvedFiles);
    if (!entries.length) return;

    // Filter for markdown-specific features
    const markdownEntries = entries.filter(e => e.file.extension?.toLowerCase() === 'md');
    const markdownFiles = markdownEntries.map(e => e.file);

    // Wrap addItem to tag all items added by this plugin
    const originalAddItem = menu.addItem;

    menu.addItem = (callback: (item: any) => any) => {
      return originalAddItem.call(menu, (item: any) => {
        callback(item);
        (item as any)._isTpsItem = true;
      });
    };

    const file = entries[0].file;

    // Handwriting / PDF Integration
    if (file.extension === 'pdf') {
      menu.addItem((item) => {
        item.setTitle('Write on PDF')
          .setIcon('pencil')
          .setSection('tps-file-ops')
          .onClick(async () => {
            const app = (this.app as any);
            if (app.openWithDefaultApp && file instanceof TFile) {
              app.openWithDefaultApp(file.path);
              return;
            }
            new Notice("Could not open PDF with the system default app.");
          });
      });
    }

    // Dynamic Properties (Markdown Only)
    if (markdownEntries.length > 0 && this.plugin.settings.showCustomPropertiesInContextMenu !== false) {
      const properties = resolveCustomProperties(this.plugin.settings.properties || [], markdownEntries, new ViewModeService());

      properties.forEach(prop => {
        if (prop.showInContextMenu === false) return;

        if (prop.key === 'snooze' || prop.type === 'snooze') {
          menu.addItem((item) => {
            const val = this.getValueCaseInsensitive(markdownEntries[0].frontmatter, prop.key);
            const isUndefined = !this.plugin.fieldInitializationService.isFieldDefinedForEntries(markdownEntries, prop.key);
            const title = isUndefined ? `${prop.label} (create field)` : (val ? `Snooze: ${val}` : 'Snooze...');

            item.setTitle(title)
              .setIcon(prop.icon || 'clock')
              .setSection('tps-props');

            if (prop.disabled) {
              item.setDisabled(true);
              (item as any).setTitle(`${title} (Mixed Profiles)`);
              return;
            }

            item.onClick(async () => {
              if (await this.plugin.fieldInitializationService.checkAndInitialize(markdownEntries, prop.key, '')) {
                return; // Field initialized, skip modal
              }
              this.delegates.openSnoozeModal(markdownEntries, prop.key);
            });
          });
          return;
        }

        if (prop.type === 'selector') {
          this.addSelectorToMenu(menu, markdownEntries, prop, 'tps-props');
        } else if (prop.type === 'list') {
          this.addListToMenu(menu, markdownEntries, prop, 'tps-props');
        } else if (prop.type === 'datetime') {
          this.addDatetimeToMenu(menu, markdownEntries, prop, 'tps-props');
        } else if (prop.type === 'recurrence') {
          this.addRecurrenceToMenu(menu, markdownEntries, prop, 'tps-props');
        } else if (prop.type === 'folder') {
          this.addFolderToMenu(menu, markdownEntries, prop, 'tps-props');
        }
        else if (prop.type === 'text' || prop.type === 'number') {
          menu.addItem((item) => {
            const val = this.getValueCaseInsensitive(markdownEntries[0].frontmatter, prop.key);
            const isUndefined = !this.plugin.fieldInitializationService.isFieldDefinedForEntries(markdownEntries, prop.key);
            const title = isUndefined ? `${prop.label} (create field)` : `${prop.label}: ${val || 'Empty'}`;

            item.setTitle(title)
              .setIcon(prop.icon || 'pencil')
              .setSection('tps-props');
            if (prop.disabled) {
              item.setDisabled(true);
              (item as any).setTitle(`${title} (Mixed Profiles)`);
              return;
            }

            item.onClick(async () => {
              const defaultValue = prop.type === 'number' ? 0 : '';
              if (await this.plugin.fieldInitializationService.checkAndInitialize(markdownEntries, prop.key, defaultValue)) {
                return; // Field initialized, skip modal
              }

              new TextInputModal(
                this.app,
                prop.label,
                val ?? '',
                async (newVal) => {
                  if (newVal !== null && newVal !== undefined) {
                    const finalVal = prop.type === 'number' ? Number(newVal) : newVal;
                    const files = markdownEntries.map(e => e.file);
                    await this.plugin.bulkEditService.updateFrontmatter(files, { [prop.key]: finalVal }, { userInitiated: true });

                    const normalizedKey = String(prop?.key || '').trim().toLowerCase();
                    if (normalizedKey === 'title') {
                      await Promise.all(
                        files.map((entryFile) =>
                          this.plugin.fileNamingService.updateFilenameIfNeeded(entryFile, { bypassCreationGrace: true })
                        )
                      );
                    }
                  }
                }
              ).open();
            });
          });
        }

      });

      // Link Operations (rendered below frontmatter properties)
      if (file.extension?.toLowerCase() === 'md') {
        const parentCount = this.resolveParentFilesFor(file).length;
        const childCount = this.resolveChildFilesFor(file).length;

        menu.addItem((item) => {
          item.setTitle(parentCount > 0 ? `Link to Parent (${parentCount})` : 'Link to Parent')
            .setIcon('link')
            .setSection('tps-props');

          const subMenu = (item as any).setSubmenu();
          this.populateParentRelationSubmenu(subMenu, file);
        });

        menu.addItem((item) => {
          item.setTitle(childCount > 0 ? `Link Children (${childCount})` : 'Link Children')
            .setIcon('network')
            .setSection('tps-props');

          const subMenu = (item as any).setSubmenu();
          this.populateChildRelationSubmenu(subMenu, file);
        });

        menu.addItem((item) => {
          item.setTitle('Link Attachments')
            .setIcon('paperclip')
            .setSection('tps-props')
            .onClick(() => {
              new MultiFileSelectModal(this.app, async (attachmentFiles: TFile[]) => {
                if (attachmentFiles.length > 0) {
                  const added = await this.plugin.bulkEditService.linkAttachments(file, attachmentFiles);
                  new Notice(`Linked ${added} attachment(s) to this note.`);
                }
              }).open();
            });
        });

      }

    }

    if (file.extension?.toLowerCase() === 'md') {
      menu.addItem((item) => {
        item.setTitle('Start Time Tracking')
          .setIcon('timer')
          .setSection('tps-props')
          .onClick(() => {
            void this.plugin.timeTrackingService.startForNote(file);
          });
      });

      menu.addItem((item) => {
        item.setTitle('Stop Running Timer')
          .setIcon('square')
          .setSection('tps-props')
          .onClick(() => {
            void this.plugin.timeTrackingService.stopFirstRunningTimer(file);
          });
      });
    }

    // Archive / Unarchive
    const archiveFiles = entries.map((entry) => entry.file);
    const inArchive = this.isFileInArchive(archiveFiles);
    menu.addItem((item) => {
      const fileCount = entries.length;
      if (inArchive) {
        const unarchiveLabel = fileCount > 1 ? `Unarchive (${fileCount} items)` : 'Unarchive';
        item.setTitle(unarchiveLabel)
          .setIcon('inbox')
          .setSection('tps-delete')
          .onClick(async () => {
            await this.unarchiveFiles(archiveFiles);
          });
      } else {
        const archiveLabel = fileCount > 1 ? `Archive (${fileCount} items)` : 'Archive';
        item.setTitle(archiveLabel)
          .setIcon('archive')
          .setSection('tps-delete')
          .onClick(async () => {
            await this.archiveFiles(archiveFiles);
          });
      }
    });

    // Delete
    menu.addItem((item) => {
      const fileCount = entries.length;
      const deleteLabel = fileCount > 1 ? `Delete (${fileCount} items)` : 'Delete';
      item.setTitle(deleteLabel)
        .setIcon('trash')
        .setSection('tps-delete')
        .setWarning(true)
        .onClick(async () => {
          if (fileCount === 1 && this.app.fileManager.promptForDeletion) {
            this.app.fileManager.promptForDeletion(entries[0].file);
          } else {
            const confirmMsg = fileCount === 1
              ? `Are you sure you want to delete "${entries[0].file.name}"?`
              : `Are you sure you want to delete ${fileCount} items?`;
            if (confirm(confirmMsg)) {
              const filesToDelete = entries
                .map((entry: any) => entry.file)
                .filter((candidate: unknown): candidate is TFile => candidate instanceof TFile);
              await this.plugin.runQueuedDelete(filesToDelete, async () => {
                for (const entry of entries) {
                  await this.app.vault.trash(entry.file, true);
                }
              });
            }
          }
        });
    });

    // Restore original methods
    menu.addItem = originalAddItem;
  }

  addSelectorToMenu(menu: Menu, entries: any[], prop: any, sectionId: string) {
    menu.addItem((item) => {
      const allValues = entries.map((e: any) => this.getValueCaseInsensitive(e.frontmatter, prop.key) || '');
      const uniqueValues = new Set(allValues);
      const current = uniqueValues.size === 1 ? allValues[0] : 'Mixed';
      const allHaveKey = entries.every((e: any) => this.hasKeyCaseInsensitive(e.frontmatter, prop.key));
      const allWithoutKey = entries.every((e: any) => !this.hasKeyCaseInsensitive(e.frontmatter, prop.key));
      const allEmpty = allHaveKey && entries.every((e: any) => {
        const value = this.getValueCaseInsensitive(e.frontmatter, prop.key);
        return value === '' || value === null || value === undefined;
      });
      const isUndefined = allWithoutKey;
      const title = isUndefined ? `${prop.label} (create field)` : `${prop.label}: ${current}`;

      item.setTitle(title)
        .setIcon(prop.icon || 'hash')
        .setSection(sectionId);

      if (prop.disabled) {
        item.setDisabled(true);
        (item as any).setTitle(`${title} (Mixed Profiles)`);
        return;
      }

      const subMenu = (item as any).setSubmenu();
      const files = entries.map((e: any) => e.file);

      subMenu.addItem((sub: any) => {
        sub.setTitle('(none)')
          .setChecked(allWithoutKey)
          .onClick(async () => {
            await this.plugin.bulkEditService.removeFrontmatterKey(files, prop.key, { userInitiated: true });
          });
      });
      subMenu.addItem((sub: any) => {
        sub.setTitle('(empty)')
          .setChecked(allEmpty)
          .onClick(async () => {
            await this.plugin.bulkEditService.updateFrontmatter(files, { [prop.key]: '' }, { userInitiated: true });
          });
      });
      subMenu.addSeparator();

      (prop.options || []).forEach((opt: string) => {
        subMenu.addItem((sub: any) => {
          sub.setTitle(opt)
            .setChecked(current === opt)
            .onClick(async () => {
              await this.plugin.bulkEditService.updateFrontmatter(files, { [prop.key]: opt }, { userInitiated: true });
            });
        });
      });

    });
  }

  addListToMenu(menu: Menu, entries: any[], prop: any, sectionId: string) {
    menu.addItem((item) => {
      const tags = this.getValueCaseInsensitive(entries[0].frontmatter, prop.key) || [];
      const count = Array.isArray(tags) ? tags.length : 0;
      const isUndefined = !this.plugin.fieldInitializationService.isFieldDefinedForEntries(entries, prop.key);
      const title = isUndefined ? `${prop.label} (create field)` : `${prop.label} (${count})`;

      item.setTitle(title)
        .setIcon(prop.icon || 'list')
        .setSection(sectionId);

      if (prop.disabled) {
        item.setDisabled(true);
        (item as any).setTitle(`${title} (Mixed Profiles)`);
        return;
      }

      const subMenu = (item as any).setSubmenu();
      this.populateListSubmenu(subMenu, entries, prop, tags);
    });
  }

  populateListSubmenu(menu: Menu, entries: any[], prop: any, tags: string[]) {
    const isUndefined = !this.plugin.fieldInitializationService.isFieldDefinedForEntries(entries, prop.key);

    menu.addItem((sub) => {
      const title = isUndefined ? `Create field and add ${prop.label.toLowerCase()}...` : `Add ${prop.label}...`;
      sub.setTitle(title)
        .setIcon('plus')
        .onClick(async () => {
          // Initialize the field if it doesn't exist yet, then immediately open the modal.
          await this.plugin.fieldInitializationService.checkAndInitialize(entries, prop.key, []);
          this.delegates.openAddTagModal(entries, prop.key);
        });
    });
    if (Array.isArray(tags)) {
      tags.forEach(tag => {
        menu.addItem((sub: any) => {
          sub.setTitle(String(tag))
            .setIcon('cross')
            .onClick(async () => {
              await this.plugin.bulkEditService.removeTag(entries.map((e: any) => e.file), tag, prop.key);
            });
        });
      });
    }

  }

  addDatetimeToMenu(menu: Menu, entries: any[], prop: any, sectionId: string) {
    const val = this.getValueCaseInsensitive(entries[0].frontmatter, prop.key);
    const isUndefined = !this.plugin.fieldInitializationService.isFieldDefinedForEntries(entries, prop.key);
    const title = isUndefined ? `${prop.label} (create field)` : (val ? `${prop.label}: ${val}` : `Set ${prop.label}...`);

    menu.addItem((item) => {
      item.setTitle(title)
        .setIcon(prop.icon || 'calendar')
        .setSection(sectionId);

      if (prop.disabled) {
        item.setDisabled(true);
        (item as any).setTitle(`${title} (Mixed Profiles)`);
        return;
      }

      item.onClick(async () => {
        if (await this.plugin.fieldInitializationService.checkAndInitialize(entries, prop.key, '')) {
          return; // Field initialized, user can click again to set date
        }
        this.delegates.openScheduledModal(entries, prop.key);
      });
    });
  }

  addRecurrenceToMenu(menu: Menu, entries: any[], prop: any, sectionId: string) {
    const recurrenceRule = this.delegates.getRecurrenceValue(entries[0].frontmatter);
    const isUndefined = !this.plugin.fieldInitializationService.isFieldDefinedForEntries(entries, prop.key);
    const title = isUndefined ? `${prop.label} (create field)` : (recurrenceRule ? `Edit ${prop.label}...` : `Add ${prop.label}...`);

    menu.addItem((item) => {
      item.setTitle(title)
        .setIcon(prop.icon || 'repeat')
        .setSection(sectionId);

      if (prop.disabled) {
        item.setDisabled(true);
        (item as any).setTitle(`${title} (Mixed Profiles)`);
        return;
      }

      item.onClick(async () => {
        if (await this.plugin.fieldInitializationService.checkAndInitialize(entries, prop.key, '')) {
          return; // Field initialized, user can click again to set recurrence
        }
        this.delegates.openRecurrenceModalNative(entries);
      });
    });
  }

  addFolderToMenu(menu: Menu, entries: any[], prop: any, sectionId: string) {
    const files = entries.map((e: any) => e.file);
    const inArchive = this.isFileInArchive(files);

    menu.addItem((item) => {
      const folder = entries[0].file.parent?.path || '/';
      item.setTitle(`${prop.label}: ${folder}`)
        .setIcon(prop.icon || 'folder')
        .setSection(sectionId);

      if (prop.disabled) {
        item.setDisabled(true);
        (item as any).setTitle(`${prop.label}: ${folder} (Mixed Profiles)`);
        return;
      }

      if (inArchive) {
        item.setDisabled(true);
        (item as any).setTitle(`${prop.label}: ${folder} (unarchive to move)`);
        return;
      }

      const subMenu = (item as any).setSubmenu();
      this.populateFolderMenu(subMenu, entries);
    });
  }

  populateFolderMenu(menu: Menu, entries: any[]) {
    const options = this.delegates.getTypeFolderOptions();
    options.forEach(({ path, label }) => {
      menu.addItem(item => {
        item.setTitle(label)
          .setChecked(entries[0].file.parent?.path === path)
          .onClick(async () => {
            await this.delegates.moveFiles(entries, path);
          });
      });
    });
  }
}
