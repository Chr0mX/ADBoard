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
      <footer className="border-t border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 py-1 font-mono text-[11px] text-[var(--pc-muted)]">
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

  return (
    <footer className="border-t border-[var(--pc-line)] bg-[var(--pc-panel)]/80 px-3 py-1 backdrop-blur-sm">
      <p className="truncate font-mono text-[11px] text-[var(--pc-ink)]">
        {device.name}
        {" · "}
        {formatResolution(device.resolution.width, device.resolution.height)}
        {problem ? ` · ${problem}` : ""}
      </p>
    </footer>
  );
}
