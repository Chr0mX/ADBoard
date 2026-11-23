import assert from "node:assert/strict";
import test from "node:test";
import { allFailed, quietOutcome } from "./op-results.ts";

const ok = (id: string) => ({ ok: true, deviceId: id });
const bad = (id: string) => ({ ok: false, deviceId: id, error: "no" });

test("allFailed needs results and no success", () => {
  assert.equal(allFailed(undefined), false);
  assert.equal(allFailed([]), false);
  assert.equal(allFailed([bad("a"), bad("b")]), true);
  assert.equal(allFailed([bad("a"), ok("b")]), false);
});

test("Quiet Mode only changes the switch when a phone really went quiet", () => {
  assert.deepEqual(quietOutcome(["a", "b"], [ok("a"), ok("b")], [ok("a"), ok("b")]), { done: 2, failed: false, partial: false });
  assert.deepEqual(quietOutcome(["a", "b"], [ok("a"), bad("b")], [ok("a"), ok("b")]), { done: 1, failed: false, partial: true });
  assert.equal(quietOutcome(["a", "b"], [bad("a"), bad("b")], [ok("a"), ok("b")]).failed, true, "screen failed everywhere");
  assert.equal(quietOutcome(["a"], null, [ok("a")]).failed, true, "the whole screen request failed");
  assert.equal(quietOutcome(["a"], [ok("a")], null).failed, true, "the whole mute request failed");
  assert.equal(quietOutcome([], [], []).failed, true, "no phones: nothing happened");
});
