import { Plugin, PluginSettingTab, Setting } from "obsidian";
import ObsidianCalendarPlugin from "./main";
import {
  CalendarStyleRule,
  CalendarStyleMatch,
  CalendarField,
  CalendarOperator,
} from "./types";
import { CalendarStyleBuilderModal } from "./visual-builder";
import {
  DEFAULT_MATCH,
  CALENDAR_OPERATORS,
  createDefaultCondition,
} from "./style-rule-service";
import { normalizeCalendarUrl } from "./utils";

const createRuleId = () =>
  `${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

const createCalendarId = () =>
  `calendar-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

const cloneRule = (rule: CalendarStyleRule): CalendarStyleRule => {
  try {
    return structuredClone(rule);
  } catch {
    return JSON.parse(JSON.stringify(rule));
  }
};

export class CalendarPluginSettingsTab extends PluginSettingTab {
  plugin: ObsidianCalendarPlugin;

  constructor(app: Plugin["app"], plugin: ObsidianCalendarPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "TPS Calendar Settings" });

    const createSection = (title: string, isOpen = true) => {
      const details = containerEl.createEl("details");
      if (isOpen) details.setAttr("open", "true");
      details.style.marginBottom = "12px";
      details.style.border = "1px solid var(--background-modifier-border)";
      details.style.borderRadius = "8px";
      details.style.padding = "8px";
      const summary = details.createEl("summary", { text: title });
      summary.style.cursor = "pointer";
      summary.style.fontWeight = "600";
      summary.style.marginLeft = "4px";
      const sectionBody = details.createDiv();
      sectionBody.style.padding = "12px 4px 4px 4px";
      return sectionBody;
    };

    // 1. Calendars Section (Top Priority)
    const calendarsSection = createSection("📅 Calendars & Sources", true);
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
          .onChange(async (value) => {
            this.plugin.settings.externalCalendarFilter = value;
            await this.plugin.saveSettings();
          }),
      );

    // 2. General & Sync Settings
    const syncSection = createSection("🔄 General & Sync", false);

    new Setting(syncSection)
      .setName("Device Role")
      .setDesc("Managed by the TPS-Controller plugin. Install/Enable TPS-Controller to change roles.")
      .addExtraButton((btn) => {
        const controllerPlugin = (this.app as any).plugins.getPlugin("tps-controller");
        // Safe check
        let isController = true;
        if (controllerPlugin && controllerPlugin.api && typeof controllerPlugin.api.isController === "function") {
          isController = controllerPlugin.api.isController();
        }

        if (isController) {
          btn
            .setIcon("check-circle")
            .setTooltip("This device is a CONTROLLER (Active)")
            .setDisabled(true);
          btn.extraSettingsEl.style.color = "var(--text-success)";
        } else {
          btn
            .setIcon("minus-circle")
            .setTooltip("This device is a REPLICA (Passive)")
            .setDisabled(true);
        }
      });


    new Setting(syncSection)
      .setName("Sync interval")
      .setDesc("Automatic sync frequency in minutes.")
      .addSlider((slider) =>
        slider
          .setLimits(5, 60, 5)
          .setValue(this.plugin.settings.syncIntervalMinutes || 15)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncIntervalMinutes = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(syncSection)
      .setName("Force sync now")
      .setDesc("Trigger an immediate manual sync.")
      .addButton((button) =>
        button
          .setButtonText("Sync Now")
          .onClick(async () => {
            button.setButtonText("Syncing...");
            button.setDisabled(true);
            await this.plugin.forceSync();
            button.setButtonText("Sync Now");
            button.setDisabled(false);
          }),
      );

    new Setting(syncSection)
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

    new Setting(syncSection)
      .setName("Sidebar calendar base path")
      .setDesc("File to open in the sidebar (Command/Ribbon action).")
      .addText((text) =>
        text
          .setPlaceholder("01 Action Items/Calendar.md")
          .setValue(this.plugin.settings.sidebarBasePath ?? "")
          .onChange(async (value) => {
            this.plugin.settings.sidebarBasePath = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // 3. Event Handling
    const handlingSection = createSection("⚙️ Event Handling", false);

    new Setting(handlingSection)
      .setName("On event deletion")
      .setDesc("Action to take when an event is removed from the calendar source.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("nothing", "Do nothing (Keep Note)")
          .addOption("archive", "Move to Archive Folder")
          .addOption("delete", "Delete Note Permanently")
          .setValue(this.plugin.settings.syncOnEventDelete || "nothing")
          .onChange(async (value) => {
            this.plugin.settings.syncOnEventDelete = value;
            await this.plugin.saveSettings();
            // Re-render to show/hide archive folder
            this.display();
          }),
      );

    if (this.plugin.settings.syncOnEventDelete === "archive") {
      new Setting(handlingSection)
        .setName("Archive folder")
        .setDesc("Folder to move archived events into.")
        .addText((text) =>
          text
            .setPlaceholder("Archive/Events")
            .setValue(this.plugin.settings.archiveFolder || "")
            .onChange(async (value) => {
              this.plugin.settings.archiveFolder = value;
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(handlingSection)
      .setName("Parent-Child Linking")
      .setDesc("Enable bidirectional linking between calendar events and parent projects/notes.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.parentLinkEnabled)
          .onChange(async (value) => {
            this.plugin.settings.parentLinkEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.parentLinkEnabled) {
      const linkDetails = handlingSection.createDiv();
      linkDetails.style.paddingLeft = "1em";
      linkDetails.style.borderLeft = "2px solid var(--background-modifier-border)";

      new Setting(linkDetails)
        .setName("Parent Link Key")
        .setDesc("Key in Child Note pointing to Parent (e.g. 'project').")
        .addText((text) =>
          text
            .setPlaceholder("parent")
            .setValue(this.plugin.settings.parentLinkKey || "parent")
            .onChange(async (value) => {
              this.plugin.settings.parentLinkKey = value.trim() || "parent";
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
    }

    new Setting(handlingSection)
      .setName("Status: Canceled")
      .setDesc("Frontmatter value to apply when event is canceled.")
      .addText((text) =>
        text
          .setPlaceholder("wont-do")
          .setValue(this.plugin.settings.canceledStatusValue || "")
          .onChange(async (value) => {
            this.plugin.settings.canceledStatusValue = value;
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

    // 4. Appearance
    const appearanceSection = createSection("🎨 Appearance", false);

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

    appearanceSection.createEl("h3", { text: "Visual Rules (Colors & Styles)", cls: "setting-item-heading" });

    // Color Rules
    const colorRuleContainer = appearanceSection.createDiv();
    this.renderCalendarStyleRules(colorRuleContainer, "colorRules", { mode: "color" });
    new Setting(appearanceSection)
      .setName("Add Color Rule")
      .addButton((btn) =>
        btn.setIcon("plus").setButtonText("Add Color Rule").onClick(async () => {
          const rules = this.plugin.settings.colorRules;
          rules.push({ id: createRuleId(), label: `Rule ${rules.length + 1}`, active: true, match: DEFAULT_MATCH, conditions: [createDefaultCondition()], color: "", textStyle: "" });
          await this.plugin.saveSettings();
          this.renderCalendarStyleRules(colorRuleContainer, "colorRules", { mode: "color" });
        })
      );

    // Text Rules
    const textRuleContainer = appearanceSection.createDiv();
    this.renderCalendarStyleRules(textRuleContainer, "textRules", { mode: "text" });
    new Setting(appearanceSection)
      .setName("Add Text Style Rule")
      .addButton((btn) =>
        btn.setIcon("plus").setButtonText("Add Text Rule").onClick(async () => {
          const rules = this.plugin.settings.textRules;
          rules.push({ id: createRuleId(), label: `Rule ${rules.length + 1}`, active: true, match: DEFAULT_MATCH, conditions: [createDefaultCondition()], color: "", textStyle: "" });
          await this.plugin.saveSettings();
          this.renderCalendarStyleRules(textRuleContainer, "textRules", { mode: "text" });
        })
      );

    // 5. Advanced / Developer
    const advancedSection = createSection("🔧 Advanced & Frontmatter", false);

    new Setting(advancedSection)
      .setName("Frontmatter Keys")
      .setDesc("Customize the property names used in your markdown files.");

    const keys = [
      { name: "Event ID", key: "eventIdKey", default: "externalEventId" },
      { name: "Internal UID", key: "uidKey", default: "tpsCalendarUid" },
      { name: "Title", key: "titleKey", default: "title" },
      { name: "Status", key: "statusKey", default: "status" },
      { name: "Prev Status", key: "previousStatusKey", default: "tpsCalendarPrevStatus" },
    ];

    keys.forEach(k => {
      new Setting(advancedSection)
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

      new Setting(card)
        .setName("Auto-create notes")
        .setDesc("Allow this calendar to create meeting notes automatically.")
        .addToggle((toggle) =>
          toggle
            .setValue(calendar.autoCreateEnabled !== false)
            .onChange(async (value) => {
              calendar.autoCreateEnabled = value;
              await save();
            }),
        );

      new Setting(card)
        .setName("Auto-create type folder")
        .setDesc("Folder used as note type for auto-created meeting notes.")
        .addText((text) =>
          text
            .setPlaceholder("01 Action Items/Events")
            .setValue(calendar.autoCreateTypeFolder || "")
            .onChange(async (value) => {
              calendar.autoCreateTypeFolder = value.trim();
              await save();
            }),
        );

      new Setting(card)
        .setName("Auto-create tag")
        .setDesc("Optional tag appended to notes created/synced from this calendar.")
        .addText((text) =>
          text
            .setPlaceholder("calendar/work")
            .setValue(calendar.autoCreateTag || "")
            .onChange(async (value) => {
              calendar.autoCreateTag = value.trim().replace(/^#+/, "").toLowerCase();
              await save();
            }),
        );

      new Setting(card)
        .setName("Auto-create template")
        .setDesc("Path to Templater template (e.g. 'Templates/Meeting Note'). Optional.")
        .addText((text) =>
          text
            .setPlaceholder("Templates/Meeting")
            .setValue(calendar.autoCreateTemplate || "")
            .onChange(async (value) => {
              calendar.autoCreateTemplate = value.trim();
              await save();
            }),
        );
    });
  }

  renderCalendarStyleRules(
    container: HTMLElement,
    listKey: "colorRules" | "textRules" | "calendarStyleRules",
    opts: { mode: "color" | "text" | "both" } = { mode: "both" },
  ) {
    container.empty();
    if (!this.plugin.settings[listKey]) {
      (this.plugin.settings as any)[listKey] = [];
    }
    const rules = (this.plugin.settings as any)[listKey] as CalendarStyleRule[];
    const mode = opts.mode;
    const refresh = async () => {
      await this.plugin.saveSettings();
      this.renderCalendarStyleRules(container, listKey, opts);
    };

    rules.forEach((rule, index) => {
      if (mode === "color") {
        rule.textStyle = "";
      } else if (mode === "text") {
        rule.color = "";
      }
      if (!rule.conditions || !rule.conditions.length) {
        rule.conditions = [createDefaultCondition()];
      }
      rule.match = rule.match || DEFAULT_MATCH;

      const card = container.createDiv({ cls: "calendar-style-rule-card" });
      card.style.border = "1px solid var(--background-modifier-border)";
      card.style.borderRadius = "6px";
      card.style.padding = "12px";
      card.style.marginBottom = "12px";
      card.style.display = "flex";
      card.style.flexDirection = "column";
      card.style.gap = "10px";

      const header = card.createDiv();
      header.style.display = "flex";
      header.style.alignItems = "center";
      header.style.gap = "12px";

      // Active Toggle
      const activeWrap = header.createEl("label");
      activeWrap.style.display = "flex";
      activeWrap.style.alignItems = "center";
      activeWrap.style.gap = "6px";
      const activeToggle = activeWrap.createEl("input", { type: "checkbox" });
      activeToggle.checked = rule.active !== false;
      activeToggle.addEventListener("change", async () => {
        rule.active = activeToggle.checked;
        await refresh();
      });
      activeWrap.createEl("span", { text: "" });

      const labelEl = header.createEl("strong", { text: rule.label || `Rule ${index + 1}` });
      labelEl.style.flex = "1";
      labelEl.style.fontSize = "1.1em";

      if ((mode !== "text" && rule.color) || (mode !== "color" && rule.textStyle)) {
        const preview = header.createDiv();
        preview.style.width = "20px";
        preview.style.height = "20px";
        preview.style.borderRadius = "4px";
        preview.style.background =
          mode === "text" ? "transparent" : rule.color || "transparent";
        preview.style.border = "1px solid var(--background-modifier-border)";
        if (mode !== "color" && rule.textStyle) {
          preview.innerText = "Ag";
          preview.style.fontSize = "10px";
          preview.style.display = "flex";
          preview.style.alignItems = "center";
          preview.style.justifyContent = "center";
        }
      }

      const controlGroup = header.createDiv();
      controlGroup.style.display = "flex";
      controlGroup.style.gap = "4px";

      const move = (from: number, to: number) => {
        [rules[from], rules[to]] = [rules[to], rules[from]];
      };

      const up = controlGroup.createEl("button", { text: "↑" });
      up.className = "mod-cta";
      up.disabled = index === 0;
      up.addEventListener("click", async () => {
        if (index === 0) return;
        move(index, index - 1);
        await refresh();
      });

      const down = controlGroup.createEl("button", { text: "↓" });
      down.className = "mod-cta";
      down.disabled = index === rules.length - 1;
      down.addEventListener("click", async () => {
        if (index >= rules.length - 1) return;
        move(index, index + 1);
        await refresh();
      });

      const editBtn = controlGroup.createEl("button", { text: "Edit" });
      editBtn.className = "mod-cta";
      editBtn.addEventListener("click", () => {
        new CalendarStyleBuilderModal(
          this.plugin.app,
          rule,
          async (updatedRule) => {
            Object.assign(rule, updatedRule);
            if (mode === "color") {
              rule.textStyle = "";
            } else if (mode === "text") {
              rule.color = "";
            }
            await refresh();
          },
          { mode },
        ).open();
      });

      const duplicateBtn = controlGroup.createEl("button", { text: "Duplicate" });
      duplicateBtn.addEventListener("click", async () => {
        const duplicated = cloneRule(rule);
        duplicated.id = createRuleId();
        duplicated.label = duplicated.label
          ? `${duplicated.label} copy`
          : `Rule ${rules.length + 1}`;
        if (mode === "color") {
          duplicated.textStyle = "";
        } else if (mode === "text") {
          duplicated.color = "";
        }
        rules.splice(index + 1, 0, duplicated);
        await refresh();
      });

      const deleteBtn = controlGroup.createEl("button", { text: "Delete" });
      deleteBtn.className = "mod-warning";
      deleteBtn.addEventListener("click", async () => {
        rules.splice(index, 1);
        await refresh();
      });

      const summary = card.createDiv({ cls: "calendar-rule-summary" });
      summary.style.color = "var(--text-muted)";
      summary.style.fontSize = "0.9em";
      summary.style.marginTop = "-4px";

      const condText = rule.conditions.map(c =>
        `${c.field} ${c.operator.replace("!", "not ")} ${c.value ? `"${c.value}"` : ''}`
      ).join(rule.match === "any" ? " OR " : " AND ");

      summary.setText(condText.length > 50 ? condText.substring(0, 50) + "..." : condText);
    });
  }
}
