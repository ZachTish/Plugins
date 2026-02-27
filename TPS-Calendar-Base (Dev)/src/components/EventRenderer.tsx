import React, { useCallback } from "react";
import { BasesEntry, BasesPropertyId, Value } from "obsidian";
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
            <div
              className="bases-calendar-event-title"
              style={{ fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1 }}
              title={title}
            >
              {title}
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
          <div className="bases-calendar-event-title" style={{ fontWeight: 'bold', flexShrink: 0 }}>{title}</div>
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
