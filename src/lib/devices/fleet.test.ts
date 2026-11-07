import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reuseUnchanged, sameDevice } from "./fleet.ts";
import type { Device } from "./types.ts";

const phone = (id: string, over: Partial<Device> = {}): Device => ({
  id,
  name: id,
  model: "Pixel",
  androidVersion: "15",
  serial: `S-${id}`,
  connection: "usb",
  status: "online",
  battery: 80,
  temperatureC: 30,
  resolution: { width: 1080, height: 2400 },
  fps: null,
  bitrateMbps: null,
  latencyMs: null,
  host: "pc",
  wallpaperHue: 10,
  ...over,
});

describe("reuseUnchanged", () => {
  it("returns the very same array when nothing changed", () => {
    const prev = [phone("a"), phone("b")];
    const next = [phone("a"), phone("b")];
    assert.equal(reuseUnchanged(prev, next), prev);
  });

  it("keeps the unchanged phones' objects and replaces only the changed one", () => {
    const prev = [phone("a"), phone("b")];
    const next = [phone("a"), phone("b", { battery: 79 })];
    const merged = reuseUnchanged(prev, next);
    assert.notEqual(merged, prev);
    assert.equal(merged[0], prev[0]);
    assert.equal(merged[1], next[1]);
    assert.equal(merged[1].battery, 79);
  });

  it("follows the new order and handles phones that appear or leave", () => {
    const prev = [phone("a"), phone("b")];
    assert.deepEqual(reuseUnchanged(prev, [phone("b"), phone("a")]).map((d) => d.id), ["b", "a"]);
    assert.notEqual(reuseUnchanged(prev, [phone("b"), phone("a")]), prev);
    assert.deepEqual(reuseUnchanged(prev, [phone("a")]).map((d) => d.id), ["a"]);
    const added = [phone("a"), phone("b"), phone("c")];
    assert.deepEqual(reuseUnchanged(prev, added).map((d) => d.id), ["a", "b", "c"]);
    const empty: Device[] = [];
    assert.deepEqual(reuseUnchanged(empty, added), added);
  });

  it("compares nested values such as the resolution by content", () => {
    assert.equal(sameDevice(phone("a"), phone("a")), true);
    assert.equal(sameDevice(phone("a"), phone("a", { resolution: { width: 720, height: 1280 } })), false);
  });
});
