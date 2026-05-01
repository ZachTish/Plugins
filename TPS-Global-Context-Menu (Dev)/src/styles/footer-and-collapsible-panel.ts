export const FOOTER_AND_COLLAPSIBLE_PANEL_STYLES = `
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      /* Gesture collapse behavior for subitems panel (paired with context menu). */
      .tps-gcm-subitems-panel.tps-gcm-gesture-collapsed {
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transition: opacity 0.22s ease, visibility 0.22s ease;
      }

      .cm-sizer .tps-gcm-subitems-panel {
        display: flex !important;
      }

      /* In live preview the panel is fixed-positioned above the context menu bar */
      .tps-gcm-subitems-panel--title-inline.tps-gcm-subitems-panel--live {
        position: fixed;
        z-index: 99999;
        margin-bottom: 0;
      }

      .tps-gcm-subitems-section {
        display: flex;
        flex-direction: column;
        gap: calc(4px * var(--tps-gcm-density));
        min-height: 0;
      }

      .tps-gcm-subitems-section--attachments {
        padding-top: calc(12px * var(--tps-gcm-density));
        border-top: 1px solid color-mix(in srgb, var(--background-modifier-border) 60%, transparent);
      }

      .tps-gcm-subitems-panel--title-inline {
        display: flex !important;
        flex-direction: column;
        gap: calc(6px * var(--tps-gcm-density));
        padding: calc(8px * var(--tps-gcm-density));

        border: 1px solid var(--background-modifier-border);
        border-radius: calc(10px * var(--tps-gcm-radius-scale));
        background: color-mix(in srgb, var(--background-secondary) 75%, transparent);
        min-width: 0;
        color: var(--text-normal);
        transition: opacity 0.2s ease, visibility 0.2s ease;
        opacity: 1;
        visibility: visible;
        box-sizing: border-box;
        font-size: calc(13px * var(--tps-gcm-text-scale));
        max-height: min(78vh, 920px);
        overflow: hidden;
      }

      .tps-gcm-subitems-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
      }

      .tps-gcm-subitems-title-wrap {
        display: flex;
        flex-direction: column;
        min-width: 0;
        flex: 1 1 auto;
      }

      .tps-gcm-subitems-title {
        margin: 0;
        font-size: calc(13px * var(--tps-gcm-text-scale));
        line-height: 1.3;
        font-weight: 700;
        color: #e0e0e0 !important;
      }

      .tps-gcm-subitems-subtitle {
        font-size: calc(11px * var(--tps-gcm-text-scale));
        line-height: 1.2;
        color: var(--text-muted);
        display: none;
      }

      .tps-gcm-subitems-subtitle--visible {
        display: block;
      }

      .tps-gcm-subitems-header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }

      .tps-gcm-subitems-header-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: calc(22px * var(--tps-gcm-button-scale));
        height: calc(22px * var(--tps-gcm-button-scale));
        border-radius: calc(6px * var(--tps-gcm-radius-scale));
        border: 1px solid var(--background-modifier-border);
        background: var(--background-modifier-form-field);
        color: var(--text-muted);
        cursor: pointer;
        padding: 0;
        flex-shrink: 0;
      }

      .tps-gcm-subitems-header-btn:hover {
        color: var(--text-normal);
        border-color: var(--interactive-accent);
        background: var(--background-modifier-hover);
      }

      .tps-gcm-subitems-header-btn.mod-cta {
        color: var(--text-on-accent);
        background: var(--interactive-accent);
        border-color: var(--interactive-accent);
      }

      .tps-gcm-subitems-header-btn.mod-cta:hover {
        background: var(--interactive-accent-hover);
      }

      .tps-gcm-subitems-body {
        display: flex;
        flex-direction: column;
        gap: 0;
        min-height: 0;
        transition: background 0.15s ease, outline 0.15s ease;
        border-radius: calc(8px * var(--tps-gcm-radius-scale));
        outline: 2px solid transparent;
        outline-offset: 2px;
      }

      .tps-gcm-subitems-body--children,
      .tps-gcm-subitems-body--attachments,
      .tps-gcm-subitems-body--references {
        overflow-y: auto;
        overflow-x: hidden;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
        scrollbar-gutter: stable both-edges;
      }

      .tps-gcm-subitems-body--children {
        max-height: min(50vh, 640px);
        padding-right: 2px;
      }

      .tps-gcm-subitems-body--attachments {
        max-height: min(24vh, 280px);
        padding-right: 2px;
      }

      .tps-gcm-subitems-body--references {
        max-height: min(34vh, 420px);
        padding-right: 2px;
      }

      .tps-gcm-subitems-body--children::-webkit-scrollbar,
      .tps-gcm-subitems-body--attachments::-webkit-scrollbar,
      .tps-gcm-subitems-body--references::-webkit-scrollbar {
        width: 8px;
      }

      .tps-gcm-subitems-body--children::-webkit-scrollbar-thumb,
      .tps-gcm-subitems-body--attachments::-webkit-scrollbar-thumb,
      .tps-gcm-subitems-body--references::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--text-muted) 35%, transparent);
        border-radius: 999px;
      }

      .tps-gcm-subitems-body--children::-webkit-scrollbar-track,
      .tps-gcm-subitems-body--attachments::-webkit-scrollbar-track,
      .tps-gcm-subitems-body--references::-webkit-scrollbar-track {
        background: transparent;
      }

      .tps-gcm-subitems-body--drop-target {
        background: color-mix(in srgb, var(--interactive-accent) 10%, transparent) !important;
        outline: 2px solid var(--interactive-accent) !important;
      }

      .tps-gcm-subitem-empty {
        font-size: calc(12px * var(--tps-gcm-text-scale));
        color: var(--text-muted);
        padding: 0;
        line-height: 1.4;
      }

      .tps-gcm-subitem-row {
        margin-inline-start: calc(var(--tps-gcm-subitem-depth, 0) * 14px);
        padding: calc(5px * var(--tps-gcm-density)) calc(7px * var(--tps-gcm-density));
        border-radius: calc(8px * var(--tps-gcm-radius-scale));
        border: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
        background: color-mix(in srgb, var(--background-primary) 84%, transparent);
        display: flex;
        flex-direction: row;
        align-items: flex-start;
        gap: calc(8px * var(--tps-gcm-density));
        min-width: 0;
        overflow: hidden;
      }

      .tps-gcm-subitem-row::-webkit-scrollbar {
        display: none;
      }

      .tps-gcm-subitem-row--dragging {
        opacity: 0.4;
        cursor: grabbing;
      }

      .tps-gcm-subitem-row--hidden {
        opacity: 0.5;
      }

      .tps-gcm-subitem-row--hidden .tps-gcm-subitem-title {
        text-decoration: line-through;
      }

      .tps-gcm-subitems-hidden-badge {
        font-size: calc(10px * var(--tps-gcm-text-scale));
        color: var(--text-muted);
        background: color-mix(in srgb, var(--background-modifier-border) 60%, transparent);
        border-radius: calc(8px * var(--tps-gcm-radius-scale));
        padding: 1px calc(5px * var(--tps-gcm-density));
        margin-inline-start: 4px;
        white-space: nowrap;
      }

      .tps-gcm-subitem-row[draggable="true"] {
        cursor: grab;
      }

      .tps-gcm-subitem-strip {
        display: flex;
        flex: 1 1 auto;
        width: 100%;
        min-width: 0;
        overflow-x: auto;
        scrollbar-width: none;
      }

      .tps-gcm-subitem-inline-strip {
        flex: 0 1 auto;
        width: auto;
        max-width: 55%;
        min-width: 0;
        justify-content: flex-end;
      }

      .tps-gcm-subitem-strip::-webkit-scrollbar {
        display: none;
      }

      .tps-gcm-subitem-strip .tps-gcm-chip {
        gap: calc(3px * var(--tps-gcm-density));
        padding: calc(3px * var(--tps-gcm-density)) calc(6px * var(--tps-gcm-density));
        border-radius: calc(8px * var(--tps-gcm-radius-scale));
        font-size: calc(12px * var(--tps-gcm-text-scale) * 0.75);
        min-height: calc(16px * var(--tps-gcm-density) * var(--tps-gcm-button-scale));
      }

      .tps-gcm-subitem-strip .tps-gcm-chip-icon svg {
        width: calc(13px * var(--tps-gcm-button-scale) * 0.75);
        height: calc(13px * var(--tps-gcm-button-scale) * 0.75);
      }

      .tps-gcm-subitem-strip .tps-gcm-chip-label {
        font-size: calc(12px * var(--tps-gcm-text-scale) * 0.75);
      }

      .tps-gcm-subitem-content {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: calc(4px * var(--tps-gcm-density));
        min-width: 0;
        flex: 1 1 auto;
      }

      .tps-gcm-subitem-header {
        display: flex;
        align-items: flex-start;
        gap: calc(8px * var(--tps-gcm-density));
        min-width: 0;
        width: 100%;
      }

      .tps-gcm-subitem-icon {
        width: 18px;
        height: 18px;
        min-width: 18px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
        font-size: calc(12px * var(--tps-gcm-text-scale));
        line-height: 1;
      }

      .tps-gcm-subitem-icon svg {
        width: 16px;
        height: 16px;
      }

      .tps-gcm-subitem-icon--emoji {
        font-size: calc(9px * var(--tps-gcm-text-scale));
      }

      .tps-gcm-subitem-text {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 2px;
        min-width: 0;
        flex: 1 1 auto;
      }

      .tps-gcm-subitem-title-line {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        width: 100%;
      }

      .tps-gcm-subitem-title {
        all: unset;
        display: inline-flex !important;
        align-items: center;
        gap: 4px;
        padding: 0 !important;
        margin: 0 !important;
        border: none !important;
        background: transparent !important;
        box-shadow: none !important;
        appearance: none;
        -webkit-appearance: none;
        color: var(--text-normal);
        font-size: calc(12px * var(--tps-gcm-text-scale));
        font-weight: 600;
        line-height: 1.2;
        cursor: pointer;
        text-align: left;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        max-width: none;
        flex: 1 1 auto;
      }

      .tps-gcm-subitem-title:hover {
        color: var(--interactive-accent);
      }

      .tps-gcm-subitem-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        width: 100%;
        flex-wrap: nowrap;
        overflow: hidden;
      }

      .tps-gcm-subitem-relation {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 1px 6px;
        font-size: calc(9px * var(--tps-gcm-text-scale));
        font-weight: 600;
        line-height: 1.2;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .tps-gcm-subitem-relation--child {
        color: var(--text-accent);
        background: color-mix(in srgb, var(--interactive-accent) 18%, transparent);
      }

      .tps-gcm-subitem-relation--attachment {
        color: #76b7ff;
        background: rgba(75, 137, 212, 0.18);
      }

      .tps-gcm-subitem-path {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: calc(10px * var(--tps-gcm-text-scale));
        color: var(--text-faint);
        max-width: 28ch;
      }

      .tps-gcm-subitem-pills,
      .tps-gcm-subitem-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: nowrap;
        flex: 0 0 auto;
        white-space: nowrap;
      }

      .tps-gcm-subitem-pill,
      .tps-gcm-subitem-action {
        border: 1px solid var(--background-modifier-border);
        border-radius: 999px;
        background: var(--background-modifier-form-field);
        color: var(--text-normal);
        font-size: calc(10px * var(--tps-gcm-text-scale));
        line-height: 1.25;
        font-weight: 600;
        padding: 3px 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
      }

      .tps-gcm-subitem-pill:hover,
      .tps-gcm-subitem-action:hover {
        border-color: var(--interactive-accent);
        background: color-mix(in srgb, var(--background-modifier-hover), var(--background-primary));
        opacity: 1 !important;
      }

      .tps-gcm-subitem-action:disabled {
        opacity: 0.55;
        cursor: wait;
      }

      .tps-gcm-subitem-pill--status {
        color: var(--text-accent);
      }

      .tps-gcm-subitem-pill--priority {
        color: var(--color-yellow);
      }

      .tps-gcm-subitem-pill--scheduled {
        color: var(--color-blue);
      }

      .tps-gcm-subitem-children {
        display: flex;
        flex-direction: column;
        gap: calc(6px * var(--tps-gcm-density));
        margin-top: 2px;
      }

      .tps-gcm-checklist-subitems {
        display: flex;
        flex-direction: column;
        gap: calc(6px * var(--tps-gcm-density));
        margin-top: calc(8px * var(--tps-gcm-density));
        padding-top: calc(8px * var(--tps-gcm-density));
        border-top: 1px dashed var(--background-modifier-border);
      }

      .tps-gcm-checklist-subitems-title {
        font-size: calc(10px * var(--tps-gcm-text-scale));
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-faint);
      }

      .tps-gcm-checklist-subitems-list {
        display: flex;
        flex-direction: column;
        gap: calc(6px * var(--tps-gcm-density));
      }

      .tps-gcm-reference-direction {
        display: flex;
        flex-direction: column;
        gap: calc(6px * var(--tps-gcm-density));
      }

      .tps-gcm-reference-direction + .tps-gcm-reference-direction {
        margin-top: calc(10px * var(--tps-gcm-density));
        padding-top: calc(10px * var(--tps-gcm-density));
        border-top: 1px dashed var(--background-modifier-border);
      }

      .tps-gcm-reference-direction-title {
        font-size: calc(10px * var(--tps-gcm-text-scale));
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-faint);
      }

      .tps-gcm-reference-group {
        display: flex;
        flex-direction: column;
        gap: calc(6px * var(--tps-gcm-density));
        padding: calc(6px * var(--tps-gcm-density));
        border-radius: calc(8px * var(--tps-gcm-radius-scale));
        background: color-mix(in srgb, var(--background-primary) 82%, transparent);
        border: 1px solid color-mix(in srgb, var(--background-modifier-border) 68%, transparent);
      }

      .tps-gcm-reference-group-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        min-width: 0;
      }

      .tps-gcm-reference-group-title {
        appearance: none;
        -webkit-appearance: none;
        border: 0;
        background: transparent;
        color: var(--text-normal);
        font-size: calc(12px * var(--tps-gcm-text-scale));
        font-weight: 700;
        line-height: 1.2;
        cursor: pointer;
        padding: 0;
        margin: 0;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: left;
        flex: 1 1 auto;
      }

      .tps-gcm-reference-group-title:hover {
        color: var(--interactive-accent);
      }

      .tps-gcm-reference-count {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
        height: 20px;
        padding: 0 6px;
        border-radius: 999px;
        font-size: calc(10px * var(--tps-gcm-text-scale));
        font-weight: 700;
        color: var(--text-accent);
        background: color-mix(in srgb, var(--interactive-accent) 18%, transparent);
      }

      .tps-gcm-reference-occurrences {
        display: flex;
        flex-direction: column;
        gap: calc(6px * var(--tps-gcm-density));
      }

      .tps-gcm-reference-occurrence {
        display: flex;
        flex-direction: column;
        gap: calc(5px * var(--tps-gcm-density));
        padding: calc(6px * var(--tps-gcm-density));
        border-radius: calc(7px * var(--tps-gcm-radius-scale));
        background: color-mix(in srgb, var(--background-secondary) 70%, transparent);
        content-visibility: auto;
        contain-intrinsic-size: 72px;
      }

      .tps-gcm-reference-occurrence-meta {
        font-size: calc(10px * var(--tps-gcm-text-scale));
        color: var(--text-faint);
        line-height: 1.3;
      }

      .tps-gcm-reference-preview {
        font-size: calc(11px * var(--tps-gcm-text-scale));
        color: var(--text-normal);
        line-height: 1.45;
        white-space: pre-wrap;
        word-break: break-word;
      }

      .tps-gcm-reference-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }

      .tps-gcm-note-graph-host {
        position: relative;
      }

      .tps-gcm-note-graph {
        --tps-gcm-note-graph-space: clamp(230px, 24%, 284px);
        position: absolute;
        top: 12px;
        right: 12px;
        width: calc(var(--tps-gcm-note-graph-space) - 24px);
        margin: 0;
        padding: 10px 12px 9px;
        background:
          radial-gradient(circle at 78% 16%, color-mix(in srgb, var(--interactive-accent) 10%, transparent), transparent 58%),
          linear-gradient(170deg, color-mix(in srgb, var(--background-secondary) 88%, transparent), color-mix(in srgb, var(--background-primary) 78%, transparent));
        border: 1px solid color-mix(in srgb, var(--background-modifier-border) 72%, transparent);
        border-radius: 14px;
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.14);
        pointer-events: auto;
        z-index: 3;
      }

      .tps-gcm-note-graph-header {
        font-size: calc(10px * var(--tps-gcm-text-scale));
        font-weight: 650;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--text-faint);
        margin: 0 0 4px;
        text-align: left;
      }

      .tps-gcm-note-graph-body {
        width: 100%;
      }

      .tps-gcm-note-graph-empty {
        font-size: calc(11px * var(--tps-gcm-text-scale));
        color: var(--text-muted);
        padding: 10px 2px 4px;
      }

      .tps-gcm-note-graph-svg {
        display: block;
        width: 100%;
        height: auto;
        overflow: visible;
      }

      .tps-gcm-note-graph-root-halo {
        fill: color-mix(in srgb, var(--interactive-accent) 8%, transparent);
        stroke: color-mix(in srgb, var(--interactive-accent) 18%, transparent);
        stroke-width: 1;
      }

      .tps-gcm-note-graph-edge {
        fill: none;
        stroke-width: 1.4;
        stroke-linecap: round;
        opacity: 0.26;
      }

      .tps-gcm-note-graph-root-node {
        fill: var(--interactive-accent);
        opacity: 0.86;
        filter: drop-shadow(0 0 8px color-mix(in srgb, var(--interactive-accent) 28%, transparent));
      }

      .tps-gcm-note-graph-node {
        cursor: pointer;
        transition: transform 0.14s ease, opacity 0.14s ease, filter 0.14s ease;
      }

      .tps-gcm-note-graph-node:hover {
        opacity: 0.92;
        filter: drop-shadow(0 0 6px rgba(255, 255, 255, 0.12));
      }

      .tps-gcm-note-graph-root-label {
        fill: var(--text-normal);
        font-size: 11px;
        font-weight: 700;
        paint-order: stroke;
        stroke: color-mix(in srgb, var(--background-primary) 92%, transparent);
        stroke-width: 4px;
        stroke-linejoin: round;
      }

      .tps-gcm-note-graph-meta {
        fill: var(--text-faint);
        font-size: 8px;
        font-weight: 550;
      }

      .tps-gcm-note-references {
        display: flex;
        flex-direction: column;
        gap: 14px;
        max-width: var(--file-line-width, 700px);
        margin: 20px auto 40px;
        padding: 16px 18px 18px;
        border: 1px solid color-mix(in srgb, var(--background-modifier-border) 70%, transparent);
        border-radius: 18px;
        background: color-mix(in srgb, var(--background-secondary) 74%, transparent);
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
      }

      .tps-gcm-note-references-header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 12px;
      }

      .tps-gcm-note-references-title-wrap {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }

      .tps-gcm-note-references-title {
        margin: 0;
        color: var(--text-normal);
        font-size: calc(15px * var(--tps-gcm-text-scale));
        font-weight: 700;
        line-height: 1.2;
      }

      .tps-gcm-note-references-subtitle {
        color: var(--text-muted);
        font-size: calc(11px * var(--tps-gcm-text-scale));
        line-height: 1.35;
      }

      .tps-gcm-note-references-body {
        display: flex;
        flex-direction: column;
        gap: 14px;
      }

      .tps-gcm-note-references .tps-gcm-reference-group {
        background: color-mix(in srgb, var(--background-primary) 55%, transparent);
      }

      .tps-gcm-note-references .tps-gcm-reference-direction {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .tps-gcm-note-references .tps-gcm-reference-simple-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .tps-gcm-note-references .tps-gcm-reference-frontmatter-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .tps-gcm-note-references .tps-gcm-reference-frontmatter-title {
        font-size: calc(10px * var(--tps-gcm-text-scale));
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--text-faint);
      }

      .tps-gcm-note-references .tps-gcm-reference-frontmatter-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      .tps-gcm-note-references .tps-gcm-reference-frontmatter-chip {
        border: 1px solid var(--background-modifier-border);
        border-radius: 999px;
        background: color-mix(in srgb, var(--background-modifier-form-field) 85%, transparent);
        color: var(--text-muted);
        font-size: calc(11px * var(--tps-gcm-text-scale));
        line-height: 1.25;
        font-weight: 600;
        padding: 5px 10px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
      }

      .tps-gcm-note-references .tps-gcm-reference-frontmatter-chip:hover {
        border-color: var(--interactive-accent);
        color: var(--text-accent);
      }

      .tps-gcm-note-footer-host {
        display: block;
        width: 100%;
      }

      /* Removed fragile Editor Footer flex column hacks that broke cm-scroller native wrapping */

      /* Source mode footer host: mounted under CM content/sizer containers. */
      .cm-content > .tps-gcm-note-footer-host,
      .cm-sizer > .tps-gcm-note-footer-host,
      .cm-contentContainer > .tps-gcm-note-footer-host,
      .cm-scroller > .tps-gcm-note-footer-host {
        display: block;
        width: 100%;
        margin-top: 0;
        padding: 0 0 56px;
        box-sizing: border-box;
      }

      /* Reading mode footer host (inside markdown-preview-sizer) */
      .markdown-preview-sizer > .tps-gcm-note-footer-host {
        display: block;
        width: 100%;
        margin-top: 50px;
      }

      .cm-sizer .tps-gcm-note-references,
      .cm-contentContainer .tps-gcm-note-references,
      .cm-scroller .tps-gcm-note-references,
      .cm-editor .tps-gcm-note-references {
        display: flex !important;
      }


      @media (max-width: 900px) {
        .tps-gcm-note-graph {
          position: relative;
          top: auto;
          right: auto;
          width: 100%;
          min-width: 0;
          max-width: 280px;
          margin: 0 0 14px auto;
        }

        .tps-gcm-note-references {
          margin-top: 20px;
        }
      }

      .tps-gcm-subitem-row--checklist {
        margin-inline-start: 0;
        content-visibility: auto;
        contain-intrinsic-size: 54px;
        align-items: flex-start;
        overflow: hidden;
      }

      .tps-gcm-checklist-toggle {
        flex: 0 0 auto;
        margin: 0;
        width: 16px;
        height: 16px;
        cursor: pointer;
      }

      .tps-gcm-checklist-toggle:disabled {
        cursor: wait;
        opacity: 0.6;
      }

      .tps-gcm-subitem-title--checklist {
        cursor: pointer;
        max-width: none;
        flex: 1 1 auto;
      }

      .tps-gcm-subitem-row--checklist .tps-gcm-subitem-meta {
        align-items: center;
        gap: 8px;
      }

      .tps-gcm-subitem-row--checklist .tps-gcm-subitem-actions {
        margin-inline-start: auto;
      }

      .tps-gcm-subitem-title--checklist:hover {
        color: var(--interactive-accent);
      }

      @keyframes tps-gcm-line-flash {
        0%   { background: color-mix(in srgb, var(--interactive-accent) 35%, transparent); }
        100% { background: transparent; }
      }

      /* Live preview / source mode */
      .cm-line.tps-gcm-line-highlight {
        animation: tps-gcm-line-flash 1.4s ease-out forwards;
        border-radius: 3px;
      }

      /* Reading mode */
      li.tps-gcm-line-highlight,
      .task-list-item.tps-gcm-line-highlight {
        animation: tps-gcm-line-flash 1.4s ease-out forwards;
        border-radius: 3px;
      }

      .tps-gcm-subitem-create-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
      }

      .tps-gcm-subitem-folder-picker {
        margin-top: 6px;
      }

      .tps-gcm-native-item:hover:not(:disabled),
      .tps-gcm-native-item:focus:not(:disabled) {
        background-color: color-mix(in srgb, var(--background-modifier-hover), var(--background-primary));
        border-color: var(--interactive-accent);
        outline: none;
        opacity: 1 !important;
      }
      .tps-gcm-native-item:disabled,
      .tps-gcm-native-item.is-disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .tps-gcm-item-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        flex-shrink: 0;
      }
      .tps-gcm-item-icon svg {
        width: 16px;
        height: 16px;
      }
      .tps-gcm-separator {
        height: 1px;
        background: var(--background-modifier-border);
        margin: 4px 8px;
      }
      
      /* Collapsed state styles */
      .tps-global-context-menu--collapsed .tps-gcm-panel {
        display: none;
      }
      
      .tps-global-context-menu--persistent .tps-global-context-header {
        cursor: pointer;
        display: flex;
        justify-content: flex-start;
        align-items: center;
        user-select: none;
        gap: calc(8px * var(--tps-gcm-density));
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: optimizeLegibility;
      }
      
      .tps-global-context-menu--persistent .tps-global-context-header:hover {
        color: var(--text-normal);
      }

      .tps-gcm-header-left {
        display: flex;
        align-items: center;
        gap: calc(4px * var(--tps-gcm-density));
        flex-shrink: 0;
      }

      .tps-gcm-header-right {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: calc(6px * var(--tps-gcm-density));
        flex-wrap: nowrap;
        flex: 1;
        overflow: hidden;
        min-width: 0;
        padding-left: calc(2px * var(--tps-gcm-density));
      }
      
      .tps-gcm-header-right::-webkit-scrollbar {
        display: none;
      }

      .tps-gcm-header-title {
        font-weight: 600;
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 160px;
      }

      .tps-gcm-collapse-button {
        min-width: calc(26px * var(--tps-gcm-button-scale));
        min-height: calc(26px * var(--tps-gcm-button-scale));
        width: calc(26px * var(--tps-gcm-button-scale));
        height: calc(26px * var(--tps-gcm-button-scale));
        border-radius: calc(6px * var(--tps-gcm-control-scale) * var(--tps-gcm-radius-scale));
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
        padding: 0;
        flex-shrink: 0;
        position: relative;
        z-index: 10;
        transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
        image-rendering: -webkit-optimize-contrast;
        -webkit-font-smoothing: antialiased;
      }

      .tps-gcm-collapse-button:hover {
        background: var(--background-modifier-hover);
        color: var(--text-normal);
        border-color: var(--interactive-accent);
      }

      .tps-gcm-collapse-button:active {
        background: var(--background-modifier-active-hover);
      }

      .tps-gcm-collapse-button::before {
        content: '';
        width: calc(10px * var(--tps-gcm-button-scale));
        height: calc(10px * var(--tps-gcm-button-scale));
        border-left: 2px solid currentColor;
        border-bottom: 2px solid currentColor;
        transform: rotate(-45deg);
        transition: transform 0.2s ease;
        image-rendering: crisp-edges;
      }

      .tps-gcm-collapse-button[aria-expanded='true']::before {
        transform: rotate(135deg);
      }

      /* Live preview: flip arrow direction */
      .tps-global-context-menu--live .tps-gcm-collapse-button::before {
        transform: rotate(135deg);
      }
      .tps-global-context-menu--live .tps-gcm-collapse-button[aria-expanded='true']::before {
        transform: rotate(-45deg);
      }

      .tps-gcm-collapse-button:focus-visible {
        outline: 2px solid var(--interactive-accent);
        outline-offset: 2px;
      }

      .tps-global-context-menu--collapsed.tps-global-context-menu--live {
        width: min(var(--tps-inline-bar-width), var(--tps-gcm-pane-width, var(--tps-inline-bar-width)));
        display: block;
        min-width: 0;
        border-top-left-radius: calc(8px * var(--tps-gcm-radius-scale));
        border-top-right-radius: calc(8px * var(--tps-gcm-radius-scale));
        background-color: var(--tps-inline-bar-bg);
        border: 1px solid var(--background-modifier-border);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        padding: calc(4px * var(--tps-gcm-density)) calc(8px * var(--tps-gcm-density));
      }

      .tps-global-context-menu--collapsed.tps-global-context-menu--live .tps-global-context-header {
        justify-content: flex-start;
        padding: 0;
        gap: 8px;
      }
      
      .tps-gcm-nav-group {
        display: flex;
        align-items: center;
        gap: 2px;
      }

      .tps-gcm-nav-button {
        min-width: calc(24px * var(--tps-gcm-button-scale));
        min-height: calc(24px * var(--tps-gcm-button-scale));
        width: calc(24px * var(--tps-gcm-button-scale));
        height: calc(24px * var(--tps-gcm-button-scale));
        border-radius: calc(4px * var(--tps-gcm-control-scale));
        border: none;
        background: transparent;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
        padding: 0;
        flex-shrink: 0;
        transition: color 0.15s ease, background-color 0.15s ease;
      }

      .tps-gcm-nav-button:hover {
        color: var(--text-normal);
        background: var(--background-modifier-hover);
      }
      
      .tps-gcm-nav-button svg {
        width: calc(14px * var(--tps-gcm-button-scale));
        height: calc(14px * var(--tps-gcm-button-scale));
      }

      /* Hide navigation buttons on very small screens or when constrained */
      @media (max-width: 400px) {
        .tps-gcm-nav-group {
          display: none;
        }
      }

      .tps-global-context-menu--collapsed.tps-global-context-menu--live .tps-gcm-header-right {
        margin-right: 0;
        flex: 0 0 auto;
      }
      
      /* Hide title text when collapsed, but keep the collapse button */
      .tps-global-context-menu--collapsed .tps-gcm-file-title {
        display: none;
      }

      /* Fix overlap: Ensure left section (button only) takes natural width in collapsed mode */
      .tps-global-context-menu--collapsed .tps-gcm-header-left {
        flex: 0 0 auto !important;
      }

      .tps-global-context-menu--collapsed .tps-gcm-collapse-button {
        min-width: calc(24px * var(--tps-gcm-button-scale));
        min-height: calc(24px * var(--tps-gcm-button-scale));
        width: calc(24px * var(--tps-gcm-button-scale));
        height: calc(24px * var(--tps-gcm-button-scale));
      }

      .tps-global-context-menu--collapsed .tps-gcm-nav-button {
        min-width: calc(32px * var(--tps-gcm-button-scale));
        min-height: calc(32px * var(--tps-gcm-button-scale));
        width: calc(32px * var(--tps-gcm-button-scale));
        height: calc(32px * var(--tps-gcm-button-scale));
      }

      .modal.mod-tps-gcm {
        width: min(var(--tps-gcm-modal-width), calc(100vw - 32px));
        max-height: var(--tps-gcm-modal-max-height);
      }

      .modal.mod-tps-gcm .modal-content {
        max-height: calc(var(--tps-gcm-modal-max-height) - 24px);
        overflow-y: auto;
        padding: calc(16px * var(--tps-gcm-density));
      }

      .modal.mod-tps-gcm h2 {
        font-size: calc(16px * var(--tps-gcm-text-scale));
        font-weight: 700;
        color: var(--text-normal);
        margin-bottom: calc(12px * var(--tps-gcm-density));
      }

      .modal.mod-tps-gcm .setting-item {
        border: none;
        padding: calc(12px * var(--tps-gcm-density)) 0;
      }

      .modal.mod-tps-gcm .setting-item-name {
        font-size: calc(13px * var(--tps-gcm-text-scale));
        font-weight: 600;
        color: var(--text-normal);
      }

      .modal.mod-tps-gcm .setting-item-description {
        font-size: calc(12px * var(--tps-gcm-text-scale));
        color: var(--text-muted);
      }

      .modal.mod-tps-gcm button {
        font-size: calc(13px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        font-weight: 600;
        padding: calc(8px * var(--tps-gcm-control-scale)) calc(16px * var(--tps-gcm-control-scale));
        color: var(--text-normal);
      }

      .modal.mod-tps-gcm button.mod-cta {
        color: var(--text-on-accent);
        font-weight: 700;
      }

      .modal.mod-tps-gcm input,
      .modal.mod-tps-gcm select,
      .modal.mod-tps-gcm textarea {
        font-size: calc(13px * var(--tps-gcm-text-scale) * var(--tps-gcm-control-scale));
        font-weight: 500;
        color: var(--text-normal);
        padding: calc(8px * var(--tps-gcm-control-scale)) calc(10px * var(--tps-gcm-control-scale));
        background-color: var(--background-primary);
        border: 1px solid var(--background-modifier-border);
        border-radius: calc(6px * var(--tps-gcm-radius-scale));
      }

      .modal.mod-tps-gcm input::placeholder {
        color: var(--text-muted);
      }
      
      /* Recurrence preview section */
      .tps-gcm-recurrence-preview {
        margin-top: 12px;
        padding: 8px;
        background: var(--background-primary);
        border-radius: 6px;
        border: 1px solid var(--background-modifier-border);
      }
      
      .tps-gcm-recurrence-preview-title {
        font-size: calc(11px * var(--tps-gcm-text-scale));
        font-weight: 600;
        text-transform: uppercase;
        color: var(--text-muted);
        margin-bottom: 6px;
      }
      
      .tps-gcm-recurrence-preview-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      
      .tps-gcm-recurrence-preview-item {
        font-size: calc(12px * var(--tps-gcm-text-scale));
        color: var(--text-normal);
        padding: 2px 0;
      }
      

      .tps-gcm-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        vertical-align: middle;
        min-height: calc(24px * var(--tps-gcm-density) * var(--tps-gcm-button-scale));
        height: auto;
        font-size: calc(11px * var(--tps-gcm-text-scale));
        padding: calc(2px * var(--tps-gcm-density)) calc(8px * var(--tps-gcm-density));
        border-radius: calc(4px * var(--tps-gcm-radius-scale));
        background: var(--background-modifier-hover);
        color: var(--text-muted);
        text-transform: uppercase;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
        line-height: 1.1;
        white-space: nowrap;
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: optimizeLegibility;
        letter-spacing: 0.02em;
      }
      
      .tps-gcm-badge:hover {
        background: var(--interactive-accent);
        color: var(--text-on-accent);
      }

      .tps-gcm-badge-tag,
      .tps-gcm-badge-tag-more,
      .tps-gcm-badge-add-tag {
        border-radius: 999px;
      }

      .tps-gcm-badge-tag-more {
        font-size: calc(9px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        padding: calc(1px * var(--tps-gcm-control-scale)) calc(6px * var(--tps-gcm-control-scale));
      }

      /* Collapsed header: make tag pills smaller */
      .tps-global-context-menu--collapsed .tps-gcm-badge-tag,
      .tps-global-context-menu--collapsed .tps-gcm-badge-tag-more,
      .tps-global-context-menu--collapsed .tps-gcm-badge-add-tag {
        font-size: calc(8px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        padding: calc(1px * var(--tps-gcm-density)) calc(4px * var(--tps-gcm-control-scale));
      }

      .tps-global-context-menu--collapsed .tps-gcm-badge-tag-remove {
        font-size: calc(9px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        margin-right: 2px;
      }

      .tps-gcm-badge-tag {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: calc(9px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        padding: calc(1px * var(--tps-gcm-control-scale)) calc(6px * var(--tps-gcm-control-scale));
      }

      .tps-gcm-badge-tag-text {
        display: inline;
      }

      .tps-gcm-badge-tag-remove {
        border: none !important;
        background: transparent !important;
        box-shadow: none !important;
        outline: none !important;
        color: #ff5a5a !important;
        opacity: 0.7;
        cursor: pointer;
        font-size: calc(10px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        line-height: 1;
        padding: 0;
        margin-right: 3px;
        font-weight: 700;
        appearance: none;
        -webkit-appearance: none;
      }

      .tps-gcm-badge-tag-remove:hover {
        background: transparent !important;
        opacity: 1;
      }

      .tps-gcm-badge-add-tag {
        background: var(--interactive-accent) !important;
        color: var(--text-on-accent) !important;
        border: none !important;
        font-size: calc(9px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        font-weight: 700;
        min-width: calc(14px * var(--tps-gcm-button-scale));
        padding: calc(1px * var(--tps-gcm-control-scale)) calc(5px * var(--tps-gcm-control-scale));
        text-align: center;
      }

      .tps-gcm-badge-add-tag:hover {
        background: var(--interactive-accent-hover) !important;
        transform: scale(1.05);
      }

      .tps-gcm-badge-add-tag:active {
        transform: scale(0.95);
      }

      /* Seamless integration for Reading Mode Collapsed State */
      .tps-global-context-menu--reading.tps-global-context-menu--collapsed {
        margin-bottom: 12px;
        min-width: 0;
        width: min(var(--tps-inline-bar-width), var(--tps-gcm-pane-width, var(--tps-inline-bar-width)));
        background-color: rgba(15, 20, 26, 0.18);
      }

      .tps-global-context-menu--reading.tps-global-context-menu--collapsed .tps-global-context-header {
        padding: 0 !important;
        color: var(--text-muted) !important;
        font-size: 0.9em !important;
        justify-content: flex-start !important; /* Align badges to left */
        gap: 8px;
      }

      /* Reset the right container to flow naturally */
      .tps-global-context-menu--reading.tps-global-context-menu--collapsed .tps-gcm-header-right {
        margin-right: 0 !important;
      }

      /* Prevent spreading in Reading Mode */
      .tps-global-context-menu--reading.tps-global-context-menu--collapsed .tps-gcm-header-left {
        flex: 0 0 auto !important;
      }

      /* ===== MOBILE-SPECIFIC COMPACT STYLING ===== */
      /* Keyboard hiding only for non-persistent overlays */
      .tps-context-hidden-for-keyboard .tps-global-context-menu:not(.tps-global-context-menu--persistent) {
`;
