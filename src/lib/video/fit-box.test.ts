import assert from "node:assert/strict";
import { test } from "node:test";
import { fitVideoBox, nextVideoSize, type TrackedVideoSize } from "./fit-box.ts";

test("portrait frame fits a wide stage without stretching", () => {
  const box = fitVideoBox(1600, 900, 1080, 2400);
  assert.equal(box.height, 900);
  assert.equal(box.width, Math.floor(1080 * (900 / 2400)));
  assert.ok(Math.abs(box.width / box.height - 1080 / 2400) < 0.01);
});

test("landscape frame fills a wide stage and stays centered by aspect", () => {
  const box = fitVideoBox(1600, 900, 2400, 1080);
  assert.equal(box.width, 1600);
  assert.equal(box.height, Math.floor(1080 * (1600 / 2400)));
  assert.ok(box.height < 900);
  assert.ok(Math.abs(box.width / box.height - 2400 / 1080) < 0.01);
});

test("a tall stage letterboxes a landscape frame on the sides", () => {
  const box = fitVideoBox(400, 800, 1920, 1080);
  assert.equal(box.width, 400);
  assert.ok(box.height < 800);
  assert.ok(Math.abs(box.width / box.height - 1920 / 1080) < 0.02);
});

test("different phone aspects each keep their own ratio", () => {
  const tall = fitVideoBox(1000, 1000, 1080, 2340);
  const wide = fitVideoBox(1000, 1000, 1600, 720);
  assert.ok(Math.abs(tall.width / tall.height - 1080 / 2340) < 0.01);
  assert.ok(Math.abs(wide.width / wide.height - 1600 / 720) < 0.01);
  assert.notEqual(tall.width, wide.width);
});

test("zero stage or frame does not invent a size", () => {
  assert.deepEqual(fitVideoBox(0, 900, 1080, 2400), { width: 0, height: 0 });
  assert.deepEqual(fitVideoBox(1600, 900, 0, 0), { width: 0, height: 0 });
});

test("orientation changes replace the locked picture size", () => {
  const portrait: TrackedVideoSize = { width: 1080, height: 2400, source: "sps" };
  const fromFrame = nextVideoSize(portrait, 2400, 1080, "frame");
  assert.deepEqual(fromFrame, { width: 2400, height: 1080, source: "frame" });
  const back = nextVideoSize(fromFrame, 1080, 2400, "sps");
  assert.deepEqual(back, { width: 1080, height: 2400, source: "sps" });
});

test("wm size and macroblock padding do not replace the SPS crop", () => {
  const crop: TrackedVideoSize = { width: 1080, height: 2400, source: "sps" };
  assert.equal(nextVideoSize(crop, 1080, 1920, "status"), crop);
  assert.equal(nextVideoSize(crop, 1088, 2400, "frame"), crop);
  assert.equal(nextVideoSize(crop, 0, 0, "sps"), crop);
});

test("a later SPS of the same orientation still updates a real size change", () => {
  const first: TrackedVideoSize = { width: 720, height: 1280, source: "sps" };
  const next = nextVideoSize(first, 1080, 2400, "sps");
  assert.deepEqual(next, { width: 1080, height: 2400, source: "sps" });
});
