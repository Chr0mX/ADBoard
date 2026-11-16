/**
 * Which kind of H264 decoder a stream asks the browser for.
 *
 * "auto" (WebCodecs `no-preference`) lets the browser pick: Chrome and Safari
 * use the GPU decoder when there is one. A GPU decoder that keeps failing (a
 * driver that rejects a size, too many hardware sessions for 12 phones) is
 * replaced by the software decoder for that stream, so the picture comes back
 * instead of looping on "Recovering decode…".
 *
 * `localStorage["adboard-video-accel"]` = "hardware" | "software" | "auto"
 * forces one, for benchmarks.
 *
 * Pure module: runs under `node --test`.
 */
export type AccelMode = "auto" | "hardware" | "software";
export type HardwareAcceleration = "no-preference" | "prefer-hardware" | "prefer-software";

export function parseAccelMode(raw: string | null | undefined): AccelMode {
  return raw === "hardware" || raw === "software" ? raw : "auto";
}

export function accelPreference(mode: AccelMode): HardwareAcceleration {
  if (mode === "hardware") return "prefer-hardware";
  if (mode === "software") return "prefer-software";
  return "no-preference";
}

/** Decoder errors of one stream: `limit` within `windowMs` means "give up on this decoder kind". */
export function createErrorWindow(limit = 3, windowMs = 10_000) {
  let times: number[] = [];
  return {
    /** Record an error at `now`; true when the limit is reached. */
    note(now: number): boolean {
      times = times.filter((t) => now - t < windowMs);
      times.push(now);
      return times.length >= limit;
    },
    reset() {
      times = [];
    },
  };
}

/**
 * The mode to use after repeated decoder errors. Only "auto" falls back (to
 * software); a forced mode is the user's choice and stays.
 */
export function fallbackMode(mode: AccelMode): AccelMode {
  return mode === "auto" ? "software" : mode;
}
