"use client";

import { useSyncExternalStore } from "react";
import { devicesClient } from "@/lib/api/client";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";
import { createPauseGate, runMacroTab, type MacroTab, type RunDevice, type RunSnapshot } from "@/lib/macro/core";
import type { Device } from "@/lib/devices/types";

/**
 * Live runs, one per tab. A phone belongs to one running tab at a time so two
 * tabs never fight over the same screen.
 */
interface LiveRun {
  tabName: string;
  controller: AbortController;
  snapshot: RunSnapshot;
  claimed: string[];
  gate: ReturnType<typeof createPauseGate>;
}

const runs = new Map<string, LiveRun>();
/** Last result per tab, kept after the run ends. */
const finished = new Map<string, RunSnapshot>();
const owners = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version += 1;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}


function localRunFor(tabId: string): RunSnapshot | null {
  return runs.get(tabId)?.snapshot ?? finished.get(tabId) ?? null;
}

function localIsRunning(tabId: string) {
  return runs.has(tabId);
}

function localRunningTabIds() {
  return [...runs.keys()];
}

/** Tab name currently driving each phone, except `tabId` itself. */
function localBusyPhones(tabId: string): Record<string, string> {
  const busy: Record<string, string> = {};
  for (const [deviceId, owner] of owners) {
    if (owner === tabId) continue;
    const run = runs.get(owner);
    if (run) busy[deviceId] = run.tabName;
  }
  return busy;
}

/* Touch feed: the points each gesture sent, for ripples on live screens. */

export interface MacroTouch {
  id: number;
  tabId: string;
  deviceIds: string[];
  /** 0–1 of each target screen. */
  points: Array<{ x: number; y: number }>;
  at: number;
}

const TOUCH_TTL_MS = 700;
let touchSeq = 0;
let touches: MacroTouch[] = [];
const touchListeners = new Set<() => void>();

function pushTouch(touch: Omit<MacroTouch, "id" | "at">) {
  const at = Date.now();
  touchSeq += 1;
  touches = [...touches.filter((t) => at - t.at < TOUCH_TTL_MS), { ...touch, id: touchSeq, at }];
  touchListeners.forEach((listener) => listener());
  // Drop it again once it has faded.
  setTimeout(() => {
    const now = Date.now();
    const next = touches.filter((t) => now - t.at < TOUCH_TTL_MS);
    if (next.length !== touches.length) {
      touches = next;
      touchListeners.forEach((listener) => listener());
    }
  }, TOUCH_TTL_MS + 20);
}

function subscribeTouches(listener: () => void) {
  touchListeners.add(listener);
  return () => touchListeners.delete(listener);
}

const NO_TOUCHES: MacroTouch[] = [];

/** Macro touches sent to `deviceId` in the last moment (null = any device). */
export function useMacroTouches(deviceId: string | null): MacroTouch[] {
  const all = useSyncExternalStore(subscribeTouches, () => touches, () => NO_TOUCHES);
  if (deviceId === null) return all;
  return all.filter((t) => t.deviceIds.includes(deviceId));
}

function toRunDevice(device: Device): RunDevice {
  return { id: device.id, name: device.name, status: device.status, resolution: device.resolution };
}

/**
 * Start a tab. Resolves with the final snapshot when the run ends (null when
 * the tab is already running), so a queue can wait for it.
 */
