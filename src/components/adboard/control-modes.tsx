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
  /** Compact track height: md fits a 44px bar, sm a 36px phone bar. */
  size?: "sm" | "md";
  /** Fill the available width (phone grid bar). */
  stretch?: boolean;
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
  size = "md",
  stretch = false,
}: ControlModesProps) {
  const counts: Record<ControlMode, number> = {
    selected: Math.min(selectedCount, 1),
    multi: multiCount,
    all: onlineCount,
  };

  return (
    <section className={stretch ? "min-w-0 flex-1 sm:flex-none" : undefined}>
      <div
        role="radiogroup"
        aria-label="Control mode"
        data-size={compact ? size : undefined}
        className={cn("pc-segmented", compact ? "flex-nowrap" : "grid grid-cols-3", stretch && "w-full sm:w-auto")}
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
              className={cn("pc-segment", compact ? (stretch ? "flex-1 sm:flex-none" : "flex-none") : "min-h-11 flex-col gap-0 py-1")}
            >
              <span className={compact ? undefined : "block text-sm"}>{m.label}</span>
              <span className="font-mono text-[11px]">{counts[m.id]}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
