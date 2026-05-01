export const NAVIGATION_AND_SHELL_STYLES = `

      :root {
        --tps-gcm-text-scale: 1;
        --tps-gcm-button-scale: 1;
        --tps-gcm-control-scale: 1;
        --tps-gcm-density: 1;
        --tps-gcm-radius-scale: 1;
        --tps-gcm-live-left: 50%;
        --tps-gcm-live-right: auto;
        --tps-gcm-live-transform: translate(-50%, 0px);
        --tps-gcm-modal-width: 520px;
        --tps-gcm-modal-max-height: 80vh;
        --tps-gcm-subitems-margin-bottom: 0px;
        --tps-gcm-daily-nav-scale: 1;
        --tps-gcm-daily-nav-rest-opacity: 0;
        --tps-gcm-mobile-toolbar-offset: 0px;
      }

      .tps-daily-note-nav {
        z-index: 50;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
      }

      .tps-gcm-time-tracker-badge {
        display: inline-flex;
        align-items: center;
        margin-left: 0.45em;
        padding: 1px 6px;
        border: 1px solid var(--background-modifier-border);
        border-radius: 999px;
        background: var(--background-modifier-form-field);
        color: var(--text-muted);
        font-size: 0.82em;
        line-height: 1.35;
        white-space: nowrap;
        vertical-align: baseline;
        user-select: none;
      }

      .tps-gcm-time-tracker-badge--running {
        border-color: color-mix(in srgb, var(--interactive-accent) 55%, var(--background-modifier-border));
        color: var(--interactive-accent);
      }

      .tps-daily-note-nav-control {
        user-select: none;
        -webkit-user-select: none;
        touch-action: manipulation;
      }

      .tps-daily-note-nav--floating {
        position: absolute;
        top: 10px;
        left: 50%;
        transform: translateX(-50%);
        opacity: var(--tps-gcm-daily-nav-rest-opacity);
        transition: opacity 0.2s ease;
        pointer-events: none;
      }

      .markdown-source-view:hover .tps-daily-note-nav--floating,
      .markdown-reading-view:hover .tps-daily-note-nav--floating,
      .tps-daily-note-nav--floating:hover {
         opacity: 1;
         pointer-events: auto;
      }

      /* When rest opacity > 0 the nav is always partially visible and interactive */
      .tps-daily-note-nav--floating[data-rest-visible] {
        pointer-events: auto;
      }

      /* On mobile there is no hover — always show the floating nav */
      .is-mobile .tps-daily-note-nav--floating {
        opacity: 1;
        pointer-events: auto;
        top: auto;
        bottom: calc(max(var(--tps-auto-base-embed-bottom, var(--tps-gcm-live-bottom, 16px)), var(--tps-gcm-mobile-toolbar-offset, 0px)) + env(safe-area-inset-bottom, 0px) + 4px);
        left: 50%;
        transform: translateX(-50%);
        width: calc(100vw - 28px);
        max-width: 420px;
        z-index: 99998;
      }

      .tps-context-hidden-for-keyboard .tps-daily-note-nav--mobile {
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      .is-mobile .tps-daily-note-nav--mobile {
        display: flex;
        justify-content: center;
        gap: 0;
        padding: 10px 12px;
        background: color-mix(in srgb, var(--background-secondary) 92%, transparent);
        border: 1px solid var(--background-modifier-border);
        border-radius: 14px;
        box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        transition: opacity 0.18s ease, transform 0.18s ease, visibility 0.18s ease;
      }

      .is-mobile .tps-daily-note-nav--mobile .tps-daily-note-nav__bottom-row {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 10px;
        width: 100%;
      }

      .is-mobile .tps-daily-note-nav--mobile .tps-daily-note-nav__dates-group {
        display: none;
      }

      .is-mobile .tps-daily-note-nav--mobile .tps-daily-note-nav__bottom-row > *:first-child {
        justify-self: start;
      }

      .is-mobile .tps-daily-note-nav--mobile .tps-daily-note-nav__bottom-row > *:nth-child(2) {
        justify-self: center;
      }

      .is-mobile .tps-daily-note-nav--mobile .tps-daily-note-nav__bottom-row > *:last-child {
        justify-self: end;
      }

      .is-mobile .tps-daily-note-nav--mobile .tps-daily-nav-today,
      .is-mobile .tps-daily-note-nav--mobile .daily-note-navbar__change-week {
        min-height: 34px;
        padding: 4px 10px;
        font-size: 0.92em;
        line-height: 1.3;
        background: transparent;
        border: 1px solid transparent;
        border-radius: 4px;
        color: var(--text-muted);
        box-shadow: none;
        transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
      }

      .is-mobile .tps-daily-note-nav--mobile .daily-note-navbar__change-week {
        justify-content: center;
        color: var(--text-muted);
      }

      .is-mobile .tps-daily-note-nav--mobile .tps-daily-nav-today--inactive {
        color: var(--text-muted);
      }

      .is-mobile .tps-daily-note-nav--mobile .tps-daily-nav-today--current {
        background: var(--background-modifier-hover);
        border-color: var(--background-modifier-border);
        color: var(--text-normal);
        font-weight: 600;
      }

      .is-mobile .tps-daily-note-nav--mobile .daily-note-navbar__change-week:hover,
      .is-mobile .tps-daily-note-nav--mobile .tps-daily-nav-today:hover {
        background: var(--background-modifier-hover);
        border-color: var(--background-modifier-border-hover, var(--background-modifier-border));
        color: var(--text-normal);
      }

      .is-mobile .tps-daily-note-nav--mobile .tps-daily-nav-today--current:hover {
        background: var(--background-modifier-hover);
        border-color: var(--background-modifier-border);
        color: var(--text-normal);
      }

      .is-mobile .tps-daily-note-nav--mobile .daily-note-navbar__change-week svg {
        width: 14px;
        height: 14px;
      }

      .tps-daily-note-nav--inline {
        position: absolute;
        inset-inline-end: 0;
        top: 50%;
        transform: translateY(-50%);
        margin: 0;
      }

      .tps-daily-note-nav-host {
        position: relative;
        padding-inline-end: 160px;
      }

      .tps-daily-note-nav-anchor {
        position: relative;
      }

      .view-header-title-parent.tps-daily-note-nav-anchor,
      .view-header-title-container.tps-daily-note-nav-anchor,
      .view-header-breadcrumbs.tps-daily-note-nav-anchor,
      .view-header-breadcrumb.tps-daily-note-nav-anchor {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }

      .tps-daily-note-nav-header-wrapper {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        min-width: 0;
        margin-top: 8px;
        padding: 12px 12px 8px;
        box-sizing: border-box;
      }

      .tps-daily-note-nav-anchor .inline-title,
      .tps-daily-note-nav-anchor .markdown-preview-sizer > h1,
      .tps-daily-note-nav-anchor .markdown-preview-view h1 {
        padding-inline-end: 0;
        box-sizing: border-box;
      }

      .tps-daily-note-nav--under-title {
        position: relative;
        display: flex;
        width: fit-content;
        max-width: 100%;
        margin: 8px 0 10px;
        opacity: 1;
        pointer-events: auto;
        z-index: 4;
      }

      .tps-daily-note-nav--header-dates {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin: 0;
        padding: 6px 8px;
        box-sizing: border-box;
        overflow: visible;
        z-index: 50;
      }

      .tps-daily-note-nav--header-controls {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0;
        padding: 6px 16px 8px;
        box-sizing: border-box;
        z-index: 50;
        background: var(--background-secondary);
        border-bottom: 1px solid var(--background-modifier-border);
      }

      .tps-daily-note-nav--header-controls .tps-daily-note-nav__bottom-row {
        gap: 14px;
        margin: 0;
      }

      .tps-daily-note-nav--header-dates,
      .tps-daily-note-nav--header-controls {
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
      }

      .tps-daily-note-nav--header-dates .daily-note-navbar__date {
        border-radius: 4px;
        padding: 3px 10px;
        font-size: 0.92em;
        line-height: 1.3;
        white-space: nowrap;
        color: var(--text-muted);
        transition: background 0.15s ease, color 0.15s ease;
      }

      .tps-daily-note-nav--header-dates .daily-note-navbar__date:hover {
        color: var(--text-normal);
        background: var(--background-modifier-hover);
      }

      .tps-daily-note-nav--header-dates .daily-note-navbar__active {
        color: var(--text-normal);
        font-weight: 600;
        background: var(--background-modifier-hover);
      }

      .tps-daily-note-nav--header-dates .daily-note-navbar__current {
        color: var(--text-accent);
      }

      .tps-daily-note-nav--header-controls .daily-note-navbar__change-week {
        border-radius: 4px;
        padding: 4px 8px;
        color: var(--text-muted);
        transition: background 0.15s ease, color 0.15s ease;
      }

      .tps-daily-note-nav--header-controls .daily-note-navbar__change-week:hover {
        color: var(--text-normal);
        background: var(--background-modifier-hover);
      }

      .tps-daily-note-nav--header-controls .daily-note-navbar__change-week svg {
        width: 14px;
        height: 14px;
      }

      .tps-daily-nav-today {
        text-transform: uppercase;
        font-size: 0.82em;
        font-weight: 500;
        letter-spacing: 0.04em;
        color: var(--text-muted);
        border-radius: 4px;
        padding: 3px 10px;
        transition: background 0.15s ease, color 0.15s ease;
      }

      .tps-daily-nav-today:hover {
        color: var(--text-normal);
        background: var(--background-modifier-hover);
      }

      .workspace-leaf-content[data-type='markdown'] .view-header-title-container,
      .workspace-leaf-content[data-type='markdown'] .view-header-title-parent,
      .workspace-leaf-content[data-type='markdown'] .view-header-breadcrumb,
      .workspace-leaf-content[data-type='markdown'] .view-header-breadcrumbs {
        min-width: 0;
      }

      @media (max-width: 900px) {
        .tps-daily-note-nav-header-wrapper {
          justify-content: flex-start;
          margin-top: 8px;
          padding: 10px 8px 6px;
        }

        .tps-daily-note-nav--header-dates {
          gap: 4px;
        }

        .tps-daily-note-nav--header-controls {
          padding: 2px 8px 4px;
        }

        .tps-daily-note-nav__top-row {
          gap: 4px;
        }

        .tps-daily-note-nav__dates-group {
          gap: 6px;
        }
      }

      @media (max-width: 1180px) {
        .tps-daily-note-nav--header .tps-daily-note-nav__offset-neg-3,
        .tps-daily-note-nav--header .tps-daily-note-nav__offset-3 {
          display: none;
        }
      }

      @media (max-width: 1020px) {
        .tps-daily-note-nav--header {
          gap: 8px;
        }

        .tps-daily-note-nav--header .daily-note-navbar__date,
        .tps-daily-note-nav--header .daily-note-navbar__change-week {
          padding-inline: 6px;
          font-size: 0.92em;
        }

        .tps-daily-note-nav--header .tps-daily-note-nav__offset-neg-2,
        .tps-daily-note-nav--header .tps-daily-note-nav__offset-2 {
          display: none;
        }
      }

      @media (max-width: 860px) {
        .tps-daily-note-nav--header .tps-daily-note-nav__offset-neg-1,
        .tps-daily-note-nav--header .tps-daily-note-nav__offset-1 {
          display: none;
        }

        .tps-daily-note-nav--header .daily-note-navbar__date {
          min-width: 52px;
        }
      }

      @media (max-width: 740px) {
        .tps-daily-note-nav--header .daily-note-navbar__date,
        .tps-daily-note-nav--header .daily-note-navbar__change-week {
          padding-inline: 4px;
          font-size: 0.88em;
        }

        .tps-daily-note-nav--header .daily-note-navbar__date {
          min-width: 46px;
        }
      }

      .tps-global-context-menu {
        position: fixed;
        min-width: 220px;
        color: var(--text-normal);
        z-index: 9999;
        font-size: calc(14px * var(--tps-gcm-text-scale));
        animation: tps-context-fade 120ms ease-out;
        touch-action: none;
      }
      @keyframes tps-context-fade {
        from { opacity: 0; transform: translateY(4px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      .tps-global-context-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        width: 100%;
        border: none;
        background: transparent;
        padding: 6px 14px;
        text-align: left;
        cursor: pointer;
        color: inherit;
      }
      .tps-global-context-item:hover,
      .tps-global-context-item:focus {
        background-color: var(--background-modifier-hover);
        outline: none;
      }
      .tps-global-context-item-label {
        font-weight: 500;
      }
      .tps-global-context-item-desc {
        font-size: calc(12px * var(--tps-gcm-text-scale));
        color: var(--text-muted);
      }
      .tps-global-context-header {
        padding: calc(4px * var(--tps-gcm-density)) calc(14px * var(--tps-gcm-density)) calc(8px * var(--tps-gcm-density));
        font-size: calc(11px * var(--tps-gcm-text-scale));
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-faint);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: calc(8px * var(--tps-gcm-density));
      }
      .tps-gcm-header-left {
        display: flex;
        align-items: center;
        gap: calc(8px * var(--tps-gcm-density));
        flex: 1;
        min-width: 0;
      }
      .tps-gcm-file-title {
        font-weight: 600;
        color: var(--text-normal);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: calc(11px * var(--tps-gcm-text-scale));
      }
      .tps-gcm-note-title-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.05em;
        height: 1.05em;
        margin-right: 0.35em;
        color: currentColor;
        opacity: 1;
        flex-shrink: 0;
        pointer-events: none;
        user-select: none;
        -webkit-user-select: none;
        vertical-align: -0.08em;
      }
      .tps-gcm-note-title-icon svg {
        width: 0.95em;
        height: 0.95em;
      }
      .tps-gcm-note-title-icon--emoji {
        font-size: 0.95em;
        line-height: 1;
      }
      .tps-gcm-header-right {
        display: flex;
        align-items: center;
        gap: calc(4px * var(--tps-gcm-density));
        flex-shrink: 0;
      }
      .tps-gcm-panel {
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: calc(6px * var(--tps-gcm-density));
      }
      .tps-gcm-multi-banner {
        font-size: calc(12px * var(--tps-gcm-text-scale));
        color: var(--text-muted);
        background: var(--background-modifier-hover);
        padding: calc(4px * var(--tps-gcm-density)) calc(8px * var(--tps-gcm-density));
        border-radius: calc(6px * var(--tps-gcm-radius-scale));
      }
      .tps-gcm-row {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .tps-gcm-row label {
        font-size: calc(11px * var(--tps-gcm-text-scale));
        font-weight: 600;
        text-transform: uppercase;
        color: var(--text-muted);
      }
      .tps-gcm-input-wrapper {
        position: relative;
        width: 100%;
        display: flex;
        flex-direction: column;
      }
      .tps-gcm-viewmode-rule {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .tps-gcm-viewmode-rule .setting-item {
        margin: 0;
        flex: 1 1 160px;
        min-width: 140px;
      }
      .tps-gcm-viewmode-rule span {
        white-space: nowrap;
      }
      .tps-gcm-row select,
      .tps-gcm-row input[type="text"],
      .tps-gcm-row input[type="datetime-local"],
      .tps-gcm-row input[type="date"] {
        width: 100%;
        border-radius: calc(6px * var(--tps-gcm-control-scale));
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        color: var(--text-normal);
        padding: calc(4px * var(--tps-gcm-control-scale)) calc(8px * var(--tps-gcm-control-scale));
        font-size: calc(12px * var(--tps-gcm-text-scale) * var(--tps-gcm-control-scale));
      }

      /* Live preview: compact toolbar fixed at the bottom of the viewport.
         Uses fixed positioning to avoid affecting readable line length. */
      .tps-global-context-menu--live,
      .tps-global-context-menu--reading {
        /* Shared sizing + surface variables */
        --tps-inline-bar-width: calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
        font-size: calc(var(--font-text-size) * 0.85 * var(--tps-gcm-text-scale));
`;
