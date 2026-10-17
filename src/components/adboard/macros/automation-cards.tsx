"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ListOrdered, Play, Square, Trash2, CalendarClock } from "lucide-react";
import { nextRunAt, type MacroSchedule } from "@/lib/macro/automation";
import {
  addSchedule,
  addToQueue,
  clearQueue,
  moveInQueue,
  patchSchedule,
  removeFromQueue,
  removeSchedule,
  runQueue,
  stopQueue,
  useAutomation,
  useQueueProgress,
} from "@/lib/macro/automation-store";
import type { MacroTab } from "@/lib/macro/core";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Card, GhostButton, IconButton } from "@/components/adboard/macros/fields";

const STATE_TONE: Record<string, string> = {
  running: "text-[var(--pc-accent)]",
  done: "text-[var(--pc-signal)]",
  failed: "text-[var(--pc-warn)]",
};

/** Task queue: play tabs one after another, each on its own ticked phones. */
export function QueueCard({ tabs, activeTab }: { tabs: MacroTab[]; activeTab: MacroTab | null }) {
  const { queue } = useAutomation();
  const { progress, running } = useQueueProgress();
  const name = (tabId: string) => tabs.find((t) => t.id === tabId)?.name ?? "(deleted tab)";

  return (
    <Card
      title={`Queue (${queue.length})`}
      data-macro-queue
      action={
        activeTab && (
          <GhostButton onClick={() => addToQueue(activeTab.id)} disabled={running} data-macro-queue-add>
            <ListOrdered className="size-4" aria-hidden />
            Add “{activeTab.name}”
          </GhostButton>
        )
      }
    >
      <p className="text-xs text-[var(--pc-muted)]">
        Plays each tab to its own stop condition, in order, on the phones ticked in that tab. A failed tab is noted and the
        queue moves on.
      </p>
      {queue.length === 0 ? (
        <p className="text-xs text-[var(--pc-muted)]">Empty. Add tabs to play them back to back.</p>
      ) : (
        <ol className="flex flex-col gap-1" data-macro-queue-list>
          {queue.map((item, index) => {
            const state = progress?.states[item.id];
            return (
              <li key={item.id} className="flex items-center gap-2 rounded-xl border border-[var(--pc-line)] px-2 py-1" data-macro-queue-item={name(item.tabId)} data-state={state?.state ?? ""}>
                <span className="w-5 font-mono text-[10px] text-[var(--pc-muted)]">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--pc-ink)]">{name(item.tabId)}</span>
                {state && (
                  <span className={cn("font-mono text-[10px] uppercase text-[var(--pc-muted)]", STATE_TONE[state.state])} title={state.detail}>
                    {state.state}
                  </span>
                )}
                <IconButton label="Move up" onClick={() => moveInQueue(item.id, -1)} disabled={running || index === 0}>
                  <ArrowUp className="size-4" />
                </IconButton>
                <IconButton label="Move down" onClick={() => moveInQueue(item.id, 1)} disabled={running || index === queue.length - 1}>
                  <ArrowDown className="size-4" />
                </IconButton>
                <IconButton label="Remove from queue" onClick={() => removeFromQueue(item.id)} disabled={running} tone="danger">
                  <Trash2 className="size-4" />
                </IconButton>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex items-center gap-2">
        {running ? (
          <button
            type="button"
            onClick={stopQueue}
            className="inline-flex h-11 min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pc-warn)] px-4 text-sm font-semibold text-[#1a0f08]"
            data-macro-queue-stop
          >
            <Square className="size-4" aria-hidden />
            Stop queue
          </button>
        ) : (
          <button
            type="button"
            disabled={queue.length === 0}
            onClick={() => void runQueue()}
            className="inline-flex h-11 min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--pc-accent-fill)] px-4 text-sm font-semibold text-white disabled:opacity-50"
            data-macro-queue-run
          >
            <Play className="size-4" aria-hidden />
            Run queue
          </button>
        )}
        {!running && queue.length > 0 && (
          <GhostButton onClick={clearQueue} data-macro-queue-clear>
            Clear
          </GhostButton>
        )}
      </div>
    </Card>
  );
}

function toLocalInput(ms: number) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function describeNext(schedule: MacroSchedule, now: number) {
  const next = nextRunAt(schedule, now);
  if (!schedule.enabled) return "Off";
  if (next === null) return "Done";
  return `Next ${new Date(next).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`;
}

/** Scheduler: start a tab or the queue at a time, once or every N minutes. */
export function ScheduleCard({ tabs, activeTab }: { tabs: MacroTab[]; activeTab: MacroTab | null }) {
  const { schedules } = useAutomation();
  const [target, setTarget] = useState<string>(activeTab ? `tab:${activeTab.id}` : "queue");
  const [kind, setKind] = useState<"once" | "every">("once");
  const [at, setAt] = useState(() => toLocalInput(Date.now() + 5 * 60_000));
  const [every, setEvery] = useState(30);
  // Re-read "next run" times as the clock moves.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const label = (s: MacroSchedule) =>
    s.target.kind === "queue" ? "Queue" : (tabs.find((t) => t.id === (s.target as { tabId: string }).tabId)?.name ?? "(deleted tab)");

  return (
    <Card title={`Schedule (${schedules.length})`} data-macro-schedule>
      <p className="text-xs text-[var(--pc-muted)]">
        Schedules run on the ADBoard agent, even with no browser open. A slot missed while the agent was off runs once
        when it is back.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const atMs = new Date(at).getTime();
          if (!Number.isFinite(atMs)) return;
          addSchedule({
            target: target === "queue" ? { kind: "queue" } : { kind: "tab", tabId: target.slice(4) },
            kind,
            at: atMs,
            everyMinutes: Math.max(1, Math.round(every)),
          });
        }}
      >
        <label className="flex flex-col gap-0.5 text-[11px] text-[var(--pc-muted)]">
          Play
          <select value={target} onChange={(e) => setTarget(e.target.value)} className="h-10 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-sm text-[var(--pc-ink)]" data-macro-schedule-target>
            {tabs.map((t) => (
              <option key={t.id} value={`tab:${t.id}`}>
                {t.name}
              </option>
            ))}
            <option value="queue">The queue</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-[var(--pc-muted)]">
          Repeat
          <select value={kind} onChange={(e) => setKind(e.target.value === "every" ? "every" : "once")} className="h-10 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-sm text-[var(--pc-ink)]" data-macro-schedule-kind>
            <option value="once">Once</option>
            <option value="every">Every…</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-[var(--pc-muted)]">
          {kind === "once" ? "At" : "Starting"}
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className="h-10 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-sm text-[var(--pc-ink)]" data-macro-schedule-at />
        </label>
        {kind === "every" && (
          <label className="flex flex-col gap-0.5 text-[11px] text-[var(--pc-muted)]">
            Minutes
            <input type="number" min={1} max={1440} value={every} onChange={(e) => setEvery(Number(e.target.value))} className="h-10 w-20 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-sm text-[var(--pc-ink)]" data-macro-schedule-every />
          </label>
        )}
        <button type="submit" className="pc-toggle pc-toggle-md" data-macro-schedule-add>
          <CalendarClock className="size-4" aria-hidden />
          Add
        </button>
      </form>
      {schedules.length > 0 && (
        <ul className="flex flex-col gap-1" data-macro-schedule-list>
          {schedules.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--pc-line)] px-2 py-1" data-macro-schedule-item={label(s)}>
              <Switch checked={s.enabled} onChange={() => patchSchedule(s.id, { enabled: !s.enabled })} aria-label={`Enable schedule for ${label(s)}`} />
              <span className="min-w-0 flex-1 text-sm text-[var(--pc-ink)]">
                {label(s)}
                <span className="ml-2 font-mono text-[10px] text-[var(--pc-muted)]">
                  {s.kind === "every" ? `every ${s.everyMinutes} min` : "once"} · {describeNext(s, now)}
                </span>
                {s.lastResult && (
                  <span className="block font-mono text-[10px] text-[var(--pc-muted)]" data-macro-schedule-last>
                    {new Date(s.lastRunAt ?? 0).toLocaleTimeString([], { timeStyle: "short" })}: {s.lastResult}
                  </span>
                )}
              </span>
              <IconButton label="Delete schedule" onClick={() => removeSchedule(s.id)} tone="danger">
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
