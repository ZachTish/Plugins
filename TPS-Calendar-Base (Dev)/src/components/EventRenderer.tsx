import React, { useCallback } from "react";
import { BasesEntry, BasesPropertyId, Value, setIcon } from "obsidian";
import { EventContentArg } from "@fullcalendar/core";
import { parsePropertyId } from "obsidian";
import { tryGetValue } from "../hooks/useCalendarEvents";

interface UseEventRendererOptions {
  app: any;
  sanitizedProperties: BasesPropertyId[];
  basesEntryMap: Map<string, BasesEntry>;
}

/**
 * Provides the renderEventContent callback for FullCalendar.
 */
export function useEventRenderer({
  app,
  sanitizedProperties,
  basesEntryMap,
}: UseEventRendererOptions) {
  const hasNonEmptyValue = useCallback((value: Value): boolean => {
    if (value === null || value === undefined) return false;
    if (typeof (value as any).isTruthy === 'function') {
      return (value as any).isTruthy();
    }
    const str = String(value);
    return !!str && str.trim().length > 0;
  }, []);

  const renderEventContent = useCallback(
    (eventInfo: EventContentArg) => {
      const props = eventInfo.event.extendedProps;
      const title = eventInfo.event.title || props.calEntryTitle || 'Untitled';
      const entryPath = props.entryPath;
      const entry = entryPath ? basesEntryMap.get(entryPath) : undefined;
      const isGhost = props.isGhost || false;
      const isTask = props.isTask || false;
      const iconName = typeof props.iconName === "string" ? props.iconName.trim() : "";
      const iconColor = typeof props.iconColor === "string" ? props.iconColor.trim() : "";

      const propertyChips: React.ReactElement[] = [];
      if (entry && sanitizedProperties && sanitizedProperties.length > 0) {
        for (const prop of sanitizedProperties) {
          try {
            const value = tryGetValue(entry, prop);
            if (hasNonEmptyValue(value as Value)) {
              propertyChips.push(
                <PropertyValue
                  key={prop}
                  value={value as Value}
                  app={app}
                />
              );
            }
          } catch (err) {
            // skip
          }
        }
      } else if (eventInfo.event.extendedProps?.isExternal && sanitizedProperties?.length) {
        const external = eventInfo.event.extendedProps?.externalEvent as any;
        for (const prop of sanitizedProperties) {
          const parsed = parsePropertyId(prop);
          const name = String(parsed.name || (parsed as any).property || prop).toLowerCase();
          const externalValue =
            name === "location" ? external?.location :
              name === "organizer" ? external?.organizer :
                name === "url" ? external?.url :
                  name === "description" ? external?.description :
                    name === "allday" ? String(!!external?.isAllDay) :
                      null;
          if (externalValue) {
            propertyChips.push(
              <span key={prop} className="bases-calendar-event-property-value">{String(externalValue)}</span>
            );
          }
        }
      }

      if (eventInfo.event.allDay) {
        return (
          <div
            className="bases-calendar-event-content bases-calendar-event-content--allday tps-calendar-entry"
            data-path={entryPath}
            style={{
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              height: '100%',
              width: '100%',
              padding: 0,
              margin: 0,
              lineHeight: '14px',
              fontSize: '0.65rem'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
              {isGhost && (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ width: '12px', height: '12px', marginRight: '4px', flexShrink: 0, opacity: 0.9 }}
                >
                  <polyline points="17 1 21 5 17 9"></polyline>
                  <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                  <polyline points="7 23 3 19 7 15"></polyline>
                  <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
                </svg>
              )}
              {isTask && (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{ width: '12px', height: '12px', marginRight: '4px', flexShrink: 0, opacity: 0.9 }}
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                </svg>
              )}
              {iconName && <EventIcon iconName={iconName} color={iconColor} />}
              <div
                className="bases-calendar-event-title"
                style={{
                  fontWeight: 'var(--tps-event-title-weight, 600)',
                  fontSize: 'var(--tps-event-title-font-size, var(--tps-event-font-size, var(--font-ui-small)))',
                  lineHeight: 'var(--tps-event-title-line-height, 1.2)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  textShadow: 'var(--tps-event-title-shadow, none)',
                  flex: 1,
                  minWidth: 0,
                }}
                title={title}
              >
                {title}
              </div>
            </div>
          </div>
        );
      }

      return (
        <div
          className="bases-calendar-event-content tps-calendar-entry"
          data-path={entryPath}
          style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100%', alignItems: 'stretch', justifyContent: propertyChips.length === 0 ? 'center' : 'flex-start' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
            {isGhost && (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ width: '14px', height: '14px', marginRight: '4px', flexShrink: 0, opacity: 0.9 }}
              >
                <polyline points="17 1 21 5 17 9"></polyline>
                <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
                <polyline points="7 23 3 19 7 15"></polyline>
                <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
              </svg>
            )}
            {isTask && (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ width: '14px', height: '14px', marginRight: '4px', flexShrink: 0, opacity: 0.9 }}
              >
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              </svg>
            )}
            {iconName && <EventIcon iconName={iconName} color={iconColor} />}
            <div
              className="bases-calendar-event-title"
              style={{
                fontWeight: 'var(--tps-event-title-weight, 600)',
                fontSize: 'var(--tps-event-title-font-size, var(--tps-event-font-size, var(--font-ui-small)))',
                lineHeight: 'var(--tps-event-title-line-height, 1.2)',
                textShadow: 'var(--tps-event-title-shadow, none)',
                flex: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              title={title}
            >
              {title}
            </div>
          </div>
          {propertyChips.length > 0 && (
            <div className="bases-calendar-event-properties" style={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden' }}>
              {propertyChips}
            </div>
          )}
        </div>
      );
    },
    [app, sanitizedProperties, hasNonEmptyValue, basesEntryMap],
  );

  return { renderEventContent };
}

const EventIcon: React.FC<{ iconName: string; color?: string }> = ({ iconName, color }) => {
  const iconRef = useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    node.empty();
    try {
      setIcon(node, iconName);
    } catch {
      node.textContent = "";
    }
  }, [iconName]);

  return (
    <span
      ref={iconRef}
      className="bases-calendar-event-frontmatter-icon"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "14px",
        height: "14px",
        flexShrink: 0,
        color: color || "currentColor",
        opacity: 0.95,
      }}
    />
  );
};

const PropertyValue: React.FC<{ value: Value; app: any }> = ({ value, app }) => {
  const elementRef = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return;
      node.textContent = ''; // Clear previous content

      if (value === null || value === undefined) return;

      // Handle objects with renderTo (e.g., complex Obsidian widgets)
      if (typeof (value as any).renderTo === 'function' && app?.renderContext) {
        (value as any).renderTo(node, app.renderContext);
      } else {
        // Fallback for primitives or objects without renderTo
        node.textContent = String(value);
      }
    },
    [app, value],
  );

  return <span ref={elementRef} className="bases-calendar-event-property-value" style={{ display: 'inline-flex', alignItems: 'center' }} />;
};
