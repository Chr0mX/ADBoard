"use client";

import { useState } from "react";
import {
  fromNormalized,
  orientationMismatch,
  orientationOf,
  placement,
  toNormalized,
  type MacroTab,
  type Size,
} from "@/lib/macro/core";
import { cn } from "@/lib/utils";
import { useDeviceVideo } from "@/hooks/use-device-video";
import { useMacroTouches, type MacroTouch } from "@/lib/macro/runs";
import type { Device } from "@/lib/devices/types";
import { stepColor } from "@/components/adboard/macros/fields";

export type FingerEnd = "start" | "end";

/**
 * The tab's touches drawn on a screen of `frame` size — the reference screen,
 * or a phone's, scaled the way the run will scale them. Markers can be dragged
 * (or nudged with arrow keys) to adjust positions before running.
 */
export function MacroPreview({
  tab,
  frame,
  frameLabel,
  backdrop,
  badge,
  ripples,
  readOnly = false,
  selectedStepId,
  placing,
  onSelectStep,
  onMoveFinger,
  onPlace,
}: {
  tab: MacroTab;
  frame: Size | null;
  frameLabel: string;
  /** Drawn under the markers, e.g. the phone's live video. */
  backdrop?: React.ReactNode;
  /** Top-left status chip, e.g. Live. */
  badge?: React.ReactNode;
  /** Recent macro touches, 0–1 of this screen. */
  ripples?: MacroTouch[];
  /** Show markers only (Control dock); no dragging. */
  readOnly?: boolean;
  selectedStepId: string | null;
  placing: boolean;
  onSelectStep: (stepId: string) => void;
  onMoveFinger: (stepId: string, fingerId: string, end: FingerEnd, point: { x: number; y: number }) => void;
  onPlace: (point: { x: number; y: number }) => void;
}) {
  // State, not refs: the element and drag are only read in event handlers.
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ pointerId: number; stepId: string; fingerId: string; end: FingerEnd } | null>(null);
  const screen = frame ?? tab.reference;
  const device = frame;
  const box = placement(tab.reference, device, tab.scale);

  const toReference = (clientX: number, clientY: number) => {
    const rect = boxEl?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    const n = { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
    return fromNormalized(n, tab.reference, device, tab.scale);
  };

  const pos = (x: number, y: number) => {
    const n = toNormalized({ x, y }, tab.reference, device, tab.scale);
    return { left: `${n.x * 100}%`, top: `${n.y * 100}%`, nx: n.x, ny: n.y };
  };

  const aspect = screen.width / screen.height;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className="relative mx-auto w-full"
        style={{ maxWidth: `min(100%, calc(min(62vh, 640px) * ${aspect}))` }}
      >
        <div
          ref={setBoxEl}
          data-macro-preview
          role="group"
          aria-label={`Touch preview on ${frameLabel}`}
          className={cn(
            "relative w-full touch-none select-none overflow-hidden rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-frame)]",
            placing && "cursor-crosshair ring-2 ring-[var(--pc-accent)]/60",
          )}
          style={{ aspectRatio: `${screen.width} / ${screen.height}` }}
          onPointerDown={(event) => {
            if (!placing || event.target !== event.currentTarget) return;
            const point = toReference(event.clientX, event.clientY);
            if (point) onPlace(point);
          }}
        >
          {backdrop}
          {/* Reference screen area (letterboxed in keep-aspect mode). */}
          <div
            aria-hidden
            className="pointer-events-none absolute rounded-md"
            style={{
              left: `${box.left * 100}%`,
              top: `${box.top * 100}%`,
              width: `${box.width * 100}%`,
              height: `${box.height * 100}%`,
              backgroundImage:
                "linear-gradient(to right, color-mix(in srgb, var(--pc-ink) 7%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--pc-ink) 7%, transparent) 1px, transparent 1px)",
              backgroundSize: "10% 10%",
              outline: box.width < 1 || box.height < 1 ? "1px dashed var(--pc-line)" : undefined,
            }}
          />
          <svg
            aria-hidden
            className="pointer-events-none absolute inset-0 size-full"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
          >
            {tab.steps.map((step, index) =>
              step.fingers.map((finger) => {
                if (finger.toX === undefined || finger.toY === undefined) return null;
                const a = pos(finger.x, finger.y);
                const b = pos(finger.toX, finger.toY);
                const selected = step.id === selectedStepId;
                return (
                  <line
                    key={`${step.id}-${finger.id}`}
                    x1={a.nx}
                    y1={a.ny}
                    x2={b.nx}
                    y2={b.ny}
                    stroke={stepColor(index)}
                    strokeWidth={selected ? 3 : 2}
                    strokeOpacity={selected ? 0.95 : 0.35}
                    strokeDasharray={step.enabled ? undefined : "6 4"}
                    vectorEffect="non-scaling-stroke"
                  />
                );
              }),
            )}
          </svg>
          <TouchRipples touches={ripples ?? []} />
          {badge && <div className="pointer-events-none absolute left-2 top-2 z-30">{badge}</div>}
          {tab.steps.map((step, index) =>
            step.fingers.map((finger, fingerIndex) => {
              const selected = step.id === selectedStepId;
              const label = `${index + 1}${step.fingers.length > 1 ? String.fromCharCode(97 + fingerIndex) : ""}`;
              const ends: FingerEnd[] = finger.toX !== undefined && finger.toY !== undefined ? ["start", "end"] : ["start"];
              return ends.map((end) => {
                const x = end === "start" ? finger.x : (finger.toX as number);
                const y = end === "start" ? finger.y : (finger.toY as number);
                const p = pos(x, y);
                const name = `Step ${index + 1}${step.fingers.length > 1 ? ` finger ${fingerIndex + 1}` : ""}${end === "end" ? " swipe end" : ""}`;
                return (
                  <button
                    key={`${step.id}-${finger.id}-${end}`}
                    type="button"
                    data-macro-marker={label + (end === "end" ? "→" : "")}
                    aria-label={`${name} at ${x}, ${y}. Drag or use arrow keys to move.`}
                    aria-pressed={selected}
                    tabIndex={readOnly ? -1 : undefined}
                    aria-hidden={readOnly || undefined}
                    className={cn(
                      "absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none",
                      readOnly && "pointer-events-none",
                      selected ? "z-20" : "z-10",
                    )}
                    style={{ left: p.left, top: p.top }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setDrag({ pointerId: event.pointerId, stepId: step.id, fingerId: finger.id, end });
                      onSelectStep(step.id);
                    }}
                    onPointerMove={(event) => {
                      const d = drag;
                      if (!d || d.pointerId !== event.pointerId) return;
                      const point = toReference(event.clientX, event.clientY);
                      if (point) onMoveFinger(d.stepId, d.fingerId, d.end, point);
                    }}
                    onPointerUp={(event) => {
                      if (drag?.pointerId === event.pointerId) setDrag(null);
                    }}
                    onPointerCancel={() => setDrag(null)}
                    onKeyDown={(event) => {
                      const delta = event.shiftKey ? 10 : 1;
                      const moves: Record<string, [number, number]> = {
                        ArrowLeft: [-delta, 0],
                        ArrowRight: [delta, 0],
                        ArrowUp: [0, -delta],
                        ArrowDown: [0, delta],
                      };
                      const move = moves[event.key];
                      if (!move) return;
                      event.preventDefault();
                      onSelectStep(step.id);
                      onMoveFinger(step.id, finger.id, end, {
                        x: Math.min(tab.reference.width, Math.max(0, x + move[0])),
                        y: Math.min(tab.reference.height, Math.max(0, y + move[1])),
                      });
                    }}
                  >
                    <span
                      className={cn(
                        "flex items-center justify-center rounded-full font-mono font-bold shadow-[0_0_0_2px_rgba(0,0,0,0.55)] transition-transform",
                        end === "end" ? "size-5 border-2 bg-transparent text-[11px]" : "size-7 text-[11px] text-[#071016]",
                        selected ? "scale-110" : "opacity-55",
                        !step.enabled && "opacity-30",
                      )}
                      style={
                        end === "end"
                          ? { borderColor: stepColor(index), color: stepColor(index) }
                          : { backgroundColor: stepColor(index) }
                      }
                    >
                      {end === "end" ? "" : label}
                    </span>
                  </button>
                );
              });
            }),
          )}
          {tab.steps.length === 0 && !placing && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-[var(--pc-muted)]">
              No touches yet. Turn on “Click to add” or add a step.
            </p>
          )}
        </div>
      </div>
      <p className="text-center font-mono text-[11px] text-[var(--pc-muted)]">
        {frameLabel} · {screen.width}×{screen.height}
        {device && tab.scale === "fit" && (box.width < 1 || box.height < 1) ? " · keep aspect (dashed = macro area)" : ""}
      </p>
    </div>
  );
}

