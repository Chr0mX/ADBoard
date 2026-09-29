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

export function clampFloatingRect(
  rect: FloatingRect,
  bounds: FloatingBounds,
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
  const maxX = Math.max(left, bounds.viewportWidth - right - width);
  const maxY = Math.max(top, bounds.viewportHeight - bottom - height);
  return {
    x: Math.min(Math.max(left, rect.x), maxX),
    y: Math.min(Math.max(top, rect.y), maxY),
    width,
    height,
  };
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
      y: margin,
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
