import { Plugin, Notice, TFile, MarkdownView } from 'obsidian';
import { Extension } from '@codemirror/state';
import { buildCanvasExtension } from './canvas-extension';
import { ReadingModeProcessor } from './reading-mode-processor';
import { initializeCardStructure } from './card-initializer';
import {
  TPSCanvasNotesSettings,
  DEFAULT_SETTINGS,
  TPSCanvasNotesSettingTab
} from './settings-tab';

export default class TPSCanvasNotesPlugin extends Plugin {
  settings: TPSCanvasNotesSettings;
  private extensionArray: Extension[] = [];
  private readingModeProcessor: ReadingModeProcessor;

  async onload() {
    await this.loadSettings();

    // Initialize reading mode processor
    this.readingModeProcessor = new ReadingModeProcessor(this.app);

    // Register settings tab
    this.addSettingTab(new TPSCanvasNotesSettingTab(this.app, this));

    // Register CodeMirror extension (Live Preview)
    this.registerEditorExtension(this.extensionArray);

    // Register Reading Mode post-processor
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      if (!this.settings.enabled) return;

      // Check if this is a daily note
      if (this.settings.dailyNotesOnly) {
        const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if (file instanceof TFile && !this.isDailyNote(file)) {
          return;
        }
      }

      await this.readingModeProcessor.process(el, ctx);
    });

    // Add command to toggle canvas mode
    this.addCommand({
      id: 'toggle-canvas-notes',
      name: 'Toggle Canvas Notes mode',
      callback: () => {
        this.settings.enabled = !this.settings.enabled;
        this.saveSettings();
        this.updateExtension();
        new Notice(`Canvas Notes ${this.settings.enabled ? 'Enabled' : 'Disabled'}`);
      }
    });

    // Add command to insert card delimiter
    this.addCommand({
      id: 'insert-card-delimiter',
      name: 'Insert card delimiter (---)',
      editorCallback: (editor) => {
        const cursor = editor.getCursor();
        editor.replaceRange('---\n', cursor);
      }
    });

    // Initial setup
    this.updateExtension();

    // Auto-initialize card structure when opening daily notes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        if (!this.settings.enabled || !this.settings.dailyNotesOnly) return;

        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) return;

        const file = activeView.file;
        if (!file || !this.isDailyNote(file)) return;

        // Wait a bit for the editor to fully load
        setTimeout(() => {
          const editor = activeView.editor;
          if (!editor) return;

          // Get the CodeMirror 6 EditorView
          const cm6View = (editor as any).cm;
          if (cm6View) {
            initializeCardStructure(cm6View);
          }
        }, 100);
      })
    );

    // Listen for mode changes (source <-> live preview) to update extension
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        this.updateExtension();
      })
    );

    console.log('TPS Canvas Notes Plugin Loaded');
  }

  onunload() {
    console.log('TPS Canvas Notes Plugin Unloaded');
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  updateExtension() {
    this.extensionArray.length = 0;

    if (this.settings.enabled) {
      // Create shouldActivate function that checks if current file is a daily note
      // and if we're in live preview mode (not source mode)
      const shouldActivate = () => {
        if (!this.settings.dailyNotesOnly) {
          return true;
        }

        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
          return false;
        }

        if (!this.isDailyNote(activeFile)) {
          return false;
        }

        // Check if we're in live preview mode (not source mode)
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView) {
          return false;
        }

        // Get the current mode - only activate in live preview
        const mode = activeView.getMode();
        return mode === 'preview'; // 'preview' is live preview, 'source' is source mode
      };

      // buildCanvasExtension returns an array of extensions
      const extensions = buildCanvasExtension(this.app, shouldActivate);
      this.extensionArray.push(...extensions);
    }

    this.app.workspace.updateOptions();
  }

  isDailyNote(file: TFile): boolean {
    try {
      // Try to use the daily-notes-interface if available
      const { getAllDailyNotes } = require('obsidian-daily-notes-interface');
      const dailyNotes = getAllDailyNotes();
      return Object.values(dailyNotes).some((note: any) => note.path === file.path);
    } catch {
      // Fallback: check if file is in the daily notes folder
      // @ts-ignore
      const dailyNotesFolder = this.app.vault.getConfig('dailyNotesFolder') || '';
      return file.path.startsWith(dailyNotesFolder);
    }
  }
}
