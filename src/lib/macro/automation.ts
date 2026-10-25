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
  /** `once` at `at`; `every` N minutes starting at `at`; `cron` from `at` on. */
  kind: "once" | "every" | "cron";
  at: number;
  everyMinutes: number;
  /** For `cron`: e.g. `0 8 * * 1-5` (the ADBoard computer's local time). */
  cron?: string;
  enabled: boolean;
  lastRunAt?: number;
  lastResult?: string;
}

export const MIN_EVERY_MINUTES = 1;
export const MAX_EVERY_MINUTES = 24 * 60;
/** A cron time missed by more than this (ADBoard was off) is skipped. */
export const CRON_GRACE_MS = 5 * 60_000;

/** Next time the schedule fires, or null when it never will again. */
export function nextRunAt(schedule: MacroSchedule, now: number): number | null {
  if (!schedule.enabled) return null;
  if (schedule.kind === "cron") {
    // Unlike `every`, missed times are not caught up: a daily 08:00 job does
    // not run at 15:00 when ADBoard starts (unless missed by < CRON_GRACE_MS).
    let cron;
    try {
      cron = parseCron(schedule.cron ?? "");
    } catch {
      return null;
    }
    const after = schedule.lastRunAt !== undefined && schedule.lastRunAt >= schedule.at ? schedule.lastRunAt : schedule.at - 1;
    const next = nextCronAfter(cron, after);
    if (next !== null && next + CRON_GRACE_MS < now) return nextCronAfter(cron, now - CRON_GRACE_MS);
    return next;
  }
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
      kind: s.kind === "every" || s.kind === "cron" ? s.kind : "once",
      ...(typeof s.cron === "string" ? { cron: s.cron.slice(0, 200) } : {}),
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

/* ------------------------------------------------------------------ */
/* Cron expressions (the agent's cron.rs does the same)                */
/*                                                                     */
/* Five fields — minute hour day-of-month month day-of-week — with `*`, */
/* lists, ranges, steps (`*\/15`, `8-18/2`), names (`jan`, `mon-fri`)  */
/* and `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. Day of    */
/* week 0–7 (0 and 7 are Sunday). When both day fields are restricted a */
/* day matches if either does. Times are local wall-clock times.        */
/* ------------------------------------------------------------------ */

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  anyDay: boolean;
  anyWeekday: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const SEARCH_YEARS = 5;

interface Field {
  name: string;
  min: number;
  max: number;
  names: string[];
  namesFrom: number;
}

const FIELDS: Field[] = [
  { name: "Minute", min: 0, max: 59, names: [], namesFrom: 0 },
  { name: "Hour", min: 0, max: 23, names: [], namesFrom: 0 },
  { name: "Day of month", min: 1, max: 31, names: [], namesFrom: 0 },
  { name: "Month", min: 1, max: 12, names: MONTHS, namesFrom: 1 },
  { name: "Day of week", min: 0, max: 7, names: WEEKDAYS, namesFrom: 0 },
];

export const CRON_SHORTCUTS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** Ready-made expressions for the schedule editor. */
export const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every day at 08:00", cron: "0 8 * * *" },
  { label: "Weekdays at 08:00", cron: "0 8 * * 1-5" },
  { label: "Weekends at 10:00", cron: "0 10 * * 0,6" },
  { label: "Every 2 hours, 08:00–20:00", cron: "0 8-20/2 * * *" },
  { label: "Mondays at 09:00", cron: "0 9 * * 1" },
  { label: "1st of the month at 00:00", cron: "0 0 1 * *" },
];

export class CronError extends Error {}

function value(field: Field, text: string): number {
  const at = field.names.indexOf(text.toLowerCase());
  if (at >= 0) return at + field.namesFrom;
  if (!/^\d+$/.test(text)) throw new CronError(`${field.name}: “${text}” is not a number`);
  const n = Number(text);
  if (n < field.min || n > field.max) throw new CronError(`${field.name}: ${n} is out of range (${field.min}–${field.max})`);
  return n;
}

function parseField(field: Field, text: string): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    if (!part) throw new CronError(`${field.name}: empty item in “${text}”`);
    const [range, stepText] = part.split("/", 2) as [string, string | undefined];
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) throw new CronError(`${field.name}: step “${stepText}” is not a number`);
      step = Number(stepText);
      if (step === 0) throw new CronError(`${field.name}: a step of 0 never repeats`);
    }
    let from: number;
    let to: number;
    if (range === "*") {
      from = field.min;
      to = field.max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-", 2);
      from = value(field, a);
      to = value(field, b);
      if (from > to) throw new CronError(`${field.name}: range ${from}-${to} goes backwards`);
    } else {
      from = value(field, range);
      // `5/10` runs from 5 to the end, every 10.
      to = stepText !== undefined ? field.max : from;
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

/** Parse an expression. Throws CronError with a readable reason. */
export function parseCron(expression: string): Cron {
  const text = expression.trim();
  let expanded = text;
  if (text.startsWith("@")) {
    expanded = CRON_SHORTCUTS[text.toLowerCase()];
    if (!expanded) throw new CronError(`Unknown shortcut “${text}”`);
  }
  const parts = expanded.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) {
    throw new CronError(`A cron expression has 5 fields (minute hour day month weekday); this one has ${parts.length}`);
  }
  const sets = parts.map((part, i) => parseField(FIELDS[i], part));
  const weekdays = new Set([...sets[4]].map((d) => (d === 7 ? 0 : d)));
  return {
    minutes: sets[0],
    hours: sets[1],
    days: sets[2],
    months: sets[3],
    weekdays,
    anyDay: parts[2] === "*",
    anyWeekday: parts[4] === "*",
  };
}

/** Null when the expression is fine, else why not. */
export function cronError(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Not a cron expression";
  }
}

function dayMatches(cron: Cron, d: Date) {
  const dom = cron.days.has(d.getDate());
  const dow = cron.weekdays.has(d.getDay());
  return !cron.anyDay && !cron.anyWeekday ? dom || dow : dom && dow;
}

/** The next matching local time strictly after `after` (ms), or null. */
export function nextCronAfter(cron: Cron, after: number): number | null {
  const t = new Date(after);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = new Date(after).getFullYear() + SEARCH_YEARS;
  while (t.getFullYear() <= limit) {
    if (!cron.months.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(cron, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1);
      continue;
    }
    // A time skipped by daylight saving lands on another hour: not a match.
    if (t.getTime() > after) return t.getTime();
    t.setMinutes(t.getMinutes() + 1);
  }
  return null;
}

/** The next `count` runs after `after`. */
export function nextCronRuns(expression: string, after: number, count = 3): number[] {
  const cron = parseCron(expression);
  const out: number[] = [];
  let t = after;
  for (let i = 0; i < count; i += 1) {
    const next = nextCronAfter(cron, t);
    if (next === null) break;
    out.push(next);
    t = next;
  }
  return out;
}
