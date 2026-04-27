export type TPSSettingsCategory = "Features" | "Automation" | "Rules" | "Appearance" | "UI Display" | "Maintenance" | "Interaction";

export function createTPSMainCategory(containerEl: HTMLElement, title: TPSSettingsCategory, defaultOpen = true): HTMLElement {
    const details = containerEl.createEl('details', { cls: 'tps-settings-main-category' });
    if (defaultOpen) details.setAttr('open', 'true');
    const summary = details.createEl('summary', { cls: 'tps-settings-main-summary' });
    summary.createEl('h3', { text: title });
    return details.createDiv({ cls: 'tps-settings-main-content' });
}

export function createTPSCollapsibleSection(
    parent: HTMLElement,
    title: string,
    description?: string,
    defaultOpen = false
): HTMLElement {
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
}
