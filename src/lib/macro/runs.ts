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
  /** The phone this run drives (one run per phone). */
  deviceId: string;
  deviceName: string;
  tabId: string;
  tabName: string;
  touchSeq: number;
  lastPoints: Array<{ x: number; y: number }>;
  lastDeviceIds: string[];
};

interface AgentView {
  version: number;
  runs: AgentRun[];
  /** Phones whose run is paused. */
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
const deviceUrl = (deviceId: string, action: string) =>
  `${agentBaseUrl() ?? ""}/api/macro/devices/${encodeURIComponent(deviceId)}/${action}`;

const isLive = (run: AgentRun) => LIVE.has(run.status) && run.finishedAt === undefined;

function tabRuns(tabId: string) {
  const all = view.runs.filter((r) => r.tabId === tabId);
  const live = all.filter(isLive);
  if (live.length === 0) return all;
  // While it runs, leave out phones' results from earlier runs of this tab.
  const since = Math.min(...live.map((r) => r.startedAt)) - 5000;
  return all.filter((r) => isLive(r) || r.startedAt >= since);
}

/** One snapshot for a tab played on several phones (each phone has its own run). */
function combine(list: AgentRun[]): RunSnapshot | null {
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  const live = list.filter(isLive);
  const lead = live[0] ?? list[0];
  let status: RunSnapshot["status"];
  if (live.length > 0) {
    if (live.every((r) => r.status === "stopping")) status = "stopping";
    else if (live.every((r) => r.status === "paused")) status = "paused";
    else status = "running";
  } else if (list.some((r) => r.status === "done")) status = "done";
  else if (list.some((r) => r.status === "stopped")) status = "stopped";
  else status = "failed";
  const notes = list
    .filter((r) => r.message && (live.length === 0 ? r.status !== "done" : !isLive(r)))
    .map((r) => `${r.deviceName}: ${r.message}`);
  const devices: RunSnapshot["devices"] = {};
  for (const r of list) Object.assign(devices, r.devices);
  return {
    status,
    cycle: Math.max(...list.map((r) => r.cycle)),
    stepIndex: lead.stepIndex,
    stepCount: Math.max(...list.map((r) => r.stepCount)),
    touches: list.reduce((sum, r) => sum + r.touches, 0),
    startedAt: Math.min(...list.map((r) => r.startedAt)),
    finishedAt: live.length > 0 ? undefined : Math.max(...list.map((r) => r.finishedAt ?? 0)),
    deadline: lead.deadline,
    message: notes.length > 0 ? notes.join(" · ") : lead.message,
    devices,
  };
}

/** Phones a tab's last Run press skipped (busy in another tab, offline), shown with its run. */
const skippedRows = new Map<string, RunSnapshot["devices"]>();

function withSkipped(tabId: string, snapshot: RunSnapshot | null): RunSnapshot | null {
  const skipped = skippedRows.get(tabId);
  if (!snapshot || !skipped) return snapshot;
  return { ...snapshot, devices: { ...skipped, ...snapshot.devices } };
}

function agentLive(tabId: string) {
  return view.runs.some((r) => r.tabId === tabId && isLive(r));
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
      const key = `${run.deviceId}:${run.startedAt}`;
      const last = seenTouch.get(key);
      if (last !== undefined && run.touchSeq > last && run.lastPoints.length > 0) {
        pushTouch({ tabId: run.tabId, deviceIds: run.lastDeviceIds, points: run.lastPoints });
      }
      seenTouch.set(key, run.touchSeq);
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
    const busy = view.runs.some(isLive);
    const visible = typeof document === "undefined" || document.visibilityState === "visible";
    pollTimer = setTimeout(loop, busy && visible ? 400 : 3000);
  };
  void loop();
  window.addEventListener("focus", () => {
    if (pollTimer) clearTimeout(pollTimer);
    void loop();
  });
}

async function agentPostUrl<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await agentFetch(url, {
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
  const data = (await res.json().catch(() => ({}))) as T;
  await refreshRuns();
  return data;
}

const agentPost = <T = unknown>(path: string, body?: unknown) => agentPostUrl<T>(runsUrl(path), body);

/** Wait until none of `deviceIds` is running; the combined result of their runs. */
async function waitAgentFinished(deviceIds: string[]): Promise<RunSnapshot | null> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await refreshRuns();
    const mine = view.runs.filter((r) => deviceIds.includes(r.deviceId));
    if (!mine.some(isLive)) return combine(mine);
  }
}

/* --------------------------- public API --------------------------- */

