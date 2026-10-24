"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsUp, LayoutGrid, Maximize2, Minus, Plus, SlidersHorizontal, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDeviceVideo } from "@/hooks/use-device-video";
import { normalizePoint } from "@/lib/devices/coords";
import { devicesClient } from "@/lib/api/client";
import type { ControlMode, Device, NavAction, PointerPhase, PointerTool } from "@/lib/devices/types";
import { ControlModes } from "@/components/adboard/control-modes";
import { StatsLine } from "@/components/adboard/status-bar";
import { useStoredString } from "@/hooks/use-stored-flag";
import {
  GRID_LAYOUT_MAX,
  clampPage,
  fixedPack,
  formatGridLayout,
  pageCount,
  pageSlice,
  parseGridLayout,
} from "@/lib/ui/grid-layout";
import { cn } from "@/lib/utils";
import { CheckboxVisual } from "@/components/ui/checkbox";
import { FLOAT_RECLAMP_EVENT } from "@/components/adboard/floating/floating-panel";
import { OPEN_ARRANGEMENT_EVENT, takeArrangementRequest } from "@/components/adboard/device-actions";

interface TouchScreenGridProps {
  devices: Device[];
  activeId: string | null;
  mouseOn: boolean;
  onFocusDevice: (deviceId: string) => void;
  /** Desktop uses a larger multi-column layout that fills the main stage. */
  layout?: "mobile" | "desktop";
  /** Hide the app name when the desk header above already shows it. */
  showTitle?: boolean;
  onExit?: () => void;
  /** Who receives touches: the touched phone, the checked phones, or all. */
  controlMode?: ControlMode;
  onControlModeChange?: (mode: ControlMode) => void;
  selectedIds?: Set<string>;
  onToggleSelected?: (deviceId: string, selected: boolean) => void;
  /** Online phones for the current mode (from useADBoard). */
  broadcastTargets?: Device[];
  /** Desktop grid: Back / Home / Recent to the current targets. */
  onNav?: (action: NavAction["type"]) => void;
  /** Cursor mode: send tile pointers as a mouse. */
  cursorMode?: boolean;
  /** Macros panel toggle (Control mode). */
  macrosOpen?: boolean;
  onToggleMacros?: () => void;
}

interface DesktopPack {
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
}

