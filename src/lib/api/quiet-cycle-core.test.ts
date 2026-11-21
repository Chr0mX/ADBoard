import assert from "node:assert/strict";
import test from "node:test";
import { cycleLine, formatLeft, parseMinutes, secondsLeft } from "./quiet-cycle-core.ts";

test("minutes parse to whole numbers in range, with a fallback", () => {
  assert.equal(parseMinutes("180", 1), 180);
  assert.equal(parseMinutes(" 15 ", 1), 15);
  assert.equal(parseMinutes("0", 15), 15);
  assert.equal(parseMinutes("", 15), 15);
  assert.equal(parseMinutes("abc", 15), 15);
  assert.equal(parseMinutes("0.2", 15), 1);
  assert.equal(parseMinutes("999999", 15), 7 * 24 * 60);
});

test("time left reads as hours and minutes", () => {
  assert.equal(formatLeft(40), "40 s");
  assert.equal(formatLeft(15 * 60), "15 m");
  assert.equal(formatLeft(2 * 3600 + 41 * 60), "2 h 41 m");
  assert.equal(formatLeft(3 * 3600), "3 h");
  assert.equal(formatLeft(-5), "0 s");
});

test("the countdown runs from the agent's clock", () => {
  assert.equal(secondsLeft(1_100, 1_000, 5_000, 5_000), 100);
  assert.equal(secondsLeft(1_100, 1_000, 5_000, 15_000), 90);
  assert.equal(secondsLeft(1_100, 1_000, 5_000, 999_000), 0);
});

test("status line", () => {
  assert.equal(cycleLine(false, "quiet", 5), "Off");
  assert.equal(cycleLine(true, "quiet", 9660), "Quiet · 2 h 41 m left");
  assert.equal(cycleLine(true, "normal", 900), "Normal · 15 m left");
});
