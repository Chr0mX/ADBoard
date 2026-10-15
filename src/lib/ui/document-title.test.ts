import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { documentTitle } from "./document-title.ts";

describe("documentTitle", () => {
  it("names the active phone on Control", () => {
    assert.equal(documentTitle({ section: "control", deviceName: "S24" }), "S24 · ADBoard");
  });

  it("falls back to the app name without a device", () => {
    assert.equal(documentTitle({ section: "control", deviceName: null }), "ADBoard");
    assert.equal(documentTitle({ section: "control", deviceName: "  " }), "ADBoard");
  });

  it("uses Grid while the grid view is open", () => {
    assert.equal(documentTitle({ section: "control", gridView: true, deviceName: "S24" }), "Grid · ADBoard");
  });

  it("uses the section label elsewhere", () => {
    assert.equal(documentTitle({ section: "files", sectionLabel: "Files", deviceName: "S24" }), "Files · ADBoard");
  });
});