const GAP = 12;
const PORTRAIT = 9 / 16;
/** Footer under each desktop tile: Include, name, stats, Focus (kept off the picture). */
const TILE_STATS_H = 40;

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
  showTitle = true,
  onExit,
  controlMode = "selected",
  onControlModeChange,
  selectedIds,
  onToggleSelected,
  broadcastTargets = [],
  onNav,
  macrosOpen = false,
  onToggleMacros,
  cursorMode = false,
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

  // Auto, or a fixed columns × rows chosen in the header (saved per browser).
  const [storedLayout, setStoredLayout] = useStoredString("adboard-grid-layout");
  const gridLayout = parseGridLayout(storedLayout);
  const layoutKey = formatGridLayout(gridLayout);
  const fixed = gridLayout.mode === "fixed" ? gridLayout : null;
  const perPage = fixed ? fixed.cols * fixed.rows : Math.max(1, listed.length);
  const pages = pageCount(listed.length, perPage);
  const [pageState, setPage] = useState(0);
  const page = clampPage(pageState, listed.length, perPage);
  const visible = fixed ? pageSlice(listed, page, perPage) : listed;
  // A short last page or few phones should not shrink tiles into empty rows.
  const fixedRows = fixed ? Math.min(fixed.rows, Math.ceil(Math.min(listed.length, perPage) / fixed.cols)) : 0;

  useLayoutEffect(() => {
    if (!desktop) return;
    const node = stageRef.current;
    if (!node) return;

    const measure = () => {
      const rect = node.getBoundingClientRect();
      setPack(
        fixed
          ? fixedPack(fixed.cols, Math.max(1, fixedRows), rect.width, rect.height, PORTRAIT, GAP, TILE_STATS_H)
          : bestDesktopPack(listed.length, rect.width, rect.height, PORTRAIT),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
    // layoutKey covers fixed.cols / fixed.rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, listed.length, layoutKey, fixedRows]);

  const mobileCols = fixed ? fixed.cols : mobileColumnCount(listed.length);

  // One slim bar; layout lives in a popover, and the bar can be hidden.
  const [storedBar, setStoredBar] = useStoredString("adboard-grid-bar");
  const barHidden = storedBar === "hidden";
  // Bar buttons: 44px on desktop, 36px on phones (unified .pc-toggle sizes).
  const barBtn = cn("pc-toggle", desktop ? "pc-toggle-md" : "pc-toggle-sm");
  // Opened from here, or by Tools → Arrangement (possibly before the grid mounted).
  const [optionsOpen, setOptionsOpen] = useState(() => (typeof window === "undefined" ? false : takeArrangementRequest()));
  useEffect(() => {
    const open = () => {
      if (!takeArrangementRequest()) return;
      setStoredBar("shown");
      setOptionsOpen(true);
    };
    window.addEventListener(OPEN_ARRANGEMENT_EVENT, open);
    return () => window.removeEventListener(OPEN_ARRANGEMENT_EVENT, open);
  }, [setStoredBar]);
  // Floating Tools / Stats step out of the way of the bar and the strip.
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event(FLOAT_RECLAMP_EVENT)));
    return () => cancelAnimationFrame(id);
  }, [optionsOpen, barHidden, desktop]);
  useEffect(() => {
    if (!optionsOpen) return;
    // In-flow strip: it never covers tiles, so only Esc / ✕ / the button close it.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOptionsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [optionsOpen]);

  const setLayout = (cols: number, rows: number) => {
    setStoredLayout(formatGridLayout({ mode: "fixed", cols, rows }));
    setPage(0);
  };
  const step = (axis: "cols" | "rows", delta: number) => {
    const base = fixed ?? { cols: desktop ? pack.cols : mobileCols, rows: desktop ? pack.rows : Math.ceil(listed.length / mobileCols) };
    const next = { cols: base.cols, rows: base.rows };
    next[axis] = Math.min(GRID_LAYOUT_MAX, Math.max(1, next[axis] + delta));
    setLayout(next.cols, next.rows);
  };

  const groupMode = controlMode === "all" || controlMode === "multi";
  const targetIds = new Set(broadcastTargets.map((d) => d.id));
  const included = (device: Device) =>
    device.status === "online" &&
    (controlMode === "all" ? true : (selectedIds?.has(device.id) ?? false));
  const toggleInclude = (device: Device) => {
    if (!onToggleSelected) return;
    if (controlMode === "all") {
      // "All but this one": check every other online phone, then drop this one.
      for (const other of listed) {
        if (other.status === "online" && other.id !== device.id) onToggleSelected(other.id, true);
      }
      onToggleSelected(device.id, false);
      onControlModeChange?.("multi");
      return;
    }
    onToggleSelected(device.id, !included(device));
  };
  const touchNote = groupMode
    ? broadcastTargets.length === 0
      ? "No phones checked — tick Include on a tile"
      : `Touch on a highlighted tile goes to ${broadcastTargets.length} phone${broadcastTargets.length === 1 ? "" : "s"}`
    : "Touch goes to the phone you touch";
  const tileProps = (device: Device) => ({
    device,
    isActive: device.id === activeId,
    inTargets: groupMode && targetIds.has(device.id),
    included: included(device),
    canToggle: Boolean(onToggleSelected),
    onToggleInclude: () => toggleInclude(device),
    sendTo: groupMode && targetIds.has(device.id)
      ? { mode: controlMode, targets: broadcastTargets }
      : { mode: "selected" as ControlMode, targets: [device] },
    mouseOn,
    cursorMode,
    onFocus: () => onFocusDevice(device.id),
  });

  return (
    <section
      data-touch-screen-grid
      data-touch-screen-layout={layout}
      className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-2"
    >
      {barHidden ? (
        <button
          type="button"
          data-grid-show-bar
          aria-label="Show grid controls"
          title="Show grid controls"
          onClick={() => setStoredBar("shown")}
          className="group absolute right-0 top-0 z-20 inline-flex size-8 min-h-8 items-center justify-center gap-1.5 overflow-hidden rounded-full border border-[var(--pc-line)] bg-[var(--pc-panel)]/90 text-xs text-[var(--pc-ink)] opacity-70 shadow-lg backdrop-blur transition-[width,opacity] hover:w-auto hover:px-3 hover:opacity-100 hover:bg-[var(--pc-accent-soft)] focus-visible:w-auto focus-visible:px-3 focus-visible:opacity-100"
        >
          <SlidersHorizontal className="size-3.5 shrink-0" />
          <span className="hidden whitespace-nowrap group-hover:inline group-focus-visible:inline">Controls</span>
        </button>
      ) : (
        <div
          data-grid-bar
          data-grid-bar-size={desktop ? "md" : "sm"}
          className={cn(
            "flex min-w-0 shrink-0 items-center border-b border-[var(--pc-line)] pb-2",
            // Phone: modes on their own full-width row, actions on a second
            // compact row. Desktop: one 44px row.
            desktop ? "gap-2" : "flex-wrap gap-1.5 sm:flex-nowrap",
          )}
        >
          {showTitle && (
            <h2 className="hidden shrink-0 font-display text-sm font-semibold text-[var(--pc-ink)] xl:block">
              ADBoard
            </h2>
          )}
          <p
 className="hidden shrink-0 whitespace-nowrap font-mono text-[11px] tracking-wider text-[var(--pc-muted)] xl:block"
            title={`${listed.length} devices · ${onlineCount} online`}
          >
            {onlineCount}/{listed.length} online
          </p>
          {onControlModeChange && (
            <div
              className={cn("flex min-w-0 items-center gap-2", desktop ? "shrink" : "w-full sm:w-auto sm:shrink")}
              data-grid-targets
              title={touchNote}
            >
              <ControlModes
                compact
                size={desktop ? "md" : "sm"}
                stretch={!desktop}
                mode={controlMode}
                onChange={onControlModeChange}
                selectedCount={activeId ? 1 : 0}
                multiCount={selectedIds?.size ?? 0}
                onlineCount={onlineCount}
              />
              {onNav && (
                <div className="flex shrink-0 items-center gap-1" data-grid-nav>
                  {(
                    [
                      ["back", "Back"],
                      ["home", "Home"],
                      ["recent", "Recent"],
                    ] as const
                  ).map(([action, label]) => (
                    <button
                      key={action}
                      type="button"
                      aria-label={`${label} on target phones`}
                      onClick={() => onNav(action)}
                      className={barBtn}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <p
 className="hidden min-w-0 truncate font-mono text-[11px] tracking-wider text-[var(--pc-muted)] 2xl:block"
                data-grid-touch-note
              >
                {touchNote}
              </p>
            </div>
          )}
          <div
            data-grid-actions
            className={cn(
              "flex min-w-0 items-center gap-1.5",
              // Phone: the action row spans the full width (labelled buttons grow).
              desktop ? "ml-auto shrink-0" : "w-full sm:ml-auto sm:w-auto sm:shrink-0",
            )}
          >
            {fixed && pages > 1 && (
              <div className="flex items-center gap-1" data-grid-page={`${page + 1}/${pages}`}>
                <button
                  type="button"
                  aria-label="Previous page"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                  className={cn(barBtn, "pc-toggle-icon")}
                >
                  <ChevronLeft className="size-4" />
                </button>
                <span className="whitespace-nowrap font-mono text-[11px] text-[var(--pc-ink)]" aria-label={`Page ${page + 1} of ${pages}`}>
                  {page + 1}/{pages}
                </span>
                <button
                  type="button"
                  aria-label="Next page"
                  disabled={page >= pages - 1}
                  onClick={() => setPage(page + 1)}
                  className={cn(barBtn, "pc-toggle-icon")}
                >
                  <ChevronRight className="size-4" />
                </button>
              </div>
            )}
            <div
              role="group"
              aria-label="Arrangement"
              data-grid-layout={layoutKey}
              className={cn("relative", !desktop && "min-w-0 flex-1 sm:flex-none")}
            >
              <button
                type="button"
                aria-expanded={optionsOpen}
                aria-controls="pc-grid-options"
                aria-label="Arrangement options"
                title="Arrangement: how many phones per row and column"
                data-grid-options-toggle
                onClick={() => setOptionsOpen((open) => !open)}
                className={cn(barBtn, !desktop && "w-full sm:w-auto")}
              >
                <LayoutGrid className="size-3.5" />
                <span>Arrangement</span>
                {fixed && (
                  <span className="rounded-md bg-[var(--pc-accent-soft)] px-1 text-[11px] text-[var(--pc-accent)]" data-grid-arrangement-value>
                    {fixed.cols}×{fixed.rows}
                  </span>
                )}
              </button>
            </div>
            {onToggleMacros && (
              <button
                type="button"
                aria-pressed={macrosOpen}
                aria-label={macrosOpen ? "Hide macro" : "Macro"}
                data-grid-macros
                onClick={onToggleMacros}
                className={cn(barBtn, !desktop && "min-w-0 flex-1 sm:flex-none")}
              >
                <Zap className="size-3.5" />
                <span data-macro-label>Macro</span>
              </button>
            )}
            <button
              type="button"
              aria-label="Hide grid controls"
              data-grid-hide-bar
              onClick={() => {
                setOptionsOpen(false);
                setStoredBar("hidden");
              }}
              className={cn(barBtn, "pc-toggle-icon")}
            >
              <ChevronsUp className="size-4" />
            </button>
            {onExit && (
              <Button
                type="button"
                variant="outline"
                aria-label="Exit grid view"
                data-grid-exit
                className={cn(barBtn, !desktop && "pc-toggle-icon")}
                onClick={onExit}
              >
                <X className="size-3.5" />
                <span className={desktop ? "inline" : "sr-only"}>Exit</span>
              </Button>
            )}
          </div>
        </div>
      )}
      {!barHidden && optionsOpen && (
        <div
          id="pc-grid-options"
          data-grid-options
          role="group"
          aria-label="Arrangement options"
          className="flex shrink-0 flex-wrap items-center gap-2 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/80 px-3 py-1.5"
        >
 <span className="font-mono text-[11px] tracking-wider text-[var(--pc-muted)]">Arrangement</span>
          <button
            type="button"
            aria-pressed={!fixed}
            data-grid-auto
            title="Automatic arrangement: fit every phone on screen"
            onClick={() => {
              setStoredLayout("auto");
              setPage(0);
            }}
            className={barBtn}
          >
            Fit all
          </button>
          <Stepper
            small={!desktop}
            label="Columns"
            value={fixed ? fixed.cols : desktop ? pack.cols : mobileCols}
            dim={!fixed}
            onStep={(delta) => step("cols", delta)}
          />
          <span aria-hidden className="font-mono text-xs text-[var(--pc-muted)]">×</span>
          <Stepper
            small={!desktop}
            label="Rows"
            value={fixed ? fixed.rows : desktop ? pack.rows : Math.ceil(listed.length / mobileCols)}
            dim={!fixed}
            onStep={(delta) => step("rows", delta)}
          />
          <p className="hidden min-w-0 flex-1 truncate text-[11px] text-[var(--pc-muted)] lg:block">
            More phones than cells adds pages (‹ › in the bar).
          </p>
          <button
            type="button"
            aria-label="Close arrangement options"
            data-grid-options-close
            onClick={() => setOptionsOpen(false)}
            className={cn(barBtn, "pc-toggle-icon ml-auto")}
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      <div
        ref={stageRef}
        // Keep tiles out from under the corner chip while the bar is hidden.
        className={cn("min-h-0 flex-1 overflow-auto", barHidden && "mr-7")}
      >
        {listed.length === 0 ? (
 <p className="px-1 font-mono text-[11px] tracking-wider text-[var(--pc-muted)]">
            No devices
          </p>
        ) : desktop ? (
          <div
            data-touch-screen-cells={pack.cols}
            data-touch-screen-pack={`${pack.tileW}x${pack.tileH}`}
            data-touch-screen-count={visible.length}
            className="grid h-full w-full place-content-center justify-items-center gap-3"
            style={{
              gridTemplateColumns:
                pack.tileW > 0
                  ? `repeat(${pack.cols}, ${pack.tileW}px)`
                  : `repeat(${pack.cols}, max-content)`,
              gridAutoRows: "max-content",
            }}
          >
            {visible.map((device) => (
              <TouchScreenTile
                key={device.id}
                {...tileProps(device)}
                layout="desktop"
                tileWidth={pack.tileW}
                tileHeight={pack.tileH}
              />
            ))}
          </div>
        ) : (
          <div
            data-touch-screen-count={visible.length}
            className="grid gap-2"
            style={{ gridTemplateColumns: `repeat(${mobileCols}, minmax(0, 1fr))` }}
          >
            {visible.map((device) => (
              <TouchScreenTile
                key={device.id}
                {...tileProps(device)}
                layout="mobile"
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}


function Stepper({
  label,
  value,
  dim,
  onStep,
  small = false,
}: {
  small?: boolean;
  label: string;
  value: number;
  /** Auto mode: shows the automatic value; stepping switches to fixed. */
  dim: boolean;
  onStep: (delta: number) => void;
}) {
  return (
    <div className="flex items-center gap-0.5" data-grid-stepper={label.toLowerCase()}>
      <button
        type="button"
        aria-label={`Fewer ${label.toLowerCase()}`}
        disabled={value <= 1}
        onClick={() => onStep(-1)}
        className={cn("pc-toggle pc-toggle-icon", small ? "pc-toggle-sm" : "pc-toggle-md")}
      >
        <Minus className="size-3.5" />
      </button>
      <span
        className={cn(
          "min-w-[3.25rem] text-center font-mono text-[11px] leading-tight",
          dim ? "text-[var(--pc-muted)]" : "text-[var(--pc-ink)]",
        )}
        aria-live="polite"
      >
 <span className="block text-[11px] tracking-wider text-[var(--pc-muted)]">{label}</span>
        <span data-grid-value>{value}</span>
      </span>
      <button
        type="button"
        aria-label={`More ${label.toLowerCase()}`}
        disabled={value >= GRID_LAYOUT_MAX}
        onClick={() => onStep(1)}
        className={cn("pc-toggle pc-toggle-icon", small ? "pc-toggle-sm" : "pc-toggle-md")}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

/** Per-tile checkbox: include this phone in the group that receives touches. */
function IncludeToggle({
  name,
  included,
  disabled,
  onToggle,
  compact = false,
}: {
  name: string;
  included: boolean;
  disabled: boolean;
  onToggle: () => void;
  /** Desktop tile footer: the 36px toggle size. */
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={`Include ${name}`}
      aria-pressed={included}
      data-grid-include={name}
      disabled={disabled}
      onClick={onToggle}
      className={cn("pc-toggle pc-toggle-icon", compact ? "pc-toggle-sm" : "pc-toggle-md")}
    >
      <CheckboxVisual checked={included} />
    </button>
  );
}

function TouchScreenTile({
  device,
  isActive,
  inTargets,
  included,
  canToggle,
  onToggleInclude,
  sendTo,
  mouseOn,
  cursorMode = false,
  layout,
  tileWidth,
  tileHeight,
  onFocus,
}: {
  device: Device;
  isActive: boolean;
  /** Part of the group that receives this tile's touches. */
  inTargets: boolean;
  included: boolean;
  canToggle: boolean;
  onToggleInclude: () => void;
  sendTo: { mode: ControlMode; targets: Device[] };
  mouseOn: boolean;
  cursorMode?: boolean;
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
        sendTo.mode,
        sendTo.targets,
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
            isActive || inTargets ? "border-[var(--pc-accent)]" : "border-[var(--pc-line)]",
            inTargets && "ring-2 ring-[var(--pc-accent)]/40",
          )}
          style={
            sized
              ? { width: tileWidth, height: tileHeight }
              : { aspectRatio: `${width} / ${height}`, height: "40vh", width: "auto" }
          }
        >
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
              const tool: PointerTool = cursorMode || event.pointerType !== "touch" ? "mouse" : "finger";
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
              <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-2 text-center font-mono text-[11px] text-white/70">
                {device.status === "unauthorized" ? "Unauthorized" : "ADB offline"}
              </p>
            )}
          </div>
        </div>
        {/* Controls live under the picture so nothing covers the phone's screen. */}
        <div
          data-tile-footer={device.id}
          className="flex min-w-0 items-center gap-1.5 px-0.5"
          style={{ height: TILE_STATS_H - 4 }}
        >
          {canToggle && (
            <IncludeToggle
              name={device.name}
              included={included}
              disabled={offline}
              onToggle={onToggleInclude}
              compact
            />
          )}
          <span className="shrink-0 truncate font-mono text-[11px] font-semibold text-[var(--pc-ink)]" style={{ maxWidth: "40%" }}>
            {device.name}
          </span>
          <div data-tile-stats={device.id} className="min-w-0 flex-1 overflow-hidden">
            <StatsLine device={device} stats={stats} className="truncate text-[11px] text-[var(--pc-muted)]" />
          </div>
          <Button
            type="button"
            variant="ghost"
            aria-label={`Focus ${device.name}`}
            title={`Open ${device.name}`}
            className="pc-toggle pc-toggle-sm pc-toggle-icon"
            onClick={onFocus}
          >
            <Maximize2 className="size-3.5" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-touch-screen-tile={device.id}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-xl border bg-[var(--pc-panel)]",
        isActive || inTargets ? "border-[var(--pc-accent)]" : "border-[var(--pc-line)]",
            inTargets && "ring-2 ring-[var(--pc-accent)]/40",
      )}
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--pc-line)] px-1">
        <span className="min-w-0 flex-1 truncate px-0.5 font-mono text-[11px] text-[var(--pc-ink)]">
          {device.name}
        </span>
        {canToggle && (
          <IncludeToggle
            name={device.name}
            included={included}
            disabled={offline}
            onToggle={onToggleInclude}
            compact
          />
        )}
        <Button
          type="button"
          variant="ghost"
          aria-label={`Focus ${device.name}`}
          className="pc-toggle pc-toggle-sm pc-toggle-icon"
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
          const tool: PointerTool = cursorMode || event.pointerType !== "touch" ? "mouse" : "finger";
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
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-2 text-center font-mono text-[11px] text-white/70">
            {device.status === "unauthorized" ? "Unauthorized" : "ADB offline"}
          </p>
        )}
      </div>
      <div data-tile-stats={device.id} className="shrink-0 border-t border-[var(--pc-line)] px-1.5 py-0.5">
        <StatsLine
          device={device}
          stats={stats}
          className="text-[11px] text-[var(--pc-muted)]"
        />
      </div>
    </div>
  );
}
