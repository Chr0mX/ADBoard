"use client";

import { formatResolution } from "@/lib/devices/coords";
import type { Device, SessionStatus, StreamStats } from "@/lib/devices/types";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  device: Device | null;
  session?: SessionStatus | null;
  stats?: StreamStats | null;
  /** Pad for the home indicator when this bar is the bottommost chrome. */
  safeBottom?: boolean;
  /** Tighter padding under the mobile stream dock. */
  compact?: boolean;
  className?: string;
}

function formatRate(kbps: number): string {
  if (!(kbps > 0)) return "—";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

function StatsLine({
  device,
  session,
  stats,
}: {
  device: Device;
  session?: SessionStatus | null;
  stats?: StreamStats | null;
}) {
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
  );
}

export function StatusBar({
  device,
  session,
  stats,
  safeBottom = false,
  compact = false,
  className,
}: StatusBarProps) {
  if (!device) {
    return (
      <footer
        className={cn(
          "shrink-0 border-t border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 font-mono text-[11px] leading-4 text-[var(--pc-muted)]",
          compact ? "py-0.5" : "pt-1",
          safeBottom
            ? "pb-[env(safe-area-inset-bottom,0px)]"
            : compact
              ? "pb-0.5"
              : "pb-1",
          className,
        )}
      >
        No active device
      </footer>
    );
  }

  return (
    <footer
      data-stream-stats
      className={cn(
        "shrink-0 border-t border-[var(--pc-line)] bg-[var(--pc-panel)] px-2",
        compact ? "py-0.5" : "pt-1",
        safeBottom
          ? "pb-[env(safe-area-inset-bottom,0px)]"
          : compact
            ? "pb-0.5"
            : "pb-1",
        className,
      )}
    >
      <StatsLine device={device} session={session} stats={stats} />
    </footer>
  );
}
