import { App, TFile } from "obsidian";
import { Logger } from "./logger";
import { DebounceMap } from "../utils/debounce";
import { repairFrontmatterText } from "../utils/frontmatter-repair";

interface PendingMutation {
  file: TFile;
  reason: string;
  mutate: (frontmatter: Record<string, unknown>) => boolean;
  resolve: (changed: boolean) => void;
}

interface SelfWriteRecord {
  operationId: string;
  until: number;
}

interface ParseFailureRecord {
  until: number;
  failures: number;
}

export interface MetadataManagerOptions {
  batchSize: number;
  queueYieldMs: number;
  selfWriteIgnoreMs: number;
  parseFailureCooldownMs: number;
  enableFrontmatterAutoRepair: boolean;
}

const DEFAULT_OPTIONS: MetadataManagerOptions = {
  batchSize: 5,
  queueYieldMs: 10,
  selfWriteIgnoreMs: 2000,
  parseFailureCooldownMs: 8000,
  enableFrontmatterAutoRepair: true
};

export class MetadataManager {
  private readonly app: App;
  private readonly logger: Logger;
  private readonly options: MetadataManagerOptions;
  private readonly queue: PendingMutation[] = [];
  private readonly selfWrites = new Map<string, SelfWriteRecord>();
  private readonly parseFailures = new Map<string, ParseFailureRecord>();
  private readonly debouncer = new DebounceMap();

  private isProcessing = false;

