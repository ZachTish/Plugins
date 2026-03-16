export class DebounceMap {
  private readonly timers = new Map<string, number>();

  schedule(key: string, delayMs: number, callback: () => void | Promise<void>): void {
    const existing = this.timers.get(key);
    if (existing != null) {
      window.clearTimeout(existing);
    }

    const timer = window.setTimeout(() => {
      this.timers.delete(key);
      void callback();
    }, Math.max(0, delayMs));

    this.timers.set(key, timer);
  }

  cancel(key: string): void {
    const existing = this.timers.get(key);
    if (existing == null) {
      return;
    }
    window.clearTimeout(existing);
    this.timers.delete(key);
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) {
      window.clearTimeout(timer);
    }
    this.timers.clear();
  }
}
