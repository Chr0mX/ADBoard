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
  /** Show host chip when the grid is not already grouped by host. */
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
  showHost = true,
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
        "group relative w-full rounded-xl border p-3 text-left transition-all duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-accent)]",
        isActive
          ? "border-[var(--pc-accent)] bg-[var(--pc-panel)] shadow-[0_8px_28px_-12px_rgba(13,90,92,0.45)]"
          : isSelected
            ? "border-[var(--pc-accent)]/50 bg-[var(--pc-panel)]/90"
            : "border-[var(--pc-line)] bg-[var(--pc-panel)]/55 hover:border-[var(--pc-accent)]/35 hover:bg-[var(--pc-panel)]/80",
        offline && "opacity-70",
      )}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-display text-base font-semibold text-[var(--pc-ink)]">
              {device.name}
            </span>
            {isSelected && (
              <span className="rounded bg-[var(--pc-accent-soft)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--pc-accent)]">
                Sel
              </span>
            )}
            {isActive && (
              <span className="rounded bg-[var(--pc-ink)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-[var(--pc-paper)]">
                Active
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-[var(--pc-muted)]">
            {device.model} · Android {device.androidVersion}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide",
            device.status === "online"
              ? "bg-[var(--pc-signal-soft)] text-[var(--pc-signal)]"
              : device.status === "unauthorized"
                ? "bg-[var(--pc-warn-soft)] text-[var(--pc-warn)]"
                : "bg-black/5 text-[var(--pc-muted)]",
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

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[10px] text-[var(--pc-muted)]">
        <div>
          <dt className="opacity-70">Serial</dt>
          <dd className="truncate text-[var(--pc-ink)]">{device.serial}</dd>
        </div>
        <div>
          <dt className="opacity-70">Link</dt>
          <dd className="uppercase text-[var(--pc-ink)]">{device.connection}</dd>
        </div>
        <div>
          <dt className="opacity-70">Battery</dt>
          <dd className="text-[var(--pc-ink)]">
            {device.battery != null ? `${device.battery}%` : "—"}
          </dd>
        </div>
        <div>
          <dt className="opacity-70">Temp</dt>
          <dd className="text-[var(--pc-ink)]">
            {device.temperatureC != null ? `${device.temperatureC.toFixed(1)}°C` : "—"}
          </dd>
        </div>
        <div>
          <dt className="opacity-70">Resolution</dt>
          <dd className="text-[var(--pc-ink)]">
            {formatResolution(device.resolution.width, device.resolution.height)}
          </dd>
        </div>
        <div>
          <dt className="opacity-70">FPS / Latency</dt>
          <dd className="text-[var(--pc-ink)]">
            {device.fps != null ? `${device.fps}` : "—"}
            {" · "}
            {device.latencyMs != null ? `${device.latencyMs} ms` : "—"}
          </dd>
        </div>
        {showHost && (
          <div className="col-span-2">
            <dt className="opacity-70">Host</dt>
            <dd className="truncate text-[var(--pc-ink)]">{device.host}</dd>
          </div>
        )}
      </dl>

      {offline && (
        <p className="mt-2 border-t border-[var(--pc-line)] pt-2 text-[11px] text-[var(--pc-warn)]">
          {device.status === "unauthorized"
            ? "Authorize USB debugging on the device."
            : "No mock session — device unreachable."}
        </p>
      )}
    </button>
  );
}
