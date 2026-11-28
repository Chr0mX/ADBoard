/**
 * When a stream has nothing to show, and what the page does about it.
 *
 * The WebSocket of an open viewer stays connected. Hiding the window, Alt-Tab, another tab, a tile scrolled
 * out of sight or a screen that sends no frames never closes it: a connection is closed only when the
 * viewer closes, the phone goes away, or the connection itself fails (see reconnect-core `isStale`: a
 * missing heartbeat, not missing video).
 *
 * What changes is the work done for a viewer nobody is looking at. After `SUSPEND_GRACE_MS` with nothing
 * to show the stream goes idle: the page drops frames before decoding, frees its decoder, and tells the
 * agent to stop sending pictures (`viewerMessage`). Heartbeats and pings go on, so the connection is still
 * watched. Showing again tells the agent to resume, which replays the SPS/PPS and a keyframe. The grace
 * period keeps a quick scroll or tab switch from toggling it.
 *
 * Touch and macro control do not go through the video socket, so an idle phone is still controlled.
 *
 * Pure module: runs under `node --test`.
 */
export const SUSPEND_GRACE_MS = 3000;

/** What the idle timer should do: "arm" starts the grace period, "resume" leaves idle. */
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
 *      setting decides. Pause (default) goes idle after the grace period (frames
 *      stop). Pause off keeps frames coming and lowers the work to the chosen FPS.
 *      The socket stays connected either way.
 *   2. ADBoard is visible but every view of THIS phone is off screen (a tile scrolled
 *      away, a collapsed panel): that phone alone goes idle after the grace period.
 *      The background setting does not apply and no other phone is affected.
 *   3. A view is visible: full speed. Foreground FPS is never changed here.
 *
 * Where frames are dropped: unless the viewer is idle the agent sends every access unit to every viewer and the
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
  /** Nothing to show: drop frames now, and after the grace period tell the agent to stop sending. The socket stays. */
  | "idle"
  /** Hidden window, not paused, 1 FPS: decode keyframes only. */
  | "sample-keyframes"
  /** Hidden window, not paused, above 1 FPS: decode everything, paint about FPS pictures per second. */
  | "throttle-paint";

/**
 * Does this page reduce work while its window is hidden? Only the phone app (`/m/`) does. The desktop view
 * never does: a hidden window keeps decoding and painting at full speed, so returning to it has nothing to
 * catch up on (no keyframe handshake, no rebuilt decoder).
 */
export function savesWhenHidden(pathname: string): boolean {
  return pathname === "/m" || pathname.startsWith("/m/");
}

export function streamMode(input: {
  pageHidden: boolean;
  /** `savesWhenHidden` for this page: when false the window's visibility is ignored. */
  hiddenSaves: boolean;
  anyViewVisible: boolean;
  policy: BackgroundPolicy;
  /** The decoder path can run in the background (WebCodecs; the MSE path cannot be thinned). */
  canThrottle: boolean;
}): StreamMode {
  if (!input.pageHidden || !input.hiddenSaves) return input.anyViewVisible ? "full" : "idle";
  if (input.policy.pause || !input.canThrottle) return "idle";
  return input.policy.fps <= KEYFRAME_SAMPLE_MAX_FPS ? "sample-keyframes" : "throttle-paint";
}

/** Is a picture due, for a background rate of `fps`, `sinceLastMs` after the last one? */
export function backgroundFrameDue(sinceLastMs: number, fps: number): boolean {
  return sinceLastMs >= 1000 / clampBackgroundFps(fps) - 2;
}

/** Modes in which the agent keeps sending pictures while the page is hidden (thinned in the page). */
export function keepsSocketInBackground(mode: StreamMode): boolean {
  return mode === "sample-keyframes" || mode === "throttle-paint";
}

/**
 * Coming back to a stream that was not decoding every frame: its decoder cannot be trusted to
 * continue from the next delta frame. Drop until a keyframe (and ask for one).
 */
export function needsKeyframeAfter(previous: StreamMode, next: StreamMode): boolean {
  if (next === "sample-keyframes") return false; // keyframes are self-contained
  return previous === "sample-keyframes" || previous === "idle";
}

/**
 * After returning to full speed: wait for a picture, ask for a keyframe, then rebuild the decoder. Never the
 * connection: a screen that sends nothing is not a dead socket, and a decoder that did not get its keyframe
 * is not either. (Closing and reopening the socket here made every still screen reconnect every few seconds.)
 */
export const RECOVERY_ASK_AFTER_MS = 1200;
export const RECOVERY_REBUILD_AFTER_MS = 3000;

export type RecoveryStep = "wait" | "ask-keyframe" | "rebuild-decoder" | "done";

export function recoveryStep(input: { elapsedMs: number; framesSince: number; asked: boolean; rebuilt: boolean }): RecoveryStep {
  if (input.framesSince > 0) return "done";
  if (input.elapsedMs >= RECOVERY_REBUILD_AFTER_MS && !input.rebuilt) return "rebuild-decoder";
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

/** Frames arrive but nothing decodes: first ask for a keyframe, and if that does not help rebuild the decoder. */
export function stallAction(consecutiveAsks: number): "ask-keyframe" | "rebuild-decoder" {
  return consecutiveAsks < 1 ? "ask-keyframe" : "rebuild-decoder";
}

/**
 * What a page tells the agent about its viewer. `active: false` stops the pictures (heartbeats and pings
 * continue); `active: true` brings them back, starting with the SPS/PPS and a keyframe. An agent that does
 * not know the message ignores it, and the page drops the frames itself.
 */
export function viewerMessage(active: boolean): string {
  return JSON.stringify({ type: "viewer", active });
}
