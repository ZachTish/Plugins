import { TFile } from "obsidian";
import { Logger } from "./logger";

export interface VaultWalkerOptions {
  chunkSize: number;
  chunkDelayMs: number;
  parallelism: number;
}

export interface VaultWalkerProgress {
  processed: number;
  total: number;
  changed: number;
  currentPath: string;
}

export interface VaultWalkerResult {
  processed: number;
  total: number;
  changed: number;
}

const DEFAULT_WALKER_OPTIONS: VaultWalkerOptions = {
  chunkSize: 100,
  chunkDelayMs: 10,
  parallelism: 3
};

export class VaultWalker {
  private readonly logger: Logger;
  private readonly options: VaultWalkerOptions;

  constructor(logger: Logger, options?: Partial<VaultWalkerOptions>) {
    this.logger = logger;
    this.options = {
      ...DEFAULT_WALKER_OPTIONS,
      ...options,
      parallelism: normalizeParallelism(options?.parallelism ?? DEFAULT_WALKER_OPTIONS.parallelism)
    };
  }

  async walk(
    files: TFile[],
    onFile: (file: TFile, index: number) => Promise<boolean>,
    onProgress?: (progress: VaultWalkerProgress) => void
  ): Promise<VaultWalkerResult> {
    const total = files.length;
    let processed = 0;
    let changed = 0;

    while (processed < total) {
      const chunkEnd = Math.min(processed + this.options.chunkSize, total);

      for (let batchStart = processed; batchStart < chunkEnd; batchStart += this.options.parallelism) {
        const batchEnd = Math.min(batchStart + this.options.parallelism, chunkEnd);
        const batchIndexes = range(batchStart, batchEnd);

        const batchResults = await Promise.all(
          batchIndexes.map(async (idx) => {
            const file = files[idx];
            try {
              const didChange = await onFile(file, idx);
              return { idx, file, didChange };
            } catch (error) {
              this.logger.error("Vault walker file callback failed", error, { file: file.path, index: idx });
              return { idx, file, didChange: false };
            }
          })
        );

        batchResults.sort((a, b) => a.idx - b.idx);
        for (const result of batchResults) {
          if (result.didChange) {
            changed += 1;
          }
          processed += 1;
          onProgress?.({
            processed,
            total,
            changed,
            currentPath: result.file.path
          });
        }
      }

      if (processed < total) {
        await this.yieldToUi();
      }
    }

    return {
      processed,
      total,
      changed
    };
  }

  private async yieldToUi(): Promise<void> {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(() => resolve(), this.options.chunkDelayMs);
    });
  }
}

function range(start: number, end: number): number[] {
  const values: number[] = [];
  for (let value = start; value < end; value += 1) {
    values.push(value);
  }
  return values;
}

function normalizeParallelism(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(Math.floor(value), 16);
}
