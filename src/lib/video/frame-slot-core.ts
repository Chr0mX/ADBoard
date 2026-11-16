/**
 * Paint at most once per display refresh, without delaying the picture.
 *
 * The first frame of a refresh is painted at once. A frame that arrives
 * before the next refresh (a burst after a stall, a 60 fps phone on a busy
 * page) waits in the slot; a newer one replaces (and closes) it, and the
 * refresh callback paints what is there. Drawing every frame of a burst
 * wastes canvas uploads on pictures that are never seen.
 * Every frame offered is closed exactly once, painted or not: an unclosed
 * VideoFrame pins GPU memory until garbage collection.
 *
 * Pure module: runs under `node --test`.
 */
export interface Closable {
  close(): void;
}

export interface FrameSlot<F extends Closable> {
  /** Take ownership of `frame`. Returns true when it replaced an unpainted one. */
  offer(frame: F): boolean;
  /** Close a waiting frame and cancel the scheduled paint. */
  clear(): void;
}

export function createFrameSlot<F extends Closable>(
  schedule: (run: () => void) => number,
  cancel: (handle: number) => void,
  paint: (frame: F) => void,
): FrameSlot<F> {
  let pending: F | null = null;
  let handle: number | null = null;
  /** A frame was already painted in this refresh. */
  let busy = false;

  const draw = (frame: F) => {
    try {
      paint(frame);
    } finally {
      frame.close();
    }
  };

  const tick = () => {
    handle = null;
    const frame = pending;
    pending = null;
    if (!frame) {
      busy = false;
      return;
    }
    // Painted in this refresh: stay busy until the next one.
    handle = schedule(tick);
    draw(frame);
  };

  return {
    offer(frame) {
      if (!busy) {
        busy = true;
        handle = schedule(tick);
        draw(frame);
        return false;
      }
      const replaced = pending !== null;
      pending?.close();
      pending = frame;
      return replaced;
    },
    clear() {
      if (handle !== null) cancel(handle);
      handle = null;
      busy = false;
      pending?.close();
      pending = null;
    },
  };
}
