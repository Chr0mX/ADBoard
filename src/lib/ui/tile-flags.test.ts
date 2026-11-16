import assert from "node:assert/strict";
import { test } from "node:test";
import { sameSession, tileFlags } from "./tile-flags.ts";

const a = { id: "a", status: "online" };
const b = { id: "b", status: "online" };

test("a change to another phone leaves this tile's flags equal", () => {
  const before = { activeId: "a", groupMode: true, targetIds: new Set(["a", "b"]), controlMode: "multi" as const, selectedIds: new Set(["a", "b"]) };
  // Phone c joins the group and becomes active: nothing about b changes.
  const after = { activeId: "c", groupMode: true, targetIds: new Set(["a", "b", "c"]), controlMode: "multi" as const, selectedIds: new Set(["a", "b", "c"]) };
  assert.deepEqual(tileFlags(b, before), tileFlags(b, after));
  assert.notDeepEqual(tileFlags(a, before), tileFlags(a, after));
});

test("included follows the mode, and offline phones are never included", () => {
  const state = { activeId: null, groupMode: true, targetIds: new Set<string>(), controlMode: "all" as const };
  assert.equal(tileFlags(a, state).included, true);
  assert.equal(tileFlags({ id: "x", status: "offline" }, state).included, false);
  assert.equal(tileFlags(a, { ...state, controlMode: "multi", selectedIds: new Set(["b"]) }).included, false);
  assert.equal(tileFlags(a, { ...state, groupMode: false, controlMode: "selected" }).inTargets, false);
});

test("an identical session report is recognised", () => {
  const s = { stream: "streaming", note: "ok", backend: "scrcpy" };
  assert.equal(sameSession(undefined, s), false);
  assert.equal(sameSession({ ...s }, s), true);
  assert.equal(sameSession({ ...s, note: "other" }, s), false);
});
