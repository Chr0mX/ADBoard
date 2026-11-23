import assert from "node:assert/strict";
import test from "node:test";
import { alertDetail, diffConnections, type SeenMap } from "./connection-alerts-core.ts";

const phone = (id: string, status: "online" | "offline" | "unauthorized" | "stale", serial = `SER-${id}`) => ({ id, serial, status });

test("the first list gives no alerts, only a starting point", () => {
  const { alerts, next } = diffConnections(null, [phone("a", "online"), phone("b", "offline")]);
  assert.deepEqual(alerts, []);
  assert.equal(next.size, 2);
});

test("a phone going offline, then coming back, gives one alert each way", () => {
  let seen: SeenMap = diffConnections(null, [phone("a", "online")]).next;
  const drop = diffConnections(seen, [phone("a", "offline")]);
  assert.deepEqual(drop.alerts, [{ id: "a", kind: "disconnected", serial: "SER-a" }]);
  seen = drop.next;
  const back = diffConnections(seen, [phone("a", "online")]);
  assert.deepEqual(back.alerts, [{ id: "a", kind: "connected", serial: "SER-a" }]);
});

test("polling the same state again gives nothing", () => {
  let seen: SeenMap = diffConnections(null, [phone("a", "online"), phone("b", "offline")]).next;
  for (let i = 0; i < 5; i++) {
    const step = diffConnections(seen, [phone("a", "online"), phone("b", "offline")]);
    assert.deepEqual(step.alerts, []);
    seen = step.next;
  }
  // Staying offline after the drop is also quiet.
  const drop = diffConnections(seen, [phone("a", "offline"), phone("b", "offline")]);
  assert.equal(drop.alerts.length, 1);
  assert.deepEqual(diffConnections(drop.next, [phone("a", "offline"), phone("b", "offline")]).alerts, []);
});

test("each phone has its own alerts and a new phone gives none", () => {
  const seen = diffConnections(null, [phone("a", "online"), phone("b", "online")]).next;
  const step = diffConnections(seen, [phone("a", "offline"), phone("b", "online"), phone("c", "online")]);
  assert.deepEqual(step.alerts.map((a) => [a.id, a.kind]), [["a", "disconnected"]]);
});

test("a phone that leaves the list is disconnected once, and connected when it returns", () => {
  const seen = diffConnections(null, [phone("a", "online")]).next;
  const gone = diffConnections(seen, []);
  assert.deepEqual(gone.alerts, [{ id: "a", kind: "disconnected", serial: "SER-a" }]);
  assert.deepEqual(diffConnections(gone.next, []).alerts, []);
  const back = diffConnections(gone.next, [phone("a", "online")]);
  assert.deepEqual(back.alerts, [{ id: "a", kind: "connected", serial: "SER-a" }]);
});

test("waiting for USB debugging approval is not a reconnection", () => {
  const seen = diffConnections(null, [phone("a", "offline")]).next;
  assert.deepEqual(diffConnections(seen, [phone("a", "unauthorized")]).alerts, []);
});

test("the detail line carries the serial", () => {
  assert.equal(alertDetail({ id: "a", kind: "disconnected", serial: "SM-G998B" }), "SM-G998B · ADB connection lost");
  assert.equal(alertDetail({ id: "a", kind: "connected", serial: "R5CW" }), "R5CW · ADB connection restored");
});

test("an unreachable agent (stale phones) gives no alert, and recovery gives none for unchanged phones", () => {
  let seen: SeenMap = diffConnections(null, [phone("a", "online"), phone("b", "online")]).next;
  const down = diffConnections(seen, [phone("a", "stale"), phone("b", "stale")]);
  assert.deepEqual(down.alerts, []);
  seen = down.next;
  // The agent is back: a is still online, b really dropped meanwhile.
  const back = diffConnections(seen, [phone("a", "online"), phone("b", "offline")]);
  assert.deepEqual(back.alerts, [{ id: "b", kind: "disconnected", serial: "SER-b" }]);
});
