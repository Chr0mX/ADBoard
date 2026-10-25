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
 * continues until a keyframe — and asks the agent for one right away
 * (otherwise the next one may be seconds away).
 *
 * Pure module: no browser APIs, so it runs under `node --test`.
 */

export const MAX_DECODE_QUEUE = 3;

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
    if (frame.isKey && frame.queueSize < MAX_DECODE_QUEUE) {
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
