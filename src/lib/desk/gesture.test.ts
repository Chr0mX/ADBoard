import assert from "node:assert/strict";
import test from "node:test";
import { finishGesture, replayGesture, type GestureSample } from "./gesture.ts";

test("an open drag ends with a pointer up", () => {
  const samples: GestureSample[] = [
    { t: 0, phase: "down", x: 0.2, y: 0.3, tool: "finger" },
    { t: 40, phase: "move", x: 0.5, y: 0.6, tool: "finger" },
  ];
  const done = finishGesture(samples);
  assert.equal(done.at(-1)?.phase, "up");
  assert.equal(done.at(-1)?.x, 0.5);
  assert.equal(done.at(-1)?.t, 56);
});

test("replay waits the same gaps that were recorded", async () => {
  const samples: GestureSample[] = [
    { t: 0, phase: "down", x: 0.1, y: 0.2, tool: "mouse" },
    { t: 30, phase: "move", x: 0.4, y: 0.5, tool: "mouse" },
    { t: 90, phase: "up", x: 0.4, y: 0.5, tool: "mouse" },
  ];
  const waits: number[] = [];
  const sent: string[] = [];
  await replayGesture(samples, async (sample) => {
    sent.push(sample.phase);
  }, {
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.deepEqual(waits, [30, 60]);
  assert.deepEqual(sent, ["down", "move", "up"]);
});
