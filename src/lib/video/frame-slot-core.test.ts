import assert from "node:assert/strict";
import { test } from "node:test";
import { createFrameSlot } from "./frame-slot-core.ts";

function harness(paint?: () => void) {
  const closed: number[] = [];
  const painted: number[] = [];
  let scheduled: (() => void) | null = null;
  let cancelled = 0;
  const slot = createFrameSlot<{ id: number; close(): void }>(
    (run) => {
      scheduled = run;
      return 1;
    },
    () => {
      cancelled += 1;
      scheduled = null;
    },
    (frame) => {
      paint?.();
      painted.push(frame.id);
    },
  );
  const frame = (id: number) => ({ id, close: () => closed.push(id) });
  const refresh = () => {
    const run = scheduled;
    scheduled = null;
    run?.();
  };
  return { slot, frame, closed, painted, refresh, cancelled: () => cancelled, hasScheduled: () => scheduled !== null };
}

test("the first frame of a refresh paints at once; a burst paints only its newest frame", () => {
  const h = harness();
  assert.equal(h.slot.offer(h.frame(1)), false);
  assert.deepEqual(h.painted, [1]); // no waiting for the refresh
  assert.equal(h.slot.offer(h.frame(2)), false);
  assert.equal(h.slot.offer(h.frame(3)), true); // 2 is replaced, never drawn
  assert.deepEqual(h.painted, [1]);
  assert.deepEqual(h.closed, [1, 2]);
  h.refresh();
  assert.deepEqual(h.painted, [1, 3]);
  assert.deepEqual(h.closed, [1, 2, 3]);
});

test("after a quiet refresh the next frame paints at once again", () => {
  const h = harness();
  h.slot.offer(h.frame(1));
  h.refresh(); // nothing waiting: the slot is free again
  assert.equal(h.hasScheduled(), false);
  h.slot.offer(h.frame(2));
  assert.deepEqual(h.painted, [1, 2]);
  // A frame painted from the slot keeps the refresh taken.
  h.slot.offer(h.frame(3));
  h.refresh();
  h.slot.offer(h.frame(4));
  assert.deepEqual(h.painted, [1, 2, 3]);
  h.refresh();
  assert.deepEqual(h.painted, [1, 2, 3, 4]);
  assert.deepEqual(h.closed, [1, 2, 3, 4]);
});

test("clear closes a waiting frame and cancels the refresh callback", () => {
  const h = harness();
  h.slot.offer(h.frame(1));
  h.slot.offer(h.frame(2));
  h.slot.clear();
  assert.deepEqual(h.closed, [1, 2]);
  assert.equal(h.cancelled(), 1);
  h.refresh();
  assert.deepEqual(h.painted, [1]);
  h.slot.clear(); // nothing waiting: no double close
  assert.deepEqual(h.closed, [1, 2]);
  h.slot.offer(h.frame(3)); // free again after clear
  assert.deepEqual(h.painted, [1, 3]);
});

test("a frame is closed even when painting throws", () => {
  const h = harness(() => {
    throw new Error("canvas lost");
  });
  assert.throws(() => h.slot.offer(h.frame(1)));
  assert.deepEqual(h.closed, [1]);
});
