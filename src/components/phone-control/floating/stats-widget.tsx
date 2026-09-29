"use client";

import { useState } from "react";
import { formatResolution } from "@/lib/devices/coords";
import type { Device, SessionStatus, StreamStats } from "@/lib/devices/types";
import { FloatingPanel } from "@/components/phone-control/floating/floating-panel";
import { cn } from "@/lib/utils";

interface StatsWidgetProps {
  device: Device | null;
  session?: SessionStatus | null;
  stats?: StreamStats | null;
}

function formatRate(kbps: number): string {
  if (!(kbps > 0)) return "—";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

export function StatsWidget({ device, session, stats }: StatsWidgetProps) {
  const [expanded, setExpanded] = useState(false);

  if (!device) {
    return (
      <FloatingPanel
        storageKey="pc-float-stats"
        kind="stats"
        defaultSize={{ width: 140, height: 56 }}
        className="min-w-[8rem]"
      >
        <p className="px-1 font-mono text-[11px] text-[var(--pc-muted)]">No device</p>
      </FloatingPanel>
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
    <FloatingPanel
      storageKey="pc-float-stats"
      kind="stats"
      defaultSize={{ width: expanded ? 220 : 180, height: expanded ? 160 : 56 }}
      className={cn("min-w-[10rem]", expanded && "min-w-[12rem]")}
    >
      <button
        type="button"
        data-stream-stats
        data-stats-expanded={expanded ? "1" : "0"}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse stream stats" : "Expand stream stats"}
        className="w-full rounded-lg px-1 text-left active:bg-[var(--pc-accent-soft)]/40"
        onClick={() => setExpanded((value) => !value)}
      >
        {!expanded ? (
          <p className="font-mono text-[11px] leading-4 text-[var(--pc-ink)]">
            {fps} · {rate} · {battery}
          </p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 font-mono text-[11px] leading-4 text-[var(--pc-ink)]">
            <dt className="text-[var(--pc-muted)]">Name</dt>
            <dd className="truncate">{device.name}</dd>
            <dt className="text-[var(--pc-muted)]">Size</dt>
            <dd>{formatResolution(width, height)}</dd>
            <dt className="text-[var(--pc-muted)]">Battery</dt>
            <dd data-battery>{battery}</dd>
            <dt className="text-[var(--pc-muted)]">Temp</dt>
            <dd data-temperature>{temperature}</dd>
            <dt className="text-[var(--pc-muted)]">FPS</dt>
            <dd>{fps}</dd>
            <dt className="text-[var(--pc-muted)]">Rate</dt>
            <dd>{rate}</dd>
            <dt className="text-[var(--pc-muted)]">Codec</dt>
            <dd>{codec}</dd>
            {problem ? (
              <>
                <dt className="text-[var(--pc-muted)]">Note</dt>
                <dd className="text-[var(--pc-warn)]">{problem}</dd>
              </>
            ) : null}
          </dl>
        )}
      </button>
    </FloatingPanel>
  );
}
