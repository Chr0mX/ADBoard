/** One-shot recovery for floats saved with old off-screen edge geometry. */
export function repairEdgeDockedFloatPrefs(defaultChipHeight = 56): number {
  if (typeof window === "undefined") return 0;
  try {
    sessionStorage.removeItem("pc-float-nav");
  } catch {
    // ignore
  }
  const keys = ["pc-float-stats", "pc-float-controls"];
  let repaired = 0;
  for (const key of keys) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as {
        x?: number;
        y?: number;
        pinned?: boolean;
        collapsed?: boolean;
        edge?: string;
      };
      if (parsed.collapsed !== true) continue;
      if (parsed.edge !== "left" && parsed.edge !== "right") continue;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const peekW = 36;
      const peekH = Math.max(72, defaultChipHeight);
      const y = typeof parsed.y === "number" ? parsed.y : 12;
      const maxY = Math.max(8, h - 8 - peekH);
      const clampedY = Math.min(Math.max(8, y), maxY);
      const nextX = parsed.edge === "left" ? 0 : Math.max(0, w - peekW);
      const stuck =
        parsed.x == null ||
        parsed.x < -4 ||
        parsed.x + peekW > w + 4 ||
        Math.abs((parsed.x ?? 0) - nextX) > 4;
      if (!stuck) continue;
      sessionStorage.setItem(
        key,
        JSON.stringify({
          x: nextX,
          y: clampedY,
          pinned: parsed.pinned === true,
          collapsed: true,
          edge: parsed.edge,
        }),
      );
      repaired += 1;
    } catch {
      // ignore
    }
  }
  return repaired;
}
