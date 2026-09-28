"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatResolution } from "@/lib/devices/coords";
import type { Device } from "@/lib/devices/types";
import type { SelectionEvent } from "@/hooks/use-phone-control";
import { DeviceMenu } from "@/components/phone-control/device-menu";

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
  const [menu, setMenu] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu(true);
      }}
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
        className="block w-full pr-12 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span data-card-name className="min-w-0 break-words font-display text-sm font-semibold leading-5 text-[var(--pc-ink)]">
            {device.name}
          </span>
          {isSelected && !isActive && (
            <span className="shrink-0 rounded bg-[var(--pc-accent-soft)] px-1 py-0.5 font-mono text-[9px] uppercase leading-none text-[var(--pc-accent)]">
              Sel
            </span>
          )}
        </span>
        <span className="mt-1 flex min-w-0 flex-col items-start gap-0.5 text-xs leading-4 text-[var(--pc-muted)]">
          <span
            className={cn(
              "inline-flex items-center gap-1 font-mono text-[10px] uppercase",
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
          <span data-card-model className="max-w-full break-words">
            {device.model}
          </span>
          <span data-card-resolution className="max-w-full break-words font-mono text-[10px]">
            {formatResolution(device.resolution.width, device.resolution.height)}
          </span>
          {(device.battery != null || device.temperatureC != null) && (
            <span className="flex flex-wrap gap-x-2">
              {device.battery != null && (
                <span data-card-battery className="font-mono text-[10px]">
                  {device.battery}%
                </span>
              )}
              {device.temperatureC != null && (
                <span data-card-temperature className="font-mono text-[10px]">
                  {device.temperatureC.toFixed(1)}°C
                </span>
              )}
            </span>
          )}
        </span>
      </button>
      <button
        ref={menuButtonRef}
        type="button"
        aria-label={`Actions for ${device.name}`}
        aria-haspopup="menu"
        aria-expanded={menu}
        className="absolute right-1 top-1 flex h-11 w-11 items-center justify-center rounded-lg text-lg leading-none text-[var(--pc-muted)] hover:bg-[var(--pc-accent-soft)]"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setMenu((open) => !open);
        }}
      >
        ⋯
      </button>
      {menu && (
        <DeviceMenu
          device={device}
          anchor={menuButtonRef.current}
          onClose={() => setMenu(false)}
        />
      )}

      {offline && (
        <p className="mt-1.5 text-[11px] text-[var(--pc-warn)]">
          {device.status === "unauthorized"
            ? "Authorize USB debugging on the device."
            : "Device unreachable."}
        </p>
      )}
    </div>
  );
}
