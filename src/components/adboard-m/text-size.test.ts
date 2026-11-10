import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseTextSize, viewportFor } from "./text-size-core.ts";

const root = path.resolve(import.meta.dirname, "../../..");

test("text size defaults to compact and only accepts known values", () => {
  assert.equal(parseTextSize(null), "compact");
  assert.equal(parseTextSize("huge"), "compact");
  assert.equal(parseTextSize("standard"), "standard");
});

test("standard keeps pinch zoom on, compact stops the iOS focus zoom", () => {
  const meta = "width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover";
  assert.match(viewportFor("standard", meta), /maximum-scale=5, viewport-fit=cover/);
  assert.match(viewportFor("compact", viewportFor("standard", meta)), /maximum-scale=1, viewport-fit=cover/);
  assert.match(viewportFor("compact", "width=device-width"), /maximum-scale=1$/);
});

test("the scale is variable-driven: both sizes define every variable, hints are at least 11 px", () => {
  const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
  const names = ["body", "hint", "btn", "field", "h2", "h3", "h4", "tab"];
  for (const n of names) {
    const all = [...css.matchAll(new RegExp(`--m-${n}:\\s*([0-9.]+)rem`, "g"))].map((m) => Number(m[1]) * 16);
    assert.equal(all.length, 2, `--m-${n} defined for compact and standard`);
    if (n === "hint" || n === "tab") for (const px of all) assert.ok(px >= 11, `--m-${n} >= 11px`);
  }
  const standardField = css.match(/html\[data-m-text="standard"\]\s*\{[^}]*--m-field:\s*([0-9.]+)rem/s);
  assert.equal(Number(standardField?.[1]) * 16, 16, "standard fields are 16 px (no iOS focus zoom)");
});

test("mobile screens use an icon, not an emoji, for Add", () => {
  assert.ok(!readFileSync(path.join(root, "src/components/adboard-m/apps-panel-mobile.tsx"), "utf8").includes("➕"));
});

test("sheet has a grab bar and honours reduced motion", () => {
  const src = readFileSync(path.join(root, "src/components/adboard-m/bottom-sheet.tsx"), "utf8");
  assert.ok(src.includes("data-m-sheet-grab"));
  assert.ok(src.includes("prefers-reduced-motion"));
});
