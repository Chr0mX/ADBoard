import assert from "node:assert/strict";
import test from "node:test";
import { closeKind, describeClose, newCloseCounts, shouldForgetToken, type CloseKind } from "./close-core.ts";

test("every code the agent sends maps to the layer that failed", () => {
  const expected: Record<number, CloseKind> = {
    1000: "normal",
    1001: "normal",
    4004: "device",
    4005: "device",
    4012: "device",
    4010: "agent",
    4011: "agent",
    4008: "client",
    4009: "client",
    1006: "transport",
    1005: "transport",
    1015: "transport",
    1011: "other",
    4999: "other",
  };
  for (const [code, kind] of Object.entries(expected)) assert.equal(closeKind(Number(code)), kind, `code ${code}`);
});

test("the agent's own reason keeps the token; a failure with no reason does not", () => {
  assert.equal(shouldForgetToken("device"), false);
  assert.equal(shouldForgetToken("agent"), false);
  assert.equal(shouldForgetToken("client"), false);
  assert.equal(shouldForgetToken("transport"), true);
  assert.equal(shouldForgetToken("normal"), true);
});

test("the description names the failing side and never calls a lost agent a lost phone", () => {
  const agent = describeClose({ code: 4011, reason: "remote agent video link ended", kind: "agent" });
  assert.match(agent, /remote agent/);
  assert.doesNotMatch(agent, /phone/);
  assert.match(describeClose({ code: 4004, reason: "unknown device", kind: "device" }), /phone's stream/);
  assert.match(describeClose({ code: 1006, reason: "", kind: "transport" }), /no close frame/);
});

test("counts start at zero for every kind", () => {
  assert.deepEqual(Object.values(newCloseCounts()), [0, 0, 0, 0, 0, 0, 0]);
});

test("a socket given up on for a missing heartbeat is its own kind and gets a fresh token", () => {
  assert.equal(shouldForgetToken("stale"), true);
  assert.match(describeClose({ code: 0, reason: ": no message for 16 s", kind: "stale" }), /no heartbeat/);
});
