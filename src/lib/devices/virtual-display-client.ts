import { agentBaseUrl, agentFetch } from "@/lib/api/auth";
import { NO_AGENT } from "@/lib/events/client";
import type { Device } from "@/lib/devices/types";
import type { VirtualDisplaySpec } from "@/lib/devices/virtual-display";

function base(): string {
  const url = agentBaseUrl();
  if (url === null) throw new Error(`Virtual displays need a phone connected through ADBoard. ${NO_AGENT}`);
  return url;
}

/** The agent answers errors with plain text. */
async function failure(res: Response): Promise<Error> {
  const text = (await res.text().catch(() => "")).trim();
  return new Error(text || `ADBoard said ${res.status}`);
}

export interface VirtualDisplayInfo {
  index: number;
  key: string;
  width: number;
  height: number;
  dpi: number;
  startApp: string | null;
  displayId: number | null;
}

/** The phone's virtual displays and how many it may have. */
export async function listVirtualDisplays(deviceId: string): Promise<{ limit: number; displays: VirtualDisplayInfo[] }> {
  const res = await agentFetch(`${base()}/api/devices/${encodeURIComponent(deviceId)}/virtual-display`, { cache: "no-store" });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as { limit: number; displays: VirtualDisplayInfo[] };
}

/** Create a virtual display on `deviceId` and start streaming it. It then appears in the device list. */
export async function createVirtualDisplay(deviceId: string, spec: VirtualDisplaySpec): Promise<Device> {
  const res = await agentFetch(`${base()}/api/devices/${encodeURIComponent(deviceId)}/virtual-display`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      width: spec.width,
      height: spec.height,
      dpi: spec.dpi,
      startApp: spec.startApp?.trim() || undefined,
      keepContent: spec.keepContent ?? false,
    }),
  });
  if (!res.ok) throw await failure(res);
  return ((await res.json()) as { device: Device }).device;
}

/** Stop a virtual display. The apps on it close with it. */
export async function closeVirtualDisplay(key: string): Promise<void> {
  const res = await agentFetch(`${base()}/api/virtual-display/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (!res.ok) throw await failure(res);
}

/** Start `package/.Activity` on the virtual display. */
export async function launchOnVirtualDisplay(key: string, component: string): Promise<void> {
  const res = await agentFetch(`${base()}/api/virtual-display/${encodeURIComponent(key)}/launch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ component }),
  });
  if (!res.ok) throw await failure(res);
}

export interface VirtualDisplayOverview {
  /** The per-phone limit in force. */
  limit: number;
  /** The limit chosen in Settings, or null when the default applies. */
  saved: number | null;
  /** The default (ADBOARD_MAX_VIRTUAL_DISPLAYS, else 1). */
  envLimit: number;
  /** The highest limit that can be set. */
  ceiling: number;
  displays: Array<VirtualDisplayInfo & { phoneId: string; phoneName: string }>;
}

/** The limit and every virtual display on this computer. */
export async function getVirtualDisplayOverview(): Promise<VirtualDisplayOverview> {
  const res = await agentFetch(`${base()}/api/virtual-display`, { cache: "no-store" });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as VirtualDisplayOverview;
}

/** Set the per-phone limit; null goes back to the default. */
export async function setVirtualDisplayLimit(limit: number | null): Promise<VirtualDisplayOverview> {
  const res = await agentFetch(`${base()}/api/virtual-display`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxPerPhone: limit }),
  });
  if (!res.ok) throw await failure(res);
  return (await res.json()) as VirtualDisplayOverview;
}
