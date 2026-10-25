import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_DECODE_QUEUE, admitFrame, newDecodeGate, type GateVerdict } from "./backpressure.ts";

const frame = (isKey: boolean, queueSize: number, hidden = false) => ({ isKey, queueSize, hidden });

/**
 * A decoder that finishes `decodePerTick` frames per tick while the agent
 * sends one access unit per tick, a keyframe every `gop` frames.
 */
function simulate({
  ticks,
  gop,
  decodePerTick,
  hiddenAt = () => false,
}: {
  ticks: number;
  gop: number;
  decodePerTick: number;
  hiddenAt?: (tick: number) => boolean;
}) {
  const gate = newDecodeGate();
  let queue = 0;
  let budget = 0;
  let maxQueue = 0;
  let decoded = 0;
  let asks = 0;
  /** Frames decoded since the last keyframe, as the decoder sees the chain. */
  let chainBroken = false;
  let badFrames = 0;
  const verdicts: GateVerdict[] = [];
  for (let tick = 0; tick < ticks; tick += 1) {
    budget += decodePerTick;
    while (budget >= 1 && queue > 0) {
      queue -= 1;
      budget -= 1;
    }
    if (queue === 0) budget = Math.min(budget, 1);
    const isKey = tick % gop === 0;
    const verdict = admitFrame(gate, frame(isKey, queue, hiddenAt(tick)));
    verdicts.push(verdict);
    if (verdict === "decode") {
      if (isKey) chainBroken = false;
      if (chainBroken) badFrames += 1;
      queue += 1;
      decoded += 1;
    } else {
      // A dropped frame breaks the chain the next delta frames refer to.
      chainBroken = true;
      if (verdict === "drop-ask-keyframe") asks += 1;
    }
    maxQueue = Math.max(maxQueue, queue);
  }
  return { gate, maxQueue, decoded, asks, badFrames, verdicts };
}

describe("decode back-pressure", () => {
  it("decodes everything while the decoder keeps up", () => {
    const gate = newDecodeGate();
    for (let i = 0; i < 100; i += 1) {
      assert.equal(admitFrame(gate, frame(i % 30 === 0, i % 2)), "decode");
    }
    assert.equal(gate.dropped, 0);
  });

  it("drops and asks for a keyframe once the queue is full", () => {
    const gate = newDecodeGate();
    assert.equal(admitFrame(gate, frame(false, MAX_DECODE_QUEUE - 1)), "decode");
    assert.equal(admitFrame(gate, frame(false, MAX_DECODE_QUEUE)), "drop-ask-keyframe");
    assert.equal(gate.dropping, true);
  });

  it("keeps dropping delta frames after the queue drains, until a keyframe", () => {
    const gate = newDecodeGate();
    admitFrame(gate, frame(false, MAX_DECODE_QUEUE));
    // Queue is empty again, but these deltas refer to the frame just dropped.
    assert.equal(admitFrame(gate, frame(false, 0)), "drop");
    assert.equal(admitFrame(gate, frame(false, 0)), "drop");
    assert.equal(admitFrame(gate, frame(true, 0)), "decode");
    assert.equal(gate.dropping, false);
    assert.equal(admitFrame(gate, frame(false, 0)), "decode");
    assert.equal(gate.dropped, 3);
  });

  it("does not resume on a keyframe while the queue is still full", () => {
    const gate = newDecodeGate();
    admitFrame(gate, frame(false, MAX_DECODE_QUEUE));
    assert.equal(admitFrame(gate, frame(true, MAX_DECODE_QUEUE)), "drop");
    assert.equal(admitFrame(gate, frame(true, 1)), "decode");
  });

  it("asks for a keyframe once per dropping episode", () => {
    const gate = newDecodeGate();
    const verdicts = [
      admitFrame(gate, frame(false, MAX_DECODE_QUEUE)),
      admitFrame(gate, frame(false, MAX_DECODE_QUEUE + 5)),
      admitFrame(gate, frame(false, MAX_DECODE_QUEUE + 5)),
    ];
    assert.deepEqual(verdicts, ["drop-ask-keyframe", "drop", "drop"]);
  });

  it("decodes nothing while the page is hidden, and resumes on a keyframe", () => {
    const gate = newDecodeGate();
    assert.equal(admitFrame(gate, frame(true, 0, true)), "drop");
    assert.equal(admitFrame(gate, frame(false, 0, true)), "drop");
    // Visible again: the deltas refer to frames that were never decoded.
    assert.equal(admitFrame(gate, frame(false, 0)), "drop");
    assert.equal(admitFrame(gate, frame(true, 0)), "decode");
  });

  it("bounds the queue when frames arrive faster than they decode", () => {
    // 60 fps in, ~20 fps decoded: without the gate the queue grows by ~40/s.
    const run = simulate({ ticks: 6000, gop: 60, decodePerTick: 1 / 3 });
    assert.ok(run.maxQueue <= MAX_DECODE_QUEUE, `queue reached ${run.maxQueue}`);
    assert.ok(run.decoded > 0);
    assert.ok(run.asks > 0);
    assert.ok(run.gate.dropped > 0);
  });

  it("never decodes a delta frame whose reference was dropped", () => {
    for (const decodePerTick of [0.1, 0.3, 0.5, 0.9, 1, 2]) {
      const run = simulate({ ticks: 3000, gop: 30, decodePerTick });
      assert.equal(run.badFrames, 0, `decode rate ${decodePerTick}`);
      assert.ok(run.maxQueue <= MAX_DECODE_QUEUE);
    }
  });

  it("drops nothing when the decoder is fast enough", () => {
    const run = simulate({ ticks: 3000, gop: 30, decodePerTick: 1 });
    assert.equal(run.gate.dropped, 0);
    assert.equal(run.decoded, 3000);
  });

  it("stops decoding while hidden and picks up at the first keyframe after", () => {
    const run = simulate({ ticks: 300, gop: 30, decodePerTick: 1, hiddenAt: (t) => t >= 100 && t < 200 });
    assert.ok(run.verdicts.slice(100, 200).every((v) => v === "drop"));
    // Visible again at 200 — not a keyframe tick (210 is): 200..209 drop.
    assert.ok(run.verdicts.slice(200, 210).every((v) => v === "drop"));
    assert.equal(run.verdicts[210], "decode");
    assert.equal(run.badFrames, 0);
  });
});
