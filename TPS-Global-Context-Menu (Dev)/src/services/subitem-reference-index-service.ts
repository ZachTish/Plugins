import { TFile } from 'obsidian';
import type TPSGlobalContextMenuPlugin from '../main';
import type { BodySubitemLink } from './subitem-types';

export class SubitemReferenceIndexService {
  constructor(private readonly plugin: TPSGlobalContextMenuPlugin) {}

  async getReferencesForChild(childFile: TFile): Promise<BodySubitemLink[]> {
    const links: BodySubitemLink[] = [];
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      const parsed = await this.plugin.bodySubitemLinkService.scanFile(file);
      links.push(...parsed.filter((entry) => entry.childPath === childFile.path));
    }
    return links;
  }
}

