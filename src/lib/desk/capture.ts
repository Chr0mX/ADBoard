import { devicesClient } from "@/lib/api/client";
import { saveBlob } from "@/lib/api/download";
import type { Device, DeviceOpResult } from "@/lib/devices/types";

export type CaptureRow = {
  deviceId: string;
  deviceName: string;
  state: "ok" | "error";
  detail: string;
};

function rowsFromResults(results: DeviceOpResult[]): CaptureRow[] {
  return results.map((result) => ({
    deviceId: result.deviceId,
    deviceName: result.deviceName,
    state: result.ok ? "ok" : "error",
    detail: result.ok ? result.output || "Saved" : result.error || "Failed",
  }));
}

/** Screenshot selected devices and trigger browser downloads for each host file. */
export async function downloadScreenshots(devices: Device[]): Promise<CaptureRow[]> {
  if (devices.length === 0) {
    return [{ deviceId: "shot", deviceName: "Screenshot", state: "error", detail: "No devices" }];
  }
  const response = await devicesClient.runCommand(devices, "screenshot");
  const rows = rowsFromResults(response.results);
  for (const result of response.results) {
    if (!result.ok || !result.output) continue;
    // Authenticated fetch: the API token stays out of URLs (proxy logs).
    saveBlob(await devicesClient.fetchHostFile(result.output), `${result.deviceName || result.deviceId}.png`);
  }
  return rows;
}

/** Start screenrecord on device with Manage-panel defaults (720p, 8 Mbps, /sdcard/Movies). */
export async function startScreenRecords(devices: Device[]): Promise<CaptureRow[]> {
  if (devices.length === 0) {
    return [{ deviceId: "rec", deviceName: "Record", state: "error", detail: "No devices" }];
  }
  const response = await devicesClient.runCommand(
    devices,
    "recordStart",
    "8000000",
    "1280x720|/sdcard/Movies",
  );
  return rowsFromResults(response.results).map((row) =>
    row.state === "ok"
      ? { ...row, detail: row.detail || "Recording on device (/sdcard/Movies)" }
      : row,
  );
}

export async function stopScreenRecords(devices: Device[]): Promise<CaptureRow[]> {
  if (devices.length === 0) {
    return [{ deviceId: "rec", deviceName: "Record", state: "error", detail: "No devices" }];
  }
  const response = await devicesClient.runCommand(devices, "recordStop");
  return rowsFromResults(response.results).map((row) =>
    row.state === "ok"
      ? { ...row, detail: "Stopped — file stays on the phone under /sdcard/Movies" }
      : row,
  );
}
