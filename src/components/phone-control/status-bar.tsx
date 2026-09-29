"use client";

import { formatResolution } from "@/lib/devices/coords";
import type { Device, SessionStatus, StreamStats } from "@/lib/devices/types";

interface StatusBarProps {
  device: Device | null;
  session?: SessionStatus | null;
  stats?: StreamStats | null;
}

function formatRate(kbps: number): string {
  if (!(kbps > 0)) return "—";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

export function StatusBar({ device, session, stats }: StatusBarProps) {
  if (!device) {
    return (
      <footer className="shrink-0 border-t border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 py-2 font-mono text-[11px] leading-4 text-[var(--pc-muted)]">
        No active device
      </footer>
    );
  }

  const problem =
    device.status !== "online"
      ? device.status
      : session?.stream === "error"
        ? session.note || "stream error"
        : null;

  const width = stats && stats.width > 0 ? stats.width : device.resolution.width;
  const height = stats && stats.height > 0 ? stats.height : device.resolution.height;
  const fps = stats && stats.fps > 0 ? `${Math.round(stats.fps)} fps` : "— fps";
  const rate = formatRate(stats?.bitrateKbps ?? 0);
  const codec = stats?.codec || "h264";
  const battery = device.battery != null ? `${device.battery}%` : "—";
  const temperature = device.temperatureC != null ? `${device.temperatureC.toFixed(1)}°C` : "—";

  return (
    <footer
      data-stream-stats
      className="shrink-0 border-t border-[var(--pc-line)] bg-[var(--pc-panel)]/80 px-3 py-1.5 backdrop-blur-sm"
    >
      <p className="flex items-center gap-x-2 overflow-x-auto whitespace-nowrap font-mono text-[11px] leading-4 text-[var(--pc-ink)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span>{device.name}</span>
        <span>{formatResolution(width, height)}</span>
        <span data-battery>{battery}</span>
        <span data-temperature>{temperature}</span>
        <span>{fps}</span>
        <span>{rate}</span>
        <span>{codec}</span>
        {problem ? <span>{problem}</span> : null}
      </p>
    </footer>
  );
}
