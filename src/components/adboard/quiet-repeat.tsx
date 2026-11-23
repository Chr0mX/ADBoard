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
  DEFAULT_PEEK_SECONDS,
  intervalMinutes,
  MAX_PEEK_SECONDS,
  MIN_PEEK_SECONDS,
  parsePeekSeconds,
  secondsLeft,
  splitInterval,
  type IntervalUnit,
} from "@/lib/api/quiet-cycle-core";

/**
 * Quiet Mode Loop, under the Quiet Mode toggle: phones go quiet at once (screen off, muted)
 * and stay quiet for the quiet duration; then the screen comes on for a few seconds (sound
 * stays muted) and the quiet duration starts again, until the loop is turned off. This only
 * sets it and shows the state; the agent keeps the times, with or without a browser open.
 */
export function QuietRepeat({ className }: { className?: string }) {
  const quiet = useQuietMode();
  const { status, receivedAt } = useQuietCycleState();
  const running = status?.enabled === true;
  const saved = splitInterval(status ? Math.round(status.intervalSecs / 60) : DEFAULT_INTERVAL_MINUTES);
  // null: show what the agent has saved until the person types.
  const [valueEdit, setValueEdit] = useState<string | null>(null);
  const [unitEdit, setUnitEdit] = useState<IntervalUnit | null>(null);
  const [peekEdit, setPeekEdit] = useState<string | null>(null);
  const peek = peekEdit ?? String(status?.peekSecs ?? DEFAULT_PEEK_SECONDS);
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
      setPeekEdit(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  // (Re)start with the fields as shown: quiet at once, for the full quiet duration.
  const apply = (nextUnit: IntervalUnit = unit) =>
    run(async () => {
      await startQuietCycle(intervalMinutes(value, nextUnit), parsePeekSeconds(peek));
      quiet.adopt(true);
    });
  // Turning it off puts the phones back (sound restored, screens on).
  const stop = async () => {
    await stopQuietCycle();
    quiet.adopt(false);
  };
  // Only an actual change restarts the timer (leaving a field untouched does nothing).
  const commit = () => {
    if ((valueEdit !== null && valueEdit !== saved.value) || (peekEdit !== null && peekEdit !== String(status?.peekSecs))) void apply();
  };
  const left = status ? secondsLeft(status.phaseEndsAt, status.now, receivedAt, clock || receivedAt) : 0;
  const field =
    "h-9 w-16 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2 text-xs text-[var(--pc-ink)] outline-none";

  return (
    <div data-quiet-repeat className={className ?? "flex w-full flex-col items-start gap-1.5"}>
      <Toggle
        pressed={running}
        onPressedChange={(on) => void run(() => (on ? apply() : stop()))}
        disabled={agentBaseUrl() === null || busy || (!running && !quiet.available)}
        aria-label="Quiet Mode Loop: repeat Quiet Mode at an interval"
        title="Phones go quiet at once (screen off, muted) for the quiet time, then the screen comes on briefly (still muted), then quiet again, until you turn this off. The agent keeps the time, also with the browser closed."
        data-quiet-repeat-toggle
        size="md"
      >
        <Repeat className="size-4" />
        Quiet Mode Loop
      </Toggle>
      {running && (
        <div data-quiet-repeat-panel className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-meta text-[var(--pc-muted)]">
            Quiet for
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
              aria-label="Quiet duration"
              data-quiet-repeat-interval
              className={field}
            />
          </label>
          <select
            value={unit}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value as IntervalUnit;
              setUnitEdit(next);
              void apply(next);
            }}
            aria-label="Quiet duration unit"
            data-quiet-repeat-unit
            className="h-9 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-xs text-[var(--pc-ink)]"
          >
            <option value="min">minutes</option>
            <option value="h">hours</option>
          </select>
          <label className="flex items-center gap-1 text-meta text-[var(--pc-muted)]">
            then screen on for
            <input
              type="number"
              inputMode="numeric"
              min={MIN_PEEK_SECONDS}
              max={MAX_PEEK_SECONDS}
              step={1}
              value={peek}
              disabled={busy}
              onChange={(event) => setPeekEdit(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => event.key === "Enter" && commit()}
              aria-label="Screen-on duration in seconds, 1 to 5"
              data-quiet-repeat-peek
              className={field}
            />
            s
          </label>
          <p data-quiet-repeat-status className="w-full text-meta text-[var(--pc-muted)]">
            {error ?? (status ? cycleLine(status.phase, left) : "")}
          </p>
        </div>
      )}
      {!running && error && <p className="text-meta text-[var(--pc-warn)]">{error}</p>}
    </div>
  );
}
