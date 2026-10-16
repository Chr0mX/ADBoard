"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { ArrowDown, ArrowUp, Copy, Hand, MousePointerClick, Move, Play, Plus, Trash2, X } from "lucide-react";
import {
  MAX_DELAY_MS,
  MAX_FINGERS,
  MAX_STEPS,
  MAX_TOUCH_MS,
  MIN_TOUCH_MS,
  cloneStep,
  newFinger,
  newStep,
  stepKind,
  stepTouchMs,
  type MacroFinger,
  type MacroStep,
  type MacroTab,
  type StepKind,
} from "@/lib/macro/core";
import { cn } from "@/lib/utils";
import { GhostButton, IconButton, NumField, formatMs, stepColor } from "@/components/phone-control/macros/fields";

const KIND_LABEL: Record<StepKind, string> = {
  tap: "Tap",
  hold: "Hold",
  swipe: "Swipe",
  multi: "Multi-touch",
};

export type NewStepKind = "tap" | "hold" | "swipe" | "multi" | "pinch";

/** A new step centered on the reference screen. */
export function makeStep(kind: NewStepKind, tab: MacroTab, at?: { x: number; y: number }): MacroStep {
  const { width: w, height: h } = tab.reference;
  const cx = at?.x ?? Math.round(w / 2);
  const cy = at?.y ?? Math.round(h / 2);
  const clampX = (v: number) => Math.min(w, Math.max(0, Math.round(v)));
  const clampY = (v: number) => Math.min(h, Math.max(0, Math.round(v)));
  switch (kind) {
    case "hold":
      return newStep([newFinger(cx, cy, { durationMs: 800 })], { delayMs: 300 });
    case "swipe":
      return newStep([newFinger(cx, clampY(cy + h * 0.2), { toX: cx, toY: clampY(cy - h * 0.2), durationMs: 300 })], { delayMs: 300 });
    case "multi":
      return newStep(
        [newFinger(clampX(cx - w * 0.15), cy, { durationMs: 100 }), newFinger(clampX(cx + w * 0.15), cy, { durationMs: 100 })],
        { delayMs: 300 },
      );
    case "pinch":
      return newStep(
        [
          newFinger(clampX(cx - w * 0.05), cy, { toX: clampX(cx - w * 0.3), toY: cy, durationMs: 400 }),
          newFinger(clampX(cx + w * 0.05), cy, { toX: clampX(cx + w * 0.3), toY: cy, durationMs: 400 }),
        ],
        { delayMs: 300 },
      );
    default:
      return newStep([newFinger(cx, cy, { durationMs: 50 })], { delayMs: 300 });
  }
}

function summary(step: MacroStep) {
  return step.fingers
    .map((f) =>
      f.toX !== undefined && f.toY !== undefined ? `${f.x},${f.y} → ${f.toX},${f.toY}` : `${f.x},${f.y}`,
    )
    .join("  +  ");
}

export function AddStepBar({ disabled, onAdd }: { disabled?: boolean; onAdd: (kind: NewStepKind) => void }) {
  const items: Array<{ kind: NewStepKind; label: string; icon: React.ReactNode }> = [
    { kind: "tap", label: "Tap", icon: <MousePointerClick className="size-3.5" aria-hidden /> },
    { kind: "hold", label: "Hold", icon: <Hand className="size-3.5" aria-hidden /> },
    { kind: "swipe", label: "Swipe", icon: <Move className="size-3.5" aria-hidden /> },
    { kind: "multi", label: "2-finger tap", icon: <Plus className="size-3.5" aria-hidden /> },
    { kind: "pinch", label: "Pinch", icon: <Plus className="size-3.5" aria-hidden /> },
  ];
  return (
    <div className="flex flex-wrap gap-1.5" data-macro-add>
      {items.map((item) => (
        <GhostButton key={item.kind} disabled={disabled} onClick={() => onAdd(item.kind)} data-add-step={item.kind}>
          {item.icon}
          {item.label}
        </GhostButton>
      ))}
    </div>
  );
}

