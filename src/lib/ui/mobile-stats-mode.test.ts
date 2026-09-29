import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMobileStatsMode } from "./mobile-stats-mode.ts";

describe("parseMobileStatsMode", () => {
  it("defaults to float", () => {
    assert.equal(parseMobileStatsMode(null), "float");
    assert.equal(parseMobileStatsMode(undefined), "float");
    assert.equal(parseMobileStatsMode("nope"), "float");
  });

  it("accepts bar", () => {
    assert.equal(parseMobileStatsMode("bar"), "bar");
  });
});
