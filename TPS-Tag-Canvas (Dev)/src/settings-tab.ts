import { App, PluginSettingTab, Setting } from "obsidian";
import TagCanvasPlugin from "./main";

export class TagCanvasSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TagCanvasPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "TPS Tag Canvas" });

    const createMainCategory = (title: string, defaultOpen = true): HTMLElement => {
      const details = containerEl.createEl('details', { cls: 'tps-settings-main-category' });
      if (defaultOpen) details.setAttr('open', 'true');
      const summary = details.createEl('summary', { cls: 'tps-settings-main-summary' });
      summary.createEl('h3', { text: title });
      return details.createDiv({ cls: 'tps-settings-main-content' });
    };

    const featuresCategory = createMainCategory('Features');

    new Setting(featuresCategory)
      .setName("Canvas output folder")
      .setDesc(
        "Vault-relative folder where tag canvas files are stored. Nested tags are flattened to one page " +
        "by leaf name (e.g. #project/coding and #personal/coding both open Tag Canvases/coding.canvas)."
      )
      .addText(text =>
        text
          .setPlaceholder("Tag Canvases")
          .setValue(this.plugin.settings.canvasFolder)
          .onChange(async v => {
            this.plugin.settings.canvasFolder = v.trim() || "Tag Canvases";
            await this.plugin.saveSettings();
          })
      );

    new Setting(featuresCategory)
      .setName("Auto-sync")
      .setDesc("Automatically update tag canvases whenever notes are created, modified, or deleted.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.autoSync)
          .onChange(async v => {
            this.plugin.settings.autoSync = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(featuresCategory)
      .setName("Sync delay (ms)")
      .setDesc("Debounce duration — how long to wait after a change before syncing.")
      .addSlider(slider =>
        slider
          .setLimits(500, 10000, 500)
          .setValue(this.plugin.settings.syncDelayMs)
          .setDynamicTooltip()
          .onChange(async v => {
            this.plugin.settings.syncDelayMs = v;
            await this.plugin.saveSettings();
          })
      );

    featuresCategory.createEl("h3", { text: "Layout" });

    new Setting(featuresCategory)
      .setName("Columns")
      .setDesc("Number of columns in the grid layout when placing new nodes.")
      .addSlider(slider =>
        slider
          .setLimits(1, 6, 1)
          .setValue(this.plugin.settings.columns)
          .setDynamicTooltip()
          .onChange(async v => {
            this.plugin.settings.columns = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Node width (px)")
      .setDesc("Width of each file node.")
      .addText(text =>
        text
          .setValue(String(this.plugin.settings.nodeWidth))
          .onChange(async v => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.nodeWidth = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Node height (px)")
      .setDesc("Height of each file node.")
      .addText(text =>
        text
          .setValue(String(this.plugin.settings.nodeHeight))
          .onChange(async v => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.nodeHeight = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Gap between nodes (px)")
      .setDesc("Spacing between file nodes.")
      .addText(text =>
        text
          .setValue(String(this.plugin.settings.gap))
          .onChange(async v => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n >= 0) {
              this.plugin.settings.gap = n;
              await this.plugin.saveSettings();
            }
          })
      );

    containerEl.createEl("h3", { text: "Exclusions" });

    new Setting(containerEl)
      .setName("Excluded tags")
      .setDesc("Comma-separated tags (without #) to skip. Child tags are also excluded when a parent is listed.")
      .addTextArea(text =>
        text
          .setPlaceholder("daily, weekly, archive")
          .setValue(this.plugin.settings.excludedTags.join(", "))
          .onChange(async v => {
            this.plugin.settings.excludedTags = v
              .split(",")
              .map(t => t.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Excluded folders")
      .setDesc("Comma-separated folder paths whose notes are ignored during tag scanning.")
      .addTextArea(text =>
        text
          .setPlaceholder("Templates, Archive/Old")
          .setValue(this.plugin.settings.excludedFolders.join(", "))
          .onChange(async v => {
            this.plugin.settings.excludedFolders = v
              .split(",")
              .map(t => t.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Archive trigger tags")
      .setDesc(
        "Comma-separated tags (without #) that mark notes as archived/hidden. " +
        "Archived notes are removed from non-archive canvases unless their node is colored, linked, or grouped."
      )
      .addTextArea(text =>
        text
          .setPlaceholder("hide, archive")
          .setValue(this.plugin.settings.archiveTriggerTags.join(", "))
          .onChange(async v => {
            this.plugin.settings.archiveTriggerTags = v
              .split(",")
              .map(t => t.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Archive trigger folders")
      .setDesc(
        "Comma-separated folder paths that mark notes as archived/hidden. " +
        "Examples: Archive, Archive/Old"
      )
      .addTextArea(text =>
        text
          .setPlaceholder("Archive")
          .setValue(this.plugin.settings.archiveTriggerFolders.join(", "))
          .onChange(async v => {
            this.plugin.settings.archiveTriggerFolders = v
              .split(",")
              .map(t => t.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Advanced" });

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Print debug information to the developer console.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.debugLogging)
          .onChange(async v => {
            this.plugin.settings.debugLogging = v;
            await this.plugin.saveSettings();
          })
      );
  }
}
