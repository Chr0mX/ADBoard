import { formatResolution } from "@/lib/devices/coords";
import type { Device, SessionStatus, StreamStats } from "@/lib/devices/types";

export function formatBitrate(kbps: number): string {
  if (!(kbps > 0)) return "—";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

export interface StreamStatFields {
  name: string;
  size: string;
  battery: string;
  temperature: string;
  fps: string;
  rate: string;
  codec: string;
  problem: string | null;
}

/** Shared field set for StatusBar, StatsLine, and StatsWidget. */
export function streamStatFields(
  device: Device,
  session?: SessionStatus | null,
  stats?: StreamStats | null,
): StreamStatFields {
  const problem =
    device.status !== "online"
      ? device.status
      : session?.stream === "error"
        ? session.note || "stream error"
        : null;

  const width = stats && stats.width > 0 ? stats.width : device.resolution.width;
  const height = stats && stats.height > 0 ? stats.height : device.resolution.height;

  return {
    name: device.name,
    size: formatResolution(width, height),
    battery: device.battery != null ? `${device.battery}%` : "—",
    temperature:
      device.temperatureC != null ? `${device.temperatureC.toFixed(1)}°C` : "—",
    fps: stats && stats.fps > 0 ? `${Math.round(stats.fps)} fps` : "— fps",
    rate: formatBitrate(stats?.bitrateKbps ?? 0),
    codec: stats?.codec || "h264",
    problem,
  };
}
