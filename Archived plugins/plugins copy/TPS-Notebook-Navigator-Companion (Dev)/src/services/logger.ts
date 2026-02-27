export interface LoggerOptions {
  prefix: string;
  debugEnabled: () => boolean;
}

export class Logger {
  private readonly prefix: string;
  private readonly debugEnabled: () => boolean;

  constructor(options: LoggerOptions) {
    this.prefix = options.prefix;
    this.debugEnabled = options.debugEnabled;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (!this.debugEnabled()) {
      return;
    }
    if (data) {
      console.info(`[${this.prefix}] ${message}`, data);
      return;
    }
    console.info(`[${this.prefix}] ${message}`);
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (data) {
      console.info(`[${this.prefix}] ${message}`, data);
      return;
    }
    console.info(`[${this.prefix}] ${message}`);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (data) {
      console.warn(`[${this.prefix}] ${message}`, data);
      return;
    }
    console.warn(`[${this.prefix}] ${message}`);
  }

  error(message: string, error?: unknown, data?: Record<string, unknown>): void {
    if (data && error !== undefined) {
      console.error(`[${this.prefix}] ${message}`, { ...data, error });
      return;
    }
    if (error !== undefined) {
      console.error(`[${this.prefix}] ${message}`, error);
      return;
    }
    if (data) {
      console.error(`[${this.prefix}] ${message}`, data);
      return;
    }
    console.error(`[${this.prefix}] ${message}`);
  }
}