  constructor(app: App, logger: Logger, options?: Partial<MetadataManagerOptions>) {
    this.app = app;
    this.logger = logger;
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options
    };
  }

  queueFrontmatterUpdate(
    file: TFile,
    reason: string,
    mutate: (frontmatter: Record<string, unknown>) => boolean
  ): Promise<boolean> {
    return new Promise((resolve) => {
      this.queue.push({ file, reason, mutate, resolve });
      this.kick();
    });
  }

  scheduleDebounced(pathKey: string, delayMs: number, callback: () => Promise<void>): void {
    this.debouncer.schedule(pathKey, delayMs, async () => {
      try {
        await callback();
      } catch (error) {
        this.logger.error("Debounced metadata callback failed", error, { path: pathKey });
      }
    });
  }

  shouldIgnoreFileEvent(path: string): boolean {
    const record = this.selfWrites.get(path);
    if (!record) {
      return this.hasActiveParseFailure(path);
    }

    if (Date.now() > record.until) {
      this.selfWrites.delete(path);
      return this.hasActiveParseFailure(path);
    }

    return true;
  }

  dispose(): void {
    this.debouncer.cancelAll();
    this.queue.length = 0;
    this.selfWrites.clear();
    this.parseFailures.clear();
  }

  private kick(): void {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    void this.processQueue();
  }

  private async processQueue(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        let processedInBatch = 0;

        while (processedInBatch < this.options.batchSize && this.queue.length > 0) {
          const next = this.queue.shift();
          if (!next) {
            continue;
          }
          await this.executeMutation(next);
          processedInBatch += 1;
        }

        if (this.queue.length > 0) {
          await this.yieldToUi();
        }
      }
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0) {
        this.kick();
      }
    }
  }

  private async executeMutation(task: PendingMutation): Promise<void> {
    const operationId = this.createOperationId(task.file.path);
    if (this.hasActiveParseFailure(task.file.path)) {
      task.resolve(false);
      return;
    }

    try {
      const changed = await this.runFrontmatterMutation(task);
      this.handleSuccessfulMutation(task.file.path, operationId, changed);
      task.resolve(changed);
    } catch (error) {
      const recovered = await this.tryRecoverFromYamlError(task, error, operationId);
      if (recovered.handled) {
        task.resolve(recovered.changed);
        return;
      }

      this.logger.error("processFrontMatter failed", error, {
        file: task.file.path,
        reason: task.reason,
        operationId
      });
      task.resolve(false);
    }
  }

  private createOperationId(path: string): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path}`;
  }

  private async runFrontmatterMutation(task: PendingMutation): Promise<boolean> {
    let changed = false;
    await this.app.fileManager.processFrontMatter(task.file, (mutableFrontmatter) => {
      const frontmatter = (mutableFrontmatter ?? {}) as Record<string, unknown>;
      changed = task.mutate(frontmatter);
    });
    return changed;
  }

  private handleSuccessfulMutation(path: string, operationId: string, changed: boolean): void {
    this.clearParseFailure(path);
    if (!changed) {
      return;
    }

    this.selfWrites.set(path, {
      operationId,
      until: Date.now() + this.options.selfWriteIgnoreMs
    });
  }

  private async tryRecoverFromYamlError(
    task: PendingMutation,
    error: unknown,
    operationId: string
  ): Promise<{ handled: boolean; changed: boolean }> {
    if (!this.isYamlParseError(error)) {
      return { handled: false, changed: false };
    }

    if (this.hasActiveParseFailure(task.file.path)) {
      this.logger.debug("Skipping metadata mutation while parse-failure cooldown is active", {
        file: task.file.path,
        reason: task.reason
      });
      return { handled: true, changed: false };
    }

    const repaired = this.options.enableFrontmatterAutoRepair
      ? await this.tryRepairMalformedFrontmatter(task.file, task.reason, operationId)
      : false;

    if (repaired) {
      try {
        const changed = await this.runFrontmatterMutation(task);
        this.handleSuccessfulMutation(task.file.path, `${operationId}-retry`, changed);
        this.logger.info("Recovered malformed frontmatter and applied metadata mutation", {
          file: task.file.path,
          reason: task.reason
        });
        return { handled: true, changed: changed || repaired };
      } catch (retryError) {
        this.markParseFailure(task.file.path, task.reason, retryError, operationId);
        return { handled: true, changed: false };
      }
    }

    this.markParseFailure(task.file.path, task.reason, error, operationId);
    return { handled: true, changed: false };
  }

  private async tryRepairMalformedFrontmatter(file: TFile, reason: string, operationId: string): Promise<boolean> {
    let content = "";
    try {
      content = await this.app.vault.cachedRead(file);
    } catch (readError) {
      this.logger.error("Failed to read file for frontmatter repair", readError, {
        file: file.path,
        reason
      });
      return false;
    }

    const repaired = repairFrontmatterText(content);
    if (!repaired.changed) {
      return false;
    }

    try {
      await this.app.vault.modify(file, repaired.content);
    } catch (writeError) {
      this.logger.error("Failed to write repaired frontmatter", writeError, {
        file: file.path,
        reason
      });
      return false;
    }

    this.selfWrites.set(file.path, {
      operationId: `${operationId}-repair`,
      until: Date.now() + this.options.selfWriteIgnoreMs
    });
    this.logger.warn("Auto-repaired malformed frontmatter", {
      file: file.path,
      reason,
      fixes: repaired.fixes.join(", ")
    });
    return true;
  }

  private markParseFailure(path: string, reason: string, error: unknown, operationId: string): void {
    const now = Date.now();
    const existing = this.parseFailures.get(path);
    if (existing && now <= existing.until) {
      this.parseFailures.set(path, {
        until: now + this.options.parseFailureCooldownMs,
        failures: existing.failures + 1
      });
      return;
    }

    this.parseFailures.set(path, {
      until: now + this.options.parseFailureCooldownMs,
      failures: (existing?.failures ?? 0) + 1
    });
    this.logger.warn("Skipping metadata mutation for malformed frontmatter", {
      file: path,
      reason,
      operationId,
      retryInMs: this.options.parseFailureCooldownMs,
      error: this.summarizeError(error)
    });
  }

  private clearParseFailure(path: string): void {
    this.parseFailures.delete(path);
  }

  private hasActiveParseFailure(path: string): boolean {
    const record = this.parseFailures.get(path);
    if (!record) {
      return false;
    }

    if (Date.now() > record.until) {
      this.parseFailures.delete(path);
      return false;
    }

    return true;
  }

  private isYamlParseError(error: unknown): boolean {
    const description = this.summarizeError(error).toLowerCase();
    return (
      description.includes("yamlparseerror") ||
      description.includes("map keys must be unique") ||
      description.includes("nested mappings are not allowed") ||
      (description.includes("yaml") && description.includes("parse"))
    );
  }

  private summarizeError(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    if (typeof error === "string") {
      return error;
    }
    try {
      return JSON.stringify(error);
    } catch (_jsonError) {
      return String(error);
    }
  }

  private async yieldToUi(): Promise<void> {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), this.options.queueYieldMs);
    });
  }
}
