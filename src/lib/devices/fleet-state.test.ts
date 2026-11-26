import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFailure,
  applySnapshot,
  createSnapshotGate,
  initialFleet,
  isUnconfirmed,
  unreachableMessage,
  withFreshness,
} from "./fleet-state.ts";

const phone = (id: string, status: "online" | "offline" | "unauthorized" | "stale" = "online") =>
  ({ id, serial: `S-${id}`, name: id, status }) as never;

test("a real fleet is never replaced by sample phones when a request fails", () => {
  let state = initialFleet(false, [phone("mock")]);
  assert.deepEqual(state.devices, [], "the sample fleet is only for explicit demo mode");
  state = applySnapshot(state, [phone("real-1"), phone("real-2")], 1_000);
  state = applyFailure(state, "agent timed out");
  assert.deepEqual(state.devices.map((d: { id: string }) => d.id), ["real-1", "real-2"]);
  assert.equal(state.connection, "unreachable");
  assert.equal(state.lastOkAt, 1_000, "the last successful refresh is kept");
  assert.equal(state.lastError, "agent timed out");
});

test("demo mode shows the sample phones and ignores agent answers and failures", () => {
  const state = initialFleet(true, [phone("mock")]);
  assert.equal(state.connection, "demo");
  assert.equal(applyFailure(state, "x"), state);
  assert.equal(applySnapshot(state, [phone("real")], 5), state);
  assert.equal(withFreshness(state.devices, state.connection)[0].status, "online", "demo phones stay as they are");
});

test("while the agent is unreachable an online phone is stale, never online", () => {
  const list = [phone("a", "online"), phone("b", "offline"), phone("c", "unauthorized")];
  const shown = withFreshness(list, "unreachable");
  assert.deepEqual(shown.map((d: { status: string }) => d.status), ["stale", "offline", "unauthorized"]);
  assert.equal(withFreshness(list, "live"), list, "a live list is used as is");
});

test("the list recovers when the agent answers again", () => {
  let state = applySnapshot(initialFleet(false), [phone("a")], 1);
  state = applyFailure(state, "down");
  assert.equal(withFreshness(state.devices, state.connection)[0].status, "stale");
  state = applySnapshot(state, [phone("a"), phone("b")], 9_000);
  assert.equal(state.connection, "live");
  assert.equal(state.lastError, null);
  assert.equal(state.lastOkAt, 9_000);
  assert.equal(withFreshness(state.devices, state.connection)[0].status, "online");
});

test("the unreachable message names the last good time and the reason", () => {
  assert.equal(unreachableMessage(initialFleet(true)), null);
  const first = applyFailure(initialFleet(false), "connection refused");
  assert.match(unreachableMessage(first)!, /Cannot reach the ADBoard agent \(connection refused\)\. Retrying\./);
  const later = applyFailure(applySnapshot(initialFleet(false), [phone("a")], 1_700_000_000_000), "timeout");
  assert.match(unreachableMessage(later)!, /Showing the last known phones from /);
  assert.equal(unreachableMessage(applySnapshot(later, [phone("a")], 2)), null);
});

test("an older response never overwrites a newer one", () => {
  const gate = createSnapshotGate();
  const slow = gate.begin();
  const fast = gate.begin();
  assert.equal(gate.accept(fast), true, "the newer request answers first");
  assert.equal(gate.accept(slow), false, "the older one arrives late and is dropped");
});

test("a list pushed by the agent makes every request still on its way stale", () => {
  const gate = createSnapshotGate();
  const request = gate.begin();
  gate.markPush();
  assert.equal(gate.accept(request), false);
  const after = gate.begin();
  assert.equal(gate.accept(after), true, "requests made after the push are fine");
  assert.equal(gate.accept(after), false, "and one answer is used once");
});

test("a refused request (401) is told apart from an unreachable agent, and recovers the same way", () => {
  let state = applySnapshot(initialFleet(false), [phone("a"), phone("b", "offline")], 10);
  state = applyFailure(state, "agent listDevices failed: 401", true);
  assert.equal(state.connection, "unauthorized");
  assert.equal(state.lastOkAt, 10);
  assert.equal(isUnconfirmed(state.connection), true);
  assert.deepEqual(
    withFreshness(state.devices, state.connection).map((d: { status: string }) => d.status),
    ["stale", "offline"],
    "a refused page may not treat the old list as ready either",
  );
  assert.match(unreachableMessage(state)!, /refused this page/);
  assert.doesNotMatch(unreachableMessage(state)!, /Cannot reach/);
  // The agent answering again brings everything back.
  state = applySnapshot(state, [phone("a")], 20);
  assert.equal(state.connection, "live");
  assert.equal(unreachableMessage(state), null);
  // And a later outage is "unreachable" again, not "unauthorized".
  assert.equal(applyFailure(state, "connection refused").connection, "unreachable");
});

test("only 401 and 403 count as a refusal", async () => {
  const { HttpStatusError, isAuthRefusal } = await import("../api/http-error.ts");
  assert.equal(isAuthRefusal(new HttpStatusError("no", 401)), true);
  assert.equal(isAuthRefusal(new HttpStatusError("no", 403)), true);
  assert.equal(isAuthRefusal(new HttpStatusError("no", 502)), false);
  assert.equal(isAuthRefusal(new Error("connection refused")), false);
});

test("a stale phone from the controller stays stale and is never promoted by the page", () => {
  const list = [phone("remote", "stale"), phone("local", "online")];
  assert.deepEqual(withFreshness(list, "live").map((d: { status: string }) => d.status), ["stale", "online"]);
});
