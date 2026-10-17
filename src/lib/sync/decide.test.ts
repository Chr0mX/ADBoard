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
