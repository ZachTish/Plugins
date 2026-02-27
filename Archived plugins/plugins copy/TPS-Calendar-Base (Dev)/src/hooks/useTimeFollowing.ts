import { useCallback, useEffect, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";

interface UseTimeFollowingOptions {
  calendarRef: React.RefObject<FullCalendar>;
  containerRef: React.RefObject<HTMLDivElement>;
  computedSlotHeight: number;
}

/**
 * Manages "follow now" mode: auto-scrolls to current time,
 * and detects user scroll to disengage.
 */
export function useTimeFollowing({
  calendarRef,
  containerRef,
  computedSlotHeight,
}: UseTimeFollowingOptions) {
  const [isFollowingNow, setIsFollowingNow] = useState(true);
  const followIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isProgrammaticScrollRef = useRef(false);
  const hasInitialScrollRef = useRef(false);

  const isTodayInView = useCallback(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return false;
    const viewStart = api.view.activeStart;
    const viewEnd = api.view.activeEnd;
    const now = new Date();
    return now >= viewStart && now < viewEnd;
  }, [calendarRef]);

  const getPrimaryTimeScroller = useCallback((): HTMLElement | null => {
    const container = containerRef.current;
    if (!container) return null;

    const nowLineScroller = container
      .querySelector<HTMLElement>(".fc-timegrid-now-indicator-line")
      ?.closest<HTMLElement>(".fc-scroller");
    if (nowLineScroller) return nowLineScroller;

    const bodyScroller = container
      .querySelector<HTMLElement>(".fc-timegrid-body")
      ?.closest<HTMLElement>(".fc-scroller");
    if (bodyScroller) return bodyScroller;

    const colsScroller = container
      .querySelector<HTMLElement>(".fc-timegrid-cols")
      ?.closest<HTMLElement>(".fc-scroller");
    if (colsScroller) return colsScroller;

    const slotsScroller = container
      .querySelector<HTMLElement>(".fc-timegrid-slots")
      ?.closest<HTMLElement>(".fc-scroller");
    if (slotsScroller) return slotsScroller;

    const scrollers = Array.from(container.querySelectorAll<HTMLElement>(".fc-scroller"));
    if (!scrollers.length) return null;

    const prioritized = scrollers.filter((el) =>
      !!el.querySelector(".fc-timegrid-body, .fc-timegrid-cols, .fc-timegrid-slots"),
    );
    const candidates = prioritized.length ? prioritized : scrollers;

    const withOverflow = candidates.filter((el) => el.scrollHeight > el.clientHeight + 1);
    if (withOverflow.length) {
      withOverflow.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      return withOverflow[0];
    }

    return candidates[0];
  }, [containerRef]);

  const scrollToNow = useCallback(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    if (!isTodayInView()) return;

    const container = containerRef.current;
    if (!container) return;

    const now = new Date();
    api.scrollToTime(
      `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:00`,
    );

    isProgrammaticScrollRef.current = true;

    requestAnimationFrame(() => {
      const nowLine = container.querySelector<HTMLElement>(".fc-timegrid-now-indicator-line");
      const lineScroller = nowLine?.closest<HTMLElement>(".fc-scroller");
      const primaryScroller = lineScroller ?? getPrimaryTimeScroller();

      if (primaryScroller && nowLine) {
        const scrollerRect = primaryScroller.getBoundingClientRect();
        const nowLineRect = nowLine.getBoundingClientRect();
        const lineTopInScroller =
          primaryScroller.scrollTop +
          (nowLineRect.top - scrollerRect.top);
        const targetScrollTop = Math.max(
          0,
          lineTopInScroller - Math.round(primaryScroller.clientHeight * 0.35),
        );

        primaryScroller.scrollTop = targetScrollTop;
      } else {
        // Fallback if indicator isn't mounted yet.
        const visibleHeight = primaryScroller?.clientHeight ?? 0;
        const slotHeight = computedSlotHeight || 45;
        const hoursVisible = visibleHeight > 0
          ? (visibleHeight / slotHeight) / 2
          : 3;
        const offsetHours = hoursVisible / 2;

        const totalMinutes = now.getHours() * 60 + now.getMinutes();
        const offsetMinutes = Math.max(0, totalMinutes - (offsetHours * 60));
        const fallbackScrollHours = Math.floor(offsetMinutes / 60);
        const fallbackScrollMins = Math.floor(offsetMinutes % 60);
        api.scrollToTime(
          `${fallbackScrollHours.toString().padStart(2, "0")}:${fallbackScrollMins.toString().padStart(2, "0")}:00`,
        );
      }

      setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 120);
    });
  }, [calendarRef, computedSlotHeight, containerRef, getPrimaryTimeScroller, isTodayInView]);

  // Follow interval: scroll every minute when active
  useEffect(() => {
    if (!isFollowingNow) return;

    if (!hasInitialScrollRef.current) {
      hasInitialScrollRef.current = true;
      const initialTimeout = setTimeout(() => scrollToNow(), 200);

      followIntervalRef.current = setInterval(() => {
        scrollToNow();
      }, 60000);

      return () => {
        clearTimeout(initialTimeout);
        if (followIntervalRef.current) {
          clearInterval(followIntervalRef.current);
          followIntervalRef.current = null;
        }
      };
    }

    scrollToNow();

    followIntervalRef.current = setInterval(() => {
      scrollToNow();
    }, 60000);

    return () => {
      if (followIntervalRef.current) {
        clearInterval(followIntervalRef.current);
        followIntervalRef.current = null;
      }
    };
  }, [isFollowingNow, scrollToNow]);

  // User interaction detection: disengage follow mode (no auto re-engage)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const disengage = () => {
      if (isFollowingNow) {
        setIsFollowingNow(false);
      }
    };

    const handleUserScroll = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !container.contains(target)) return;

      const isCalendarScroller =
        target.classList.contains("fc-scroller") ||
        !!target.closest(".fc-scroller") ||
        target.classList.contains("bases-calendar-scroll-surface");

      if (!isCalendarScroller) return;

      if (isProgrammaticScrollRef.current) return;
      disengage();
    };

    const handleWheel = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !container.contains(target)) return;
      disengage();
    };

    const handleTouchMove = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !container.contains(target)) return;
      disengage();
    };

    container.addEventListener("scroll", handleUserScroll, { capture: true, passive: true });
    container.addEventListener("wheel", handleWheel, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: true });

    return () => {
      container.removeEventListener("scroll", handleUserScroll, true);
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchmove", handleTouchMove);
    };
  }, [containerRef, isFollowingNow]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (followIntervalRef.current) clearInterval(followIntervalRef.current);
    };
  }, []);

  return {
    isFollowingNow,
    setIsFollowingNow,
    scrollToNow,
    isTodayInView,
  };
}
