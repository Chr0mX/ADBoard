"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { Device } from "@/lib/devices/types";
import { flushMacrosToAgent, getWorkspace } from "@/lib/macro/store";
import { isRunning, onAgentView, refreshRuns, startRun, stopRun } from "@/lib/macro/runs";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";
import { createAgentSync } from "@/lib/sync/agent-store";
import { mergeById } from "@/lib/sync/decide";
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
 * Macro task queue and scheduler. Only tab ids and times are stored, shared
 * with every browser through the agent (/api/store/macro-queue and
 * /macro-schedules). With an agent, the queue and the schedules run ON the
 * agent (they keep going with no browser open and never double-fire); only
 * the in-browser mock (no agent) still runs them here. Each tab plays on its
 * own ticked phones.
 */
const viaAgent = () => typeof window !== "undefined" && agentBaseUrl() !== null;

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

function applyShared(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value ?? []));
  } catch {
    // kept in memory below
  }
  cache = null;
  notify();
}
const queueSync = createAgentSync({
  name: "macro-queue",
  getLocal: () => read().queue,
  applyRemote: (value) => applyShared(QUEUE_KEY, normalizeQueue(value)),
  merge: (local, remote, base) => mergeById(normalizeQueue(local), normalizeQueue(remote), base ? normalizeQueue(base) : null),
  isMeaningful: (value) => Array.isArray(value) && value.length > 0,
});
const scheduleSync = createAgentSync({
  name: "macro-schedules",
  getLocal: () => read().schedules,
  applyRemote: (value) => applyShared(SCHEDULE_KEY, normalizeSchedules(value)),
  merge: (local, remote, base) => mergeById(normalizeSchedules(local), normalizeSchedules(remote), base ? normalizeSchedules(base) : null),
  isMeaningful: (value) => Array.isArray(value) && value.length > 0,
});

function read() {
  if (typeof window !== "undefined") {
    queueSync.start();
    scheduleSync.start();
  }
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
  if (next.queue) queueSync.push();
  if (next.schedules) scheduleSync.push();
  notify();
}

/** Wait (briefly) until the agent's queue and schedules have been loaded. */
export function automationReady() {
  read();
  return Promise.all([queueSync.ready(), scheduleSync.ready()]).then(() => undefined);
}

/** Queue and schedules as stored (whole-library export/import). */
export function getAutomation() {
  return read();
}
export function setAutomation(next: { queue: QueueItem[]; schedules: MacroSchedule[] }) {
  write({ queue: normalizeQueue(next.queue), schedules: normalizeSchedules(next.schedules) });
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

/* Agent queue progress, from the runs poll (GET /api/macro/runs). */
let agentQueue: QueueProgress | null = null;
if (typeof window !== "undefined") {
  onAgentView((view) => {
    const next = (view.queue ?? null) as QueueProgress | null;
    if (JSON.stringify(next) !== JSON.stringify(agentQueue)) {
      agentQueue = next;
      notify();
    }
  });
}

export function useQueueProgress() {
  useSyncExternalStore(subscribe, () => version, () => 0);
  if (viaAgent()) return { progress: agentQueue, running: Boolean(agentQueue?.running) };
  return { progress: queueProgress, running: queueRun !== null };
}

async function queueAction(action: "run" | "stop") {
  const res = await agentFetch(`${agentBaseUrl() ?? ""}/api/macro/queue/${action}`, { method: "POST" });
  await refreshRuns();
  return res.ok;
}

function tabDevices(tabId: string) {
  const tab = getWorkspace().tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  return { tab, devices: devicesNow.filter((d) => tab.targetIds.includes(d.id)) };
}

/** Play the queue once, in order. Resolves when it ends; false if already running. */
export async function runQueue(): Promise<boolean> {
  if (viaAgent()) {
    // The agent plays what it has: hand it this browser's latest edits first.
    await Promise.all([queueSync.flush(), flushMacrosToAgent()]);
    return queueAction("run");
  }
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
  if (viaAgent()) {
    void queueAction("stop");
    return;
  }
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
    // With an agent, schedules fire on the agent (no browser needed).
    if (viaAgent()) return;
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
