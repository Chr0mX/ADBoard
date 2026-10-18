import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firstSyncAction } from "./decide.ts";

describe("firstSyncAction", () => {
  it("adopts the shared copy when the agent has one", () => {
    assert.equal(firstSyncAction({ value: { tabs: [] }, rev: 3 }, true), "adopt");
    assert.equal(firstSyncAction({ value: { tabs: [] }, rev: 3 }, false), "adopt");
  });
  it("uploads real local data when the agent is empty", () => {
    assert.equal(firstSyncAction({ value: null, rev: 0 }, true), "upload");
  });
  it("never uploads an untouched starter", () => {
    assert.equal(firstSyncAction({ value: null, rev: 0 }, false), "skip");
  });
});

import { mergeById, mergeWorkspaces } from "./decide.ts";

describe("merge (no data loss when copies meet)", () => {
  it("keeps tabs from both sides and the newer edit of a shared tab", () => {
    const local = { version: 1, activeId: "b", tabs: [
      { id: "a", name: "A local newer", updatedAt: 5 },
      { id: "b", name: "B only here", updatedAt: 1 },
    ] };
    const remote = { version: 1, activeId: "c", tabs: [
      { id: "a", name: "A remote", updatedAt: 2 },
      { id: "c", name: "C only there", updatedAt: 1 },
    ] };
    const merged = mergeWorkspaces(local, remote);
    assert.deepEqual(merged.tabs.map((t) => t.name), ["A local newer", "C only there", "B only here"]);
    assert.equal(merged.activeId, "b");
  });
  it("an untouched starter on one side loses nothing on the other", () => {
    const real = [{ id: "farm", updatedAt: 9 }, { id: "collect", updatedAt: 9 }];
    const starter = [{ id: "tab-1", updatedAt: 1 }];
    assert.deepEqual(mergeById(starter, real).map((t) => t.id), ["farm", "collect", "tab-1"]);
  });
});

it("merge with the last agreed copy does not bring back deleted or replaced items", () => {
  const a = { id: "a", updatedAt: 1 };
  const b = { id: "b", updatedAt: 1 };
  const c = { id: "c", updatedAt: 1 };
  // This browser deleted b; the agent still has it from before.
  assert.deepEqual(mergeById([a], [a, b], [a, b]).map((x) => x.id), ["a"]);
  // Another browser deleted b; this browser still has it.
  assert.deepEqual(mergeById([a, b], [a], [a, b]).map((x) => x.id), ["a"]);
  // Replaced everything with new ids (import → replace) before the upload.
  assert.deepEqual(mergeById([c], [a, b], [a, b]).map((x) => x.id), ["c"]);
  // New on either side since the base: kept.
  assert.deepEqual(mergeById([a, c], [a, b], [a]).map((x) => x.id), ["a", "b", "c"]);
  // No base known: nothing dropped.
  assert.deepEqual(mergeById([a], [a, b], null).map((x) => x.id), ["a", "b"]);
});
