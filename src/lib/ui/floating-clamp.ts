/** Clamp a floating panel rect inside the visual viewport with safe-area insets. */

export interface FloatingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatingBounds {
  viewportWidth: number;
  viewportHeight: number;
  insetTop?: number;
  insetRight?: number;
  insetBottom?: number;
  insetLeft?: number;
  /** Extra margin inside the safe area. */
  margin?: number;
}

/** Visible strip when a collapsed float is docked like a Samsung edge panel. */
export const EDGE_PEEK = 44;

/** Reserve for the centered bottom taskbar capsule so floats stay clear of it. */
export const TASKBAR_FLOAT_RESERVE = 56;

export type FloatEdge = "left" | "right";

/** Flush peek tab geometry on the left/right edge (always fully tappable). */
export function edgePeekRect(
  edge: FloatEdge,
  height: number,
  bounds: FloatingBounds,
  y: number,
): FloatingRect {
  const margin = bounds.margin ?? 8;
  const left = (bounds.insetLeft ?? 0) + margin;
  const right = (bounds.insetRight ?? 0) + margin;
  const top = (bounds.insetTop ?? 0) + margin;
  const bottom = (bounds.insetBottom ?? 0) + margin;
  // Match FloatingPanel edge-peek min height so short panels (Stats) keep
  // enough strip for a rotated label on both edges.
  const h = Math.max(EDGE_PEEK * 2.5, 110, height);
  const maxY = Math.max(top, bounds.viewportHeight - bottom - h);
  const clampedY = Math.min(Math.max(top, y), maxY);
  if (edge === "left") {
    return { x: 0, y: clampedY, width: EDGE_PEEK, height: h };
  }
  return {
    x: Math.max(0, bounds.viewportWidth - EDGE_PEEK),
    y: clampedY,
    width: EDGE_PEEK,
    height: h,
  };
}

export function clampFloatingRect(
  rect: FloatingRect,
  bounds: FloatingBounds,
  options?: {
    /** When true, X may leave the screen except for EDGE_PEEK (collapsed edge hide). */
    allowEdgeHide?: boolean;
  },
): FloatingRect {
  const margin = bounds.margin ?? 8;
  const top = (bounds.insetTop ?? 0) + margin;
  const right = (bounds.insetRight ?? 0) + margin;
  const bottom = (bounds.insetBottom ?? 0) + margin;
  const left = (bounds.insetLeft ?? 0) + margin;
  const maxW = Math.max(0, bounds.viewportWidth - left - right);
  const maxH = Math.max(0, bounds.viewportHeight - top - bottom);
  const width = Math.min(Math.max(0, rect.width), maxW || rect.width);
  const height = Math.min(Math.max(0, rect.height), maxH || rect.height);
  const maxY = Math.max(top, bounds.viewportHeight - bottom - height);
  const y = Math.min(Math.max(top, rect.y), maxY);

  if (options?.allowEdgeHide) {
    const minX = left - Math.max(0, width - EDGE_PEEK);
    const maxX = bounds.viewportWidth - right - EDGE_PEEK;
    return {
      x: Math.min(Math.max(minX, rect.x), Math.max(minX, maxX)),
      y,
      width,
      height,
    };
  }

  const maxX = Math.max(left, bounds.viewportWidth - right - width);
  return {
    x: Math.min(Math.max(left, rect.x), maxX),
    y,
    width,
    height,
  };
}

/** Bring an edge-docked panel fully on-screen on the same side it was docked. */
export function edgeRevealRect(
  edge: FloatEdge | null,
  size: { width: number; height: number },
  bounds: FloatingBounds,
  y: number,
): FloatingRect {
  const margin = bounds.margin ?? 8;
  const x =
    edge === "right"
      ? bounds.viewportWidth - (bounds.insetRight ?? 0) - margin - size.width
      : (bounds.insetLeft ?? 0) + margin;
  return clampFloatingRect({ x, y, ...size }, bounds);
}

/** Snap a collapsed panel to a side edge when it is close enough, else clear edge. */
export function resolveCollapsedEdge(
  rect: FloatingRect,
  bounds: FloatingBounds,
  threshold = 40,
): { x: number; y: number; edge: FloatEdge | null } {
  const margin = bounds.margin ?? 8;
  const left = (bounds.insetLeft ?? 0) + margin;
  const right = (bounds.insetRight ?? 0) + margin;
  const top = (bounds.insetTop ?? 0) + margin;
  const bottom = (bounds.insetBottom ?? 0) + margin;
  const height = rect.height;
  const maxY = Math.max(top, bounds.viewportHeight - bottom - height);
  const y = Math.min(Math.max(top, rect.y), maxY);

  const leftDockX = left - Math.max(0, rect.width - EDGE_PEEK);
  const rightDockX = bounds.viewportWidth - right - EDGE_PEEK;
  const distLeft = Math.abs(rect.x - leftDockX);
  const distRight = Math.abs(rect.x - rightDockX);
  // Also treat near-viewport-edge positions as dock intent.
  const nearLeft = rect.x <= left + threshold;
  const nearRight = rect.x + rect.width >= bounds.viewportWidth - right - threshold;

  if (nearLeft || distLeft <= threshold) {
    const peek = edgePeekRect("left", rect.height, bounds, y);
    return { x: peek.x, y: peek.y, edge: "left" };
  }
  if (nearRight || distRight <= threshold) {
    const peek = edgePeekRect("right", rect.height, bounds, y);
    return { x: peek.x, y: peek.y, edge: "right" };
  }

  const fully = clampFloatingRect(rect, bounds);
  return { x: fully.x, y: fully.y, edge: null };
}

/** @deprecated Prefer edgePeekRect — kept for callers that still pass full size. */
export function edgeDockRect(
  edge: FloatEdge,
  size: { width: number; height: number },
  bounds: FloatingBounds,
  y: number,
): FloatingRect {
  return edgePeekRect(edge, size.height, bounds, y);
}

export function readSafeInsets(style: CSSStyleDeclaration | null): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (!style) return { top: 0, right: 0, bottom: 0, left: 0 };
  const parse = (value: string) => {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    top: parse(style.getPropertyValue("--pc-safe-top") || "0"),
    right: parse(style.getPropertyValue("--pc-safe-right") || "0"),
    bottom: parse(style.getPropertyValue("--pc-safe-bottom") || "0"),
    left: parse(style.getPropertyValue("--pc-safe-left") || "0"),
  };
}

export function defaultFloatPosition(
  kind: "stats" | "controls" | "nav",
  viewportWidth: number,
  viewportHeight: number,
  size: { width: number; height: number },
  landscape: boolean,
): FloatingRect {
  const margin = 12;
  if (kind === "nav") {
    return {
      x: Math.max(margin, (viewportWidth - size.width) / 2),
      y: Math.max(margin, viewportHeight - size.height - margin - 8),
      width: size.width,
      height: size.height,
    };
  }
  if (kind === "stats") {
    return {
      x: margin,
      y: Math.max(
        margin,
        viewportHeight - size.height - margin - TASKBAR_FLOAT_RESERVE,
      ),
      width: size.width,
      height: size.height,
    };
  }
  // controls
  if (landscape) {
    return {
      x: Math.max(margin, viewportWidth - size.width - margin),
      y: Math.max(margin, (viewportHeight - size.height) / 2),
      width: size.width,
      height: size.height,
    };
  }
  return {
    x: Math.max(margin, viewportWidth - size.width - margin),
    y: margin,
    width: size.width,
    height: size.height,
  };
}
