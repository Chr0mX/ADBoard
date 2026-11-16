import assert from "node:assert/strict";
import { test } from "node:test";
import { createSegmentQueue, trimRange } from "./mse-queue-core.ts";

test("the queue never grows past its limit and resumes on a keyframe", () => {
  const queue = createSegmentQueue<number>(3);
  assert.equal(queue.push(1, true), true);
  assert.equal(queue.push(2, false), true);
  assert.equal(queue.push(3, false), true);
  // Full: everything waiting is thrown away with the new segment.
  assert.equal(queue.push(4, false), false);
  assert.equal(queue.length, 0);
  assert.equal(queue.dropped, 4);
  // Delta frames after the gap cannot be decoded: refused until a keyframe.
  assert.equal(queue.push(5, false), false);
  assert.equal(queue.push(6, true), true);
  assert.equal(queue.push(7, false), true);
  assert.equal(queue.length, 2);
  for (let i = 0; i < 1000; i += 1) queue.push(i, i % 30 === 0);
  assert.ok(queue.length <= 3);
});

test("the init segment is never refused, and FIFO order holds", () => {
  const queue = createSegmentQueue<string>(1);
  queue.push("a", true);
  queue.pushRequired("init");
  assert.equal(queue.shift(), "a");
  queue.unshift("a");
  assert.equal(queue.shift(), "a");
  assert.equal(queue.shift(), "init");
  assert.equal(queue.shift(), undefined);
});

test("played video is trimmed only when a few seconds are behind", () => {
  assert.equal(trimRange(0, 3), null);
  assert.equal(trimRange(0, 5.5), null);
  assert.deepEqual(trimRange(0, 10), { start: 0, end: 6 });
  assert.deepEqual(trimRange(100, 120), { start: 100, end: 116 });
});