export function StepList({
  tab,
  selectedStepId,
  canTest,
  onSelect,
  onChange,
  onTest,
}: {
  tab: MacroTab;
  selectedStepId: string | null;
  canTest: boolean;
  onSelect: (stepId: string | null) => void;
  onChange: (steps: MacroStep[]) => void;
  onTest: (stepId: string) => void;
}) {
  const steps = tab.steps;
  const patchStep = (id: string, change: (step: MacroStep) => MacroStep) =>
    onChange(steps.map((s) => (s.id === id ? change(s) : s)));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  if (steps.length === 0) {
    return <p className="rounded-xl border border-dashed border-[var(--pc-line)] p-4 text-center text-xs text-[var(--pc-muted)]">No steps yet.</p>;
  }

  return (
    <ol className="flex flex-col gap-1.5" data-macro-steps>
      {steps.map((step, index) => {
        const selected = step.id === selectedStepId;
        const kind = stepKind(step);
        return (
          <li
            key={step.id}
            data-macro-step={index + 1}
            className={cn(
              "rounded-xl border bg-[var(--pc-paper)]",
              selected ? "border-[var(--pc-accent)]" : "border-[var(--pc-line)]",
              !step.enabled && "opacity-60",
            )}
          >
            <div className="flex items-center gap-1 p-1">
              <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center" title={step.enabled ? "Skip this step" : "Play this step"}>
                <Checkbox
                  aria-label={`Step ${index + 1} enabled`}
                  checked={step.enabled}
                  onChange={() => patchStep(step.id, (s) => ({ ...s, enabled: !s.enabled }))}
                />
              </label>
              <button
                type="button"
                aria-expanded={selected}
                onClick={() => onSelect(selected ? null : step.id)}
                className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left"
              >
                <span
                  className="flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold text-[#071016]"
                  style={{ backgroundColor: stepColor(index) }}
                >
                  {index + 1}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--pc-ink)]">
                    {step.label || KIND_LABEL[kind]}
                    {kind === "multi" && (
                      <span className="rounded bg-[var(--pc-accent-soft)] px-1 font-mono text-[9px] text-[var(--pc-accent)]">
                        {step.fingers.length} fingers
                      </span>
                    )}
                  </span>
                  <span className="truncate font-mono text-[10px] text-[var(--pc-muted)]">
                    {summary(step)} · {formatMs(stepTouchMs(step))} · wait {formatMs(step.delayMs)}
                  </span>
                </span>
              </button>
              <IconButton label={`Test step ${index + 1}`} disabled={!canTest} onClick={() => onTest(step.id)} tone="accent">
                <Play className="size-4" aria-hidden />
              </IconButton>
              <div className="hidden items-center sm:flex">
                <IconButton label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                  <ArrowUp className="size-4" aria-hidden />
                </IconButton>
                <IconButton label={`Move step ${index + 1} down`} disabled={index === steps.length - 1} onClick={() => move(index, 1)}>
                  <ArrowDown className="size-4" aria-hidden />
                </IconButton>
                <IconButton
                  label={`Duplicate step ${index + 1}`}
                  disabled={steps.length >= MAX_STEPS}
                  onClick={() => {
                    const copy = cloneStep(step);
                    onChange([...steps.slice(0, index + 1), copy, ...steps.slice(index + 1)]);
                    onSelect(copy.id);
                  }}
                >
                  <Copy className="size-4" aria-hidden />
                </IconButton>
              </div>
              <IconButton
                label={`Delete step ${index + 1}`}
                tone="danger"
                onClick={() => {
                  onChange(steps.filter((s) => s.id !== step.id));
                  if (selected) onSelect(null);
                }}
              >
                <Trash2 className="size-4" aria-hidden />
              </IconButton>
            </div>
            {selected && (
              <StepEditor
                step={step}
                index={index}
                tab={tab}
                onChange={(next) => patchStep(step.id, () => next)}
                onMove={(delta) => move(index, delta)}
                onDuplicate={() => {
                  const copy = cloneStep(step);
                  onChange([...steps.slice(0, index + 1), copy, ...steps.slice(index + 1)]);
                  onSelect(copy.id);
                }}
                isFirst={index === 0}
                isLast={index === steps.length - 1}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepEditor({
  step,
  index,
  tab,
  onChange,
  onMove,
  onDuplicate,
  isFirst,
  isLast,
}: {
  step: MacroStep;
  index: number;
  tab: MacroTab;
  onChange: (step: MacroStep) => void;
  onMove: (delta: number) => void;
  onDuplicate: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const total = Math.max(stepTouchMs(step), 1);
  const patchFinger = (id: string, patch: Partial<MacroFinger>) =>
    onChange({ ...step, fingers: step.fingers.map((f) => (f.id === id ? { ...f, ...patch } : f)) });
  const { width: w, height: h } = tab.reference;

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--pc-line)] p-2" data-step-editor>
      <div className="grid grid-cols-[minmax(0,1fr)_7.5rem] gap-2">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
          Name
          <input
            value={step.label}
            maxLength={80}
            placeholder={KIND_LABEL[stepKind(step)]}
            onChange={(event) => onChange({ ...step, label: event.target.value })}
            className="h-11 min-h-11 min-w-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-xs text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]"
          />
        </label>
        <NumField
          label="Then wait"
          suffix="ms"
          value={step.delayMs}
          min={0}
          max={MAX_DELAY_MS}
          onChange={(delayMs) => onChange({ ...step, delayMs })}
          data-step-delay
        />
      </div>

      <div className="flex flex-col gap-2">
        {step.fingers.map((finger, fingerIndex) => {
          const swipe = finger.toX !== undefined && finger.toY !== undefined;
          return (
            <fieldset
              key={finger.id}
              data-finger={fingerIndex + 1}
              className="flex flex-col gap-2 rounded-xl border border-[var(--pc-line)] p-2"
            >
              <legend className="flex w-full items-center gap-2 px-1 text-xs text-[var(--pc-ink)]">
                <span className="font-medium">
                  {step.fingers.length > 1 ? `Finger ${fingerIndex + 1}` : "Touch"}
                </span>
                <label className="ml-auto flex min-h-11 cursor-pointer items-center gap-2 text-[var(--pc-muted)]">
                  Swipe
                  <Switch
                    checked={swipe}
                    aria-label={`Finger ${fingerIndex + 1} swipes`}
                    onChange={() =>
                      patchFinger(
                        finger.id,
                        swipe
                          ? { toX: undefined, toY: undefined }
                          : {
                              toX: finger.x,
                              toY: Math.max(0, Math.round(finger.y - h * 0.2)),
                              durationMs: Math.max(finger.durationMs, 200),
                            },
                      )
                    }
                  />
                </label>
                {step.fingers.length > 1 && (
                  <IconButton
                    label={`Remove finger ${fingerIndex + 1}`}
                    tone="danger"
                    onClick={() => onChange({ ...step, fingers: step.fingers.filter((f) => f.id !== finger.id) })}
                  >
                    <X className="size-4" aria-hidden />
                  </IconButton>
                )}
              </legend>
              <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
                <NumField compact label="X" value={finger.x} min={0} max={w} onChange={(x) => patchFinger(finger.id, { x })} />
                <NumField compact label="Y" value={finger.y} min={0} max={h} onChange={(y) => patchFinger(finger.id, { y })} />
                {swipe && (
                  <>
                    <NumField compact label="To X" value={finger.toX ?? 0} min={0} max={w} onChange={(toX) => patchFinger(finger.id, { toX })} />
                    <NumField compact label="To Y" value={finger.toY ?? 0} min={0} max={h} onChange={(toY) => patchFinger(finger.id, { toY })} />
                  </>
                )}
                {step.fingers.length > 1 && (
                  <NumField
                    compact
                    label="Starts after"
                    suffix="ms"
                    value={finger.startMs}
                    min={0}
                    max={MAX_TOUCH_MS}
                    onChange={(startMs) => patchFinger(finger.id, { startMs })}
                  />
                )}
                <NumField
                  compact
                  label={swipe ? "Swipe time" : "Press time"}
                  suffix="ms"
                  value={finger.durationMs}
                  min={MIN_TOUCH_MS}
                  max={MAX_TOUCH_MS}
                  onChange={(durationMs) => patchFinger(finger.id, { durationMs })}
                />
              </div>
            </fieldset>
          );
        })}
      </div>

      {step.fingers.length > 1 && (
        <div aria-label="Finger timeline" className="flex flex-col gap-1 rounded-xl bg-[var(--pc-panel)] p-2">
          {step.fingers.map((finger, fingerIndex) => (
            <div key={finger.id} className="flex items-center gap-2">
              <span className="w-5 font-mono text-[10px] text-[var(--pc-muted)]">{String.fromCharCode(97 + fingerIndex)}</span>
              <div className="relative h-2.5 flex-1 rounded-full bg-[var(--pc-line)]">
                <div
                  className="absolute h-full rounded-full"
                  style={{
                    left: `${(finger.startMs / total) * 100}%`,
                    width: `${(Math.max(MIN_TOUCH_MS, finger.durationMs) / total) * 100}%`,
                    backgroundColor: stepColor(index),
                  }}
                />
              </div>
            </div>
          ))}
          <span className="text-right font-mono text-[10px] text-[var(--pc-muted)]">{formatMs(total)} with fingers down</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <GhostButton
          disabled={step.fingers.length >= MAX_FINGERS}
          onClick={() => {
            const last = step.fingers[step.fingers.length - 1];
            const x = Math.min(w, (last?.x ?? w / 2) + Math.round(w * 0.1));
            onChange({
              ...step,
              fingers: [...step.fingers, newFinger(x, last?.y ?? h / 2, { durationMs: last?.durationMs ?? 100, startMs: last?.startMs ?? 0 })],
            });
          }}
          data-add-finger
        >
          <Plus className="size-3.5" aria-hidden />
          Add finger ({step.fingers.length}/{MAX_FINGERS})
        </GhostButton>
        <span className="ml-auto flex items-center sm:hidden">
          <IconButton label="Move step up" disabled={isFirst} onClick={() => onMove(-1)}>
            <ArrowUp className="size-4" aria-hidden />
          </IconButton>
          <IconButton label="Move step down" disabled={isLast} onClick={() => onMove(1)}>
            <ArrowDown className="size-4" aria-hidden />
          </IconButton>
          <IconButton label="Duplicate step" onClick={onDuplicate}>
            <Copy className="size-4" aria-hidden />
          </IconButton>
        </span>
      </div>
    </div>
  );
}
