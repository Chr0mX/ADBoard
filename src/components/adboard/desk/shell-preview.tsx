"use client";

import { useState } from "react";
import { touchGeometry } from "@/lib/desk/actions";
import type { MacroStep } from "@/lib/desk/store";
import type { Device } from "@/lib/devices/types";
import { cn } from "@/lib/utils";
import { useLiveScreen } from "@/components/adboard/macros/preview";
import { stepColor } from "@/components/adboard/macros/fields";

export type PointEnd = "start" | "end";

/** Percent of the screen, one decimal (what step X/Y fields hold). */
const toPercent = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 10;

/**
 * The job's touch steps drawn on a phone's live screen. Positions are the
 * steps' own X/Y percentages of the screen, which is exactly what the runner
 * sends (0–1 of the phone's screen), so a marker sits where the touch lands.
 * The frame keeps the phone's aspect ratio (the live video size when
 * streaming, which follows rotation).
 */
export function ShellPreview({
  device,
  live,
  steps,
  selectedStepId,
  placing,
  runningStepId,
  onSelectStep,
  onMovePoint,
}: {
  device: Device;
  live: boolean;
  steps: MacroStep[];
  selectedStepId: string | null;
  /** Clicking the screen sets this end of the selected step. */
  placing: PointEnd | null;
  runningStepId?: string | null;
  onSelectStep: (stepId: string) => void;
  onMovePoint: (stepId: string, end: PointEnd, point: { x: number; y: number }) => void;
}) {
  const { frame, streaming, badge, backdrop } = useLiveScreen(device, live);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ pointerId: number; stepId: string; end: PointEnd } | null>(null);
  const known = frame.width > 0 && frame.height > 0;
  const aspect = known ? frame.width / frame.height : 9 / 19.5;

  const toScreen = (clientX: number, clientY: number) => {
    const rect = box?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return { x: toPercent((clientX - rect.left) / rect.width), y: toPercent((clientY - rect.top) / rect.height) };
  };

  const touchSteps = steps
    .map((step, index) => ({ step, index, geometry: touchGeometry(step) }))
    .filter((item): item is { step: MacroStep; index: number; geometry: NonNullable<ReturnType<typeof touchGeometry>> } => item.geometry !== null);

  return (
    <div className="flex min-w-0 flex-col gap-2" data-shell-preview={device.id}>
      <div className="relative mx-auto w-full" style={{ maxWidth: `min(100%, calc(min(62vh, 640px) * ${aspect}))` }}>
        <div
          ref={setBox}
          role="group"
          aria-label={`Touch positions on ${device.name}`}
          data-shell-preview-screen
          className={cn(
            "relative w-full touch-none select-none overflow-hidden rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-frame)]",
            placing && "cursor-crosshair ring-2 ring-[var(--pc-accent)]/60",
          )}
          style={{ aspectRatio: `${known ? frame.width : 9} / ${known ? frame.height : 19.5}` }}
          onPointerDown={(event) => {
            if (!placing || !selectedStepId || event.target !== event.currentTarget) return;
            const point = toScreen(event.clientX, event.clientY);
            if (point) onMovePoint(selectedStepId, placing, point);
          }}
        >
          {backdrop}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                "linear-gradient(to right, color-mix(in srgb, var(--pc-ink) 7%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--pc-ink) 7%, transparent) 1px, transparent 1px)",
              backgroundSize: "10% 10%",
            }}
          />
          <svg aria-hidden className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 1 1" preserveAspectRatio="none">
            {touchSteps.map(({ step, index, geometry }) => {
              const selected = step.id === selectedStepId;
              const lines = [
                geometry.end ? [geometry.start, geometry.end] : null,
                geometry.start2 && geometry.end2 ? [geometry.start2, geometry.end2] : null,
              ].filter((line): line is NonNullable<typeof line> => line !== null);
              return lines.map(([a, b], n) => (
                <line
                  key={`${step.id}-${n}`}
                  data-shell-path={index + 1}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={stepColor(index)}
                  strokeWidth={selected ? 3 : 2}
                  strokeOpacity={selected ? 0.95 : 0.4}
                  strokeDasharray={step.enabled === false ? "6 4" : undefined}
                  vectorEffect="non-scaling-stroke"
                />
              ));
            })}
          </svg>
          {badge && <div className="pointer-events-none absolute left-2 top-2 z-30">{badge}</div>}
          {touchSteps.map(({ step, index, geometry }) => {
            const selected = step.id === selectedStepId;
            const running = step.id === runningStepId;
            // Pinch is set by its centre (the step's X/Y); its finger paths are drawn only.
            const ends: Array<{ end: PointEnd; at: { x: number; y: number } }> =
              step.kind === "pinch"
                ? [{ end: "start", at: { x: (step.x ?? 50) / 100, y: (step.y ?? 50) / 100 } }]
                : [{ end: "start", at: geometry.start }, ...(geometry.end && (step.kind === "swipe" || step.kind === "drag") ? [{ end: "end" as const, at: geometry.end }] : [])];
            return ends.map(({ end, at }) => (
              <button
                key={`${step.id}-${end}`}
                type="button"
                data-shell-marker={`${index + 1}${end === "end" ? "→" : ""}`}
                data-x={toPercent(at.x)}
                data-y={toPercent(at.y)}
                aria-label={`Step ${index + 1} ${end === "end" ? "end" : "position"} at ${toPercent(at.x)}%, ${toPercent(at.y)}%. Drag or use arrow keys to move.`}
                aria-pressed={selected}
                className={cn("absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none", selected ? "z-20" : "z-10")}
                style={{ left: `${at.x * 100}%`, top: `${at.y * 100}%` }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  setDrag({ pointerId: event.pointerId, stepId: step.id, end });
                  onSelectStep(step.id);
                }}
                onPointerMove={(event) => {
                  if (!drag || drag.pointerId !== event.pointerId) return;
                  const point = toScreen(event.clientX, event.clientY);
                  if (point) onMovePoint(drag.stepId, drag.end, point);
                }}
                onPointerUp={(event) => {
                  if (drag?.pointerId === event.pointerId) setDrag(null);
                }}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(event) => {
                  const delta = event.shiftKey ? 5 : 0.5;
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
                  onMovePoint(step.id, end, {
                    x: Math.min(100, Math.max(0, toPercent(at.x) + move[0])),
                    y: Math.min(100, Math.max(0, toPercent(at.y) + move[1])),
                  });
                }}
              >
                <span
                  className={cn(
                    "flex items-center justify-center rounded-full font-mono font-bold shadow-[0_0_0_2px_rgba(0,0,0,0.55)] transition-transform",
                    end === "end" ? "size-5 border-2 bg-transparent text-[11px]" : "size-7 text-[11px] text-[#071016]",
                    selected ? "scale-110" : "opacity-60",
                    step.enabled === false && "opacity-30",
                    running && "animate-pulse ring-2 ring-white",
                  )}
                  style={end === "end" ? { borderColor: stepColor(index), color: stepColor(index) } : { backgroundColor: stepColor(index) }}
                >
                  {end === "end" ? "" : index + 1}
                </span>
              </button>
            ));
          })}
          {touchSteps.length === 0 && (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center text-xs text-[var(--pc-muted)]">
              No touch steps yet. Tap, swipe and other Input Actions show here where they land.
            </p>
          )}
        </div>
      </div>
      <p className="text-center font-mono text-[11px] text-[var(--pc-muted)]">
        {device.name}
        {streaming ? " · live" : ""} · {known ? `${frame.width}×${frame.height}` : "screen size unknown"}
      </p>
    </div>
  );
}
