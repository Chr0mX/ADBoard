import assert from "node:assert/strict";
import { test } from "node:test";
import { AFTER_MS, Ring, SNAPSHOT_EVERY_MS, STALL_MS, allStalled, detectorStep, newDetector } from "./diagnostics-core.ts";

test("a ring keeps only the newest entries, in order", () => {
  const ring = new Ring<number>(3);
  for (let i = 1; i <= 5; i += 1) ring.push(i);
  assert.deepEqual(ring.values(), [3, 4, 5]);
  assert.equal(ring.length, 3);
});

test("all tiles stalled means every shown phone stopped painting after painting recently", () => {
  const now = 100_000;
  const stalled = { views: 1, lastPaintedAt: now - STALL_MS - 1 };
  assert.equal(allStalled([stalled, stalled], now, 0), true);
  assert.equal(allStalled([stalled], now, 0), false, "one phone is not 'all tiles'");
  assert.equal(allStalled([stalled, { views: 1, lastPaintedAt: now - 100 }], now, 0), false, "one tile still paints");
  assert.equal(allStalled([stalled, { views: 0, lastPaintedAt: now - 100 }, stalled], now, 0), true, "a phone not shown does not count");
  assert.equal(allStalled([stalled, { views: 1, lastPaintedAt: null }], now, 0), false, "a phone that never painted is not a freeze");
  assert.equal(allStalled([stalled, { views: 1, lastPaintedAt: now - 60_000 }], now, 0), false, "a stall long ago is not this one");
});

test("an episode is noticed once, saved 5 s later, then not again for a minute", () => {
  const stalled = (now: number) => [
    { views: 1, lastPaintedAt: now - 3000 },
    { views: 1, lastPaintedAt: now - 3000 },
  ];
  let state = newDetector();
  let step = detectorStep(state, stalled(10_000), 10_000, 0);
  assert.deepEqual([step.trigger, step.save], [true, false]);
  state = step.state;
  step = detectorStep(state, stalled(12_000), 12_000, 0);
  assert.deepEqual([step.trigger, step.save], [false, false], "still recording what follows");
  state = step.state;
  step = detectorStep(state, stalled(10_000 + AFTER_MS), 10_000 + AFTER_MS, 0);
  assert.deepEqual([step.trigger, step.save], [false, true], "saved after the after-window");
  state = step.state;
  const later = 10_000 + AFTER_MS + 1000;
  assert.equal(detectorStep(state, stalled(later), later, 0).trigger, false, "rate limited");
  const muchLater = 10_000 + AFTER_MS + SNAPSHOT_EVERY_MS;
  assert.equal(detectorStep(state, stalled(muchLater), muchLater, 0).trigger, true, "a new episode after a minute");
});

test("a hidden page is not a stall, and a stall counts only from when the page came back", () => {
  const now = 100_000;
  const old = { views: 1, lastPaintedAt: now - 4000 };
  assert.equal(allStalled([old, old], now, null), false, "hidden: nothing is painted on purpose");
  assert.equal(allStalled([old, old], now, now - 500), false, "visible again 500 ms ago");
  assert.equal(allStalled([old, old], now, now - STALL_MS - 1), true, "visible long enough and still no paint");
  assert.equal(detectorStep(newDetector(), [old, old], now, null).trigger, false);
});

test("an episode already noticed is still saved if the page goes hidden", () => {
  const stalled = [
    { views: 1, lastPaintedAt: 7000 },
    { views: 1, lastPaintedAt: 7000 },
  ];
  const step = detectorStep(newDetector(), stalled, 10_000, 0);
  assert.equal(step.trigger, true);
  assert.equal(detectorStep(step.state, stalled, 10_000 + AFTER_MS, null).save, true);
});
