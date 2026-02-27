export type MaybePromise = void | Promise<unknown>;

interface RunAsyncActionOptions {
  onError?: (error: unknown) => void;
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as PromiseLike<unknown>).then === "function";
}

export function runAsyncAction(action: () => MaybePromise, options?: RunAsyncActionOptions): void {
  const onError = options?.onError ?? ((error: unknown) => console.error("[TPS GCM] Unhandled async action error", error));

  try {
    const result = action();
    if (isPromiseLike(result)) {
      void result.catch(onError);
    }
  } catch (error) {
    onError(error);
  }
}
