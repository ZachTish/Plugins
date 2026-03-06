"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const obsidian_1 = require("obsidian");
const KanbanView_1 = require("./views/KanbanView");
const settings_1 = require("./settings");
const SettingsTab_1 = require("./settings/SettingsTab");
class TPSKanbanPlugin extends obsidian_1.Plugin {
    constructor() {
        super(...arguments);
        this.settings = settings_1.DEFAULT_SETTINGS;
    }
    async onload() {
        var _a, _b, _c;
        console.log('Loading TPS Kanban (Dev)');
        this.settings = Object.assign({}, settings_1.DEFAULT_SETTINGS, await this.loadData() || {});
        this.registerView(KanbanView_1.KANBAN_VIEW_TYPE, (leaf) => new KanbanView_1.KanbanView(leaf, this));
        this.addCommand({
            id: 'open-kanban-view',
            name: 'Open TPS Kanban',
            callback: async () => {
                const leaf = this.app.workspace.getRightLeaf(false) || this.app.workspace.getLeaf(true);
                await leaf.setViewState({ type: KanbanView_1.KANBAN_VIEW_TYPE });
                this.app.workspace.revealLeaf(leaf);
            },
        });
        this.addSettingTab(new SettingsTab_1.KanbanSettingTab(this.app, this));
        // Try to register a minimal GCM provider if available (best-effort)
        try {
            const internal = this.app.internalPlugins;
            const gcm = ((_a = internal === null || internal === void 0 ? void 0 : internal.getPluginById) === null || _a === void 0 ? void 0 : _a.call(internal, 'tps-global-context-menu')) || ((_c = (_b = this.app.plugins) === null || _b === void 0 ? void 0 : _b.getPlugin) === null || _c === void 0 ? void 0 : _c.call(_b, 'tps-global-context-menu'));
            const provider = {
                id: 'tps-kanban',
                label: 'Kanban card actions',
                produceMenu: (context) => {
                    // Minimal: return an array of actions if context.cardId exists
                    if (context === null || context === void 0 ? void 0 : context.cardId)
                        return [{ id: 'open-card', label: 'Open card' }];
                    return [];
                }
            };
            if (gcm && typeof (gcm.registerContextProvider) === 'function') {
                gcm.registerContextProvider(provider);
            }
            else if (gcm && gcm.api && typeof gcm.api.registerContextProvider === 'function') {
                gcm.api.registerContextProvider(provider);
            }
        }
        catch { /* ignore if GCM not present */ }
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }
    onunload() {
        console.log('Unloading TPS Kanban (Dev)');
    }
}
exports.default = TPSKanbanPlugin;
