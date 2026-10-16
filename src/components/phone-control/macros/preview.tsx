"use client";

import { useState } from "react";
import {
  fromNormalized,
  placement,
  toNormalized,
  type MacroTab,
  type Size,
} from "@/lib/macro/core";
import { cn } from "@/lib/utils";
import { stepColor } from "@/components/phone-control/macros/fields";

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
  selectedStepId,
  placing,
  onSelectStep,
  onMoveFinger,
  onPlace,
}: {
  tab: MacroTab;
  frame: Size | null;
  frameLabel: string;
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
                    className={cn(
                      "absolute flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none",
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
                        end === "end" ? "size-5 border-2 bg-transparent text-[9px]" : "size-7 text-[11px] text-[#071016]",
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
      <p className="text-center font-mono text-[10px] text-[var(--pc-muted)]">
        {frameLabel} · {screen.width}×{screen.height}
        {device && tab.scale === "fit" && (box.width < 1 || box.height < 1) ? " · keep aspect (dashed = macro area)" : ""}
      </p>
    </div>
  );
}
