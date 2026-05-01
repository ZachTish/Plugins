const PLUGIN_PREFIX = "[Global Context Menu]";
const PLUGIN_NAME = "Global Context Menu";
const DEDUP_WINDOW_MS = 3000;
const MAX_TRACKED_DUPLICATES = 300;
const MAX_STORED_ENTRIES = 600;
const MAX_SERIALIZED_DEPTH = 4;
const MAX_SERIALIZED_ARRAY_LENGTH = 20;
const MAX_SERIALIZED_OBJECT_KEYS = 25;

type LogLevel = "debug" | "info" | "warn" | "error";
type SuiteGlobal = typeof globalThis & { __TPS_SUITE_LOGS__?: SuiteLogStore };

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
  allowWhenDisabled?: boolean;
  dedupe?: boolean;
}

let loggingEnabled = false;
const duplicateStates = new Map<string, DuplicateState>();

export function setLoggingEnabled(value: boolean): void {
  loggingEnabled = !!value;
  if (loggingEnabled) {
    const store = getSuiteLogStore();
    emit(
      "info",
      "[Logger] Debug logging enabled",
      [{ inspect: "globalThis.__TPS_SUITE_LOGS__.getEntries()", retainedEntries: store.entries.length }],
      { allowWhenDisabled: true, dedupe: false },
    );
    return;
  }

  flushExpiredDuplicates(true);
}

export function log(message?: unknown, ...optionalParams: unknown[]): void {
  emit("info", message, optionalParams);
}

export function debug(message?: unknown, ...optionalParams: unknown[]): void {
  emit("debug", message, optionalParams);
}

export function info(message?: unknown, ...optionalParams: unknown[]): void {
  emit("info", message, optionalParams);
}

export function warn(message?: unknown, ...optionalParams: unknown[]): void {
  emit("warn", message, optionalParams);
}

export function error(message?: unknown, ...optionalParams: unknown[]): void {
  emit("error", message, optionalParams, { allowWhenDisabled: true });
}

export function getRecentLogs(limit?: number): LogEntry[] {
  flushExpiredDuplicates();
  return getSuiteLogStore().getEntries(limit);
}

export function clearRecentLogs(): void {
  duplicateStates.clear();
  getSuiteLogStore().clear();
}

function emit(level: LogLevel, message?: unknown, rawContexts: unknown[] = [], options: EmitOptions = {}): void {
  flushExpiredDuplicates();
  if (!options.allowWhenDisabled && level !== "error" && !loggingEnabled) {
    return;
  }

  const normalizedMessage = normalizeMessage(message);
  const normalizedContexts = rawContexts
    .map((item) => normalizeValue(item))
    .filter((item) => item !== undefined);
  const errors = extractErrors([message, ...rawContexts]);

  if (options.dedupe !== false && shouldSuppressDuplicate(level, normalizedMessage, normalizedContexts)) {
    return;
  }

  writeEntry(createEntry(level, normalizedMessage, normalizedContexts, errors));
}

function shouldSuppressDuplicate(level: LogLevel, message: string, contexts: unknown[]): boolean {
  const key = buildDedupKey(level, message, contexts);
  const now = Date.now();
  const existing = duplicateStates.get(key);
  if (!existing) {
    duplicateStates.set(key, {
      level,
      message,
      contexts,
      firstSeen: now,
      lastSeen: now,
      suppressed: 0,
    });
    pruneDuplicateStates();
    return false;
  }

  if (now - existing.lastSeen < DEDUP_WINDOW_MS) {
    existing.lastSeen = now;
    existing.suppressed += 1;
    return true;
  }

  flushDuplicateState(key, existing);
  duplicateStates.set(key, {
    level,
    message,
    contexts,
    firstSeen: now,
    lastSeen: now,
    suppressed: 0,
  });
  return false;
}

function flushExpiredDuplicates(force = false): void {
  const now = Date.now();
  for (const [key, state] of duplicateStates.entries()) {
    if (!force && now - state.lastSeen < DEDUP_WINDOW_MS) {
      continue;
    }
    flushDuplicateState(key, state);
  }
}

function flushDuplicateState(key: string, state: DuplicateState): void {
  if (state.suppressed > 0) {
    writeEntry(
      createEntry(
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

  duplicateStates.delete(key);
}

function pruneDuplicateStates(): void {
  if (duplicateStates.size <= MAX_TRACKED_DUPLICATES) {
    return;
  }

  for (const [key, state] of duplicateStates.entries()) {
    flushDuplicateState(key, state);
    if (duplicateStates.size <= MAX_TRACKED_DUPLICATES) {
      return;
    }
  }
}

function createEntry(level: LogLevel, message: string, contexts: unknown[], errors: SerializedError[]): LogEntry {
  const store = getSuiteLogStore();
  const now = Date.now();
  const iso = new Date(now).toISOString();

  return {
    seq: store.nextSeq++,
    plugin: PLUGIN_NAME,
    prefix: PLUGIN_PREFIX,
    level,
    message,
    at: iso,
    time: iso.slice(11, 23),
    relativeMs: now - store.startedAtMs,
    ...(contexts.length > 0 ? { contexts } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}

function writeEntry(entry: LogEntry): void {
  const store = getSuiteLogStore();
  store.entries.push(entry);
  if (store.entries.length > store.maxEntries) {
    store.entries.splice(0, store.entries.length - store.maxEntries);
  }

  const header = `${PLUGIN_PREFIX} [${entry.level.toUpperCase()} #${entry.seq} +${entry.relativeMs}ms ${entry.time}] ${entry.message}`;
  const payload = createConsolePayload(entry);
  const method = resolveConsoleMethod(entry.level);
  if (payload === undefined) {
    method(header);
    return;
  }
  method(header, payload);
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

function normalizeMessage(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof Error) {
    return message.message || message.name;
  }
  if (message === undefined) {
    return "";
  }
  const normalized = normalizeValue(message);
  if (typeof normalized === "string") {
    return normalized;
  }
  try {
    return JSON.stringify(normalized);
  } catch {
    return String(message);
  }
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

function prependScope(scope: string, message?: unknown): string {
  const normalized = normalizeMessage(message);
  return normalized ? `[${scope}] ${normalized}` : `[${scope}]`;
}

export interface ScopedLogger {
  log(message?: unknown, ...rest: unknown[]): void;
  debug(message?: unknown, ...rest: unknown[]): void;
  info(message?: unknown, ...rest: unknown[]): void;
  warn(message?: unknown, ...rest: unknown[]): void;
  error(message?: unknown, ...rest: unknown[]): void;
}

export function createScoped(scope: string): ScopedLogger {
  return {
    log: (msg?: unknown, ...rest: unknown[]) => log(prependScope(scope, msg), ...rest),
    debug: (msg?: unknown, ...rest: unknown[]) => debug(prependScope(scope, msg), ...rest),
    info: (msg?: unknown, ...rest: unknown[]) => info(prependScope(scope, msg), ...rest),
    warn: (msg?: unknown, ...rest: unknown[]) => warn(prependScope(scope, msg), ...rest),
    error: (msg?: unknown, ...rest: unknown[]) => error(prependScope(scope, msg), ...rest),
  };
}
