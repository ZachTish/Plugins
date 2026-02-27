import { TFile } from "obsidian";
import { VaultWalker } from "../src/services/vault-walker";

class TestLogger {
  errorCalls: Array<{ message: string; data?: Record<string, unknown> }> = [];

  error(message: string, _error?: unknown, data?: Record<string, unknown>): void {
    this.errorCalls.push({ message, data });
  }
}

describe("VaultWalker", () => {
  it("processes files in bounded parallel batches and reports progress", async () => {
    const logger = new TestLogger();
    const walker = new VaultWalker(logger as never, {
      chunkSize: 5,
      chunkDelayMs: 0,
      parallelism: 3
    });

    const files = Array.from({ length: 8 }).map((_, index) => ({
      path: `Folder/File-${index}.md`
    })) as unknown as TFile[];

    const progressValues: number[] = [];

    const result = await walker.walk(
      files,
      async (_file, index) => {
        await Promise.resolve();
        return index % 2 === 0;
      },
      (progress) => {
        progressValues.push(progress.processed);
      }
    );

    expect(result.total).toBe(8);
    expect(result.processed).toBe(8);
    expect(result.changed).toBe(4);
    expect(progressValues[0]).toBe(1);
    expect(progressValues[progressValues.length - 1]).toBe(8);
    expect(logger.errorCalls.length).toBe(0);
  });

  it("logs callback errors and continues walking", async () => {
    const logger = new TestLogger();
    const walker = new VaultWalker(logger as never, {
      chunkSize: 4,
      chunkDelayMs: 0,
      parallelism: 2
    });

    const files = [
      { path: "A.md" },
      { path: "B.md" },
      { path: "C.md" }
    ] as unknown as TFile[];

    const result = await walker.walk(files, async (file) => {
      if (file.path === "B.md") {
        throw new Error("boom");
      }
      return true;
    });

    expect(result.processed).toBe(3);
    expect(result.changed).toBe(2);
    expect(logger.errorCalls.length).toBe(1);
    expect(logger.errorCalls[0]?.data?.file).toBe("B.md");
  });
});
