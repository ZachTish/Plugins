const LOG_PREFIX = "[TPS Controller]";

export function log(...args: any[]): void {
    console.log(LOG_PREFIX, ...args);
}

export function warn(...args: any[]): void {
    console.warn(LOG_PREFIX, ...args);
}

export function error(...args: any[]): void {
    console.error(LOG_PREFIX, ...args);
}
