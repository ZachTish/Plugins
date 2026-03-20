import { App, PluginSettingTab, Setting, debounce } from 'obsidian';
import type TPSGlobalContextMenuPlugin from './main';
import type { AppearanceSettingKey, ViewModeConditionOperator, ViewModeConditionType, ViewModeRule, ViewModeRuleCondition } from './types';
import { PropertyProfilesModal } from './modals/property-profile-modal';

const createCollapsibleSection = (
  parent: HTMLElement,
  title: string,
  description?: string,
  defaultOpen = false
): HTMLElement => {
  const details = parent.createEl('details', { cls: 'tps-collapsible-section' });
  if (defaultOpen) {
    details.setAttr('open', 'true');
  }

  const summary = details.createEl('summary', { cls: 'tps-collapsible-section-summary' });
  summary.createSpan({ cls: 'tps-collapsible-section-title', text: title });

  if (description) {
    details.createEl('p', {
      cls: 'tps-collapsible-section-description',
      text: description
    });
  }

  return details.createDiv({ cls: 'tps-collapsible-section-content' });
};

/**
 * Settings tab for the plugin
 */
export class TPSGlobalContextMenuSettingTab extends PluginSettingTab {
  plugin: TPSGlobalContextMenuPlugin;
  private static readonly SETTINGS_BUILD_STAMP = '2026-03-11 18:12';
  private settingsViewState = new Map<string, boolean>();
  private settingsScrollTop = 0;
  private hasRenderedSettings = false;

