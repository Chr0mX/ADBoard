"use client";

import { formatResolution } from "@/lib/devices/coords";
import type { Device, SessionStatus } from "@/lib/devices/types";

interface StatusBarProps {
  device: Device | null;
  session?: SessionStatus | null;
}

export function StatusBar({ device, session }: StatusBarProps) {
  if (!device) {
    return (
      <footer className="border-t border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-4 py-2 font-mono text-[11px] text-[var(--pc-muted)] sm:px-6">
        No active device
      </footer>
    );
  }

  const parts = [
    device.name,
    device.host,
    device.connection.toUpperCase(),
    formatResolution(device.resolution.width, device.resolution.height),
    device.fps != null ? `${device.fps} FPS` : "— FPS",
    device.bitrateMbps != null ? `${device.bitrateMbps} Mbps` : "— Mbps",
  ];

  if (device.latencyMs != null) {
    parts.push(`${device.latencyMs} ms`);
  }

  if (device.status !== "online") {
    parts.push(device.status.toUpperCase());
  }

  if (session) {
    parts.push(`stream:${session.stream}`);
    parts.push(session.backend);
  }

  return (
    <footer className="border-t border-[var(--pc-line)] bg-[var(--pc-panel)]/80 px-4 py-2 backdrop-blur-sm sm:px-6">
      <p className="truncate font-mono text-[11px] tracking-wide text-[var(--pc-ink)]">
        {parts.join(" • ")}
      </p>
    </footer>
  );
}
