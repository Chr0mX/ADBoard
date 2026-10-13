import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TASKBAR_PINS,
  MAX_TASKBAR_PINS,
  normalizeTaskbarPins,
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
    const many = [
      "keyboard",
      "mouse",
      "record",
      "replay",
      "refresh",
      "apk",
    ];
    const next = normalizeTaskbarPins(many);
    assert.equal(next.length, MAX_TASKBAR_PINS);
    assert.deepEqual(next, many.slice(0, MAX_TASKBAR_PINS));
  });
});
