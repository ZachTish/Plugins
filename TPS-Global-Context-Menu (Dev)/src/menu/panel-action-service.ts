import {
  App,
  FuzzySuggestModal,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  normalizePath,
  Platform,
  TFile,
  WorkspaceLeaf,
} from 'obsidian';
import TPSGlobalContextMenuPlugin from '../main';
import * as logger from '../logger';
import { FileSuggestModal } from '../modals/FileSuggestModal';
import { MultiFileSelectModal } from '../modals/MultiFileSelectModal';
import { CreateSubitemModal } from '../modals/create-subitem-modal';
import { ConfirmDeleteModal } from '../modals/confirm-delete-modal';
import { CameraCaptureModal } from '../modals/camera-capture-modal';
import { TextInputModal } from '../modals/text-input-modal';
import { parseLinksFromFrontmatterValue } from '../services/link-target-service';
import { getFolderPathOptions, getUniqueMarkdownPath, sanitizeSubitemTitle } from '../services/subitem-creation-service';

const ATTACHMENTS_FRONTMATTER_KEY = 'attachments';

type ViewMode = 'reading' | 'live' | 'source';

export class PanelActionService {
  constructor(
    private readonly plugin: TPSGlobalContextMenuPlugin,
    private readonly delegates: {
      archiveEntries: (entries: any[]) => Promise<void>;
    },
  ) {}

  private get app(): App {
    return this.plugin.app;
  }

  async setViewModeForFile(file: TFile, mode: ViewMode): Promise<void> {
    let targetLeaf = this.app.workspace.getLeavesOfType('markdown')
      .find((leaf: any) => leaf?.view?.file?.path === file.path) || null;

    if (!targetLeaf) {
      const activeLeaf = this.app.workspace.activeLeaf as any;
      if (activeLeaf?.view?.getViewType?.() === 'markdown') {
        targetLeaf = activeLeaf;
      }
    }

    if (!targetLeaf) {
      targetLeaf = this.app.workspace.getLeaf(false) as any;
    }
    if (!targetLeaf) return;

    const currentFilePath = (targetLeaf.view as any)?.file?.path;
    if (currentFilePath !== file.path) {
      await this.plugin.openFileInLeaf(file, false, () => targetLeaf, { revealLeaf: false });
    }

    const view = targetLeaf.view as any;
    if (!view || view.getViewType?.() !== 'markdown') return;

    const state = { ...view.getState() };
    if (mode === 'reading') {
      state.mode = 'preview';
      delete state.source;
    } else if (mode === 'live') {
      state.mode = 'source';
      state.source = false;
    } else {
      state.mode = 'source';
      state.source = true;
    }

    await view.setState(state, { history: true });
    this.plugin.suppressViewModeSwitchForPathUntilFocusChange(file.path);
  }

