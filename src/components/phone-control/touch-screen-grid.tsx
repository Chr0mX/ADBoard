"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDeviceVideo } from "@/hooks/use-device-video";
import { normalizePoint } from "@/lib/devices/coords";
import { devicesClient } from "@/lib/api/client";
import type { Device, PointerPhase, PointerTool } from "@/lib/devices/types";
import { StatsLine } from "@/components/phone-control/status-bar";
import { PC_HIT_MIN } from "@/lib/ui/control-chrome";
import { cn } from "@/lib/utils";

interface TouchScreenGridProps {
  devices: Device[];
  activeId: string | null;
  mouseOn: boolean;
  onFocusDevice: (deviceId: string) => void;
  /** Desktop uses a larger multi-column layout that fills the main stage. */
  layout?: "mobile" | "desktop";
  onExit?: () => void;
}

interface DesktopPack {
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
}

const GAP = 12;
const PORTRAIT = 9 / 16;
/** Reserved strip under each desktop tile for fps/bitrate/battery. */
const TILE_STATS_H = 22;

/** Pick cols/rows that maximize tile area while keeping phone aspect (no side bars). */
function bestDesktopPack(
  count: number,
  stageW: number,
  stageH: number,
  aspect: number,
): DesktopPack {
  let best: DesktopPack & { area: number } = {
    cols: 1,
    rows: Math.max(1, count),
    tileW: 0,
    tileH: 0,
    area: 0,
  };
  if (!(count > 0 && stageW > 0 && stageH > 0 && aspect > 0)) return best;

  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const cellW = (stageW - GAP * (cols - 1)) / cols;
    const cellH = (stageH - GAP * (rows - 1)) / rows;
    // Leave room under the stream for the per-tile stats line.
    const streamCellH = cellH - TILE_STATS_H;
    if (!(cellW > 1 && streamCellH > 1)) continue;

    let tileW: number;
    let tileH: number;
    if (cellW / streamCellH > aspect) {
      tileH = streamCellH;
      tileW = streamCellH * aspect;
    } else {
      tileW = cellW;
      tileH = cellW / aspect;
    }
    const area = tileW * tileH;
    if (area > best.area) {
      best = {
        cols,
        rows,
        tileW: Math.floor(tileW),
        tileH: Math.floor(tileH),
        area,
      };
    }
  }
  return best;
}

function mobileColumnCount(online: number) {
  if (online <= 1) return 1;
  if (online <= 4) return 2;
  return 3;
}

