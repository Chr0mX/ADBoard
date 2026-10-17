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
