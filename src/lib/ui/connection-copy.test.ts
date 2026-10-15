import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectionProblemLabel,
  offlineOverlayCopy,
  streamOverlayCopy,
} from "./connection-copy.ts";
import type { Device, SessionStatus } from "../devices/types.ts";

const base: Device = {
  id: "d1",
  name: "Phone",
  model: "Pixel",
  androidVersion: "14",
  serial: "serial",
  connection: "usb",
  status: "online",
  battery: 80,
  temperatureC: 30,
  resolution: { width: 1080, height: 1920 },
  fps: 60,
  bitrateMbps: 8,
  latencyMs: 40,
  host: "local",
  wallpaperHue: 200,
};

describe("connectionProblemLabel", () => {
  it("hints reconnect for offline ADB", () => {
    const label = connectionProblemLabel({ ...base, status: "offline" });
    assert.match(label ?? "", /ADB offline/i);
  });

  it("hints unlock for unauthorized", () => {
    const label = connectionProblemLabel({ ...base, status: "unauthorized" });
    assert.match(label ?? "", /unauthorized/i);
  });

  it("prefers session note on stream error", () => {
    const session: SessionStatus = {
      serial: "serial",
      stream: "error",
      note: "encoder failed",
      backend: "scrcpy",
    };
    assert.equal(connectionProblemLabel(base, session), "encoder failed");
  });
});

describe("offlineOverlayCopy", () => {
  it("offers reconnect when ADB is offline", () => {
    const copy = offlineOverlayCopy({ ...base, status: "offline" });
    assert.equal(copy.showReconnect, true);
    assert.match(copy.title, /ADB offline/i);
  });
});

describe("streamOverlayCopy", () => {
  it("explains stream errors", () => {
    const copy = streamOverlayCopy("error", "boom");
    assert.equal(copy?.title, "Stream error");
    assert.match(copy?.body ?? "", /boom/);
  });
});
