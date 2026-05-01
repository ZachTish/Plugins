export const LINKED_SUBITEMS_AND_CONTEXT_STYLES = `
        width: max(220px, var(--tps-inline-bar-width));
        max-width: var(--tps-gcm-pane-width, none);
        margin-left: auto;
        margin-right: auto;
        box-sizing: border-box;
      }

      .markdown-preview-view .tps-global-context-menu--reading {
        /* No background, border, or shadow - just the chips */
      }
      .markdown-view.is-readable-line-width .tps-global-context-menu--live,
      .markdown-view.is-readable-line-width .tps-global-context-menu--reading,
      .markdown-source-view.is-readable-line-width .tps-global-context-menu--live,
      .markdown-source-view.is-readable-line-width .tps-global-context-menu--reading,
      .markdown-preview-view.is-readable-line-width .tps-global-context-menu--reading,
      body.tps-readable-line-width .tps-global-context-menu--live,
      body.tps-readable-line-width .tps-global-context-menu--reading,
      body.is-readable-line-width .tps-global-context-menu--live,
      body.is-readable-line-width .tps-global-context-menu--reading {
        --tps-inline-bar-width: calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
        max-width: var(--tps-gcm-pane-width, none);
      }

      .tps-global-context-menu--live,
      .tps-global-context-menu--reading {
        display: flex;
        flex-direction: column;
        justify-content: flex-end; /* Ensure content stacks from bottom up if height is constrained? No, with auto height it grows up from bottom anchor. */
        align-items: center; /* Center children horizontally */
        
        position: fixed;
        /* Move up to clear Obsidian mobile toolbar (approx 50px) + status bar */
        bottom: calc(max(var(--tps-auto-base-embed-bottom, var(--tps-gcm-live-bottom, 16px)), var(--tps-gcm-mobile-toolbar-offset, 0px)) + env(safe-area-inset-bottom, 0px) + var(--tps-auto-base-embed-height, 0px) + 8px);
        left: var(--tps-gcm-live-left);
        right: var(--tps-gcm-live-right);
        /* Respect Obsidian UI text scaling */
        font-size: calc(var(--font-ui-medium) * var(--tps-gcm-text-scale));
        z-index: 100000;
        /* Ensure it fits on screen with the higher bottom offset */
        max-height: calc(100vh - 120px); 
        overflow: visible;
        pointer-events: auto;
        --tps-gcm-scale: 1;
        transform: var(--tps-gcm-live-transform);
        transform-origin: center bottom;
        margin-left: 0;
        margin-right: 0;
      }



      .tps-global-context-menu--collapsed.tps-global-context-menu--live,
      .tps-global-context-menu--collapsed.tps-global-context-menu--reading {
        /* Transparent when collapsed */
      }

      .tps-global-context-menu--live .tps-gcm-panel,
      .tps-global-context-menu--reading .tps-gcm-panel {
        padding: calc(4px * var(--tps-gcm-density)) 0 0;
        background: transparent;
        /* Adjust max-height for inner panel */
        max-height: calc(100vh - 200px);
        overflow-y: auto;
        scrollbar-width: thin;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        grid-auto-flow: row dense;
        column-gap: calc(10px * var(--tps-gcm-density));
        row-gap: calc(10px * var(--tps-gcm-density));
      }


      .tps-global-context-menu--live .tps-gcm-title-row,
      .tps-global-context-menu--reading .tps-gcm-title-row,
      .tps-global-context-menu--live .tps-gcm-tags-row,
      .tps-global-context-menu--reading .tps-gcm-tags-row,
      .tps-global-context-menu--live .tps-gcm-actions-row,
      .tps-global-context-menu--reading .tps-gcm-actions-row,
      .tps-global-context-menu--live .tps-gcm-file-ops-row,
      .tps-global-context-menu--reading .tps-gcm-file-ops-row,
      .tps-global-context-menu--live .tps-gcm-multi-banner,
      .tps-global-context-menu--reading .tps-gcm-multi-banner {
        grid-column: 1 / -1;
      }
      .tps-global-context-menu--live .tps-gcm-unified-row,
      .tps-global-context-menu--reading .tps-gcm-unified-row {
        grid-column: 1 / -1;
        width: 100%;
      }
      .tps-global-context-menu--live .tps-gcm-subitems-panel,
      .tps-global-context-menu--reading .tps-gcm-subitems-panel {
        grid-column: 1 / -1;
        width: 100%;
      }
      .tps-gcm-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .tps-gcm-toolbar .tps-gcm-row {
        margin: 0;
        padding: 0;
      }
      .tps-gcm-toolbar .tps-gcm-row > label {
        display: none;
      }
      .tps-gcm-toolbar select,
      .tps-gcm-toolbar input,
      .tps-gcm-toolbar .tps-gcm-actions-row button {
        font-size: 11px;
        padding: 2px 6px;
      }
      .tps-gcm-toolbar .tps-gcm-actions-row {
        gap: 4px;
      }

      /* Hide only non-persistent context menus for keyboard/modal states */
      .tps-context-hidden-for-keyboard .tps-global-context-menu:not(.tps-global-context-menu--persistent) {
        visibility: hidden;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease, visibility 0.15s ease;
      }
      .tps-auto-base-embed-hidden-for-keyboard .tps-global-context-menu:not(.tps-global-context-menu--persistent) {
        visibility: hidden;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease, visibility 0.15s ease;
      }
      .tps-context-hidden-for-modal .tps-global-context-menu:not(.tps-global-context-menu--persistent) {
        visibility: hidden;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease, visibility 0.15s ease;
      }
      /* Also hide all persistent inline UI surfaces when keyboard is visible.
         The JS handler applies inline-styles as the primary mechanism; this
         body-class rule is a belt-and-suspenders CSS fallback. */
      .tps-context-hidden-for-keyboard .tps-global-context-menu--persistent,
      .tps-context-hidden-for-keyboard .tps-gcm-panel,
      .tps-context-hidden-for-keyboard .tps-gcm-note-graph,
      .tps-context-hidden-for-keyboard .tps-gcm-top-parent-nav,
      .tps-context-hidden-for-keyboard .tps-gcm-title-icon,
      .tps-context-hidden-for-keyboard .tps-gcm-note-references {
        visibility: hidden !important;
        opacity: 0 !important;
        pointer-events: none !important;
        transition: opacity 0.15s ease, visibility 0.15s ease;
      }
      
      /* Add transition for smoother show/hide */
      .tps-global-context-menu--persistent {
        transition: opacity 0.15s ease, visibility 0.15s ease;
      }

      /* Gesture collapse: smooth hide/reveal for persistent menu surfaces.
         This mirrors mobile toolbar-style motion instead of abruptly removing nodes. */
      .tps-global-context-menu--persistent {
        transition: opacity 0.22s ease, visibility 0.22s ease;
      }

      .tps-global-context-menu--persistent.tps-gcm-gesture-collapsed {
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
      }
      .tps-gcm-tags {
        display: flex;
        flex-wrap: wrap;
        gap: calc(6px * var(--tps-gcm-density));
      }
      
      /* Inline tags container */
      .tps-gcm-tags-inline {
        display: flex;
        flex-wrap: wrap;
        gap: calc(4px * var(--tps-gcm-density));
        align-items: center;
      }
      
      .tps-gcm-tag {
        background: var(--background-modifier-hover);
        border-radius: 999px;
        padding: calc(1px * var(--tps-gcm-density)) calc(6px * var(--tps-gcm-density));
        font-size: calc(9px * var(--tps-gcm-text-scale));
        display: inline-flex;
        align-items: center;
        gap: calc(4px * var(--tps-gcm-density));
        line-height: 1.2;
        text-transform: uppercase;
        font-weight: 600;
        color: var(--text-muted);
      }
      
      .tps-gcm-tag-removable {
        padding-right: 3px;
      }
      
      .tps-gcm-tag-text {
        display: inline;
      }

      .tps-gcm-tag-link {
        color: inherit;
        text-decoration: underline;
        text-underline-offset: 2px;
        cursor: pointer;
      }

      .tps-gcm-tag-link:hover {
        color: var(--interactive-accent);
      }
      
      .tps-gcm-tag-remove {
        border: none;
        background: transparent;
        color: inherit;
        opacity: 0.6;
        cursor: pointer;
        font-size: calc(14px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        padding: 0 2px;
        line-height: 1;
        font-weight: normal;
        transition: opacity 0.15s ease;
      }
      
      .tps-gcm-tag-remove:hover {
        opacity: 1;
      }

      .tps-gcm-inline-subtask-btn {
        border: 1px solid color-mix(in srgb, var(--interactive-accent) 30%, var(--background-modifier-border));
        background: color-mix(in srgb, var(--background-primary) 78%, var(--interactive-accent) 22%);
        color: color-mix(in srgb, var(--text-normal) 75%, var(--interactive-accent));
        cursor: pointer;
        padding: 0;
        width: 22px;
        height: 22px;
        min-width: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        border-radius: 999px;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
        z-index: 9999;
        position: fixed;
        pointer-events: none;
        backdrop-filter: blur(10px);
        transition: opacity 0.12s ease, color 0.12s ease, border-color 0.12s ease, background 0.12s ease, transform 0.12s ease;
        transform: translateY(0) scale(0.96);
      }

      .tps-gcm-inline-subtask-btn.is-visible {
        opacity: 0.95;
        pointer-events: auto;
        transform: translateY(0) scale(1);
      }

      .tps-gcm-inline-subtask-btn:hover {
        color: var(--interactive-accent);
        opacity: 1;
        border-color: color-mix(in srgb, var(--interactive-accent) 78%, transparent);
        background: color-mix(in srgb, var(--background-primary) 62%, var(--interactive-accent) 38%);
      }

      .cm-line.tps-gcm-inline-subtask-host-hover,
      .task-list-item.tps-gcm-inline-subtask-host-hover,
      li.tps-gcm-inline-subtask-host-hover {
        background: color-mix(in srgb, var(--interactive-accent), transparent 86%) !important;
        border-radius: 6px;
      }

      .cm-line.tps-gcm-inline-subtask-host-blocked,
      .task-list-item.tps-gcm-inline-subtask-host-blocked,
      li.tps-gcm-inline-subtask-host-blocked {
        background: color-mix(in srgb, var(--interactive-accent), transparent 88%) !important;
        border-radius: 6px;
      }

      .tps-gcm-inline-subtask-blocked-section {
        background: color-mix(in srgb, var(--interactive-accent), transparent 88%) !important;
        border-radius: 6px;
      }

      .tps-gcm-inline-subtask-blocked-section > ul,
      .tps-gcm-inline-subtask-blocked-section > ol {
        background: color-mix(in srgb, var(--interactive-accent), transparent 92%) !important;
        border-radius: 6px;
      }

      li.tps-gcm-inline-subtask-host-blocked > ul,
      li.tps-gcm-inline-subtask-host-blocked > ol {
        background: color-mix(in srgb, var(--interactive-accent), transparent 92%) !important;
        border-radius: 6px;
      }

      .tps-gcm-inline-subtask-nested-blocked {
        background: color-mix(in srgb, var(--color-red), transparent 86%) !important;
        border-radius: 6px;
      }

      .tps-gcm-inline-subtask-nested-highlight {
        background: color-mix(in srgb, var(--interactive-accent), transparent 90%) !important;
        border-radius: 6px;
      }

      .cm-line.tps-gcm-inline-subtask-nested-highlight,
      li.tps-gcm-inline-subtask-nested-highlight,
      .task-list-item.tps-gcm-inline-subtask-nested-highlight {
        background: color-mix(in srgb, var(--interactive-accent), transparent 90%) !important;
      }

      .cm-line.tps-gcm-inline-subtask-nested-blocked,
      li.tps-gcm-inline-subtask-nested-blocked,
      .task-list-item.tps-gcm-inline-subtask-nested-blocked {
        background: color-mix(in srgb, var(--color-red), transparent 86%) !important;
      }

      .tps-gcm-inline-subtask-nested-blocked .list-bullet,
      .tps-gcm-inline-subtask-nested-blocked .cm-formatting-list {
        color: color-mix(in srgb, var(--color-red), var(--text-muted) 45%) !important;
      }

      .tps-gcm-inline-subtask-btn.is-blocked {
        border-color: color-mix(in srgb, var(--color-red), transparent 45%);
        background: color-mix(in srgb, var(--background-primary) 72%, var(--color-red) 28%);
        cursor: not-allowed;
      }

      .tps-gcm-linked-subitem-task .tps-gcm-linked-subitem-link,
      .tps-gcm-linked-subitem-task .internal-link,
      .tps-gcm-linked-subitem-task .cm-hmd-internal-link {
        text-decoration: none;
      }

      li.tps-gcm-linked-subitem-task,
      .task-list-item.tps-gcm-linked-subitem-task,
      p.tps-gcm-linked-subitem-task,
      .cm-line.tps-gcm-linked-subitem-task {
        position: relative;
        min-width: 0;
        --tps-gcm-linked-subitem-gap: 6px;
        --tps-gcm-linked-subitem-checkbox-gap: 8px;
      }

      .cm-line.tps-gcm-linked-subitem-task {
        display: block !important;
        border-radius: 0;
        padding-left: 0 !important;
        border-left: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
        outline: none !important;
      }

      .cm-line.tps-gcm-linked-subitem-task,
      .cm-line.tps-gcm-linked-subitem-task.HyperMD-task-line,
      .cm-line.tps-gcm-linked-subitem-task.cm-active,
      .cm-line.tps-gcm-linked-subitem-task.cm-active.HyperMD-task-line {
        background: transparent !important;
        box-shadow: none !important;
        border: 0 !important;
        outline: none !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.HyperMD-task-line,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.cm-active,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.cm-active.HyperMD-task-line {
        display: block !important;
        white-space: nowrap !important;
        overflow: visible !important;
        text-indent: 0 !important;
        padding-top: 0 !important;
        padding-bottom: 0 !important;
        padding-right: 0 !important;
        min-height: 0 !important;
        line-height: inherit !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task::before,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task::after {
        content: none !important;
        display: none !important;
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task > * {
        align-self: center !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task *,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task *::before,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task *::after {
        box-shadow: none !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task input.task-list-item-checkbox,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task .task-list-item-checkbox {
        margin: 0 var(--tps-gcm-linked-subitem-checkbox-gap) 0 0 !important;
        transform: none !important;
        vertical-align: middle !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task .tps-gcm-linked-subitem-cm-widget,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task .tps-gcm-linked-subitem-row-content.is-cm-widget {
        margin-left: 0 !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.HyperMD-task-line,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.cm-active,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.cm-active.HyperMD-task-line {
        white-space: nowrap !important;
        overflow-x: auto !important;
        overflow-y: hidden !important;
        scrollbar-width: thin;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.kind-checkbox .tps-gcm-linked-subitem-cm-widget,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.kind-checkbox .tps-gcm-linked-subitem-row-content.is-cm-widget,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.kind-bullet .tps-gcm-linked-subitem-cm-widget,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.kind-bullet .tps-gcm-linked-subitem-row-content.is-cm-widget {
        margin-left: 4px !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task .cm-formatting-task {
        margin: 0 !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task .cm-formatting-list,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task [class*="cm-formatting-list"],
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task .cm-indent {
        margin: 0 !important;
        padding: 0 !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.kind-checkbox .cm-formatting-list,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.kind-checkbox [class*="cm-formatting-list"] {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        min-width: 1.45em !important;
        font-size: 1.28em !important;
        padding-right: 4px !important;
        line-height: 1 !important;
        color: var(--text-faint) !important;
        opacity: 1 !important;
        transform: scale(1.75) !important;
        transform-origin: center !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.kind-checkbox .cm-list-1,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.kind-checkbox .cm-list-2,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.kind-checkbox .cm-list-3,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task.kind-checkbox .cm-list-4 {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        min-width: 1.45em !important;
        font-size: 1.28em !important;
        padding-right: 4px !important;
        line-height: 1 !important;
        color: var(--text-faint) !important;
        opacity: 1 !important;
        transform: scale(1.75) !important;
        transform-origin: center !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task .cm-indent {
        display: inline-block !important;
        width: auto !important;
        min-width: unset !important;
        overflow: visible !important;
        opacity: 1 !important;
        margin: 0 !important;
        padding: 0 !important;
      }

      .tps-gcm-linked-subitem-row,
      .tps-gcm-linked-subitem-row-content {
        display: inline-flex !important;
        align-items: center;
        gap: var(--tps-gcm-linked-subitem-gap);
        flex-wrap: nowrap !important;
        min-width: 0 !important;
        max-width: none !important;
        white-space: nowrap;
        width: auto !important;
        background: transparent !important;
        box-shadow: none !important;
        border: 0 !important;
        overflow: visible !important;
        scrollbar-width: thin;
        -webkit-overflow-scrolling: touch;
        vertical-align: middle !important;
      }

      .tps-gcm-linked-subitem-link {
        display: inline-flex;
        align-items: center;
        flex: 0 0 auto;
        white-space: nowrap;
        overflow: visible;
        text-overflow: clip;
        max-width: none;
        min-width: max-content !important;
        cursor: pointer;
      }

      button.tps-gcm-linked-subitem-link {
        appearance: none;
        background: none;
        border: 0;
        padding: 0;
        margin: 0;
        color: inherit;
        font: inherit;
        text-align: left;
      }

      .tps-gcm-linked-subitem-link-widget {
        margin-left: 0;
      }

      .tps-gcm-linked-subitem-props-widget {
        margin-left: 6px;
      }

      li.tps-gcm-linked-subitem-task > p.tps-gcm-linked-subitem-row,
      li.tps-gcm-linked-subitem-task > div.tps-gcm-linked-subitem-row,
      li.tps-gcm-linked-subitem-task > span.tps-gcm-linked-subitem-row-content {
        display: inline-flex !important;
        margin: 0;
        min-width: 0 !important;
        max-width: none !important;
        width: auto !important;
        white-space: nowrap !important;
        vertical-align: middle;
        overflow: visible !important;
      }

      .tps-gcm-linked-subitem-checkbox {
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        color: var(--text-muted);
        width: 18px;
        height: 18px;
        min-width: 18px;
        border-radius: 5px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
        margin-right: 8px;
        vertical-align: middle;
        transition: opacity 0.1s ease, background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease;
        flex-shrink: 0;
      }


      .tps-gcm-linked-subitem-checkbox.is-cm-widget {
        margin-right: 10px;
      }

      .markdown-source-view.mod-cm6.is-live-preview .tps-gcm-linked-subitem-checkbox.is-cm-widget {
        width: 21px;
        height: 21px;
        min-width: 21px;
        padding: 3px;
        border-radius: 6px;
        margin-right: 14px;
        accent-color: var(--interactive-accent);
      }

      .tps-gcm-linked-subitem-checkbox.is-bullet {
        border-color: transparent;
        background: transparent;
      }

      /* Hide native checkbox only when explicitly marked hidden in Live Preview */
      .cm-line input.task-list-item-checkbox.tps-gcm-linked-subitem-checkbox-hidden,
      .cm-line .task-list-item-checkbox.tps-gcm-linked-subitem-checkbox-hidden,
      .cm-line .cm-formatting-task.tps-gcm-linked-subitem-checkbox-hidden {
        opacity: 0 !important;
        width: 0 !important;
        height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        position: absolute !important;
      }

      .markdown-reading-view input.task-list-item-checkbox.tps-gcm-linked-subitem-checkbox-hidden,
      .markdown-preview-view input.task-list-item-checkbox.tps-gcm-linked-subitem-checkbox-hidden {
        display: none !important;
        width: 0 !important;
        height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
      }

      /* Hide native links in reading mode when replaced by custom row */
      .tps-gcm-hidden-native-link {
        display: none !important;
        font-size: 0 !important;
        width: 0 !important;
        height: 0 !important;
        overflow: hidden !important;
      }

      /* Row content container - unified structure for both modes */
      .tps-gcm-linked-subitem-row-content {
        display: inline-flex !important;
        align-items: center;
        gap: var(--tps-gcm-linked-subitem-gap);
        flex-wrap: nowrap;
        vertical-align: baseline;
        position: relative;
        min-width: 0 !important;
        max-width: none !important;
        width: auto !important;
        overflow: visible !important;
      }

      .tps-gcm-linked-subitem-row-content.is-cm-widget,
      .tps-gcm-linked-subitem-cm-widget {
        display: inline-flex !important;
        align-items: center;
        gap: var(--tps-gcm-linked-subitem-gap);
        flex-wrap: nowrap;
        vertical-align: baseline;
        width: auto !important;
        min-width: 0 !important;
        max-width: none !important;
        background: transparent !important;
        box-shadow: none !important;
        border: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        position: relative;
        overflow: visible !important;
      }

      .tps-gcm-linked-subitem-row-content.has-leading-bullet,
      .tps-gcm-linked-subitem-cm-widget.has-leading-bullet {
        gap: 3px !important;
      }

      .tps-gcm-linked-subitem-bullet-marker {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 0.52em;
        min-width: 0.52em;
        margin-right: -1px;
        font-size: 0.98em;
        color: var(--text-faint);
        line-height: 1;
        flex-shrink: 0;
        cursor: pointer;
        pointer-events: auto;
        user-select: none;
      }

      .markdown-source-view.mod-cm6.is-live-preview .tps-gcm-linked-subitem-cm-widget.has-leading-bullet .tps-gcm-linked-subitem-bullet-marker,
      .markdown-source-view.mod-cm6.is-live-preview .tps-gcm-linked-subitem-row-content.is-cm-widget.has-leading-bullet .tps-gcm-linked-subitem-bullet-marker {
        width: 0.95em;
        min-width: 0.95em;
        margin-right: 7px;
        font-size: 1.55em;
        line-height: 1;
      }

      .tps-gcm-linked-subitem-link {
        color: var(--link-color);
      }

      .tps-gcm-linked-subitem-link:hover {
        color: var(--link-color-hover);
      }

      /* Pills container */
      .tps-gcm-linked-subitem-pills {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex-wrap: nowrap;
        margin-left: 0;
        min-width: max-content;
        max-width: none;
        overflow: visible;
        flex: 0 0 auto !important;
        flex-shrink: 0 !important;
      }

      .task-list-item.tps-gcm-linked-subitem-task,
      li.tps-gcm-linked-subitem-task {
        list-style-position: outside !important;
        list-style-type: disc !important;
        padding-left: 0 !important;
        margin-left: 0 !important;
        text-indent: 0 !important;
      }

      .task-list-item.tps-gcm-linked-subitem-task::marker,
      li.tps-gcm-linked-subitem-task::marker {
        color: var(--text-faint);
      }

      .tps-gcm-linked-subitem-checkbox {
        margin-right: 0;
        cursor: pointer;
      }

      .tps-gcm-linked-subitem-pill {
        display: inline-flex;
        align-items: center;
        border: 1px solid var(--background-modifier-border);
        border-radius: 999px;
        background: var(--background-modifier-form-field);
        color: var(--text-muted);
        font-size: 0.85em;
        font-weight: 500;
        padding: 1px 4px;
        margin-left: 0;
        cursor: pointer;
        white-space: nowrap;
        opacity: 1;
        visibility: visible;
        width: auto !important;
        min-width: 0 !important;
        max-width: max-content !important;
        flex: 0 0 auto !important;
      }

      .tps-gcm-linked-subitem-pill:hover {
        border-color: var(--interactive-accent);
        background: color-mix(in srgb, var(--background-modifier-hover), var(--background-primary));
      }

      .tps-gcm-linked-subitem-pill--status {
        color: var(--text-muted);
      }

      .tps-gcm-linked-subitem-pill--priority {
        color: var(--text-muted);
      }

      .tps-gcm-linked-subitem-pill--scheduled {
        color: var(--text-muted);
      }

      .tps-gcm-linked-subitem-pill--tag {
        color: var(--text-accent);
      }

      .tps-gcm-linked-subitem-pill--folder {
        color: var(--text-muted);
      }

      .tps-gcm-linked-subitem-pill--action {
        color: var(--text-muted);
      }

      /* CodeMirror widget context - ensure pills are visible in live preview */
      .cm-widget .tps-gcm-linked-subitem-pill,
      .cm-content .tps-gcm-linked-subitem-pill,
      .cm-line .tps-gcm-linked-subitem-pill {
        display: inline-block;
        opacity: 1;
        visibility: visible;
        font-size: 0.85em !important;
        line-height: 1.2 !important;
      }

      /* Wikilink mark decoration in live preview - style without replacing */
      .cm-line .tps-gcm-linked-subitem-wikilink {
        font-weight: 600;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task .tps-gcm-linked-subitem-wikilink-hidden {
        display: inline-block !important;
        width: 0 !important;
        min-width: 0 !important;
        max-width: 0 !important;
        overflow: hidden !important;
        opacity: 0 !important;
        color: transparent !important;
        font-size: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        pointer-events: none !important;
        vertical-align: middle !important;
      }

      /* CodeMirror widget wrapper for pills */
      .tps-gcm-linked-subitem-cm-widget {
        display: inline-flex;
        align-items: center;
        flex-wrap: nowrap;
        gap: var(--tps-gcm-linked-subitem-gap);
        vertical-align: middle;
        line-height: inherit;
        min-width: 0;
        max-width: none;
        overflow: visible;
        background: transparent !important;
        box-shadow: none !important;
        border: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        width: fit-content !important;
      }

      .tps-gcm-linked-subitem-pills-only {
        display: inline-flex !important;
        align-items: center !important;
        margin-left: 6px !important;
        gap: 4px !important;
        vertical-align: middle !important;
        max-width: min(100%, 70vw) !important;
        overflow-x: auto !important;
        overflow-y: hidden !important;
        white-space: nowrap !important;
        scrollbar-width: thin;
        line-height: inherit !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-widget .tps-gcm-linked-subitem-pills-only,
      .markdown-source-view.mod-cm6.is-live-preview .tps-gcm-linked-subitem-pills-only {
        display: inline-flex !important;
        align-items: center !important;
        visibility: visible !important;
        opacity: 1 !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task .cm-widgetBuffer,
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task .cm-widget:has(> .tps-gcm-linked-subitem-cm-widget),
      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task .cm-widget .tps-gcm-linked-subitem-cm-widget {
        display: inline-flex !important;
        align-items: center !important;
        width: auto !important;
        min-width: 0 !important;
        max-width: none !important;
        overflow: visible !important;
        opacity: 1 !important;
        visibility: visible !important;
        flex: 0 1 auto !important;
        vertical-align: middle !important;
      }

      .tps-gcm-linked-subitem-caret-spacer {
        display: inline-block;
        width: 0.5ch;
        min-width: 0.5ch;
        opacity: 0;
        pointer-events: none;
        user-select: none;
        white-space: pre;
      }

      /* Ensure widget pills inherit proper styling */
      .tps-gcm-linked-subitem-cm-widget .tps-gcm-linked-subitem-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        max-width: max-content;
        overflow: hidden;
        text-overflow: ellipsis;
        width: auto !important;
        min-width: 0 !important;
        flex: 0 0 auto !important;
      }

      .markdown-source-view.mod-cm6.is-live-preview .cm-line.tps-gcm-linked-subitem-task .tps-gcm-linked-subitem-pill {
        background: var(--background-modifier-form-field) !important;
        border-color: var(--background-modifier-border) !important;
      }

      /* Reading mode should mirror the clean inline live-preview row, not a full-width card. */
      .markdown-reading-view li.task-list-item.tps-gcm-linked-subitem-task,
      .markdown-preview-view li.task-list-item.tps-gcm-linked-subitem-task,
      .markdown-reading-view li.tps-gcm-linked-subitem-task,
      .markdown-preview-view li.tps-gcm-linked-subitem-task {
        display: list-item !important;
        position: relative !important;
        background: transparent !important;
        box-shadow: none !important;
        border: 0 !important;
        border-radius: 0 !important;
        padding: 0 !important;
        margin: 0 !important;
        margin-left: 0 !important;
        line-height: inherit !important;
        min-height: 0 !important;
        list-style-position: outside !important;
        list-style-type: disc !important;
        text-indent: 0 !important;
      }

      .markdown-reading-view ul:has(> li.tps-gcm-linked-subitem-task),
      .markdown-preview-view ul:has(> li.tps-gcm-linked-subitem-task),
      .markdown-reading-view ol:has(> li.tps-gcm-linked-subitem-task),
      .markdown-preview-view ol:has(> li.tps-gcm-linked-subitem-task),
      .markdown-reading-view ul:has(> li.task-list-item.tps-gcm-linked-subitem-task),
      .markdown-preview-view ul:has(> li.task-list-item.tps-gcm-linked-subitem-task),
      .markdown-reading-view ol:has(> li.task-list-item.tps-gcm-linked-subitem-task),
      .markdown-preview-view ol:has(> li.task-list-item.tps-gcm-linked-subitem-task) {
        margin-block-start: 0 !important;
        margin-block-end: 0 !important;
        margin-top: 0 !important;
        margin-bottom: 0 !important;
        padding-top: 0 !important;
        padding-bottom: 0 !important;
      }

      .markdown-reading-view li.tps-gcm-linked-subitem-task + li.tps-gcm-linked-subitem-task,
      .markdown-preview-view li.tps-gcm-linked-subitem-task + li.tps-gcm-linked-subitem-task,
      .markdown-reading-view li.task-list-item.tps-gcm-linked-subitem-task + li.task-list-item.tps-gcm-linked-subitem-task,
      .markdown-preview-view li.task-list-item.tps-gcm-linked-subitem-task + li.task-list-item.tps-gcm-linked-subitem-task {
        margin-top: 0 !important;
      }

      .markdown-reading-view li.task-list-item.tps-gcm-linked-subitem-task > p,
      .markdown-preview-view li.task-list-item.tps-gcm-linked-subitem-task > p,
      .markdown-reading-view li.tps-gcm-linked-subitem-task > p,
      .markdown-preview-view li.tps-gcm-linked-subitem-task > p {
        display: flex !important;
        align-items: center !important;
        flex-wrap: nowrap !important;
        gap: var(--tps-gcm-linked-subitem-gap) !important;
        margin: 0 !important;
        min-width: 0 !important;
        max-width: none !important;
        width: auto !important;
        background: transparent !important;
        box-shadow: none !important;
        border: 0 !important;
        line-height: inherit !important;
        white-space: nowrap !important;
        overflow-x: auto !important;
        overflow-y: hidden !important;
        scrollbar-width: thin;
      }

      .markdown-reading-view li.task-list-item.tps-gcm-linked-subitem-task > input.task-list-item-checkbox,
      .markdown-preview-view li.task-list-item.tps-gcm-linked-subitem-task > input.task-list-item-checkbox,
      .markdown-reading-view li.tps-gcm-linked-subitem-task > input.task-list-item-checkbox,
      .markdown-preview-view li.tps-gcm-linked-subitem-task > input.task-list-item-checkbox {
        margin: 0 var(--tps-gcm-linked-subitem-checkbox-gap) 0 0 !important;
        align-self: center !important;
      }

      .markdown-reading-view li.task-list-item.tps-gcm-linked-subitem-task > .list-bullet,
      .markdown-preview-view li.task-list-item.tps-gcm-linked-subitem-task > .list-bullet,
      .markdown-reading-view li.tps-gcm-linked-subitem-task > .list-bullet,
      .markdown-preview-view li.tps-gcm-linked-subitem-task > .list-bullet {
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 1.05em !important;
        min-width: 1.05em !important;
        margin: 0 6px 0 0 !important;
        vertical-align: middle !important;
        color: var(--text-faint) !important;
        opacity: 1 !important;
        overflow: visible !important;
      }

      .markdown-reading-view li.task-list-item.tps-gcm-linked-subitem-task.kind-checkbox > .list-bullet,
      .markdown-preview-view li.task-list-item.tps-gcm-linked-subitem-task.kind-checkbox > .list-bullet,
      .markdown-reading-view li.tps-gcm-linked-subitem-task.kind-checkbox > .list-bullet,
      .markdown-preview-view li.tps-gcm-linked-subitem-task.kind-checkbox > .list-bullet {
        display: none !important;
      }

      .markdown-reading-view li.tps-gcm-linked-subitem-task .tps-gcm-linked-subitem-row-content.is-reading-mode,
      .markdown-preview-view li.tps-gcm-linked-subitem-task .tps-gcm-linked-subitem-row-content.is-reading-mode,
      .markdown-reading-view li.task-list-item.tps-gcm-linked-subitem-task .tps-gcm-linked-subitem-row-content.is-reading-mode,
      .markdown-preview-view li.task-list-item.tps-gcm-linked-subitem-task .tps-gcm-linked-subitem-row-content.is-reading-mode {
        display: flex !important;
        align-items: center !important;
        gap: var(--tps-gcm-linked-subitem-gap) !important;
        margin: 0 !important;
        padding: 0 !important;
        line-height: inherit !important;
        background: transparent !important;
        box-shadow: none !important;
        border: 0 !important;
        min-width: 0 !important;
        max-width: none !important;
        width: 100% !important;
        overflow-x: auto !important;
        overflow-y: hidden !important;
      }

      .markdown-reading-view li.task-list-item.tps-gcm-linked-subitem-task.kind-checkbox > .tps-gcm-linked-subitem-row-content.is-reading-mode,
      .markdown-preview-view li.task-list-item.tps-gcm-linked-subitem-task.kind-checkbox > .tps-gcm-linked-subitem-row-content.is-reading-mode,
      .markdown-reading-view li.tps-gcm-linked-subitem-task.kind-checkbox > .tps-gcm-linked-subitem-row-content.is-reading-mode,
      .markdown-preview-view li.tps-gcm-linked-subitem-task.kind-checkbox > .tps-gcm-linked-subitem-row-content.is-reading-mode {
        gap: 4px !important;
        margin-left: 6px !important;
      }

      .markdown-reading-view li.task-list-item.tps-gcm-linked-subitem-task.kind-bullet > .tps-gcm-linked-subitem-row-content.is-reading-mode,
      .markdown-preview-view li.task-list-item.tps-gcm-linked-subitem-task.kind-bullet > .tps-gcm-linked-subitem-row-content.is-reading-mode,
      .markdown-reading-view li.tps-gcm-linked-subitem-task.kind-bullet > .tps-gcm-linked-subitem-row-content.is-reading-mode,
      .markdown-preview-view li.tps-gcm-linked-subitem-task.kind-bullet > .tps-gcm-linked-subitem-row-content.is-reading-mode {
        margin-left: 6px !important;
      }

      .markdown-reading-view li.task-list-item.tps-gcm-linked-subitem-task.kind-checkbox,
      .markdown-preview-view li.task-list-item.tps-gcm-linked-subitem-task.kind-checkbox,
      .markdown-reading-view li.tps-gcm-linked-subitem-task.kind-checkbox,
      .markdown-preview-view li.tps-gcm-linked-subitem-task.kind-checkbox,
      .markdown-reading-view li.task-list-item.tps-gcm-linked-subitem-task.kind-bullet,
      .markdown-preview-view li.task-list-item.tps-gcm-linked-subitem-task.kind-bullet,
      .markdown-reading-view li.tps-gcm-linked-subitem-task.kind-bullet,
      .markdown-preview-view li.tps-gcm-linked-subitem-task.kind-bullet {
        padding-left: 13px !important;
      }

      .markdown-reading-view li.task-list-item.tps-gcm-linked-subitem-task.kind-checkbox > .tps-gcm-linked-subitem-row-content.is-reading-mode > .tps-gcm-linked-subitem-checkbox,
      .markdown-preview-view li.task-list-item.tps-gcm-linked-subitem-task.kind-checkbox > .tps-gcm-linked-subitem-row-content.is-reading-mode > .tps-gcm-linked-subitem-checkbox,
      .markdown-reading-view li.tps-gcm-linked-subitem-task.kind-checkbox > .tps-gcm-linked-subitem-row-content.is-reading-mode > .tps-gcm-linked-subitem-checkbox,
      .markdown-preview-view li.tps-gcm-linked-subitem-task.kind-checkbox > .tps-gcm-linked-subitem-row-content.is-reading-mode > .tps-gcm-linked-subitem-checkbox {
        margin-right: 2px !important;
      }

      body[data-tps-gcm-linked-subitem-style="soft-link"] li.tps-gcm-linked-subitem-task,
      body[data-tps-gcm-linked-subitem-style="soft-link"] .task-list-item.tps-gcm-linked-subitem-task,
      body[data-tps-gcm-linked-subitem-style="soft-link"] p.tps-gcm-linked-subitem-task {
        border-radius: 0;
        transition: color 0.15s ease;
      }

      body[data-tps-gcm-linked-subitem-style="soft-link"] li.tps-gcm-linked-subitem-task.is-open,
      body[data-tps-gcm-linked-subitem-style="soft-link"] .task-list-item.tps-gcm-linked-subitem-task.is-open,
      body[data-tps-gcm-linked-subitem-style="soft-link"] p.tps-gcm-linked-subitem-task.is-open {
        background: transparent !important;
      }

      /* Green complete-state background removed - styling now driven by status mapping only */
      body[data-tps-gcm-linked-subitem-style="soft-link"] li.tps-gcm-linked-subitem-task.is-complete,
      body[data-tps-gcm-linked-subitem-style="soft-link"] .task-list-item.tps-gcm-linked-subitem-task.is-complete,
      body[data-tps-gcm-linked-subitem-style="soft-link"] p.tps-gcm-linked-subitem-task.is-complete {
        /* Default bullet styling for complete items - no special background */
      }

      body[data-tps-gcm-linked-subitem-style="soft-link"] li.tps-gcm-linked-subitem-task.is-canceled,
      body[data-tps-gcm-linked-subitem-style="soft-link"] .task-list-item.tps-gcm-linked-subitem-task.is-canceled,
      body[data-tps-gcm-linked-subitem-style="soft-link"] p.tps-gcm-linked-subitem-task.is-canceled {
        opacity: 0.84;
      }

      body[data-tps-gcm-linked-subitem-style="accent"] li.tps-gcm-linked-subitem-task,
      body[data-tps-gcm-linked-subitem-style="accent"] .task-list-item.tps-gcm-linked-subitem-task,
      body[data-tps-gcm-linked-subitem-style="accent"] p.tps-gcm-linked-subitem-task {
        border-left: 3px solid var(--interactive-accent);
        padding-left: 6px;
        border-radius: 6px;
      }

      body[data-tps-gcm-linked-subitem-style="accent"] li.tps-gcm-linked-subitem-task.is-complete,
      body[data-tps-gcm-linked-subitem-style="accent"] .task-list-item.tps-gcm-linked-subitem-task.is-complete,
      body[data-tps-gcm-linked-subitem-style="accent"] p.tps-gcm-linked-subitem-task.is-complete {
        border-left-color: var(--color-green);
      }

      body[data-tps-gcm-linked-subitem-style="accent"] li.tps-gcm-linked-subitem-task.is-canceled,
      body[data-tps-gcm-linked-subitem-style="accent"] .task-list-item.tps-gcm-linked-subitem-task.is-canceled,
      body[data-tps-gcm-linked-subitem-style="accent"] p.tps-gcm-linked-subitem-task.is-canceled {
        border-left-color: var(--color-orange);
        opacity: 0.82;
      }

      /* Heading-style linked subitems */
      h1.tps-gcm-linked-subitem-task.kind-heading,
      h2.tps-gcm-linked-subitem-task.kind-heading,
      h3.tps-gcm-linked-subitem-task.kind-heading,
      h4.tps-gcm-linked-subitem-task.kind-heading,
      h5.tps-gcm-linked-subitem-task.kind-heading,
      h6.tps-gcm-linked-subitem-task.kind-heading {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: nowrap;
      }

      h1.tps-gcm-linked-subitem-task.kind-heading > .tps-gcm-linked-subitem-checkbox,
      h2.tps-gcm-linked-subitem-task.kind-heading > .tps-gcm-linked-subitem-checkbox,
      h3.tps-gcm-linked-subitem-task.kind-heading > .tps-gcm-linked-subitem-checkbox,
      h4.tps-gcm-linked-subitem-task.kind-heading > .tps-gcm-linked-subitem-checkbox,
      h5.tps-gcm-linked-subitem-task.kind-heading > .tps-gcm-linked-subitem-checkbox,
      h6.tps-gcm-linked-subitem-task.kind-heading > .tps-gcm-linked-subitem-checkbox {
        flex-shrink: 0;
      }

      h1.tps-gcm-linked-subitem-task.kind-heading > a.internal-link,
      h2.tps-gcm-linked-subitem-task.kind-heading > a.internal-link,
      h3.tps-gcm-linked-subitem-task.kind-heading > a.internal-link,
      h4.tps-gcm-linked-subitem-task.kind-heading > a.internal-link,
      h5.tps-gcm-linked-subitem-task.kind-heading > a.internal-link,
      h6.tps-gcm-linked-subitem-task.kind-heading > a.internal-link {
        flex: 1;
      }

      h1.tps-gcm-linked-subitem-task.kind-heading > .tps-gcm-linked-subitem-pills,
      h2.tps-gcm-linked-subitem-task.kind-heading > .tps-gcm-linked-subitem-pills,
      h3.tps-gcm-linked-subitem-task.kind-heading > .tps-gcm-linked-subitem-pills,
      h4.tps-gcm-linked-subitem-task.kind-heading > .tps-gcm-linked-subitem-pills,
      h5.tps-gcm-linked-subitem-task.kind-heading > .tps-gcm-linked-subitem-pills,
      h6.tps-gcm-linked-subitem-task.kind-heading > .tps-gcm-linked-subitem-pills {
        flex-shrink: 0;
      }

      .cm-line.tps-gcm-linked-subitem-task.kind-heading .cm-formatting-header {
        margin-right: 4px;
      }

      .tps-gcm-tag-add {
        border: 1px dashed var(--text-muted);
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        font-size: calc(10px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        padding: calc(1px * var(--tps-gcm-control-scale)) calc(6px * var(--tps-gcm-control-scale));
        border-radius: 999px;
        font-weight: bold;
        transition: all 0.15s ease;
      }
      
      .tps-gcm-tag-add:hover {
        border-color: var(--interactive-accent);
        color: var(--interactive-accent);
      }
      
      .tps-gcm-tag button {
        border: none;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        font-size: calc(11px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        padding: 0;
      }
      
      /* File operations row */
      .tps-gcm-file-ops-row {
        padding-top: calc(8px * var(--tps-gcm-density));
        border-top: 1px solid var(--background-modifier-border);
        margin-top: calc(4px * var(--tps-gcm-density));
      }
      .tps-global-context-menu--live .tps-gcm-row label,
      .tps-global-context-menu--reading .tps-gcm-row label,
      .tps-global-context-menu--live .tps-gcm-file-op-btn,
      .tps-global-context-menu--reading .tps-gcm-file-op-btn,
      .tps-global-context-menu--live .tps-gcm-tag,
      .tps-global-context-menu--reading .tps-gcm-tag,
      .tps-global-context-menu--live .tps-gcm-file-title,
      .tps-global-context-menu--reading .tps-gcm-file-title {
        font-size: 0.95em;
      }

      
      .tps-gcm-file-ops {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      
      .tps-gcm-file-op-btn {
        display: inline-flex;
        align-items: center;
        gap: calc(4px * var(--tps-gcm-density));
        padding: calc(1px * var(--tps-gcm-control-scale) * var(--tps-gcm-density)) calc(5px * var(--tps-gcm-control-scale) * var(--tps-gcm-density));
        border: 1px solid var(--background-modifier-border);
        border-radius: calc(6px * var(--tps-gcm-control-scale) * var(--tps-gcm-radius-scale));
        background: var(--background-primary);
        color: var(--text-muted);
        cursor: pointer;
        font-size: calc(9px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        transition: all 0.15s ease;
      }

      
      .tps-gcm-file-op-btn:hover {
        background: var(--background-modifier-hover);
        color: var(--text-normal);
        border-color: var(--interactive-accent);
      }
      
      .tps-gcm-file-op-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      
      .tps-gcm-file-op-icon svg {
        width: calc(10px * var(--tps-gcm-button-scale));
        height: calc(10px * var(--tps-gcm-button-scale));
      }
      
      .tps-gcm-file-op-label {
        white-space: nowrap;
      }
      
      .tps-gcm-panel--hidden {
        display: none;
      }
      .tps-gcm-panel-toggle {
        display: flex;
        justify-content: flex-end;
        padding: 6px 14px 10px;
      }
      .tps-gcm-panel-toggle button {
        font-size: calc(11px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        border: none;
        cursor: pointer;
        color: var(--interactive-accent);
        background: transparent;
      }
      .tps-gcm-add-row {
        display: flex;
        gap: 6px;
      }
      .tps-gcm-add-row .tps-gcm-input-wrapper {
        flex: 1;
      }
      .tps-gcm-add-row button {
        border-radius: calc(5px * var(--tps-gcm-control-scale));
        border: 1px solid var(--background-modifier-border);
        background: var(--background-modifier-hover);
        padding: calc(3px * var(--tps-gcm-control-scale)) calc(6px * var(--tps-gcm-control-scale));
        font-size: calc(11px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        cursor: pointer;
        white-space: nowrap;
      }
      .tps-gcm-dropdown {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        border: 1px solid var(--background-modifier-border);
        border-radius: 6px;
        background: var(--background-primary);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
        max-height: 200px;
        overflow-y: auto;
        z-index: 10000;
      }
      .tps-gcm-dropdown-item {
        padding: 6px 10px;
        cursor: pointer;
      }
      .tps-gcm-dropdown-item:hover {
        background: var(--background-modifier-hover);
      }
      .tps-gcm-input-button {
        width: 100%;
        border-radius: calc(5px * var(--tps-gcm-control-scale));
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        color: var(--text-normal);
        padding: calc(4px * var(--tps-gcm-control-scale)) calc(6px * var(--tps-gcm-control-scale));
        font-size: calc(12px * var(--tps-gcm-text-scale) * var(--tps-gcm-control-scale));
        text-align: left;
        cursor: pointer;
      }

      .tps-gcm-input-select {
        width: 100%;
        border-radius: calc(5px * var(--tps-gcm-control-scale));
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        color: var(--text-normal);
        padding: calc(4px * var(--tps-gcm-control-scale)) calc(6px * var(--tps-gcm-control-scale));
        font-size: calc(12px * var(--tps-gcm-text-scale) * var(--tps-gcm-control-scale));
        cursor: pointer;
        appearance: none;
        -webkit-appearance: none;
      }
      .tps-gcm-recurrence-options {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .tps-gcm-recurrence-options button {
        flex: 1 1 40%;
        border-radius: calc(6px * var(--tps-gcm-control-scale));
        border: 1px solid var(--background-modifier-border);
        background: var(--background-primary);
        color: var(--text-normal);
        padding: calc(6px * var(--tps-gcm-control-scale));
        cursor: pointer;
        font-size: calc(12px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
      }
      .tps-gcm-recurrence-header {
        font-size: calc(11px * var(--tps-gcm-text-scale));
        text-transform: uppercase;
        color: var(--text-muted);
        letter-spacing: 0.1em;
      }
      .tps-gcm-recurrence-actions {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
      }
      .tps-gcm-recurrence-actions button {
        border-radius: calc(5px * var(--tps-gcm-control-scale));
        border: 1px solid var(--background-modifier-border);
        background: var(--background-modifier-hover);
        color: var(--text-normal);
        padding: calc(4px * var(--tps-gcm-control-scale)) calc(8px * var(--tps-gcm-control-scale));
        font-size: calc(11px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        cursor: pointer;
      }
      .tps-gcm-actions-row {
        display: flex;
        justify-content: space-between;
        gap: 6px;
        margin-top: 4px;
      }
      .tps-gcm-actions-row button {
        flex: 1;
        border-radius: calc(5px * var(--tps-gcm-control-scale));
        border: 1px solid var(--background-modifier-border);
        background: var(--background-modifier-hover);
        color: var(--text-normal);
        padding: calc(4px * var(--tps-gcm-control-scale)) calc(6px * var(--tps-gcm-control-scale));
        font-size: calc(11px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
        cursor: pointer;
      }
      .tps-gcm-actions-row button.tps-gcm-actions-delete {
        color: var(--text-accent);
      }
      .tps-gcm-native-menu-section {
        border-top: 1px solid var(--background-modifier-border);
        padding: 8px 0;
        margin-top: 4px;
      }
      .tps-gcm-section-header {
        padding: 4px 14px 8px;
        font-size: calc(11px * var(--tps-gcm-text-scale));
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--text-muted);
      }
      .tps-gcm-native-items {
        display: flex;
        flex-direction: column;
      }
      .tps-gcm-native-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        border: 1px solid transparent;
        background: transparent;
        padding: 6px 14px;
        text-align: left;
        cursor: pointer;
        color: var(--text-normal);
        font-size: calc(13px * var(--tps-gcm-text-scale));
      }

      /* Mobile: smaller action / file-op buttons (collapse handled elsewhere) */
      @media (max-width: 640px) {
        .tps-gcm-actions-row button,
        .tps-gcm-add-row button,
        .tps-gcm-input-button,
        .tps-gcm-input-select,
        .tps-gcm-file-op-btn {
          font-size: calc(9px * var(--tps-gcm-text-scale) * var(--tps-gcm-button-scale));
          padding: calc(2px * var(--tps-gcm-control-scale)) calc(4px * var(--tps-gcm-control-scale));
        }

        .tps-gcm-file-op-icon svg {
          width: 10px;
          height: 10px;
        }
      }

      /* --- NEW CONTEXT STRIP LAYOUT --- */
      
      .tps-gcm-unified-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: calc(8px * var(--tps-gcm-density));
        padding: calc(2px * var(--tps-gcm-density)) calc(8px * var(--tps-gcm-density));
        width: 100%;
        min-width: 0;
        box-sizing: border-box;
        overflow: hidden;
      }
      
      .tps-gcm-context-strip {
        grid-column: 1;
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: calc(6px * var(--tps-gcm-density));
        overflow-x: auto;
        flex-wrap: nowrap;
        flex: 1 1 auto;
        min-width: 0;
        padding: calc(2px * var(--tps-gcm-density)) 0;
        margin-bottom: 0;
        width: auto;
        max-width: 100%;
        box-sizing: border-box;
        
        /* Hide scrollbar but allow scroll */
        scrollbar-width: none; 
        -ms-overflow-style: none;
      }
      .tps-gcm-context-strip::-webkit-scrollbar {
        display: none;
      }
      
      .tps-gcm-chip {
        display: inline-flex;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        gap: calc(5px * var(--tps-gcm-density));
        padding: calc(6px * var(--tps-gcm-density)) calc(12px * var(--tps-gcm-density));
        border-radius: calc(16px * var(--tps-gcm-radius-scale));
        background: var(--background-modifier-form-field);
        border: 1px solid var(--background-modifier-border);
        font-size: calc(12px * var(--tps-gcm-text-scale));
        font-weight: 500;
        color: var(--text-normal);
        cursor: pointer;
        transition: all 0.15s ease;
        flex-shrink: 0;
        white-space: nowrap;
        user-select: none;
      }
      
      .tps-gcm-chip:hover {
        background: color-mix(in srgb, var(--background-modifier-hover), var(--background-primary));
        border-color: var(--interactive-accent);
        transform: translateY(-1px);
        opacity: 1 !important;
      }
      
      .tps-gcm-chip-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        opacity: 0.8;
        flex-shrink: 0;
      }
      .tps-gcm-chip-icon svg {
        width: 13px;
        height: 13px;
      }
      
      .tps-gcm-chip-label {
        font-weight: 500;
        white-space: nowrap;
      }

      .tps-gcm-chip--tag-value .tps-gcm-chip-tag-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: calc(14px * var(--tps-gcm-button-scale));
        height: calc(14px * var(--tps-gcm-button-scale));
        margin-left: calc(2px * var(--tps-gcm-density));
        border: none;
        border-radius: 999px;
        padding: 0;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s ease, color 0.15s ease, background-color 0.15s ease;
      }

      .tps-gcm-chip--tag-value:hover .tps-gcm-chip-tag-remove,
      .tps-gcm-chip--tag-value:focus-within .tps-gcm-chip-tag-remove {
        opacity: 0.95;
        pointer-events: auto;
      }

      .tps-gcm-chip--tag-value .tps-gcm-chip-tag-remove:hover {
        color: var(--text-normal);
        background: var(--background-modifier-hover);
      }

      .tps-gcm-chip--tag-value .tps-gcm-chip-tag-remove svg {
        width: calc(10px * var(--tps-gcm-button-scale));
        height: calc(10px * var(--tps-gcm-button-scale));
      }
      
      /* --- ACTION BAR --- */
      
      .tps-gcm-action-bar {
        grid-column: 2;
        position: static;
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: calc(8px * var(--tps-gcm-density));
        padding: calc(8px * var(--tps-gcm-density)) 0;
        flex: 0 0 auto;
        flex-shrink: 0;
        margin-inline-start: 0;
        justify-content: flex-end;
        justify-self: end;
        pointer-events: auto;
        min-width: max-content;
        white-space: nowrap;
        z-index: 2;
        border-top: 1px solid color-mix(in srgb, var(--background-modifier-border) 50%, transparent);
        border-bottom: 1px solid color-mix(in srgb, var(--background-modifier-border) 50%, transparent);
      }

      @media (max-width: 980px) {
        .tps-gcm-unified-row { gap: calc(6px * var(--tps-gcm-density)); }
      }
      
      .tps-gcm-action-group {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: calc(4px * var(--tps-gcm-density));
      }
      
      .tps-gcm-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: calc(36px * var(--tps-gcm-button-scale) * var(--tps-gcm-density));
        height: calc(36px * var(--tps-gcm-button-scale) * var(--tps-gcm-density));
        border-radius: calc(10px * var(--tps-gcm-radius-scale));
        background: var(--background-modifier-form-field);
        color: var(--text-muted);
        border: 1px solid var(--background-modifier-border);
        cursor: pointer;
        transition: all 0.15s ease;
        flex-shrink: 0;
      }
      
      .tps-gcm-icon-btn:hover {
        background: color-mix(in srgb, var(--background-modifier-hover), var(--background-primary));
        color: var(--text-normal);
        border-color: var(--interactive-accent);
        transform: translateY(-1px);
        opacity: 1 !important;
      }
      
      .tps-gcm-icon-btn svg {
        width: calc(16px * var(--tps-gcm-button-scale));
        height: calc(16px * var(--tps-gcm-button-scale));
      }

      .tps-gcm-subitems-panel {
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
        touch-action: none;
        max-height: min(78vh, 920px);
        overflow: hidden;
      }

      .tps-gcm-subitems-panel--hidden {
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
      }

      /* Keyboard-visible state: hide subitems panel entirely so mobile viewport
         remains usable while editing with the on-screen keyboard open. */
      .tps-gcm-subitems-panel--keyboard-hidden {
        display: none !important;
        opacity: 0 !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      /* Keyboard-visible state: hide persistent inline context menu bar. */
      .tps-gcm-menu--keyboard-hidden {
        display: none !important;
`;
