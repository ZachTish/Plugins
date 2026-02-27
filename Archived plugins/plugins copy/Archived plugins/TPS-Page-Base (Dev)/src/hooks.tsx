import { useContext, useEffect, useRef, useState, RefObject } from "react";
import { App } from "obsidian";
import { AppContext } from "./context";

export const useApp = (): App | undefined => {
  return useContext(AppContext);
};

/**
 * Hook that detects if an element is visible in the viewport.
 * Returns true if element is currently visible OR was ever visible.
 */
export function useIsVisible(
  ref: RefObject<HTMLElement>,
  options?: IntersectionObserverInit
): boolean {
  const [isVisible, setIsVisible] = useState(false);
  const hasBeenVisibleRef = useRef(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Create observer with 200px rootMargin for pre-loading
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          hasBeenVisibleRef.current = true;
        }
      },
      {
        rootMargin: "200px",
        ...options,
      }
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [ref, options]);

  // Return true if currently visible OR was ever visible (avoid thrashing)
  return isVisible || hasBeenVisibleRef.current;
}
