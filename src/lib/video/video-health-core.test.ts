import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTION_EVERY_MS,
  classify,
  decide,
  newHealthTracker,
  observe,
  type HealthCounts,
  type HealthInput,
  type HealthTracker,
} from "./video-health-core.ts";

const zero: HealthCounts = { seen: 0, received: 0, decoded: 0, painted: 0, agentSource: 0, agentSent: 0 };
const open: Omit<HealthInput, "now"> = { socketOpen: true, statusSeen: true, onScreen: true, idle: false };

/** Run `seconds` of half-second ticks; `step` says how each count moves per tick. */
function run(seconds: number, step: Partial<Record<keyof HealthCounts, number>>, start = zero, from = 0) {
  let counts = { ...start };
  let tracker: HealthTracker = newHealthTracker(from, counts);
  let now = from;
  for (let t = 0; t < seconds * 2; t += 1) {
    now += 500;
    counts = { ...counts };
    for (const [key, by] of Object.entries(step) as [keyof HealthCounts, number][]) {
      // The agent's counts move only with its heartbeat, every 5 s.
      const beat = key === "agentSource" || key === "agentSent";
      if (!beat || now % 5000 === 0) (counts[key] as number) += beat ? by * 10 : by;
    }
    tracker = observe(tracker, counts, now);
  }
  return { tracker, now };
}

test("a stream that paints is ok", () => {
  const { tracker, now } = run(20, { seen: 1, received: 1, decoded: 1, painted: 1, agentSource: 1, agentSent: 1 });
  assert.equal(classify(tracker, { ...open, now }), "ok");
});

test("A: no open socket is the reconnect logic's business", () => {
  const { tracker, now } = run(5, {});
  assert.equal(classify(tracker, { ...open, socketOpen: false, now }), "socket-down");
  assert.equal(classify(tracker, { ...open, statusSeen: false, now }), "waiting");
});

test("a still screen is not a fault, and no repair is attempted", () => {
  const started = { ...zero, seen: 50, received: 50, decoded: 50, painted: 50, agentSource: 50, agentSent: 50 };
  const { tracker, now } = run(60, {}, started);
  const health = classify(tracker, { ...open, now });
  assert.equal(health, "still");
  assert.equal(decide(tracker, health, now).action, "none");
});

test("D: decoded but not painted while on screen is repainted, rationed", () => {
  const { tracker, now } = run(6, { seen: 1, received: 1, decoded: 1, agentSource: 1, agentSent: 1 });
  const health = classify(tracker, { ...open, now });
  assert.equal(health, "not-rendering");
  const first = decide(tracker, health, now);
  assert.equal(first.action, "repaint");
  assert.equal(decide(first.tracker, health, now + 1000).action, "none");
  assert.equal(decide(first.tracker, health, now + ACTION_EVERY_MS).action, "repaint");
  // Off screen, nothing is painted on purpose.
  assert.notEqual(classify(tracker, { ...open, onScreen: false, now }), "not-rendering");
});

test("D: a paint stall counts only from when the phone came on screen (a tab back from hidden)", () => {
  const { tracker, now } = run(6, { seen: 1, received: 1, decoded: 1, agentSource: 1, agentSent: 1 });
  assert.notEqual(classify(tracker, { ...open, onScreenSince: now - 100, now }), "not-rendering", "just came back");
  assert.equal(classify(tracker, { ...open, onScreenSince: now - 2500, now }), "not-rendering", "on screen 2.5 s, still no paint");
});

test("B: messages arriving but not taken in mean a page fault: reconnect", () => {
  const { tracker, now } = run(6, { seen: 1, agentSource: 1, agentSent: 1 });
  const health = classify(tracker, { ...open, now });
  assert.equal(health, "page-dropping");
  assert.equal(decide(tracker, health, now).action, "reconnect");
});

test("C: received but not decoded is left to the decoder recovery", () => {
  const { tracker, now } = run(6, { seen: 1, received: 1, agentSource: 1, agentSent: 1 });
  const health = classify(tracker, { ...open, now });
  assert.equal(health, "not-decoding");
  assert.equal(decide(tracker, health, now).action, "none");
});

test("E: the phone produces and the agent sends this socket nothing: reconnect", () => {
  const started = { ...zero, seen: 10, received: 10, decoded: 10, painted: 10, agentSource: 10, agentSent: 10 };
  const { tracker, now } = run(20, { agentSource: 1 }, started);
  const health = classify(tracker, { ...open, now });
  assert.equal(health, "agent-holding");
  assert.equal(decide(tracker, health, now).action, "reconnect");
  // An idle viewer is held on purpose.
  assert.notEqual(classify(tracker, { ...open, idle: true, now }), "agent-holding");
});

test("an agent that does not report its counts is never blamed", () => {
  const started = { ...zero, seen: 10, received: 10, decoded: 10, painted: 10, agentSource: null, agentSent: null };
  const { tracker, now } = run(30, {}, started);
  assert.equal(classify(tracker, { ...open, now }), "still");
});
