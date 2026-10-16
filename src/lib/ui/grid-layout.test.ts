import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampPage, fixedPack, formatGridLayout, pageCount, pageSlice, parseGridLayout } from "./grid-layout.ts";

describe("grid layout", () => {
  it("parses and clamps stored layouts", () => {
    assert.deepEqual(parseGridLayout(null), { mode: "auto" });
    assert.deepEqual(parseGridLayout("auto"), { mode: "auto" });
    assert.deepEqual(parseGridLayout("3x2"), { mode: "fixed", cols: 3, rows: 2 });
    assert.deepEqual(parseGridLayout("0x99"), { mode: "fixed", cols: 1, rows: 8 });
    assert.deepEqual(parseGridLayout("junk"), { mode: "auto" });
    assert.equal(formatGridLayout({ mode: "fixed", cols: 4, rows: 3 }), "4x3");
  });

  it("sizes tiles to fit a fixed grid", () => {
    // 2 columns × 1 row in 1000×800, phone aspect 9:16, no gap/stats.
    const pack = fixedPack(2, 1, 1000, 800, 9 / 16, 0, 0);
    assert.equal(pack.tileH, 800);
    assert.equal(pack.tileW, 450);
    // Width-bound: 4 columns.
    const narrow = fixedPack(4, 1, 1000, 800, 9 / 16, 0, 0);
    assert.equal(narrow.tileW, 250);
    assert.ok(narrow.tileH <= 800);
  });

  it("pages through devices", () => {
    const items = [1, 2, 3, 4, 5];
    assert.equal(pageCount(5, 2), 3);
    assert.deepEqual(pageSlice(items, 0, 2), [1, 2]);
    assert.deepEqual(pageSlice(items, 2, 2), [5]);
    assert.deepEqual(pageSlice(items, 9, 2), [5]);
    assert.equal(clampPage(4, 3, 2), 1);
    assert.equal(pageCount(0, 4), 1);
  });
});
