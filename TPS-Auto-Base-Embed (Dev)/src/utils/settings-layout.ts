export function createTPSSettingsGroup(
  parent: HTMLElement,
  title: string,
  description?: string,
): HTMLElement {
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
}