  constructor(app: App, plugin: TPSGlobalContextMenuPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private getWorkspaceNames(): string[] {
    const internal = (this.app as any).internalPlugins;
    if (!internal) return [];
    const wp = internal.plugins?.['workspaces'] ?? internal.getPluginById?.('workspaces');
    if (!wp || wp.enabled === false) return [];
    const instance = wp.instance;
    if (!instance) return [];
    const workspaces: Record<string, unknown> = instance.workspaces ?? {};
    return Object.keys(workspaces).sort();
  }

  display(): void {
    const { containerEl } = this;
    this.captureSettingsViewState(containerEl);

    containerEl.empty();

    const debouncedSave = debounce(() => this.plugin.saveSettings(), 300);

    const saveAppearance = async () => {
      await this.plugin.saveSettings();
    };

    const setAppearanceSettingValue = async (key: AppearanceSettingKey, value: unknown) => {
      (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
      await this.plugin.saveSettings();
    };

    // Appearance sync mode is handled by TPS-Controller.
    const getAppearanceModeText = (_key: AppearanceSettingKey): string => 'Sync handled by TPS-Controller.';
    const attachAppearanceSyncToggle = (_setting: Setting, _key: AppearanceSettingKey) => { };

    const createMainCategory = (title: 'Features' | 'Rules' | 'Interaction' | 'UI Display', defaultOpen = false): HTMLElement => {
      const details = containerEl.createEl('details', { cls: 'tps-settings-main-category' });
      if (defaultOpen) details.setAttr('open', 'true');
      const summary = details.createEl('summary', { cls: 'tps-settings-main-summary' });
      summary.createEl('h3', { text: title });
      return details.createDiv({ cls: 'tps-settings-main-content' });
    };

    let featuresCategory: HTMLElement;
    let rulesCategory: HTMLElement;
    let interactionCategory: HTMLElement;
    let uiDisplayCategory: HTMLElement;

    const createSection = (parent: HTMLElement, title: string, description?: string, defaultOpen = false): HTMLElement =>
      createCollapsibleSection(parent, title, description, defaultOpen);

    const createPopout = (parent: HTMLElement, title: string, description?: string, defaultOpen = false): HTMLElement =>
      createCollapsibleSection(parent, title, description, defaultOpen);

    const pluginsRegistry = (this.app as any)?.plugins;
    const hasController = Boolean(
      pluginsRegistry?.getPlugin?.('tps-controller') || pluginsRegistry?.plugins?.['tps-controller']
    );
    const hasCompanion = Boolean(
      pluginsRegistry?.getPlugin?.('tps-notebook-navigator-companion') ||
      pluginsRegistry?.plugins?.['tps-notebook-navigator-companion']
    );

    containerEl.createEl('h2', { text: `TPS Global Context Menu (${TPSGlobalContextMenuSettingTab.SETTINGS_BUILD_STAMP})` });

    containerEl.createEl('p', {
      text: 'Define a single context menu that can be reused throughout the vault. Menu items accept JSON definitions to keep the configuration portable and extendable.',
    });

    if (hasController || hasCompanion) {
      const ownershipNote = containerEl.createDiv({ cls: 'setting-item-description' });
      ownershipNote.style.marginBottom = '16px';
      ownershipNote.style.padding = '10px 12px';
      ownershipNote.style.border = '1px solid var(--background-modifier-border)';
      ownershipNote.style.borderRadius = '8px';
      ownershipNote.style.background = 'var(--background-secondary)';
      ownershipNote.setText(
        [
          hasController ? 'TPS Controller should own suite automation, archive behavior, and shared calendar fields.' : '',
          hasCompanion ? 'Notebook Navigator Companion should own icon/color/sort automation.' : '',
          'GCM should stay focused on menus, properties, and note interaction.'
        ].filter(Boolean).join(' ')
      );
    }

    featuresCategory = createMainCategory('Features');
    rulesCategory = createMainCategory('Rules');
    interactionCategory = createMainCategory('Interaction');
    uiDisplayCategory = createMainCategory('UI Display');

    // --- General Settings ---
    const general = createSection(
      interactionCategory,
      'General Settings',
      'Common menu behavior, default paths, and archive basics.',
      true
    );

    new Setting(general)
      .setName('Enable console logging')
      .setDesc('Show debug logs in the developer console.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableLogging).onChange(async (value) => {
          this.plugin.settings.enableLogging = value;
          await this.plugin.saveSettings();
        }),
      );

    const archiveAutomation = createPopout(
      general,
      'Archive Automation',
      hasController
        ? 'Advanced. Prefer TPS Controller for archive ownership so the suite has one source of truth.'
        : 'Advanced archive automation for tag-based moves.'
    );

    new Setting(archiveAutomation)
      .setName('Daily archive tag sweep')
      .setDesc('Runs after 12:05am and catches up later on startup if that day was missed. Moves files with the archive tag into the archive folder.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableArchiveTagMove).onChange(async (value) => {
          this.plugin.settings.enableArchiveTagMove = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.enableArchiveTagMove) {
      new Setting(archiveAutomation)
        .setName('Archive tag')
        .setDesc('Tag that triggers auto-archive (case-insensitive, with or without #).')
        .addText((text) =>
          text
            .setPlaceholder('archive')
            .setValue(this.plugin.settings.archiveTag)
            .onChange((value) => {
              this.plugin.settings.archiveTag = value.trim() || 'archive';
              void debouncedSave();
            })
        );

      new Setting(archiveAutomation)
        .setName('Archive folder')
        .setDesc('Destination folder for archived files.')
        .addText((text) =>
          text
            .setPlaceholder('System/Archive')
            .setValue(this.plugin.settings.archiveFolderPath)
            .onChange((value) => {
              this.plugin.settings.archiveFolderPath = value.trim();
              void debouncedSave();
            })
        );

      new Setting(archiveAutomation)
        .setName('Use daily archive folders')
        .setDesc('When enabled, archived files will be placed in a daily subfolder (YYYY-MM-DD) within the archive folder instead of directly in the archive folder.')
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.archiveUseDailyFolder)
            .onChange(async (value) => {
              this.plugin.settings.archiveUseDailyFolder = value;
              await this.plugin.saveSettings();
            })
        );
    } else {
      archiveAutomation.createEl('p', {
        text: 'Archive automation is disabled. Enable Daily archive tag sweep to configure archive tag/folder behavior.',
        cls: 'setting-item-description',
      });
    }

    // Default paths for new items
    new Setting(general)
      .setName('Default attachments path')
      .setDesc('Folder where new attachment notes are created (plus button). Leave empty to use vault root.')
      .addText((text) =>
        text
          .setPlaceholder('e.g., Attachments or Notes/Attachments')
          .setValue(this.plugin.settings.defaultAttachmentsPath)
          .onChange((value) => {
            this.plugin.settings.defaultAttachmentsPath = value.trim();
            void debouncedSave();
          })
      );

    new Setting(general)
      .setName('Default subitems path')
      .setDesc('Folder where new subitems/tasks are created (plus button). Leave empty to use vault root.')
      .addText((text) =>
        text
          .setPlaceholder('e.g., Tasks or Work/Tasks')
          .setValue(this.plugin.settings.defaultSubitemsPath)
          .onChange((value) => {
            this.plugin.settings.defaultSubitemsPath = value.trim();
            void debouncedSave();
          })
      );

    new Setting(general)
      .setName('Default new subitem status')
      .setDesc('Status applied to newly promoted/created subitems. Leave empty to write no status.')
      .addText((text) =>
        text
          .setPlaceholder('open')
          .setValue(this.plugin.settings.defaultNewSubitemStatus ?? '')
          .onChange((value) => {
            this.plugin.settings.defaultNewSubitemStatus = value.trim();
            void debouncedSave();
          })
      );

    new Setting(general)
      .setName('Default new subitem priority')
      .setDesc('Priority applied to newly promoted/created subitems. Leave empty to write no priority.')
      .addText((text) =>
        text
          .setPlaceholder('normal')
          .setValue(this.plugin.settings.defaultNewSubitemPriority ?? '')
          .onChange((value) => {
            this.plugin.settings.defaultNewSubitemPriority = value.trim();
            void debouncedSave();
          })
      );

    new Setting(general)
      .setName('Checklist promote behavior')
      .setDesc('When promoting a checklist item to a subitem, choose whether to remove the line, complete + link it, or keep it open as a link.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('complete-and-link', 'Mark complete + link')
          .addOption('link-only', 'Link only')
          .addOption('remove', 'Remove checklist line')
          .setValue(this.plugin.settings.checklistPromotionBehavior ?? 'complete-and-link')
          .onChange((value) => {
            if (value === 'remove' || value === 'complete-and-link' || value === 'link-only') {
              this.plugin.settings.checklistPromotionBehavior = value;
              void debouncedSave();
            }
          })
      );

    new Setting(general)
      .setName('Right-click menu placement')
      .setDesc('Choose whether TPS items appear before or after native/core menu items.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('tps-last', 'TPS after native')
          .addOption('tps-first', 'TPS before native')
          .setValue(this.plugin.settings.nativeMenuPlacement || 'tps-last')
          .onChange(async (value: 'tps-first' | 'tps-last') => {
            this.plugin.settings.nativeMenuPlacement = value;
            await this.plugin.saveSettings();
          })
      );

    // Consolidated Scope Settings
    new Setting(general)
      .setName('Enable in specific views')
      .setDesc('Toggle where the custom context menu should appear.')
      .addToggle(toggle => toggle
        .setTooltip('Live Preview & Editor')
        .setValue(this.plugin.settings.enableInLivePreview)
        .onChange(async v => { this.plugin.settings.enableInLivePreview = v; await this.plugin.saveSettings(); }))
      .addToggle(toggle => toggle
        .setTooltip('Reading View & Popovers')
        .setValue(this.plugin.settings.enableInPreview)
        .onChange(async v => { this.plugin.settings.enableInPreview = v; await this.plugin.saveSettings(); }))
      .addToggle(toggle => toggle
        .setTooltip('Side Panels (Explorer, etc)')
        .setValue(this.plugin.settings.enableInSidePanels)
        .onChange(async v => { this.plugin.settings.enableInSidePanels = v; await this.plugin.saveSettings(); }));


    // --- Canvas & Bases Settings ---
    const pomodoroSection = createSection(
      featuresCategory,
      'Pomodoro Timer',
      'Optional timer feature. Its detailed settings stay below the master toggle.',
      false
    );

    new Setting(pomodoroSection)
      .setName('Enable Pomodoro Timer')
      .setDesc('Adds a configurable Pomodoro timer to the Global Context Menu.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enablePomodoro)
          .onChange(async (value) => {
            this.plugin.settings.enablePomodoro = value;
            await this.plugin.saveSettings();
          })
      );

    if (this.plugin.settings.enablePomodoro) {
      new Setting(pomodoroSection)
        .setName('Work Duration (minutes)')
        .addText((text) =>
          text
            .setPlaceholder('25')
            .setValue(String(this.plugin.settings.pomodoroWorkDuration))
            .onChange(async (value) => {
              const num = parseInt(value, 10);
              if (!isNaN(num) && num > 0) {
                this.plugin.settings.pomodoroWorkDuration = num;
                void debouncedSave();
              }
            })
        );

      new Setting(pomodoroSection)
        .setName('Short Break Duration (minutes)')
        .addText((text) =>
          text
            .setPlaceholder('5')
            .setValue(String(this.plugin.settings.pomodoroBreakDuration))
            .onChange(async (value) => {
              const num = parseInt(value, 10);
              if (!isNaN(num) && num > 0) {
                this.plugin.settings.pomodoroBreakDuration = num;
                void debouncedSave();
              }
            })
        );

      new Setting(pomodoroSection)
        .setName('Long Break Duration (minutes)')
        .addText((text) =>
          text
            .setPlaceholder('15')
            .setValue(String(this.plugin.settings.pomodoroLongBreakDuration))
            .onChange(async (value) => {
              const num = parseInt(value, 10);
              if (!isNaN(num) && num > 0) {
                this.plugin.settings.pomodoroLongBreakDuration = num;
                void debouncedSave();
              }
            })
        );

      new Setting(pomodoroSection)
        .setName('Long Break Interval')
        .setDesc('How many work sessions before a long break.')
        .addText((text) =>
          text
            .setPlaceholder('4')
            .setValue(String(this.plugin.settings.pomodoroLongBreakInterval))
            .onChange(async (value) => {
              const num = parseInt(value, 10);
              if (!isNaN(num) && num > 0) {
                this.plugin.settings.pomodoroLongBreakInterval = num;
                void debouncedSave();
              }
            })
        );

      new Setting(pomodoroSection)
        .setName('Pomodoro Event Folder')
        .setDesc('Where tracking events will be created (e.g. Action Items/Events).')
        .addText((text) =>
          text
            .setPlaceholder('Action Items/Events')
            .setValue(String(this.plugin.settings.pomodoroEventFolder))
            .onChange(async (value) => {
              this.plugin.settings.pomodoroEventFolder = value.trim();
              void debouncedSave();
            })
        );

      new Setting(pomodoroSection)
        .setName('Pomodoro Default Tags')
        .setDesc('Comma-separated list of tags added to the generated pomodoro events.')
        .addText((text) =>
          text
            .setPlaceholder('pomodoro, timebox')
            .setValue(String(this.plugin.settings.pomodoroDefaultTags))
            .onChange(async (value) => {
              this.plugin.settings.pomodoroDefaultTags = value;
              void debouncedSave();
            })
        );
    }

    const canvasBases = createSection(
      featuresCategory,
      'Canvas & Bases',
      'Behavior for opening notes from Canvas and Bases.',
      false
    );

    new Setting(canvasBases)
      .setName('Open notes in split tab (Desktop only)')
      .setDesc('When you click a note card in a Canvas or a row in a Bases view, open it in a vertical split tab to the right instead of replacing the current tab. Keeps the canvas/base visible while you work in the note.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableCanvasBaseSplit).onChange(async (value) => {
          this.plugin.settings.enableCanvasBaseSplit = value;
          await this.plugin.saveSettings();
        }),
      );

    const inlineUi = createSection(
      interactionCategory,
      'Inline UI',
      'Persistent inline surfaces. Graph and subitems behavior are grouped here.',
      true
    );



    new Setting(inlineUi)
      .setName('Show inline context menu')
      .setDesc('Master toggle for the persistent inline UI. Turn this off to hide the inline bar, subitems panel, title icon, and top parent nav.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableInlinePersistentMenus).onChange(async (value) => {
          this.plugin.settings.enableInlinePersistentMenus = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.enableInlinePersistentMenus) {
    new Setting(inlineUi)
      .setName('Inline menu only')
      .setDesc('Disable TPS additions in native/right-click menus and keep the plugin limited to inline persistent surfaces.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.inlineMenuOnly).onChange(async (value) => {
          this.plugin.settings.inlineMenuOnly = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(inlineUi)
      .setName('Show subitems panel')
      .setDesc('Show the larger inline subitems panel under the note title. Disable this to keep only the inline context menu bar.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableSubitemsPanel).onChange(async (value) => {
          this.plugin.settings.enableSubitemsPanel = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(inlineUi)
      .setName('Show checklist items in subitems panel')
      .setDesc('Render checklist items beneath children in the subitems panel.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showChecklistInSubitemsPanel).onChange(async (value) => {
          this.plugin.settings.showChecklistInSubitemsPanel = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(inlineUi)
      .setName('Show references at bottom of note')
      .setDesc('Show outgoing and incoming references in an inline footer after the note content.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showReferencesInSubitemsPanel).onChange(async (value) => {
          this.plugin.settings.showReferencesInSubitemsPanel = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(inlineUi)
      .setName('Show unlinked mentions at bottom of note')
      .setDesc('Show exact-title unlinked mentions in the inline references footer with a one-click Link action.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showMentionsInSubitemsPanel).onChange(async (value) => {
          this.plugin.settings.showMentionsInSubitemsPanel = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(inlineUi)
      .setName('Show note graph')
      .setDesc('Show the compact inline graph panel at the top-right of the note.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showInlineNoteGraph).onChange(async (value) => {
          this.plugin.settings.showInlineNoteGraph = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(inlineUi)
      .setName('Graph depth')
      .setDesc('How many link steps away from the current note the graph should include. Higher values are slower and noisier.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 3, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.noteGraphDepth ?? 1)
          .onChange(async (value) => {
            this.plugin.settings.noteGraphDepth = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(inlineUi)
      .setName('Max incoming graph nodes')
      .setDesc('Maximum incoming-linked notes to show in the graph.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 12, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.noteGraphMaxIncoming ?? 3)
          .onChange(async (value) => {
            this.plugin.settings.noteGraphMaxIncoming = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(inlineUi)
      .setName('Max outgoing graph nodes')
      .setDesc('Maximum outgoing-linked notes to show in the graph.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 12, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.noteGraphMaxOutgoing ?? 3)
          .onChange(async (value) => {
            this.plugin.settings.noteGraphMaxOutgoing = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(inlineUi)
      .setName('Max mention graph nodes')
      .setDesc('Maximum mention-based nodes to show in the graph.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 8, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.noteGraphMaxMentions ?? 2)
          .onChange(async (value) => {
            this.plugin.settings.noteGraphMaxMentions = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(inlineUi)
      .setName('Subitems panel position')
      .setDesc('Whether the subitems panel appears above or below the inline context menu bar.')
      .addDropdown((dd) =>
        dd
          .addOption('below', 'Below menu')
          .addOption('above', 'Above menu')
          .setValue(this.plugin.settings.subitemsPanelPosition ?? 'below')
          .onChange(async (value) => {
            this.plugin.settings.subitemsPanelPosition = value as 'above' | 'below';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(inlineUi)
      .setName('Auto-collapse when empty')
      .setDesc('Collapse the subitems panel on file open when it has no children, attachments, or checklist items to show.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.subitemsPanelAutoCollapse ?? true).onChange(async (value) => {
          this.plugin.settings.subitemsPanelAutoCollapse = value;
          await this.plugin.saveSettings();
        }),
      );

    } else {
      inlineUi.createEl('p', {
        text: 'Inline UI is disabled. Enable the master toggle to configure subitems, references, and note graph options.',
        cls: 'setting-item-description',
      });
    }

    // --- Appearance Settings ---
    const appearance = createSection(uiDisplayCategory, 'Appearance');
    appearance.createEl('p', {
      text: 'Use the cloud/monitor button on each row to switch between synced and this-device-only behavior.',
      cls: 'setting-item-description',
    });

    const menuTextScaleSetting = new Setting(appearance)
      .setName('Menu text scale')
      .setDesc(`Scale for inline menu and panel text. ${getAppearanceModeText('menuTextScale')}`)
      .addSlider((slider) =>
        slider
          .setLimits(70, 180, 5)
          .setDynamicTooltip()
          .setValue(Math.round((this.plugin.settings.menuTextScale || 1) * 100))
          .onChange(async (value) => {
            setAppearanceSettingValue('menuTextScale', value / 100);
            await saveAppearance();
          }),
      );
    attachAppearanceSyncToggle(menuTextScaleSetting, 'menuTextScale');

    const buttonScaleSetting = new Setting(appearance)
      .setName('Button size scale')
      .setDesc(`Scale action buttons, collapse buttons, and nav buttons. ${getAppearanceModeText('buttonScale')}`)
      .addSlider((slider) =>
        slider
          .setLimits(70, 180, 5)
          .setDynamicTooltip()
          .setValue(Math.round((this.plugin.settings.buttonScale || 1) * 100))
          .onChange(async (value) => {
            setAppearanceSettingValue('buttonScale', value / 100);
            await saveAppearance();
          }),
      );
    attachAppearanceSyncToggle(buttonScaleSetting, 'buttonScale');

    const controlScaleSetting = new Setting(appearance)
      .setName('Selector/input size scale')
      .setDesc(`Scale selector/input controls (dropdowns, text/date inputs, quick inputs). ${getAppearanceModeText('controlScale')}`)
      .addSlider((slider) =>
        slider
          .setLimits(70, 180, 5)
          .setDynamicTooltip()
          .setValue(Math.round((this.plugin.settings.controlScale || 1) * 100))
          .onChange(async (value) => {
            setAppearanceSettingValue('controlScale', value / 100);
            await saveAppearance();
          }),
      );
    attachAppearanceSyncToggle(controlScaleSetting, 'controlScale');

    const densitySetting = new Setting(appearance)
      .setName('Menu density')
      .setDesc(`Adjust spacing/padding density across chips, rows, and action buttons. ${getAppearanceModeText('menuDensity')}`)
      .addSlider((slider) =>
        slider
          .setLimits(75, 135, 5)
          .setDynamicTooltip()
          .setValue(Math.round((this.plugin.settings.menuDensity || 1) * 100))
          .onChange(async (value) => {
            setAppearanceSettingValue('menuDensity', value / 100);
            await saveAppearance();
          }),
      );
    attachAppearanceSyncToggle(densitySetting, 'menuDensity');

    const radiusSetting = new Setting(appearance)
      .setName('Corner roundness')
      .setDesc(`Scale corner radius for chips, icon buttons, and collapsed controls. ${getAppearanceModeText('menuRadiusScale')}`)
      .addSlider((slider) =>
        slider
          .setLimits(60, 180, 5)
          .setDynamicTooltip()
          .setValue(Math.round((this.plugin.settings.menuRadiusScale || 1) * 100))
          .onChange(async (value) => {
            setAppearanceSettingValue('menuRadiusScale', value / 100);
            await saveAppearance();
          }),
      );
    attachAppearanceSyncToggle(radiusSetting, 'menuRadiusScale');

    const livePositionSetting = new Setting(appearance)
      .setName('Live menu position')
      .setDesc(`Horizontal anchor for the floating Live Preview bar. ${getAppearanceModeText('liveMenuPosition')}`)
      .addDropdown((dropdown) =>
        dropdown
          .addOption('center', 'Center')
          .addOption('left', 'Left')
          .addOption('right', 'Right')
          .setValue(this.plugin.settings.liveMenuPosition || 'center')
          .onChange(async (value: 'left' | 'center' | 'right') => {
            setAppearanceSettingValue('liveMenuPosition', value);
            await saveAppearance();
          }),
      );
    attachAppearanceSyncToggle(livePositionSetting, 'liveMenuPosition');

    const liveOffsetXSetting = new Setting(appearance)
      .setName('Live menu horizontal offset')
      .setDesc(`X offset (px) applied after positioning. Negative = left, positive = right. ${getAppearanceModeText('liveMenuOffsetX')}`)
      .addSlider((slider) =>
        slider
          .setLimits(-300, 300, 5)
          .setDynamicTooltip()
          .setValue(Math.round(this.plugin.settings.liveMenuOffsetX || 0))
          .onChange(async (value) => {
            setAppearanceSettingValue('liveMenuOffsetX', value);
            await saveAppearance();
          }),
      );
    attachAppearanceSyncToggle(liveOffsetXSetting, 'liveMenuOffsetX');

    const liveOffsetYSetting = new Setting(appearance)
      .setName('Live menu vertical offset')
      .setDesc(`Y offset (px) applied after positioning. Negative = up, positive = down. ${getAppearanceModeText('liveMenuOffsetY')}`)
      .addSlider((slider) =>
        slider
          .setLimits(-240, 240, 4)
          .setDynamicTooltip()
          .setValue(Math.round(this.plugin.settings.liveMenuOffsetY || 0))
          .onChange(async (value) => {
            setAppearanceSettingValue('liveMenuOffsetY', value);
            await saveAppearance();
          }),
      );
    attachAppearanceSyncToggle(liveOffsetYSetting, 'liveMenuOffsetY');

    const subitemsMarginSetting = new Setting(appearance)
      .setName('Subitems panel margin bottom')
      .setDesc(`Vertical spacing (px) between the subitems panel and the context menu. ${getAppearanceModeText('subitemsMarginBottom')}`)
      .addSlider((slider) =>
        slider
          .setLimits(-20, 40, 1)
          .setDynamicTooltip()
          .setValue(Math.round(this.plugin.settings.subitemsMarginBottom ?? 0)) // Default 0
          .onChange(async (value) => {
            setAppearanceSettingValue('subitemsMarginBottom', value);
            await saveAppearance();
          }),
      );
    attachAppearanceSyncToggle(subitemsMarginSetting, 'subitemsMarginBottom');

    appearance.createEl('h4', { text: 'Daily Note Navigation', attr: { style: 'margin-top: 1.2em;' } });

    const dailyNavScaleSetting = new Setting(appearance)
      .setName('Nav button size scale')
      .setDesc(`Scale the daily note navigation controls independently of the rest of the UI. ${getAppearanceModeText('dailyNavScale')}`)
      .addSlider((slider) =>
        slider
          .setLimits(50, 250, 5)
          .setDynamicTooltip()
          .setValue(Math.round((this.plugin.settings.dailyNavScale ?? 1) * 100))
          .onChange(async (value) => {
            setAppearanceSettingValue('dailyNavScale', value / 100);
            await saveAppearance();
          }),
      );
    attachAppearanceSyncToggle(dailyNavScaleSetting, 'dailyNavScale');

    const dailyNavOpacitySetting = new Setting(appearance)
      .setName('Nav resting opacity')
      .setDesc(`Opacity of the floating nav when not hovered (0 = hidden until hover, 100 = always fully visible). ${getAppearanceModeText('dailyNavRestOpacity')}`)
      .addSlider((slider) =>
        slider
          .setLimits(0, 100, 5)
          .setDynamicTooltip()
          .setValue(Math.round(this.plugin.settings.dailyNavRestOpacity ?? 0))
          .onChange(async (value) => {
            setAppearanceSettingValue('dailyNavRestOpacity', value);
            await saveAppearance();
            // Update the data-rest-visible attribute on any live nav
            const navManager = (this.plugin as any).dailyNoteNavManager;
            if (navManager?.currentNav) {
              if (value > 0) {
                navManager.currentNav.dataset.restVisible = 'true';
              } else {
                delete navManager.currentNav.dataset.restVisible;
              }
            }
          }),
      );
    attachAppearanceSyncToggle(dailyNavOpacitySetting, 'dailyNavRestOpacity');

    const modalWidthSetting = new Setting(appearance)
      .setName('Modal width')
      .setDesc(`Width of TPS modal dialogs (Add Tag, Schedule, Recurrence, etc). ${getAppearanceModeText('modalWidth')}`)
      .addSlider((slider) =>
        slider
          .setLimits(320, 960, 20)
          .setDynamicTooltip()
          .setValue(Math.round(this.plugin.settings.modalWidth || 520))
          .onChange(async (value) => {
            setAppearanceSettingValue('modalWidth', value);
            await saveAppearance();
          }),
      );
    attachAppearanceSyncToggle(modalWidthSetting, 'modalWidth');

    const modalHeightSetting = new Setting(appearance)
      .setName('Modal max height (vh)')
      .setDesc(`Maximum modal height as viewport percentage. ${getAppearanceModeText('modalMaxHeightVh')}`)
      .addSlider((slider) =>
        slider
          .setLimits(50, 95, 1)
          .setDynamicTooltip()
          .setValue(Math.round(this.plugin.settings.modalMaxHeightVh || 80))
          .onChange(async (value) => {
            setAppearanceSettingValue('modalMaxHeightVh', value);
            await saveAppearance();
          }),
      );
    attachAppearanceSyncToggle(modalHeightSetting, 'modalMaxHeightVh');

    new Setting(appearance)
      .setName('Reset appearance')
      .setDesc('Restore all appearance controls to default values.')
      .addButton((button) =>
        button
          .setButtonText('Reset')
          .onClick(async () => {
            setAppearanceSettingValue('menuTextScale', 1);
            setAppearanceSettingValue('buttonScale', 1);
            setAppearanceSettingValue('controlScale', 1);
            setAppearanceSettingValue('menuDensity', 1);
            setAppearanceSettingValue('menuRadiusScale', 1);
            setAppearanceSettingValue('liveMenuPosition', 'center');
            setAppearanceSettingValue('liveMenuOffsetX', 0);
            setAppearanceSettingValue('liveMenuOffsetY', 0);
            setAppearanceSettingValue('subitemsMarginBottom', 0);
            setAppearanceSettingValue('modalWidth', 520);
            setAppearanceSettingValue('modalMaxHeightVh', 80);
            await saveAppearance();
            this.display();
          }),
      );


    // --- Custom Property Configuration ---
    const propertyConfig = createSection(
      rulesCategory,
      'Custom Property Configuration',
      'Define editable frontmatter fields and per-property behavior. Placement toggles live under Features > Menu Configuration.',
      false
    );

    propertyConfig.createEl('p', {
      text: `${(this.plugin.settings.properties || []).length} properties configured. Use the Features toggle section to choose where they appear.`,
      cls: 'setting-item-description',
    });

    const propertiesConfigContainer = propertyConfig.createDiv();
    this.renderProperties(propertiesConfigContainer);
    new Setting(propertyConfig)
      .addButton(btn => btn.setButtonText('Add Property').setCta().onClick(async () => {
        this.plugin.settings.properties.push({ id: Date.now().toString(), label: 'New Property', key: 'new_prop', type: 'text' });
        await this.plugin.saveSettings();
        this.display();
      }));

    // --- View Mode Settings ---
    const viewMode = createSection(
      rulesCategory,
      'View Mode Configuration',
      'Frontmatter key, ignored folders, and automatic rules. Master toggles live under Features > Automation & Features.',
      false
    );

    if (!this.plugin.settings.enableViewModeSwitching) {
      viewMode.createEl('p', {
        text: 'Automatic view mode switching is off. Re-enable it under Features > Automation & Features to edit the frontmatter key, ignored folders, and rules.',
        cls: 'setting-item-description',
      });
    }

    const viewModeConfigContainer = viewMode.createDiv();
    let viewRulesPopout: HTMLElement = viewModeConfigContainer;

    if (this.plugin.settings.enableViewModeSwitching) {
      new Setting(viewModeConfigContainer)
        .setName('Frontmatter Key')
        .setDesc('The frontmatter property used to determine view mode (e.g. "viewmode")')
        .addText((text) =>
          text
            .setValue(this.plugin.settings.viewModeFrontmatterKey)
            .setPlaceholder('viewmode')
            .onChange(async (value) => {
              this.plugin.settings.viewModeFrontmatterKey = value || 'viewmode';
              await this.plugin.saveSettings();
            })
        );

      new Setting(viewModeConfigContainer)
        .setName('Ignored Folders')
        .setDesc('One path per line. Files in these folders will generally keep their current view mode.')
        .addTextArea((text) => {
          text
            .setPlaceholder('Bases\nAtlas/Views')
            .setValue(this.plugin.settings.viewModeIgnoredFolders || '')
            .onChange(async (value) => {
              this.plugin.settings.viewModeIgnoredFolders = value;
              await this.plugin.saveSettings();
            });
          text.inputEl.rows = 3;
          text.inputEl.cols = 30;
        });

      viewRulesPopout = createPopout(
        viewModeConfigContainer,
        'View Mode Rules',
        'Define condition rules with AND/OR matching (path contains, scheduled past, daily-note date rules, etc).'
      );
    }

    const ensureViewModeRules = (): ViewModeRule[] => {
      if (!Array.isArray(this.plugin.settings.viewModeRules)) {
        this.plugin.settings.viewModeRules = [];
      }
      return this.plugin.settings.viewModeRules as ViewModeRule[];
    };

    const createCondition = (type: ViewModeConditionType): ViewModeRuleCondition => {
      if (type === 'path') return { type: 'path', operator: 'contains', value: '' };
      if (type === 'scheduled') return { type: 'scheduled', key: 'scheduled', operator: 'past' };
      if (type === 'daily-note') return { type: 'daily-note', operator: 'not-today' };
      return { type: 'frontmatter', key: 'status', operator: 'equals', value: '' };
    };

    const normalizeConditionType = (type: unknown): ViewModeConditionType => {
      const normalized = String(type || '').trim().toLowerCase();
      if (normalized === 'path') return 'path';
      if (normalized === 'scheduled') return 'scheduled';
      if (normalized === 'daily-note') return 'daily-note';
      return 'frontmatter';
    };

    const normalizeConditionOperator = (type: ViewModeConditionType, operator: unknown): ViewModeConditionOperator => {
      const value = String(operator || '').trim().toLowerCase();
      if (type === 'path') {
        if (value === 'equals' || value === 'starts-with' || value === 'ends-with' || value === 'not-contains' || value === 'exists' || value === 'missing') {
          return value as ViewModeConditionOperator;
        }
        return 'contains';
      }
      if (type === 'frontmatter') {
        if (value === 'contains' || value === 'not-equals' || value === 'not-contains' || value === 'exists' || value === 'missing' || value === 'is-empty') {
          return value as ViewModeConditionOperator;
        }
        return 'equals';
      }
      if (value === 'future' || value === 'today' || value === 'not-today' || value === 'exists' || value === 'missing') {
        return value as ViewModeConditionOperator;
      }
      return 'past';
    };

    const operatorNeedsValue = (type: ViewModeConditionType, operator: ViewModeConditionOperator): boolean => {
      if (type === 'daily-note' || type === 'scheduled') return false;
      return operator !== 'exists' && operator !== 'missing' && operator !== 'is-empty';
    };

    const ensureRuleShape = (rule: ViewModeRule): { normalizedRule: ViewModeRule; changed: boolean } => {
      let changed = false;
      const normalizedRule: ViewModeRule = rule;

      if (normalizedRule.match !== 'all' && normalizedRule.match !== 'any') {
        normalizedRule.match = 'all';
        changed = true;
      }
      if (!normalizedRule.mode) {
        normalizedRule.mode = 'reading';
        changed = true;
      }

      if (!Array.isArray(normalizedRule.conditions) || normalizedRule.conditions.length === 0) {
        const legacyKey = String((normalizedRule as any).key || '').trim();
        const legacyValue = String((normalizedRule as any).value || '').trim();
        if (legacyKey && legacyValue) {
          normalizedRule.conditions = [{ type: 'frontmatter', key: legacyKey, operator: 'equals', value: legacyValue }];
        } else {
          normalizedRule.conditions = [createCondition('frontmatter')];
        }
        changed = true;
      }

      normalizedRule.conditions = (normalizedRule.conditions || []).map((condition) => {
        const type = normalizeConditionType(condition?.type);
        const operator = normalizeConditionOperator(type, condition?.operator);
        const normalizedCondition: ViewModeRuleCondition = {
          ...condition,
          type,
          operator,
        };
        if (type === 'frontmatter' && !String(normalizedCondition.key || '').trim()) {
          normalizedCondition.key = 'status';
          changed = true;
        }
        if (type === 'scheduled' && !String(normalizedCondition.key || '').trim()) {
          normalizedCondition.key = 'scheduled';
          changed = true;
        }
        if (operatorNeedsValue(type, operator)) {
          if (normalizedCondition.value == null) {
            normalizedCondition.value = '';
            changed = true;
          }
        } else if (normalizedCondition.value) {
          normalizedCondition.value = '';
          changed = true;
        }
        return normalizedCondition;
      });

      return { normalizedRule, changed };
    };

    const getOperatorOptions = (type: ViewModeConditionType): Array<{ value: ViewModeConditionOperator; label: string }> => {
      if (type === 'path') {
        return [
          { value: 'contains', label: 'contains' },
          { value: 'equals', label: 'equals' },
          { value: 'starts-with', label: 'starts with' },
          { value: 'ends-with', label: 'ends with' },
          { value: 'not-contains', label: 'does not contain' },
          { value: 'exists', label: 'exists' },
          { value: 'missing', label: 'missing' },
        ];
      }
      if (type === 'frontmatter') {
        return [
          { value: 'equals', label: 'equals' },
          { value: 'contains', label: 'contains' },
          { value: 'not-equals', label: 'does not equal' },
          { value: 'not-contains', label: 'does not contain' },
          { value: 'exists', label: 'exists' },
          { value: 'missing', label: 'missing' },
        ];
      }
      return [
        { value: 'past', label: 'is in the past' },
        { value: 'future', label: 'is in the future' },
        { value: 'today', label: 'is today' },
        { value: 'not-today', label: 'is not today' },
        { value: 'exists', label: 'exists' },
        { value: 'missing', label: 'missing' },
      ];
    };

    if (this.plugin.settings.enableViewModeSwitching) {
      new Setting(viewRulesPopout)
        .setName('Rules')
        .setDesc('Add and combine conditions per rule.')
        .addButton(btn => btn
          .setButtonText('Add Rule')
          .setCta()
          .onClick(async () => {
            const rules = ensureViewModeRules();
            rules.push({
              mode: 'reading',
              match: 'all',
              conditions: [createCondition('frontmatter')],
            });
            await this.plugin.saveSettings();
            this.display();
          }))
        .addButton(btn => btn
          .setButtonText('Add Daily Rule')
          .onClick(async () => {
            const rules = ensureViewModeRules();
            rules.push({
              mode: 'reading',
              match: 'all',
              conditions: [{ type: 'daily-note', operator: 'not-today' }],
            });
            await this.plugin.saveSettings();
            this.display();
          }))
        .addButton(btn => btn
          .setButtonText('Add Path/Past OR')
          .onClick(async () => {
            const rules = ensureViewModeRules();
            rules.push({
              mode: 'reading',
              match: 'any',
              conditions: [
                { type: 'path', operator: 'contains', value: '' },
                { type: 'scheduled', key: 'scheduled', operator: 'past' },
              ],
            });
            await this.plugin.saveSettings();
            this.display();
          }));

      const rules = ensureViewModeRules();
      let migratedRules = false;
      rules.forEach((rule, index) => {
        const normalized = ensureRuleShape(rule);
        if (normalized.changed) migratedRules = true;
        const currentRule = normalized.normalizedRule;

        const card = viewRulesPopout.createDiv({ cls: 'tps-gcm-viewmode-rule' });
        card.style.border = '1px solid var(--background-modifier-border)';
        card.style.borderRadius = '8px';
        card.style.padding = '10px';
        card.style.marginBottom = '10px';

        new Setting(card)
          .setName(`Rule ${index + 1}`)
          .setDesc('Conditions must match before applying mode.')
          .addDropdown(drop => drop
            .addOption('all', 'Match all (AND)')
            .addOption('any', 'Match any (OR)')
            .setValue(currentRule.match || 'all')
            .onChange(async v => {
              currentRule.match = v === 'any' ? 'any' : 'all';
              await this.plugin.saveSettings();
            }))
          .addDropdown(drop => drop
            .addOption('reading', 'Reading')
            .addOption('source', 'Source')
            .addOption('live', 'Live')
            .setValue(currentRule.mode)
            .onChange(async v => {
              currentRule.mode = v;
              await this.plugin.saveSettings();
            }))
          .addButton(btn => btn
            .setButtonText('Add Condition')
            .onClick(async () => {
              currentRule.conditions = currentRule.conditions || [];
              currentRule.conditions.push(createCondition('frontmatter'));
              await this.plugin.saveSettings();
              this.display();
            }))
          .addExtraButton(btn => btn
            .setIcon('trash')
            .setTooltip('Delete rule')
            .onClick(async () => {
              rules.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
            }));

        const conditions = currentRule.conditions || [];
        conditions.forEach((condition, conditionIndex) => {
          const type = normalizeConditionType(condition.type);
          const operator = normalizeConditionOperator(type, condition.operator);
          const conditionRow = card.createDiv();
          conditionRow.style.display = 'grid';
          conditionRow.style.gridTemplateColumns = 'minmax(110px, 1fr) minmax(110px, 1fr) minmax(120px, 1.3fr) minmax(160px, 2fr) auto';
          conditionRow.style.gap = '8px';
          conditionRow.style.alignItems = 'center';
          conditionRow.style.marginTop = '8px';

          const typeSetting = new Setting(conditionRow).setClass('tps-gcm-no-border');
          typeSetting.addDropdown(drop => drop
            .addOption('frontmatter', 'Frontmatter')
            .addOption('path', 'Path')
            .addOption('scheduled', 'Scheduled')
            .addOption('daily-note', 'Daily Note')
            .setValue(type)
            .onChange(async v => {
              const nextType = normalizeConditionType(v);
              const nextCondition = createCondition(nextType);
              currentRule.conditions![conditionIndex] = nextCondition;
              await this.plugin.saveSettings();
              this.display();
            }));

          const keySetting = new Setting(conditionRow).setClass('tps-gcm-no-border');
          if (type === 'frontmatter' || type === 'scheduled') {
            keySetting.addText(text => text
              .setPlaceholder(type === 'frontmatter' ? 'key' : 'scheduled')
              .setValue(String(condition.key || (type === 'scheduled' ? 'scheduled' : '')))
              .onChange(async value => {
                condition.key = type === 'scheduled' ? (value.trim() || 'scheduled') : value.trim();
                await this.plugin.saveSettings();
              }));
          } else {
            keySetting.setName('');
          }

          const operatorSetting = new Setting(conditionRow).setClass('tps-gcm-no-border');
          operatorSetting.addDropdown(drop => {
            getOperatorOptions(type).forEach(option => drop.addOption(option.value, option.label));
            drop
              .setValue(operator)
              .onChange(async value => {
                condition.operator = normalizeConditionOperator(type, value);
                if (!operatorNeedsValue(type, condition.operator)) {
                  condition.value = '';
                }
                await this.plugin.saveSettings();
                this.display();
              });
          });

          const valueSetting = new Setting(conditionRow).setClass('tps-gcm-no-border');
          if (operatorNeedsValue(type, operator)) {
            valueSetting.addText(text => text
              .setPlaceholder(type === 'path' ? 'text to match in path' : 'value')
              .setValue(String(condition.value || ''))
              .onChange(async value => {
                condition.value = value;
                await this.plugin.saveSettings();
              }));
          } else {
            valueSetting.setName('');
          }

          new Setting(conditionRow)
            .setClass('tps-gcm-no-border')
            .addExtraButton(btn => btn
              .setIcon('x')
              .setTooltip('Remove condition')
              .onClick(async () => {
                currentRule.conditions!.splice(conditionIndex, 1);
                if (!currentRule.conditions!.length) {
                  currentRule.conditions = [createCondition('frontmatter')];
                }
                await this.plugin.saveSettings();
                this.display();
              }));
        });
      });

      if (migratedRules) {
        void this.plugin.saveSettings();
      }
    }

    // --- Overlay Ignore Rules ---
    const overlayIgnore = createSection(rulesCategory, 'Overlay Ignore Rules');
    overlayIgnore.createEl('p', {
      text: 'Define rules to hide the context menu/subitems overlay for notes that match certain conditions.',
      cls: 'setting-item-description'
    });

    // Helper function for ignore rules (simplified - no mode selection needed)
    const createIgnoreRulesUI = (container: HTMLElement, rules: ViewModeRule[]) => {
      const createConditionHelper = (type: ViewModeConditionType): ViewModeRuleCondition => {
        if (type === 'path') return { type: 'path', operator: 'contains', value: '' };
        if (type === 'scheduled') return { type: 'scheduled', key: 'scheduled', operator: 'past' };
        if (type === 'daily-note') return { type: 'daily-note', operator: 'not-today' };
        return { type: 'frontmatter', key: 'status', operator: 'equals', value: '' };
      };

      new Setting(container)
        .addButton(btn => btn
          .setButtonText('Add Rule')
          .onClick(async () => {
            rules.push({
              mode: 'ignore',
              match: 'all',
              conditions: [createConditionHelper('frontmatter')],
            });
            await this.plugin.saveSettings();
            this.display();
          }));

      rules.forEach((rule, index) => {
        const card = container.createDiv({ cls: 'tps-gcm-ignore-rule' });
        card.style.border = '1px solid var(--background-modifier-border)';
        card.style.borderRadius = '8px';
        card.style.padding = '10px';
        card.style.marginBottom = '10px';

        new Setting(card)
          .setName(`Rule ${index + 1}`)
          .setDesc('Conditions must match before hiding overlay.')
          .addDropdown(drop => drop
            .addOption('all', 'Match all (AND)')
            .addOption('any', 'Match any (OR)')
            .setValue(rule.match || 'all')
            .onChange(async v => {
              rule.match = v === 'any' ? 'any' : 'all';
              await this.plugin.saveSettings();
            }))
          .addButton(btn => btn
            .setButtonText('Add Condition')
            .onClick(async () => {
              rule.conditions = rule.conditions || [];
              rule.conditions.push(createConditionHelper('frontmatter'));
              await this.plugin.saveSettings();
              this.display();
            }))
          .addExtraButton(btn => btn
            .setIcon('trash')
            .setTooltip('Delete rule')
            .onClick(async () => {
              rules.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
            }));

        const conditions = rule.conditions || [];
        conditions.forEach((condition, conditionIndex) => {
          const conditionRow = card.createDiv();
          conditionRow.style.display = 'grid';
          conditionRow.style.gridTemplateColumns = 'minmax(110px, 1fr) minmax(110px, 1fr) minmax(120px, 1.3fr) minmax(160px, 2fr) auto';
          conditionRow.style.gap = '8px';
          conditionRow.style.alignItems = 'center';
          conditionRow.style.marginTop = '8px';

          const typeSetting = new Setting(conditionRow).setClass('tps-gcm-no-border');
          typeSetting.addDropdown(drop => drop
            .addOption('frontmatter', 'Frontmatter')
            .addOption('path', 'Path')
            .addOption('scheduled', 'Scheduled')
            .addOption('daily-note', 'Daily Note')
            .setValue(String(condition.type || 'frontmatter'))
            .onChange(async v => {
              const nextType = String(v) as ViewModeConditionType;
              rule.conditions![conditionIndex] = createConditionHelper(nextType);
              await this.plugin.saveSettings();
              this.display();
            }));

          const keySetting = new Setting(conditionRow).setClass('tps-gcm-no-border');
          if (condition.type === 'frontmatter' || condition.type === 'scheduled') {
            keySetting.addText(text => text
              .setPlaceholder(condition.type === 'frontmatter' ? 'key' : 'scheduled')
              .setValue(String(condition.key || (condition.type === 'scheduled' ? 'scheduled' : '')))
              .onChange(async value => {
                condition.key = condition.type === 'scheduled' ? (value.trim() || 'scheduled') : value.trim();
                await this.plugin.saveSettings();
              }));
          }

          const operatorSetting = new Setting(conditionRow).setClass('tps-gcm-no-border');
          const operators = condition.type === 'path'
            ? ['contains', 'equals', 'starts-with', 'ends-with', 'not-contains']
            : condition.type === 'frontmatter'
              ? ['equals', 'contains', 'not-equals', 'not-contains', 'exists', 'missing', 'is-empty']
              : ['past', 'future', 'today', 'not-today'];
          operatorSetting.addDropdown(drop => {
            operators.forEach(op => drop.addOption(op, op));
            drop
              .setValue(String(condition.operator || operators[0]))
              .onChange(async value => {
                condition.operator = value as ViewModeConditionOperator;
                await this.plugin.saveSettings();
                this.display();
              });
          });

          const valueSetting = new Setting(conditionRow).setClass('tps-gcm-no-border');
          const needsValue = !['daily-note', 'scheduled'].includes(condition.type || '') && !['exists', 'missing'].includes(condition.operator || '');
          if (needsValue) {
            valueSetting.addText(text => text
              .setPlaceholder(condition.type === 'path' ? 'text to match in path' : 'value')
              .setValue(String(condition.value || ''))
              .onChange(async value => {
                condition.value = value;
                await this.plugin.saveSettings();
              }));
          }

          new Setting(conditionRow)
            .setClass('tps-gcm-no-border')
            .addExtraButton(btn => btn
              .setIcon('x')
              .setTooltip('Remove condition')
              .onClick(async () => {
                rule.conditions!.splice(conditionIndex, 1);
                if (!rule.conditions!.length) {
                  rule.conditions = [createConditionHelper('frontmatter')];
                }
                await this.plugin.saveSettings();
                this.display();
              }));
        });
      });
    };

    const subitemIgnorePopout = createPopout(
      overlayIgnore,
      'Subitems Overlay Ignore Rules',
      'Rules to hide the subitems section for matching notes'
    );
    if (!Array.isArray(this.plugin.settings.subitems_IgnoreRules)) {
      this.plugin.settings.subitems_IgnoreRules = [];
    }
    createIgnoreRulesUI(subitemIgnorePopout, this.plugin.settings.subitems_IgnoreRules as ViewModeRule[]);

    const inlineMenuIgnorePopout = createPopout(
      overlayIgnore,
      'Inline Menu Overlay Ignore Rules',
      'Rules to hide the inline context menu for matching notes'
    );
    if (!Array.isArray(this.plugin.settings.inlineMenu_IgnoreRules)) {
      this.plugin.settings.inlineMenu_IgnoreRules = [];
    }
    createIgnoreRulesUI(inlineMenuIgnorePopout, this.plugin.settings.inlineMenu_IgnoreRules as ViewModeRule[]);

    // --- Menu Configuration (Consolidated) ---
    const menuConfig = createSection(featuresCategory, 'Menu Configuration');
    const systemCommandsPopout = createPopout(
      menuConfig,
      'System Commands',
      'Choose optional file operation buttons. Rename is always shown for single-file targets.'
    );
    const systemCommands = [
      { id: 'open-in-new-tab', label: 'New Tab' },
      { id: 'open-to-right', label: 'To Right' },
      { id: 'open-in-new-window', label: 'New Window' },
      { id: 'move-file', label: 'Move' },
      { id: 'duplicate', label: 'Duplicate' },
      { id: 'copy-url', label: 'Copy URL' },
      { id: 'reveal-finder', label: 'Reveal File' },
    ];

    const sysCmdContainer = systemCommandsPopout.createDiv();
    sysCmdContainer.style.display = 'grid';
    sysCmdContainer.style.gridTemplateColumns = '1fr 1fr';
    sysCmdContainer.style.gap = '10px';

    systemCommands.forEach(cmd => {
      const row = sysCmdContainer.createDiv();
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.justifyContent = 'space-between';

      const label = row.createSpan({ text: cmd.label });
      const toggle = new Setting(row)
        .setClass('tps-gcm-compact-toggle')
        .addToggle(t => t
          .setValue((this.plugin.settings.systemCommands || []).includes(cmd.id))
          .onChange(async (value) => {
            let cmds = this.plugin.settings.systemCommands || [];
            if (value && !cmds.includes(cmd.id)) cmds.push(cmd.id);
            else if (!value) cmds = cmds.filter(c => c !== cmd.id);
            this.plugin.settings.systemCommands = cmds;
            await this.plugin.saveSettings();
          }));
    });

    const propertiesPopout = createPopout(
      menuConfig,
      'Custom Properties',
      'Feature toggles only. Define labels, keys, types, options, and per-property placement under Rules > Custom Property Configuration.'
    );

    propertiesPopout.createEl('p', {
      text: `${(this.plugin.settings.properties || []).length} properties configured in Rules > Custom Property Configuration.`,
      cls: 'setting-item-description',
    });

    new Setting(propertiesPopout)
      .setName('Show custom properties in inline UI')
      .setDesc('Display configured custom properties in the inline header/context strip.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showCustomPropertiesInInlineUi !== false)
        .onChange(async (value) => {
          this.plugin.settings.showCustomPropertiesInInlineUi = value;
          await this.plugin.saveSettings();
        }));

    new Setting(propertiesPopout)
      .setName('Show custom properties in context menu')
      .setDesc('Display configured custom properties in the right-click context menu.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showCustomPropertiesInContextMenu !== false)
        .onChange(async (value) => {
          this.plugin.settings.showCustomPropertiesInContextMenu = value;
          await this.plugin.saveSettings();
        }));

    new Setting(propertiesPopout)
      .setName('Inherit Notebook Navigator tag colors')
      .setDesc('When enabled, tag chips in the inline menu adopt Notebook Navigator tag colors if available.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.inheritNotebookNavigatorTagColors !== false)
        .onChange(async (value) => {
          this.plugin.settings.inheritNotebookNavigatorTagColors = value;
          await this.plugin.saveSettings();
        }));

    // --- Automation Features (Consolidated) ---
    const automation = createSection(featuresCategory, 'Automation & Features');

    automation.createEl('p', {
      text: 'Keep these focused on note interaction. Higher-impact automation stays under the advanced subsections below.',
      cls: 'setting-item-description'
    });

    const taskAutomation = createPopout(automation, 'Checklists & Task State');
    new Setting(taskAutomation).setName('Check pending items').setDesc('Warn on completion if items unchecked').addToggle(t => t.setValue(this.plugin.settings.checkOpenChecklistItems).onChange(async v => { this.plugin.settings.checkOpenChecklistItems = v; await this.plugin.saveSettings(); }));
    new Setting(taskAutomation).setName('Check parent-linked notes').setDesc('Warn when completing if any notes with parent links are still open').addToggle(t => t.setValue(this.plugin.settings.checkParentLinkStatuses).onChange(async v => { this.plugin.settings.checkParentLinkStatuses = v; await this.plugin.saveSettings(); }));
    new Setting(taskAutomation)
      .setName('Checklist completion property')
      .setDesc('When enabled, automatically writes a boolean frontmatter property that is true only when every checklist item is checked [x] or canceled [-]. Unchecked [ ] and question-mark [?] items keep it false.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableChecklistCompletionProperty).onChange(async (v) => {
          this.plugin.settings.enableChecklistCompletionProperty = v;
          await this.plugin.saveSettings();
        })
      );
    if (this.plugin.settings.enableChecklistCompletionProperty) {
      new Setting(taskAutomation)
        .setName('Completion property key')
        .setDesc('Frontmatter key used for the checklist completion boolean (e.g. "allChecked").')
        .addText((t) =>
          t
            .setPlaceholder('allChecked')
            .setValue(this.plugin.settings.checklistCompletionPropertyKey || 'allChecked')
            .onChange(async (v) => {
              this.plugin.settings.checklistCompletionPropertyKey = v.trim() || 'allChecked';
              await this.plugin.saveSettings();
            })
        );
    }
    new Setting(taskAutomation)
      .setName('Checkbox click cycle')
      .setDesc('Cycle task states on normal click. Right-click or long-press opens a state selector.')
      .addToggle(t => t.setValue(this.plugin.settings.enableTaskCheckboxCycle).onChange(async v => { this.plugin.settings.enableTaskCheckboxCycle = v; await this.plugin.saveSettings(); }));
    new Setting(taskAutomation)
      .setName('Final checklist prompt statuses')
      .setDesc('When the last open checkbox is resolved, prompt to set one of these statuses (comma-separated).')
      .addText((t) =>
        t.setValue((this.plugin.settings.checklistFinalPromptStatuses || ['complete', 'wont-do']).join(', '))
          .onChange(async (v) => {
            const next = v.split(',').map((s) => s.trim()).filter(Boolean);
            this.plugin.settings.checklistFinalPromptStatuses = next.length > 0 ? next : ['complete', 'wont-do'];
            await this.plugin.saveSettings();
          })
      );

    const relationshipAutomation = createPopout(automation, 'Parent / Child Links');
    new Setting(relationshipAutomation).setName('Parent frontmatter key').setDesc('Frontmatter key used to link a note to its parent (child → parent direction, e.g. "childOf")').addText(t => t.setValue(this.plugin.settings.parentLinkFrontmatterKey || 'childOf').onChange(async v => { this.plugin.settings.parentLinkFrontmatterKey = v.trim() || 'childOf'; await this.plugin.saveSettings(); }));
    new Setting(relationshipAutomation).setName('Child frontmatter key').setDesc('Frontmatter key written to the parent note listing its children (parent → child direction, e.g. "parentOf")').addText(t => t.setValue(this.plugin.settings.childLinkFrontmatterKey || 'parentOf').onChange(async v => { this.plugin.settings.childLinkFrontmatterKey = v.trim() || 'parentOf'; await this.plugin.saveSettings(); }));
    new Setting(relationshipAutomation)
      .setName('Auto self-link parent in parent key')
      .setDesc('When enabled, parent notes keep a self-reference in the parent key (for example childOf: [[This Note]]).')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoSelfLinkParentInParentKey ?? false).onChange(async (v) => {
          this.plugin.settings.autoSelfLinkParentInParentKey = v;
          await this.plugin.saveSettings();
        })
      );
    new Setting(relationshipAutomation)
      .setName('Parent link format')
      .setDesc('Store parent links as wikilinks or markdown links with explicit note-title display names.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('wikilink', 'Wikilink ([[path|Title]])')
          .addOption('markdown-title', 'Markdown ([Title](path))')
          .setValue(this.plugin.settings.parentLinkFormat || 'wikilink')
          .onChange(async (value: 'wikilink' | 'markdown-title') => {
            this.plugin.settings.parentLinkFormat = value;
            await this.plugin.saveSettings();
          })
      );
    new Setting(relationshipAutomation)
      .setName('Tag parent when child linked')
      .setDesc('Applied to parent notes when linking children. Use # or plain tag. Leave empty to disable.')
      .addText((text) =>
        text
          .setPlaceholder('project')
          .setValue(this.plugin.settings.parentTagOnChildLink || '')
          .onChange(async (value) => {
            this.plugin.settings.parentTagOnChildLink = value.trim();
            await this.plugin.saveSettings();
          })
      );
    new Setting(relationshipAutomation).setName('Top page connections navigation').setDesc('Show a navigation button displaying all incoming and outgoing links at the top of the page above the title').addToggle(t => t.setValue(this.plugin.settings.enableTopParentNav).onChange(async v => { this.plugin.settings.enableTopParentNav = v; await this.plugin.saveSettings(); this.plugin.persistentMenuManager.ensureMenus(); }));
    new Setting(relationshipAutomation)
      .setName('Ignore embedded children in top links')
      .setDesc('When enabled, links created by embedded children and promoted checklist children are hidden from the top Links button.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.ignoreEmbeddedChildrenInTopLinks ?? true).onChange(async (v) => {
          this.plugin.settings.ignoreEmbeddedChildrenInTopLinks = v;
          await this.plugin.saveSettings();
          this.plugin.persistentMenuManager.ensureMenus();
        })
      );
    new Setting(relationshipAutomation).setName('Completion statuses').setDesc('Statuses treated as complete for parent-linked notes').addText(t => t.setValue((this.plugin.settings.parentCompletionStatuses || []).join(', ')).onChange(async v => { this.plugin.settings.parentCompletionStatuses = v.split(',').map(s => s.trim()).filter(Boolean); await this.plugin.saveSettings(); }));

    const workspaceFeatures = createPopout(automation, 'Workspace & Backlinks');
    new Setting(workspaceFeatures)
      .setName('Workspace ribbon buttons')
      .setDesc(
        'Add a ribbon icon for each saved workspace in the core Workspaces plugin. ' +
        'Clicking an icon instantly loads that workspace. ' +
        'Requires the core Workspaces plugin to be enabled. ' +
        'Changes take effect immediately.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.workspaceRibbonButtons)
          .onChange(async (value) => {
            this.plugin.settings.workspaceRibbonButtons = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.workspaceRibbonButtons) {
      const workspaceIconSettings = workspaceFeatures.createDiv({ cls: 'tps-gcm-sub-settings' });
      workspaceIconSettings.style.paddingLeft = '15px';
      workspaceIconSettings.style.borderLeft = '2px solid var(--background-modifier-border)';

      const workspaceNames = this.getWorkspaceNames();
      if (workspaceNames.length === 0) {
        workspaceIconSettings.createEl('p', {
          cls: 'setting-item-description',
          text: 'No saved workspaces found (or the core Workspaces plugin is disabled). Save at least one workspace to configure per-workspace icons.',
        });
      } else {
        const iconMap = this.plugin.settings.workspaceRibbonIcons || {};
        for (const workspaceName of workspaceNames) {
          new Setting(workspaceIconSettings)
            .setName(`Workspace icon: ${workspaceName}`)
            .setDesc('Lucide icon name. Leave blank to use layout-dashboard.')
            .addText((text) =>
              text
                .setPlaceholder('layout-dashboard')
                .setValue(iconMap[workspaceName] || '')
                .onChange(async (value) => {
                  const next = value.trim();
                  if (!this.plugin.settings.workspaceRibbonIcons || typeof this.plugin.settings.workspaceRibbonIcons !== 'object') {
                    this.plugin.settings.workspaceRibbonIcons = {};
                  }
                  if (next) this.plugin.settings.workspaceRibbonIcons[workspaceName] = next;
                  else delete this.plugin.settings.workspaceRibbonIcons[workspaceName];
                  await this.plugin.saveSettings();
                })
            );
        }

        const staleMappings = Object.keys(iconMap).filter((name) => !workspaceNames.includes(name));
        if (staleMappings.length > 0) {
          new Setting(workspaceIconSettings)
            .setName('Remove stale workspace icon mappings')
            .setDesc(`You have ${staleMappings.length} icon mapping(s) for workspaces that no longer exist.`)
            .addButton((button) =>
              button.setButtonText('Remove stale mappings').onClick(async () => {
                for (const name of staleMappings) delete this.plugin.settings.workspaceRibbonIcons[name];
                await this.plugin.saveSettings();
                this.display();
              })
            );
        }
      }
    }

    new Setting(workspaceFeatures)
      .setName('Ignored frontmatter keys')
      .setDesc('Comma-separated list of frontmatter keys to hide from the Frontmatter section in the Backlinks panel (e.g. "dateModified, dateCreated").')
      .addText(t => t
        .setPlaceholder('dateModified, dateCreated')
        .setValue((this.plugin.settings.ignoredBacklinksFrontmatterKeys || []).join(', '))
        .onChange(async v => {
          this.plugin.settings.ignoredBacklinksFrontmatterKeys = v.split(',').map(s => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));

    const advancedAutomation = createPopout(
      automation,
      'Advanced Automation',
      [
        hasController ? 'Prefer TPS Controller for recurring/archive orchestration.' : '',
        hasCompanion ? 'Prefer Companion for icon/color/sort ownership.' : '',
      ].filter(Boolean).join(' ')
    );
    new Setting(advancedAutomation).setName('Task Recurrence').setDesc('Auto-create next recurring task').addToggle(t => t.setValue(this.plugin.settings.enableRecurrence).onChange(async v => { this.plugin.settings.enableRecurrence = v; await this.plugin.saveSettings(); }));

    if (this.plugin.settings.enableRecurrence) {
      const sub = advancedAutomation.createDiv({ cls: 'tps-gcm-sub-settings' });
      sub.style.paddingLeft = '15px';
      sub.style.borderLeft = '2px solid var(--background-modifier-border)';
      new Setting(sub).setName('Completion Triggers').setDesc('Statuses that trigger recurrence').addText(t => t.setValue((this.plugin.settings.recurrenceCompletionStatuses || []).join(', ')).onChange(async v => { this.plugin.settings.recurrenceCompletionStatuses = v.split(',').map(s => s.trim()).filter(Boolean); await this.plugin.saveSettings(); }));
      new Setting(sub).setName('Prompt on Edit').setDesc('Ask to update future instances').addToggle(t => t.setValue(this.plugin.settings.promptOnRecurrenceEdit).onChange(async v => { this.plugin.settings.promptOnRecurrenceEdit = v; await this.plugin.saveSettings(); }));
      new Setting(sub).setName('Template Folder').setDesc('Folder for recurring event templates (copied when recurrence first set). Leave blank to disable.').addText(t => t.setPlaceholder('e.g. Recurring Templates').setValue(this.plugin.settings.recurringTemplateFolder || '').onChange(async v => { this.plugin.settings.recurringTemplateFolder = v.trim(); await this.plugin.saveSettings(); }));
    }

    new Setting(advancedAutomation).setName('Auto-Rename Files').setDesc('Rename based on title/date criteria').addToggle(t => t.setValue(this.plugin.settings.enableAutoRename).onChange(async v => { this.plugin.settings.enableAutoRename = v; await this.plugin.saveSettings(); }));
    new Setting(advancedAutomation)
      .setName('Auto-sync title from filename')
      .setDesc('Keep frontmatter `title` aligned to the current filename on open/rename. Disabled by default to avoid surprise metadata writes.')
      .addToggle(t => t.setValue(this.plugin.settings.autoSyncTitleFromFilename).onChange(async v => { this.plugin.settings.autoSyncTitleFromFilename = v; await this.plugin.saveSettings(); }));
    new Setting(advancedAutomation).setName('Auto-Save Folder').setDesc('Save path to frontmatter').addToggle(t => t.setValue(this.plugin.settings.autoSaveFolderPath).onChange(async v => { this.plugin.settings.autoSaveFolderPath = v; await this.plugin.saveSettings(); }));
    new Setting(advancedAutomation)
      .setName('Seed new subitem visual metadata')
      .setDesc('When creating child notes, copy inferred icon/color defaults into frontmatter. Disabled by default so GCM does not claim visual field ownership.')
      .addToggle(t => t.setValue(this.plugin.settings.seedNewSubitemVisualMetadata).onChange(async v => { this.plugin.settings.seedNewSubitemVisualMetadata = v; await this.plugin.saveSettings(); }));
    new Setting(advancedAutomation)
      .setName('Apply companion rules on subitem create')
      .setDesc('Immediately invoke the Notebook Navigator Companion after GCM creates a subitem. Disabled by default to avoid unexpected icon/color/sort writes.')
      .addToggle(t => t.setValue(this.plugin.settings.applyCompanionRulesOnSubitemCreate).onChange(async v => { this.plugin.settings.applyCompanionRulesOnSubitemCreate = v; await this.plugin.saveSettings(); }));
    new Setting(advancedAutomation)
      .setName('Frontmatter auto-write exclusions')
      .setDesc('Skip automatic frontmatter writes for matching files. One pattern per line. Supports exact paths, folder prefixes (end with /), wildcards (*), name:<basename>, and re:<regex>. Example: Templates/, Templates/*.md, name:daily-template')
      .addTextArea(t => t
        .setValue(this.plugin.settings.frontmatterAutoWriteExclusions || '')
        .setPlaceholder('Templates/\nTemplates/*.md\nname:daily-template')
        .onChange(async v => {
          this.plugin.settings.frontmatterAutoWriteExclusions = v;
          await this.plugin.saveSettings();
        }));

    const viewModeFeatures = createPopout(
      automation,
      'View Mode Switching',
      'Feature toggles only. Rule/frontmatter configuration lives under Rules > View Mode Configuration.'
    );
    new Setting(viewModeFeatures)
      .setName('Enable automatic view mode switching')
      .setDesc('Automatically switch between Source, Live Preview, and Reading modes based on frontmatter and configured rules.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableViewModeSwitching)
          .onChange(async (value) => {
            this.plugin.settings.enableViewModeSwitching = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(viewModeFeatures)
      .setName('Show inline manual view mode controls')
      .setDesc('Show Reading / Live / Source buttons in the inline menu panel only.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableInlineManualViewMode)
          .onChange(async (value) => {
            this.plugin.settings.enableInlineManualViewMode = value;
            await this.plugin.saveSettings();
          })
      );

    const navigationAutomation = createPopout(automation, 'Daily Note Navigation');
    new Setting(navigationAutomation)
      .setName('Enable Daily Note Navigation')
      .setDesc('Show hovering Previous/Today/Next controls on daily notes.')
      .addToggle(t => t.setValue(this.plugin.settings.enableDailyNoteNav).onChange(async v => {
        this.plugin.settings.enableDailyNoteNav = v;
        await this.plugin.saveSettings();
        if ((this.plugin as any).dailyNoteNavManager) {
          (this.plugin as any).dailyNoteNavManager.refresh();
        }
      }));

    new Setting(navigationAutomation)
      .setName('Show "Today" button')
      .setDesc('Show a Today shortcut between the prev/next arrows. Disable to show only the arrows.')
      .addToggle(t => t.setValue(this.plugin.settings.dailyNavShowToday !== false).onChange(async v => {
        this.plugin.settings.dailyNavShowToday = v;
        await this.plugin.saveSettings();
        if ((this.plugin as any).dailyNoteNavManager) {
          (this.plugin as any).dailyNoteNavManager.refresh();
        }
      }));

    containerEl.createEl('p', {
      text: 'Note: native context menu items are preserved; TPS actions are injected when context targets match.',
      cls: 'setting-item-description',
      attr: { style: 'margin-top: 20px; text-align: center; opacity: 0.7;' }
    });
    this.restoreSettingsViewState(containerEl);
  }

  private captureSettingsViewState(containerEl: HTMLElement): void {
    this.settingsScrollTop = containerEl.scrollTop;
    this.settingsViewState.clear();
    const detailsEls = Array.from(containerEl.querySelectorAll('details'));
    detailsEls.forEach((detailsEl, index) => {
      const details = detailsEl as HTMLDetailsElement;
      const summaryText = details.querySelector('summary')?.textContent?.trim() || '';
      this.settingsViewState.set(`${index}:${summaryText}`, details.open);
    });
  }

  private restoreSettingsViewState(containerEl: HTMLElement): void {
    const detailsEls = Array.from(containerEl.querySelectorAll('details'));
    if (!this.hasRenderedSettings) {
      detailsEls.forEach((detailsEl) => {
        (detailsEl as HTMLDetailsElement).removeAttribute('open');
      });
      this.hasRenderedSettings = true;
      containerEl.scrollTop = 0;
      return;
    }
    detailsEls.forEach((detailsEl, index) => {
      const details = detailsEl as HTMLDetailsElement;
      const summaryText = details.querySelector('summary')?.textContent?.trim() || '';
      const isOpen = this.settingsViewState.get(`${index}:${summaryText}`);
      if (isOpen) details.setAttr('open', 'true');
      else details.removeAttribute('open');
    });
    containerEl.scrollTop = this.settingsScrollTop;
  }

  renderProperties(container: HTMLElement) {
    container.empty();

    // Ensure properties exists
    if (!this.plugin.settings.properties) {
      this.plugin.settings.properties = [];
    }

    this.plugin.settings.properties.forEach((prop, index) => {
      const div = container.createDiv('tps-gcm-setting-item');
      div.style.border = '1px solid var(--background-modifier-border)';
      div.style.padding = '10px';
      div.style.marginBottom = '10px';
      div.style.borderRadius = '6px';
      div.style.display = 'flex';
      div.style.flexDirection = 'column';
      div.style.gap = '10px';

      const header = div.createDiv();
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.style.alignItems = 'center';
      header.createEl('strong', { text: prop.label || 'Unnamed Property' });

      const controls = header.createDiv();

      // Move Up
      if (index > 0) {
        const upBtn = controls.createEl('button', { text: '↑' });
        upBtn.onclick = async () => {
          const temp = this.plugin.settings.properties[index - 1];
          this.plugin.settings.properties[index - 1] = prop;
          this.plugin.settings.properties[index] = temp;
          await this.plugin.saveSettings();
          this.display();
        };
      }

      // Move Down
      if (index < this.plugin.settings.properties.length - 1) {
        const downBtn = controls.createEl('button', { text: '↓' });
        downBtn.onclick = async () => {
          const temp = this.plugin.settings.properties[index + 1];
          this.plugin.settings.properties[index + 1] = prop;
          this.plugin.settings.properties[index] = temp;
          await this.plugin.saveSettings();
          this.display();
        };
      }

      const delBtn = controls.createEl('button', { text: 'Delete' });
      delBtn.onclick = async () => {
        this.plugin.settings.properties.splice(index, 1);
        await this.plugin.saveSettings();
        this.display();
      };

      // Edit Fields
      const fields = div.createDiv();
      fields.style.display = 'grid';
      fields.style.gridTemplateColumns = '1fr 1fr';
      fields.style.gap = '10px';

      // Label
      new Setting(fields)
        .setName('Label')
        .addText(text => text
          .setValue(prop.label)
          .onChange(async (value) => {
            prop.label = value;
            await this.plugin.saveSettings();
          }));

      // Key
      new Setting(fields)
        .setName('Frontmatter Key')
        .addText(text => text
          .setValue(prop.key)
          .onChange(async (value) => {
            prop.key = value;
            await this.plugin.saveSettings();
          }));

      // Type
      new Setting(fields)
        .setName('Type')
        .addDropdown(drop => drop
          .addOption('text', 'Text')
          .addOption('number', 'Number')
          .addOption('datetime', 'Date/Time')
          .addOption('selector', 'Selector (Dropdown)')
          .addOption('list', 'List (Tags)')
          .addOption('recurrence', 'Recurrence')
          .addOption('folder', 'Type (Folder)')
          .addOption('snooze', 'Snooze')
          .setValue(prop.type)
          .onChange(async (value: any) => {
            prop.type = value;
            await this.plugin.saveSettings();
            this.display();
          }));

      // Icon
      new Setting(fields)
        .setName('Icon')
        .addText(text => text
          .setValue(prop.icon || '')
          .setPlaceholder('lucide-icon-name')
          .onChange(async (value) => {
            prop.icon = value;
            await this.plugin.saveSettings();
          }));

      new Setting(fields)
        .setName('Show on inline menu')
        .setDesc('Show this property in the inline header panel')
        .addToggle((toggle) =>
          toggle
            .setValue(prop.showInCollapsed !== false)
            .onChange(async (value) => {
              prop.showInCollapsed = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(fields)
        .setName('Show in context menu')
        .setDesc('Show this property in the right-click context menu')
        .addToggle((toggle) =>
          toggle
            .setValue(prop.showInContextMenu !== false)
            .onChange(async (value) => {
              prop.showInContextMenu = value;
              await this.plugin.saveSettings();
            })
        );

      // Options (only for selector)
      if (prop.type === 'selector') {
        const optionsDiv = div.createDiv();
        optionsDiv.style.gridColumn = '1 / -1';
        new Setting(optionsDiv)
          .setName('Options (comma separated)')
          .addTextArea(text => text
            .setValue((prop.options || []).join(', '))
            .onChange(async (value) => {
              prop.options = value.split(',').map(s => s.trim()).filter(s => s);
              await this.plugin.saveSettings();
            }));
      }

      // Profiles
      const profilesDiv = div.createDiv();
      profilesDiv.style.gridColumn = '1 / -1';
      new Setting(profilesDiv)
        .setName('Conditional Profiles')
        .setDesc('Configure conditional rules to hide this property or override selector options based on path/frontmatter.')
        .addButton(btn => btn
          .setButtonText(prop.profiles && prop.profiles.length > 0 ? `Edit Profiles (${prop.profiles.length})` : 'Add Profiles')
          .onClick(() => {
            new PropertyProfilesModal(this.app, this.plugin, prop, () => {
              this.renderProperties(container);
            }).open();
          }));
    });
  }

}
