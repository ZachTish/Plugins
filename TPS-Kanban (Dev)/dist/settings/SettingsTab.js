"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KanbanSettingTab = void 0;
const obsidian_1 = require("obsidian");
const settings_1 = require("../settings");
class KanbanSettingTab extends obsidian_1.PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'TPS Kanban settings' });
        new obsidian_1.Setting(containerEl)
            .setName('Per-base boards')
            .setDesc('Keep separate boards per vault/base when enabled')
            .addToggle(toggle => {
            var _a, _b;
            return toggle
                .setValue((_b = (_a = this.plugin.settings) === null || _a === void 0 ? void 0 : _a.perBaseScope) !== null && _b !== void 0 ? _b : settings_1.DEFAULT_SETTINGS.perBaseScope)
                .onChange(async (v) => {
                this.plugin.settings.perBaseScope = v;
                await this.plugin.saveSettings();
            });
        });
        new obsidian_1.Setting(containerEl)
            .setName('Default lanes')
            .setDesc('Comma-separated list of default lane titles for a new board')
            .addText(text => {
            var _a, _b;
            return text
                .setPlaceholder(settings_1.DEFAULT_SETTINGS.defaultLanes.join(', '))
                .setValue(((_b = (_a = this.plugin.settings) === null || _a === void 0 ? void 0 : _a.defaultLanes) !== null && _b !== void 0 ? _b : settings_1.DEFAULT_SETTINGS.defaultLanes).join(', '))
                .onChange(async (v) => {
                this.plugin.settings.defaultLanes = v.split(',').map(s => s.trim()).filter(Boolean);
                await this.plugin.saveSettings();
            });
        });
    }
}
exports.KanbanSettingTab = KanbanSettingTab;
