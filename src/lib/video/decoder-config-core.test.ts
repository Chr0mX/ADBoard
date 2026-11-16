import assert from "node:assert/strict";
import { test } from "node:test";
import { accelPreference, createErrorWindow, fallbackMode, parseAccelMode } from "./decoder-config-core.ts";

test("the mode maps to the WebCodecs preference, unknown values mean auto", () => {
  assert.equal(parseAccelMode(null), "auto");
  assert.equal(parseAccelMode("nonsense"), "auto");
  assert.equal(accelPreference(parseAccelMode("hardware")), "prefer-hardware");
  assert.equal(accelPreference(parseAccelMode("software")), "prefer-software");
  assert.equal(accelPreference("auto"), "no-preference");
});

test("three errors within ten seconds trip the window; spread out, they do not", () => {
  const quick = createErrorWindow();
  assert.equal(quick.note(0), false);
  assert.equal(quick.note(1000), false);
  assert.equal(quick.note(2000), true);
  const slow = createErrorWindow();
  assert.equal(slow.note(0), false);
  assert.equal(slow.note(8000), false);
  assert.equal(slow.note(16_000), false);
  slow.reset();
  assert.equal(slow.note(16_500), false);
});

test("only auto falls back to software", () => {
  assert.equal(fallbackMode("auto"), "software");
  assert.equal(fallbackMode("hardware"), "hardware");
  assert.equal(fallbackMode("software"), "software");
});
