"use client";

import { useSyncExternalStore } from "react";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";
import { firstSyncAction } from "@/lib/sync/decide";

/*
 * Keeps a browser store (macros, Automate library, queue, schedules) in step
 * with the agent's shared copy (/api/store/{name}), so every browser on this
 * ADBoard sees the same data. localStorage stays as the offline cache.
 */

export type SyncState = "pending" | "shared" | "local" | "conflict";

const statusListeners = new Set<() => void>();
const statuses = new Map<string, { state: SyncState; message?: string }>();
function setStatus(name: string, state: SyncState, message?: string) {
  statuses.set(name, { state, message });
  statusListeners.forEach((listener) => listener());
}
const PENDING: { state: SyncState; message?: string } = { state: "pending" };
export function useSyncStatus(name: string) {
  return useSyncExternalStore(
    (onChange) => {
      statusListeners.add(onChange);
      return () => statusListeners.delete(onChange);
    },
    () => statuses.get(name) ?? PENDING,
    () => PENDING,
  );
}

interface Options {
  name: string;
  /** The browser's current value (what gets uploaded). */
  getLocal: () => unknown;
  /** Replace the browser's copy with the shared one, without pushing back. */
  applyRemote: (value: unknown) => void;
  /** False for an untouched starter, which must never overwrite shared data. */
  isMeaningful: (value: unknown) => boolean;
}

const PULL_MS = 10_000;
const PUSH_DELAY_MS = 600;

export function createAgentSync({ name, getLocal, applyRemote, isMeaningful }: Options) {
  let started = false;
  let synced = false;
  let rev = 0;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let inflight = false;
  let dirty = false;

  const url = () => `${agentBaseUrl() ?? ""}/api/store/${name}`;
  const enabled = () => typeof window !== "undefined" && agentBaseUrl() !== null;

  async function fetchShared(): Promise<{ value: unknown; rev: number } | null> {
    try {
      const res = await agentFetch(url(), { cache: "no-store" });
      if (!res.ok) return null;
      return (await res.json()) as { value: unknown; rev: number };
    } catch {
      return null;
    }
  }

  async function upload() {
    if (inflight) {
      dirty = true;
      return;
    }
    inflight = true;
    dirty = false;
    try {
      const res = await agentFetch(url(), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: getLocal(), baseRev: rev }),
      });
      if (res.ok) {
        rev = ((await res.json()) as { rev: number }).rev;
        setStatus(name, "shared");
      } else if (res.status === 409) {
        // Someone else saved first: show their copy rather than overwrite it.
        const current = (await res.json()) as { value: unknown; rev: number };
        rev = current.rev;
        dirty = false;
        applyRemote(current.value);
        setStatus(name, "conflict", "Changed in another browser; showing the latest");
      } else {
        setStatus(name, "local", `Saved in this browser only (agent said ${res.status})`);
      }
    } catch {
      setStatus(name, "local", "Saved in this browser only (agent not reachable)");
    } finally {
      inflight = false;
      if (dirty) void upload();
    }
  }

  async function pull() {
    if (!synced || inflight || pushTimer) return;
    const shared = await fetchShared();
    if (!shared) {
      setStatus(name, "local", "Saved in this browser only (agent not reachable)");
      return;
    }
    if (shared.rev > rev && !inflight && !pushTimer) {
      rev = shared.rev;
      if (shared.value !== null && shared.value !== undefined) applyRemote(shared.value);
    }
    if (statuses.get(name)?.state !== "conflict") setStatus(name, "shared");
  }

  async function firstSync() {
    const shared = await fetchShared();
    if (!shared) {
      setStatus(name, "local", "Saved in this browser only (agent not reachable)");
      // Try again later; until then edits stay local.
      setTimeout(() => void firstSync(), PULL_MS);
      return;
    }
    const action = firstSyncAction(shared, isMeaningful(getLocal()));
    rev = shared.rev;
    synced = true;
    if (action === "adopt") {
      applyRemote(shared.value);
      setStatus(name, "shared");
    } else if (action === "upload" || dirty) {
      await upload();
    } else {
      setStatus(name, "shared");
    }
  }

  function start() {
    if (started || !enabled()) return;
    started = true;
    void firstSync();
    const onVisible = () => {
      if (document.visibilityState === "visible") void pull();
    };
    window.addEventListener("focus", () => void pull());
    document.addEventListener("visibilitychange", onVisible);
    setInterval(() => {
      if (document.visibilityState === "visible") void pull();
    }, PULL_MS);
  }

  /** Call after every local save. */
  function push() {
    if (!enabled()) return;
    start();
    if (!synced) {
      dirty = true;
      return;
    }
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void upload();
    }, PUSH_DELAY_MS);
  }

  /** Upload a pending edit now (before asking the agent to use the data). */
  async function flush() {
    if (!enabled()) return;
    start();
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
      await upload();
    }
    while (inflight) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return { start, push, pull, flush };
}
