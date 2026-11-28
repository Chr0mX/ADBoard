/**
 * Rolling video diagnostics: keep the last seconds of every stream, and notice the moment every tile of the
 * page stops painting at once, so the history from just before it can be saved (see hub `saveDiagnostics`
 * and the agent's `POST /api/diagnostics/video-snapshot`). Read-only bookkeeping: nothing here changes how
 * video is handled.
 *
 * Pure module: runs under `node --test`.
 */

/** A fixed-size ring: pushing past the size drops the oldest entry. */
export class Ring<T> {
  private items: T[] = [];
  readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  push(item: T) {
    this.items.push(item);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
  }

  values(): T[] {
    return [...this.items];
  }

  get length() {
    return this.items.length;
  }
}

/** Samples per stream (one per 500 ms tick: 15 s) and events per stream and per page. */
export const SAMPLE_RING = 30;
export const EVENT_RING = 50;

/** A stream counts as stalled when it has not painted for this long. */
export const STALL_MS = 2000;
/** ...and it had painted within this window before that, so a phone that never showed anything is not it. */
export const RECENT_MS = 12_000;
/** After a trigger, keep recording this long before saving, so the snapshot shows what followed. */
export const AFTER_MS = 5000;
/** At most one automatic snapshot this often. */
export const SNAPSHOT_EVERY_MS = 60_000;

export interface StreamPaint {
  /** Views of the phone shown on the page now. */
  views: number;
  /** When it last painted (performance.now), or null if never. */
  lastPaintedAt: number | null;
}

export interface DetectorState {
  /** When the current all-stalled episode was noticed, while its snapshot is still to be saved. */
  pendingSince: number | null;
  lastSnapshotAt: number | null;
}

export function newDetector(): DetectorState {
  return { pendingSince: null, lastSnapshotAt: null };
}

/** Is every shown stream (two or more) stalled, each after painting recently? */
export function allStalled(streams: readonly StreamPaint[], now: number): boolean {
  const shown = streams.filter((s) => s.views > 0);
  if (shown.length < 2) return false;
  return shown.every((s) => s.lastPaintedAt !== null && now - s.lastPaintedAt >= STALL_MS && now - s.lastPaintedAt <= RECENT_MS);
}

/**
 * One look, every tick. `trigger`: an episode just began (record it as an event); `save`: the episode's
 * after-window is over, save the snapshot now.
 */
export function detectorStep(state: DetectorState, streams: readonly StreamPaint[], now: number): { state: DetectorState; trigger: boolean; save: boolean } {
  if (state.pendingSince !== null) {
    if (now - state.pendingSince >= AFTER_MS) return { state: { pendingSince: null, lastSnapshotAt: now }, trigger: false, save: true };
    return { state, trigger: false, save: false };
  }
  if (state.lastSnapshotAt !== null && now - state.lastSnapshotAt < SNAPSHOT_EVERY_MS) return { state, trigger: false, save: false };
  if (!allStalled(streams, now)) return { state, trigger: false, save: false };
  return { state: { ...state, pendingSince: now }, trigger: true, save: false };
}
