"use client";

import { useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDeviceVideo } from "@/hooks/use-device-video";
import { normalizePoint } from "@/lib/devices/coords";
import { devicesClient } from "@/lib/api/client";
import type { Device, PointerPhase, PointerTool } from "@/lib/devices/types";
import { cn } from "@/lib/utils";

interface TouchScreenGridProps {
  devices: Device[];
  activeId: string | null;
  mouseOn: boolean;
  onFocusDevice: (deviceId: string) => void;
}

/** Multi-device grid where each tile accepts touch and injects to that phone. */
export function TouchScreenGrid({
  devices,
  activeId,
  mouseOn,
  onFocusDevice,
}: TouchScreenGridProps) {
  const online = devices.filter((device) => device.status === "online");
  const cols = online.length <= 1 ? 1 : online.length <= 4 ? 2 : 3;

  return (
    <section
      data-touch-screen-grid
      className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2"
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="font-display text-sm font-semibold text-[var(--pc-ink)]">
          Grid
        </h2>
        <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--pc-muted)]">
          {online.length} online · touch each screen
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {online.length === 0 ? (
          <p className="px-1 font-mono text-[10px] uppercase tracking-wider text-[var(--pc-muted)]">
            No online screens
          </p>
        ) : (
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {online.map((device) => (
              <TouchScreenTile
                key={device.id}
                device={device}
                isActive={device.id === activeId}
                mouseOn={mouseOn}
                onFocus={() => onFocusDevice(device.id)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TouchScreenTile({
  device,
  isActive,
  mouseOn,
  onFocus,
}: {
  device: Device;
  isActive: boolean;
  mouseOn: boolean;
  onFocus: () => void;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: number;
    tool: PointerTool;
  } | null>(null);
  const [ripple, setRipple] = useState<{ x: number; y: number; key: number } | null>(
    null,
  );
  const { canvasRef, configured, decodeState, frameSize, frameSizeRef } =
    useDeviceVideo(device.serial);
  const width = frameSize?.width || 9;
  const height = frameSize?.height || 16;
  const live = configured && decodeState === "decoding";
  const offline = device.status !== "online";

  const emit = (phase: PointerPhase, clientX: number, clientY: number, tool: PointerTool) => {
    if (!paneRef.current || offline) return;
    const rect = paneRef.current.getBoundingClientRect();
    const point = normalizePoint(clientX, clientY, rect);
    if (phase === "down") {
      setRipple({ x: point.x * 100, y: point.y * 100, key: Date.now() });
    }
    const size = frameSizeRef.current;
    void devicesClient
      .sendPointer(
        "selected",
        [device],
        phase,
        point,
        size?.width ?? width,
        size?.height ?? height,
        tool,
      )
      .catch(() => {
        // Tile stays interactive; next pointer may succeed.
      });
  };

  return (
    <div
      data-touch-screen-tile={device.id}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-xl border bg-[var(--pc-panel)]",
        isActive ? "border-[var(--pc-accent)]" : "border-[var(--pc-line)]",
      )}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-[var(--pc-line)] px-1.5 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--pc-ink)]">
          {device.name}
        </span>
        <Button
          type="button"
          variant="ghost"
          aria-label={`Focus ${device.name}`}
          className="h-9 min-h-9 w-9 min-w-9 rounded-lg p-0 text-[var(--pc-ink)]"
          onClick={onFocus}
        >
          <Maximize2 className="size-4" />
        </Button>
      </div>
      <div
        ref={paneRef}
        role="application"
        aria-label={`${device.name} screen`}
        data-video-orientation={width >= height ? "landscape" : "portrait"}
        data-video-frame={`${width}x${height}`}
        className={cn(
          "relative min-h-0 w-full flex-1 touch-none select-none overflow-hidden bg-[#101418]",
          mouseOn && !offline ? "cursor-crosshair" : "cursor-default",
        )}
        style={{ aspectRatio: `${width} / ${height}` }}
        onPointerDown={(event) => {
          if (offline || !mouseOn) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const tool: PointerTool = event.pointerType === "touch" ? "finger" : "mouse";
          dragRef.current = { id: event.pointerId, tool };
          emit("down", event.clientX, event.clientY, tool);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.id !== event.pointerId) return;
          emit("move", event.clientX, event.clientY, drag.tool);
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.id !== event.pointerId) return;
          dragRef.current = null;
          emit("up", event.clientX, event.clientY, drag.tool);
        }}
        onPointerCancel={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.id !== event.pointerId) return;
          dragRef.current = null;
          emit("cancel", event.clientX, event.clientY, drag.tool);
        }}
      >
        <div
          className="pointer-events-none absolute inset-0"
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
        {ripple && (
          <span
            key={ripple.key}
            className="pointer-events-none absolute z-10 h-8 w-8 -translate-x-1/2 -translate-y-1/2 animate-pc-ripple rounded-full border-2 border-white/90 bg-white/25"
            style={{ left: `${ripple.x}%`, top: `${ripple.y}%` }}
          />
        )}
        {offline && (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center font-mono text-[10px] text-white/70">
            Offline
          </p>
        )}
      </div>
    </div>
  );
}
