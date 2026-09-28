export interface FittedBox {
  width: number;
  height: number;
}

export interface TrackedVideoSize {
  width: number;
  height: number;
  source: "sps" | "status" | "frame";
}

/**
 * Largest rectangle of `videoWidth`×`videoHeight` that fits inside the stage.
 * Portrait and landscape use the same scale; neither axis is stretched.
 */
export function fitVideoBox(
  containerWidth: number,
  containerHeight: number,
  videoWidth: number,
  videoHeight: number,
): FittedBox {
  if (
    !(containerWidth > 0 && containerHeight > 0 && videoWidth > 0 && videoHeight > 0)
  ) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(containerWidth / videoWidth, containerHeight / videoHeight);
  return {
    width: Math.max(1, Math.floor(videoWidth * scale)),
    height: Math.max(1, Math.floor(videoHeight * scale)),
  };
}

function sameOrientation(prev: TrackedVideoSize, width: number, height: number) {
  return prev.width >= prev.height === width >= height;
}

function paddingOnly(prev: TrackedVideoSize, width: number, height: number) {
  return Math.abs(prev.width - width) <= 16 && Math.abs(prev.height - height) <= 16;
}

/**
 * SPS crop is the scrcpy picture size. A later 0×0 or `wm size` status must not
 * replace it, and macroblock padding (1088 vs 1080) must not either.
 * A real orientation change from a decoded frame or a new SPS does.
 */
export function nextVideoSize(
  prev: TrackedVideoSize | null,
  width: number,
  height: number,
  source: TrackedVideoSize["source"],
): TrackedVideoSize | null {
  if (!(width > 0 && height > 0)) return prev;
  if (!prev) return { width, height, source };
  if (prev.width === width && prev.height === height) {
    if (source === "sps" && prev.source !== "sps") return { width, height, source };
    return prev;
  }
  if (source === "status") return prev;
  if (
    source === "frame" &&
    prev.source === "sps" &&
    sameOrientation(prev, width, height) &&
    paddingOnly(prev, width, height)
  ) {
    return prev;
  }
  return { width, height, source };
}
