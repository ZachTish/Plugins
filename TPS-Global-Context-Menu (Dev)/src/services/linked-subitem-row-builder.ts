/**
 * Unified row builder for linked subitem rows.
 * Provides consistent DOM structure for both reading mode and Live Preview.
 */
import type { TFile } from 'obsidian';
import type { SubitemLineModel, PropertyPill } from './subitem-line-model';

export interface LinkedSubitemRowElements {
  /** Container element for the entire row */
  container: HTMLElement;
  /** Checkbox button element */
  checkbox: HTMLElement | null;
  /** Link text element */
  link: HTMLElement;
  /** Pills container */
  pillsContainer: HTMLElement;
}

/**
 * Build a complete linked subitem row DOM structure.
 * This is the single source of truth for row rendering in both modes.
 */
export function buildLinkedSubitemRow(
  model: SubitemLineModel,
  onCheckboxClick: (evt: MouseEvent) => void,
  onBulletClick: (evt: MouseEvent) => void,
  onLinkClick: (path: string) => void,
  onPillClick: (evt: MouseEvent, pill: PropertyPill) => void,
  options?: { includeCheckbox?: boolean; includeBulletMarker?: boolean },
): LinkedSubitemRowElements {
  const displayLabel = String(model.displayLabel || model.childFile.basename || model.childFile.name || '').trim()
    || model.childFile.basename;
  console.debug('[TPS GCM] [DIAG] buildLinkedSubitemRow start', {
    childFile: model.childFile.path,
    parentFile: model.parentFile.path,
    kind: model.kind,
    checkboxState: model.checkboxState,
    visualState: model.visualState,
    modelPillCount: model.pills.length,
    modelPills: model.pills.map((pill) => ({ kind: pill.kind, label: pill.label, value: pill.value })),
  });

  // Container for the entire row content
  const container = document.createElement('span');
  container.className = 'tps-gcm-linked-subitem-row tps-gcm-linked-subitem-row-content';
  container.dataset.linkedSubitemPath = model.childFile.path;
  container.dataset.linkedSubitemParent = model.parentFile.path;
  container.dataset.linkedSubitemKind = model.kind;
  container.dataset.linkedSubitemLabel = displayLabel;

  const includeCheckbox = options?.includeCheckbox === true;
  const includeBulletMarker = options?.includeBulletMarker === true;

  if (includeBulletMarker) {
    container.classList.add('has-leading-bullet');
    const bullet = document.createElement('span');
    bullet.className = 'tps-gcm-linked-subitem-bullet-marker';
    bullet.setAttribute('aria-hidden', 'true');
    bullet.dataset.linkedSubitemPath = model.childFile.path;
    bullet.dataset.linkedSubitemParent = model.parentFile.path;
    bullet.textContent = '•';
    bullet.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
    });
    bullet.addEventListener('click', onBulletClick);
    container.appendChild(bullet);
  }
  if (includeCheckbox) {
    container.classList.add('has-leading-control');
  }
  let checkbox: HTMLElement | null = null;
  if (includeCheckbox) {
    const checkboxInput = document.createElement('input');
    checkboxInput.type = 'checkbox';
    checkboxInput.tabIndex = -1;
    checkboxInput.className = `tps-gcm-linked-subitem-checkbox state-${model.visualState}`;
    if (model.kind !== 'checkbox' && model.kind !== 'heading' && !model.hasExplicitStatus) {
      checkboxInput.classList.add('is-bullet');
    }
    if (model.kind === 'heading') {
      checkboxInput.classList.add('is-heading');
    }
    const state = model.checkboxState || '[ ]';
    checkboxInput.setAttribute('aria-label', 'Toggle linked subitem status');
    checkboxInput.dataset.linkedSubitemPath = model.childFile.path;
    checkboxInput.dataset.linkedSubitemParent = model.parentFile.path;
    checkboxInput.dataset.linkedSubitemState = state;
    checkboxInput.checked = /[xX]/.test(state);
    checkboxInput.indeterminate = state.includes('?') || state.includes('-') || state.includes('/');
    checkboxInput.addEventListener('mousedown', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
    });
    checkboxInput.addEventListener('touchstart', (evt) => {
      evt.stopPropagation();
    }, { passive: true });
    checkboxInput.addEventListener('click', onCheckboxClick);
    container.appendChild(checkboxInput);
    checkbox = checkboxInput;
  }

  // Link text
  const link = document.createElement('a');
  link.className = 'internal-link tps-gcm-linked-subitem-link';
  link.textContent = displayLabel;
  link.dataset.linkedSubitemPath = model.childFile.path;
  link.setAttribute('href', model.childFile.path);
  link.setAttribute('data-href', model.childFile.path);
  link.addEventListener('mousedown', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
  });
  link.addEventListener('click', (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    onLinkClick(model.childFile.path);
  });
  container.appendChild(link);

  // Pills container
  const pillsContainer = document.createElement('span');
  pillsContainer.className = 'tps-gcm-linked-subitem-pills';
  for (const pillData of model.pills) {
    const pill = document.createElement('span');
    pill.className = `tps-gcm-linked-subitem-pill tps-gcm-linked-subitem-pill--${pillData.kind}`;
    pill.textContent = pillData.label;
    if (pillData.kind !== 'hidden') {
      pill.dataset.linkedSubitemPath = model.childFile.path;
      pill.dataset.linkedSubitemPillKind = pillData.kind;
      pill.dataset.linkedSubitemPillValue = pillData.value || pillData.label;
      if (pillData.propertyKey) pill.dataset.linkedSubitemPropertyKey = pillData.propertyKey;
      if (pillData.propertyType) pill.dataset.linkedSubitemPropertyType = pillData.propertyType;
    }
    if (pillData.textColor) pill.style.color = pillData.textColor;
    if (pillData.backgroundColor) {
      pill.style.backgroundColor = pillData.backgroundColor;
      pill.style.backgroundImage = `linear-gradient(${pillData.backgroundColor}, ${pillData.backgroundColor})`;
    }
    if (pillData.borderColor) {
      pill.style.border = `1px solid ${pillData.borderColor}`;
    }
    if (pillData.kind !== 'hidden') {
      pill.addEventListener('mousedown', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
      });
      pill.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        onPillClick(evt, pillData);
      });
    }
    pillsContainer.appendChild(pill);
  }
  container.appendChild(pillsContainer);
  container.dataset.linkedSubitemPillCount = String(model.pills.length);
  container.dataset.linkedSubitemHasCheckbox = includeCheckbox ? 'true' : 'false';

  console.debug('[TPS GCM] [DIAG] buildLinkedSubitemRow complete', {
    childFile: model.childFile.path,
    renderedPillCount: pillsContainer.children.length,
    renderedPills: Array.from(pillsContainer.children).map((pillEl) => ({
      kind: (pillEl as HTMLElement).dataset.linkedSubitemPillKind,
      value: (pillEl as HTMLElement).dataset.linkedSubitemPillValue,
      text: (pillEl as HTMLElement).textContent,
    })),
  });

  return { container, checkbox, link, pillsContainer };
}

/**
 * Get the icon name for a checkbox state.
 */
/**
 * Update checkbox DOM element to reflect new state.
 */
export function updateCheckboxState(checkbox: HTMLElement, newState: string, visualState: string): void {
  checkbox.dataset.linkedSubitemState = newState;
  checkbox.className = `tps-gcm-linked-subitem-checkbox state-${visualState}`;
  if (checkbox instanceof HTMLInputElement) {
    checkbox.checked = /[xX]/.test(newState);
    checkbox.indeterminate = newState.includes('?') || newState.includes('-') || newState.includes('\\');
  }
}
