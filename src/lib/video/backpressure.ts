/**
 * Back-pressure for live H264 decoding.
 *
 * The agent sends every access unit as it is encoded; nothing on the wire
 * slows down when this device can't keep up. Without a limit, a slow or
 * throttled decoder (a hot iPhone, a grid of phones) queues frames without
 * bound until the browser runs out of memory and reloads the page.
 *
 * The gate keeps at most `MAX_DECODE_QUEUE` frames waiting. Past that, or
 * while the page is hidden, it drops frames. A dropped delta frame breaks the
 * chain the next frames are predicted from, so once dropping starts it
 * continues until a keyframe — which the page asks the agent for once the
 * queue has drained to `RESUME_QUEUE` (otherwise the next one may be seconds
 * away).
 *
 * The limit is an overload level, not a transient one. With a limit of 3, four
 * phones decoding side by side hit it all the time: each hit threw away the rest
 * of the GOP and cost a keyframe round trip, so the decoder sat idle between
 * keyframes and the pictures looked frozen. A queue of a few frames is normal
 * and is decoded.
 *
 * Pure module: no browser APIs, so it runs under `node --test`.
 */

/** Frames the decoder may hold before the page drops frames (about 0.4 s at 30 fps). */
export const MAX_DECODE_QUEUE = 12;
/** After dropping, a keyframe is only taken once the queue is below this, and only then is one asked for. */
export const RESUME_QUEUE = 6;

export interface DecodeGate {
  /** Dropping until the next keyframe. */
  dropping: boolean;
  /** Frames dropped so far (diagnostics). */
  dropped: number;
}

export function newDecodeGate(): DecodeGate {
  return { dropping: false, dropped: 0 };
}

/** `decode` it; `drop` it; or drop it and ask the agent for a keyframe. */
export type GateVerdict = "decode" | "drop" | "drop-ask-keyframe";

export interface FrameInfo {
  isKey: boolean;
  /** Frames the decoder holds right now (`VideoDecoder.decodeQueueSize`). */
  queueSize: number;
  /** The page is not visible (another app, locked screen, background tab). */
  hidden: boolean;
}

export function admitFrame(gate: DecodeGate, frame: FrameInfo): GateVerdict {
  if (frame.hidden) {
    // Nothing is shown: decode nothing. Coming back needs a keyframe.
    // The keyframe is asked for when the page shows again, not now.
    gate.dropping = true;
    gate.dropped += 1;
    return "drop";
  }
  if (gate.dropping) {
    if (frame.isKey && frame.queueSize < RESUME_QUEUE) {
      gate.dropping = false;
      return "decode";
    }
    gate.dropped += 1;
    return "drop";
  }
  if (frame.queueSize >= MAX_DECODE_QUEUE) {
    gate.dropping = true;
    gate.dropped += 1;
    return "drop-ask-keyframe";
  }
  return "decode";
}

/** A place that shows a stream. `visible` is absent for views that always count. */
export interface VideoViewLike {
  visible?: () => boolean;
}

/**
 * Is at least one view of the stream on screen? A grid tile scrolled out of
 * sight, or in a collapsed panel, reports `visible() === false`. When no view
 * is visible the stream is treated like a hidden page: frames are dropped
 * instead of decoded and painted, and a keyframe is asked for on return.
 */
export function anyViewVisible(views: Iterable<VideoViewLike>): boolean {
  for (const view of views) {
    if (!view.visible || view.visible()) return true;
  }
  return false;
}
