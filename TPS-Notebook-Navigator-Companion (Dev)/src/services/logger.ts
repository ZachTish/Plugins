const DEDUP_WINDOW_MS = 3000;
const MAX_TRACKED_DUPLICATES = 300;
const MAX_STORED_ENTRIES = 600;
const MAX_SERIALIZED_DEPTH = 4;
const MAX_SERIALIZED_ARRAY_LENGTH = 20;
const MAX_SERIALIZED_OBJECT_KEYS = 25;

type LogLevel = "debug" | "info" | "warn" | "error";
type SuiteGlobal = typeof globalThis & { __TPS_SUITE_LOGS__?: SuiteLogStore };

export interface LoggerOptions {
  prefix: string;
  debugEnabled: () => boolean;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

export interface LogEntry {
  seq: number;
  plugin: string;
  prefix: string;
  level: LogLevel;
  message: string;
  at: string;
  time: string;
  relativeMs: number;
  contexts?: unknown[];
  errors?: SerializedError[];
}

interface DuplicateState {
  level: LogLevel;
  message: string;
  contexts: unknown[];
  firstSeen: number;
  lastSeen: number;
  suppressed: number;
}

interface SuiteLogStore {
  version: number;
  startedAt: string;
  startedAtMs: number;
  nextSeq: number;
  entries: LogEntry[];
  maxEntries: number;
  getEntries(limit?: number): LogEntry[];
  clear(): void;
}

interface EmitOptions {
  allowWhenDebugDisabled?: boolean;
  dedupe?: boolean;
}

export class Logger {
  private readonly prefix: string;
  private readonly debugEnabled: () => boolean;
  private readonly duplicateStates = new Map<string, DuplicateState>();

  constructor(options: LoggerOptions) {
    this.prefix = options.prefix;
    this.debugEnabled = options.debugEnabled;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.emit("debug", message, data ? [data] : []);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.emit("info", message, data ? [data] : [], { allowWhenDebugDisabled: true });
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.emit("warn", message, data ? [data] : [], { allowWhenDebugDisabled: true });
  }

  error(message: string, error?: unknown, data?: Record<string, unknown>): void {
    const contexts: unknown[] = [];
    if (data) {
      contexts.push(data);
    }
    if (error !== undefined) {
      contexts.push(error);
    }
    this.emit("error", message, contexts, { allowWhenDebugDisabled: true });
  }

  getRecentLogs(limit?: number): LogEntry[] {
    this.flushExpiredDuplicates();
    return getSuiteLogStore().getEntries(limit);
  }

  private emit(level: LogLevel, message: string, rawContexts: unknown[], options: EmitOptions = {}): void {
    this.flushExpiredDuplicates();
    if (!options.allowWhenDebugDisabled && level === "debug" && !this.debugEnabled()) {
      return;
    }

    const normalizedContexts = rawContexts
      .map((item) => normalizeValue(item))
      .filter((item) => item !== undefined);
    const errors = extractErrors(rawContexts);

    if (options.dedupe !== false && this.shouldSuppressDuplicate(level, message, normalizedContexts)) {
      return;
    }

    this.writeEntry(this.createEntry(level, message, normalizedContexts, errors));
  }

  private shouldSuppressDuplicate(level: LogLevel, message: string, contexts: unknown[]): boolean {
    const key = buildDedupKey(level, message, contexts);
    const now = Date.now();
    const existing = this.duplicateStates.get(key);
    if (!existing) {
      this.duplicateStates.set(key, {
        level,
        message,
        contexts,
        firstSeen: now,
        lastSeen: now,
        suppressed: 0,
      });
      this.pruneDuplicateStates();
      return false;
    }

    if (now - existing.lastSeen < DEDUP_WINDOW_MS) {
      existing.lastSeen = now;
      existing.suppressed += 1;
      return true;
    }

    this.flushDuplicateState(key, existing);
    this.duplicateStates.set(key, {
      level,
      message,
      contexts,
      firstSeen: now,
      lastSeen: now,
      suppressed: 0,
    });
    return false;
  }

  private flushExpiredDuplicates(force = false): void {
    const now = Date.now();
    for (const [key, state] of this.duplicateStates.entries()) {
      if (!force && now - state.lastSeen < DEDUP_WINDOW_MS) {
        continue;
      }
      this.flushDuplicateState(key, state);
    }
  }

