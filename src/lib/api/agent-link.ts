"use client";

import { useSyncExternalStore } from "react";
import { agentBaseUrl, agentTokenSync, forgetAgentToken } from "@/lib/api/auth";
import { withTimeout } from "@/lib/api/timeout";
import {
  initialLink,
  nextProbeDelay,
  onInstanceSeen,
  onProbe,
  shouldReload,
  type DeviceReadiness,
  type LinkEvent,
  type LinkState,
  type ProbeResult,
} from "@/lib/api/agent-link-core";

/*
 * The page's one watcher of the agent (see agent-link-core for the rules). Sockets and requests report
 * trouble here; the watcher confirms it with `/api/health`, and tells everyone when the agent is back, or is
 * a new process. The video hub, the phone list and the live socket listen and reconnect at once instead of
 * each waiting out its own backoff.
 */

export type { DeviceReadiness, LinkEvent, LinkState } from "@/lib/api/agent-link-core";

const PROBE_TIMEOUT_MS = 3000;
const RELOAD_KEY = "adboard-recovery-reload-at";

let state: LinkState = initialLink(typeof performance === "undefined" ? 0 : performance.now());
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let probing = false;
let troubleTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(event: LinkEvent, state: LinkState) => void>();
const storeListeners = new Set<() => void>();
const deviceStatus = new Map<string, string>();
let census: (() => { wanted: number; connectedSinceUp: number }) | null = null;

function emit(events: LinkEvent[]) {
  for (const event of events) {
    if (event === "restarted") forgetAgentToken(); // a new process made a new token
    if (event !== "ready") console.info(`[adboard link] agent ${event}${event === "restarted" ? ` (instance ${state.instance})` : ""}`);
    for (const listener of [...listeners]) {
      try {
        listener(event, state);
      } catch (error) {
        console.warn("[adboard link] listener failed", error);
      }
    }
  }
  storeListeners.forEach((listener) => listener());
}

async function probeOnce(): Promise<ProbeResult> {
  const base = agentBaseUrl();
  if (base === null) return { ok: true, instance: null, ready: true };
  const controller = typeof AbortController === "undefined" ? null : new AbortController();
  try {
    // `/api/health`, not `/health`: the service worker never answers /api/ from its cache.
    const request = fetch(`${base}/api/health`, { cache: "no-store", credentials: "include", signal: controller?.signal });
    const res = await withTimeout(request, PROBE_TIMEOUT_MS, () => controller?.abort());
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { instance?: unknown; ready?: unknown };
    return {
      ok: true,
      instance: typeof body.instance === "string" && body.instance ? body.instance : null,
      // An older agent does not say: it is as ready as it will get once it answers.
      ready: typeof body.ready === "boolean" ? body.ready : true,
    };
  } catch {
    return { ok: false };
  }
}

function schedule(delay: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void probe(), delay);
}

async function probe() {
  if (probing) return;
  probing = true;
  if (timer) clearTimeout(timer);
  timer = null;
  try {
    const result = await probeOnce();
    const step = onProbe(state, result, performance.now());
    state = step.state;
    emit(step.events);
    maybeReload();
  } finally {
    probing = false;
    schedule(nextProbeDelay(state));
  }
}

/** Start watching (once per page; nothing happens in the in-browser demo). */
export function startAgentLink() {
  if (started || typeof window === "undefined" || agentBaseUrl() === null) return;
  started = true;
  const now = () => {
    if (document.visibilityState === "visible") reportAgentTrouble(0);
  };
  // Back from the background, a sleeping laptop or a lost network: look at once, timers may have been held back.
  document.addEventListener("visibilitychange", now);
  window.addEventListener("online", () => reportAgentTrouble(0));
  window.addEventListener("pageshow", now);
  document.addEventListener("resume", now);
  void probe();
}

/** A socket closed or a request failed: check the agent now (folded with other reports in the same moment). */
export function reportAgentTrouble(delayMs = 150) {
  if (!started) return;
  if (troubleTimer) return;
  troubleTimer = setTimeout(() => {
    troubleTimer = null;
    void probe();
  }, delayMs);
}

/** A video heartbeat named the agent's process. */
export function reportInstance(instance: string | undefined) {
  if (!instance) return;
  const step = onInstanceSeen(state, instance, performance.now());
  if (step.state === state) return;
  state = step.state;
  emit(step.events);
}

export function onAgentLink(listener: (event: LinkEvent, state: LinkState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function agentLinkState(): LinkState {
  return state;
}

/** The phone list as the agent last sent it (not the page's stale marking): who can be streamed now. */
export function reportFleetStatuses(devices: ReadonlyArray<{ serial: string; status: string }>) {
  const before = [...deviceStatus].join();
  deviceStatus.clear();
  for (const device of devices) deviceStatus.set(device.serial, device.status);
  if ([...deviceStatus].join() === before) return;
  for (const listener of [...fleetListeners]) listener();
}

const fleetListeners = new Set<() => void>();

/** The phone list (as the agent sent it) changed. */
export function onFleetStatuses(listener: () => void): () => void {
  fleetListeners.add(listener);
  return () => fleetListeners.delete(listener);
}

export function deviceReadiness(serial: string): DeviceReadiness {
  const status = deviceStatus.get(serial);
  if (status === undefined) return "unknown";
  return status === "online" ? "online" : "not-online";
}

/** The video hub says how many streams it wants and how many have had a working socket since the agent came back. */
export function registerStreamCensus(read: () => { wanted: number; connectedSinceUp: number }) {
  census = read;
}

function maybeReload() {
  if (!census || typeof window === "undefined") return;
  // Signed out (no token): the sign-in screen is the answer, not a reload.
  if (agentTokenSync() === null) return;
  let lastReloadAt: number | null = null;
  try {
    const raw = window.sessionStorage.getItem(RELOAD_KEY);
    lastReloadAt = raw ? Number(raw) || null : null;
  } catch {
    // no storage: still at most one reload per page life below
  }
  const counts = census();
  const now = Date.now();
  if (
    !shouldReload({
      phase: state.phase,
      ready: state.ready,
      upForMs: performance.now() - state.since,
      wanted: counts.wanted,
      connectedSinceUp: counts.connectedSinceUp,
      lastReloadAt,
      now,
      pageVisible: document.visibilityState === "visible",
    })
  ) {
    return;
  }
  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(now));
  } catch {
    return; // without the guard a reload could repeat: do not risk it
  }
  console.warn(`[adboard link] the agent answers but none of ${counts.wanted} video streams could connect for a minute: reloading the page`);
  window.location.reload();
}

function subscribeStore(listener: () => void) {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

/** The watcher's state for the UI (re-renders on every change). */
export function useAgentLink(): LinkState {
  return useSyncExternalStore(subscribeStore, () => state, () => state);
}
