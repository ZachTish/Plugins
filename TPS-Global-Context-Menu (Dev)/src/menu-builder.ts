import { App, Menu, TFile, TFolder, Notice, normalizePath } from 'obsidian';
import TPSGlobalContextMenuPlugin from './main';
import { SYSTEM_COMMANDS } from './constants';
import { TextInputModal } from './text-input-modal';
import { FileSuggestModal } from './FileSuggestModal';
import { MultiFileSelectModal } from './MultiFileSelectModal';
import { mergeNormalizedTags, normalizeTagValue } from './tag-utils';
import * as logger from './logger';
import { resolveCustomProperties } from './resolve-profiles';
import { ViewModeService } from './view-mode-service';
import { executeCommandById, hasCommand } from './core';

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

  private getUniqueArchiveTargetPath(file: TFile, archiveFolder: string): string {
    // If daily folder is enabled, append YYYY-MM-DD to the archive path
    let finalFolder = archiveFolder;
    if (this.plugin.settings.archiveUseDailyFolder) {
      const today = window.moment().format('YYYY-MM-DD');
      finalFolder = normalizePath(`${archiveFolder}/${today}`);
    }

    const targetBase = normalizePath(`${finalFolder}/${file.name}`);
    let targetPath = targetBase;
    let counter = 1;
    while (this.app.vault.getAbstractFileByPath(targetPath)) {
      targetPath = normalizePath(`${finalFolder}/${file.basename} ${counter}.${file.extension}`);
      counter += 1;
    }
    return targetPath;
  }

  private async archiveFiles(files: TFile[]): Promise<void> {
    const archiveTag = normalizeTagValue(this.plugin.settings.archiveTag || 'archive');
    const archiveFolder = this.plugin.getArchiveFolderPath();
    if (!archiveTag || !archiveFolder) {
      new Notice('Archive tag/folder settings are not configured.');
      return;
    }

    await this.ensureFolderPath(archiveFolder);

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
            await this.app.fileManager.processFrontMatter(file, (frontmatter: any) => {
              frontmatter.tags = mergeNormalizedTags(frontmatter.tags, archiveTag);

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
          const targetPath = this.getUniqueArchiveTargetPath(file, archiveFolder);
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
            await this.app.fileManager.processFrontMatter(file, (frontmatter: any) => {
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
              frontmatter.tags = tags.filter((tag: any) => {
                const normalized = normalizeTagValue(String(tag));
                return normalized !== archiveTag;
              });

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

    // System Commands (All Files)
    const enabledCommands = this.plugin.settings.systemCommands || [];
    const file = entries[0].file;

    // Handwriting / PDF Integration
    if (file.extension === 'pdf') {
      menu.addItem((item) => {
        item.setTitle('Write on PDF')
          .setIcon('pencil')
          .setSection('tps-file-ops')
          .onClick(async () => {
            const app = (this.app as any);
            if (hasCommand(this.app, 'open-with-default-app:open')) {
              executeCommandById(this.app, 'open-with-default-app:open');
              return;
            }

            if (app.openWithDefaultApp && file instanceof TFile) {
              app.openWithDefaultApp(file.path);
              return;
            }

            const knownIds = [
              'handwritten-notes:create',
              'handwritten-notes:modal-create-open',
              'obsidian-handwriting:create'
            ];

            let found = false;
            for (const id of knownIds) {
              if (hasCommand(this.app, id)) {
                executeCommandById(this.app, id);
                found = true;
                break;
              }
            }

            if (!found) {
              new Notice("Could not open PDF with default app or handwriting plugin (checked 'open-with-default-app', native 'openWithDefaultApp', and 'Handwritten Notes').");
            }
          });
      });
    }

    // Dynamic Properties (Markdown Only)
    if (markdownEntries.length > 0) {
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
                    await this.plugin.bulkEditService.updateFrontmatter(markdownEntries.map(e => e.file), { [prop.key]: finalVal });
                  }
                }
              ).open();
            });
          });
        }
      });

      // Add Note Operations (Markdown Only)
      if (markdownFiles.length > 0) {
        menu.addItem((item) =>
          item
            .setTitle("Add to note...")
            .setIcon("file-plus")
            .setSection('tps-note-ops')
            .onClick(() => {
              this.plugin.noteOperationService.addNotesToAnotherNote(markdownFiles);
            })
        );

        menu.addItem((item) =>
          item
            .setTitle("Add to daily note...")
            .setIcon("calendar-plus")
            .setSection('tps-note-ops')
            .onClick(() => {
              this.plugin.noteOperationService.addNotesToDailyNotes(markdownFiles);
            })
        );
      }

      // Link Operations (rendered below frontmatter properties)
      if (file.extension?.toLowerCase() === 'md') {
        menu.addItem((item) => {
          item.setTitle('Link to Parent')
            .setIcon('link')
            .setSection('tps-props')
            .onClick(() => {
              new FileSuggestModal(this.app, async (parentFile: TFile) => {
                await this.plugin.bulkEditService.linkToParent([file], parentFile);
                new Notice(`Linked to parent: ${parentFile.basename}`);
              }).open();
            });
        });

        menu.addItem((item) => {
          item.setTitle('Link Children')
            .setIcon('network')
            .setSection('tps-props')
            .onClick(() => {
              new MultiFileSelectModal(this.app, async (childFiles: TFile[]) => {
                if (childFiles.length > 0) {
                  await this.plugin.bulkEditService.linkChildren(file, childFiles);
                  new Notice(`Linked ${childFiles.length} children to this note.`);
                }
              }).open();
            });
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

    // --- File/System Operations (rendered below properties) ---
    if (enabledCommands.includes('open-in-new-tab')) {
      menu.addItem((item) => {
        item.setTitle('Open in new tab')
          .setIcon('file-plus')
          .setSection('tps-file-ops')
          .onClick(async () => {
            await this.plugin.openFileInLeaf(file, 'tab', () => this.app.workspace.getLeaf('tab'));
          });
      });
    }

    if (enabledCommands.includes('open-to-right')) {
      menu.addItem((item) => {
        item.setTitle('Open to the right')
          .setIcon('separator-vertical')
          .setSection('tps-file-ops')
          .onClick(async () => {
            await this.plugin.openFileInLeaf(file, 'split', () => this.app.workspace.getLeaf('split'));
          });
      });
    }

    if (enabledCommands.includes('open-in-new-window')) {
      menu.addItem((item) => {
        item.setTitle('Open in new window')
          .setIcon('maximize')
          .setSection('tps-file-ops')
          .onClick(async () => {
            await this.plugin.openFileInLeaf(file, 'window', () => this.app.workspace.getLeaf('window'));
          });
      });
    }

    if (enabledCommands.includes('open-in-same-tab')) {
      menu.addItem((item) => {
        item.setTitle('Open in same tab')
          .setIcon('file')
          .setSection('tps-file-ops')
          .onClick(async () => {
            await this.plugin.openFileInLeaf(file, false, () => this.app.workspace.getLeaf(false));
          });
      });
    }

    if (enabledCommands.includes('bookmark')) {
      menu.addItem((item) => {
        // @ts-ignore - accessing internal plugins API
        const bookmarksPlugin = this.app.internalPlugins.getPluginById('bookmarks');
        const bookmarkItems = bookmarksPlugin?.instance?.items || [];
        const existingBookmark = bookmarkItems.find((i: any) => i.path === file.path);
        const isBookmarked = !!existingBookmark;

        item.setTitle(isBookmarked ? 'Remove bookmark' : 'Bookmark')
          .setIcon('bookmark')
          .setSection('tps-file-ops')
          .onClick(async () => {
            if (!bookmarksPlugin?.instance) return;

            try {
              if (isBookmarked && existingBookmark) {
                if (typeof bookmarksPlugin.instance.removeItem === 'function') {
                  bookmarksPlugin.instance.removeItem(existingBookmark);
                } else if (Array.isArray(bookmarksPlugin.instance.items)) {
                  const idx = bookmarksPlugin.instance.items.indexOf(existingBookmark);
                  if (idx > -1) {
                    bookmarksPlugin.instance.items.splice(idx, 1);
                    if (typeof bookmarksPlugin.instance.saveData === 'function') {
                      await bookmarksPlugin.instance.saveData();
                    }
                  }
                }
              } else {
                if (typeof bookmarksPlugin.instance.addItem === 'function') {
                  bookmarksPlugin.instance.addItem({ type: 'file', path: file.path, title: file.basename });
                } else if (Array.isArray(bookmarksPlugin.instance.items)) {
                  bookmarksPlugin.instance.items.push({ type: 'file', path: file.path, title: file.basename });
                  if (typeof bookmarksPlugin.instance.saveData === 'function') {
                    await bookmarksPlugin.instance.saveData();
                  }
                }
              }
            } catch (err) {
              logger.error('[TPS GCM] Bookmark operation failed:', err);
            }
          });
      });
    }

    if (entries.length === 1) {
      menu.addItem((item) => {
        item.setTitle('Rename...')
          .setIcon('pencil')
          .setSection('tps-file-ops')
          .onClick(() => {
            void this.promptRenameFile(file);
          });
      });
    }

    if (enabledCommands.includes('move-file')) {
      menu.addItem((item) => {
        item.setTitle('Move file to...')
          .setIcon('folder-input')
          .setSection('tps-file-ops')
          .onClick(() => {
            // @ts-ignore
            if (typeof this.app.fileManager.promptForFileMove === 'function') {
              // @ts-ignore
              this.app.fileManager.promptForFileMove(file);
            } else {
              executeCommandById(this.app, 'app:move-file');
            }
          });
      });
    }

    if (enabledCommands.includes('duplicate')) {
      menu.addItem((item) => {
        item.setTitle('Duplicate')
          .setIcon('copy')
          .setSection('tps-file-ops')
          .onClick(async () => {
            const baseName = file.basename;
            const ext = file.extension;
            const folder = file.parent?.path || '';
            const isFolder = !ext;
            const name = isFolder ? file.name : baseName;

            let newPath = folder ? `${folder}/${name} copy` : `${name} copy`;
            if (ext) newPath += `.${ext}`;

            let counter = 2;
            while (this.app.vault.getAbstractFileByPath(newPath)) {
              newPath = folder ? `${folder}/${name} copy ${counter}` : `${name} copy ${counter}`;
              if (ext) newPath += `.${ext}`;
              counter++;
            }

            if (file instanceof TFile) {
              const content = await this.app.vault.read(file);
              await this.app.vault.create(newPath, content);
            } else {
              new Notice("Folder duplication not supported yet");
              return;
            }
            new Notice(`Created ${newPath}`);
          });
      });
    }

    if (enabledCommands.includes('copy-url')) {
      menu.addItem((item) => {
        item.setTitle('Copy Obsidian URL')
          .setIcon('link')
          .setSection('tps-file-ops')
          .onClick(() => {
            // @ts-ignore
            const url = this.app.getObsidianUrl(file);
            navigator.clipboard.writeText(url);
            new Notice('Obsidian URL copied');
          });
      });
    }

    if (enabledCommands.includes('get-relative-path')) {
      menu.addItem((item) => {
        item.setTitle('Copy relative path')
          .setIcon('link')
          .setSection('tps-file-ops')
          .onClick(() => {
            navigator.clipboard.writeText(file.path);
            new Notice('Path copied to clipboard');
          });
      });
    }

    if (enabledCommands.includes('reveal-finder')) {
      menu.addItem((item) => {
        item.setTitle('Reveal in system explorer')
          .setIcon('monitor')
          .setSection('tps-reveal-ops')
          .onClick(() => {
            // @ts-ignore
            this.app.showInFolder(file.path);
          });
      });
    }

    if (enabledCommands.includes('reveal-nav')) {
      menu.addItem((item) => {
        item.setTitle('Reveal in navigation')
          .setIcon('folder-open')
          .setSection('tps-reveal-ops')
          .onClick(() => {
            const leaf = this.app.workspace.getLeavesOfType('file-explorer')[0];
            if (leaf && leaf.view) {
              // @ts-ignore
              leaf.view.revealInFolder(file);
            }
          });
      });
    }

    // Restore original methods
    menu.addItem = originalAddItem;
  }

  addSelectorToMenu(menu: Menu, entries: any[], prop: any, sectionId: string) {
    menu.addItem((item) => {
      const allValues = entries.map((e: any) => this.getValueCaseInsensitive(e.frontmatter, prop.key) || '');
      const uniqueValues = new Set(allValues);
      const current = uniqueValues.size === 1 ? allValues[0] : 'Mixed';
      const isUndefined = !this.plugin.fieldInitializationService.isFieldDefinedForEntries(entries, prop.key);
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

      // Add initialization option if undefined
      if (isUndefined) {
        subMenu.addItem((sub: any) => {
          sub.setTitle('Create field')
            .setIcon('plus-circle')
            .onClick(async () => {
              const defaultValue = (prop.options && prop.options[0]) || '';
              await this.plugin.fieldInitializationService.checkAndInitialize(entries, prop.key, defaultValue);
            });
        });
        subMenu.addSeparator();
      }

      (prop.options || []).forEach((opt: string) => {
        subMenu.addItem((sub: any) => {
          sub.setTitle(opt)
            .setChecked(current === opt)
            .onClick(async () => {
              await this.plugin.bulkEditService.updateFrontmatter(entries.map((e: any) => e.file), { [prop.key]: opt });
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
          if (await this.plugin.fieldInitializationService.checkAndInitialize(entries, prop.key, [])) {
            return; // Field initialized, user can click again to add
          }
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
