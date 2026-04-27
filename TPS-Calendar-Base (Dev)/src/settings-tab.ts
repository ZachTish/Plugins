import { Plugin, PluginSettingTab, Setting, debounce } from "obsidian";
import ObsidianCalendarPlugin from "./main";
import { normalizeCalendarUrl } from "./utils";
import { getPluginById } from "./core";
import { renderListWithControls } from "./utils/list-renderer";
import { createTPSCollapsibleSection } from "./utils/settings-layout";

const createCalendarId = () =>
  `calendar-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

const createSettingsGroup = (
  parent: HTMLElement,
  title: string,
  description?: string,
): HTMLElement => {
  const group = parent.createDiv({ cls: 'tps-settings-flat-group' });
  group.style.marginBottom = '18px';
  group.style.padding = '14px 16px';
  group.style.border = '1px solid var(--background-modifier-border)';
  group.style.borderRadius = '12px';
  group.style.background = 'var(--background-secondary)';
  group.createEl('h3', { text: title });
  if (description) {
    group.createEl('p', { text: description, cls: 'setting-item-description' });
  }
  return group;
};

export class CalendarPluginSettingsTab extends PluginSettingTab {
  plugin: ObsidianCalendarPlugin;
  private settingsViewState = new Map<string, boolean>();
  private settingsScrollTop = 0;
  private hasRenderedSettings = false;

  constructor(app: Plugin["app"], plugin: ObsidianCalendarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    this.captureSettingsViewState(containerEl);
    containerEl.empty();

    const debouncedSave = debounce(() => this.plugin.saveSettings(), 300);

    containerEl.createEl("h2", { text: "TPS Calendar Settings" });

    const featuresCategory = createSettingsGroup(containerEl, 'Daily Use', 'Core calendar behavior, sources, and note creation defaults.');
    const automationCategory = createSettingsGroup(containerEl, 'Automation', 'Sync behavior, generated data, and background calendar processing.');
    const rulesCategory = createSettingsGroup(containerEl, 'Rules', 'Matching rules and calendar-specific automation rules.');
    const appearanceCategory = createSettingsGroup(containerEl, 'Appearance', 'Visual layout and rendering preferences.');

    // Check for Controller override
    const controller = getPluginById(this.app, "tps-controller") as any;
    if (controller?.settings) {
      const warning = containerEl.createDiv({ cls: 'tps-settings-warning' });
      warning.createEl("strong", { text: "⚠️ Managed by TPS Controller" });
      warning.createEl("p", {
        text: "External calendars are currently being managed by the TPS Controller plugin. The settings below are being overridden.",
        attr: { style: "margin-top: 5px; margin-bottom: 0;" }
      });
    }

    // 1. Calendars Section (Top Priority)
    const calendarsSection = createTPSCollapsibleSection(
      featuresCategory,
      "Calendars & Sources",
      "Source feeds and quick import. This is the highest-priority setup area for the calendar plugin.",
      false
    );

    new Setting(calendarsSection)
      .setName("Enable external calendar integration")
      .setDesc("Master toggle for external calendar sources and external event rendering.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableExternalCalendars ?? true)
          .onChange(async (value) => {
            this.plugin.settings.enableExternalCalendars = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (!(this.plugin.settings.enableExternalCalendars ?? true)) {
      calendarsSection.createEl("p", {
        text: "External calendars are disabled. Enable the master toggle to configure calendar sources and import rules.",
        cls: "setting-item-description",
      });
    } else if (controller?.settings) {
      calendarsSection.createEl("p", {
        text: "Calendar sources are managed by TPS Controller. Use Controller settings to change feeds, filters, archive behavior, and shared field mappings.",
        cls: "setting-item-description",
      });
    } else {
      const calendarsContainer = calendarsSection.createDiv();
      this.renderExternalCalendars(calendarsContainer);

      new Setting(calendarsSection)
        .setName("Add new calendar source")
        .setDesc("Add an external iCal feed (Google, Outlook, etc).")
        .addButton((btn) =>
          btn
            .setIcon("plus")
            .setButtonText("Add Calendar")
            .setCta()
            .onClick(async () => {
              if (!this.plugin.settings.externalCalendars) {
                this.plugin.settings.externalCalendars = [];
              }
              this.plugin.settings.externalCalendars.push({
                id: createCalendarId(),
                url: "",
                color: "#3b82f6",
                enabled: true,
                autoCreateEnabled: true,
                autoCreateTypeFolder: "",
                autoCreateFolder: "",
                autoCreateTag: "",
                autoCreateTemplate: "",
              });

              await this.plugin.saveSettings();
              this.renderExternalCalendars(calendarsContainer);
            }),
        );

      let bulkInput = "";
      let bulkInputComponent: { setValue: (value: string) => void } | null = null;
      const quickAddSetting = new Setting(calendarsSection)
        .setName("Quick Add (Bulk Import)")
        .setDesc("Paste iCal URLs (comma or newline separated).");

      quickAddSetting.controlEl.style.flexDirection = "column";
      quickAddSetting.controlEl.style.alignItems = "flex-end";

      quickAddSetting.addTextArea((text) => {
        bulkInputComponent = text as unknown as {
          setValue: (value: string) => void;
        };
        text
          .setPlaceholder("https://calendar.google.com/...\nhttps://outlook.office365.com/...")
          .onChange((value) => {
            bulkInput = value;
          });
        text.inputEl.rows = 3;
        text.inputEl.style.width = "100%";
        text.inputEl.style.marginTop = "8px";
      })
        .addButton((btn) =>
          btn
            .setButtonText("Import URLs")
            .onClick(async () => {
              const urls = bulkInput
                .split(/[\n,]+/)
                .map((entry) => normalizeCalendarUrl(entry.trim()))
                .filter(Boolean);
              if (!urls.length) return;
              if (!this.plugin.settings.externalCalendars) {
                this.plugin.settings.externalCalendars = [];
              }
              const existing = new Set(
                this.plugin.settings.externalCalendars.map((calendar) => calendar.url),
              );
              urls.forEach((url) => {
                if (existing.has(url)) return;
                this.plugin.settings.externalCalendars.push({
                  id: createCalendarId(),
                  url,
                  color: "#3b82f6",
                  enabled: true,
                  autoCreateEnabled: true,
                  autoCreateTypeFolder: "",
                  autoCreateFolder: "",
                  autoCreateTag: "",
                  autoCreateTemplate: "",
                });
              });

              await this.plugin.saveSettings();
              bulkInput = "";
              bulkInputComponent?.setValue("");
              this.renderExternalCalendars(calendarsContainer);
            }),
        );

      new Setting(calendarsSection)
        .setName("Filter external events")
        .setDesc("Exclude events with titles containing these comma-separated terms.")
        .addTextArea((text) =>
          text
            .setPlaceholder("Canceled, Tentative")
            .setValue(this.plugin.settings.externalCalendarFilter || "")
            .onChange((value) => {
              this.plugin.settings.externalCalendarFilter = value;
              void debouncedSave();
            }),
        );
    }

    // 2. General Settings
    const generalSection = createTPSCollapsibleSection(
      featuresCategory,
      "General",
      "Primary interaction settings that most users are likely to change.",
      false
    );

    new Setting(generalSection)
      .setName("Calendar day click action")
      .setDesc("Open Daily Note (.md) or Canvas (.canvas) when clicking a date header.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("daily-note", "Daily Note (.md)")
          .addOption("daily-canvas", "Canvas Dashboard (.canvas)")
          .setValue(this.plugin.settings.dailyDateLinkTarget || "daily-note")
          .onChange(async (value: "daily-note" | "daily-canvas") => {
            this.plugin.settings.dailyDateLinkTarget = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(generalSection)
      .setName("Default calendar creation type")
      .setDesc("Choose whether drag/create actions make a full note or append a task.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("note", "Full note")
          .addOption("task", "Task line")
          .setValue(this.plugin.settings.defaultCreateMode || "note")
          .onChange(async (value) => {
            this.plugin.settings.defaultCreateMode = value as "note" | "task";
            await this.plugin.saveSettings();
            taskTargetSetting.settingEl.style.display = value === "task" ? "" : "none";
          }),
      );

    new Setting(generalSection)
      .setName("Default calendar creation destination")
      .setDesc("Optional folder for notes or file for tasks. Leave blank to keep the base-derived destination.")
      .addText((text) =>
        text
          .setPlaceholder("Markdown/04 Lists/Calendar or Markdown/04 Lists/Hca Calendar.md")
          .setValue(this.plugin.settings.defaultCreateDestination || "")
          .onChange(async (value) => {
            this.plugin.settings.defaultCreateDestination = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    const taskTargetSetting = new Setting(generalSection)
      .setName("Task creation target file fallback")
      .setDesc("Legacy fallback file for task mode when the generic destination is blank.")
      .addText((text) =>
        text
          .setPlaceholder("Markdown/Action Items/Hca-Outlook.md")
          .setValue(this.plugin.settings.defaultTaskTargetFile || "")
          .onChange(async (value) => {
            this.plugin.settings.defaultTaskTargetFile = value.trim();
            await this.plugin.saveSettings();
          }),
      );
    taskTargetSetting.settingEl.style.display = (this.plugin.settings.defaultCreateMode || "note") === "task" ? "" : "none";

    new Setting(generalSection)
      .setName("Sidebar calendar base path")
      .setDesc("File to open in the sidebar (Command/Ribbon action).")
      .addText((text) =>
        text
          .setPlaceholder("01 Action Items/Calendar.md")
          .setValue(this.plugin.settings.sidebarBasePath ?? "")
          .onChange((value) => {
            this.plugin.settings.sidebarBasePath = value.trim();
            void debouncedSave();
          }),
      );

    new Setting(generalSection)
      .setName("Show unscheduled notes button")
      .setDesc("Display a dropdown button in the calendar header listing notes in the current Base that have no start date set.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableUnscheduledView ?? true)
          .onChange(async (value) => {
            this.plugin.settings.enableUnscheduledView = value;
            await this.plugin.saveSettings();
          }),
      );

    const viewBehaviorSection = createTPSCollapsibleSection(
      rulesCategory,
      "Calendar View Defaults",
      "Default navigation and visible time-range behavior.",
      false
    );

    new Setting(viewBehaviorSection)
      .setName("Default view mode")
      .setDesc("Default view for calendars without a per-view mode set. Select 'Filter-based (Auto)' to auto-select the day span from the visible event date range.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("day", "Day")
          .addOption("3d", "3 Days")
          .addOption("4d", "4 Days")
          .addOption("5d", "5 Days")
          .addOption("7d", "7 Days")
          .addOption("week", "Week")
          .addOption("month", "Month")
          .addOption("continuous", "Continuous")
          .addOption("filter-based", "Filter-based (Auto)")
          .setValue(this.plugin.settings.viewMode || "week")
          .onChange(async (value) => {
            this.plugin.settings.viewMode = value as any;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(viewBehaviorSection)
      .setName("Auto view mode from visible local events")
      .setDesc("Only applies when view mode is 'Filter-based (Auto)'. Ignored when a specific mode (Day, 3d, Week, etc.) is selected.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.filterRangeAuto ?? false)
          .onChange(async (value) => {
            this.plugin.settings.filterRangeAuto = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(viewBehaviorSection)
      .setName("Context date detection")
      .setDesc("When embedded, detect date from parent note title/path.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.contextDateEnabled ?? false)
          .onChange(async (value) => {
            this.plugin.settings.contextDateEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(viewBehaviorSection)
      .setName("Daily note date format")
      .setDesc(
        "Moment.js format string for daily note filenames (e.g. YYYYMMDD, DD-MM-YYYY). " +
          "Leave blank to use Obsidian's built-in Daily Notes format.",
      )
      .addText((text) =>
        text
          .setPlaceholder("e.g. YYYYMMDD or DD-MM-YYYY")
          .setValue(this.plugin.settings.dailyNoteDateFormat ?? "")
          .onChange(async (value) => {
            this.plugin.settings.dailyNoteDateFormat = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(viewBehaviorSection)
      .setName("Primary event date field")
      .setDesc("First frontmatter field used to place notes on the calendar.")
      .addText((text) =>
        text
          .setPlaceholder("scheduled")
          .setValue(this.plugin.settings.startProperty ?? "scheduled")
          .onChange(async (value) => {
            this.plugin.settings.startProperty = value.trim() || "scheduled";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(viewBehaviorSection)
      .setName("Secondary event date field")
      .setDesc("Fallback field when the primary field is missing. Leave blank to disable.")
      .addText((text) =>
        text
          .setPlaceholder("due")
          .setValue(this.plugin.settings.secondaryStartProperty ?? "")
          .onChange(async (value) => {
            this.plugin.settings.secondaryStartProperty = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(viewBehaviorSection)
      .setName("Tertiary event date field")
      .setDesc("Second fallback field when primary/secondary are missing. Leave blank to disable.")
      .addText((text) =>
        text
          .setPlaceholder("completed")
          .setValue(this.plugin.settings.tertiaryStartProperty ?? "")
          .onChange(async (value) => {
            this.plugin.settings.tertiaryStartProperty = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    viewBehaviorSection.createEl("p", {
      text:
        "Per-base controls: open each Calendar Base view options to toggle primary/secondary/tertiary date sources and optional per-source durations. If a source duration is left blank, events use the minimum time slot.",
    }).addClass("setting-item-description");

    new Setting(viewBehaviorSection)
      .setName("Week starts on")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("sunday", "Sunday")
          .addOption("monday", "Monday")
          .addOption("tuesday", "Tuesday")
          .addOption("wednesday", "Wednesday")
          .addOption("thursday", "Thursday")
          .addOption("friday", "Friday")
          .addOption("saturday", "Saturday")
          .setValue(this.plugin.settings.weekStartDay || "monday")
          .onChange(async (value) => {
            this.plugin.settings.weekStartDay = value as any;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(viewBehaviorSection)
      .setName("Navigation step")
      .setDesc("How far Previous/Next moves in multi-day views.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("1", "1 day")
          .addOption("3", "3 days")
          .addOption("4", "4 days")
          .addOption("5", "5 days")
          .addOption("7", "1 week")
          .addOption("30", "1 month")
          .setValue(String(this.plugin.settings.navStep ?? 1))
          .onChange(async (value) => {
            this.plugin.settings.navStep = Number(value);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(viewBehaviorSection)
      .setName("Show navigation buttons")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showNavButtons ?? true)
          .onChange(async (value) => {
            this.plugin.settings.showNavButtons = value;
            await this.plugin.saveSettings();
          }),
      );

    viewBehaviorSection.createEl("p", {
      text: "Hidden-hour range is now configured per Calendar Base view in that view's options instead of globally here.",
      cls: "setting-item-description",
    });

    // 3. Event Handling (UI-related settings only)
    const handlingSection = createTPSCollapsibleSection(
      automationCategory,
      "Event Handling",
      "Linking and status behavior for calendar-created notes.",
      false
    );

    let linkDetails: HTMLElement;

    new Setting(handlingSection)
      .setName("Parent-Child Linking")
      .setDesc("Enable bidirectional linking between calendar events and parent projects/notes.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.parentLinkEnabled)
          .onChange(async (value) => {
            this.plugin.settings.parentLinkEnabled = value;
            await this.plugin.saveSettings();
            if (linkDetails) linkDetails.style.display = value ? '' : 'none';
          }),
      );

    linkDetails = handlingSection.createDiv({ cls: 'tps-settings-indent' });
    linkDetails.style.display = this.plugin.settings.parentLinkEnabled ? '' : 'none';

    new Setting(linkDetails)
      .setName("Parent Link Key")
      .setDesc("Key in Child Note pointing to Parent (e.g. 'childOf').")
      .addText((text) =>
        text
          .setPlaceholder("childOf")
          .setValue(this.plugin.settings.parentLinkKey || "childOf")
          .onChange(async (value) => {
            this.plugin.settings.parentLinkKey = value.trim() || "childOf";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(linkDetails)
      .setName("Child Link Key")
      .setDesc("Key in Parent Note pointing to Children (e.g. 'meetings').")
      .addText((text) =>
        text
          .setPlaceholder("meetings")
          .setValue(this.plugin.settings.childLinkKey || "meetings")
          .onChange(async (value) => {
            this.plugin.settings.childLinkKey = value.trim() || "meetings";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(handlingSection)
      .setName("Status: In-Progress")
      .setDesc("Frontmatter value to apply for current events.")
      .addText((text) =>
        text
          .setPlaceholder("working")
          .setValue(this.plugin.settings.inProgressStatusValue || "working")
          .onChange(async (value) => {
            this.plugin.settings.inProgressStatusValue = value;
            await this.plugin.saveSettings();
          }),
      );

    // 4. Task Items
    const taskItemsSection = createTPSCollapsibleSection(
      featuresCategory,
      "Task Items",
      "Optional task rendering. Related settings stay hidden until the feature is enabled.",
      false
    );

    new Setting(taskItemsSection)
      .setName("Show task items")
      .setDesc("Render inline task checkboxes (- [ ]) that have Tasks-plugin date annotations as calendar events.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showTaskItems)
          .onChange(async (value) => {
            this.plugin.settings.showTaskItems = value;
            await this.plugin.saveSettings();
            taskItemDetails.style.display = value ? "" : "none";
          }),
      );

    const taskItemDetails = taskItemsSection.createDiv({ cls: "tps-settings-indent" });
    taskItemDetails.style.display = this.plugin.settings.showTaskItems ? "" : "none";

    new Setting(taskItemDetails)
      .setName("Date field")
      .setDesc("Which date annotation to use to place tasks on the calendar.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            any: "Any (due \u{1F4C5} \u2192 scheduled \u23F3 \u2192 start \u{1F6EB})",
            due: "Due (\u{1F4C5})",
            scheduled: "Scheduled (\u23F3)",
            start: "Start (\u{1F6EB})",
          })
          .setValue(this.plugin.settings.taskDateField)
          .onChange(async (value) => {
            this.plugin.settings.taskDateField = value as any;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(taskItemDetails)
      .setName("Show completed tasks")
      .setDesc("Include tasks marked [x] as calendar events.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showCompletedTaskItems)
          .onChange(async (value) => {
            this.plugin.settings.showCompletedTaskItems = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(taskItemDetails)
      .setName("Folder filter")
      .setDesc("Only scan notes in these folders (comma-separated). Leave blank to scan all notes.")
      .addText((text) =>
        text
          .setPlaceholder("Markdown/Action Items, Markdown/Notes")
          .setValue(this.plugin.settings.taskItemFolderFilter || "")
          .onChange(async (value) => {
            this.plugin.settings.taskItemFolderFilter = value;
            await this.plugin.saveSettings();
          }),
      );

    // 5. Appearance
    const appearanceSection = createTPSCollapsibleSection(
      appearanceCategory,
      "Appearance",
      "Lower-priority visual tuning and optional style rules.",
      false
    );

    new Setting(appearanceSection)
      .setName("Theme & Integration")
      .setHeading();

    new Setting(appearanceSection)
      .setName("Show Now Indicator")
      .setDesc("Red line marking current time.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showNowIndicator)
          .onChange(async (value) => {
            this.plugin.settings.showNowIndicator = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(appearanceSection)
      .setName("Past Event Opacity")
      .setDesc("Dim past events (0-100%).")
      .addSlider((slider) =>
        slider
          .setLimits(0, 100, 10)
          .setValue(this.plugin.settings.pastEventOpacity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.pastEventOpacity = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(appearanceSection)
      .setName("Event Font Size")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ small: "Small", default: "Default", large: "Large" })
          .setValue(this.plugin.settings.eventFontSize)
          .onChange(async (value) => {
            this.plugin.settings.eventFontSize = value as any;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(appearanceSection)
      .setName("Active note highlight color")
      .setDesc("Color used to highlight the currently open note's event in embedded calendars.")
      .addColorPicker((picker) =>
        picker
          .setValue(this.plugin.settings.activeEventHighlightColor || "#3b82f6")
          .onChange(async (value) => {
            this.plugin.settings.activeEventHighlightColor = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(appearanceSection)
      .setName("Event Visual Sources")
      .setHeading();

    new Setting(appearanceSection)
      .setName("Note event color source")
      .setDesc("Choose whether note event colors come from note frontmatter or are turned off.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("frontmatter", "Frontmatter")
          .addOption("off", "Off")
          .setValue(this.plugin.settings.noteEventColorSource || "frontmatter")
          .onChange(async (value) => {
            this.plugin.settings.noteEventColorSource = value as any;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(appearanceSection)
      .setName("Note event icon source")
      .setDesc("Choose whether note event icons come from note frontmatter values or are turned off.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("frontmatter", "Frontmatter")
          .addOption("off", "Off")
          .setValue(this.plugin.settings.noteEventIconSource || "frontmatter")
          .onChange(async (value) => {
            this.plugin.settings.noteEventIconSource = value as any;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(appearanceSection)
      .setName("Frontmatter color applies to")
      .setDesc("Choose whether frontmatter color affects note event cards, icons, both, or neither.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("both", "Card + icon")
          .addOption("card", "Card only")
          .addOption("icon", "Icon only")
          .addOption("off", "Off")
          .setValue(this.plugin.settings.noteEventFrontmatterColorTarget || "both")
          .onChange(async (value) => {
            this.plugin.settings.noteEventFrontmatterColorTarget = value as any;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(appearanceSection)
      .setName("Layout & Dimensions")
      .setHeading();

    new Setting(appearanceSection)
      .setName("Slot Duration")
      .setDesc("Height of time slots.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ "15": "15 min", "30": "30 min", "60": "60 min" })
          .setValue(String(this.plugin.settings.slotDuration))
          .onChange(async (value) => {
            this.plugin.settings.slotDuration = Number(value);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(appearanceSection)
      .setName("Minimum Event Height")
      .setDesc("Minimum pixel height for timed events in the calendar grid.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 120, 2)
          .setValue(this.plugin.settings.minEventHeight)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.minEventHeight = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(appearanceSection)
      .setName("All-Day Row Height")
      .addSlider((slider) =>
        slider
          .setLimits(20, 60, 2)
          .setValue(this.plugin.settings.allDayEventHeight)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.allDayEventHeight = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(appearanceSection)
      .setName("Sticky All-Day Section")
      .setDesc("Keep all-day events visible while scrolling.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.allDayStickyScroll)
          .onChange(async (value) => {
            this.plugin.settings.allDayStickyScroll = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(appearanceSection)
      .setName("Show Single-Day Date Label")
      .setDesc("Show the built-in date label at the top of day view. Turn this off if you want the daily note itself to act as the day label.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showSingleDayDateLabel ?? true)
          .onChange(async (value) => {
            this.plugin.settings.showSingleDayDateLabel = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(appearanceSection)
      .setName("Time Format")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ "12h": "12h (1:00 PM)", "24h": "24h (13:00)" })
          .setValue(this.plugin.settings.timeFormat)
          .onChange(async (value) => {
            this.plugin.settings.timeFormat = value as any;
            await this.plugin.saveSettings();
          }),
      );

    // 5. Advanced / Developer
    const advancedSection = createTPSCollapsibleSection(
      rulesCategory,
      "Advanced & Frontmatter",
      "Shared key names and lower-frequency advanced behavior.",
      false
    );

    const frontmatterKeysSection = createTPSCollapsibleSection(
      advancedSection,
      "Frontmatter Keys",
      "All calendar frontmatter key names are grouped here, including the note color/icon fields used for event rendering.",
      false
    );

    const keys = [
      { name: "Event ID", key: "eventIdKey", default: "externalEventId" },
      { name: "Internal UID", key: "uidKey", default: "tpsCalendarUid" },
      { name: "Title", key: "titleKey", default: "title" },
      { name: "Status", key: "statusKey", default: "status" },
      { name: "Prev Status", key: "previousStatusKey", default: "tpsCalendarPrevStatus" },
      { name: "Event Color", key: "frontmatterColorField", default: "color" },
      { name: "Event Icon", key: "frontmatterIconField", default: "icon" },
    ];

    keys.forEach(k => {
      new Setting(frontmatterKeysSection)
        .setName(k.name + " Key")
        .addText(text => text
          .setPlaceholder(k.default)
          .setValue((this.plugin.settings as any)[k.key] || k.default)
          .onChange(async (val) => {
            (this.plugin.settings as any)[k.key] = val.trim() || k.default;
            await this.plugin.saveSettings();
          })
        );
    });

    // 6. Debug
    const debugSection = createTPSCollapsibleSection(
      automationCategory,
      "Debug",
      "Low-frequency troubleshooting controls.",
      false
    );

    new Setting(debugSection)
      .setName("Enable logging")
      .setDesc("Print detailed debug logs to the developer console (Ctrl+Shift+I). Disable when not needed.")
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.enableLogging).onChange(async (value) => {
          this.plugin.settings.enableLogging = value;
          await this.plugin.saveSettings();
        })
      );
    this.restoreSettingsViewState(containerEl);
  }

  private captureSettingsViewState(containerEl: HTMLElement): void {
    this.settingsScrollTop = containerEl.scrollTop;
    this.settingsViewState.clear();
    const detailsEls = Array.from(containerEl.querySelectorAll("details"));
    detailsEls.forEach((detailsEl, index) => {
      const details = detailsEl as HTMLDetailsElement;
      const summaryText = details.querySelector("summary")?.textContent?.trim() || "";
      this.settingsViewState.set(`${index}:${summaryText}`, details.open);
    });
  }

  private restoreSettingsViewState(containerEl: HTMLElement): void {
    const detailsEls = Array.from(containerEl.querySelectorAll("details"));
    if (!this.hasRenderedSettings) {
      detailsEls.forEach((detailsEl) => {
        const details = detailsEl as HTMLDetailsElement;
        details.removeAttribute("open");
      });
      this.hasRenderedSettings = true;
      containerEl.scrollTop = 0;
      return;
    }
    detailsEls.forEach((detailsEl, index) => {
      const details = detailsEl as HTMLDetailsElement;
      const summaryText = details.querySelector("summary")?.textContent?.trim() || "";
      const isOpen = this.settingsViewState.get(`${index}:${summaryText}`);
      if (isOpen) details.setAttr("open", "true");
      else details.removeAttribute("open");
    });
    containerEl.scrollTop = this.settingsScrollTop;
  }

  renderExternalCalendars(container: HTMLElement) {
    container.empty();
    if (!this.plugin.settings.externalCalendars) {
      this.plugin.settings.externalCalendars = [];
    }
    const calendars = this.plugin.settings.externalCalendars;
    const save = async (rerender = false) => {

      await this.plugin.saveSettings();
      if (rerender) {
        this.renderExternalCalendars(container);
      }
    };

    if (!calendars.length) {
      const empty = container.createEl("p", {
        text: "No external calendars added yet.",
      });
      empty.style.marginBottom = "12px";
      empty.style.color = "var(--text-muted)";
      return;
    }

    calendars.forEach((calendar, index) => {
      const card = container.createDiv();
      card.style.border = "1px solid var(--background-modifier-border)";
      card.style.borderRadius = "8px";
      card.style.padding = "12px";
      card.style.marginBottom = "12px";
      card.style.display = "flex";
      card.style.flexDirection = "column";
      card.style.gap = "8px";

      const header = card.createDiv();
      header.style.display = "flex";
      header.style.alignItems = "center";
      header.style.gap = "8px";

      const title = header.createEl("strong", {
        text: calendar.url ? `Calendar ${index + 1}` : "New calendar",
      });
      title.style.flex = "1";

      const move = (from: number, to: number) => {
        [calendars[from], calendars[to]] = [calendars[to], calendars[from]];
      };

      const controls = header.createDiv();
      controls.style.display = "flex";
      controls.style.gap = "4px";

      const upBtn = controls.createEl("button", { text: "↑" });
      upBtn.className = "mod-cta";
      upBtn.disabled = index === 0;
      upBtn.addEventListener("click", async () => {
        if (index === 0) return;
        move(index, index - 1);
        await save(true);
      });

      const downBtn = controls.createEl("button", { text: "↓" });
      downBtn.className = "mod-cta";
      downBtn.disabled = index === calendars.length - 1;
      downBtn.addEventListener("click", async () => {
        if (index >= calendars.length - 1) return;
        move(index, index + 1);
        await save(true);
      });

      const deleteBtn = controls.createEl("button", { text: "Delete" });
      deleteBtn.className = "mod-warning";
      deleteBtn.addEventListener("click", async () => {
        calendars.splice(index, 1);
        await save(true);
      });

      new Setting(card)
        .setName("Visible in calendar")
        .setDesc("Show events from this calendar in the view.")
        .addToggle((toggle) =>
          toggle
            .setValue(calendar.enabled !== false)
            .onChange(async (value) => {
              calendar.enabled = value;
              await save();
            }),
        );

      new Setting(card)
        .setName("iCal URL")
        .setDesc("Paste the full .ics URL for this calendar.")
        .addText((text) =>
          text
            .setPlaceholder("https://example.com/calendar.ics")
            .setValue(calendar.url || "")
            .onChange(async (value) => {
              calendar.url = value.trim();
              await save();
            }),
        );

      new Setting(card)
        .setName("Color")
        .setDesc("Calendar color for external events.")
        .addColorPicker((picker) =>
          picker
            .setValue(calendar.color || "#3b82f6")
            .onChange(async (value) => {
              calendar.color = value;
              await save();
            }),
        );

      // Auto-create settings moved to TPS-Controller.
    });
  }

}
