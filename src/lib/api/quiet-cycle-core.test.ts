import assert from "node:assert/strict";
import test from "node:test";
import { cycleLine, formatLeft, intervalMinutes, secondsLeft } from "./quiet-cycle-core.ts";

test("hours and minutes make whole minutes in range", () => {
  assert.equal(intervalMinutes("1", "30"), 90);
  assert.equal(intervalMinutes("", "45"), 45);
  assert.equal(intervalMinutes("2", ""), 120);
  assert.equal(intervalMinutes("0", "0"), 60);
  assert.equal(intervalMinutes("abc", "5"), 60);
  assert.equal(intervalMinutes("-1", "5"), 60);
  assert.equal(intervalMinutes("9999", "0"), 7 * 24 * 60);
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
  assert.equal(cycleLine("quiet", 9660), "Quiet now · switches in 2 h 41 m");
  assert.equal(cycleLine("normal", 900), "Normal now · switches in 15 m");
});
