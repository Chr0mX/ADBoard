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

test("the phone scale is token-driven: compact and standard define every token, small text is at least 11 px", () => {
  const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
  const compact = css.match(/\n\[data-m-app\],\s*\[data-m-sheet\]\s*\{([^}]*)\}/)?.[1] ?? "";
  const standard = css.match(/html\[data-m-text="standard"\] \[data-m-app\],\s*html\[data-m-text="standard"\] \[data-m-sheet\]\s*\{([^}]*)\}/)?.[1] ?? "";
  const names = ["title", "subtitle", "heading", "device", "body", "control", "field", "label", "secondary", "tech", "meta", "tab"];
  for (const n of names) {
    const size = (block: string) => Number(block.match(new RegExp(`--t-${n}:\\s*([0-9.]+)rem`))?.[1]) * 16;
    const [c, st] = [size(compact), size(standard)];
    assert.ok(Number.isFinite(c) && Number.isFinite(st), `--t-${n} defined for compact and standard`);
    assert.ok(st >= c, `--t-${n}: standard is not smaller than compact`);
    if (["secondary", "tech", "meta", "tab", "label"].includes(n)) assert.ok(c >= 11, `--t-${n} >= 11px`);
  }
  // Standard fields are 16 px (no iOS focus zoom).
  assert.equal(Number(standard.match(/--t-field:\s*([0-9.]+)rem/)?.[1]) * 16, 16);
});

test("mobile screens use an icon, not an emoji, for Add", () => {
  assert.ok(!readFileSync(path.join(root, "src/components/adboard-m/apps-panel-mobile.tsx"), "utf8").includes("➕"));
});

test("sheet has a grab bar and honours reduced motion", () => {
  const src = readFileSync(path.join(root, "src/components/adboard-m/bottom-sheet.tsx"), "utf8");
  assert.ok(src.includes("data-m-sheet-grab"));
  assert.ok(src.includes("prefers-reduced-motion"));
});
