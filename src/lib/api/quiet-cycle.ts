"use client";

import { useSyncExternalStore } from "react";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";
import type { QuietPhase } from "@/lib/api/quiet-cycle-core";

/**
 * The repeating Quiet / normal cycle. The agent keeps the settings, the phase
 * and the timing (`/api/quiet-cycle`); this only reads and changes it.
 */

export interface QuietCycleStatus {
  enabled: boolean;
  /** How long phones stay quiet (the quiet duration). */
  intervalSecs: number;
  /** The brief screen-on time between quiet periods, 1 to 5 seconds. */
  peekSecs: number;
  phase: QuietPhase;
  phaseStartedAt: number;
  phaseEndsAt: number;
  /** The agent's clock (unix seconds) when it answered. */
  now: number;
  secondsLeft: number;
}

export interface QuietCycleState {
  status: QuietCycleStatus | null;
  /** `Date.now()` when `status` arrived. */
  receivedAt: number;
}

const POLL_MS = 5000;
let state: QuietCycleState = { status: null, receivedAt: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function publish(status: QuietCycleStatus) {
  state = { status, receivedAt: Date.now() };
  listeners.forEach((listener) => listener());
}

function url(path = "") {
  const base = agentBaseUrl();
  if (base === null) throw new Error("The Quiet Mode Loop needs the ADBoard agent");
  return `${base}/api/quiet-cycle${path}`;
}

async function read(res: Response): Promise<QuietCycleStatus> {
  if (!res.ok) {
    let message = `ADBoard said ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // no body
    }
    throw new Error(message);
  }
  return (await res.json()) as QuietCycleStatus;
}

export async function refreshQuietCycle(): Promise<QuietCycleStatus | null> {
  if (agentBaseUrl() === null) return null;
  try {
    const status = await read(await agentFetch(url(), { cache: "no-store" }));
    publish(status);
    return status;
  } catch {
    return null;
  }
}

export async function startQuietCycle(quietMinutes: number, peekSecs: number) {
  const status = await read(
    await agentFetch(url(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intervalSecs: quietMinutes * 60, peekSecs }),
    }),
  );
  publish(status);
  return status;
}

export async function stopQuietCycle() {
  const status = await read(await agentFetch(url("/stop"), { method: "POST" }));
  publish(status);
  return status;
}

/** The shared cycle state; polls while something shows it. */
export function useQuietCycleState(): QuietCycleState {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      if (listeners.size === 1) {
        void refreshQuietCycle();
        timer = setInterval(() => void refreshQuietCycle(), POLL_MS);
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    () => state,
    () => state,
  );
}