function localStartRun(tab: MacroTab, devices: Device[], onlyStepId?: string): Promise<RunSnapshot | null> {
  if (runs.has(tab.id)) return Promise.resolve(null);
  const busy = localBusyPhones(tab.id);
  const controller = new AbortController();
  const claimed = devices.filter((d) => d.status === "online" && !busy[d.id]).map((d) => d.id);
  for (const id of claimed) owners.set(id, tab.id);
  const byId = new Map(devices.map((d) => [d.id, d]));
  const gate = createPauseGate();
  const live: LiveRun = {
    tabName: tab.name,
    controller,
    claimed,
    gate,
    snapshot: {
      status: "running",
      cycle: 1,
      stepIndex: 0,
      stepCount: 0,
      touches: 0,
      startedAt: Date.now(),
      devices: {},
    },
  };
  runs.set(tab.id, live);
  finished.delete(tab.id);
  notify();

  // Snapshot the tab: editing it while it runs changes the next run, not this one.
  const frozen: MacroTab = JSON.parse(JSON.stringify(tab)) as MacroTab;
  return runMacroTab({
    tab: frozen,
    pauseGate: gate,
    devices: devices.map(toRunDevice),
    busy,
    onlyStepId,
    signal: controller.signal,
    onUpdate: (snapshot) => {
      if (controller.signal.aborted && snapshot.status === "running") snapshot.status = "stopping";
      live.snapshot = snapshot;
      notify();
    },
    send: async (targets, strokes) => {
      pushTouch({
        tabId: tab.id,
        deviceIds: targets.map((t) => t.id),
        points: strokes.map((stroke) => stroke.points[stroke.points.length - 1] ?? { x: 0, y: 0 }).concat(
          strokes.filter((stroke) => stroke.points.length > 1).map((stroke) => stroke.points[0]),
        ),
      });
      const result = await devicesClient.sendGesture(
        targets.length > 1 ? "multi" : "selected",
        targets.map((t) => byId.get(t.id)).filter((d): d is Device => Boolean(d)),
        strokes,
      );
      return targets.map((t) => {
        const row = result.targets.find((r) => r.deviceId === t.id);
        return row
          ? { deviceId: t.id, inject: row.inject, detail: row.detail }
          : { deviceId: t.id, inject: "error" as const, detail: "no result from agent" };
      });
    },
  })
    .then((snapshot) => {
      finished.set(tab.id, snapshot);
      return snapshot;
    })
    .catch((error: unknown) => {
      const snapshot: RunSnapshot = {
        ...live.snapshot,
        status: "failed",
        finishedAt: Date.now(),
        message: error instanceof Error ? error.message : "run failed",
      };
      finished.set(tab.id, snapshot);
      return snapshot;
    })
    .finally(() => {
      runs.delete(tab.id);
      for (const id of claimed) if (owners.get(id) === tab.id) owners.delete(id);
      notify();
    });
}

/** Pause before the next step; the run keeps its phones while paused. */
function localPauseRun(tabId: string) {
  const run = runs.get(tabId);
  if (!run || run.controller.signal.aborted || run.gate.paused()) return;
  run.gate.pause();
  notify();
}

function localResumeRun(tabId: string) {
  const run = runs.get(tabId);
  if (!run || !run.gate.paused()) return;
  run.gate.resume();
  notify();
}

/** True from Pause until Resume (the snapshot shows "paused" once the step in flight ends). */
function localIsPaused(tabId: string) {
  return runs.get(tabId)?.gate.paused() ?? false;
}

/** Ask a run to stop after the gesture in flight (which always lifts its fingers). */
function localStopRun(tabId: string) {
  const run = runs.get(tabId);
  if (!run || run.controller.signal.aborted) return;
  run.controller.abort();
  run.snapshot = { ...run.snapshot, status: "stopping" };
  notify();
}

function localStopAllRuns() {
  for (const id of runs.keys()) localStopRun(id);
}

/** Drop the stored result for a deleted tab. */
function localForgetRun(tabId: string) {
  localStopRun(tabId);
  finished.delete(tabId);
  notify();
}


/* ------------------------------------------------------------------ */
/* Agent runs: the run lives on the agent, per phone, so every browser  */
/* sees it and it keeps going when the browser that started it closes. */
/* ------------------------------------------------------------------ */

type AgentRun = RunSnapshot & {
  tabId: string;
  tabName: string;
  touchSeq: number;
  lastPoints: Array<{ x: number; y: number }>;
  lastDeviceIds: string[];
};

interface AgentView {
  version: number;
  runs: AgentRun[];
  paused: string[];
  queue?: unknown;
}

const LIVE = new Set(["running", "paused", "stopping"]);
let view: AgentView = { version: -1, runs: [], paused: [] };
const seenTouch = new Map<string, number>();
let polling = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
const viewListeners = new Set<(view: AgentView) => void>();

const agentMode = () => typeof window !== "undefined" && agentBaseUrl() !== null;
const runsUrl = (path = "") => `${agentBaseUrl() ?? ""}/api/macro/runs${path}`;

function agentRun(tabId: string) {
  return view.runs.find((r) => r.tabId === tabId) ?? null;
}
function agentLive(tabId: string) {
  const run = agentRun(tabId);
  return Boolean(run && LIVE.has(run.status) && run.finishedAt === undefined);
}