/** Fading rings where a macro just touched (points are 0–1 of the screen). */
export function TouchRipples({ touches }: { touches: MacroTouch[] }) {
  if (touches.length === 0) return null;
  return (
    <div aria-hidden data-macro-ripples={touches.length} className="pointer-events-none absolute inset-0 z-[6] overflow-hidden">
      {touches.flatMap((touch) =>
        touch.points.map((p, i) => (
          <span key={`${touch.id}-${i}`} className="pc-ripple" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} />
        )),
      )}
    </div>
  );
}

/**
 * A phone's live screen for previews: its video as a backdrop, the frame size
 * (the real, rotation-aware video size when streaming, else the reported
 * resolution) and a status badge. Shared by the Macros and Shell Automation
 * previews so both show the screen the same way.
 */
export function useLiveScreen(device: Device, live: boolean) {
  const { canvasRef, configured, decodeState, frameSize } = useDeviceVideo(live ? device.serial : null);
  const frame: Size = (live && frameSize) || device.resolution;
  const playing = live && configured && decodeState === "decoding";
  const state = !configured
    ? { key: "off", text: "No video (mock UI)" }
    : decodeState === "decoding"
      ? { key: "live", text: "Live" }
      : decodeState === "error" || decodeState === "unsupported"
        ? { key: "unavailable", text: "Video unavailable" }
        : decodeState === "waiting"
          ? { key: "waiting", text: "Waiting for picture…" }
          : { key: "connecting", text: "Connecting…" };
  const badge = live ? (
    <span
      data-macro-live={state.key}
      className={cn(
 "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wider",
        playing ? "bg-[var(--pc-signal)] text-[#04140c]" : "bg-[var(--pc-panel)]/90 text-[var(--pc-muted)]",
      )}
    >
      {playing && <span className="size-1.5 animate-pulse rounded-full bg-[#04140c]" />}
      {state.text}
    </span>
  ) : null;
  const backdrop =
    live && configured ? (
      <canvas
        ref={canvasRef}
        data-macro-live-canvas
        className={cn(
          "pointer-events-none absolute inset-0 h-full w-full object-contain transition-opacity",
          playing ? "opacity-100" : "opacity-0",
        )}
      />
    ) : null;
  return { frame, streaming: Boolean(live && frameSize), badge, backdrop };
}

/**
 * The preview on a phone's live screen: its video under the markers, sized
 * by the real (rotation-aware) video frame, with ripples while a macro runs.
 */
export function LivePreview({
  device,
  live,
  ...rest
}: {
  device: Device;
  live: boolean;
} & Omit<Parameters<typeof MacroPreview>[0], "frame" | "frameLabel" | "backdrop" | "badge" | "ripples">) {
  const { frame, streaming, badge, backdrop } = useLiveScreen(device, live);
  const touches = useMacroTouches(device.id);
  const mismatch = rest.tab.orientation === "match" && orientationMismatch(rest.tab.reference, frame);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {mismatch && (
        <p className="rounded-lg bg-[var(--pc-warn-soft)] px-2 py-1.5 text-xs text-[var(--pc-warn)]">
          {device.name} is {orientationOf(frame)} right now and this tab is {orientationOf(rest.tab.reference)}; runs skip it unless “Run anyway” is set.
        </p>
      )}
      <MacroPreview
        {...rest}
        frame={frame}
        frameLabel={`${device.name}${streaming ? " · live" : ""}`}
        badge={badge}
        ripples={touches}
        backdrop={backdrop}
      />
    </div>
  );
}