/** Multi-device grid where each tile accepts pointer input and injects to that phone. */
export function TouchScreenGrid({
  devices,
  activeId,
  mouseOn,
  onFocusDevice,
  layout = "mobile",
  onExit,
}: TouchScreenGridProps) {
  // Show every known device — offline tiles stay visible so nothing disappears.
  const listed = devices;
  const onlineCount = listed.filter((device) => device.status === "online").length;
  const desktop = layout === "desktop";
  const stageRef = useRef<HTMLDivElement>(null);
  const [pack, setPack] = useState<DesktopPack>({
    cols: 1,
    rows: 1,
    tileW: 0,
    tileH: 0,
  });

  useLayoutEffect(() => {
    if (!desktop) return;
    const node = stageRef.current;
    if (!node) return;

    const measure = () => {
      const rect = node.getBoundingClientRect();
      setPack(bestDesktopPack(listed.length, rect.width, rect.height, PORTRAIT));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [desktop, listed.length]);

  const mobileCols = mobileColumnCount(listed.length);

  return (
    <section
      data-touch-screen-grid
      data-touch-screen-layout={layout}
      className="relative flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-2"
    >
      <div className="flex shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="shrink-0 font-display text-sm font-semibold text-[var(--pc-ink)]">
            Rasiel
          </h2>
          <p className="truncate font-mono text-[10px] uppercase tracking-wider text-[var(--pc-muted)]">
            {listed.length} devices · {onlineCount} online · control each screen
          </p>
        </div>
        {onExit && (
          <Button
            type="button"
            variant="outline"
            aria-label="Exit grid view"
            data-grid-exit
            className={cn(PC_HIT_MIN, "h-11 shrink-0 gap-1.5 border-[var(--pc-line)] px-2 text-[var(--pc-ink)]")}
            onClick={onExit}
          >
            <X className="size-3.5" />
            <span className={desktop ? "inline text-xs" : "sr-only"}>Exit</span>
          </Button>
        )}
      </div>
      <div
        ref={stageRef}
        className="min-h-0 flex-1 overflow-auto"
      >
        {listed.length === 0 ? (
          <p className="px-1 font-mono text-[10px] uppercase tracking-wider text-[var(--pc-muted)]">
            No devices
          </p>
        ) : desktop ? (
          <div
            data-touch-screen-cells={pack.cols}
            data-touch-screen-pack={`${pack.tileW}x${pack.tileH}`}
            data-touch-screen-count={listed.length}
            className="grid h-full w-full place-content-center justify-items-center gap-3"
            style={{
              gridTemplateColumns:
                pack.tileW > 0
                  ? `repeat(${pack.cols}, ${pack.tileW}px)`
                  : `repeat(${pack.cols}, max-content)`,
              gridAutoRows: "max-content",
            }}
          >
            {listed.map((device) => (
              <TouchScreenTile
                key={device.id}
                device={device}
                isActive={device.id === activeId}
                mouseOn={mouseOn}
                layout="desktop"
                tileWidth={pack.tileW}
                tileHeight={pack.tileH}
                onFocus={() => onFocusDevice(device.id)}
              />
            ))}
          </div>
        ) : (
          <div
            data-touch-screen-count={listed.length}
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${mobileCols}, minmax(0, 1fr))` }}
          >
            {listed.map((device) => (
              <TouchScreenTile
                key={device.id}
                device={device}
                isActive={device.id === activeId}
                mouseOn={mouseOn}
                layout="mobile"
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
  layout,
  tileWidth,
  tileHeight,
  onFocus,
}: {
  device: Device;
  isActive: boolean;
  mouseOn: boolean;
  layout: "mobile" | "desktop";
  tileWidth?: number;
  tileHeight?: number;
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
  const { canvasRef, configured, decodeState, frameSize, frameSizeRef, stats } =
    useDeviceVideo(device.serial);
  const width = frameSize?.width || 9;
  const height = frameSize?.height || 16;
  const live = configured && decodeState === "decoding";
  const offline = device.status !== "online";
  const desktop = layout === "desktop";

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

  if (desktop) {
    const sized = (tileWidth ?? 0) > 0 && (tileHeight ?? 0) > 0;
    return (
      <div
        data-touch-screen-tile={device.id}
        className="flex w-full flex-col gap-1"
        style={sized ? { width: tileWidth } : undefined}
      >
        <div
          className={cn(
            "relative overflow-hidden rounded-xl border",
            isActive ? "border-[var(--pc-accent)]" : "border-[var(--pc-line)]",
          )}
          style={
            sized
              ? { width: tileWidth, height: tileHeight }
              : { aspectRatio: `${width} / ${height}`, height: "40vh", width: "auto" }
          }
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-7 items-center gap-1 bg-gradient-to-b from-black/70 to-transparent px-1.5">
            <span className="pointer-events-none min-w-0 flex-1 truncate font-mono text-[10px] text-white">
              {device.name}
            </span>
            <Button
              type="button"
              variant="ghost"
              aria-label={`Focus ${device.name}`}
              className="pointer-events-auto h-11 min-h-11 w-11 min-w-11 rounded-xl border border-white/20 bg-black/40 p-0 text-white hover:bg-white/15 hover:text-white"
              onClick={onFocus}
            >
              <Maximize2 className="size-3.5" />
            </Button>
          </div>
          <div
            ref={paneRef}
            role="application"
            aria-label={`${device.name} screen`}
            data-video-orientation={width >= height ? "landscape" : "portrait"}
            data-video-frame={`${width}x${height}`}
            className={cn(
              "absolute inset-0 touch-none select-none overflow-hidden bg-[#101418]",
              mouseOn && !offline ? "cursor-crosshair" : "cursor-default",
            )}
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
        <div
          data-tile-stats={device.id}
          className="min-w-0 overflow-hidden px-0.5"
          style={{ height: TILE_STATS_H }}
        >
          <StatsLine
            device={device}
            stats={stats}
            className="text-[10px] text-[var(--pc-muted)]"
          />
        </div>
      </div>
    );
  }

  return (
    <div
      data-touch-screen-tile={device.id}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-xl border bg-[var(--pc-panel)]",
        isActive ? "border-[var(--pc-accent)]" : "border-[var(--pc-line)]",
      )}
    >
      <div className="flex h-7 shrink-0 items-center gap-1 border-b border-[var(--pc-line)] px-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-[var(--pc-ink)]">
          {device.name}
        </span>
        <Button
          type="button"
          variant="ghost"
          aria-label={`Focus ${device.name}`}
          className="h-11 min-h-11 w-11 min-w-11 rounded-xl p-0 text-[var(--pc-ink)]"
          onClick={onFocus}
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </div>
      <div
        ref={paneRef}
        role="application"
        aria-label={`${device.name} screen`}
        data-video-orientation={width >= height ? "landscape" : "portrait"}
        data-video-frame={`${width}x${height}`}
        className={cn(
          "relative min-h-0 w-full touch-none select-none overflow-hidden bg-[#101418]",
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
      <div data-tile-stats={device.id} className="shrink-0 border-t border-[var(--pc-line)] px-1.5 py-0.5">
        <StatsLine
          device={device}
          stats={stats}
          className="text-[10px] text-[var(--pc-muted)]"
        />
      </div>
    </div>
  );
}
