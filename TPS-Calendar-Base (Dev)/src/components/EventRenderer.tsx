import React, { useCallback } from "react";
import { BasesEntry, BasesPropertyId, Value, setIcon } from "obsidian";
import { EventContentArg } from "@fullcalendar/core";
import { parsePropertyId } from "obsidian";
import { tryGetValue } from "../hooks/useCalendarEvents";
import { normalizeCalendarIconName } from "../utils/calendar-presentation";

interface UseEventRendererOptions {
  app: any;
  sanitizedProperties: BasesPropertyId[];
  basesEntryMap: Map<string, BasesEntry>;
  titlePropertyId: BasesPropertyId | null;
}

/**
 * Provides the renderEventContent callback for FullCalendar.
 */
export function useEventRenderer({
  app,
  sanitizedProperties,
  basesEntryMap,
  titlePropertyId,
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
      const titleValue = entry && titlePropertyId ? tryGetValue(entry, titlePropertyId) as Value : undefined;
      const hasRenderableTitleValue = hasNonEmptyValue(titleValue as Value);
      const isGhost = props.isGhost || false;
      const isTask = props.isTask || false;
      const taskCheckboxState = typeof props.taskCheckboxState === "string" ? props.taskCheckboxState.trim() : "";
      const status = typeof props.status === "string" ? props.status.trim() : "";
      const displayTaskCheckboxState = isTask
        ? resolveTaskCheckboxState(taskCheckboxState, status)
        : taskCheckboxState;
      const taskInlineProperties = (props.taskInlineProperties || {}) as Record<string, string>;
      const taskIsDone = !!props.taskIsDone;
      const iconName = typeof props.iconName === "string" ? props.iconName.trim() : "";
      const iconColor = typeof props.iconColor === "string" ? props.iconColor.trim() : "";
      const taskColor = typeof props.taskColor === "string" ? props.taskColor.trim() : "";
      const eventHasColoredBackground = Boolean(eventInfo.event.backgroundColor || props.backgroundColor);
      const resolvedIconColor = iconColor || (eventHasColoredBackground ? "var(--text-on-accent)" : "currentColor");
      const resolvedCheckboxColor = isTask && (taskColor || eventHasColoredBackground)
        ? "var(--text-on-accent)"
        : (iconColor || "currentColor");

      const propertyChips: React.ReactElement[] = [];
      if (isTask && sanitizedProperties && sanitizedProperties.length > 0) {
        for (const prop of sanitizedProperties) {
          try {
            if (titlePropertyId && prop === titlePropertyId) continue;
            const parsed = parsePropertyId(prop);
            const name = String(parsed.name || (parsed as any).property || prop).toLowerCase();
            const inlineValue = taskInlineProperties[name];
            if (inlineValue && inlineValue.trim()) {
              propertyChips.push(
                <span key={prop} className="bases-calendar-event-property-value">{inlineValue}</span>
              );
            }
          } catch (_err) {
            // skip
          }
        }
      } else if (entry && sanitizedProperties && sanitizedProperties.length > 0) {
        for (const prop of sanitizedProperties) {
          try {
            // Skip the title property — it's already rendered as the styled title bar
            if (titlePropertyId && prop === titlePropertyId) continue;
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
          if (titlePropertyId && prop === titlePropertyId) continue;
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
            data-path={eventInfo.event.extendedProps?.isExternal ? undefined : entryPath}
            data-tps-external-calendar-event={eventInfo.event.extendedProps?.isExternal ? "true" : undefined}
            style={{
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              height: '100%',
              width: '100%',
              padding: '0 0 2px 0',
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
              {!isTask && iconName
                ? <EventIcon iconName={iconName} color={resolvedIconColor} />
                : isTask
                  ? renderTaskCheckboxIcon(displayTaskCheckboxState, 12, resolvedCheckboxColor)
                  : null}
              {hasRenderableTitleValue ? (
                <RenderedValue
                  value={titleValue as Value}
                  app={app}
                  className="bases-calendar-event-title"
                  style={{
	                  color: 'inherit',
	                  fontWeight: 'inherit',
	                  textDecoration: taskIsDone ? 'line-through' : 'none',
	                  opacity: taskIsDone ? 0.72 : 1,
	                  fontSize: 'var(--font-ui-smaller)',
	                  lineHeight: '1.1',
	                  letterSpacing: 'normal',
	                  textShadow: 'none',
	                  fontFamily: 'inherit',
	                  display: 'block',
	                  whiteSpace: 'normal',
	                  overflow: 'hidden',
	                  textOverflow: 'clip',
	                  wordBreak: 'break-word',
	                  overflowWrap: 'anywhere',
	                  flex: 1,
	                  minWidth: 0,
	                }}
                  fallbackText={title}
                  title={title}
                />
              ) : (
                <div
                  className="bases-calendar-event-title"
                  style={{
	                  color: 'inherit',
	                  fontWeight: 'inherit',
	                  textDecoration: taskIsDone ? 'line-through' : 'none',
	                  opacity: taskIsDone ? 0.72 : 1,
	                  fontSize: 'var(--font-ui-smaller)',
	                  lineHeight: '1.1',
	                  letterSpacing: 'normal',
	                  textShadow: 'none',
	                  fontFamily: 'inherit',
	                  display: 'block',
	                  whiteSpace: 'normal',
	                  overflow: 'hidden',
	                  textOverflow: 'clip',
	                  wordBreak: 'break-word',
	                  overflowWrap: 'anywhere',
	                  flex: 1,
	                  minWidth: 0,
	                }}
                  title={title}
                >
                  {title}
                </div>
              )}
            </div>
          </div>
        );
      }

      return (
        <div
          className="bases-calendar-event-content tps-calendar-entry"
          data-path={eventInfo.event.extendedProps?.isExternal ? undefined : entryPath}
          data-tps-external-calendar-event={eventInfo.event.extendedProps?.isExternal ? "true" : undefined}
          style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100%', alignItems: 'stretch', justifyContent: 'flex-start', paddingBottom: '0.5em' }}
        >
	          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%', flex: '0 0 auto' }}>
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
            {!isTask && iconName
              ? <EventIcon iconName={iconName} color={resolvedIconColor} />
              : isTask
                ? renderTaskCheckboxIcon(displayTaskCheckboxState, 14, resolvedCheckboxColor)
                : null}
            {hasRenderableTitleValue ? (
              <RenderedValue
                value={titleValue as Value}
                app={app}
                className="bases-calendar-event-title"
                style={{
	                  color: 'inherit',
	                  fontWeight: 'inherit',
	                  textDecoration: taskIsDone ? 'line-through' : 'none',
	                  opacity: taskIsDone ? 0.72 : 1,
	                  fontSize: 'var(--font-ui-smaller)',
	                  lineHeight: '1.1',
	                  letterSpacing: 'normal',
	                  textShadow: 'none',
	                  fontFamily: 'inherit',
	                  display: 'block',
	                  flex: 1,
	                  minWidth: 0,
	                  whiteSpace: 'normal',
	                  overflow: 'hidden',
	                  textOverflow: 'clip',
	                  wordBreak: 'break-word',
	                  overflowWrap: 'anywhere',
	                }}
                fallbackText={title}
                title={title}
              />
            ) : (
              <div
                className="bases-calendar-event-title"
                style={{
	                  color: 'inherit',
	                  fontWeight: 'inherit',
	                  textDecoration: taskIsDone ? 'line-through' : 'none',
	                  opacity: taskIsDone ? 0.72 : 1,
	                  fontSize: 'var(--font-ui-smaller)',
	                  lineHeight: '1.1',
	                  letterSpacing: 'normal',
	                  textShadow: 'none',
	                  fontFamily: 'inherit',
	                  display: 'block',
	                  flex: 1,
	                  minWidth: 0,
	                  whiteSpace: 'normal',
	                  overflow: 'hidden',
	                  textOverflow: 'clip',
	                  wordBreak: 'break-word',
	                  overflowWrap: 'anywhere',
	                }}
                title={title}
              >
                {title}
              </div>
            )}
          </div>
          {propertyChips.length > 0 && (
            <div className="bases-calendar-event-properties" style={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden' }}>
              {propertyChips}
            </div>
          )}
        </div>
      );
    },
    [app, sanitizedProperties, hasNonEmptyValue, basesEntryMap, titlePropertyId],
  );

  return { renderEventContent };
}

const EventIcon: React.FC<{ iconName: string; color?: string }> = ({ iconName, color }) => {
  const iconRef = useCallback((node: HTMLSpanElement | null) => {
    if (!node) return;
    node.empty();
    try {
      const normalizedIconName = normalizeCalendarIconName(iconName);
      if (!normalizedIconName) return;
      setIcon(node, normalizedIconName);
      const resolvedColor = color || "var(--text-on-accent)";
      node.style.color = resolvedColor;
      node.querySelectorAll("svg, svg *").forEach((el) => {
        const svgEl = el as SVGElement;
        svgEl.setAttribute("stroke", resolvedColor);
        if (svgEl.hasAttribute("fill") && svgEl.getAttribute("fill") !== "none") {
          svgEl.setAttribute("fill", "none");
        }
        svgEl.style.color = resolvedColor;
      });
    } catch {
      node.textContent = "";
    }
  }, [iconName, color]);

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
        color: color || "var(--text-on-accent)",
        opacity: 0.95,
      }}
    />
  );
};