export function useRunVersion() {
  if (agentMode()) startPolling();
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

export function runFor(tabId: string): RunSnapshot | null {
  return agentMode() ? withSkipped(tabId, combine(tabRuns(tabId))) : localRunFor(tabId);
}

export function isRunning(tabId: string) {
  return agentMode() ? agentLive(tabId) : localIsRunning(tabId);
}

export function runningTabIds() {
  return agentMode() ? [...new Set(view.runs.filter(isLive).map((r) => r.tabId))] : localRunningTabIds();
}

/** Tab name currently driving each phone, except `tabId` itself. */
export function busyPhones(tabId: string): Record<string, string> {
  if (!agentMode()) return localBusyPhones(tabId);
  const busy: Record<string, string> = {};
  for (const run of view.runs) {
    if (run.tabId !== tabId && isLive(run)) busy[run.deviceId] = run.tabName;
  }
  return busy;
}

/**
 * Start a tab on its phones: one independent run per phone (phones already
 * running are skipped). Resolves with the combined final snapshot when every
 * phone has finished (null when none could start), so a queue can wait for it.
 */
export function startRun(tab: MacroTab, devices: Device[], onlyStepId?: string): Promise<RunSnapshot | null> {
  if (!agentMode()) return localStartRun(tab, devices, onlyStepId);
  startPolling();
  if (lastStartError?.tabId === tab.id) lastStartError = null;
  skippedRows.delete(tab.id);
  return agentPost<{ started?: string[]; skipped?: RunSnapshot["devices"] }>("", { tab, deviceIds: devices.map((d) => d.id), onlyStepId })
    .then((data) => {
      if (data.skipped && Object.keys(data.skipped).length > 0) {
        skippedRows.set(tab.id, data.skipped);
        notify();
      }
      return waitAgentFinished(data.started ?? devices.map((d) => d.id));
    })
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

function liveDevicesOf(tabId: string) {
  return view.runs.filter((r) => r.tabId === tabId && isLive(r)).map((r) => r.deviceId);
}

export function pauseRun(tabId: string) {
  if (!agentMode()) return localPauseRun(tabId);
  view = { ...view, paused: [...new Set([...view.paused, ...liveDevicesOf(tabId)])] };
  notify();
  void agentPost(`/${encodeURIComponent(tabId)}/pause`).catch(() => {});
}

export function resumeRun(tabId: string) {
  if (!agentMode()) return localResumeRun(tabId);
  const ids = liveDevicesOf(tabId);
  view = { ...view, paused: view.paused.filter((id) => !ids.includes(id)) };
  notify();
  void agentPost(`/${encodeURIComponent(tabId)}/resume`).catch(() => {});
}

/** True from Pause until Resume (the snapshot shows "paused" once the step in flight ends). */
export function isPaused(tabId: string) {
  if (!agentMode()) return localIsPaused(tabId);
  const ids = liveDevicesOf(tabId);
  return ids.length > 0 && ids.every((id) => view.paused.includes(id));
}

/* ------------------------- per-phone runs ------------------------- */

export interface PhoneRun extends RunSnapshot {
  deviceId: string;
  tabId: string;
  tabName: string;
  live: boolean;
  paused: boolean;
}

/** Errors from the last Start press per phone (e.g. already running, offline). */
const phoneErrors = new Map<string, string>();

export function phoneStartError(deviceId: string) {
  return phoneErrors.get(deviceId) ?? null;
}

/** A phone's live run, else its last finished run. */
export function phoneRun(deviceId: string): PhoneRun | null {
  if (agentMode()) {
    const run = view.runs.find((r) => r.deviceId === deviceId);
    if (!run) return null;
    return { ...run, live: isLive(run), paused: view.paused.includes(deviceId) };
  }
  // In-browser fallback: runs are per tab, so report the tab driving this phone.
  const tabId = owners.get(deviceId);
  const live = tabId ? runs.get(tabId) : undefined;
  if (!tabId || !live) return null;
  return { ...live.snapshot, deviceId, tabId, tabName: live.tabName, live: true, paused: live.gate.paused() };
}

/** Start `tab` on one phone; the agent refuses (409) when that phone is already running. */
export async function startPhone(device: Device, tab: MacroTab, onlyStepId?: string): Promise<boolean> {
  phoneErrors.delete(device.id);
  if (!agentMode()) {
    if (owners.has(device.id) || runs.has(tab.id)) {
      phoneErrors.set(device.id, "Already running (in-browser runs are per tab)");
      notify();
      return false;
    }
    void localStartRun(tab, [device], onlyStepId);
    return true;
  }
  startPolling();
  try {
    await agentPostUrl(deviceUrl(device.id, "start"), { tab, onlyStepId });
    return true;
  } catch (error) {
    phoneErrors.set(device.id, error instanceof Error ? error.message : "could not start");
    notify();
    return false;
  }
}

function phoneAction(deviceId: string, action: "stop" | "pause" | "resume") {
  if (!agentMode()) {
    const tabId = owners.get(deviceId);
    if (!tabId) return;
    if (action === "stop") localStopRun(tabId);
    else if (action === "pause") localPauseRun(tabId);
    else localResumeRun(tabId);
    return;
  }
  if (action === "pause") view = { ...view, paused: [...new Set([...view.paused, deviceId])] };
  if (action === "resume") view = { ...view, paused: view.paused.filter((id) => id !== deviceId) };
  notify();
  void agentPostUrl(deviceUrl(deviceId, action)).catch(() => {});
}

export const stopPhone = (deviceId: string) => phoneAction(deviceId, "stop");
export const pausePhone = (deviceId: string) => phoneAction(deviceId, "pause");
export const resumePhone = (deviceId: string) => phoneAction(deviceId, "resume");
