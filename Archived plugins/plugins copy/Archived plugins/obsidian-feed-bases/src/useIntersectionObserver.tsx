import { RefObject, useEffect, useState } from "react";

export function useIsVisible(
  ref: RefObject<HTMLElement | null>,
  options?: IntersectionObserverInit
): boolean {
  const [hasBeenVisible, setHasBeenVisible] = useState(false);

  useEffect(() => {
    if (hasBeenVisible) return;
    const node = ref.current;
    if (!node) return;

    if (typeof IntersectionObserver === "undefined") {
      setHasBeenVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          setHasBeenVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px 0px", threshold: 0.01, ...options }
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [ref, hasBeenVisible, options]);

  return hasBeenVisible;
}
