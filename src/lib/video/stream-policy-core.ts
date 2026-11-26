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

/* ---------------------------------------------------------------------------
 * Background behaviour (Settings → Video / Performance)
 *
 * Three different reasons a stream may have nothing to show, handled differently:
 *   1. The browser window or tab is hidden (Alt-Tab, another tab): the background
 *      setting decides. Pause (default) keeps the suspension above. Pause off keeps
 *      the socket and lowers the work to the chosen FPS.
 *   2. ADBoard is visible but every view of THIS phone is off screen (a tile scrolled
 *      away, a collapsed panel): that phone alone is suspended after the grace period,
 *      as before. The background setting does not apply and no other phone is affected.
 *   3. A view is visible: full speed. Foreground FPS is never changed here.
 *
 * Where frames are dropped: the agent sends every access unit to every viewer and the
 * encoder (scrcpy `max_fps`) is a per-session launch option shared by all viewers, so
 * the rate cannot be lowered at the source for one hidden tab. The reduction happens in
 * the browser, as early as it is safe:
 *   - at 1 FPS, delta frames are dropped before any decoding and only keyframes are
 *     decoded (a keyframe is requested once a second);
 *   - above 1 FPS every frame must still be decoded (each delta frame is predicted from
 *     the one before it), but only about FPS pictures per second are painted.
 * The bytes still travel the network in both cases.
 * ------------------------------------------------------------------------- */

export const MIN_BACKGROUND_FPS = 1;
export const MAX_BACKGROUND_FPS = 60;
export const DEFAULT_BACKGROUND_FPS = 5;
/** At or below this rate only keyframes are decoded; above it every frame is decoded. */
export const KEYFRAME_SAMPLE_MAX_FPS = 1;

export interface BackgroundPolicy {
  /** Suspend streams while the window is hidden (the original behaviour). */
  pause: boolean;
  /** Pictures per second kept while hidden and not paused, 1 to 60. */
  fps: number;
}

export const DEFAULT_BACKGROUND_POLICY: BackgroundPolicy = { pause: true, fps: DEFAULT_BACKGROUND_FPS };

export function clampBackgroundFps(value: unknown): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_BACKGROUND_FPS;
  return Math.min(MAX_BACKGROUND_FPS, Math.max(MIN_BACKGROUND_FPS, Math.round(n)));
}

/** The saved values (strings from storage, or anything) to a valid policy; missing means the defaults. */
export function readBackgroundPolicy(pause: string | null | undefined, fps: string | null | undefined): BackgroundPolicy {
  return {
    // Only an explicit "0" turns pausing off: an absent or unreadable value keeps the original behaviour.
    pause: pause !== "0",
    fps: clampBackgroundFps(fps),
  };
}

export type StreamMode =
  /** Showing: decode and paint everything. */
  | "full"
  /** Nothing to show: drop frames now and suspend the stream after the grace period. */
  | "hold-then-suspend"
  /** Hidden window, not paused, 1 FPS: decode keyframes only. */
  | "sample-keyframes"
  /** Hidden window, not paused, above 1 FPS: decode everything, paint about FPS pictures per second. */
  | "throttle-paint";

export function streamMode(input: {
  pageHidden: boolean;
  anyViewVisible: boolean;
  policy: BackgroundPolicy;
  /** The decoder path can run in the background (WebCodecs; the MSE path cannot be thinned). */
  canThrottle: boolean;
}): StreamMode {
  if (!input.pageHidden) return input.anyViewVisible ? "full" : "hold-then-suspend";
  if (input.policy.pause || !input.canThrottle) return "hold-then-suspend";
  return input.policy.fps <= KEYFRAME_SAMPLE_MAX_FPS ? "sample-keyframes" : "throttle-paint";
}

/** Is a picture due, for a background rate of `fps`, `sinceLastMs` after the last one? */
export function backgroundFrameDue(sinceLastMs: number, fps: number): boolean {
  return sinceLastMs >= 1000 / clampBackgroundFps(fps) - 2;
}

/** Streams that are allowed to hold a socket while the page is hidden. */
export function keepsSocketInBackground(mode: StreamMode): boolean {
  return mode === "sample-keyframes" || mode === "throttle-paint";
}

/**
 * Coming back to a stream that was not decoding every frame: its decoder cannot be trusted to
 * continue from the next delta frame. Drop until a keyframe (and ask for one).
 */
export function needsKeyframeAfter(previous: StreamMode, next: StreamMode): boolean {
  if (next === "sample-keyframes") return false; // keyframes are self-contained
  return previous === "sample-keyframes" || previous === "hold-then-suspend";
}

/** After returning to full speed: wait for a picture, ask for a keyframe, and only then start over. */
export const RECOVERY_ASK_AFTER_MS = 1200;
export const RECOVERY_RECONNECT_AFTER_MS = 4000;

export type RecoveryStep = "wait" | "ask-keyframe" | "reconnect" | "done";

export function recoveryStep(input: { elapsedMs: number; framesSince: number; asked: boolean }): RecoveryStep {
  if (input.framesSince > 0) return "done";
  if (input.elapsedMs >= RECOVERY_RECONNECT_AFTER_MS) return "reconnect";
  if (input.elapsedMs >= RECOVERY_ASK_AFTER_MS && !input.asked) return "ask-keyframe";
  return "wait";
}

/**
 * Frames keep arriving but none is decoded: the keyframe the decoder needs never reached it (dropped
 * before the page accepted video, lost on the way, or folded into another viewer's request). Waiting for
 * the encoder's own next keyframe can take seconds, so ask. A still screen sends nothing at all, which is
 * not a stall.
 */
export const DECODE_STALL_ASK_MS = 2000;

export interface DecodeStallState {
  /** Access units seen and pictures decoded at the last look, and since when nothing was decoded. */
  seen: number;
  decoded: number;
  since: number;
}

export function decodeStallStep(
  state: DecodeStallState,
  now: { seen: number; decoded: number; at: number },
): { state: DecodeStallState; ask: boolean } {
  const progressed = now.decoded !== state.decoded;
  const quiet = now.seen === state.seen;
  if (progressed || quiet) {
    // Pictures are showing, or nothing is arriving (a still screen): the clock starts over.
    return { state: { seen: now.seen, decoded: now.decoded, since: now.at }, ask: false };
  }
  if (now.at - state.since >= DECODE_STALL_ASK_MS) {
    return { state: { seen: now.seen, decoded: now.decoded, since: now.at }, ask: true };
  }
  return { state: { ...state, seen: now.seen }, ask: false };
}