/** The agent's latest view (the queue card reads its progress from here). */
export function onAgentView(listener: (view: AgentView) => void) {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

export async function refreshRuns() {
  if (!agentMode()) return;
  try {
    const res = await agentFetch(runsUrl(), { cache: "no-store" });
    if (!res.ok) return;
    const next = (await res.json()) as AgentView;
    for (const run of next.runs) {
      const last = seenTouch.get(run.tabId);
      if (last !== undefined && run.touchSeq > last && run.lastPoints.length > 0) {
        pushTouch({ tabId: run.tabId, deviceIds: run.lastDeviceIds, points: run.lastPoints });
      }
      seenTouch.set(run.tabId, run.touchSeq);
    }
    const changed = JSON.stringify(next) !== JSON.stringify(view);
    view = next;
    viewListeners.forEach((listener) => listener(view));
    if (changed) notify();
  } catch {
    // Agent unreachable: keep the last view.
  }
}

function startPolling() {
  if (polling || !agentMode()) return;
  polling = true;
  const loop = async () => {
    await refreshRuns();
    const busy = view.runs.some((r) => LIVE.has(r.status) && r.finishedAt === undefined);
    const visible = typeof document === "undefined" || document.visibilityState === "visible";
    pollTimer = setTimeout(loop, busy && visible ? 400 : 3000);
  };
  void loop();
  window.addEventListener("focus", () => {
    if (pollTimer) clearTimeout(pollTimer);
    void loop();
  });
}

async function agentPost(path: string, body?: unknown) {
  const res = await agentFetch(runsUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `agent said ${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // keep the status
    }
    throw new Error(message);
  }
  await refreshRuns();
}

async function waitAgentFinished(tabId: string): Promise<RunSnapshot | null> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await refreshRuns();
    if (!agentLive(tabId)) return agentRun(tabId);
  }
}

/* --------------------------- public API --------------------------- */

export function useRunVersion() {
  if (agentMode()) startPolling();
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

export function runFor(tabId: string): RunSnapshot | null {
  return agentMode() ? agentRun(tabId) : localRunFor(tabId);
}

export function isRunning(tabId: string) {
  return agentMode() ? agentLive(tabId) : localIsRunning(tabId);
}

export function runningTabIds() {
  return agentMode() ? view.runs.filter((r) => agentLive(r.tabId)).map((r) => r.tabId) : localRunningTabIds();
}

/** Tab name currently driving each phone, except `tabId` itself. */
export function busyPhones(tabId: string): Record<string, string> {
  if (!agentMode()) return localBusyPhones(tabId);
  const busy: Record<string, string> = {};
  for (const run of view.runs) {
    if (run.tabId === tabId || !agentLive(run.tabId)) continue;
    for (const [deviceId, row] of Object.entries(run.devices)) {
      if (row.state !== "skipped" && row.state !== "busy") busy[deviceId] = run.tabName;
    }
  }
  return busy;
}

/**
 * Start a tab. Resolves with the final snapshot when the run ends (null when
 * it could not start), so a queue can wait for it.
 */
export function startRun(tab: MacroTab, devices: Device[], onlyStepId?: string): Promise<RunSnapshot | null> {
  if (!agentMode()) return localStartRun(tab, devices, onlyStepId);
  startPolling();
  return agentPost("", { tab, deviceIds: devices.map((d) => d.id), onlyStepId })
    .then(() => waitAgentFinished(tab.id))
    .catch((error: unknown) => {
      lastStartError = { tabId: tab.id, message: error instanceof Error ? error.message : "could not start" };
      notify();
      return null;
    });
}

/** Why the last Run press did not start (e.g. already running), for the run card. */
export let lastStartError: { tabId: string; message: string } | null = null;

export function stopRun(tabId: string) {
  if (!agentMode()) return localStopRun(tabId);
  void agentPost(`/${encodeURIComponent(tabId)}/stop`).catch(() => {});
}

export function stopAllRuns() {
  if (!agentMode()) return localStopAllRuns();
  void agentPost(`/all/stop-all`).catch(() => {});
}

export function forgetRun(tabId: string) {
  if (!agentMode()) return localForgetRun(tabId);
  void agentPost(`/${encodeURIComponent(tabId)}/forget`).catch(() => {});
}

export function pauseRun(tabId: string) {
  if (!agentMode()) return localPauseRun(tabId);
  view = { ...view, paused: [...new Set([...view.paused, tabId])] };
  notify();
  void agentPost(`/${encodeURIComponent(tabId)}/pause`).catch(() => {});
}

export function resumeRun(tabId: string) {
  if (!agentMode()) return localResumeRun(tabId);
  view = { ...view, paused: view.paused.filter((id) => id !== tabId) };
  notify();
  void agentPost(`/${encodeURIComponent(tabId)}/resume`).catch(() => {});
}

/** True from Pause until Resume (the snapshot shows "paused" once the step in flight ends). */
export function isPaused(tabId: string) {
  return agentMode() ? view.paused.includes(tabId) : localIsPaused(tabId);
}
