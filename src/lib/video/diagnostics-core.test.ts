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
  assert.equal(allStalled([stalled, stalled], now), true);
  assert.equal(allStalled([stalled], now), false, "one phone is not 'all tiles'");
  assert.equal(allStalled([stalled, { views: 1, lastPaintedAt: now - 100 }], now), false, "one tile still paints");
  assert.equal(allStalled([stalled, { views: 0, lastPaintedAt: now - 100 }, stalled], now), true, "a phone not shown does not count");
  assert.equal(allStalled([stalled, { views: 1, lastPaintedAt: null }], now), false, "a phone that never painted is not a freeze");
  assert.equal(allStalled([stalled, { views: 1, lastPaintedAt: now - 60_000 }], now), false, "a stall long ago is not this one");
});

test("an episode is noticed once, saved 5 s later, then not again for a minute", () => {
  const stalled = (now: number) => [
    { views: 1, lastPaintedAt: now - 3000 },
    { views: 1, lastPaintedAt: now - 3000 },
  ];
  let state = newDetector();
  let step = detectorStep(state, stalled(10_000), 10_000);
  assert.deepEqual([step.trigger, step.save], [true, false]);
  state = step.state;
  step = detectorStep(state, stalled(12_000), 12_000);
  assert.deepEqual([step.trigger, step.save], [false, false], "still recording what follows");
  state = step.state;
  step = detectorStep(state, stalled(10_000 + AFTER_MS), 10_000 + AFTER_MS);
  assert.deepEqual([step.trigger, step.save], [false, true], "saved after the after-window");
  state = step.state;
  const later = 10_000 + AFTER_MS + 1000;
  assert.equal(detectorStep(state, stalled(later), later).trigger, false, "rate limited");
  const muchLater = 10_000 + AFTER_MS + SNAPSHOT_EVERY_MS;
  assert.equal(detectorStep(state, stalled(muchLater), muchLater).trigger, true, "a new episode after a minute");
});
