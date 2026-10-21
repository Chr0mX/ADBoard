import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TASKBAR_PINS,
  MAX_TASKBAR_PINS,
  moveTaskbarPin,
  normalizeHiddenNav,
  normalizeTaskbarPins,
  TASKBAR_TOOL_GROUP,
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
    assert.equal(MAX_TASKBAR_PINS, TASKBAR_TOOL_IDS.length);
    assert.equal(next.length, MAX_TASKBAR_PINS);
    // Room for every tool, each pinned once, in order.
    assert.deepEqual(next, [...TASKBAR_TOOL_IDS]);
  });
});

describe("taskbar tools", () => {
  it("offers Macros, Screenshot and Screen record in the customisation list", () => {
    assert.ok(TASKBAR_TOOL_IDS.includes("macro"));
    assert.ok(TASKBAR_TOOL_IDS.includes("screenshot"));
    assert.ok(TASKBAR_TOOL_IDS.includes("screenrec"));
  });
});

describe("moveTaskbarPin", () => {
  it("moves a pin earlier and later, keeping the others in order", () => {
    assert.deepEqual(moveTaskbarPin(["keyboard", "refresh", "apk"], "apk", -1), ["keyboard", "apk", "refresh"]);
    assert.deepEqual(moveTaskbarPin(["keyboard", "refresh", "apk"], "keyboard", 1), ["refresh", "keyboard", "apk"]);
  });

  it("does nothing at the ends or for a pin that is not there", () => {
    assert.deepEqual(moveTaskbarPin(["keyboard", "refresh"], "keyboard", -1), ["keyboard", "refresh"]);
    assert.deepEqual(moveTaskbarPin(["keyboard", "refresh"], "refresh", 1), ["keyboard", "refresh"]);
    assert.deepEqual(moveTaskbarPin(["keyboard"], "apk", 1), ["keyboard"]);
  });
});

describe("taskbar groups and hidden controls", () => {
  it("puts every pinnable tool in a group", () => {
    for (const id of TASKBAR_TOOL_IDS) assert.ok(TASKBAR_TOOL_GROUP[id], id);
  });

  it("keeps hidden controls in the fixed order, without duplicates or unknown ids", () => {
    assert.deepEqual(normalizeHiddenNav(["power", "back", "volume_up", "power"]), ["volume_up", "power"]);
    assert.deepEqual(normalizeHiddenNav("x"), []);
  });
});

