import { Notice, Plugin, TFile, MarkdownView } from "obsidian";
import { CalendarView, CalendarViewType } from "./calendar-view";
import { DEFAULT_CONDENSE_LEVEL } from "./utils";
import { CalendarPluginBridge } from "./plugin-interface";
import { AutoCreateService } from "./services/auto-create-service";
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
  autoCreateService: AutoCreateService;
  externalCalendarService: ExternalCalendarService;
  private syncIntervalId: number | null = null;

  async onload() {
    this.autoCreateService = new AutoCreateService(this.app);
    this.externalCalendarService = new ExternalCalendarService();
    this.registerBasesView(CalendarViewType, {
      name: "Calendar",
      icon: "lucide-calendar",
      factory: (controller, containerEl) =>
        new CalendarView(controller, containerEl, this),
      options: () => CalendarView.getOptions(this),
    });
    this.addSettingTab(new CalendarPluginSettingsTab(this.app, this));
    await this.loadSettings();
    this.refreshCalendarViews();
    this.setupAutoCreateSync();
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
    this.addCommand({
      id: "calendar-regenerate-future-notes",
      name: "Regenerate Future Event Notes (Updates templates)",
      callback: async () => {
        const confirm = window.confirm(
          "Are you sure you want to regenerate all future event notes? This will overwrite existing notes with the current template. Manual edits to note bodies may be lost."
        );
        if (confirm) {
          new Notice("Starting regeneration of future notes...");
          await this.runAutoCreateSync(true);
          new Notice("Regeneration complete.");
        }
      },
    });

    this.addCommand({
      id: "calendar-cleanup-duplicates",
      name: "Remove Duplicate Event Notes",
      callback: async () => {
        const confirm = window.confirm(
          "This will scan your vault for duplicate event notes (same ID/UID) and move them to the archive or delete them. Proceeds?"
        );
        if (confirm) {
          const calendars = this.settings.externalCalendars || [];
          const calendarConfigs: Record<string, any> = Object.fromEntries(
            calendars
              .filter((calendar) => calendar.url)
              .map((calendar) => [
                normalizeCalendarUrl(calendar.url),
                {
                  typeFolder: calendar.autoCreateTypeFolder || "",
                  folder: calendar.autoCreateFolder || "",
                  tag: normalizeCalendarTag(calendar.autoCreateTag || ""),
                  template: calendar.autoCreateTemplate || "",
                  autoCreateEnabled: calendar.autoCreateEnabled !== false,
                },
              ]),
          );

          const count = await this.autoCreateService.runDuplicateCleanupOnly(calendarConfigs);
          new Notice(`Cleanup complete. Removed ${count} duplicates.`);
        }
      },
    });

    this.addRibbonIcon("calendar", "Open default calendar base", async () => {
      await this.openDefaultBaseInSidebar();
    });

    // Listen for file deletions to remove parent-child links
    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        if (file instanceof TFile && file.extension === "md" && this.settings.parentLinkEnabled && this.settings.childLinkKey) {
          const childLink = `[[${file.basename}]]`;
          const allFiles = this.app.vault.getMarkdownFiles();

          for (const pFile of allFiles) {
            const cache = this.app.metadataCache.getFileCache(pFile);
            const children = cache?.frontmatter?.[this.settings.childLinkKey];

            let match = false;
            if (Array.isArray(children)) {
              match = children.some(c => String(c) === childLink);
            } else if (typeof children === "string") {
              match = children === childLink;
            }

            if (match) {
              await removeChildLinkFromParent(this.app, file.basename, pFile, this.settings.childLinkKey);
            }
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
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  async loadSettings() {
    const stored = await this.loadData();
    this.settings = migrateSettings(stored);
  }


  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshCalendarViews();
    // Fire a custom workspace event so Bases-registered views also get notified.
    // getLeavesOfType may not find Bases views, but workspace events always work.
    this.app.workspace.trigger("tps-calendar-settings-changed" as any);
    this.setupAutoCreateSync();
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

  private setupAutoCreateSync(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }

    this.autoCreateService.updateConfig({
      allowAutoCreate: this.isController(),
      eventIdKey: this.settings.eventIdKey,
      uidKey: this.settings.uidKey,
      titleKey: this.settings.titleKey,
      statusKey: this.settings.statusKey,
      previousStatusKey: this.settings.previousStatusKey,
      startProperty: this.settings.startProperty,
      endProperty: this.settings.endProperty,
    });

    void this.runAutoCreateSync();

    const minutes = Math.max(1, this.settings.syncIntervalMinutes || 5);
    this.syncIntervalId = window.setInterval(() => {
      void this.runAutoCreateSync();
    }, minutes * 60 * 1000);
  }

  async forceSync(): Promise<void> {
    new Notice("Forcing Calendar Sync...");
    const calendars = this.settings.externalCalendars || [];
    const urls = calendars
      .map((calendar) => normalizeCalendarUrl(calendar.url))
      .filter(Boolean);

    const calendarConfigs: Record<string, { typeFolder?: string; folder?: string; tag?: string; autoCreateEnabled?: boolean }> =
      Object.fromEntries(
        calendars
          .filter((calendar) => calendar.url)
          .map((calendar) => [
            normalizeCalendarUrl(calendar.url),
            {
              typeFolder: calendar.autoCreateTypeFolder || "",
              folder: calendar.autoCreateFolder || "",
              tag: normalizeCalendarTag(calendar.autoCreateTag || ""),
              template: calendar.autoCreateTemplate || "",
              autoCreateEnabled: calendar.autoCreateEnabled !== false,
            },
          ]),
      );

    await this.autoCreateService.checkAndCreateMeetingNotes(
      this.externalCalendarService,
      urls,
      this.getExternalCalendarFilter(),
      calendarConfigs,
    );
  }

  private async runAutoCreateSync(forceRegenerate = false): Promise<void> {
    if (!this.isController()) return;

    const calendars = this.settings.externalCalendars || [];
    const urls = calendars
      .map((calendar) => normalizeCalendarUrl(calendar.url))
      .filter(Boolean);
    if (!urls.length) return;

    const calendarConfigs: Record<string, { typeFolder?: string; folder?: string; tag?: string; autoCreateEnabled?: boolean }> =
      Object.fromEntries(
        calendars
          .filter((calendar) => calendar.url)
          .map((calendar) => [
            normalizeCalendarUrl(calendar.url),
            {
              typeFolder: calendar.autoCreateTypeFolder || "",
              folder: calendar.autoCreateFolder || "",
              tag: normalizeCalendarTag(calendar.autoCreateTag || ""),
              template: calendar.autoCreateTemplate || "",
              autoCreateEnabled: calendar.autoCreateEnabled !== false,
            },
          ]),
      );

    await this.autoCreateService.checkAndCreateMeetingNotes(
      this.externalCalendarService,
      urls,
      this.getExternalCalendarFilter(),
      calendarConfigs,
      forceRegenerate
    );
  }

  /*
   * Centralized Controller Check
   * Queries 'tps-controller' plugin. Defaults to TRUE (Controller) if plugin is missing.
   */
  isController(): boolean {
    const controllerPlugin = (this.app as any).plugins.getPlugin("tps-controller");
    if (controllerPlugin && controllerPlugin.api && typeof controllerPlugin.api.isController === "function") {
      return controllerPlugin.api.isController();
    }
    // Default to Controller if plugin is missing (Safe fallback)
    return true;
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

  getExternalCalendarUrls(): string[] {
    const calendars = this.settings.externalCalendars ?? [];
    return calendars
      .filter((calendar) => calendar.url && calendar.enabled !== false)
      .map((calendar) => normalizeCalendarUrl(calendar.url))
      .filter(Boolean);
  }

  getExternalCalendarFilter(): string {
    return this.settings.externalCalendarFilter ?? "";
  }

  getExternalCalendarConfig(url: string): ExternalCalendarConfig | null {
    const target = normalizeCalendarUrl(url);
    const calendars = this.settings.externalCalendars ?? [];
    return (
      calendars.find(
        (calendar) => normalizeCalendarUrl(calendar.url) === target,
      ) ?? null
    );
  }

  getExternalCalendarAutoCreateMap(): Record<string, ExternalCalendarConfig> {
    const calendars = this.settings.externalCalendars ?? [];
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
    const calendars = this.settings.externalCalendars ?? [];
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
