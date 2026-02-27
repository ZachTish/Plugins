import { App, BasesEntry, Component, MarkdownRenderer, MarkdownView, WorkspaceLeaf } from "obsidian";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "./hooks";
import * as logger from "./logger";
import { useIsVisible } from "./useIntersectionObserver";

// Types
export type FeedItem =
  | { type: "entry"; entry: BasesEntry; id: string }
  | { type: "header"; label: string; id: string; count: number };

type PathLike = { path: string };
type PluginMap = Record<string, unknown>;
type GcmPlugin = {
  buildSpecialPanel?: (files: BasesEntry["file"][], options?: { inline?: boolean }) => HTMLElement | null;
  menuController?: { createSummaryHeader: (file: BasesEntry["file"]) => HTMLElement };
};
type ProjectsPlugin = {
  projectMenuManager?: { buildProjectPanel: (file: BasesEntry["file"], options?: { collapsed?: boolean }) => HTMLElement | null };
};

type FeedReactViewProps = {
  items: FeedItem[];
  onEntryClick: (entry: BasesEntry, isModEvent: boolean) => void;
  onEntryContextMenu: (evt: React.MouseEvent, entry: BasesEntry) => void;
  showProperties: boolean;
  integratedMode?: boolean;
  onReorder?: (order: string[]) => void;
  onEditorActivity?: () => void;
};

type FeedEntryProps = {
  entry: BasesEntry;
  app: App;
  bodyTextCache: Map<string, boolean>;
  isFocused: boolean;
  onFocusEntry: (path: string) => void;
  showProperties: boolean;
  onEntryClick: (entry: BasesEntry, isModEvent: boolean) => void;
  onEntryContextMenu: (evt: React.MouseEvent, entry: BasesEntry) => void;
  isCollapsed: boolean;
  isInlinePanelCollapsed: boolean;
  onToggleCollapsed: (next: boolean) => void;
  onToggleInlinePanel: (next: boolean) => void;
  integratedMode?: boolean;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onEditorActivity?: () => void;
};

let sharedNoteLiveLeaf: WorkspaceLeaf | null = null;
let sharedNoteLiveLeafPath: string | null = null;

function destroySharedNoteLiveLeaf(): void {
  if (!sharedNoteLiveLeaf) return;
  try {
    sharedNoteLiveLeaf.detach();
  } catch (err) {
    logger.warn("Failed to detach shared note live leaf", err);
  } finally {
    sharedNoteLiveLeaf = null;
    sharedNoteLiveLeafPath = null;
  }
}

