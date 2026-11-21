/**
 * Undo for the full-screen step editor.
 *
 * Each change keeps a snapshot of the steps from before it. Changes that
 * follow each other quickly (dragging a marker fires dozens of moves) count as
 * one, so Undo takes back the whole drag, not one pixel of it.
 *
 * Pure module: runs under `node --test`.
 */
export interface PlaceHistory<T> {
  /**
   * Remember `before` as the state to return to. `joinable` changes (a drag)
   * that follow each other quickly count as one; adding or deleting a step
   * (`joinable` false) always gets its own entry.
   */
  push(before: T, now: number, joinable?: boolean): void;
  /** The snapshot to restore, or undefined when there is nothing to undo. */
  undo(): T | undefined;
  readonly size: number;
  clear(): void;
}

export function createPlaceHistory<T>(limit = 30, coalesceMs = 600): PlaceHistory<T> {
  let stack: T[] = [];
  let lastAt = -Infinity;
  return {
    push(before, now, joinable = true) {
      const quick = joinable && now - lastAt < coalesceMs;
      lastAt = joinable ? now : -Infinity;
      // A quick follow-up change belongs to the same gesture: keep its first snapshot.
      if (quick && stack.length > 0) return;
      stack.push(before);
      if (stack.length > limit) stack = stack.slice(stack.length - limit);
    },
    undo() {
      lastAt = -Infinity;
      return stack.pop();
    },
    get size() {
      return stack.length;
    },
    clear() {
      stack = [];
      lastAt = -Infinity;
    },
  };
}
