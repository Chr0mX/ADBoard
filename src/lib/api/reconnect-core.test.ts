import assert from "node:assert/strict";
import { test } from "node:test";
import { createBackoff, isStale } from "./reconnect-core.ts";

test("delays grow by half up to the ceiling and reset after a good connection", () => {
  const top = createBackoff({ random: () => 1 });
  const delays = Array.from({ length: 10 }, () => top.next());
  assert.deepEqual(delays.slice(0, 5), [400, 600, 900, 1350, 2025]);
  assert.equal(delays[9], 8000);
  // The first five attempts cover an outage of about five seconds with gaps of at most ~2 s.
  assert.ok(delays.slice(0, 5).every((d) => d <= 2025));
  top.reset();
  assert.equal(top.next(), 400);
  const bottom = createBackoff({ random: () => 0 });
  assert.deepEqual([bottom.next(), bottom.next(), bottom.next()], [200, 300, 450]);
});

test("jitter spreads sockets between half and all of the delay", () => {
  const delays = new Set<number>();
  for (let i = 0; i < 50; i += 1) {
    const delay = createBackoff().next();
    assert.ok(delay >= 200 && delay <= 400, String(delay));
    delays.add(delay);
  }
  assert.ok(delays.size > 5);
});

test("a socket is stale only after three missed heartbeats, and never without one", () => {
  assert.equal(isStale(0, 14_000, 5), false);
  assert.equal(isStale(0, 15_001, 5), true);
  assert.equal(isStale(0, 600_000, null), false);
  assert.equal(isStale(0, 600_000, 0), false);
});