  async promptRenameFile(file: TFile): Promise<void> {
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

  openFileInPreferredLeaf(file: TFile): void {
    void this.plugin.openFileInLeaf(file, false, () => this.app.workspace.getLeaf(false), { revealLeaf: true });
  }

  async promptAttachFiles(parentFile: TFile, onRefresh: () => void): Promise<void> {
    if (parentFile.extension?.toLowerCase() !== 'md') {
      new Notice('Attachments can only be managed from markdown notes.');
      return;
    }

    new MultiFileSelectModal(this.app, async (files: TFile[]) => {
      const added = await this.addFilesToAttachmentsFrontmatter(parentFile, files);
      if (added > 0) {
        new Notice(`Attached ${added} item(s) to ${parentFile.basename}.`);
        onRefresh();
      }
    }).open();
  }

  async changeRelationToAttachment(rootFile: TFile, childFile: TFile): Promise<void> {
    await this.plugin.subitemRelationshipSyncService.unlinkChildFromParent(childFile, rootFile);
    await this.addFilesToAttachmentsFrontmatter(rootFile, [childFile]);
  }

  async changeRelationToChild(rootFile: TFile, targetFile: TFile): Promise<void> {
    await this.removeFromAttachmentsFrontmatter(rootFile, targetFile);
    await this.plugin.bulkEditService.linkToParent([targetFile], rootFile);
  }

  showSubitemAddMenu(event: MouseEvent, file: TFile): void {
    const menu = new Menu();
    menu.addItem((item) => {
      item.setTitle('Add to board...')
        .setIcon('layout-grid')
        .onClick(() => {
          void this.addFilesToBoard([file]);
        });
    });
    menu.showAtMouseEvent(event);
  }

  showInsertMenu(e: MouseEvent, entries: any[]): void {
    const menu = new Menu();
    const isMd = entries.length === 1 && entries[0].file.extension === 'md';
    if (!isMd) return;

    const currentFile = entries[0].file as TFile;

    menu.addItem(item => {
      item.setTitle('Insert Template')
        .setIcon('layout-template')
        .onClick(() => {
          void this.ensureEditModeAndExecute(() => this.triggerTemplateInsert());
        });
    });

    menu.addItem(item => {
      item.setTitle('Create Handwritten Note')
        .setIcon('pencil')
        .onClick(() => {
          void this.ensureEditModeAndExecute(() => this.triggerHandwriting());
        });
    });

    menu.addItem(item => {
      item.setTitle('Insert Voice Recording')
        .setIcon('mic')
        .onClick(() => {
          void this.ensureEditModeAndExecute(() => this.triggerVoiceRecording());
        });
    });

    menu.addItem(item => {
      item.setTitle('Insert Photo')
        .setIcon('camera')
        .onClick(() => {
          void this.ensureEditModeAndExecute(() => {
            void this.triggerInsertPhoto();
          });
        });
    });

    menu.addSeparator();

    menu.addItem(item => {
      item.setTitle('Create Note')
        .setIcon('file-plus')
        .onClick(() => {
          void this.createNoteAndAddAsAttachment(currentFile);
        });
    });

    menu.addItem(item => {
      item.setTitle('Attach Existing Note')
        .setIcon('link')
        .onClick(() => {
          void this.attachExistingNoteAsAttachment(currentFile);
        });
    });

    menu.showAtMouseEvent(e);
  }

  showLinkMenu(e: MouseEvent, entries: any[]): void {
    const menu = new Menu();
    const sourceFiles = entries
      .map((entry) => entry?.file)
      .filter((file): file is TFile => file instanceof TFile);
    const currentFile = sourceFiles[0];

    menu.addItem(item => {
      item.setTitle('Link to Parent')
        .setIcon('link')
        .onClick(() => {
          new FileSuggestModal(this.app, async (file: TFile) => {
            await this.plugin.bulkEditService.linkToParent(entries.map(e => e.file), file);
            new Notice(`Linked to parent: ${file.basename}`);
          }, { extensions: ['md', 'base'] }).open();
        });
    });

    menu.addItem(item => {
      item.setTitle('Link Children')
        .setIcon('network')
        .onClick(() => {
          if (!currentFile) {
            new Notice('No source file selected.');
            return;
          }
          new MultiFileSelectModal(this.app, async (files: TFile[]) => {
            if (files.length > 0) {
              await this.plugin.bulkEditService.linkChildren(currentFile, files);
              new Notice(`Linked ${files.length} children.`);
            }
          }).open();
        });
    });

    menu.addItem(item => {
      item.setTitle('Link Attachments')
        .setIcon('paperclip')
        .onClick(() => {
          if (!currentFile) {
            new Notice('No source file selected.');
            return;
          }
          new MultiFileSelectModal(this.app, async (files: TFile[]) => {
            if (files.length > 0) {
              const added = await this.plugin.bulkEditService.linkAttachments(currentFile, files);
              new Notice(`Linked ${added} attachment(s).`);
            }
          }).open();
        });
    });

    menu.addItem(item => {
      item.setTitle('Add to Board...')
        .setIcon('layout-grid')
        .onClick(() => {
          void this.addFilesToBoard(sourceFiles);
        });
    });

    menu.showAtMouseEvent(e);
  }

  showOptionsMenu(e: MouseEvent, entries: any[]): void {
    const menu = new Menu();
    const file = entries[0].file;
    const isMd = file.extension === 'md';
    const currentFile = entries[0].file as TFile;

    if (isMd) {
      menu.addItem(item => {
        item.setTitle('Insert Template')
          .setIcon('layout-template')
          .onClick(() => {
            void this.ensureEditModeAndExecute(() => this.triggerTemplateInsert());
          });
      });

      menu.addItem(item => {
        item.setTitle('Create Handwritten Note')
          .setIcon('pencil')
          .onClick(() => {
            void this.ensureEditModeAndExecute(() => this.triggerHandwriting());
          });
      });

      menu.addItem(item => {
        item.setTitle('Insert Voice Recording')
          .setIcon('mic')
          .onClick(() => {
            void this.ensureEditModeAndExecute(() => this.triggerVoiceRecording());
          });
      });

      menu.addItem(item => {
        item.setTitle('Insert Photo')
          .setIcon('camera')
          .onClick(() => {
            void this.ensureEditModeAndExecute(() => {
              void this.triggerInsertPhoto();
            });
          });
      });

      menu.addSeparator();

      menu.addItem(item => {
        item.setTitle('Create Note')
          .setIcon('file-plus')
          .onClick(() => {
            void this.createNoteAndAddAsAttachment(currentFile);
          });
      });

      menu.addItem(item => {
        item.setTitle('Attach Existing Note')
          .setIcon('link')
          .onClick(() => {
            void this.attachExistingNoteAsAttachment(currentFile);
          });
      });

      menu.addSeparator();
    }

    if (isMd) {
      const sourceFiles = entries
        .map((entry) => entry?.file)
        .filter((entryFile): entryFile is TFile => entryFile instanceof TFile);

      menu.addItem(item => {
        item.setTitle('Link to Parent')
          .setIcon('link')
          .onClick(() => {
            new FileSuggestModal(this.app, async (parentFile: TFile) => {
              await this.plugin.bulkEditService.linkToParent(entries.map(entry => entry.file), parentFile);
              new Notice(`Linked to parent: ${parentFile.basename}`);
            }, { extensions: ['md', 'base'] }).open();
          });
      });

      menu.addItem(item => {
        item.setTitle('Link Children')
          .setIcon('network')
          .onClick(() => {
            if (!currentFile) {
              new Notice('No source file selected.');
              return;
            }
            new MultiFileSelectModal(this.app, async (files: TFile[]) => {
              if (files.length > 0) {
                await this.plugin.bulkEditService.linkChildren(currentFile, files);
                new Notice(`Linked ${files.length} children.`);
              }
            }).open();
          });
      });

      menu.addItem(item => {
        item.setTitle('Link Attachments')
          .setIcon('paperclip')
          .onClick(() => {
            if (!currentFile) {
              new Notice('No source file selected.');
              return;
            }
            new MultiFileSelectModal(this.app, async (files: TFile[]) => {
              if (files.length > 0) {
                const added = await this.plugin.bulkEditService.linkAttachments(currentFile, files);
                new Notice(`Linked ${added} attachment(s).`);
              }
            }).open();
          });
      });

      menu.addItem(item => {
        item.setTitle('Add to Board...')
          .setIcon('layout-grid')
          .onClick(() => {
            void this.addFilesToBoard(sourceFiles);
          });
      });

      menu.addSeparator();
    }

    menu.addItem(item => {
      item.setTitle('Rename')
        .setIcon('pencil')
        .onClick(() => {
          void this.promptRenameFile(file);
        });
    });

    menu.addSeparator();

    if (this.plugin.settings.enableInlineManualViewMode !== false && isMd) {
      menu.addItem(item => item.setTitle('Reading View').setIcon('book-open').onClick(() => void this.setViewModeForFile(file, 'reading')));
      menu.addItem(item => item.setTitle('Live Preview').setIcon('eye').onClick(() => void this.setViewModeForFile(file, 'live')));
      menu.addItem(item => item.setTitle('Source Mode').setIcon('file-code-2').onClick(() => void this.setViewModeForFile(file, 'source')));
      menu.addSeparator();
    }

    menu.addItem(item => {
      item.setTitle('Open in New Tab')
        .setIcon('square-plus')
        .onClick(async () => {
          await this.plugin.openFileInLeaf(file, 'tab', () => this.app.workspace.getLeaf('tab'));
        });
    });

    menu.addItem(item => {
      item.setTitle('Duplicate')
        .setIcon('copy')
        .onClick(async () => {
          const folder = file.parent?.path || '';
          const ext = file.extension ? `.${file.extension}` : '';
          let candidate = folder ? `${folder}/${file.basename} copy${ext}` : `${file.basename} copy${ext}`;
          let counter = 2;
          while (this.app.vault.getAbstractFileByPath(candidate)) {
            candidate = folder ? `${folder}/${file.basename} copy ${counter}${ext}` : `${file.basename} copy ${counter}${ext}`;
            counter += 1;
          }
          const content = await this.app.vault.readBinary(file);
          await this.app.vault.createBinary(candidate, content);
        });
    });

    menu.addItem(item => {
      item.setTitle('Copy Path')
        .setIcon('link')
        .onClick(() => {
          void navigator.clipboard.writeText(file.path);
          new Notice('Path copied');
        });
    });

    menu.addSeparator();

    menu.addItem(item => {
      item.setTitle('Archive')
        .setIcon('archive')
        .onClick(() => {
          void this.delegates.archiveEntries(entries);
        });
    });

    menu.addItem(item => {
      item.setTitle('Delete')
        .setIcon('trash-2')
        .setWarning(true)
        .onClick(() => {
          const modal = new ConfirmDeleteModal(this.app, `Delete "${file.basename}"?`, async () => {
            await this.plugin.runQueuedDelete([file], async () => {
              await this.app.vault.trash(file, true);
            });
          });
          modal.open();
        });
    });

    menu.showAtMouseEvent(e);
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

  async ensureEditModeAndExecute(callback: () => void): Promise<void> {
    const activeLeaf = this.app.workspace.activeLeaf;
    const view = activeLeaf?.view;

    if (!(view instanceof MarkdownView)) {
      new Notice('No markdown note is active.');
      return;
    }

    const isPreviewMode = (view as any).currentMode?.type === 'preview';
    if (isPreviewMode) {
      const state = activeLeaf.getViewState();
      state.state.mode = 'source';
      await activeLeaf.setViewState(state);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    callback();
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

  private getFrontmatterValueCaseInsensitive(frontmatter: Record<string, any> | null | undefined, key: string): any {
    if (!frontmatter || !key) return undefined;
    if (key in frontmatter) return frontmatter[key];
    const lowerKey = key.toLowerCase();
    const match = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === lowerKey);
    return match ? frontmatter[match] : undefined;
  }

  private setFrontmatterValueCaseInsensitive(frontmatter: Record<string, any>, key: string, value: any): void {
    const existingKey = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    if (existingKey) {
      frontmatter[existingKey] = value;
    } else {
      frontmatter[key] = value;
    }
  }

  private async addFilesToAttachmentsFrontmatter(parentFile: TFile, files: TFile[]): Promise<number> {
    if (parentFile.extension?.toLowerCase() !== 'md') return 0;
    const uniqueFiles = files.filter((file, index) => file.path !== parentFile.path && files.findIndex((candidate) => candidate.path === file.path) === index);
    if (!uniqueFiles.length) return 0;

    let added = 0;
    await this.app.fileManager.processFrontMatter(parentFile, (frontmatter: Record<string, any>) => {
      const existingRaw = this.getFrontmatterValueCaseInsensitive(frontmatter, ATTACHMENTS_FRONTMATTER_KEY);
      const values: string[] = [];
      const seen = new Set<string>();

      const pushValue = (raw: any) => {
        if (typeof raw !== 'string') return;
        const trimmed = raw.trim();
        if (!trimmed) return;
        const lookupKey = trimmed.toLowerCase();
        if (seen.has(lookupKey)) return;
        seen.add(lookupKey);
        values.push(trimmed);
      };

      if (Array.isArray(existingRaw)) {
        existingRaw.forEach((entry) => pushValue(entry));
      } else {
        pushValue(existingRaw);
      }

      const startCount = values.length;
      uniqueFiles.forEach((file) => {
        const link = this.app.fileManager.generateMarkdownLink(file, parentFile.path);
        pushValue(link);
      });

      added = values.length - startCount;
      this.setFrontmatterValueCaseInsensitive(frontmatter, ATTACHMENTS_FRONTMATTER_KEY, values);
    });

    return added;
  }

  private async removeFromAttachmentsFrontmatter(rootFile: TFile, targetFile: TFile): Promise<void> {
    await this.app.fileManager.processFrontMatter(rootFile, (fm: Record<string, any>) => {
      const existingRaw = this.getFrontmatterValueCaseInsensitive(fm, ATTACHMENTS_FRONTMATTER_KEY);
      const existing = parseLinksFromFrontmatterValue(this.app, existingRaw, rootFile.path);
      const filtered = existing.filter((file) => file.path !== targetFile.path);
      const existingKey = Object.keys(fm).find((key) => key.toLowerCase() === ATTACHMENTS_FRONTMATTER_KEY.toLowerCase());
      if (filtered.length === 0) {
        if (existingKey) delete fm[existingKey];
      } else {
        const links = filtered.map((file) => this.app.fileManager.generateMarkdownLink(file, rootFile.path));
        this.setFrontmatterValueCaseInsensitive(fm, ATTACHMENTS_FRONTMATTER_KEY, links);
      }
    });
  }

  async createNoteAndAddAsAttachment(parentFile: TFile): Promise<void> {
    if (parentFile.extension?.toLowerCase() !== 'md') {
      new Notice('Parent must be a markdown note.');
      return;
    }

    const modal = await new Promise<{ title: string; folderPath: string } | null>((resolve) => {
      const defaultFolderPath = this.plugin.settings.defaultAttachmentsPath || parentFile.parent?.path || '/';
      const createModal = new CreateSubitemModal(this.app, getFolderPathOptions(this.app), defaultFolderPath, resolve);
      createModal.open();
      createModal.titleEl.textContent = 'Create New Note';
    });

    if (!modal) return;

    const cleanedTitle = sanitizeSubitemTitle(modal.title);
    if (!cleanedTitle) {
      new Notice('Note title cannot be empty.');
      return;
    }

    const folderPath = modal.folderPath === '/' ? '' : normalizePath(modal.folderPath);
    if (folderPath) {
      await this.ensureFolderPath(folderPath);
    }

    const targetPath = getUniqueMarkdownPath(this.app, folderPath, cleanedTitle);
    const escapedTitle = cleanedTitle.replace(/"/g, '\\"');
    const initialContent = `---\ntitle: "${escapedTitle}"\n---\n\n`;

    let created: TFile;
    try {
      created = await this.app.vault.create(targetPath, initialContent);
    } catch (error) {
      logger.error('[TPS GCM] Failed creating note:', error);
      new Notice('Failed to create note.');
      return;
    }

    try {
      const parentCache = this.app.metadataCache.getFileCache(parentFile);
      const parentFm = (parentCache?.frontmatter || {}) as Record<string, any>;
      const existingRaw = this.getFrontmatterValueCaseInsensitive(parentFm, ATTACHMENTS_FRONTMATTER_KEY);
      const existingAttachments = parseLinksFromFrontmatterValue(this.app, existingRaw, parentFile.path);
      const allAttachments = [...existingAttachments, created];
      const attachmentLinks = allAttachments.map((file) => `[[${file.path}]]`).join(', ');
      await this.app.fileManager.processFrontMatter(parentFile, (fm) => {
        this.setFrontmatterValueCaseInsensitive(fm, ATTACHMENTS_FRONTMATTER_KEY, attachmentLinks);
      });
    } catch (error) {
      logger.warn('[TPS GCM] Failed adding note to parent attachments:', error);
    }

    const shouldEmbedAndOpen = await new Promise<boolean>((resolve) => {
      const dialog = new Modal(this.app);
      dialog.titleEl.textContent = 'Embed Note?';
      dialog.contentEl.createEl('p', { text: `Would you like to embed this note in ${parentFile.basename} and open it?` });

      const buttonContainer = dialog.contentEl.createDiv({ cls: 'modal-button-container' });
      const embedBtn = buttonContainer.createEl('button', { text: 'Embed & Open', cls: 'mod-cta' });
      embedBtn.onclick = () => {
        dialog.close();
        resolve(true);
      };

      const skipBtn = buttonContainer.createEl('button', { text: 'Skip' });
      skipBtn.onclick = () => {
        dialog.close();
        resolve(false);
      };

      dialog.open();
    });

    if (shouldEmbedAndOpen) {
      try {
        const parentContent = await this.app.vault.read(parentFile);
        const embedCode = `![[${created.basename}]]`;
        const newContent = `${parentContent.trimRight()}\n\n${embedCode}`;
        await this.app.vault.modify(parentFile, newContent);
      } catch (error) {
        logger.warn('[TPS GCM] Failed embedding note:', error);
      }

      await this.plugin.openFileInLeaf(created, false, () => this.app.workspace.getLeaf(false), { revealLeaf: true });
    }

    new Notice(`Created note: ${created.basename}`);
  }

  async attachExistingNoteAsAttachment(parentFile: TFile): Promise<void> {
    if (parentFile.extension?.toLowerCase() !== 'md') {
      new Notice('Parent must be a markdown note.');
      return;
    }

    const selection = await new Promise<TFile | null>((resolve) => {
      const modal = new FileSuggestModal(this.app, (file: TFile) => {
        resolve(file);
      });
      modal.open();
    });

    if (!selection || selection.path === parentFile.path) {
      if (selection?.path === parentFile.path) {
        new Notice('Cannot attach a note to itself.');
      }
      return;
    }

    try {
      const parentCache = this.app.metadataCache.getFileCache(parentFile);
      const parentFm = (parentCache?.frontmatter || {}) as Record<string, any>;
      const existingRaw = this.getFrontmatterValueCaseInsensitive(parentFm, ATTACHMENTS_FRONTMATTER_KEY);
      const existingAttachments = parseLinksFromFrontmatterValue(this.app, existingRaw, parentFile.path);
      if (existingAttachments.some((file) => file.path === selection.path)) {
        new Notice(`${selection.basename} is already attached.`);
        return;
      }

      const allAttachments = [...existingAttachments, selection];
      const attachmentLinks = allAttachments.map((file) => `[[${file.path}]]`).join(', ');
      await this.app.fileManager.processFrontMatter(parentFile, (fm) => {
        this.setFrontmatterValueCaseInsensitive(fm, ATTACHMENTS_FRONTMATTER_KEY, attachmentLinks);
      });

      new Notice(`Attached: ${selection.basename}`);
    } catch (error) {
      logger.error('[TPS GCM] Failed attaching note:', error);
      new Notice('Failed to attach note.');
    }

    const shouldEmbed = await new Promise<boolean>((resolve) => {
      const dialog = new Modal(this.app);
      dialog.titleEl.textContent = 'Embed Note?';
      dialog.contentEl.createEl('p', { text: `Would you like to embed ${selection.basename} in ${parentFile.basename}?` });

      const buttonContainer = dialog.contentEl.createDiv({ cls: 'modal-button-container' });
      const embedBtn = buttonContainer.createEl('button', { text: 'Embed', cls: 'mod-cta' });
      embedBtn.onclick = () => {
        dialog.close();
        resolve(true);
      };

      const skipBtn = buttonContainer.createEl('button', { text: 'Skip' });
      skipBtn.onclick = () => {
        dialog.close();
        resolve(false);
      };

      dialog.open();
    });

    if (shouldEmbed) {
      try {
        const parentContent = await this.app.vault.read(parentFile);
        const embedCode = `![[${selection.basename}]]`;
        if (!parentContent.includes(embedCode)) {
          const newContent = `${parentContent.trimRight()}\n\n${embedCode}`;
          await this.app.vault.modify(parentFile, newContent);
        }
      } catch (error) {
        logger.warn('[TPS GCM] Failed embedding note:', error);
      }
    }
  }

  private triggerTemplateInsert(): void {
    const app = this.app as any;
    if (app.plugins?.getPlugin('templater-obsidian')) {
      app.commands.executeCommandById('templater-obsidian:insert-templater');
    } else {
      app.commands.executeCommandById('editor:insert-template');
    }
  }

  triggerHandwriting(): void {
    const app = this.app as any;
    const cmdId = 'handwritten-notes:quick-create-embed';
    if (app.commands.findCommand(cmdId)) {
      app.commands.executeCommandById(cmdId);
    } else {
      app.commands.executeCommandById('handwritten-notes:modal-create-embed');
    }
  }

  triggerVoiceRecording(): void {
    const app = this.app as any;
    const commandsApi = app.commands as any;

    const preferredIds = [
      'audio-recorder:start',
      'audio-recorder:start-stop',
      'audio-recorder:start-stop-recording',
      'audio-recorder:record',
      'audio-recorder:insert-recording',
    ];

    for (const id of preferredIds) {
      if (commandsApi?.findCommand?.(id)) {
        commandsApi.executeCommandById(id);
        return;
      }
    }

    const allCommands: Array<{ id?: string; name?: string }> =
      typeof commandsApi?.listCommands === 'function'
        ? commandsApi.listCommands()
        : Object.values(commandsApi?.commands ?? {});

    const discovered = allCommands.find((cmd) => {
      const id = (cmd?.id ?? '').toLowerCase();
      const name = (cmd?.name ?? '').toLowerCase();
      const isAudioRecorder = id.includes('audio-recorder');
      const looksLikeRecordAction =
        name.includes('record') ||
        name.includes('voice') ||
        (name.includes('audio') && name.includes('insert'));
      return isAudioRecorder && looksLikeRecordAction;
    });

    if (discovered?.id && commandsApi?.findCommand?.(discovered.id)) {
      commandsApi.executeCommandById(discovered.id);
      return;
    }

    new Notice('Voice recorder command not found. Enable the core Audio Recorder plugin.');
  }

  async triggerInsertPhoto(): Promise<void> {
    let imageBlob: Blob | null = null;

    if (Platform.isMobile) {
      imageBlob = await this.openImageCaptureInput(true);
    } else {
      imageBlob = await this.capturePhotoWithWebcam();
      if (!imageBlob) {
        imageBlob = await this.openImageCaptureInput(false);
      }
    }

    if (!imageBlob) return;

    const attachmentFile = await this.saveImageBlobAsAttachment(imageBlob);
    if (!attachmentFile) return;

    this.insertAttachmentLinkIntoEditorOrClipboard(attachmentFile);
  }

  private async capturePhotoWithWebcam(): Promise<Blob | null> {
    if (!navigator.mediaDevices?.getUserMedia) {
      return null;
    }

    return new Promise<Blob | null>((resolve) => {
      const modal = new CameraCaptureModal(this.app, resolve);
      modal.open();
    });
  }

  private async openImageCaptureInput(preferCamera: boolean): Promise<Blob | null> {
    return new Promise<Blob | null>((resolve) => {
      const input = document.createElement('input');
      let settled = false;

      const finish = (value: Blob | null) => {
        if (settled) return;
        settled = true;
        try {
          input.remove();
        } catch {
          // ignore cleanup errors
        }
        resolve(value);
      };

      input.type = 'file';
      input.accept = 'image/*';
      if (preferCamera) {
        input.setAttribute('capture', 'environment');
      }
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      input.style.width = '1px';
      input.style.height = '1px';
      input.style.opacity = '0';

      const handleChange = () => {
        const file = input.files?.[0] ?? null;
        finish(file);
      };

      const handleWindowFocus = () => {
        window.setTimeout(() => {
          if (!settled) {
            finish(null);
          }
        }, 250);
      };

      input.addEventListener('change', handleChange, { once: true });
      window.addEventListener('focus', handleWindowFocus, { once: true });

      document.body.appendChild(input);
      input.click();
    });
  }

  private async saveImageBlobAsAttachment(blob: Blob): Promise<TFile | null> {
    const extension = this.getImageExtension(blob.type);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `photo-${timestamp}.${extension}`;
    const activeFile = this.app.workspace.getActiveFile();
    const sourcePath = activeFile?.path;

    try {
      const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment(filename, sourcePath);
      const data = await blob.arrayBuffer();
      return await this.app.vault.createBinary(attachmentPath, data);
    } catch (error) {
      logger.error('[TPS GCM] Failed saving photo attachment:', error);
      new Notice('Failed to save photo attachment.');
      return null;
    }
  }

  private getImageExtension(mimeType: string): string {
    const mime = String(mimeType || '').toLowerCase();
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('gif')) return 'gif';
    if (mime.includes('heic') || mime.includes('heif')) return 'heic';
    return 'jpg';
  }

  private insertAttachmentLinkIntoEditorOrClipboard(file: TFile): void {
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const sourcePath = markdownView?.file?.path ?? file.path;
    const markdownLink = this.app.fileManager.generateMarkdownLink(file, sourcePath);

    if (markdownView?.editor) {
      markdownView.editor.replaceSelection(markdownLink);
      new Notice(`Inserted photo: ${file.name}`);
      return;
    }

    try {
      void navigator.clipboard.writeText(markdownLink);
      new Notice(`Saved ${file.name}. Link copied to clipboard.`);
    } catch {
      new Notice(`Saved ${file.name}.`);
    }
  }

  private async addFilesToBoard(files: TFile[]): Promise<void> {
    if (!files.length) {
      new Notice('Select at least one file first.');
      return;
    }

    const boardFile = await this.pickCanvasFile();
    if (!boardFile) return;

    let canvasData: any = {};
    try {
      const raw = await this.app.vault.read(boardFile);
      if (raw.trim()) {
        canvasData = JSON.parse(raw);
      }
    } catch (error) {
      logger.error('[TPS GCM] Failed to parse canvas file:', boardFile.path, error);
      new Notice(`Unable to read board: ${boardFile.basename}`);
      return;
    }

    if (!canvasData || typeof canvasData !== 'object') {
      canvasData = {};
    }
    if (!Array.isArray(canvasData.nodes)) {
      canvasData.nodes = [];
    }
    if (!Array.isArray(canvasData.edges)) {
      canvasData.edges = [];
    }

    const nodes = canvasData.nodes as Array<Record<string, any>>;
    const existingFileNodes = new Set(
      nodes
        .filter((node) => node?.type === 'file' && typeof node.file === 'string')
        .map((node) => normalizePath(String(node.file))),
    );

    const filesToAdd = files.filter((file) => !existingFileNodes.has(normalizePath(file.path)));
    if (!filesToAdd.length) {
      new Notice(`All selected files are already on ${boardFile.basename}.`);
      return;
    }

    const nodeWidth = 320;
    const nodeHeight = 200;
    const gap = 40;
    const columns = 3;

    let maxBottom = 0;
    for (const node of nodes) {
      const y = Number(node?.y);
      const height = Number(node?.height);
      if (!Number.isFinite(y)) continue;
      const resolvedHeight = Number.isFinite(height) ? height : nodeHeight;
      maxBottom = Math.max(maxBottom, y + resolvedHeight);
    }

    const startX = 40;
    const startY = maxBottom > 0 ? maxBottom + gap : 40;

    filesToAdd.forEach((file, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      nodes.push({
        id: this.generateCanvasNodeId(),
        type: 'file',
        file: file.path,
        x: startX + col * (nodeWidth + gap),
        y: startY + row * (nodeHeight + gap),
        width: nodeWidth,
        height: nodeHeight,
      });
    });

    try {
      await this.app.vault.modify(boardFile, JSON.stringify(canvasData, null, 2));
      new Notice(`Added ${filesToAdd.length} file(s) to ${boardFile.basename}.`);
    } catch (error) {
      logger.error('[TPS GCM] Failed to update canvas board:', boardFile.path, error);
      new Notice(`Failed to update ${boardFile.basename}.`);
    }
  }

  private async pickCanvasFile(): Promise<TFile | null> {
    const canvasFiles = this.app.vault.getFiles()
      .filter((file) => file.extension?.toLowerCase() === 'canvas')
      .sort((a, b) => b.stat.mtime - a.stat.mtime);

    if (!canvasFiles.length) {
      new Notice('No canvas files found in this vault.');
      return null;
    }

    return new Promise<TFile | null>((resolve) => {
      let settled = false;
      const finish = (value: TFile | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      class CanvasPickerModal extends FuzzySuggestModal<TFile> {
        getItems(): TFile[] {
          return canvasFiles;
        }

        getItemText(item: TFile): string {
          return item.path;
        }

        onChooseItem(item: TFile): void {
          finish(item);
        }

        onClose(): void {
          finish(null);
        }
      }

      const modal = new CanvasPickerModal(this.app);
      modal.setPlaceholder('Choose canvas board...');
      modal.open();
    });
  }

  private generateCanvasNodeId(): string {
    return `tps-gcm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
