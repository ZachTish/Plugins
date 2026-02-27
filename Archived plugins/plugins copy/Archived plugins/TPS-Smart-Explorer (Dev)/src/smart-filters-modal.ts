
import { Modal, Setting, Notice, App } from "obsidian";
import * as logger from "./logger";
import { FilterEditModal } from "./filter-edit-modal";

export class SmartFiltersModal extends Modal {
    plugin: any;
    constructor(e: App, t: any) {
        super(e);
        this.plugin = t;
    }
    onOpen() {
        (this.titleEl.setText("Manage Smart Filters"), this.render());
    }
    render() {
        let { contentEl: e } = this;
        e.empty();
        let t = Array.isArray(this.plugin.settings.filters)
            ? this.plugin.settings.filters
            : [],
            { Notice: n } = require("obsidian"),
            r = () =>
                Array.isArray(this.plugin.settings.filters)
                    ? [...this.plugin.settings.filters]
                    : [],
            a = async (c: any) => {
                try {
                    ((this.plugin.settings.filters = c),
                        await this.plugin.saveSettings(),
                        this.plugin.refreshAllExplorer2(),
                        this.render());
                } catch (i) {
                    (logger.error("Explorer 2: failed to save filters", i),
                        new n("Unable to save filters"));
                }
            },
            s = (c: any, i: any) => {
                if (c === i) return;
                let f = r();
                if (c < 0 || i < 0 || c >= f.length || i >= f.length) return;
                let [h] = f.splice(c, 1);
                (f.splice(i, 0, h), a(f));
            },
            l = (c: any) => {
                let i = r(),
                    f = i.indexOf(c);
                if (f === -1) return;
                let h = JSON.parse(JSON.stringify(c));
                h.id = FilterEditModal.createFilterId();
                let b = (c.name && c.name.trim()) || `Filter ${f + 1}`,
                    F = new Set(i.map((w: any) => (w?.name || "").toLowerCase())),
                    d = `${b} copy`,
                    m = 2;
                for (; F.has(d.toLowerCase());) ((d = `${b} copy ${m}`), (m += 1));
                ((h.name = d), i.splice(f + 1, 0, h), a(i));
            };
        (e.createEl("p", {
            text: "Filters appear as folders in Explorer 2. Build rules with groups to target the notes you want. Use duplicate or move buttons to reorder them.",
        }),
            t.length || e.createEl("p", { text: "No filters configured yet." }),
            t.forEach((c: any, i: number) => {
                let f = e.createDiv({ cls: "explorer2-filter-card" });
                (f.createEl("h4", { text: c.name || `Filter ${i + 1}` }),
                    f
                        .createEl("div", { cls: "explorer2-filter-meta" })
                        .setText(
                            `Match: ${(c.match || "all").toUpperCase()} \u2022 Icon: ${c.icon || "filter"}`,
                        ));
                let b = f.createDiv({ cls: "explorer2-filter-buttons" }),
                    F = b.createEl("button", { cls: "mod-cta" });
                (F.setText("Edit"),
                    F.addEventListener("click", () => {
                        new FilterEditModal(this.app, this.plugin, c, (x: any) => {
                            let T = r(),
                                L = T.indexOf(c);
                            L !== -1 && ((T[L] = x), a(T));
                        }).open();
                    }));
                let d = b.createEl("button", { cls: "mod-ghost" });
                (d.setText("Duplicate"), d.addEventListener("click", () => l(c)));
                let m = b.createEl("button", { cls: "mod-ghost" });
                (m.setText("Move up"),
                    (m.disabled = i === 0),
                    m.addEventListener("click", () => {
                        i !== 0 && s(i, i - 1);
                    }));
                let w = b.createEl("button", { cls: "mod-ghost" });
                (w.setText("Move down"),
                    (w.disabled = i === t.length - 1),
                    w.addEventListener("click", () => {
                        i !== t.length - 1 && s(i, i + 1);
                    }));
                let g = b.createEl("button", { cls: "explorer2-danger" });
                (g.setText("Delete"),
                    g.addEventListener("click", () => {
                        if (!confirm(`Delete filter "${c.name || `Filter ${i + 1}`}"?`))
                            return;
                        let x = r(),
                            T = x.indexOf(c);
                        T !== -1 && (x.splice(T, 1), a(x));
                    }));
            }));
        let o = e.createEl("button", { cls: "mod-cta" });
        (o.setText("Add filter"),
            (o.style.marginTop = "12px"),
            o.addEventListener("click", () => {
                new FilterEditModal(this.app, this.plugin, null, (c: any) => {
                    let i = r();
                    (i.push(c), a(i));
                }).open();
            }));
    }
}
