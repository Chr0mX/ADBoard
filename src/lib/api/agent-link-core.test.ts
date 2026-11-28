import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DOWN_PROBE_MAX_MS,
  GATE_MAX_WAIT_MS,
  RELOAD_AFTER_MS,
  RELOAD_EVERY_MS,
  UP_PROBE_MS,
  initialLink,
  mayConnect,
  nextProbeDelay,
  onInstanceSeen,
  onProbe,
  reconnectSpreadMs,
  shouldReload,
} from "./agent-link-core.ts";

const up = (instance: string | null, ready = true) => ({ ok: true as const, instance, ready });

test("a first answer is up and ready; a failure after it is an outage", () => {
  let { state, events } = onProbe(initialLink(0), up("a"), 10);
  assert.deepEqual(events, ["up", "ready"]);
  assert.equal(state.phase, "up");
  ({ state, events } = onProbe(state, { ok: false }, 20));
  assert.deepEqual(events, ["down"]);
  assert.equal(state.outages, 1);
  assert.equal(state.ready, false);
  ({ state, events } = onProbe(state, { ok: false }, 30));
  assert.deepEqual(events, [], "still down: nothing new");
  assert.equal(state.failures, 2);
});

test("run.bat closed and opened again: the new process is a restart, and ready once it has listed the phones", () => {
  let { state } = onProbe(initialLink(0), up("old"), 0);
  ({ state } = onProbe(state, { ok: false }, 1000));
  let events;
  ({ state, events } = onProbe(state, up("new", false), 9000));
  assert.deepEqual(events, ["up", "restarted"], "answers, but has not looked at the phones yet");
  assert.equal(state.restarts, 1);
  ({ state, events } = onProbe(state, up("new", true), 10_000));
  assert.deepEqual(events, ["ready"]);
  ({ state, events } = onProbe(state, up("new", true), 25_000));
  assert.deepEqual(events, []);
});

test("a restart between two probes (no outage seen) is still a restart", () => {
  let { state } = onProbe(initialLink(0), up("old"), 0);
  let events;
  ({ state, events } = onProbe(state, up("new"), 15_000));
  assert.deepEqual(events, ["restarted", "ready"]);
  // A video heartbeat can tell first.
  ({ state, events } = onInstanceSeen(state, "newer", 16_000));
  assert.deepEqual(events, ["restarted", "ready"]);
  ({ state, events } = onInstanceSeen(state, "newer", 17_000));
  assert.deepEqual(events, []);
});

test("an older agent without an instance id is never mistaken for a restart", () => {
  let { state } = onProbe(initialLink(0), up(null), 0);
  const { events } = onProbe(state, up(null), 15_000);
  assert.deepEqual(events, []);
  ({ state } = onProbe(state, { ok: false }, 16_000));
  assert.deepEqual(onProbe(state, up(null), 20_000).events, ["up", "ready"]);
});

test("probes are quick and jittered while the agent is away, slow while it answers", () => {
  let { state } = onProbe(initialLink(0), up("a"), 0);
  assert.equal(nextProbeDelay(state), UP_PROBE_MS);
  const delays: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    ({ state } = onProbe(state, { ok: false }, i));
    delays.push(nextProbeDelay(state, () => 1));
  }
  assert.equal(delays[0], 500, "the first retry comes within half a second");
  assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]));
  assert.equal(Math.max(...delays), DOWN_PROBE_MAX_MS, "bounded: a returning agent is noticed within 2 s");
  assert.ok(nextProbeDelay(state, () => 0) >= DOWN_PROBE_MAX_MS / 2);
});

test("a stream waits for the agent and for its phone, but never for ever", () => {
  assert.equal(mayConnect("down", "online", 0), false);
  assert.equal(mayConnect("up", "not-online", 0), false, "the phone is not listed online yet");
  assert.equal(mayConnect("up", "online", 0), true);
  assert.equal(mayConnect("unknown", "unknown", 0), true, "page load: try at once");
  assert.equal(mayConnect("down", "not-online", GATE_MAX_WAIT_MS), true, "the watcher could be wrong");
});

test("reconnects after a restart are spread out", () => {
  const spread = Array.from({ length: 12 }, (_, i) => reconnectSpreadMs(i, () => 0.5));
  assert.equal(spread[0], 60);
  assert.ok(spread[11] < 1000, "twelve phones within a second");
});

test("the page reloads itself only when the agent answers and no stream can connect for a minute", () => {
  const base = { phase: "up" as const, ready: true, upForMs: RELOAD_AFTER_MS, wanted: 4, connectedSinceUp: 0, lastReloadAt: null, now: 1e9, pageVisible: true };
  assert.equal(shouldReload(base), true);
  assert.equal(shouldReload({ ...base, connectedSinceUp: 1 }), false, "one working stream: the page is fine");
  assert.equal(shouldReload({ ...base, upForMs: RELOAD_AFTER_MS - 1 }), false);
  assert.equal(shouldReload({ ...base, phase: "down" }), false, "the agent is away: a reload would not help");
  assert.equal(shouldReload({ ...base, ready: false }), false);
  assert.equal(shouldReload({ ...base, wanted: 0 }), false);
  assert.equal(shouldReload({ ...base, pageVisible: false }), false);
  assert.equal(shouldReload({ ...base, lastReloadAt: base.now - RELOAD_EVERY_MS + 1 }), false, "at most once in ten minutes");
  assert.equal(shouldReload({ ...base, lastReloadAt: base.now - RELOAD_EVERY_MS }), true);
});
