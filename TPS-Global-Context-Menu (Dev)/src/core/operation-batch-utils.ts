export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 0);
  });
}

export async function runInBatches<T>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<void>,
  batchSize = 50,
): Promise<void> {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }

  const effectiveBatchSize = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : 50;

  for (let index = 0; index < items.length; index += 1) {
    await worker(items[index], index);
    if ((index + 1) % effectiveBatchSize === 0 && index < items.length - 1) {
      await yieldToEventLoop();
    }
  }
}
