export const MOBILE_AND_SUBITEMS_STYLES = `
        display: none !important;
      }

      /* Subitems Panel Styles */
      .tps-gcm-subitems-panel {
        position: relative !important; /* Force containing block */
        background: var(--background-secondary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 12px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        z-index: 100001;
        overflow: hidden; 
        display: flex;
        flex-direction: column;
        transition: all 0.2s ease;
      }

      .tps-gcm-subitems-panel--collapsed {
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
        height: auto !important;
        min-height: 0 !important;
        overflow: visible !important;
        padding: 0 !important;
        pointer-events: none;
      }

      .tps-gcm-subitems-panel--collapsed > * {
        display: none !important;
      }
      
      .tps-gcm-subitems-panel--collapsed .tps-gcm-collapse-overlay-btn-v2 {
        display: none !important;
      }

      .tps-gcm-subitems-panel--collapsed > .tps-gcm-expand-handle {
        display: flex !important;
        pointer-events: auto;
      }

      .tps-gcm-collapse-overlay-btn-v2 {
        position: absolute !important;
        top: 4px !important;
        left: 50% !important;
        right: auto !important;
        transform: translateX(-50%) !important;
        width: 32px !important;
        height: 20px !important;
        background: var(--background-secondary-alt); 
        border: 1px solid var(--background-modifier-border);
        border-radius: 8px !important; /* Squircle */
        display: flex !important;
        justify-content: center;
        align-items: center;
        cursor: pointer;
        color: var(--text-muted);
        opacity: 0; /* Hidden until hover */
        transition: opacity 0.2s, background-color 0.2s;
        z-index: 99999 !important;
      }

      /* Show handle when hovering panel or the handle itself */
      .tps-gcm-subitems-panel:hover .tps-gcm-collapse-overlay-btn-v2,
      .tps-gcm-collapse-overlay-btn-v2:hover {
        opacity: 1 !important;
      }

      .tps-gcm-collapse-overlay-btn-v2:hover {
        background-color: var(--background-modifier-hover);
        color: var(--text-normal);
      }

      .tps-gcm-expand-handle {
        display: none; /* Hidden when not collapsed */
        justify-content: center;
        align-items: center;
        gap: 6px;
        min-width: 32px;
        height: 22px;
        padding: 0 8px;
        background: var(--background-secondary);
        border: 1px solid var(--background-modifier-border);
        border-radius: 8px; /* Squircle matching collapse */
        margin: 0 auto;
        cursor: pointer;
        color: var(--text-muted);
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        z-index: 100002;
      }
      .tps-gcm-expand-handle:hover {
        color: var(--text-normal);
        background: var(--background-modifier-hover);
      }

      .tps-gcm-expand-count {
        font-size: 11px;
        font-weight: 600;
        line-height: 1;
        white-space: nowrap;
        color: var(--text-muted);
      }

      .tps-gcm-expand-handle:hover .tps-gcm-expand-count {
        color: var(--text-normal);
      }

      .tps-gcm-subitems-panel--live {
        position: fixed !important; 
        /* Left/Bottom set by JS */
      }

      .tps-gcm-subitems-panel--hidden {
        display: none !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }

      /* Parent Navigation Button - Prominent Style */
      .tps-gcm-parent-nav-button {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        background-color: var(--interactive-accent);
        color: var(--text-on-accent);
        border: 1px solid var(--interactive-accent);
        border-radius: 999px;
        font-size: calc(12px * var(--tps-gcm-text-scale));
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.1s ease, background-color 0.1s, box-shadow 0.1s;
        margin-left: 8px; /* Spacing from title/other elements */
      }
      .tps-gcm-parent-nav-button:hover {
        background-color: var(--interactive-accent-hover);
        transform: translateY(-1px);
        box-shadow: 0 2px 5px rgba(0,0,0,0.2);
        color: var(--text-on-accent);
      }
      .tps-gcm-parent-nav-button svg {
        width: 14px;
        height: 14px;
        stroke-width: 2.5px;
      }

      .tps-gcm-top-parent-nav {
        margin-bottom: 12px;
        display: flex;
        justify-content: flex-start;
        user-select: none;
      }
      .tps-gcm-parent-nav-button--top {
        margin-left: 0 !important;
      }

      /* Plus Buttons - Neutral Style */
      .tps-gcm-subitems-header-btn {
        color: var(--text-muted);
        background: transparent;
      }
      .tps-gcm-subitems-header-btn:hover {
        color: var(--text-normal);
        background: var(--background-modifier-hover);
      }

      /* Direction sections */
      .tps-gcm-bl-direction {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .tps-gcm-bl-direction + .tps-gcm-bl-direction {
        margin-top: 6px;
        padding-top: 6px;
        border-top: 1px dashed var(--background-modifier-border);
      }

      .tps-gcm-bl-direction-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 0;
      }

      .tps-gcm-bl-section-header {
        cursor: pointer;
        user-select: none;
        border-radius: 4px;
        padding: 3px 4px;
        margin: 0 -4px;
        transition: background-color 0.1s;
      }
      .tps-gcm-bl-section-header:hover {
        background: color-mix(in srgb, var(--background-modifier-hover) 60%, transparent);
      }

      .tps-gcm-bl-direction-title {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-faint);
      }

      .tps-gcm-bl-direction-count {
        font-size: 10px;
        font-weight: 600;
        color: var(--text-muted);
      }

      /* Group card */
      .tps-gcm-bl-group {
        display: flex;
        flex-direction: column;
        border-radius: 6px;
        background: color-mix(in srgb, var(--background-secondary) 50%, transparent);
        border: 1px solid color-mix(in srgb, var(--background-modifier-border) 60%, transparent);
        overflow: hidden;
      }

      .tps-gcm-bl-group-header {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 3px 6px;
        min-width: 0;
      }

      .tps-gcm-bl-chevron {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        flex: 0 0 16px;
        color: var(--text-muted);
        cursor: pointer;
      }

      .tps-gcm-bl-chevron svg {
        width: 14px;
        height: 14px;
      }

      .tps-gcm-bl-group-title {
        color: var(--text-muted);
        font-size: 10px;
        font-weight: 600;
        line-height: 1.3;
        cursor: pointer;
        padding: 0;
        margin: 0;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1 1 auto;
        text-decoration: none;
      }

      .tps-gcm-bl-group-title:hover {
        color: var(--text-accent);
        text-decoration: underline;
      }

      .tps-gcm-bl-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 700;
        color: var(--text-accent);
        background: color-mix(in srgb, var(--interactive-accent) 16%, transparent);
        flex: 0 0 auto;
      }

      .tps-gcm-bl-open-btn {
        appearance: none;
        -webkit-appearance: none;
        border: 0;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        padding: 2px;
        border-radius: 4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
      }

      .tps-gcm-bl-open-btn svg {
        width: 14px;
        height: 14px;
      }

      .tps-gcm-bl-open-btn:hover {
        color: var(--text-accent);
        background: var(--background-modifier-hover);
      }

      /* Occurrences list */
      .tps-gcm-bl-occurrences {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 0 6px 6px 6px;
      }

      .tps-gcm-bl-occurrence {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 4px 6px;
        border-radius: 5px;
        background: color-mix(in srgb, var(--background-primary) 80%, transparent);
      }

      .tps-gcm-bl-occurrence-meta {
        font-size: 9px;
        color: var(--text-faint);
        line-height: 1.2;
      }

      .tps-gcm-bl-occurrence-preview {
        font-size: var(--font-ui-small);
        color: var(--text-normal);
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .tps-gcm-bl-occurrence-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-wrap: wrap;
      }

      .tps-gcm-bl-action {
        border: 1px solid var(--background-modifier-border);
        border-radius: 999px;
        background: var(--background-modifier-form-field);
        color: var(--text-normal);
        font-size: 10px;
        line-height: 1.25;
        font-weight: 600;
        padding: 2px 7px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }

      .tps-gcm-bl-action:hover {
        border-color: var(--interactive-accent);
        background: color-mix(in srgb, var(--background-modifier-hover), var(--background-primary));
      }

      /* Frontmatter-key sections (direction-level) */
      .tps-gcm-bl-fm-section {
        padding: 4px 6px 4px 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .tps-gcm-bl-fm-section-key {
        font-size: 9px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-faint);
        padding: 0 2px;
      }

      .tps-gcm-bl-fm-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .tps-gcm-bl-fm-chip {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-modifier-form-field);
        font-size: var(--font-ui-small);
        color: var(--text-muted);
        cursor: pointer;
        text-decoration: none;
        transition: border-color 80ms, color 80ms;
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tps-gcm-bl-fm-chip:hover {
        border-color: var(--interactive-accent);
        color: var(--text-accent);
      }

      /* Highlighted link / mention text in preview */
      .tps-gcm-bl-highlight {
        background: color-mix(in srgb, var(--text-accent) 18%, transparent);
        color: var(--text-accent);
        border-radius: 2px;
        padding: 0 1px;
      }

      /* Children / Attachments file list */
      .tps-gcm-bl-file-list {
        display: flex;
        flex-direction: column;
        gap: 1px;
        padding: 0 4px 4px;
      }

      .tps-gcm-bl-file-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 6px;
        border-radius: 4px;
      }

      .tps-gcm-bl-file-row:hover {
        background: var(--background-modifier-hover);
      }

      .tps-gcm-bl-file-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 14px;
        color: var(--text-muted);
      }

      .tps-gcm-bl-file-icon svg {
        width: 14px;
        height: 14px;
      }

      .tps-gcm-bl-file-name {
        appearance: none;
        -webkit-appearance: none;
        border: 0;
        background: transparent;
        color: var(--text-normal);
        font-size: var(--font-ui-small);
        cursor: pointer;
        padding: 0;
        margin: 0;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
        line-height: 1.4;
      }

      .tps-gcm-bl-file-name:hover {
        color: var(--text-accent);
      }

      .tps-gcm-rule-builder-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin: 10px 0 14px;
      }

      .tps-gcm-rule-builder-filter {
        flex: 1 1 240px;
        min-width: 220px;
      }

      .tps-gcm-rule-builder-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .tps-gcm-settings-block {
        margin: 12px 0 16px;
        padding: 14px;
        border-radius: 12px;
        border: 1px solid color-mix(in srgb, var(--background-modifier-border) 75%, transparent);
        background: color-mix(in srgb, var(--background-secondary) 45%, transparent);
      }

      .tps-gcm-settings-block > h4 {
        margin: 0 0 6px;
      }

      .tps-gcm-rule-chip {
        min-width: 28px;
        height: 28px;
        padding: 0 8px;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        font-size: 12px;
        font-weight: 700;
        color: var(--text-muted);
      }

      .tps-gcm-rule-card {
        border: 1px solid var(--background-modifier-border);
        border-radius: 10px;
        background: color-mix(in srgb, var(--background-secondary) 55%, transparent);
        overflow: hidden;
      }

      .tps-gcm-rule-card-summary {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        cursor: pointer;
      }

      .tps-gcm-rule-card-summary-icon,
      .tps-gcm-output-preview-icon {
        width: 28px;
        height: 28px;
        border-radius: 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        flex: 0 0 28px;
      }

      .tps-gcm-rule-card-summary-icon svg,
      .tps-gcm-output-preview-icon svg,
      .tps-gcm-icon-picker-item-icon svg {
        width: 16px;
        height: 16px;
      }

      .tps-gcm-rule-card-summary-text {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .tps-gcm-rule-card-summary-title {
        font-weight: 600;
      }

      .tps-gcm-rule-card-summary-meta,
      .tps-gcm-rule-card-preview {
        color: var(--text-muted);
        font-size: var(--font-ui-small);
      }

      .tps-gcm-rule-card-body {
        padding: 0 14px 14px;
      }

      .tps-gcm-rule-card-section {
        margin-top: 14px;
        padding: 12px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--background-primary) 78%, transparent);
        border: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
      }

      .tps-gcm-rule-card-section h5 {
        margin: 0 0 10px;
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-faint);
      }

      .tps-gcm-condition-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-bottom: 10px;
      }

      .tps-gcm-condition-row {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 8px;
        padding: 10px;
        border-radius: 10px;
        background: var(--background-primary);
        border: 1px solid var(--background-modifier-border);
      }

      .tps-gcm-output-preview {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
      }

      .tps-gcm-output-preview-text {
        color: var(--text-muted);
        font-size: var(--font-ui-small);
      }

      .tps-gcm-quick-icon-row,
      .tps-gcm-color-swatch-row,
      .tps-gcm-rule-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 10px;
      }

      .tps-gcm-quick-icon-btn,
      .tps-gcm-color-swatch,
      .tps-gcm-rule-action-btn {
        border: 1px solid var(--background-modifier-border);
        border-radius: 8px;
        background: var(--background-primary);
      }

      .tps-gcm-quick-icon-btn {
        width: 34px;
        height: 34px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }

      .tps-gcm-quick-icon-btn.is-active,
      .tps-gcm-color-swatch.is-active,
      .tps-gcm-icon-picker-item.is-active {
        border-color: var(--interactive-accent);
        box-shadow: 0 0 0 1px color-mix(in srgb, var(--interactive-accent) 45%, transparent);
      }

      .tps-gcm-color-swatch {
        width: 28px;
        height: 28px;
        cursor: pointer;
        overflow: hidden;
      }

      .tps-gcm-color-swatch.is-empty {
        width: auto;
        padding: 0 8px;
        font-size: 11px;
        color: var(--text-muted);
      }

      .tps-gcm-criteria-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .tps-gcm-criterion-card {
        padding: 10px;
        border-radius: 10px;
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
      }

      .tps-gcm-criterion-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--text-muted);
        margin-bottom: 8px;
      }

      .tps-gcm-icon-picker-modal .modal-content {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .tps-gcm-icon-picker-search {
        width: 100%;
      }

      .tps-gcm-icon-picker-current {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--text-muted);
        font-size: var(--font-ui-small);
      }

      .tps-gcm-icon-picker-current-preview,
      .tps-gcm-icon-picker-item-icon {
        width: 20px;
        height: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .tps-gcm-icon-picker-grid {
        max-height: 420px;
        overflow: auto;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 8px;
      }

      .tps-gcm-icon-picker-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 10px 12px;
        border: 1px solid var(--background-modifier-border);
        border-radius: 10px;
        background: var(--background-primary);
        text-align: left;
        cursor: pointer;
      }

      .tps-gcm-icon-picker-item-label {
        font-size: var(--font-ui-small);
        color: var(--text-normal);
        word-break: break-word;
      }

      @media (max-width: 900px) {
        .tps-gcm-condition-row {
          grid-template-columns: 1fr 1fr;
        }
      }

      @media (max-width: 640px) {
        .tps-gcm-condition-row {
          grid-template-columns: 1fr;
        }

        .tps-gcm-icon-picker-grid {
          grid-template-columns: 1fr;
        }
      }

      /* ── Dataview inline-field: hide all by default, show via JS ── */
      .dataview.inline-field {
        display: none !important;
      }
      .dataview.inline-field[data-tps-visible="true"] {
        display: inline !important;
      }
      .dataview.inline-field[data-tps-visible="true"] .dataview.inline-field-key {
        display: none !important;
      }
      .dataview.inline-field[data-tps-visible="true"] .dataview.inline-field-value {
        display: inline-flex !important;
        align-items: center !important;
        padding: 2px 8px !important;
        border-radius: 12px !important;
        background: color-mix(in srgb, var(--background-modifier-form-field) 60%, transparent) !important;
        border: 1px solid var(--background-modifier-border) !important;
        font-family: inherit !important;
        font-size: calc(var(--font-text-size) * 0.85) !important;
        font-weight: 500 !important;
        color: var(--text-normal) !important;
        vertical-align: middle !important;
        cursor: pointer !important;
        transition: all 0.15s ease !important;
      }
      .dataview.inline-field[data-tps-visible="true"] .dataview.inline-field-value:hover {
        border-color: var(--interactive-accent) !important;
        background: var(--background-modifier-hover) !important;
      }

    
`;
