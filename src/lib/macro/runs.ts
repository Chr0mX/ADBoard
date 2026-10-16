"use client";

import { useSyncExternalStore } from "react";
import { devicesClient } from "@/lib/api/client";
import { runMacroTab, type MacroTab, type RunDevice, type RunSnapshot } from "@/lib/macro/core";
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

export function useRunVersion() {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

export function runFor(tabId: string): RunSnapshot | null {
  return runs.get(tabId)?.snapshot ?? finished.get(tabId) ?? null;
}

export function isRunning(tabId: string) {
  return runs.has(tabId);
}

export function runningTabIds() {
  return [...runs.keys()];
}

/** Tab name currently driving each phone, except `tabId` itself. */
export function busyPhones(tabId: string): Record<string, string> {
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

export function startRun(tab: MacroTab, devices: Device[], onlyStepId?: string) {
  if (runs.has(tab.id)) return;
  const busy = busyPhones(tab.id);
  const controller = new AbortController();
  const claimed = devices.filter((d) => d.status === "online" && !busy[d.id]).map((d) => d.id);
  for (const id of claimed) owners.set(id, tab.id);
  const byId = new Map(devices.map((d) => [d.id, d]));
  const live: LiveRun = {
    tabName: tab.name,
    controller,
    claimed,
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
  void runMacroTab({
    tab: frozen,
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
    })
    .catch((error: unknown) => {
      finished.set(tab.id, {
        ...live.snapshot,
        status: "failed",
        finishedAt: Date.now(),
        message: error instanceof Error ? error.message : "run failed",
      });
    })
    .finally(() => {
      runs.delete(tab.id);
      for (const id of claimed) if (owners.get(id) === tab.id) owners.delete(id);
      notify();
    });
}

/** Ask a run to stop after the gesture in flight (which always lifts its fingers). */
export function stopRun(tabId: string) {
  const run = runs.get(tabId);
  if (!run || run.controller.signal.aborted) return;
  run.controller.abort();
  run.snapshot = { ...run.snapshot, status: "stopping" };
  notify();
}

export function stopAllRuns() {
  for (const id of runs.keys()) stopRun(id);
}

/** Drop the stored result for a deleted tab. */
export function forgetRun(tabId: string) {
  stopRun(tabId);
  finished.delete(tabId);
  notify();
}
