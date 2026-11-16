/**
 * Coalesce "something changed, fetch the list again" requests.
 *
 * Every `device_updated` event used to start its own GET /api/devices. With 12
 * phones a burst of events meant a burst of overlapping fetches whose answers
 * could arrive out of order. Here at most one fetch runs; triggers that arrive
 * meanwhile fold into a single follow-up fetch, and an answer that a newer
 * list has overtaken is thrown away.
 *
 * Pure module: runs under `node --test`.
 */
export interface CoalescedRefresh {
  /** Ask for a refresh. Never starts a second fetch while one runs. */
  trigger(): void;
  /** A newer value arrived another way (a pushed list): drop any answer still on its way. */
  invalidate(): void;
  /** Stop: no further fetches, pending answers are ignored. */
  dispose(): void;
}

export function createCoalescedRefresh<T>(
  fetcher: () => Promise<T>,
  apply: (value: T) => void,
): CoalescedRefresh {
  let running = false;
  let again = false;
  let disposed = false;
  let epoch = 0;

  const run = async () => {
    running = true;
    do {
      again = false;
      const mine = epoch;
      try {
        const value = await fetcher();
        if (!disposed && mine === epoch && !again) apply(value);
      } catch {
        // The next event or the socket's own list brings it up to date.
      }
    } while (again && !disposed);
    running = false;
  };

  return {
    trigger() {
      if (disposed) return;
      if (running) {
        again = true;
        return;
      }
      void run();
    },
    invalidate() {
      epoch += 1;
    },
    dispose() {
      disposed = true;
    },
  };
}
