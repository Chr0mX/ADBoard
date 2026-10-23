"use client";

import { useDeviceVideo } from "@/hooks/use-device-video";
import type { SelectionEvent } from "@/hooks/use-adboard";
import { cn } from "@/lib/utils";
import type { Device } from "@/lib/devices/types";

interface ScreenGridProps {
  devices: Device[];
  activeId: string | null;
  onSelect: (event: SelectionEvent) => void;
  showHeading?: boolean;
}

export function ScreenGrid({
  devices,
  activeId,
  onSelect,
  showHeading = true,
}: ScreenGridProps) {
  const online = devices.filter((device) => device.status === "online");

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2" data-screen-grid>
      {showHeading && (
        <h2 className="font-display text-sm font-semibold tracking-wide text-[var(--pc-ink)]">
          Screens
        </h2>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {online.length === 0 ? (
          <p className="px-1 font-mono text-[11px] uppercase tracking-wider text-[var(--pc-muted)]">
            No online screens
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2 pr-1">
            {online.map((device) => (
              <ScreenTile
                key={device.id}
                device={device}
                isActive={device.id === activeId}
                onSelect={onSelect}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function ScreenTile({
  device,
  isActive,
  onSelect,
}: {
  device: Device;
  isActive: boolean;
  onSelect: (event: SelectionEvent) => void;
}) {
  const { canvasRef, configured, decodeState, frameSize } = useDeviceVideo(device.serial);
  const width = frameSize?.width || 9;
  const height = frameSize?.height || 16;
  const live = configured && decodeState === "decoding";

  return (
    <button
      type="button"
      data-screen-tile={device.id}
      aria-label={`Show ${device.name}`}
      aria-pressed={isActive}
      onClick={(event) =>
        onSelect({
          deviceId: device.id,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
        })
      }
      className={cn(
        "flex min-h-11 flex-col gap-1 rounded-xl border p-1.5 text-left",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-accent)]",
        isActive
          ? "border-[var(--pc-accent)] bg-[var(--pc-panel)]"
          : "border-[var(--pc-line)] bg-[var(--pc-panel)]/70 hover:border-[var(--pc-accent)]/40",
      )}
    >
      <div
        data-video-orientation={width >= height ? "landscape" : "portrait"}
        data-video-frame={`${width}x${height}`}
        className="relative w-full overflow-hidden bg-[#101418]"
        style={{ aspectRatio: `${width} / ${height}` }}
      >
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(165deg, hsl(${device.wallpaperHue} 42% 22%), hsl(${(device.wallpaperHue + 40) % 360} 28% 10%))`,
          }}
        />
        {configured && (
          <canvas
            ref={canvasRef}
            className={cn(
              "pointer-events-none absolute inset-0 h-full w-full object-contain",
              live ? "opacity-100" : "opacity-0",
            )}
          />
        )}
      </div>
      <span className="truncate px-0.5 font-mono text-[11px] text-[var(--pc-ink)]">
        {device.name}
      </span>
    </button>
  );
}
