/**
 * When to suspend a stream nobody is looking at.
 *
 * A hidden stream already skips decoding, but its socket kept receiving every
 * frame: bytes, wake-ups and memory spent on pictures that are thrown away,
 * which matters most on an iPhone with a dozen phones. After `graceMs` with no
 * visible view the stream is suspended (socket and decoder closed); it resumes
 * as soon as a view shows again. The grace period keeps a quick scroll or tab
 * switch from tearing the stream down and up.
 *
 * Touch and macro control do not go through the video socket, so a suspended
 * phone is still controlled.
 *
 * Pure module: runs under `node --test`.
 */
export const SUSPEND_GRACE_MS = 3000;

export type SuspendAction = "none" | "arm" | "disarm" | "resume";

export interface SuspendState {
  suspended: boolean;
  /** A suspend timer is running. */
  armed: boolean;
}

/** What to do when visibility is re-evaluated (`shown`: page visible and a view on screen). */
export function onVisibilityChange(state: SuspendState, shown: boolean): SuspendAction {
  if (shown) {
    if (state.suspended) return "resume";
    return state.armed ? "disarm" : "none";
  }
  if (state.suspended || state.armed) return "none";
  return "arm";
}

/** The suspend timer fired: suspend only if still not shown. */
export function shouldSuspend(state: SuspendState, shown: boolean): boolean {
  return !shown && !state.suspended;
}
