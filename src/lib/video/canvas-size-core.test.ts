import assert from "node:assert/strict";
import { test } from "node:test";
import { fittedSize, nextCanvasSize } from "./canvas-size-core.ts";

const phone = { width: 1080, height: 2400 };

test("a small tile gets a small canvas with the frame's shape", () => {
  const size = fittedSize(phone, { width: 200, height: 444 });
  assert.deepEqual(size, { width: 200, height: 444 });
  // A box with another shape: the frame is contained, not stretched.
  assert.deepEqual(fittedSize(phone, { width: 500, height: 444 }), { width: 200, height: 444 });
});

test("the canvas is never larger than the frame, and an unknown box means full size", () => {
  assert.deepEqual(fittedSize(phone, { width: 4000, height: 4000 }), phone);
  assert.deepEqual(fittedSize(phone, null), phone);
  assert.deepEqual(fittedSize(phone, { width: 0, height: 0 }), phone);
});

test("a canvas that is big enough and not wasteful is kept", () => {
  const current = { width: 220, height: 489 };
  assert.equal(nextCanvasSize(current, { width: 200, height: 444 }), current);
  // Grown past the canvas, or shrunk a lot: resize to what is needed.
  assert.deepEqual(nextCanvasSize(current, { width: 300, height: 667 }), { width: 300, height: 667 });
  assert.deepEqual(nextCanvasSize(current, { width: 100, height: 222 }), { width: 100, height: 222 });
});

test("a rotated phone gets a new canvas even if the old one is large enough", () => {
  const portrait = { width: 1080, height: 2400 };
  assert.deepEqual(nextCanvasSize(portrait, { width: 600, height: 270 }), { width: 600, height: 270 });
});
