/**
 * Reconnect timing for the agent's WebSockets.
 *
 * A fixed 2 s retry made every socket of the page (12 video streams, events,
 * clipboard) knock at the same instant, every 2 s, for as long as the agent
 * was away. Backoff with jitter starts faster (so a quick restart is picked up
 * sooner), slows down while the agent stays away, and spreads the sockets out.
 *
 * Pure module: runs under `node --test`.
 */
export interface Backoff {
  /** Delay before the next attempt, in ms. */
  next(): number;
  /** The connection worked: start from the short delay again. */
  reset(): void;
}

export function createBackoff(options: { baseMs?: number; maxMs?: number; random?: () => number } = {}): Backoff {
  const baseMs = options.baseMs ?? 400;
  const maxMs = options.maxMs ?? 8000;
  const random = options.random ?? Math.random;
  let attempt = 0;
  return {
    next() {
      // Grows by half each time: an agent restart takes a few seconds, and the
      // gap between attempts must stay short for that long.
      const ceiling = Math.min(maxMs, baseMs * 1.5 ** attempt);
      attempt = Math.min(attempt + 1, 30);
      // "Equal jitter": between half and all of the ceiling.
      return Math.round(ceiling / 2 + random() * (ceiling / 2));
    },
    reset() {
      attempt = 0;
    },
  };
}

/**
 * Has a socket that promised a heartbeat every `heartbeatSeconds` gone quiet?
 * Three missed beats count as dead. No promise (an older agent) is never stale:
 * a phone showing a still screen legitimately sends nothing.
 */
export function isStale(lastMessageAt: number, now: number, heartbeatSeconds: number | null): boolean {
  if (!heartbeatSeconds || heartbeatSeconds <= 0) return false;
  return now - lastMessageAt > heartbeatSeconds * 3000;
}
