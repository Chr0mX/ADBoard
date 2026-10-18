/**
 * Task queue and scheduler on top of the macro runner (`startRun`). Pure
 * logic only: no storage, timers or React, so it can be tested in Node.
 * Both play existing macro tabs; neither is a second macro engine.
 */

import type { RunSnapshot } from "./core";

export interface QueueItem {
  id: string;
  tabId: string;
}

export type QueueItemState = "waiting" | "running" | "done" | "stopped" | "failed" | "skipped";

export interface QueueProgress {
  running: boolean;
  index: number;
  states: Record<string, { state: QueueItemState; detail?: string }>;
}

/**
 * Play `items` one after another. `start` plays a tab and resolves when it
 * ends (null when the tab could not start, e.g. already running). A missing
 * tab is skipped; a failed run is recorded and the queue moves on. Aborting
 * ends the queue after the current run stops.
 */
export async function runQueueItems({
  items,
  hasTab,
  start,
  signal,
  onProgress,
}: {
  items: QueueItem[];
  hasTab: (tabId: string) => boolean;
  start: (tabId: string) => Promise<RunSnapshot | null>;
  signal: AbortSignal;
  onProgress: (progress: QueueProgress) => void;
}): Promise<QueueProgress> {
  const progress: QueueProgress = {
    running: true,
    index: 0,
    states: Object.fromEntries(items.map((item) => [item.id, { state: "waiting" as QueueItemState }])),
  };
  const emit = () => onProgress({ ...progress, states: { ...progress.states } });
  emit();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    progress.index = index;
    if (signal.aborted) {
      progress.states[item.id] = { state: "stopped" };
      continue;
    }
    if (!hasTab(item.tabId)) {
      progress.states[item.id] = { state: "skipped", detail: "tab was deleted" };
      emit();
      continue;
    }
    progress.states[item.id] = { state: "running" };
    emit();
    const result = await start(item.tabId);
    if (!result) {
      progress.states[item.id] = { state: "skipped", detail: "tab is already running" };
    } else if (result.status === "done") {
      progress.states[item.id] = { state: "done", detail: result.message };
    } else if (result.status === "stopped") {
      progress.states[item.id] = { state: "stopped", detail: result.message };
    } else {
      progress.states[item.id] = { state: "failed", detail: result.message };
    }
    emit();
  }
  progress.running = false;
  emit();
  return progress;
}

export type ScheduleTarget = { kind: "tab"; tabId: string } | { kind: "queue" };

export interface MacroSchedule {
  id: string;
  target: ScheduleTarget;
  /** `once` at `at`; `every` N minutes starting at `at`. */
  kind: "once" | "every";
  at: number;
  everyMinutes: number;
  enabled: boolean;
  lastRunAt?: number;
  lastResult?: string;
}

export const MIN_EVERY_MINUTES = 1;
export const MAX_EVERY_MINUTES = 24 * 60;

/** Next time the schedule fires, or null when it never will again. */
export function nextRunAt(schedule: MacroSchedule, now: number): number | null {
  if (!schedule.enabled) return null;
  if (schedule.kind === "once") {
    return schedule.lastRunAt !== undefined ? null : schedule.at;
  }
  const every = Math.max(MIN_EVERY_MINUTES, schedule.everyMinutes) * 60_000;
  if (schedule.lastRunAt === undefined || schedule.lastRunAt < schedule.at) return schedule.at;
  // The first slot after the last run. Slots missed while the page was closed
  // collapse into one run (the latest slot), not a burst of catch-up runs.
  const next = schedule.at + (Math.floor((schedule.lastRunAt - schedule.at) / every) + 1) * every;
  if (next <= now - every) return schedule.at + Math.floor((now - schedule.at) / every) * every;
  return next;
}

/** Schedules whose next run time has arrived. */
export function dueSchedules(schedules: MacroSchedule[], now: number): MacroSchedule[] {
  return schedules.filter((schedule) => {
    const next = nextRunAt(schedule, now);
    return next !== null && next <= now;
  });
}

export function normalizeSchedules(raw: unknown): MacroSchedule[] {
  if (!Array.isArray(raw)) return [];
  const out: MacroSchedule[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const s = value as Partial<MacroSchedule>;
    const target =
      s.target && typeof s.target === "object" && s.target.kind === "queue"
        ? ({ kind: "queue" } as const)
        : s.target && typeof s.target === "object" && s.target.kind === "tab" && typeof s.target.tabId === "string"
          ? ({ kind: "tab", tabId: s.target.tabId } as const)
          : null;
    if (!target || typeof s.id !== "string" || typeof s.at !== "number") continue;
    out.push({
      id: s.id,
      target,
      kind: s.kind === "every" ? "every" : "once",
      at: s.at,
      everyMinutes: Math.min(
        MAX_EVERY_MINUTES,
        Math.max(MIN_EVERY_MINUTES, typeof s.everyMinutes === "number" ? Math.round(s.everyMinutes) : 60),
      ),
      enabled: s.enabled !== false,
      lastRunAt: typeof s.lastRunAt === "number" ? s.lastRunAt : undefined,
      lastResult: typeof s.lastResult === "string" ? s.lastResult : undefined,
    });
  }
  return out;
}

export function normalizeQueue(raw: unknown): QueueItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (v): v is QueueItem =>
        Boolean(v) && typeof v === "object" && typeof (v as QueueItem).id === "string" && typeof (v as QueueItem).tabId === "string",
    )
    .map((v) => ({ id: v.id, tabId: v.tabId }));
}
