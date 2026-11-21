"use client";

import { useEffect, useState } from "react";
import { Repeat } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { useQuietMode } from "@/hooks/use-quiet-mode";
import { agentBaseUrl } from "@/lib/api/auth";
import { startQuietCycle, stopQuietCycle, useQuietCycleState } from "@/lib/api/quiet-cycle";
import {
  cycleLine,
  DEFAULT_INTERVAL_MINUTES,
  intervalMinutes,
  secondsLeft,
  splitInterval,
  type IntervalUnit,
} from "@/lib/api/quiet-cycle-core";

/**
 * Quiet Mode Loop, under the Quiet Mode toggle: the agent flips Quiet Mode on and
 * off at the interval (minutes or hours), with or without a browser open. This
 * only sets it and shows the state; the agent keeps the interval and the time.
 */
export function QuietRepeat({ className }: { className?: string }) {
  const quiet = useQuietMode();
  const { status, receivedAt } = useQuietCycleState();
  const running = status?.enabled === true;
  const saved = splitInterval(status ? Math.round(status.intervalSecs / 60) : DEFAULT_INTERVAL_MINUTES);
  // null: show what the agent has saved until the person types.
  const [valueEdit, setValueEdit] = useState<string | null>(null);
  const [unitEdit, setUnitEdit] = useState<IntervalUnit | null>(null);
  const value = valueEdit ?? saved.value;
  const unit = unitEdit ?? saved.unit;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(0);

  // Redraw the countdown once a second while the loop runs.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setValueEdit(null);
      setUnitEdit(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  // Start in the phase the phones are in now; a change of interval keeps the current phase.
  const apply = (nextUnit: IntervalUnit = unit) =>
    run(() => startQuietCycle(intervalMinutes(value, nextUnit), running && status ? status.phase : quiet.on ? "quiet" : "normal"));
  // Only an actual change restarts the timer (leaving the field untouched does nothing).
  const commit = () => {
    if (valueEdit !== null && valueEdit !== saved.value) void apply();
  };
  const left = status ? secondsLeft(status.phaseEndsAt, status.now, receivedAt, clock || receivedAt) : 0;
  const field =
    "h-9 w-16 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2 text-xs text-[var(--pc-ink)] outline-none";

  return (
    <div data-quiet-repeat className={className ?? "flex w-full flex-col items-start gap-1.5"}>
      <Toggle
        pressed={running}
        onPressedChange={(on) => void run(() => (on ? apply() : stopQuietCycle()))}
        disabled={!agentBaseUrl() || busy || (!running && !quiet.available)}
        aria-label="Quiet Mode Loop: repeat Quiet Mode at an interval"
        title="Repeat Quiet Mode on and off at this interval; the agent keeps the time, also with the browser closed"
        data-quiet-repeat-toggle
        size="md"
      >
        <Repeat className="size-4" />
        Quiet Mode Loop
      </Toggle>
      {running && (
        <div data-quiet-repeat-panel className="flex flex-wrap items-center gap-2">
          <span className="text-meta text-[var(--pc-muted)]">Every</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={value}
            disabled={busy}
            onChange={(event) => setValueEdit(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => event.key === "Enter" && commit()}
            aria-label="Quiet Mode Loop interval"
            data-quiet-repeat-interval
            className={field}
          />
          <select
            value={unit}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value as IntervalUnit;
              setUnitEdit(next);
              void apply(next);
            }}
            aria-label="Interval unit"
            data-quiet-repeat-unit
            className="h-9 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-xs text-[var(--pc-ink)]"
          >
            <option value="min">minutes</option>
            <option value="h">hours</option>
          </select>
          <p data-quiet-repeat-status className="w-full text-meta text-[var(--pc-muted)]">
            {error ?? (status ? cycleLine(status.phase, left) : "")}
          </p>
        </div>
      )}
      {!running && error && <p className="text-meta text-[var(--pc-warn)]">{error}</p>}
    </div>
  );
}
