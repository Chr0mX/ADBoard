import assert from "node:assert/strict";
import test from "node:test";
import { controlGroupLabel } from "./control-group.ts";

test("nothing is shown while only the shown phone is controlled", () => {
  assert.equal(controlGroupLabel("selected", 5), null);
  assert.equal(controlGroupLabel(undefined, 5), null);
  assert.equal(controlGroupLabel("all", 1), null, "a group of one is just that phone");
  assert.equal(controlGroupLabel("multi", 0), null);
});

test("a group says how many phones and which group", () => {
  assert.equal(controlGroupLabel("all", 12), "Controlling 12 phones (all online phones)");
  assert.equal(controlGroupLabel("multi", 3), "Controlling 3 phones (the ticked phones)");
});
