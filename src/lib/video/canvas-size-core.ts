/**
 * How many pixels a video canvas needs.
 *
 * A canvas used to take the phone's full resolution (1080 x 2400) even as a
 * 200 px grid tile, so every frame copied about 20 times more pixels than the
 * screen could show, and 12 tiles held over 100 MB of canvas memory. The
 * backing store now matches what is displayed: the frame fitted into the
 * canvas's box in device pixels, never larger than the frame itself.
 *
 * Pure module: runs under `node --test`.
 */
export interface Size {
  width: number;
  height: number;
}

/** The frame fitted (contain) into `box` (device pixels), capped at the frame's own size. */
export function fittedSize(frame: Size, box: Size | null): Size {
  if (!box || box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return frame;
  const scale = Math.min(1, box.width / frame.width, box.height / frame.height);
  if (scale >= 1) return frame;
  return {
    width: Math.max(1, Math.round(frame.width * scale)),
    height: Math.max(1, Math.round(frame.height * scale)),
  };
}

/**
 * The size to give the canvas now. Resizing reallocates and clears it, so a
 * canvas that is already big enough, and not wastefully big, is left alone:
 * dragging a panel edge must not resize every tile on every frame.
 */
export function nextCanvasSize(current: Size, needed: Size): Size {
  const bigEnough = current.width >= needed.width && current.height >= needed.height;
  const wasteful = current.width > needed.width * 1.5 || current.height > needed.height * 1.5;
  // Same shape? A rotated phone needs a new canvas even when it would "fit".
  const sameShape = Math.abs(current.width * needed.height - current.height * needed.width) <= Math.max(current.width, current.height) * 2;
  return bigEnough && !wasteful && sameShape ? current : needed;
}
