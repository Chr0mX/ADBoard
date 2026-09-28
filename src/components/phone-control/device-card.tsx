"use client";

import { cn } from "@/lib/utils";
import { formatResolution } from "@/lib/devices/coords";
import type { Device } from "@/lib/devices/types";
import type { SelectionEvent } from "@/hooks/use-phone-control";

interface DeviceCardProps {
  device: Device;
  isActive: boolean;
  isSelected: boolean;
  onSelect: (event: SelectionEvent) => void;
  /** Unused: cards no longer repeat the host line. Kept for callers. */
  showHost?: boolean;
}

function statusLabel(status: Device["status"]) {
  switch (status) {
    case "online":
      return "Online";
    case "unauthorized":
      return "Unauthorized";
    default:
      return "Offline";
  }
}

export function DeviceCard({
  device,
  isActive,
  isSelected,
  onSelect,
}: DeviceCardProps) {
  const offline = device.status !== "online";

  return (
    <button
      type="button"
      onClick={(e) =>
        onSelect({
          deviceId: device.id,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
        })
      }
      className={cn(
        "group relative w-full rounded-xl border px-3 py-2.5 text-left transition-colors",
        "min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-accent)]",
        isActive
          ? "border-[var(--pc-accent)] bg-[var(--pc-panel)]"
          : isSelected
            ? "border-[var(--pc-accent)]/50 bg-[var(--pc-panel)]/90"
            : "border-[var(--pc-line)] bg-[var(--pc-panel)]/55 hover:border-[var(--pc-accent)]/35",
        offline && "opacity-70",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-display text-sm font-semibold text-[var(--pc-ink)]">
              {device.name}
            </span>
            {isSelected && !isActive && (
              <span className="rounded bg-[var(--pc-accent-soft)] px-1 py-0.5 font-mono text-[9px] uppercase text-[var(--pc-accent)]">
                Sel
              </span>
            )}
          </div>
          <p className="truncate text-xs text-[var(--pc-muted)]">
            {device.model}
            {" · "}
            {formatResolution(device.resolution.width, device.resolution.height)}
            {device.battery != null ? ` · ${device.battery}%` : ""}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 font-mono text-[10px] uppercase",
            device.status === "online"
              ? "text-[var(--pc-signal)]"
              : device.status === "unauthorized"
                ? "text-[var(--pc-warn)]"
                : "text-[var(--pc-muted)]",
          )}
        >
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              device.status === "online"
                ? "bg-[var(--pc-signal)]"
                : device.status === "unauthorized"
                  ? "bg-[var(--pc-warn)]"
                  : "bg-[var(--pc-muted)]",
            )}
          />
          {statusLabel(device.status)}
        </span>
      </div>

      {offline && (
        <p className="mt-1.5 text-[11px] text-[var(--pc-warn)]">
          {device.status === "unauthorized"
            ? "Authorize USB debugging on the device."
            : "Device unreachable."}
        </p>
      )}
    </button>
  );
}
