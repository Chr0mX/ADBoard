import type { Device, MappedTap, NormalizedPoint } from "./types";

/** Normalize click inside the displayed phone pane to 0–1. */
export function normalizePoint(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): NormalizedPoint {
  const x = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const y = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
  return { x, y };
}

/** Map normalized coords onto each target device's native resolution. */
export function mapToDevices(
  point: NormalizedPoint,
  targets: Device[],
): MappedTap[] {
  return targets.map((device) => ({
    deviceId: device.id,
    deviceName: device.name,
    x: Math.round(point.x * device.resolution.width),
    y: Math.round(point.y * device.resolution.height),
    width: device.resolution.width,
    height: device.resolution.height,
  }));
}

export function formatResolution(width: number, height: number): string {
  return `${width}×${height}`;
}