function resolveTaskCheckboxState(markerState: string, status: string): string {
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedStatus === "complete" || normalizedStatus === "completed" || normalizedStatus === "done") return "x";
  if (normalizedStatus === "wont-do" || normalizedStatus === "wont do" || normalizedStatus === "cancelled" || normalizedStatus === "canceled") return "-";
  if (normalizedStatus === "holding" || normalizedStatus === "hold" || normalizedStatus === "blocked") return "?";
  if (normalizedStatus === "working" || normalizedStatus === "in-progress" || normalizedStatus === "in progress") return "/";
  return String(markerState || "").trim();
}

function renderTaskCheckboxIcon(state: string, size: number, color = "currentColor"): React.ReactElement {
  const common = {
    xmlns: "http://www.w3.org/2000/svg",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: "2",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    style: { width: `${size}px`, height: `${size}px`, marginRight: '4px', flexShrink: 0, opacity: 0.9 },
  };

  if (/^[xX]$/.test(state)) {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <path d="M8 12l3 3 5-6"></path>
      </svg>
    );
  }

  if (state === "-") {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <path d="M8 12h8"></path>
      </svg>
    );
  }

  if (state === "\\") {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <path d="M8 8l8 8"></path>
      </svg>
    );
  }

  if (state === "?") {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <path d="M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-.9.8-1.7 1.3-1.7 2.7"></path>
        <path d="M12 17h.01"></path>
      </svg>
    );
  }

  return (
    <svg {...common}>
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    </svg>
  );
}

const PropertyValue: React.FC<{ value: Value; app: any }> = ({ value, app }) => {
  return (
    <RenderedValue
      value={value}
      app={app}
      className="bases-calendar-event-property-value"
      style={{ display: 'inline-flex', alignItems: 'center' }}
    />
  );
};

const RenderedValue: React.FC<{
  value: Value;
  app: any;
  className?: string;
  style?: React.CSSProperties;
  fallbackText?: string;
  title?: string;
}> = ({ value, app, className, style, fallbackText, title }) => {
  const elementRef = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return;
      node.textContent = ''; // Clear previous content

      if (title) {
        node.setAttribute("title", title);
      } else {
        node.removeAttribute("title");
      }

      if (value === null || value === undefined) {
        if (fallbackText) node.textContent = fallbackText;
        return;
      }

      // Handle objects with renderTo (e.g., complex Obsidian widgets)
      if (typeof (value as any).renderTo === 'function' && app?.renderContext) {
        (value as any).renderTo(node, app.renderContext);
      } else {
        // Fallback for primitives or objects without renderTo
        node.textContent = String(value ?? fallbackText ?? "");
      }
    },
    [app, fallbackText, title, value],
  );

  return <span ref={elementRef} className={className} style={style} />;
};
