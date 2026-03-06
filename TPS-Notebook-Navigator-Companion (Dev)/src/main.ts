import { Plugin, Notice } from "obsidian";
import { getPluginById } from "./core";
import { DEFAULT_SETTINGS, NotebookNavigatorCompanionSettings } from "./types";

export default class NotebookNavigatorCompanionPlugin extends Plugin {
  settings: NotebookNavigatorCompanionSettings = DEFAULT_SETTINGS;

  async onload() {
    try {
      const stored = (await this.loadData()) as Partial<NotebookNavigatorCompanionSettings> | undefined;
      if (stored) this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    } catch (e) {
      // ignore
    }

    // Minimal probe to help debug click capture from DevTools
    try {
      (window as any).__tps_nn_probe = (window as any).__tps_nn_probe || {};
      (window as any).__tps_nn_probe._enabled = false;
      (window as any).__tps_nn_probe.enableCaptureLogging = () => { (window as any).__tps_nn_probe._enabled = true; console.info('TPS-NN probe enabled'); };
      (window as any).__tps_nn_probe.disableCaptureLogging = () => { (window as any).__tps_nn_probe._enabled = false; console.info('TPS-NN probe disabled'); };
      document.addEventListener('click', (e) => {
        if (!(window as any).__tps_nn_probe._enabled) return;
        try { console.log('TPS-NN capture click', e.target); } catch (err) {}
      }, true);

      // Forwarding helper: allow other plugins (e.g., feed embeds) to call
      // `window.__tps_nn_probe.openTag(tagText)` to request opening/selecting a tag.
      (window as any).__tps_nn_probe.openTag = async (tagText: string) => {
        const tried: string[] = [];
        let handled = false;
        try {
          const nn = getPluginById(this.app, "notebook-navigator") as any;
          const callIfExists = async (host: any, name: string, arg: string) => {
            try {
              if (!host || typeof host[name] !== "function") return false;
              await host[name].call(host, arg);
              return true;
            } catch (e) {
              return false;
            }
          };

          const candidates = ["openTag", "open", "reveal", "select", "navigate", "show", "focus"];
          for (const name of candidates) {
            tried.push(name);
            if (await callIfExists(nn, name, tagText)) { handled = true; break; }
            if (await callIfExists(nn?.api, name, tagText)) { handled = true; break; }
          }

          if (!handled) {
            const hosts = [nn, nn?.api];
            const keywords = ["open", "reveal", "select", "navigate", "show", "focus", "tag", "folder"];
            for (const host of hosts) {
              if (!host || typeof host !== "object") continue;
              for (const key of Object.keys(host)) {
                try {
                  if (typeof host[key] === "function") {
                    const lower = key.toLowerCase();
                    if (keywords.some((k) => lower.includes(k))) {
                      tried.push(key);
                      try { await host[key].call(host, tagText); handled = true; break; } catch { /* continue */ }
                    }
                  }
                } catch { /* ignore */ }
              }
              if (handled) break;
            }
          }

          console.debug("TPS-NN: openTag tried", tried, { handled, plugin: nn });

          if (!handled) {
            try { (this.app.workspace as any).trigger?.("notebook-navigator:open-tag", tagText); } catch {}
            try { (this.app.workspace as any).trigger?.("tps-nn:open-tag", tagText); } catch {}
          }
        } catch (e) {
          console.error("TPS-NN openTag error", e);
        }
      };
      console.info('TPS-NN minimal probe installed — run __tps_nn_probe.enableCaptureLogging() in DevTools');
      try { new Notice('TPS-NN minimal probe installed'); } catch (e) {}
    } catch (e) {
      // ignore
    }
  }

  onunload() {
    // nothing special
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // --- Minimal stubs for API expected by settings/UI modules ---
  async applyRulesToActiveFile(_showNotice: boolean): Promise<boolean> {
    return false;
  }

  async applyRulesToAllFiles(_showNotice: boolean, _reason = "manual-all"): Promise<number> {
    return 0;
  }

  async applyRulesToFile(_file: any): Promise<void> {
    return;
  }

  getSmartSortPreviewForActiveFile(): string | null {
    return null;
  }

  createDefaultSortBucket(): any { return {}; }
  createDefaultSortSegment(): any { return {}; }
  createDefaultRule(): any { return {}; }
  createDefaultHideRule(): any {
    return { id: `hide-rule-${Date.now()}`, name: "New Hide Rule", enabled: true, match: "all", conditions: [], mode: "add", tagName: "hide" };
  }

  getRuleMatchForActiveFile(_rule: any): boolean | null { return null; }

}

