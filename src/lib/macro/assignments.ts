"use client";

import { useSyncExternalStore } from "react";
import { createAgentSync } from "@/lib/sync/agent-store";

/*
 * Which macro tab each phone plays (deviceId → tabId), chosen in the Phones
 * card. Shared with every browser through the agent (/api/store/macro-assignments),
 * so the choice survives refreshes, reconnects and agent restarts, and
 * POST /api/macro/devices/{id}/start with no body plays it. A cleared choice
 * is stored as "" so it is not brought back by a merge.
 */
export type Assignments = Record<string, string>;

const KEY = "adboard-macro-assignments";
const listeners = new Set<() => void>();
let cache: Assignments | null = null;
let version = 0;

function notify() {
  version += 1;
  listeners.forEach((listener) => listener());
}

export function normalizeAssignments(value: unknown): Assignments {
  const out: Assignments = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [device, tab] of Object.entries(value as Record<string, unknown>)) {
      if (typeof tab === "string") out[device] = tab;
    }
  }
  return out;
}

function store(next: Assignments) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private mode: kept for this page only
  }
  notify();
}

const sync = createAgentSync({
  name: "macro-assignments",
  getLocal: () => read(),
  applyRemote: (value) => store(normalizeAssignments(value)),
  // Both sides kept; this browser's choice wins for a phone set on both.
  merge: (local, remote) => ({ ...normalizeAssignments(remote), ...normalizeAssignments(local) }),
  isMeaningful: (value) => Object.keys(normalizeAssignments(value)).length > 0,
});

function read(): Assignments {
  if (typeof window !== "undefined") sync.start();
  if (cache) return cache;
  try {
    cache = normalizeAssignments(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    cache = {};
  }
  return cache;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) {
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

const NONE: Assignments = {};

export function useAssignments(): Assignments {
  useSyncExternalStore(subscribe, () => version, () => 0);
  return typeof window === "undefined" ? NONE : read();
}

export function assignMacro(deviceId: string, tabId: string | null) {
  store({ ...read(), [deviceId]: tabId ?? "" });
  sync.push();
}

/** Hand this browser's latest choices to the agent now. */
export function flushAssignments() {
  return sync.flush();
}