  private flushDuplicateState(key: string, state: DuplicateState): void {
    if (state.suppressed > 0) {
      this.writeEntry(
        this.createEntry(
          state.level === "error" ? "error" : "info",
          `[Logger] Suppressed ${state.suppressed} duplicate ${state.level} entr${state.suppressed === 1 ? "y" : "ies"}: ${state.message}`,
          [{
            originalLevel: state.level,
            firstSeen: new Date(state.firstSeen).toISOString(),
            lastSeen: new Date(state.lastSeen).toISOString(),
            durationMs: state.lastSeen - state.firstSeen,
            sampleContext: state.contexts.length <= 1 ? state.contexts[0] : state.contexts,
          }],
          [],
        ),
      );
    }

    this.duplicateStates.delete(key);
  }

  private pruneDuplicateStates(): void {
    if (this.duplicateStates.size <= MAX_TRACKED_DUPLICATES) {
      return;
    }

    for (const [key, state] of this.duplicateStates.entries()) {
      this.flushDuplicateState(key, state);
      if (this.duplicateStates.size <= MAX_TRACKED_DUPLICATES) {
        return;
      }
    }
  }

  private createEntry(level: LogLevel, message: string, contexts: unknown[], errors: SerializedError[]): LogEntry {
    const store = getSuiteLogStore();
    const now = Date.now();
    const iso = new Date(now).toISOString();

    return {
      seq: store.nextSeq++,
      plugin: this.prefix,
      prefix: `[${this.prefix}]`,
      level,
      message,
      at: iso,
      time: iso.slice(11, 23),
      relativeMs: now - store.startedAtMs,
      ...(contexts.length > 0 ? { contexts } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    };
  }

  private writeEntry(entry: LogEntry): void {
    const store = getSuiteLogStore();
    store.entries.push(entry);
    if (store.entries.length > store.maxEntries) {
      store.entries.splice(0, store.entries.length - store.maxEntries);
    }

    const header = `[${this.prefix}] [${entry.level.toUpperCase()} #${entry.seq} +${entry.relativeMs}ms ${entry.time}] ${entry.message}`;
    const payload = createConsolePayload(entry);
    const method = resolveConsoleMethod(entry.level);
    if (payload === undefined) {
      method(header);
      return;
    }
    method(header, payload);
  }
}

function createConsolePayload(entry: LogEntry): unknown {
  const hasContexts = Array.isArray(entry.contexts) && entry.contexts.length > 0;
  const hasErrors = Array.isArray(entry.errors) && entry.errors.length > 0;

  if (hasContexts && !hasErrors && entry.contexts!.length === 1) {
    return entry.contexts![0];
  }
  if (!hasContexts && hasErrors && entry.errors!.length === 1) {
    return entry.errors![0];
  }

  if (!hasContexts && !hasErrors) {
    return undefined;
  }

  return {
    ...(hasContexts ? { contexts: entry.contexts } : {}),
    ...(hasErrors ? { errors: entry.errors } : {}),
  };
}

function resolveConsoleMethod(level: LogLevel): (...args: unknown[]) => void {
  if (level === "error") {
    return console.error.bind(console);
  }
  if (level === "warn") {
    return console.warn.bind(console);
  }
  return console.info.bind(console);
}

function buildDedupKey(level: LogLevel, message: string, contexts: unknown[]): string {
  let serializedContexts = "";
  try {
    serializedContexts = JSON.stringify(contexts);
  } catch {
    serializedContexts = String(contexts);
  }
  if (serializedContexts.length > 1000) {
    serializedContexts = `${serializedContexts.slice(0, 1000)}...`;
  }
  return `${level}:${message}:${serializedContexts}`;
}

function extractErrors(items: unknown[]): SerializedError[] {
  const errors: SerializedError[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    collectErrors(item, errors, seen);
  }
  return errors;
}

function collectErrors(value: unknown, errors: SerializedError[], seen: Set<string>, depth = 0): void {
  if (value instanceof Error) {
    const serialized = serializeError(value);
    const key = `${serialized.name}:${serialized.message}:${serialized.stack || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      errors.push(serialized);
    }
    return;
  }

  if (!value || typeof value !== "object" || depth >= 2) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, MAX_SERIALIZED_ARRAY_LENGTH)) {
      collectErrors(item, errors, seen, depth + 1);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if ("error" in record) {
    collectErrors(record.error, errors, seen, depth + 1);
  }
  if ("cause" in record) {
    collectErrors(record.cause, errors, seen, depth + 1);
  }
}

function serializeError(error: Error): SerializedError {
  const serialized: SerializedError = {
    name: error.name,
    message: error.message,
  };
  if (typeof error.stack === "string" && error.stack.length > 0) {
    serialized.stack = error.stack;
  }
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined) {
    serialized.cause = normalizeValue(cause, 1);
  }
  return serialized;
}

function normalizeValue(value: unknown, depth = 0, seen?: WeakSet<object>): unknown {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_SERIALIZED_DEPTH) {
      return `[Array(${value.length})]`;
    }
    const normalized = value
      .slice(0, MAX_SERIALIZED_ARRAY_LENGTH)
      .map((item) => normalizeValue(item, depth + 1, seen));
    if (value.length > MAX_SERIALIZED_ARRAY_LENGTH) {
      normalized.push(`[+${value.length - MAX_SERIALIZED_ARRAY_LENGTH} more]`);
    }
    return normalized;
  }

  if (value instanceof Map) {
    if (depth >= MAX_SERIALIZED_DEPTH) {
      return `[Map(${value.size})]`;
    }
    return {
      __type: "Map",
      entries: Array.from(value.entries())
        .slice(0, MAX_SERIALIZED_ARRAY_LENGTH)
        .map(([key, entryValue]) => [normalizeValue(key, depth + 1, seen), normalizeValue(entryValue, depth + 1, seen)]),
      ...(value.size > MAX_SERIALIZED_ARRAY_LENGTH ? { __truncatedEntries: value.size - MAX_SERIALIZED_ARRAY_LENGTH } : {}),
    };
  }

  if (value instanceof Set) {
    if (depth >= MAX_SERIALIZED_DEPTH) {
      return `[Set(${value.size})]`;
    }
    return {
      __type: "Set",
      values: Array.from(value.values())
        .slice(0, MAX_SERIALIZED_ARRAY_LENGTH)
        .map((entryValue) => normalizeValue(entryValue, depth + 1, seen)),
      ...(value.size > MAX_SERIALIZED_ARRAY_LENGTH ? { __truncatedEntries: value.size - MAX_SERIALIZED_ARRAY_LENGTH } : {}),
    };
  }

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const activeSeen = seen ?? new WeakSet<object>();
    if (activeSeen.has(objectValue)) {
      return "[Circular]";
    }

    if (depth >= MAX_SERIALIZED_DEPTH) {
      return `[${objectValue.constructor?.name || "Object"}]`;
    }

    activeSeen.add(objectValue);
    const entries = Object.entries(objectValue);
    const normalized: Record<string, unknown> = {};
    const ctorName = objectValue.constructor?.name;
    if (ctorName && ctorName !== "Object") {
      normalized.__type = ctorName;
    }
    for (const [key, entryValue] of entries.slice(0, MAX_SERIALIZED_OBJECT_KEYS)) {
      normalized[key] = normalizeValue(entryValue, depth + 1, activeSeen);
    }
    if (entries.length > MAX_SERIALIZED_OBJECT_KEYS) {
      normalized.__truncatedKeys = entries.length - MAX_SERIALIZED_OBJECT_KEYS;
    }
    activeSeen.delete(objectValue);
    return normalized;
  }

  return String(value);
}

function getSuiteLogStore(): SuiteLogStore {
  const root = globalThis as SuiteGlobal;
  if (root.__TPS_SUITE_LOGS__) {
    return root.__TPS_SUITE_LOGS__;
  }

  const store: SuiteLogStore = {
    version: 1,
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    nextSeq: 1,
    entries: [],
    maxEntries: MAX_STORED_ENTRIES,
    getEntries(limit?: number): LogEntry[] {
      if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
        return [...store.entries];
      }
      return store.entries.slice(-Math.floor(limit));
    },
    clear(): void {
      store.entries.length = 0;
    },
  };

  root.__TPS_SUITE_LOGS__ = store;
  return store;
}
