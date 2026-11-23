import assert from "node:assert/strict";
import test from "node:test";
import { cycleLine, formatLeft, intervalMinutes, secondsLeft, splitInterval } from "./quiet-cycle-core.ts";

test("a number and a unit make whole minutes in range", () => {
  assert.equal(intervalMinutes("90", "min"), 90);
  assert.equal(intervalMinutes("2", "h"), 120);
  assert.equal(intervalMinutes("1.5", "h"), 90);
  assert.equal(intervalMinutes("", "min"), 60);
  assert.equal(intervalMinutes("0", "h"), 60);
  assert.equal(intervalMinutes("abc", "min"), 60);
  assert.equal(intervalMinutes("-1", "h"), 60);
  assert.equal(intervalMinutes("0.2", "min"), 1);
  assert.equal(intervalMinutes("9999", "h"), 7 * 24 * 60);
});

test("saved minutes read back as hours when they are whole hours", () => {
  assert.deepEqual(splitInterval(120), { value: "2", unit: "h" });
  assert.deepEqual(splitInterval(90), { value: "90", unit: "min" });
  assert.deepEqual(splitInterval(45), { value: "45", unit: "min" });
  assert.deepEqual(splitInterval(60), { value: "1", unit: "h" });
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
  assert.equal(cycleLine("quiet", 9660), "Quiet now · next change in 2 h 41 m");
  assert.equal(cycleLine("normal", 900), "Normal now · next change in 15 m");
});

test("the Quiet Mode Loop toggle checks for 'no agent' with === null (same-origin is the empty string)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../components/adboard/quiet-repeat.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("agentBaseUrl() === null"));
  assert.ok(!/!agentBaseUrl\(\)/.test(src), "an empty base URL (the Windows pack) must not disable the toggle");
});
