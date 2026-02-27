export function installConsoleErrorFilter(): () => void {
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    originalConsoleError(...args);
  };

  return () => {
    console.error = originalConsoleError;
  };
}

export function installDateContainsPolyfill(): void {
  if (typeof (Date.prototype as any).contains === 'function') return;

  (Date.prototype as any).contains = function (target: string) {
    const str = String(this);
    if (typeof (str as any).contains === 'function') {
      return (str as any).contains(target);
    }
    return str.toLowerCase().includes(String(target).toLowerCase());
  };
}
