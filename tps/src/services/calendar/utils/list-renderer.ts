export function renderListWithControls(items: any[], _opts?: any) {
  const container = document.createElement('div');
  items.forEach(i => { const el = document.createElement('div'); el.textContent = String(i?.name ?? i); container.appendChild(el); });
  return container;
}
