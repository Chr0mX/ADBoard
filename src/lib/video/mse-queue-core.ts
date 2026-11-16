/**
 * A bounded queue of media segments waiting for the SourceBuffer.
 *
 * The MSE path (pages opened by LAN IP, without WebCodecs) appended every
 * segment to an array and waited for the SourceBuffer. When appends are slower
 * than the stream (a busy iPhone), that array grew without limit. Past `limit`
 * waiting segments the queue is emptied and everything is refused until the
 * next keyframe, the same rule as the WebCodecs decode gate: a gap in delta
 * frames cannot be decoded anyway.
 *
 * Pure module: runs under `node --test`.
 */
export const MAX_MSE_QUEUE = 90;

export interface BoundedSegmentQueue<T> {
  /** Add a segment; false when it was refused (dropping until a keyframe). */
  push(segment: T, isKey: boolean): boolean;
  /** Add a segment that must never be dropped (the init segment). */
  pushRequired(segment: T): void;
  shift(): T | undefined;
  unshift(segment: T): void;
  clear(): void;
  readonly length: number;
  /** Segments refused or thrown away so far. */
  readonly dropped: number;
}

export function createSegmentQueue<T>(limit = MAX_MSE_QUEUE): BoundedSegmentQueue<T> {
  let items: T[] = [];
  let dropping = false;
  let dropped = 0;
  return {
    push(segment, isKey) {
      if (dropping) {
        if (!isKey) {
          dropped += 1;
          return false;
        }
        dropping = false;
      }
      if (items.length >= limit) {
        dropped += items.length + 1;
        items = [];
        dropping = true;
        return false;
      }
      items.push(segment);
      return true;
    },
    pushRequired(segment) {
      items.push(segment);
    },
    shift: () => items.shift(),
    unshift(segment) {
      items.unshift(segment);
    },
    clear() {
      items = [];
      dropping = false;
    },
    get length() {
      return items.length;
    },
    get dropped() {
      return dropped;
    },
  };
}

/** Keep at most this many seconds of already played video in the SourceBuffer. */
export const MSE_KEEP_BEHIND_SECONDS = 4;

/** The range of played media to remove, or null when there is too little to bother. */
export function trimRange(bufferedStart: number, currentTime: number): { start: number; end: number } | null {
  const end = currentTime - MSE_KEEP_BEHIND_SECONDS;
  return end - bufferedStart >= 2 ? { start: bufferedStart, end } : null;
}
