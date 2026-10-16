import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TASKBAR_PINS,
  MAX_TASKBAR_PINS,
  normalizeTaskbarPins,
  TASKBAR_TOOL_IDS,
} from "./taskbar-pins.ts";

describe("normalizeTaskbarPins", () => {
  it("returns defaults for invalid input", () => {
    assert.deepEqual(normalizeTaskbarPins(null), DEFAULT_TASKBAR_PINS);
    assert.deepEqual(normalizeTaskbarPins("x"), DEFAULT_TASKBAR_PINS);
  });

  it("dedupes and drops unknown ids", () => {
    assert.deepEqual(
      normalizeTaskbarPins(["keyboard", "nope", "keyboard", "refresh"]),
      ["keyboard", "refresh"],
    );
  });

  it("caps at MAX_TASKBAR_PINS", () => {
    // Every tool once, a duplicate, then every tool again.
    const many = [...TASKBAR_TOOL_IDS, "keyboard", ...TASKBAR_TOOL_IDS];
    const next = normalizeTaskbarPins(many);
    assert.equal(MAX_TASKBAR_PINS, 15);
    assert.equal(next.length, MAX_TASKBAR_PINS);
    // Room for every tool, each pinned once, in order.
    assert.deepEqual(next, [...TASKBAR_TOOL_IDS]);
  });
});
