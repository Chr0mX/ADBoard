import assert from "node:assert/strict";
import { test } from "node:test";
import { createViewGate } from "./view-gate.ts";

test("an identical poll is not a change; a different one is, once", () => {
  const gate = createViewGate();
  assert.equal(gate.changed('{"version":1,"runs":[]}'), true);
  assert.equal(gate.changed('{"version":1,"runs":[]}'), false);
  assert.equal(gate.changed('{"version":2,"runs":[]}'), true);
  assert.equal(gate.changed('{"version":2,"runs":[]}'), false);
  gate.reset();
  assert.equal(gate.changed('{"version":2,"runs":[]}'), true);
});
