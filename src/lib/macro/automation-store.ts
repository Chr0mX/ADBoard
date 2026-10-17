"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { Device } from "@/lib/devices/types";
import { getWorkspace } from "@/lib/macro/store";
import { isRunning, startRun, stopRun } from "@/lib/macro/runs";
import {
  dueSchedules,
  normalizeQueue,
  normalizeSchedules,
  runQueueItems,
  type MacroSchedule,
  type QueueItem,
  type QueueProgress,
} from "@/lib/macro/automation";

/*
 * Browser state for the macro task queue and scheduler. Only tab ids and
 * times are stored; macros themselves stay in the macro workspace. Every run
 * goes through `startRun`, so device locks, Pause and Stop work the same as
 * the Run button. Each tab plays on its own ticked phones.
 */

const QUEUE_KEY = "adboard-macro-queue";
const SCHEDULE_KEY = "adboard-macro-schedules";
const TICK_MS = 15_000;

const listeners = new Set<() => void>();
let version = 0;
function notify() {
  version += 1;
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === QUEUE_KEY || event.key === SCHEDULE_KEY) {
      cache = null;
      notify();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

let cache: { queue: QueueItem[]; schedules: MacroSchedule[] } | null = null;
function read() {
  if (cache) return cache;
  const parse = (key: string) => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    } catch {
      return [];
    }
  };
  cache = { queue: normalizeQueue(parse(QUEUE_KEY)), schedules: normalizeSchedules(parse(SCHEDULE_KEY)) };
  return cache;
}
function write(next: { queue?: QueueItem[]; schedules?: MacroSchedule[] }) {
  const current = read();
  cache = { queue: next.queue ?? current.queue, schedules: next.schedules ?? current.schedules };
  try {
    if (next.queue) localStorage.setItem(QUEUE_KEY, JSON.stringify(cache.queue));
    if (next.schedules) localStorage.setItem(SCHEDULE_KEY, JSON.stringify(cache.schedules));
  } catch {
    // private mode: kept for this page only
  }
  notify();
}

const EMPTY = { queue: [] as QueueItem[], schedules: [] as MacroSchedule[] };
export function useAutomation() {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return typeof window === "undefined" ? EMPTY : read();
}

const uid = () => Math.random().toString(36).slice(2, 10);

/* ------------------------------ queue ------------------------------ */

export function addToQueue(tabId: string) {
  write({ queue: [...read().queue, { id: uid(), tabId }] });
}
export function removeFromQueue(id: string) {
  write({ queue: read().queue.filter((item) => item.id !== id) });
}
export function moveInQueue(id: string, delta: -1 | 1) {
  const queue = [...read().queue];
  const at = queue.findIndex((item) => item.id === id);
  const to = at + delta;
  if (at < 0 || to < 0 || to >= queue.length) return;
  [queue[at], queue[to]] = [queue[to], queue[at]];
  write({ queue });
}
export function clearQueue() {
  write({ queue: [] });
}

let devicesNow: Device[] = [];
let queueRun: { controller: AbortController; currentTabId: string | null } | null = null;
let queueProgress: QueueProgress | null = null;

export function useQueueProgress() {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return { progress: queueProgress, running: queueRun !== null };
}

function tabDevices(tabId: string) {
  const tab = getWorkspace().tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  return { tab, devices: devicesNow.filter((d) => tab.targetIds.includes(d.id)) };
}

/** Play the queue once, in order. Resolves when it ends; false if already running. */
export async function runQueue(): Promise<boolean> {
  if (queueRun) return false;
  const items = read().queue;
  if (items.length === 0) return false;
  const controller = new AbortController();
  queueRun = { controller, currentTabId: null };
  notify();
  try {
    await runQueueItems({
      items,
      hasTab: (tabId) => tabDevices(tabId) !== null,
      start: (tabId) => {
        const found = tabDevices(tabId);
        if (!found || !queueRun) return Promise.resolve(null);
        queueRun.currentTabId = tabId;
        return startRun(found.tab, found.devices);
      },
      signal: controller.signal,
      onProgress: (progress) => {
        queueProgress = progress;
        notify();
      },
    });
  } finally {
    queueRun = null;
    notify();
  }
  return true;
}

/** Stop the tab playing now and skip the rest of the queue. */
export function stopQueue() {
  if (!queueRun) return;
  queueRun.controller.abort();
  if (queueRun.currentTabId) stopRun(queueRun.currentTabId);
  notify();
}

/* ---------------------------- scheduler ---------------------------- */

export function addSchedule(schedule: Omit<MacroSchedule, "id" | "enabled">) {
  write({ schedules: [...read().schedules, { ...schedule, id: uid(), enabled: true }] });
}
export function patchSchedule(id: string, patch: Partial<MacroSchedule>) {
  write({ schedules: read().schedules.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
}
export function removeSchedule(id: string) {
  write({ schedules: read().schedules.filter((s) => s.id !== id) });
}

/** Start one due schedule now. Exported for the scheduler tick. */
export function fireSchedule(schedule: MacroSchedule, now = Date.now()) {
  let result: string;
  if (schedule.target.kind === "queue") {
    if (queueRun) result = "Skipped: the queue is already playing";
    else if (read().queue.length === 0) result = "Skipped: the queue is empty";
    else {
      void runQueue();
      result = "Started the queue";
    }
  } else {
    const found = tabDevices(schedule.target.tabId);
    if (!found) result = "Skipped: tab was deleted";
    else if (isRunning(found.tab.id)) result = `Skipped: “${found.tab.name}” was already running`;
    else if (!found.devices.some((d) => d.status === "online")) result = `Skipped: no online phone ticked in “${found.tab.name}”`;
    else {
      void startRun(found.tab, found.devices);
      result = `Started “${found.tab.name}”`;
    }
  }
  patchSchedule(schedule.id, { lastRunAt: now, lastResult: result });
}

/**
 * Mount once (Phone control app). Keeps the device list for queue and
 * schedules and checks for due schedules every 15 s. Schedules only run
 * while an ADBoard page is open: the agent has no macro runner of its own.
 */
export function useMacroAutomation(devices: Device[]) {
  useEffect(() => {
    devicesNow = devices;
  }, [devices]);
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      for (const schedule of dueSchedules(read().schedules, now)) fireSchedule(schedule, now);
    };
    const first = window.setTimeout(tick, 1000);
    const timer = window.setInterval(tick, TICK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
}
