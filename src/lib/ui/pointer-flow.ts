/*
 * Finger and mouse events from a screen tile must reach the agent in the order
 * they happened, and a fast drag must not flood it. These two helpers are what
 * the main screen already did inline; the grid tiles use them too.
 */

/**
 * Runs tasks one after another in the order they were queued. A task that
 * fails does not stop the ones after it. Without this, two requests can be in
 * flight together and an "up" can overtake the "move" before it.
 */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const next = tail.then(task, task);
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
