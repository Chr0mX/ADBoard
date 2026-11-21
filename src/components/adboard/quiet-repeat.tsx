"use client";

import { useEffect, useState } from "react";
import { Repeat } from "lucide-react";
import { Toggle } from "@/components/ui/toggle";
import { useQuietMode } from "@/hooks/use-quiet-mode";
import { agentBaseUrl } from "@/lib/api/auth";
import { startQuietCycle, stopQuietCycle, useQuietCycleState } from "@/lib/api/quiet-cycle";
import { cycleLine, DEFAULT_INTERVAL_MINUTES, intervalMinutes, secondsLeft } from "@/lib/api/quiet-cycle-core";

/**
 * Repeat, under the Quiet mode toggle: the agent flips Quiet mode on and off
 * every hours:minutes, with or without a browser open. This only sets it and
 * shows the state; the agent keeps the interval and the time.
 */
export function QuietRepeat({ className }: { className?: string }) {
  const quiet = useQuietMode();
  const { status, receivedAt } = useQuietCycleState();
  const running = status?.enabled === true;
  const saved = status ? Math.round(status.intervalSecs / 60) : DEFAULT_INTERVAL_MINUTES;
  // null: show what the agent has saved until the person types.
  const [hoursEdit, setHoursEdit] = useState<string | null>(null);
  const [minutesEdit, setMinutesEdit] = useState<string | null>(null);
  const hours = hoursEdit ?? String(Math.floor(saved / 60));
  const minutes = minutesEdit ?? String(saved % 60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(0);

  // Redraw the countdown once a second while repeating.
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
      setHoursEdit(null);
      setMinutesEdit(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  // Start in the phase the phones are in now; a change of interval keeps the current phase.
  const apply = () =>
    run(() => startQuietCycle(intervalMinutes(hours, minutes), running && status ? status.phase : quiet.on ? "quiet" : "normal"));
  // Stopping leaves the phones as they are, so remember which state that is.
  const stop = async () => {
    const was = status?.phase === "quiet";
    await stopQuietCycle();
    quiet.adopt(was);
  };
  const left = status ? secondsLeft(status.phaseEndsAt, status.now, receivedAt, clock || receivedAt) : 0;
  const field =
    "h-9 w-16 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2 text-xs text-[var(--pc-ink)] outline-none";
  const input = (label: string, value: string, set: (v: string) => void, attr: string) => (
    <label className="flex items-center gap-1 text-meta text-[var(--pc-muted)]">
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={value}
        disabled={busy}
        onChange={(event) => set(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && running && void apply()}
        aria-label={`Repeat interval, ${label}`}
        {...{ [attr]: true }}
        className={field}
      />
      {label}
    </label>
  );

  return (
    <div data-quiet-repeat className={className ?? "flex w-full flex-col items-start gap-1.5"}>
      <Toggle
        pressed={running}
        onPressedChange={(on) => void run(() => (on ? apply() : stop()))}
        disabled={!agentBaseUrl() || busy || (!running && !quiet.available)}
        aria-label="Repeat: switch Quiet mode on and off at an interval"
        title="Switch Quiet mode on and off at an interval; the agent keeps the time"
        data-quiet-repeat-toggle
        size="md"
      >
        <Repeat className="size-4" />
        Repeat
      </Toggle>
      {running && (
        <div
          data-quiet-repeat-panel
          className="flex flex-wrap items-center gap-2"
          // Apply when focus leaves both fields (not when moving from hours to minutes).
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void apply();
          }}
        >
          <span className="text-meta text-[var(--pc-muted)]">Every</span>
          {input("h", hours, setHoursEdit, "data-quiet-repeat-hours")}
          {input("min", minutes, setMinutesEdit, "data-quiet-repeat-minutes")}
          <p data-quiet-repeat-status className="w-full text-meta text-[var(--pc-muted)]">
            {error ?? (status ? cycleLine(status.phase, left) : "")}
          </p>
        </div>
      )}
      {!running && error && <p className="text-meta text-[var(--pc-warn)]">{error}</p>}
    </div>
  );
}
