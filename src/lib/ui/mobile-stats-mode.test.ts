import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMobileStatsMode } from "./mobile-stats-mode.ts";

describe("parseMobileStatsMode", () => {
  it("is shown by default", () => {
    assert.equal(parseMobileStatsMode(null), "show");
    assert.equal(parseMobileStatsMode(undefined), "show");
    assert.equal(parseMobileStatsMode("nope"), "show");
  });

  it("is hidden only when saved as hide", () => {
    assert.equal(parseMobileStatsMode("hide"), "hide");
    assert.equal(parseMobileStatsMode("show"), "show");
  });

  it("treats values saved by older versions as shown", () => {
    assert.equal(parseMobileStatsMode("bar"), "show");
    assert.equal(parseMobileStatsMode("float"), "show");
  });
});
