import { App, Menu } from "obsidian";
import TPSGlobalContextMenuPlugin from "./main";
import { normalizeTagValue, parseTagInput } from './tag-utils';

type Delegates = {
  addSafeClickListener: (element: HTMLElement, handler: (e: MouseEvent) => void) => void;
  showMenuAtAnchor: (menu: Menu, anchor: HTMLElement | MouseEvent | KeyboardEvent) => void;
  openAddTagModal: (entries: any[], key?: string) => void;
  openScheduledModal: (entries: any[], key?: string) => void;
  openRecurrenceModalNative: (entries: any[]) => void;
  moveFiles: (entries: any[], folderPath: string) => Promise<void>;
  getTypeFolderOptions: () => { path: string; label: string }[];
  getRecurrenceValue: (fm: any) => string;
  formatDatetimeDisplay: (value: string | null | undefined) => string;
  hashStringToHue: (str: string) => number;
};

export class PropertyRowService {
  constructor(
    private app: App,
    private plugin: TPSGlobalContextMenuPlugin,
    private d: Delegates
  ) { }

  private getValueCaseInsensitive(frontmatter: any, key: string): any {
    if (!frontmatter || !key) return undefined;
    if (key in frontmatter) return frontmatter[key];
    const lowerKey = key.toLowerCase();
    const match = Object.keys(frontmatter).find(k => k.toLowerCase() === lowerKey);
    return match ? frontmatter[match] : undefined;
  }

  createSelectorRow(entries: any[], prop: any): HTMLElement {
    const row = document.createElement("div");
    row.className = "tps-gcm-row";
    const label = document.createElement("label");
    label.textContent = prop.label;

    const valueEl = document.createElement("div");
    valueEl.className = "tps-gcm-value tps-gcm-input-button";

    const updateDisplay = () => {
      const allValues = entries.map((e: any) => this.getValueCaseInsensitive(e.frontmatter, prop.key) || "");
      const uniqueValues = new Set(allValues);
      const current = uniqueValues.size === 1 ? allValues[0] : "Mixed";
      const isUndefined = entries.every((e: any) => !this.plugin.fieldInitializationService.isFieldDefinedForEntries([e], prop.key));

      valueEl.textContent = current || "Select...";
      if (isUndefined) {
        valueEl.style.color = "var(--text-muted)";
        valueEl.style.fontStyle = "italic";
      } else {
        valueEl.style.color = "";
        valueEl.style.fontStyle = "";
      }
    };

    updateDisplay();

    this.d.addSafeClickListener(valueEl, async (e) => {
      // Check if field needs initialization
      const defaultValue = (prop.options && prop.options[0]) || "";
      if (await this.plugin.fieldInitializationService.checkAndInitialize(entries, prop.key, defaultValue)) {
        updateDisplay();
        return; // Skip opening menu on first click
      }

      const allValues = entries.map((e: any) => this.getValueCaseInsensitive(e.frontmatter, prop.key) || "");
      const uniqueValues = new Set(allValues);
      const current = uniqueValues.size === 1 ? allValues[0] : "Mixed";

      const menu = new Menu();
      (prop.options || []).forEach((opt: string) => {
        menu.addItem((item) => {
          item
            .setTitle(opt)
            .setChecked(current === opt)
            .onClick(async () => {
              await this.plugin.bulkEditService.updateFrontmatter(
                entries.map((entry: any) => entry.file),
                { [prop.key]: opt }
              );
              updateDisplay();
            });
        });
      });
      this.d.showMenuAtAnchor(menu, e);
    });
    valueEl.addEventListener("mousedown", (e) => e.stopPropagation());

    row.appendChild(label);
    row.appendChild(valueEl);
    return row;
  }

