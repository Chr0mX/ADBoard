"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ListOrdered, Pencil, Play, Square, Trash2, CalendarClock } from "lucide-react";
import { CRON_PRESETS, cronError, nextCronRuns, nextRunAt, type MacroSchedule } from "@/lib/macro/automation";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";
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
import { cn, sentenceCase } from "@/lib/utils";
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
                <span className="w-5 font-mono text-[11px] text-[var(--pc-muted)]">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--pc-ink)]">{name(item.tabId)}</span>
                {state && (
 <span className={cn("font-mono text-[11px] text-[var(--pc-muted)]", STATE_TONE[state.state])} title={state.detail}>
                    {sentenceCase(state.state)}
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

const fmt = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", dateStyle: undefined, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function describeNext(schedule: MacroSchedule, now: number) {
  if (!schedule.enabled) return "Off";
  if (schedule.kind === "cron" && cronError(schedule.cron ?? "")) return "Invalid cron";
  const next = nextRunAt(schedule, now);
  if (next === null) return "Done";
  return `Next ${new Date(next).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`;
}

function describeRepeat(s: MacroSchedule) {
  if (s.kind === "cron") return `cron ${s.cron ?? ""}`;
  return s.kind === "every" ? `every ${s.everyMinutes} min` : "once";
}

type Kind = MacroSchedule["kind"];
const fieldClass = "h-10 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 text-sm text-[var(--pc-ink)]";

/**
 * The next runs of a cron expression. With the agent they come from it, on
 * the clock schedules really run on; otherwise from this browser's clock.
 */
function useCronPreview(expr: string, active: boolean) {
  const [preview, setPreview] = useState<{ expr: string; next: number[]; error?: string; agentOffset?: number } | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    const timer = window.setTimeout(() => {
      const local = () => {
        const error = cronError(expr);
        return { expr, next: error ? [] : nextCronRuns(expr, Date.now(), 3), error: error ?? undefined };
      };
      const base = agentBaseUrl();
      if (base === null) {
        setPreview(local());
        return;
      }
      agentFetch(`${base}/api/macro/cron?expr=${encodeURIComponent(expr)}&count=3`, { cache: "no-store" })
        .then(async (res) => {
          const body = (await res.json()) as { next?: number[]; utcOffsetMinutes?: number; error?: string };
          if (!live) return;
          setPreview(res.ok ? { expr, next: body.next ?? [], agentOffset: body.utcOffsetMinutes } : { expr, next: [], error: body.error ?? "Not a cron expression" });
        })
        .catch(() => live && setPreview(local()));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [expr, active]);
  return preview && preview.expr === expr ? preview : null;
}

/** Scheduler: start a tab or the queue once, every N minutes, or on a cron expression. */
export function ScheduleCard({ tabs, activeTab }: { tabs: MacroTab[]; activeTab: MacroTab | null }) {
  const { schedules } = useAutomation();
  const [chosenTarget, setTarget] = useState<string>(activeTab ? `tab:${activeTab.id}` : "queue");
  // Tabs can arrive (sync) or go after the choice was made: fall back to the open tab.
  const target =
    chosenTarget === "queue" || tabs.some((t) => `tab:${t.id}` === chosenTarget) ? chosenTarget : activeTab ? `tab:${activeTab.id}` : "queue";
  const [kind, setKind] = useState<Kind>("once");
  const [at, setAt] = useState(() => toLocalInput(Date.now() + 5 * 60_000));
  const [every, setEvery] = useState(30);
  const [cron, setCron] = useState("0 8 * * 1-5");
  const [editing, setEditing] = useState<string | null>(null);
  // Re-read "next run" times as the clock moves.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const preview = useCronPreview(cron.trim(), kind === "cron");
  const cronProblem = kind === "cron" ? (preview?.error ?? cronError(cron)) : null;
  const browserOffset = -new Date().getTimezoneOffset();
  const label = (s: MacroSchedule) =>
    s.target.kind === "queue" ? "Queue" : (tabs.find((t) => t.id === (s.target as { tabId: string }).tabId)?.name ?? "(deleted tab)");

  const reset = () => {
    setEditing(null);
    setKind("once");
    setAt(toLocalInput(Date.now() + 5 * 60_000));
  };
  const edit = (s: MacroSchedule) => {
    setEditing(s.id);
    setTarget(s.target.kind === "queue" ? "queue" : `tab:${s.target.tabId}`);
    setKind(s.kind);
    setAt(toLocalInput(s.kind === "cron" ? Date.now() : s.at));
    setEvery(s.everyMinutes);
    if (s.cron) setCron(s.cron);
  };

  return (
    <Card title={`Schedule (${schedules.length})`} data-macro-schedule>
      <p className="text-xs text-[var(--pc-muted)]">
        Schedules run on the ADBoard agent, even with no browser open. A missed <em>Once</em> or <em>Every</em> slot runs once when the agent is back;
        a missed cron time is skipped unless it was under 5 minutes ago.
      </p>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const atMs = kind === "cron" ? Date.now() : new Date(at).getTime();
          if (!Number.isFinite(atMs) || cronProblem) return;
          const fields = {
            target: target === "queue" ? ({ kind: "queue" } as const) : ({ kind: "tab", tabId: target.slice(4) } as const),
            kind,
            at: atMs,
            everyMinutes: Math.min(1440, Math.max(1, Math.round(every))),
            ...(kind === "cron" ? { cron: cron.trim() } : {}),
          };
          if (editing) {
            // New timing: forget the last run so the schedule starts over.
            patchSchedule(editing, { ...fields, cron: kind === "cron" ? cron.trim() : undefined, lastRunAt: undefined, lastResult: undefined });
            reset();
          } else addSchedule(fields);
        }}
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-0.5 text-[11px] text-[var(--pc-muted)]">
            Play
            <select value={target} onChange={(e) => setTarget(e.target.value)} className={fieldClass} data-macro-schedule-target>
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
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={fieldClass} data-macro-schedule-kind>
              <option value="once">Once</option>
              <option value="every">Every…</option>
              <option value="cron">Cron expression</option>
            </select>
          </label>
          {kind !== "cron" && (
            <label className="flex flex-col gap-0.5 text-[11px] text-[var(--pc-muted)]">
              {kind === "once" ? "At" : "Starting"}
              <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className={fieldClass} data-macro-schedule-at />
            </label>
          )}
          {kind === "every" && (
            <label className="flex flex-col gap-0.5 text-[11px] text-[var(--pc-muted)]">
              Minutes
              <input type="number" min={1} max={1440} value={every} onChange={(e) => setEvery(Number(e.target.value))} className={cn(fieldClass, "w-20")} data-macro-schedule-every />
            </label>
          )}
          {kind === "cron" && (
            <>
              <label className="flex flex-col gap-0.5 text-[11px] text-[var(--pc-muted)]">
                Expression
                <input
                  value={cron}
                  onChange={(e) => setCron(e.target.value)}
                  spellCheck={false}
                  placeholder="min hour day month weekday"
                  aria-invalid={Boolean(cronProblem) || undefined}
                  className={cn(fieldClass, "w-60 font-mono", cronProblem && "border-[var(--pc-warn)]")}
                  data-macro-schedule-cron
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-[var(--pc-muted)]">
                Preset
                <select
                  value={CRON_PRESETS.find((p) => p.cron === cron.trim())?.cron ?? ""}
                  onChange={(e) => e.target.value && setCron(e.target.value)}
                  className={fieldClass}
                  data-macro-schedule-preset
                >
                  <option value="">Custom</option>
                  {CRON_PRESETS.map((p) => (
                    <option key={p.cron} value={p.cron}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <button type="submit" className="pc-toggle pc-toggle-md" disabled={Boolean(cronProblem)} data-macro-schedule-add>
            <CalendarClock className="size-4" aria-hidden />
            {editing ? "Save" : "Add"}
          </button>
          {editing && (
            <GhostButton onClick={reset} data-macro-schedule-cancel>
              Cancel
            </GhostButton>
          )}
        </div>
        {kind === "cron" && (
          <div className="font-mono text-[11px]" data-macro-schedule-preview>
            {cronProblem ? (
              <p className="text-[var(--pc-warn)]">{cronProblem}</p>
            ) : preview ? (
              <p className="text-[var(--pc-muted)]">
                Next: {preview.next.length ? preview.next.map(fmt).join(" · ") : "never (no such date)"}
                {preview.agentOffset !== undefined && preview.agentOffset !== browserOffset && (
                  <span className="block text-[var(--pc-warn)]">
                    ADBoard&apos;s computer is at UTC{preview.agentOffset >= 0 ? "+" : "−"}
                    {Math.abs(preview.agentOffset / 60)}, this browser at UTC{browserOffset >= 0 ? "+" : "−"}
                    {Math.abs(browserOffset / 60)}: cron times use ADBoard&apos;s clock (shown here in your time).
                  </span>
                )}
              </p>
            ) : null}
            <p className="text-[var(--pc-muted)]">minute hour day-of-month month day-of-week · e.g. */15, 8-18/2, 1,15, mon-fri, @daily</p>
          </div>
        )}
      </form>
      {schedules.length > 0 && (
        <ul className="flex flex-col gap-1" data-macro-schedule-list>
          {schedules.map((s) => (
            <li
              key={s.id}
              className={cn("flex flex-wrap items-center gap-2 rounded-xl border px-2 py-1", editing === s.id ? "border-[var(--pc-accent)]" : "border-[var(--pc-line)]")}
              data-macro-schedule-item={label(s)}
            >
              <Switch checked={s.enabled} onChange={() => patchSchedule(s.id, { enabled: !s.enabled })} aria-label={`Enable schedule for ${label(s)}`} />
              <span className="min-w-0 flex-1 text-sm text-[var(--pc-ink)]">
                {label(s)}
                <span className="ml-2 font-mono text-[11px] text-[var(--pc-muted)]">
                  {describeRepeat(s)} · {describeNext(s, now)}
                </span>
                {s.lastResult && (
                  <span className="block font-mono text-[11px] text-[var(--pc-muted)]" data-macro-schedule-last>
                    {new Date(s.lastRunAt ?? 0).toLocaleTimeString([], { timeStyle: "short" })}: {s.lastResult}
                  </span>
                )}
              </span>
              <IconButton label="Edit schedule" onClick={() => edit(s)} data-macro-schedule-edit>
                <Pencil className="size-4" />
              </IconButton>
              <IconButton
                label="Delete schedule"
                onClick={() => {
                  if (editing === s.id) reset();
                  removeSchedule(s.id);
                }}
                tone="danger"
              >
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
