import { useEffect, useRef } from "react";

interface UseCalendarZoomOptions {
  containerRef: React.RefObject<HTMLDivElement>;
  computedSlotHeight: number;
  onCondenseLevelChange?: (level: number) => void;
}

/**
 * Manages fluid pinch-to-zoom (Ctrl+wheel) for calendar slot height.
 * Updates CSS variable in real-time and debounces the commit to condense level.
 */
export function useCalendarZoom({
  containerRef,
  computedSlotHeight,
  onCondenseLevelChange,
}: UseCalendarZoomOptions) {
  const currentSlotHeightRef = useRef(computedSlotHeight);
  const pinchDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Sync ref when computedSlotHeight changes externally
  useEffect(() => {
    currentSlotHeightRef.current = computedSlotHeight;
  }, [computedSlotHeight]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();

        const current = currentSlotHeightRef.current;
        const delta = e.deltaY;
        const adjustment = delta * -0.2;

        // Clamp height: Min 9px (0.15 * 60), Max 90px (1.5 * 60)
        const newHeight = Math.max(9, Math.min(90, current + adjustment));

        if (newHeight !== current) {
          currentSlotHeightRef.current = newHeight;
          container.style.setProperty('--calendar-slot-height', `${newHeight}px`);

          // Debounce commit
          if (pinchDebounceRef.current) clearTimeout(pinchDebounceRef.current);
          pinchDebounceRef.current = setTimeout(() => {
            const BASE = 60;
            const MAX_SLOT_ZOOM = 1.5;
            const MIN_SLOT_ZOOM = 0.15;
            const MAX_LEVEL = 220;
            const range = MAX_SLOT_ZOOM - MIN_SLOT_ZOOM;

            const newZoom = newHeight / BASE;
            const newLevel = ((MAX_SLOT_ZOOM - newZoom) / range) * MAX_LEVEL;
            const clampedLevel = Math.max(0, Math.min(MAX_LEVEL, newLevel));

            if (onCondenseLevelChange) {
              onCondenseLevelChange(Math.round(clampedLevel));
            }
          }, 150);
        }
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [onCondenseLevelChange]);

  return { currentSlotHeightRef };
}
