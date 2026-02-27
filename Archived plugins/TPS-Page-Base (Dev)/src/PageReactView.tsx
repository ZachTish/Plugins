import React, { useState, useRef, useEffect, RefObject } from "react";
import { TFile, Component, MarkdownRenderer } from "obsidian";
import { PageEntry, GroupedPageEntries, PageViewContent } from "./types";
import { useApp, useIsVisible } from "./hooks";

interface PageReactViewProps {
  baseTitle: string;
  content: PageViewContent;
  isGrouped: boolean;
  lazyLoadThreshold: number;
  onEditEntry?: never; // Deprecated
}

export const PageReactView: React.FC<PageReactViewProps> = ({
  baseTitle,
  content,
  isGrouped,
  lazyLoadThreshold,
}) => {
  // Check if content is grouped
  const isContentGrouped = isGrouped && content.length > 0 && 'groupLabel' in content[0];

  return (
    <div className="bases-page-view">
      {baseTitle ? <h1 className="bases-page-title">{baseTitle}</h1> : null}

      <div className="bases-page-entries">
        {content.length === 0 ? (
          <p className="bases-page-empty">No entries to display</p>
        ) : isContentGrouped ? (
          // Render grouped entries: group as H2, entries as H3
          (content as GroupedPageEntries[]).map((group) => (
            <div key={`group-${group.groupLabel}`} className="bases-page-group">
              <h2 className="bases-page-group-title">{group.groupLabel}</h2>
              {group.entries.map((entry) => (
                <PageEntryView
                  key={entry.file.path}
                  entry={entry}
                  useLazyLoad={group.entries.length > lazyLoadThreshold}
                  isGroupedEntry={true}
                />
              ))}
            </div>
          ))
        ) : (
          // Render flat entries: entries as H2
          (content as PageEntry[]).map((entry) => (
            <PageEntryView
              key={entry.file.path}
              entry={entry}
              useLazyLoad={content.length > lazyLoadThreshold}
              isGroupedEntry={false}
            />
          ))
        )}
      </div>


    </div>
  );
};

interface PageEntryViewProps {
  entry: PageEntry;
  useLazyLoad: boolean;
  isGroupedEntry: boolean;
}

/**
 * Individual entry component.
 * Renders H2 or H3 title (depending on grouping) and body content with lazy loading support.
 */
const PageEntryView: React.FC<PageEntryViewProps> = ({
  entry,
  useLazyLoad,
  isGroupedEntry,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const componentRef = useRef<Component | null>(null);
  const isVisible = useIsVisible(containerRef);
  const app = useApp();

  const shouldRender = !useLazyLoad || isVisible;

  // Render markdown body when visible
  useEffect(() => {
    if (!shouldRender || !bodyRef.current || !app) return;

    const component = new Component();
    componentRef.current = component;

    MarkdownRenderer.render(
      app,
      entry.bodyContent,
      bodyRef.current,
      entry.file.path,
      component
    ).catch((error) => {
      console.error("[PageBase] Error rendering markdown:", error);
    });

    return () => {
      if (componentRef.current) {
        componentRef.current.unload();
        componentRef.current = null;
      }
    };
  }, [shouldRender, entry.bodyContent, entry.file.path, app]);

  const [isCollapsed, setIsCollapsed] = useState(false);
  const TitleTag = isGroupedEntry ? "h3" : "h2";

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (app) {
      const leaf = app.workspace.getLeaf(false);
      leaf.openFile(entry.file);
    }
  };

  const handleToggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsCollapsed(!isCollapsed);
  };

  return (
    <div ref={containerRef} className={`bases-page-entry ${isCollapsed ? "is-collapsed" : ""}`}>
      <div className="bases-page-entry-header" onClick={handleToggle}>
        <div
          className="bases-page-entry-toggle-icon"
          style={{
            display: 'flex',
            alignItems: 'center',
            marginRight: '8px',
            transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease',
            color: 'var(--text-muted)'
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </div>
        <TitleTag className={isGroupedEntry ? "bases-page-entry-title-grouped" : "bases-page-entry-title"}>
          {entry.title}
        </TitleTag>
        <button
          className="bases-page-entry-open-btn clickable-icon"
          aria-label="Open note"
          onClick={handleOpen}
          style={{ background: 'none', border: 'none', padding: '4px', cursor: 'pointer', opacity: 0.7 }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
            <polyline points="15 3 21 3 21 9"></polyline>
            <line x1="10" y1="14" x2="21" y2="3"></line>
          </svg>
        </button>
      </div>

      {!isCollapsed && shouldRender ? (
        <div
          ref={bodyRef}
          className="bases-page-entry-body markdown-preview-view markdown-rendered"
        />
      ) : !isCollapsed ? (
        <div className="bases-page-entry-placeholder">
          Scroll to load...
        </div>
      ) : null}
    </div>
  );
};

// Removed HoverEditorComponent
