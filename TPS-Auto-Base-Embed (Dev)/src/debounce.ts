export function debounce<T extends (...args: any[]) => void>(fn: T, wait: number): T {
  let timeout: number | null = null;
  return ((...args: any[]) => {
    if (timeout !== null) {
      window.clearTimeout(timeout);
    }
    timeout = window.setTimeout(() => {
      timeout = null;
      fn(...args);
    }, wait);
  }) as T;
}