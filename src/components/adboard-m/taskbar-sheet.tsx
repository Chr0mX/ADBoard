"use client";

import { Switch } from "@/components/ui/switch";
import { BottomSheet } from "@/components/adboard-m/bottom-sheet";
import { useTaskbarPins } from "@/hooks/use-taskbar-pins";
import { useTaskbarHidden } from "@/hooks/use-taskbar-hidden";
import {
  HIDEABLE_NAV_IDS,
  HIDEABLE_NAV_LABELS,
  TASKBAR_TOOL_IDS,
  TASKBAR_TOOL_LABELS,
  moveTaskbarPin,
} from "@/lib/ui/taskbar-pins";

/** Pin, hide and reorder the Control taskbar buttons (the same stored settings as Settings → Phone taskbar). */
export function TaskbarSheet({ onClose }: { onClose: () => void }) {
  const { pins, setPins, togglePin, resetPins, atLimit } = useTaskbarPins();
  const { hidden, toggleHidden } = useTaskbarHidden();
  return (
    <BottomSheet title="Taskbar" onClose={onClose} dataSheet="taskbar">
      <p className="text-xs text-[var(--pc-muted)]">Back, Home, Recent, Minimize always stay. Pick what sits beside them.</p>
      <div className="flex flex-col gap-1" data-m-taskbar-pins>
        {TASKBAR_TOOL_IDS.map((id) => (
          <label key={id} className="pc-choice-row justify-between" aria-disabled={(!pins.includes(id) && atLimit) || undefined}>
            <span>{TASKBAR_TOOL_LABELS[id]}</span>
            <Switch checked={pins.includes(id)} disabled={!pins.includes(id) && atLimit} onChange={() => togglePin(id)} />
          </label>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="font-display text-xs font-semibold text-[var(--pc-ink)]">Show on the bar</h3>
        {HIDEABLE_NAV_IDS.map((id) => (
          <label key={id} className="pc-choice-row justify-between">
            <span>{HIDEABLE_NAV_LABELS[id]}</span>
            <Switch checked={!hidden.includes(id)} onChange={() => toggleHidden(id)} />
          </label>
        ))}
      </div>
      {pins.length > 1 && (
        <div className="flex flex-col gap-1" data-m-taskbar-order>
          <h3 className="font-display text-xs font-semibold text-[var(--pc-ink)]">Order (left to right)</h3>
          {pins.map((id, index) => (
            <div key={id} className="flex items-center justify-between gap-2 text-sm text-[var(--pc-ink)]">
              <span>
                {index + 1}. {TASKBAR_TOOL_LABELS[id]}
              </span>
              <span className="flex gap-1">
                <button type="button" className="pc-toggle pc-toggle-md min-h-11 px-3" disabled={index === 0} aria-label={`Move ${TASKBAR_TOOL_LABELS[id]} earlier`} onClick={() => setPins(moveTaskbarPin(pins, id, -1))}>
                  Up
                </button>
                <button type="button" className="pc-toggle pc-toggle-md min-h-11 px-3" disabled={index === pins.length - 1} aria-label={`Move ${TASKBAR_TOOL_LABELS[id]} later`} onClick={() => setPins(moveTaskbarPin(pins, id, 1))}>
                  Down
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <button type="button" className="pc-toggle pc-toggle-md min-h-11" disabled={pins.length === 0} onClick={resetPins}>
        Reset pins
      </button>
    </BottomSheet>
  );
}
