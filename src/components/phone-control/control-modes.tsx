"use client";

import { cn } from "@/lib/utils";
import type { ControlMode } from "@/lib/devices/types";

interface ControlModesProps {
  mode: ControlMode;
  onChange: (mode: ControlMode) => void;
  selectedCount: number;
  multiCount: number;
  onlineCount: number;
  /** One inline row (grid header) instead of the 3-column panel block. */
  compact?: boolean;
}

const MODES: { id: ControlMode; label: string }[] = [
  { id: "selected", label: "Selected" },
  { id: "multi", label: "Multi" },
  { id: "all", label: "All" },
];

export function ControlModes({
  mode,
  onChange,
  selectedCount,
  multiCount,
  onlineCount,
  compact = false,
}: ControlModesProps) {
  const counts: Record<ControlMode, number> = {
    selected: Math.min(selectedCount, 1),
    multi: multiCount,
    all: onlineCount,
  };

  return (
    <section>
      <div
        role="radiogroup"
        aria-label="Control mode"
        className={compact ? "flex gap-1" : "grid grid-cols-3 gap-1.5"}
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
              data-control-mode={m.id}
              className={cn(
                compact
                  ? "inline-flex h-11 min-h-11 items-center gap-1.5 rounded-xl border px-2.5 text-xs transition-colors"
                  : "min-h-11 rounded-lg border px-2 py-1.5 text-center transition-colors",
                active
                  ? "border-[var(--pc-accent)] bg-[var(--pc-accent-soft)] text-[var(--pc-ink)]"
                  : "border-[var(--pc-line)] bg-[var(--pc-panel)]/60 text-[var(--pc-muted)]",
              )}
            >
              <span className={compact ? "font-medium" : "block text-sm font-medium"}>{m.label}</span>
              <span className="font-mono text-[10px]">{counts[m.id]}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