  createListRow(entries: any[], prop: any): HTMLElement {
    const row = document.createElement("div");
    row.className = "tps-gcm-row tps-gcm-tags-row";
    const label = document.createElement("label");
    label.textContent = prop.label;

    const container = document.createElement("div");
    container.className = "tps-gcm-tags-container tps-gcm-tags-inline";

    const refreshTags = () => {
      container.innerHTML = "";
      const freshFm = this.app.metadataCache.getFileCache(entries[0].file)?.frontmatter || {};
      const rawTags = this.getValueCaseInsensitive(freshFm, prop.key);
      const tagList = parseTagInput(rawTags);
      const isUndefined = entries.every((e: any) => !this.plugin.fieldInitializationService.isFieldDefinedForEntries([e], prop.key));

      const normalizedMap = new Map<string, string>();
      for (const tag of tagList) {
        const normalized = normalizeTagValue(tag);
        if (!normalized) continue;
        if (!normalizedMap.has(normalized)) normalizedMap.set(normalized, `#${normalized}`);
      }

      Array.from(normalizedMap.values()).forEach((tag: string) => {
        const tagEl = document.createElement("span");
        tagEl.className = "tps-gcm-tag tps-gcm-tag-removable";

        const tagText = document.createElement("span");
        tagText.className = "tps-gcm-tag-text";
        tagText.textContent = tag;
        tagEl.appendChild(tagText);

        const removeBtn = document.createElement("button");
        removeBtn.className = "tps-gcm-tag-remove";
        removeBtn.innerHTML = "×";
        removeBtn.title = `Remove ${tag}`;
        this.d.addSafeClickListener(removeBtn, async (e) => {
          e.stopPropagation();
          await this.plugin.bulkEditService.removeTag(
            entries.map((entry: any) => entry.file),
            tag,
            prop.key
          );
          refreshTags();
        });
        tagEl.appendChild(removeBtn);

        const hue = this.d.hashStringToHue(tag);
        tagEl.style.backgroundColor = `hsla(${hue}, 40%, 20%, 0.4)`;
        tagEl.style.color = `hsl(${hue}, 60%, 85%)`;
        tagEl.style.border = `1px solid hsla(${hue}, 40%, 30%, 0.5)`;

        container.appendChild(tagEl);
      });

      const addBtn = document.createElement("button");
      addBtn.innerHTML = "+";
      addBtn.className = "tps-gcm-tag-add";
      if (isUndefined) {
        addBtn.style.fontStyle = "italic";
        addBtn.title = "Create field and add tag";
      } else {
        addBtn.style.fontStyle = "";
        addBtn.title = "Add tag";
      }
      this.d.addSafeClickListener(addBtn, async () => {
        // Check if field needs initialization
        if (await this.plugin.fieldInitializationService.checkAndInitialize(entries, prop.key, [])) {
          refreshTags();
          return; // Skip opening modal on first click
        }
        this.d.openAddTagModal(entries, prop.key);
      });
      addBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      container.appendChild(addBtn);
    };

    refreshTags();
    row.appendChild(label);
    row.appendChild(container);
    return row;
  }

  createDatetimeRow(entries: any[], prop: any): HTMLElement {
    const row = document.createElement("div");
    row.className = "tps-gcm-row";
    const label = document.createElement("label");
    label.textContent = prop.label;

    const valueEl = document.createElement("div");
    valueEl.className = "tps-gcm-value tps-gcm-input-button";

    const updateDisplay = () => {
      const rawValue = entries[0].frontmatter[prop.key];
      const formatted = this.d.formatDatetimeDisplay(rawValue);
      const isUndefined = entries.every((e: any) => !this.plugin.fieldInitializationService.isFieldDefinedForEntries([e], prop.key));

      if (formatted) {
        valueEl.textContent = formatted;
        valueEl.style.color = "";
        valueEl.style.fontStyle = "";
      } else {
        valueEl.textContent = isUndefined ? "Create field..." : "Set date...";
        valueEl.style.color = "var(--text-muted)";
        valueEl.style.fontStyle = isUndefined ? "italic" : "";
      }
    };

    updateDisplay();

    this.d.addSafeClickListener(valueEl, async () => {
      // Check if field needs initialization
      if (await this.plugin.fieldInitializationService.checkAndInitialize(entries, prop.key, "")) {
        updateDisplay();
        return; // Skip opening modal on first click
      }

      this.d.openScheduledModal(entries, prop.key);
    });
    valueEl.addEventListener("mousedown", (e) => e.stopPropagation());
    row.appendChild(label);
    row.appendChild(valueEl);
    return row;
  }

  createTextRow(entries: any[], prop: any): HTMLElement {
    const row = document.createElement("div");
    row.className = "tps-gcm-row";
    const label = document.createElement("label");
    label.textContent = prop.label;

    const input = document.createElement("input");
    input.type = "text";
    input.value = entries[0].frontmatter[prop.key] || "";
    input.placeholder = "Empty";
    input.addEventListener("change", async () => {
      await this.plugin.bulkEditService.updateFrontmatter(
        entries.map((entry: any) => entry.file),
        { [prop.key]: input.value }
      );
    });
    this.d.addSafeClickListener(input, (e) => e.stopPropagation());
    input.addEventListener("mousedown", (e) => e.stopPropagation());

    row.appendChild(label);
    row.appendChild(input);
    return row;
  }

  createNumberRow(entries: any[], prop: any): HTMLElement {
    const row = document.createElement("div");
    row.className = "tps-gcm-row";
    const label = document.createElement("label");
    label.textContent = prop.label;

    const input = document.createElement("input");
    input.type = "number";
    input.value = entries[0].frontmatter[prop.key] || "";
    input.addEventListener("change", async () => {
      const val = input.value ? Number(input.value) : null;
      await this.plugin.bulkEditService.updateFrontmatter(
        entries.map((entry: any) => entry.file),
        { [prop.key]: val }
      );
    });
    this.d.addSafeClickListener(input, (e) => e.stopPropagation());
    input.addEventListener("mousedown", (e) => e.stopPropagation());

    row.appendChild(label);
    row.appendChild(input);
    return row;
  }

