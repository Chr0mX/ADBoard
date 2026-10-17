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
  /**
   * Combine this browser's real data with the agent's copy (nothing dropped).
   * Used when both have data that differ; without it the agent's copy wins.
   * `base` is the last copy this browser and the agent agreed on (null when
   * unknown), so an item deleted on one side is not brought back.
   */
  merge?: (local: unknown, remote: unknown, base: unknown) => unknown;
}

const BACKUP_LIMIT = 5;

/** This browser's copies saved just before another copy replaced them. */
export function readBackups(name: string): Array<{ at: number; value: unknown }> {
  try {
    const raw = localStorage.getItem(`adboard-backups-${name}`);
    const list = raw ? (JSON.parse(raw) as Array<{ at: number; value: unknown }>) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveBackup(name: string, value: unknown) {
  try {
    const list = readBackups(name);
    const raw = JSON.stringify(value);
    if (list[0] && JSON.stringify(list[0].value) === raw) return;
    const next = [{ at: Date.now(), value }, ...list].slice(0, BACKUP_LIMIT);
    localStorage.setItem(`adboard-backups-${name}`, JSON.stringify(next));
  } catch {
    // Storage full: the agent's history still has earlier versions.
  }
}

/** The last copy this browser and the agent agreed on, for three-way merges. */
function readBase(name: string): unknown {
  try {
    const raw = localStorage.getItem(`adboard-sync-base-${name}`);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeBase(name: string, value: unknown) {
  try {
    localStorage.setItem(`adboard-sync-base-${name}`, JSON.stringify(value));
  } catch {
    // Storage full: merges keep everything instead.
    try {
      localStorage.removeItem(`adboard-sync-base-${name}`);
    } catch {
      // ignore
    }
  }
}

const PULL_MS = 10_000;
const PUSH_DELAY_MS = 600;

export function createAgentSync({ name, getLocal, applyRemote: applyRemoteRaw, isMeaningful, merge: mergeRaw }: Options) {
  // Whatever replaces this browser's copy, keep the old one first if it held real data.
  const applyRemote = (value: unknown, agreed = true) => {
    const local = getLocal();
    if (isMeaningful(local) && JSON.stringify(local) !== JSON.stringify(value)) saveBackup(name, local);
    applyRemoteRaw(value);
    if (agreed) writeBase(name, value);
  };
  const merge = mergeRaw && ((local: unknown, remote: unknown) => mergeRaw(local, remote, readBase(name)));
  /** Whether the agent's last known copy holds real data. */
  let serverMeaningful = false;
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
    // A starter (e.g. a phone that only switched the selected tab) must never
    // replace real shared data: take the agent's copy instead.
    if (serverMeaningful && !isMeaningful(getLocal())) {
      dirty = false;
      const shared = await fetchShared();
      if (shared && shared.value !== null && shared.value !== undefined) {
        rev = shared.rev;
        applyRemote(shared.value);
      }
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
        writeBase(name, getLocal());
        serverMeaningful = serverMeaningful || isMeaningful(getLocal());
        setStatus(name, "shared");
      } else if (res.status === 409) {
        // Someone else saved first: show their copy rather than overwrite it.
        const current = (await res.json()) as { value: unknown; rev: number };
        rev = current.rev;
        dirty = false;
        serverMeaningful = isMeaningful(current.value);
        // Keep this browser's edit too: merge onto the newer copy and try again.
        const local = getLocal();
        if (merge && isMeaningful(local) && serverMeaningful) {
          applyRemote(merge(local, current.value), false);
          dirty = true;
        } else {
          applyRemote(current.value);
        }
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
      serverMeaningful = isMeaningful(shared.value);
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
    const local = getLocal();
    const localMeaningful = isMeaningful(local);
    const action = firstSyncAction(shared, localMeaningful);
    rev = shared.rev;
    serverMeaningful = shared.rev > 0 && isMeaningful(shared.value);
    synced = true;
    if (action === "adopt") {
      if (merge && localMeaningful && serverMeaningful && JSON.stringify(local) !== JSON.stringify(shared.value)) {
        // Both sides have real data: keep all of it, then share the result.
        applyRemote(merge(local, shared.value), false);
        await upload();
      } else if (localMeaningful && !serverMeaningful) {
        // The agent only holds a starter: this browser's real data wins.
        await upload();
      } else {
        applyRemote(shared.value);
      }
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
    // Leaving or reloading with an edit still waiting: send it now.
    window.addEventListener("pagehide", () => {
      if (!pushTimer || !synced) return;
      clearTimeout(pushTimer);
      pushTimer = null;
      const local = getLocal();
      if (serverMeaningful && !isMeaningful(local)) return;
      try {
        void agentFetch(url(), {
          method: "PUT",
          keepalive: true,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: local, baseRev: rev }),
        }).catch(() => {});
      } catch {
        // Too large for a keepalive request: the next load merges it.
      }
    });
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
