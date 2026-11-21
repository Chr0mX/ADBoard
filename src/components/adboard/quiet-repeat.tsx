"use client";

import { useEffect, useState } from "react";
import { Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { useQuietMode } from "@/hooks/use-quiet-mode";
import { useStoredFlag } from "@/hooks/use-stored-flag";
import { agentBaseUrl } from "@/lib/api/auth";
import { startQuietCycle, stopQuietCycle, useQuietCycleState } from "@/lib/api/quiet-cycle";
import {
  cycleLine,
  DEFAULT_NORMAL_MINUTES,
  DEFAULT_QUIET_MINUTES,
  formatLeft,
  parseMinutes,
  secondsLeft,
} from "@/lib/api/quiet-cycle-core";

const OPEN_KEY = "adboard-quiet-repeat-open";

/**
 * "Repeat indefinitely", directly under the Quiet mode toggle. The agent does
 * the timing (quiet for N minutes, normal for M, again and again, also with no
 * browser open); this only sets it up and shows what phase it is in.
 */
export function QuietRepeat({ className }: { className?: string }) {
  const quiet = useQuietMode();
  const { status, receivedAt } = useQuietCycleState();
  const [open, setOpen] = useStoredFlag(OPEN_KEY, false);
  // null: show what the agent has saved (or the defaults) until the person types.
  const [quietEdit, setQuietEdit] = useState<string | null>(null);
  const [normalEdit, setNormalEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(0);
  const running = status?.enabled === true;
  const supported = agentBaseUrl() !== null;

  // Tick once a second while a cycle runs, only to redraw the countdown.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const quietText = quietEdit ?? String(status ? Math.round(status.quietSecs / 60) : DEFAULT_QUIET_MINUTES);
  const normalText = normalEdit ?? String(status ? Math.round(status.normalSecs / 60) : DEFAULT_NORMAL_MINUTES);
  const shown = open || running;
  const left = status ? secondsLeft(status.phaseEndsAt, status.now, receivedAt, clock || receivedAt) : 0;
  const quietMinutes = parseMinutes(quietText, DEFAULT_QUIET_MINUTES);
  const normalMinutes = parseMinutes(normalText, DEFAULT_NORMAL_MINUTES);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setQuietEdit(String(quietMinutes));
      setNormalEdit(String(normalMinutes));
      await startQuietCycle(quietMinutes, normalMinutes, quiet.on ? "quiet" : "normal");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start");
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      const was = status?.phase === "quiet";
      await stopQuietCycle();
      quiet.adopt(was);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not stop");
    } finally {
      setBusy(false);
    }
  };

  const field =
    "h-9 w-20 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-2 text-xs text-[var(--pc-ink)] outline-none";

  return (
    <div data-quiet-repeat className={className ?? "flex w-full flex-col items-start gap-1.5"}>
      <Toggle
        pressed={shown}
        onPressedChange={(on) => {
          setOpen(on);
          if (!on && running) void stop();
        }}
        disabled={!supported || busy}
        aria-label="Repeat indefinitely: alternate Quiet mode and normal on a timer"
        title="Alternate Quiet mode and normal on a timer; the agent keeps the time"
        data-quiet-repeat-toggle
        size="md"
      >
        <Repeat className="size-4" />
        Repeat indefinitely
      </Toggle>
      {shown && (
        <div data-quiet-repeat-panel className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-0.5 text-meta text-[var(--pc-muted)]">
            Quiet for (min)
            <input
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={quietText}
              disabled={busy}
              onChange={(event) => setQuietEdit(event.target.value)}
              aria-label="Quiet duration in minutes"
              data-quiet-repeat-quiet
              className={field}
            />
          </label>
          <label className="flex flex-col gap-0.5 text-meta text-[var(--pc-muted)]">
            Normal for (min)
            <input
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={normalText}
              disabled={busy}
              onChange={(event) => setNormalEdit(event.target.value)}
              aria-label="Normal duration in minutes"
              data-quiet-repeat-normal
              className={field}
            />
          </label>
          {running ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void stop()} disabled={busy} data-quiet-repeat-stop>
              Stop
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => void start()} disabled={busy || !quiet.available} data-quiet-repeat-start>
              Start
            </Button>
          )}
          <p data-quiet-repeat-status className="w-full text-meta text-[var(--pc-muted)]">
            {error ??
              (running && status
                ? cycleLine(true, status.phase, left)
                : `Quiet ${formatLeft(quietMinutes * 60)}, then normal ${formatLeft(normalMinutes * 60)}, again and again. Starts in ${quiet.on ? "Quiet" : "normal"}.`)}
          </p>
        </div>
      )}
    </div>
  );
}