  createRecurrenceRow(entries: any[], prop?: any): HTMLElement {
    const row = document.createElement("div");
    row.className = "tps-gcm-row";
    const label = document.createElement("label");
    label.textContent = prop ? prop.label : "Recurrence";

    const valueEl = document.createElement("div");
    valueEl.className = "tps-gcm-value tps-gcm-input-button";
    const rule = this.d.getRecurrenceValue(entries[0].frontmatter);
    valueEl.textContent = rule || "Set recurrence...";
    if (!rule) valueEl.style.color = "var(--text-muted)";

    this.d.addSafeClickListener(valueEl, () => this.d.openRecurrenceModalNative(entries));
    valueEl.addEventListener("mousedown", (e) => e.stopPropagation());

    row.appendChild(label);
    row.appendChild(valueEl);
    return row;
  }

  createTypeRow(entries: any[], prop?: any): HTMLElement {
    const row = document.createElement("div");
    row.className = "tps-gcm-row";
    const label = document.createElement("label");
    label.textContent = prop ? prop.label : "Type";

    const select = document.createElement("select");
    select.className = "tps-gcm-value tps-gcm-input-select";
    const currentPath = entries[0].file.parent?.path || "/";

    const options = this.d.getTypeFolderOptions();
    for (const { path, label: optionLabel } of options) {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = optionLabel;
      select.appendChild(option);
    }
    select.value = currentPath;
    select.addEventListener("change", async () => this.d.moveFiles(entries, select.value));
    select.addEventListener("mousedown", (e) => e.stopPropagation());

    row.appendChild(label);
    row.appendChild(select);
    return row;
  }

  /**
   * Opens a submenu for status selection (used by chips)
   */
  openStatusSubmenu(anchor: HTMLElement, entries: any[], onUpdate?: (newVal: string) => void, overrideOptions?: string[], onAfterUpdate?: (files: any[]) => Promise<void>): void {
    const menu = new Menu();
    const fm = entries[0].frontmatter;
    const currentStatus = typeof fm.status === 'string' ? fm.status.trim() : '';

    const statuses = overrideOptions && overrideOptions.length > 0 ? overrideOptions : ['open', 'working', 'blocked', 'wont-do', 'complete'];
    statuses.forEach(status => {
      menu.addItem(item => {
        item
          .setTitle(status)
          .setChecked(currentStatus === status)
          .onClick(async () => {
            const files = entries.map((entry: any) => entry.file);
            const updatedCount = await this.plugin.bulkEditService.setStatus(files, status);
            if (updatedCount > 0) {
              entries.forEach((entry: any) => {
                if (!entry.frontmatter || typeof entry.frontmatter !== 'object') entry.frontmatter = {};
                entry.frontmatter.status = status;
              });
              if (onUpdate) onUpdate(status);
              if (onAfterUpdate) await onAfterUpdate(files);
            }
          });
      });
    });

    this.d.showMenuAtAnchor(menu, anchor);
  }

  /**
   * Opens a submenu for priority selection (used by chips)
   */
  openPrioritySubmenu(anchor: HTMLElement, entries: any[], onUpdate?: (newVal: string) => void, overrideOptions?: string[]): void {
    const menu = new Menu();
    const fm = entries[0].frontmatter;
    const currentPrio = typeof fm.priority === 'string' ? fm.priority.trim() : '';

    const priorities = overrideOptions && overrideOptions.length > 0 ? overrideOptions : ['high', 'medium', 'normal', 'low'];
    priorities.forEach(priority => {
      menu.addItem(item => {
        item
          .setTitle(priority)
          .setChecked(currentPrio === priority)
          .onClick(async () => {
            entries.forEach((entry: any) => {
              if (!entry.frontmatter || typeof entry.frontmatter !== 'object') entry.frontmatter = {};
              entry.frontmatter.priority = priority;
            });
            if (onUpdate) onUpdate(priority);
            await this.plugin.bulkEditService.updateFrontmatter(
              entries.map((entry: any) => entry.file),
              { priority }
            );
          });
      });
    });

    this.d.showMenuAtAnchor(menu, anchor);
  }

  /**
   * Opens a submenu for folder/type selection (used by chips)
   */
  openTypeSubmenu(anchor: HTMLElement, entries: any[]): void {
    const menu = new Menu();
    const currentPath = entries[0].file.parent?.path || '/';
    const options = this.d.getTypeFolderOptions();

    options.forEach(({ path, label }) => {
      menu.addItem(item => {
        item
          .setTitle(label)
          .setChecked(currentPath === path)
          .onClick(async () => {
            await this.d.moveFiles(entries, path);
          });
      });
    });

    this.d.showMenuAtAnchor(menu, anchor);
  }
}
