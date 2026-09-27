"use client";

import { cn } from "@/lib/utils";
import type { ControlMode } from "@/lib/devices/types";

interface ControlModesProps {
  mode: ControlMode;
  onChange: (mode: ControlMode) => void;
  selectedCount: number;
  multiCount: number;
  onlineCount: number;
}

const MODES: { id: ControlMode; label: string; hint: string }[] = [
  { id: "selected", label: "Selected", hint: "Active device only" },
  { id: "multi", label: "Multi", hint: "Multi-selected devices" },
  { id: "all", label: "All Devices", hint: "Every online device" },
];

export function ControlModes({
  mode,
  onChange,
  selectedCount,
  multiCount,
  onlineCount,
}: ControlModesProps) {
  const counts: Record<ControlMode, number> = {
    selected: Math.min(selectedCount, 1),
    multi: multiCount,
    all: onlineCount,
  };

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-sm font-semibold tracking-wide text-[var(--pc-ink)]">
          CONTROL
        </h2>
        <p className="font-mono text-[10px] uppercase tracking-wider text-[var(--pc-muted)]">
          Input broadcast
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label="Control mode"
        className="flex flex-col gap-1.5"
      >
        {MODES.map((m) => {
          const active = mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(m.id)}
              className={cn(
                "group flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-all duration-200",
                active
                  ? "border-[var(--pc-accent)] bg-[var(--pc-accent-soft)] shadow-[inset_0_0_0_1px_var(--pc-accent)]"
                  : "border-[var(--pc-line)] bg-[var(--pc-panel)]/60 hover:border-[var(--pc-accent)]/40 hover:bg-[var(--pc-panel)]",
              )}
            >
              <span className="flex items-center gap-2.5">
                <span
                  className={cn(
                    "flex h-3.5 w-3.5 items-center justify-center rounded-full border-2",
                    active
                      ? "border-[var(--pc-accent)]"
                      : "border-[var(--pc-muted)]",
                  )}
                >
                  {active && (
                    <span className="h-1.5 w-1.5 rounded-full bg-[var(--pc-accent)]" />
                  )}
                </span>
                <span>
                  <span
                    className={cn(
                      "block text-sm font-medium",
                      active ? "text-[var(--pc-ink)]" : "text-[var(--pc-muted)]",
                    )}
                  >
                    {m.label}
                  </span>
                  <span className="block text-[11px] text-[var(--pc-muted)]">
                    {m.hint}
                  </span>
                </span>
              </span>
              <span className="font-mono text-xs text-[var(--pc-muted)]">
                {counts[m.id]}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