export const FeedReactView: React.FC<FeedReactViewProps> = ({
  items,
  onEntryClick,
  onEntryContextMenu,
  showProperties,
  integratedMode = false,
  onReorder,
  onEditorActivity,
}) => {
  const app = useApp();
  const parentRef = React.useRef<HTMLDivElement>(null);
  const knownGroupIdsRef = React.useRef<Set<string>>(new Set());
  const bodyTextCacheRef = React.useRef<Map<string, boolean>>(new Map());

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [entryCollapsed, setEntryCollapsed] = useState<Record<string, boolean>>(
    () => ({}),
  );
  const [inlineCollapsed, setInlineCollapsed] = useState<Record<string, boolean>>(
    () => ({}),
  );
  const [focusedEntryPath, setFocusedEntryPath] = useState<string | null>(null);

  useEffect(() => {
    return () => destroySharedNoteLiveLeaf();
  }, []);

  const getEntryKey = useCallback((entry: BasesEntry) => entry.file.path, []);

  useEffect(() => {
    const headerIds = new Set<string>();
    for (const item of items) {
      if (item.type === "header") headerIds.add(item.id);
    }

    if (integratedMode) {
      setCollapsedGroups(new Set());
    } else {
      setCollapsedGroups((prev) => {
        const next = new Set(prev);
        const known = knownGroupIdsRef.current;

        // Only auto-collapse newly introduced groups
        for (const id of headerIds) {
          if (!known.has(id)) {
            next.add(id);
          }
        }

        // Prune groups that no longer exist
        for (const id of Array.from(next)) {
          if (!headerIds.has(id)) next.delete(id);
        }

        return next;
      });
    }

    knownGroupIdsRef.current = headerIds;
  }, [items, integratedMode]);

  const visibleItems = useMemo(() => {
    const filtered: (FeedItem & { collapsed?: boolean })[] = [];
    let currentGroupCollapsed = false;

    for (const item of items) {
      if (item.type === "header") {
        currentGroupCollapsed = integratedMode ? false : collapsedGroups.has(item.id);
        filtered.push({ ...item, collapsed: currentGroupCollapsed });
      } else {
        if (!currentGroupCollapsed) {
          filtered.push(item);
        }
      }
    }

    return filtered;
  }, [items, collapsedGroups, integratedMode]);

  const sectionEntryOrders = useMemo(() => {
    const map = new Map<string, string[]>();
    let currentSectionKey = "__ungrouped__";
    for (const item of visibleItems) {
      if (item.type === "header") {
        currentSectionKey = item.id || "__ungrouped__";
        if (!map.has(currentSectionKey)) map.set(currentSectionKey, []);
        continue;
      }
      if (!map.has(currentSectionKey)) map.set(currentSectionKey, []);
      map.get(currentSectionKey)!.push(item.entry.file.path);
    }
    return map;
  }, [visibleItems]);

  const sectionOrderByEntry = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const sectionEntries of sectionEntryOrders.values()) {
      for (const path of sectionEntries) {
        map.set(path, sectionEntries);
      }
    }
    return map;
  }, [sectionEntryOrders]);

  useEffect(() => {
    const available = new Set(
      items
        .filter((item): item is Extract<FeedItem, { type: "entry" }> => item.type === "entry")
        .map((item) => item.entry.file.path),
    );
    setFocusedEntryPath((prev) => {
      if (prev && available.has(prev)) return prev;
      if (integratedMode) {
        const first = items.find((item): item is Extract<FeedItem, { type: "entry" }> => item.type === "entry");
        return first?.entry.file.path ?? null;
      }
      return null;
    });
  }, [items, integratedMode]);

  useEffect(() => {
    if (!app) return;
    const offModify = app.vault.on("modify", (file: unknown) => {
      if (file && typeof file === "object" && "path" in file) {
        bodyTextCacheRef.current.delete((file as PathLike).path);
      }
    });
    const offRename = app.vault.on("rename", (file: unknown, oldPath: string) => {
      if (oldPath) bodyTextCacheRef.current.delete(oldPath);
      if (file && typeof file === "object" && "path" in file) {
        bodyTextCacheRef.current.delete((file as PathLike).path);
      }
    });
    const offDelete = app.vault.on("delete", (file: unknown) => {
      if (file && typeof file === "object" && "path" in file) {
        bodyTextCacheRef.current.delete((file as PathLike).path);
      }
    });
    return () => {
      app.vault.offref(offModify);
      app.vault.offref(offRename);
      app.vault.offref(offDelete);
    };
  }, [app]);


  const handleMove = useCallback(
    (entryId: string, direction: "up" | "down", sectionOrder: string[]) => {
      if (!onReorder) return;
      const idx = sectionOrder.indexOf(entryId);
      if (idx === -1) return;
      const targetIdx = direction === "up" ? idx - 1 : idx + 1;
      if (targetIdx < 0 || targetIdx >= sectionOrder.length) return;

      const next = items
        .filter((item) => item.type === "entry")
        .map((item) => item.entry.file.path);
      const fromPath = sectionOrder[idx];
      const toPath = sectionOrder[targetIdx];
      const fromGlobal = next.indexOf(fromPath);
      const toGlobal = next.indexOf(toPath);
      if (fromGlobal < 0 || toGlobal < 0) return;
      const temp = next[fromGlobal];
      next[fromGlobal] = next[toGlobal];
      next[toGlobal] = temp;
      onReorder(next);
    },
    [items, onReorder],
  );


  return (
    <div
      ref={parentRef}
      className="bases-feed-scroll-root"
      style={{
        height: "100%",
        overflowY: "auto",
        overflowX: "hidden",
        width: "100%",
        position: "relative"
      }}
    >
      <div className={`bases-feed${integratedMode ? " is-integrated" : ""}`}>
        {items.length === 0 ? (
          <div className="bases-feed-empty">No notes to display</div>
        ) : (
          <div className="bases-feed-mobile-list">
            {visibleItems.map((item) =>
              item.type === "header" ? (
                integratedMode ? (
                  <h1 key={item.id} className="bases-feed-group-header is-integrated">
                    {item.label}
                  </h1>
                ) : (
                  <div
                    key={item.id}
                    className="bases-feed-group-header"
                    onClick={() => {
                      setCollapsedGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      });
                    }}
                  >
                    <div
                      className={`bases-feed-group-caret ${item.collapsed ? "is-collapsed" : ""
                        }`}
                    >
                      ▾
                    </div>
                    <div className="bases-feed-group-title">
                      {item.label}
                    </div>
                    <div className="bases-feed-group-count">
                      {item.count}
                    </div>
                  </div>
                )
              ) : (
                <FeedEntry
                  key={item.entry.file.path}
                  entry={item.entry}
                  app={app}
                  bodyTextCache={bodyTextCacheRef.current}
                  isFocused={focusedEntryPath === item.entry.file.path}
                  onFocusEntry={(path) => setFocusedEntryPath(path)}
                  showProperties={showProperties}
                  onEntryClick={onEntryClick}
                  onEntryContextMenu={onEntryContextMenu}
                  isCollapsed={integratedMode ? false : (entryCollapsed[getEntryKey(item.entry)] ?? true)}
                  isInlinePanelCollapsed={inlineCollapsed[getEntryKey(item.entry)] ?? true}
                  onToggleCollapsed={(next) => {
                    if (integratedMode) return;
                    const key = getEntryKey(item.entry);
                    setEntryCollapsed((prev) => ({ ...prev, [key]: next }));
                  }}
                  onToggleInlinePanel={(next) => {
                    const key = getEntryKey(item.entry);
                    setInlineCollapsed((prev) => ({ ...prev, [key]: next }));
                  }}
                  integratedMode={integratedMode}
                  canMoveUp={
                    !!onReorder &&
                    (() => {
                      const section = sectionOrderByEntry.get(item.entry.file.path) || [];
                      return section.indexOf(item.entry.file.path) > 0;
                    })()
                  }
                  canMoveDown={
                    !!onReorder &&
                    (() => {
                      const section = sectionOrderByEntry.get(item.entry.file.path) || [];
                      const idx = section.indexOf(item.entry.file.path);
                      return idx > -1 && idx < section.length - 1;
                    })()
                  }
                  onMoveUp={
                    onReorder
                      ? () => handleMove(
                        item.entry.file.path,
                        "up",
                        sectionOrderByEntry.get(item.entry.file.path) || []
                      )
                      : undefined
                  }
                  onMoveDown={
                    onReorder
                      ? () => handleMove(
                        item.entry.file.path,
                        "down",
                        sectionOrderByEntry.get(item.entry.file.path) || []
                      )
                      : undefined
                  }
                  onEditorActivity={onEditorActivity}
                />
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const FeedEntry: React.FC<FeedEntryProps> = ({
  entry,
  app,
  bodyTextCache,
  isFocused,
  onFocusEntry,
  showProperties,
  onEntryClick,
  onEntryContextMenu,
  isCollapsed,
  isInlinePanelCollapsed,
  onToggleCollapsed,
  onToggleInlinePanel,
  integratedMode = false,
  canMoveUp = false,
  canMoveDown = false,
  onMoveUp,
  onMoveDown,
  onEditorActivity,
}) => {
  const panelHostRef = React.useRef<HTMLDivElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const editorHostRef = React.useRef<HTMLTextAreaElement | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [editorText, setEditorText] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const frontmatterRef = React.useRef<string>("");
  const inlineCollapsedRef = React.useRef<boolean>(isInlinePanelCollapsed);
  const toggleInlineRef = React.useRef<(next: boolean) => void>(onToggleInlinePanel);
  const [hasBodyText, setHasBodyText] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const previewHostRef = React.useRef<HTMLDivElement | null>(null);
  const livePreviewHostRef = React.useRef<HTMLDivElement | null>(null);
  const integratedLiveHostRef = React.useRef<HTMLDivElement | null>(null);
  const previewComponentRef = React.useRef<Component | null>(null);
  const isVisible = useIsVisible(containerRef);

  useEffect(() => {
    let isActive = true;
    if (!app) return;

    const stripFrontmatter = (raw: string) => {
      const lines = raw.split("\n");
      if (lines[0]?.trim() !== "---") return raw;
      for (let i = 1; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (line === "---" || line === "...") {
          return lines.slice(i + 1).join("\n");
        }
      }
      return "";
    };

    const cached = bodyTextCache.get(entry.file.path);
    if (typeof cached === "boolean") {
      setHasBodyText(cached);
    } else {
      app.vault
        .cachedRead(entry.file)
        .then((text) => {
          if (!isActive) return;
          const body = stripFrontmatter(text).trim();
          const hasBody = body.length > 0;
          bodyTextCache.set(entry.file.path, hasBody);
          setHasBodyText(hasBody);
        })
        .catch((err) => {
          if (!isActive) return;
          logger.warn("Failed to read entry body", err);
          bodyTextCache.set(entry.file.path, false);
          setHasBodyText(false);
        });
    }

    return () => {
      isActive = false;
    };
  }, [app, entry.file, bodyTextCache]);

  useEffect(() => {
    if (!app) return;
    const filePath = entry.file.path;
    const onModify = (file: unknown) => {
      if (!file || typeof file !== "object" || !("path" in file)) return;
      if ((file as PathLike).path !== filePath) return;
      const active = document.activeElement as HTMLElement | null;
      const editorHost = editorHostRef.current;
      const isEditing = !!(editorHost && active && editorHost.contains(active));
      if (isEditing) return;
      if (isDirty) return;
      setIsDirty(false);
    };
    const offModify = app.vault.on("modify", onModify);
    return () => {
      app.vault.offref(offModify);
    };
  }, [app, entry.file.path]);

  useEffect(() => {
    inlineCollapsedRef.current = isInlinePanelCollapsed;
    toggleInlineRef.current = onToggleInlinePanel;
  }, [isInlinePanelCollapsed, onToggleInlinePanel]);

  useEffect(() => {
    const host = panelHostRef.current;
    const wrapper = host?.firstElementChild as HTMLElement | null;
    if (!wrapper) return;
    const panel = wrapper.querySelector<HTMLElement>('.tps-gcm-panel');
    const collapseButton = wrapper.querySelector<HTMLButtonElement>('.tps-gcm-collapse-button');

    wrapper.classList.toggle('tps-global-context-menu--collapsed', isInlinePanelCollapsed);
    if (panel) {
      panel.classList.toggle('tps-gcm-panel--hidden', isInlinePanelCollapsed);
    }
    if (collapseButton) {
      const expanded = !isInlinePanelCollapsed;
      collapseButton.setAttribute('aria-expanded', expanded.toString());
      collapseButton.setAttribute('title', expanded ? 'Collapse inline controls' : 'Expand inline controls');
    }
  }, [isInlinePanelCollapsed]);

  const handleTitleClick = (evt: React.MouseEvent) => {
    evt.preventDefault();
    const isModEvent = evt.ctrlKey || evt.metaKey;
    onEntryClick(entry, isModEvent);
  };

  const handleContextMenu = (evt: React.MouseEvent) => {
    evt.preventDefault();
    evt.stopPropagation();
    onEntryContextMenu(evt, entry);
  };

  const handleHover = (evt: React.MouseEvent) => {
    if (app) {
      app.workspace.trigger("hover-link", {
        event: evt.nativeEvent,
        source: "bases",
        hoverParent: app.renderContext,
        targetEl: evt.currentTarget,
        linktext: entry.file.path,
      });
    }
  };

  const setEditorHost = useCallback((node: HTMLTextAreaElement | null) => {
    editorHostRef.current = node;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, []);

  const shouldMountEditor = integratedMode || (isFocused && isVisible);

  const splitFrontmatter = useCallback((raw: string): { frontmatter: string; body: string } => {
    const normalized = raw.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) {
      return { frontmatter: "", body: normalized };
    }
    const end = normalized.indexOf("\n---\n", 4);
    if (end === -1) {
      return { frontmatter: "", body: normalized };
    }
    const frontmatter = normalized.slice(0, end + 5);
    const body = normalized.slice(end + 5);
    return { frontmatter, body };
  }, []);

  useEffect(() => {
    if (!app || !shouldMountEditor) return;
    let alive = true;
    const loadTimer = window.setTimeout(async () => {
      try {
        const text = await app.vault.cachedRead(entry.file);
        if (!alive) return;
        const parsed = splitFrontmatter(text);
        frontmatterRef.current = parsed.frontmatter;
        setEditorText(parsed.body);
        setIsDirty(false);
        setIsEditing(false);
      } catch (err) {
        if (!alive) return;
        logger.warn("Failed to load inline text editor content", err);
      }
    }, 0);

    return () => {
      alive = false;
      window.clearTimeout(loadTimer);
    };
  }, [app, entry.file, shouldMountEditor, splitFrontmatter]);

  useEffect(() => {
    if (!app) return;
    const host = isEditing ? livePreviewHostRef.current : previewHostRef.current;
    if (!host || !shouldMountEditor) return;
    host.empty();
    if (previewComponentRef.current) {
      previewComponentRef.current.unload();
    }
    const component = new Component();
    previewComponentRef.current = component;
    void MarkdownRenderer.render(app, editorText, host, entry.file.path, component);
    return () => {
      component.unload();
      if (previewComponentRef.current === component) {
        previewComponentRef.current = null;
      }
    };
  }, [app, editorText, entry.file.path, shouldMountEditor, isEditing]);

  useEffect(() => {
    if (!integratedMode || !shouldMountEditor || !isFocused || !app) return;
    const host = integratedLiveHostRef.current;
    if (!host) return;
    let alive = true;
    let cleanup: (() => void) | null = null;

    const mountSharedLeaf = async () => {
      if (!alive) return;
      try {
        if (!sharedNoteLiveLeaf) {
          // @ts-ignore internal constructor used intentionally for embedded editor
          sharedNoteLiveLeaf = new WorkspaceLeaf(app);
        }

        if (sharedNoteLiveLeafPath !== entry.file.path) {
          await sharedNoteLiveLeaf.openFile(entry.file, {
            state: { mode: "source", source: true },
            active: false,
          });
          sharedNoteLiveLeafPath = entry.file.path;
        }

        if (!alive || !sharedNoteLiveLeaf) return;
        const view = sharedNoteLiveLeaf.view;
        if (!(view instanceof MarkdownView)) return;

        host.empty();
        host.appendChild(view.containerEl);
        view.onResize();

        const editorEl = view.containerEl;
        const markDirty = () => {
          setIsDirty(true);
          onEditorActivity?.();
        };
        editorEl.addEventListener("input", markDirty, true);
        editorEl.addEventListener("keydown", markDirty, true);
        cleanup = () => {
          editorEl.removeEventListener("input", markDirty, true);
          editorEl.removeEventListener("keydown", markDirty, true);
        };
      } catch (err) {
        logger.warn("Failed to mount shared note live leaf", err);
      }
    };

    void mountSharedLeaf();

    return () => {
      alive = false;
      cleanup?.();
      if (host) host.empty();
    };
  }, [integratedMode, shouldMountEditor, isFocused, app, entry.file, onEditorActivity]);

  const saveEditorText = useCallback(async () => {
    if (!app || !isDirty || isSaving) return;
    try {
      setIsSaving(true);
      const next = frontmatterRef.current
        ? `${frontmatterRef.current}${editorText.startsWith("\n") ? "" : "\n"}${editorText}`
        : editorText;
      await app.vault.modify(entry.file, next);
      setIsDirty(false);
    } catch (err) {
      logger.warn("Inline text save failed", err);
    } finally {
      setIsSaving(false);
    }
  }, [app, entry.file, editorText, isDirty, isSaving]);

  useEffect(() => {
    const node = editorHostRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${node.scrollHeight}px`;
  }, [editorText, shouldMountEditor]);

  const showContent = !isCollapsed;

  // Ref callback to mount the TPS-GCM inline panel
  const setPanelHost = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !app) return;
      panelHostRef.current = node;

      // Try to get TPS-Global-Context-Menu plugin
      // @ts-ignore - accessing internal plugins
      const plugins = app.plugins?.plugins as PluginMap | undefined;
      const gcmPlugin = plugins?.["tps-global-context-menu"] as GcmPlugin | undefined;
      if (!gcmPlugin || typeof gcmPlugin.buildSpecialPanel !== 'function' || !gcmPlugin.menuController) {
        const attempts = Number(node.dataset.gcmAttempt || "0");
        if (attempts < 3) {
          node.dataset.gcmAttempt = String(attempts + 1);
          setTimeout(() => setPanelHost(node), 300);
        }
        return;
      }

      try {
        node.empty();

        const wrapper = document.createElement('div');
        wrapper.className = 'tps-global-context-menu tps-global-context-menu--persistent tps-global-context-menu--reading';
        if (inlineCollapsedRef.current) {
          wrapper.classList.add('tps-global-context-menu--collapsed');
        }

        const header = gcmPlugin.menuController.createSummaryHeader(entry.file);
        wrapper.appendChild(header);

        const panel = gcmPlugin.buildSpecialPanel([entry.file], { inline: true });
        if (panel) {
          if (inlineCollapsedRef.current) {
            panel.classList.add('tps-gcm-panel--hidden');
          }
          wrapper.appendChild(panel);
        }

        node.appendChild(wrapper);

        const collapseButton = wrapper.querySelector<HTMLButtonElement>('.tps-gcm-collapse-button');
        if (collapseButton) {
          collapseButton.onclick = (e) => {
            e.preventDefault();
            toggleInlineRef.current?.(!inlineCollapsedRef.current);
          };
        }
      } catch (err) {
        logger.error("Failed to build inline panel", err);
      }
    },
    [app, entry.file]
  );

  // Ref callback to mount the TPS-Projects panel
  const setProjectHost = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || !app) return;

      // Try to get TPS-Projects plugin
      // @ts-ignore
      const plugins = app.plugins?.plugins as PluginMap | undefined;
      const projPlugin = plugins?.["tps-projects"] as ProjectsPlugin | undefined;
      if (!projPlugin || !projPlugin.projectMenuManager || typeof projPlugin.projectMenuManager.buildProjectPanel !== 'function') {
        return;
      }

      try {
        const panel = projPlugin.projectMenuManager.buildProjectPanel(entry.file, { collapsed: true });
        if (panel) {
          node.empty();
          node.appendChild(panel);
        }
      } catch (err) {
        logger.error("Failed to build project panel", err);
      }
    },
    [app, entry.file]
  );

  return (
    <div ref={containerRef} className={`bases-feed-entry ${isCollapsed ? "is-collapsed" : "is-expanded"}${integratedMode ? " is-integrated" : ""}`} data-path={entry.file.path} onContextMenu={handleContextMenu}>
      <div className="bases-feed-entry-header" style={{ display: 'flex', alignItems: 'center' }}>
        {!integratedMode && hasBodyText && <span className="bases-feed-entry-body-dot" aria-hidden="true" />}
        {!integratedMode && (
          <button
            className={`bases-feed-collapse-btn ${isCollapsed ? "is-collapsed" : "is-expanded"}`}
            onClick={(e) => {
              e.preventDefault();
              onToggleCollapsed(!isCollapsed);
            }}
            style={{
              background: 'none',
              border: 'none',
              padding: '0 4px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              color: 'var(--text-muted)',
              marginRight: '4px'
            }}
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
        )}
        {integratedMode ? (
          <>
            <h2 className="bases-feed-entry-title is-integrated" style={{ flex: 1 }}>
              {entry.file.basename}
            </h2>
          </>
        ) : (
          <a
            className="bases-feed-entry-title"
            onClick={handleTitleClick}
            onMouseEnter={handleHover}
            href="#"
            style={{ flex: 1 }}
          >
            {entry.file.basename}
          </a>
        )}
        {integratedMode && (onMoveUp || onMoveDown) && (
          <div className="bases-feed-entry-order">
            <button
              className="bases-feed-entry-order-btn"
              type="button"
              aria-label="Move up"
              disabled={!canMoveUp}
              onClick={(evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                onMoveUp?.();
              }}
            >
              ↑
            </button>
            <button
              className="bases-feed-entry-order-btn"
              type="button"
              aria-label="Move down"
              disabled={!canMoveDown}
              onClick={(evt) => {
                evt.preventDefault();
                evt.stopPropagation();
                onMoveDown?.();
              }}
            >
              ↓
            </button>
          </div>
        )}
      </div>
      {!integratedMode && (
        <div
          ref={setPanelHost}
          className={`bases-feed-entry-inline-panel ${isInlinePanelCollapsed ? "is-collapsed" : "is-visible"}`}
        />
      )}

      {showContent && (
        <div className="bases-feed-entry-content">
          {shouldMountEditor ? (
            integratedMode ? (
              isFocused ? (
                <div
                  ref={integratedLiveHostRef}
                  className="bases-feed-entry-live-host"
                />
              ) : (
                <div
                  ref={previewHostRef}
                  className="bases-feed-entry-rendered markdown-rendered"
                  onClick={(evt) => {
                    evt.preventDefault();
                    onFocusEntry(entry.file.path);
                  }}
                />
              )
            ) : (
            isEditing ? (
              <div className="bases-feed-entry-live-edit">
                <textarea
                  ref={setEditorHost}
                  className="bases-feed-entry-editor"
                  onFocus={() => {
                    onFocusEntry(entry.file.path);
                    onEditorActivity?.();
                  }}
                  onBlur={() => {
                    void saveEditorText();
                    setIsEditing(false);
                  }}
                  onChange={(evt) => {
                    setEditorText((evt.target as HTMLTextAreaElement).value);
                    setIsDirty(true);
                    onEditorActivity?.();
                  }}
                  value={editorText}
                  style={
                    {
                      "--metadata-display-editing": showProperties ? "block" : "none",
                      minHeight: integratedMode ? "0" : "100px",
                      width: "100%",
                      resize: "none",
                    } as React.CSSProperties
                  }
                />
                <div
                  ref={livePreviewHostRef}
                  className="bases-feed-entry-rendered bases-feed-entry-rendered-live markdown-rendered"
                />
              </div>
            ) : (
              <div
                ref={previewHostRef}
                className="bases-feed-entry-rendered markdown-rendered"
                onClick={(evt) => {
                  evt.preventDefault();
                  onFocusEntry(entry.file.path);
                  setIsEditing(true);
                  window.setTimeout(() => editorHostRef.current?.focus(), 0);
                }}
              />
            )
            )
          ) : (
            <div
              className="bases-feed-entry-editor bases-feed-entry-editor-placeholder"
              style={{ minHeight: "100px", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)" }}
            >
              <button
                type="button"
                className="bases-feed-entry-activate-editor"
                onClick={(evt) => {
                  evt.preventDefault();
                  evt.stopPropagation();
                  onFocusEntry(entry.file.path);
                  setIsEditing(true);
                }}
                style={{
                  border: "1px solid var(--background-modifier-border)",
                  borderRadius: "6px",
                  background: "var(--background-primary)",
                  color: "var(--text-normal)",
                  padding: "6px 10px",
                  cursor: "pointer",
                }}
              >
                Click to edit
              </button>
            </div>
          )}
          {!integratedMode && (
            <div
              ref={setProjectHost}
              className="bases-feed-projects-footer"
              style={{ marginTop: '32px', borderTop: '1px solid var(--background-modifier-border)', paddingTop: '16px' }}
            />
          )}
        </div>
      )}
    </div>
  );
};
