/*
 * Finger and mouse events from a screen tile must reach the agent in the order
 * they happened, and a fast drag must not flood it. These two helpers are what
 * the main screen already did inline; the grid tiles use them too.
 */

/**
 * Runs tasks one after another in the order they were queued. A task that
 * fails does not stop the ones after it. Without this, two requests can be in
 * flight together and an "up" can overtake the "move" before it.
 *
 * A task queued with `coalesce` (a finger or mouse move) is skipped when a newer
 * coalescing task was queued after it with nothing else in between: only the
 * latest position is sent. Before, every move of a fast drag was sent one after
 * another, so a slow answer let them pile up and the phone replayed old moves for
 * seconds. A move is never skipped in favour of one queued after a down, up or
 * cancel, so the last position before a release always arrives. A skipped task
 * resolves to `undefined`.
 */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  // Bumped by every task that is not a move; a move only gives way to a newer move of the same stretch.
  let stretch = 0;
  let moves = 0;
  const latestInStretch = new Map<number, number>();
  return {
    run<T>(task: () => Promise<T>, options: { coalesce?: boolean } = {}): Promise<T | undefined> {
      let guarded: () => Promise<T | undefined> = task;
      if (options.coalesce) {
        const mine = ++moves;
        const myStretch = stretch;
        latestInStretch.set(myStretch, mine);
        guarded = () => {
          if (latestInStretch.get(myStretch) !== mine) return Promise.resolve(undefined);
          latestInStretch.delete(myStretch);
          return task();
        };
      } else {
        stretch += 1;
      }
      const next = tail.then(guarded, guarded);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

export interface MoveState {
  lastX: number;
  lastY: number;
  /** `performance.now()` when the last move was sent. */
  lastSent: number;
}

/**
 * A move that is both sooner than 16 ms after the last one and less than 2 px
 * away from it adds nothing, so it is not sent. Down, up and cancel always are.
 */
export function shouldSendMove(last: MoveState, x: number, y: number, now: number): boolean {
  const dx = x - last.lastX;
  const dy = y - last.lastY;
  return !(now - last.lastSent < 16 && dx * dx + dy * dy < 4);
}
