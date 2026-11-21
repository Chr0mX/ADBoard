import type { DeviceStatus } from "@/lib/devices/types";

/*
 * Which phones just lost or regained their ADB connection. Only a change of
 * state gives an alert: polling the same state again, a phone seen for the
 * first time, and the first list after the page opens give none.
 */

export type ConnectionKind = "disconnected" | "connected";

export interface ConnectionAlert {
  /** The device id; one alert per phone, and a newer one replaces its older one. */
  id: string;
  kind: ConnectionKind;
  serial: string;
}

export interface Seen {
  status: DeviceStatus;
  serial: string;
}

export type SeenMap = ReadonlyMap<string, Seen>;

export const ALERT_TEXT: Record<ConnectionKind, { title: string; detail: string }> = {
  disconnected: { title: "Device disconnected", detail: "ADB connection lost" },
  connected: { title: "Device connected", detail: "ADB connection restored" },
};

/** The one-line detail under the title: `{serial} · ADB connection lost`. */
export function alertDetail(alert: ConnectionAlert): string {
  return `${alert.serial} · ${ALERT_TEXT[alert.kind].detail}`;
}

export function diffConnections(
  previous: SeenMap | null,
  devices: ReadonlyArray<{ id: string; serial: string; status: DeviceStatus }>,
): { alerts: ConnectionAlert[]; next: SeenMap } {
  const next = new Map<string, Seen>();
  for (const device of devices) next.set(device.id, { status: device.status, serial: device.serial });
  const alerts: ConnectionAlert[] = [];
  if (previous === null) return { alerts, next };
  for (const [id, now] of next) {
    const before = previous.get(id);
    if (!before) continue;
    if (before.status === "online" && now.status !== "online") alerts.push({ id, kind: "disconnected", serial: now.serial });
    else if (before.status !== "online" && now.status === "online") alerts.push({ id, kind: "connected", serial: now.serial });
  }
  // A phone that dropped out of the list altogether was disconnected too.
  for (const [id, before] of previous) {
    if (before.status === "online" && !next.has(id)) {
      alerts.push({ id, kind: "disconnected", serial: before.serial });
      // Keep it as offline so it can report "connected" when it comes back.
      next.set(id, { status: "offline", serial: before.serial });
    } else if (before.status !== "online" && !next.has(id)) {
      next.set(id, before);
    }
  }
  return { alerts, next };
}
