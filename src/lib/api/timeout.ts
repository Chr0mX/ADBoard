/**
 * A request that may not hang forever. `fetch` has no timeout of its own: a request stuck behind the browser's
 * six connections per host, or one the agent never answers, stays pending for good, and anything waiting on it
 * waits for good too.
 *
 * Pure module: runs under `node --test`.
 */
export class TimeoutError extends Error {
  readonly ms: number;

  constructor(ms: number) {
    super(`no answer within ${ms} ms`);
    this.name = "TimeoutError";
    this.ms = ms;
  }
}

/** Settles like `work`, or rejects with a `TimeoutError` after `ms`; `onTimeout` runs then (to abort the request). */
export function withTimeout<T>(work: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new TimeoutError(ms));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
