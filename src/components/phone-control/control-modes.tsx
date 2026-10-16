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
        data-size={compact ? "md" : undefined}
        className={cn("pc-segmented", compact ? "flex-nowrap" : "grid grid-cols-3")}
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
              className={cn("pc-segment", compact ? "flex-none" : "min-h-11 flex-col gap-0 py-1")}
            >
              <span className={compact ? undefined : "block text-sm"}>{m.label}</span>
              <span className="font-mono text-[10px]">{counts[m.id]}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
