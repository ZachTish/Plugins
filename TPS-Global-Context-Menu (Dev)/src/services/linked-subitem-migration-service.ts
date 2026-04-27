import { Notice, TFile } from 'obsidian';
import TPSGlobalContextMenuPlugin from '../main';
import * as logger from '../logger';
import { FileSuggestModal } from '../modals/FileSuggestModal';

export class LinkedSubitemMigrationService {
  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  async promptAndMigrateLinkedChildren(sourceFile: TFile): Promise<void> {
    if (!(sourceFile instanceof TFile) || sourceFile.extension?.toLowerCase() !== 'md') {
      new Notice('Linked subitem migration only works on markdown notes.');
      return;
    }

    const destinationFile = await new Promise<TFile | null>((resolve) => {
      let settled = false;
      const finish = (value: TFile | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const modal = new (class extends FileSuggestModal {
        onClose() {
          finish(null);
        }
      })(this.plugin.app, async (file: TFile) => finish(file), { extensions: ['md'] });
      modal.open();
    });

    if (!destinationFile) return;
    if (destinationFile.path === sourceFile.path) {
      new Notice('Choose a different destination note.');
      return;
    }

    const result = await this.migrateLinkedChildren(sourceFile, destinationFile);
    if (result.moved === 0) {
      new Notice(`No linked children found in ${sourceFile.basename}.`);
      return;
    }

    new Notice(
      `Moved ${result.moved} linked child${result.moved === 1 ? '' : 'ren'} from ${sourceFile.basename} to ${destinationFile.basename}.`,
    );
  }

  async migrateLinkedChildren(sourceFile: TFile, destinationFile: TFile): Promise<{ moved: number }> {
    const links = await this.plugin.bodySubitemLinkService.scanFile(sourceFile);
    if (links.length === 0) return { moved: 0 };

    let moved = 0;
    for (const link of links) {
      const childFile = link.childFile;
      if (!(childFile instanceof TFile) || childFile.path === sourceFile.path || childFile.path === destinationFile.path) {
        continue;
      }

      try {
        await this.plugin.subitemRelationshipSyncService.linkExistingChildToParent(childFile, destinationFile, {
          insertBodyLink: true,
          checkboxState: link.checkboxState,
        });
        await this.plugin.subitemRelationshipSyncService.unlinkChildFromParent(childFile, sourceFile);
        moved++;
      } catch (error) {
        logger.warn('[TPS GCM] Failed migrating linked child', {
          sourceFile: sourceFile.path,
          destinationFile: destinationFile.path,
          childFile: childFile.path,
          error,
        });
      }
    }

    return { moved };
  }
}
