import assert from "node:assert/strict";
import { test } from "node:test";
import { markInput, newStreamPerf, percentile, recordMessage, recordPaint, recordQueue, snapshotPerf } from "./perf-core.ts";

test("percentile uses nearest rank and handles empty lists", () => {
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([5], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 95), 10);
});

test("timing rings keep only the newest samples", () => {
  const perf = newStreamPerf();
  for (let i = 0; i < 1000; i += 1) recordMessage(perf, i);
  assert.equal(perf.messageMs.length, 256);
  assert.equal(perf.messageMs[0], 744);
  assert.equal(snapshotPerf(perf).messageMsP95 > 900, true);
});

test("an input mark is closed by the next paint only", () => {
  const perf = newStreamPerf();
  recordPaint(perf, 5);
  assert.deepEqual(perf.inputMs, []);
  markInput(perf, 100);
  markInput(perf, 120); // a second input before the paint keeps the first mark
  recordPaint(perf, 140);
  recordPaint(perf, 160);
  assert.deepEqual(perf.inputMs, [40]);
  assert.equal(perf.painted, 3);
});

test("the queue high-water mark only rises", () => {
  const perf = newStreamPerf();
  recordQueue(perf, 2);
  recordQueue(perf, 1);
  assert.equal(snapshotPerf(perf).maxQueue, 2);
});

test("close diagnostics start empty and the snapshot is a copy, not the live counters", () => {
  const perf = newStreamPerf();
  assert.equal(perf.sockets, 0);
  assert.equal(perf.retryAttempts, 0);
  assert.equal(perf.lastClose, null);
  assert.equal(perf.lastRecoveryMs, null);
  perf.closes.agent += 1;
  perf.lastClose = { code: 4011, reason: "remote agent video link ended", wasClean: true, kind: "agent", at: 1, openForMs: 900, frames: 12 };
  const snap = snapshotPerf(perf);
  perf.closes.agent += 5;
  perf.lastClose.frames = 99;
  assert.equal(snap.closes.agent, 1);
  assert.equal(snap.lastClose?.frames, 12);
});
