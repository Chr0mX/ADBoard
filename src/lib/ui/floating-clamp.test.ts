import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampFloatingRect, defaultFloatPosition } from "./floating-clamp.ts";

describe("clampFloatingRect", () => {
  it("keeps a panel inside the viewport", () => {
    const next = clampFloatingRect(
      { x: 900, y: 900, width: 160, height: 80 },
      { viewportWidth: 390, viewportHeight: 844, margin: 8 },
    );
    assert.equal(next.x, 390 - 8 - 160);
    assert.equal(next.y, 844 - 8 - 80);
    assert.equal(next.width, 160);
    assert.equal(next.height, 80);
  });

  it("honors safe-area insets", () => {
    const next = clampFloatingRect(
      { x: 0, y: 0, width: 120, height: 48 },
      {
        viewportWidth: 390,
        viewportHeight: 844,
        insetTop: 47,
        insetBottom: 34,
        margin: 8,
      },
    );
    assert.equal(next.x, 8);
    assert.equal(next.y, 47 + 8);
  });

  it("shrinks when the panel is wider than the usable area", () => {
    const next = clampFloatingRect(
      { x: 0, y: 0, width: 400, height: 60 },
      { viewportWidth: 375, viewportHeight: 667, margin: 8 },
    );
    assert.equal(next.width, 375 - 16);
    assert.equal(next.x, 8);
  });
});

describe("defaultFloatPosition", () => {
  it("places nav along the bottom in portrait", () => {
    const rect = defaultFloatPosition(
      "nav",
      390,
      844,
      { width: 300, height: 56 },
      false,
    );
    assert.ok(rect.y > 700);
    assert.ok(Math.abs(rect.x - (390 - 300) / 2) < 1);
  });

  it("places controls on the trailing edge in landscape", () => {
    const rect = defaultFloatPosition(
      "controls",
      844,
      390,
      { width: 200, height: 220 },
      true,
    );
    assert.ok(rect.x > 500);
  });
});
