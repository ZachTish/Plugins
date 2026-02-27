import { Notice, Plugin, TFile, MarkdownView } from "obsidian";
import { CalendarView, CalendarViewType } from "./calendar-view";
import { DEFAULT_CONDENSE_LEVEL } from "./utils";
import { CalendarPluginBridge } from "./plugin-interface";
import { ExternalCalendarService } from "./external-calendar-service";
import { CalendarStyleRule } from "./types";
import { CalendarPluginSettingsTab } from "./settings-tab";
import { removeChildLinkFromParent } from "./parent-child-link";
import {
  createDefaultCondition,
  findStyleOverride,
} from "./style-rule-service";
import { normalizeCalendarUrl, normalizeCalendarTag } from "./utils";
import { ExternalCalendarConfig, CalendarPluginSettings } from "./types";
import { DEFAULT_SETTINGS, migrateSettings } from "./settings-migration";
import { EmbedRenderer } from "./embed-renderer";



export default class ObsidianCalendarPlugin
  extends Plugin
  implements CalendarPluginBridge {
  settings: CalendarPluginSettings = DEFAULT_SETTINGS;
  externalCalendarService: ExternalCalendarService;

  async onload() {
    this.externalCalendarService = new ExternalCalendarService();
    // Load shared UI styles
    try {
      const cssPath = `${this.manifest.dir}/styles-ui.css`;
      const cssContent = await this.app.vault.adapter.read(cssPath);
      this.register(() => document.head.querySelector('style#tps-calendar-ui-styles')?.remove());
      const styleEl = document.head.createEl('style', { attr: { id: 'tps-calendar-ui-styles' } });
      styleEl.textContent = cssContent;
    } catch (e) {
      console.warn("TPS-Calendar-Base: Failed to load styles-ui.css", e);
    }
    this.registerBasesView(CalendarViewType, {
      name: "Calendar",
      icon: "lucide-calendar",
      factory: (controller, containerEl) =>
        new CalendarView(controller, containerEl, this),
      options: () => CalendarView.getOptions(this),
    });
    this.addSettingTab(new CalendarPluginSettingsTab(this.app, this));
    await this.loadSettings();
    this.setupPluginAPI();
    this.refreshCalendarViews();
    this.registerMarkdownPostProcessor(EmbedRenderer(this));

    this.addCommand({
      id: "open-default-calendar-base-sidebar",
      name: "Open default calendar base in right sidebar",
      callback: () => this.openDefaultBaseInSidebar(),
    });

    this.addCommand({
      id: "calendar-set-day-link-target-daily-note",
      name: "Set day link target: Daily note (.md)",
      callback: async () => {
        await this.setDayLinkTarget("daily-note");
      },
    });

    this.addCommand({
      id: "calendar-set-day-link-target-daily-canvas",
      name: "Set day link target: Daily canvas (.canvas)",
      callback: async () => {
        await this.setDayLinkTarget("daily-canvas");
      },
    });

    this.addCommand({
      id: "calendar-toggle-day-link-target",
      name: "Toggle day link target (daily note/canvas)",
      callback: async () => {
        const next =
          this.settings.dailyDateLinkTarget === "daily-canvas"
            ? "daily-note"
            : "daily-canvas";
        await this.setDayLinkTarget(next);
      },
    });
    // Auto-create and cleanup commands removed — handled by TPS-Controller.

    this.addRibbonIcon("calendar", "Open default calendar base", async () => {
      await this.openDefaultBaseInSidebar();
    });

    // Listen for file deletions to remove parent-child links
    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        if (file instanceof TFile && file.extension === "md" && this.settings.parentLinkEnabled && this.settings.childLinkKey) {
          const allFiles = this.app.vault.getMarkdownFiles();

          for (const pFile of allFiles) {
            const cache = this.app.metadataCache.getFileCache(pFile);
            const children = cache?.frontmatter?.[this.settings.childLinkKey];
            if (children === undefined || children === null) continue;
            await removeChildLinkFromParent(this.app, file.basename, pFile, this.settings.childLinkKey);
          }
        }
      })
    );
  }

  private isEditorFocused(): boolean {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const editor = view?.editor as any;
    if (!editor) return false;
    try {
      return typeof editor.hasFocus === "function" ? editor.hasFocus() : false;
    } catch {
      return false;
    }
  }

  onunload() {
    // No intervals to clear — sync is handled by TPS-Controller.
  }

  async loadSettings() {
    const stored = await this.loadData();
    this.settings = migrateSettings(stored);
  }


  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshCalendarViews();
    // Fire a custom workspace event so Bases-registered views also get notified.
    this.app.workspace.trigger("tps-calendar-settings-changed" as any);
  }

  private async setDayLinkTarget(target: "daily-note" | "daily-canvas"): Promise<void> {
    if (this.settings.dailyDateLinkTarget === target) return;
    this.settings.dailyDateLinkTarget = target;
    await this.saveSettings();
    new Notice(
      target === "daily-canvas"
        ? "Calendar day links now open daily canvas files."
        : "Calendar day links now open daily markdown notes."
    );
  }

  // ========================================================================
  // API — Exposed for TPS-Controller to query
  // ========================================================================

  private setupPluginAPI(): void {
    (this as any).api = {
      getExternalCalendarService: (): ExternalCalendarService => this.externalCalendarService,
      getExternalCalendarUrls: (): string[] => this.getExternalCalendarUrls(),
      getSettings: (): Partial<CalendarPluginSettings> => ({ ...this.settings }),
    };
  }




  getCalendarStyleOverride(data: Record<string, any>) {
    return findStyleOverride(
      this.settings.colorRules,
      this.settings.textRules,
      this.settings.calendarStyleRules,
      data,
    );
  }

  getDefaultCondenseLevel(): number {
    return this.settings.defaultCondenseLevel ?? DEFAULT_CONDENSE_LEVEL;
  }

  getEffectiveExternalCalendars(): ExternalCalendarConfig[] {
    // 1. Check TPS-Controller
    const controller = (this.app as any).plugins?.getPlugin("tps-controller");
    if (controller?.settings?.externalCalendars?.length) {
      return controller.settings.externalCalendars;
    }
    // 2. Fallback to local
    return this.settings.externalCalendars ?? [];
  }

  getExternalCalendarUrls(): string[] {
    const calendars = this.getEffectiveExternalCalendars();
    return calendars
      .filter((calendar) => calendar.url && calendar.enabled !== false)
      .map((calendar) => normalizeCalendarUrl(calendar.url))
      .filter(Boolean);
  }

  getExternalCalendarFilter(): string {
    // Check Controller for filter too
    const controller = (this.app as any).plugins?.getPlugin("tps-controller");
    if (controller?.settings?.externalCalendarFilter) {
      return controller.settings.externalCalendarFilter;
    }
    return this.settings.externalCalendarFilter ?? "";
  }

  getExternalCalendarConfig(url: string): ExternalCalendarConfig | null {
    const target = normalizeCalendarUrl(url);
    const calendars = this.getEffectiveExternalCalendars();
    return (
      calendars.find(
        (calendar) => normalizeCalendarUrl(calendar.url) === target,
      ) ?? null
    );
  }

  getExternalCalendarAutoCreateMap(): Record<string, ExternalCalendarConfig> {
    const calendars = this.getEffectiveExternalCalendars();
    return Object.fromEntries(
      calendars
        .filter((calendar) => calendar.url)
        .map((calendar) => [
          normalizeCalendarUrl(calendar.url),
          calendar,
        ])
        .filter(([url]) => Boolean(url)),
    );
  }

  getCalendarColor(url: string): string {
    const calendars = this.getEffectiveExternalCalendars();
    const target = normalizeCalendarUrl(url);
    const match = calendars.find(
      (calendar) => normalizeCalendarUrl(calendar.url) === target,
    );
    return match?.color || "#3b82f6";
  }

  getPriorityValues(): string[] {
    return this.settings.priorityValues ?? [];
  }

  getStatusValues(): string[] {
    return this.settings.statusValues ?? [];
  }

  refreshCalendarViews() {
    const leaves = this.app.workspace.getLeavesOfType(CalendarViewType);
    for (const leaf of leaves) {
      const view = leaf.view as unknown as CalendarView | null;
      view?.refreshFromPluginSettings();
    }
  }

  async openDefaultBaseInSidebar(): Promise<void> {
    const path = this.settings.sidebarBasePath?.trim();
    if (!path) {
      new Notice("Set a default calendar base path in settings first.");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      new Notice(`File not found: ${path}`);
      return;
    }
    if (!(file as any).extension) {
      new Notice("Default calendar base must be a file.");
      return;
    }

    let existingLeaf: any = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if ((leaf.view as any).file?.path === path) {
        existingLeaf = leaf;
        return true;
      }
    });

    if (existingLeaf) {
      this.app.workspace.revealLeaf(existingLeaf);
      return;
    }

    let leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(true);
    }
    if (!leaf) {
      new Notice("Could not open right sidebar.");
      return;
    }
    await (leaf as any).openFile(file, { active: false });
    this.app.workspace.revealLeaf(leaf);
  }
}
