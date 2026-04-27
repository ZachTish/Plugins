import { App, Notice, TFile } from "obsidian";
import { Logger } from "./logger";
import { DebounceMap } from "../utils/debounce";

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
  private readonly queuedPaths = new Set<string>();
  private readonly activeMutationPaths = new Set<string>();
  private readonly selfWrites = new Map<string, SelfWriteRecord>();
  private readonly parseFailures = new Map<string, ParseFailureRecord>();
  private readonly debouncer = new DebounceMap();
  private readonly unsafeFrontmatterWarnedPaths = new Set<string>();

  private isProcessing = false;

  constructor(app: App, logger: Logger, options?: Partial<MetadataManagerOptions>) {
    this.app = app;
    this.logger = logger;
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options
    };

    // Set up Linter coordination if available
    this.setupLinterCoordination();
  }

  private setupLinterCoordination(): void {
    try {
      // @ts-ignore: External plugin API
      const linterPlugin = this.app.plugins?.getPlugin?.("obsidian-linter");
      if (!linterPlugin?.enabled) {
        return;
      }

      // Note: Linter doesn't expose events, so we rely on enhanced timing
      // When Linter formats frontmatter, the next metadata-change event will be
      // caught by selfWrites tracking (600ms window)
      this.logger.info("Linter plugin detected, enhanced coordination enabled");
    } catch (error) {
      this.logger.debug("Linter coordination setup failed (not critical)", error);
    }
  }

  async queueFrontmatterUpdate(
    file: TFile,
    reason: string,
    mutate: (frontmatter: Record<string, unknown>) => boolean
  ): Promise<boolean> {
    if (!(await this.canMutateFrontmatterSafely(file, reason))) {
      return false;
    }
    if (this.hasActiveParseFailure(file.path)) {
      return false;
    }
    if (this.queuedPaths.has(file.path) || this.activeMutationPaths.has(file.path)) {
      return false;
    }
    return new Promise((resolve) => {
      this.queuedPaths.add(file.path);
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
    this.queuedPaths.clear();
    this.activeMutationPaths.clear();
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
          this.queuedPaths.delete(next.file.path);
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

    this.activeMutationPaths.add(task.file.path);
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
    } finally {
      this.activeMutationPaths.delete(task.file.path);
    }
  }

  private createOperationId(path: string): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path}`;
  }

  private async runFrontmatterMutation(task: PendingMutation): Promise<boolean> {
    let changed = false;
    await this.normalizeLeadingWhitespaceBeforeFrontmatter(task.file);
    const fileManager = this.app.fileManager as any;
    const nativeProcessFrontMatter = typeof fileManager?.__tpsGcmOriginalProcessFrontMatter === "function"
      ? fileManager.__tpsGcmOriginalProcessFrontMatter.bind(fileManager)
      : this.app.fileManager.processFrontMatter.bind(this.app.fileManager);
    await nativeProcessFrontMatter(task.file, (mutableFrontmatter: Record<string, unknown>) => {
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
      // Avoid warning spam while the cooldown is active; the initial warning already
      // includes the file, reason, and remediation guidance.
      this.logger.debug("Parse-failure cooldown active; skipping metadata mutation", {
        file: task.file.path,
        reason: task.reason,
      });
      return { handled: true, changed: false };
    }

    this.logger.warn("YAML parse error - frontmatter mutation skipped for cooldown window", {
      file: task.file.path,
      reason: task.reason,
      suggestion: "Fix YAML syntax manually; plugin will not rewrite malformed frontmatter",
      error: this.summarizeError(error)
    });
    this.markParseFailure(task.file.path, task.reason, error, operationId);
    return { handled: true, changed: false };
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

  validateFrontmatterValue(key: string, value: unknown): boolean {
    // Ensure we're not writing objects/arrays (except for specific fields)
    if (key.toLowerCase() === "tags" && Array.isArray(value)) {
      // Tags array is allowed
      return value.every(v => typeof v === "string");
    }

    // All other fields must be strings or null
    if (value !== null && typeof value !== "string") {
      this.logger.warn("⚠️ Rejecting non-string frontmatter value", {
        key,
        valueType: typeof value,
        suggestion: "Only string values are safe for frontmatter"
      });
      return false;
    }

    // Check for problematic YAML characters in strings
    if (typeof value === "string") {
      // Warn if value contains unquoted colons (Linter will quote)
      if (/:\s/.test(value) && !/^["']/.test(value)) {
        this.logger.debug("Frontmatter value contains colon - Linter may quote this", {
          key,
          value
        });
      }
    }

    return true;
  }

  private async canMutateFrontmatterSafely(file: TFile, reason: string): Promise<boolean> {
    if (!(file instanceof TFile)) return false;
    if (file.extension?.toLowerCase() !== "md") return false;

    await this.normalizeLeadingWhitespaceBeforeFrontmatter(file);
    const issue = await this.getUnsafeFrontmatterIssue(file);
    if (!issue) {
      return true;
    }

    if (!this.unsafeFrontmatterWarnedPaths.has(file.path)) {
      this.unsafeFrontmatterWarnedPaths.add(file.path);
      const message = issue === "frontmatter-not-at-top"
        ? `Skipped frontmatter update for "${file.basename}" (frontmatter is not at the top of the note).`
        : `Skipped frontmatter update for "${file.basename}" (multiple YAML blocks detected).`;
      new Notice(message);
      this.logger.warn("Skipping frontmatter mutation due to unsafe frontmatter structure", {
        file: file.path,
        reason,
        issue,
      });
    }

    return false;
  }

  private async getUnsafeFrontmatterIssue(
    file: TFile,
  ): Promise<"frontmatter-not-at-top" | "duplicate-frontmatter" | null> {
    let content = "";
    try {
      content = await this.app.vault.cachedRead(file);
    } catch (error) {
      this.logger.warn("Failed reading file for frontmatter safety check", {
        file: file.path,
        error: this.summarizeError(error),
      });
      return null;
    }

    if (!content) return null;

    const normalized = content.replace(/\r\n/g, "\n");
    const bomOffset = normalized.startsWith("\uFEFF") ? 1 : 0;
    const body = normalized.slice(bomOffset);

    const trimmedLeading = body.replace(/^\s*/, "");
    const leadingOffset = body.length - trimmedLeading.length;
    const leadingWhitespaceOnly = leadingOffset > 0 && !/\S/.test(body.slice(0, leadingOffset));
    const frontmatterCandidate = body.startsWith("---\n")
      ? body
      : leadingWhitespaceOnly && trimmedLeading.startsWith("---\n")
        ? trimmedLeading
        : null;

    if (frontmatterCandidate) {
      const firstBlock = this.findFrontmatterBlock(frontmatterCandidate, 0);
      if (!firstBlock) return null;

      const trailing = frontmatterCandidate.slice(firstBlock.end);
      const trimmedTrailing = trailing.replace(/^\s*/, "");
      if (trimmedTrailing.startsWith("---\n")) {
        const secondBlock = this.findFrontmatterBlock(trimmedTrailing, 0);
        if (secondBlock && this.looksLikeYamlFrontmatter(secondBlock.body)) {
          return "duplicate-frontmatter";
        }
      }
      return null;
    }

    if (trimmedLeading.startsWith("---\n")) {
      const nestedBlock = this.findFrontmatterBlock(body, leadingOffset);
      if (nestedBlock && this.looksLikeYamlFrontmatter(nestedBlock.body)) {
        return "frontmatter-not-at-top";
      }
    }

    return null;
  }

  private async normalizeLeadingWhitespaceBeforeFrontmatter(file: TFile): Promise<void> {
    let content = "";
    try {
      content = await this.app.vault.cachedRead(file);
    } catch {
      return;
    }

    if (!content) return;

    const normalized = content.replace(/\r\n/g, "\n");
    const bom = normalized.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body = bom ? normalized.slice(1) : normalized;
    if (body.startsWith("---\n")) return;

    const trimmedLeading = body.replace(/^\s*/, "");
    const leadingOffset = body.length - trimmedLeading.length;
    if (leadingOffset <= 0 || !trimmedLeading.startsWith("---\n")) return;

    const prefix = body.slice(0, leadingOffset);
    if (/\S/.test(prefix)) return;

    const liveFile = this.app.vault.getAbstractFileByPath(file.path);
    if (!(liveFile instanceof TFile)) return;

    await this.app.vault.modify(liveFile, `${bom}${trimmedLeading}`);
  }

  private findFrontmatterBlock(
    content: string,
    startIndex: number,
  ): { body: string; end: number } | null {
    if (!content.startsWith("---\n", startIndex)) {
      return null;
    }

    // Look for a closing delimiter. Accept typical cases like "\n---\n"
    // and also allow a closing "\n---" at EOF (no trailing newline).
    const closeWithTrailing = content.indexOf("\n---\n", startIndex + 4);
    if (closeWithTrailing !== -1) {
      return {
        body: content.slice(startIndex + 4, closeWithTrailing),
        end: closeWithTrailing + "\n---\n".length,
      };
    }

    // Fallback: accept a closing delimiter followed by EOF or only whitespace.
    const closeAtEof = content.indexOf("\n---", startIndex + 4);
    if (closeAtEof !== -1) {
      const after = content.slice(closeAtEof + "\n---".length);
      if (/^\s*$/.test(after)) {
        return {
          body: content.slice(startIndex + 4, closeAtEof),
          end: closeAtEof + "\n---".length,
        };
      }
    }

    return null;
  }

  private looksLikeYamlFrontmatter(body: string): boolean {
    return body
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .some((line) => /^[A-Za-z0-9_"'.-]+\s*:/.test(line));
  }
}
