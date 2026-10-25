"use client";

import { useSyncExternalStore } from "react";
import { agentBaseUrl, agentFetch } from "@/lib/api/auth";

/**
 * Event history and Discord notifications, kept by the agent
 * (`/api/events`, `/api/notifications`). The browser never sees the webhook
 * URL: only whether one is set.
 */

export type Severity = "debug" | "info" | "warning" | "error" | "critical";
export const SEVERITIES: Severity[] = ["debug", "info", "warning", "error", "critical"];

export type EventCategory = "device" | "macro" | "app" | "scrcpy" | "adb" | "system" | "notification";

export const CATEGORY_LABEL: Record<EventCategory, string> = {
  device: "Phones",
  macro: "Macros",
  app: "Apps & installs",
  scrcpy: "Live screen",
  adb: "ADB",
  system: "ADBoard",
  notification: "Notifications",
};

export interface AppEvent {
  id: number;
  at: number;
  category: EventCategory;
  kind: string;
  severity: Severity;
  deviceId?: string;
  deviceName?: string;
  source: string;
  summary: string;
  detail?: string;
  runId?: string;
  meta?: Record<string, unknown>;
  /** Identical events folded into this one. */
  repeats?: number;
  lastAt?: number;
}

export interface EventQuery {
  q?: string;
  /** Lowest severity shown. */
  severity?: Severity;
  category?: string;
  device?: string;
  run?: string;
  since?: number;
  until?: number;
  before?: number;
  limit?: number;
}

export interface EventPage {
  events: AppEvent[];
  total: number;
  hasMore: boolean;
  nextBefore?: number;
}

export interface EventSummary {
  since: number;
  total: number;
  latestId: number;
  bySeverity: Partial<Record<Severity, number>>;
  byCategory: Partial<Record<EventCategory, number>>;
  macroRuns: { done: number; failed: number; stopped: number };
  problemDevices: Record<string, number>;
  recentProblems: AppEvent[];
}

export type NotifyLevel = "off" | "info" | "warning" | "error" | "critical";

export interface Retention {
  maxEvents: number;
  /** 0 keeps events until maxEvents pushes them out. */
  maxDays: number;
}

export interface DeliveryStatus {
  lastAttemptAt?: number;
  lastOkAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  sent: number;
  failed: number;
  dropped: number;
  suppressed: number;
  queued: number;
}

export interface NotificationSettings {
  enabled: boolean;
  webhookSet: boolean;
  /** Last digits of the webhook id, e.g. "…5678". */
  webhookHint?: string;
  categories: Partial<Record<EventCategory, NotifyLevel>>;
  detail: "brief" | "full";
  cooldownSecs: number;
  /** 0 sends every drop; else only phones offline this long (and their return). */
  offlineAlertMins: number;
  history: Retention;
  status: DeliveryStatus;
}

export interface MacroStats {
  name: string;
  tabId?: string;
  runs: number;
  done: number;
  failed: number;
  stopped: number;
  /** done / runs, 0–1. */
  successRate: number;
  /** Average length of finished runs. */
  avgSeconds?: number;
  lastAt: number;
  lastStatus: "done" | "failed" | "stopped";
  /** The steps that fail most (up to 3). */
  failingSteps: Array<{ step?: number; count: number; lastReason: string }>;
  failedPhones: Record<string, number>;
}

export type NotificationUpdate = Partial<Omit<NotificationSettings, "webhookSet" | "webhookHint" | "status">> & {
  /** "" removes the webhook. */
  webhookUrl?: string;
};

export const NO_AGENT = "Event history and notifications need the ADBoard agent";

function base() {
  const url = agentBaseUrl();
  if (url === null) throw new Error(NO_AGENT);
  return url;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `ADBoard said ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      message = body.error ?? message;
    } catch {
      // keep the status
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function hasAgent() {
  return agentBaseUrl() !== null;
}

export async function fetchEvents(query: EventQuery): Promise<EventPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "" && value !== null) params.set(key, String(value));
  }
  return json(await agentFetch(`${base()}/api/events?${params}`, { cache: "no-store" }));
}

export async function fetchSummary(since: number): Promise<EventSummary> {
  return json(await agentFetch(`${base()}/api/events/summary?since=${since}`, { cache: "no-store" }));
}

/** Per-macro run results since `since`, worst first. */
export async function fetchMacroStats(since: number): Promise<MacroStats[]> {
  return json(await agentFetch(`${base()}/api/events/macros?since=${since}`, { cache: "no-store" }));
}

export async function clearEvents(before?: number): Promise<{ removed: number }> {
  return json(
    await agentFetch(`${base()}/api/events/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(before ? { before } : {}),
    }),
  );
}

export async function fetchNotifications(): Promise<NotificationSettings> {
  return json(await agentFetch(`${base()}/api/notifications`, { cache: "no-store" }));
}

export async function saveNotifications(update: NotificationUpdate): Promise<NotificationSettings> {
  return json(
    await agentFetch(`${base()}/api/notifications`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }),
  );
}

/** Send a test message (to `webhookUrl` before saving it, else the saved one). */
export async function testNotification(webhookUrl?: string): Promise<string> {
  const res = await agentFetch(`${base()}/api/notifications/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(webhookUrl ? { webhookUrl } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? `ADBoard said ${res.status}`);
  return body.message ?? "Sent";
}

/* --------------------- unseen problems (header badge) --------------------- */

const SEEN_KEY = "adboard-events-seen";
const POLL_MS = 30_000;

interface Alerts {
  /** Warnings and errors newer than the last visit to Events. */
  unseen: number;
  worst: Severity | null;
  latestId: number;
}

let alerts: Alerts = { unseen: 0, worst: null, latestId: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function readSeen() {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

async function poll() {
  try {
    const summary = await fetchSummary(Date.now() - 7 * 86_400_000);
    const seen = readSeen();
    const fresh = summary.recentProblems.filter((e) => e.id > seen);
    const rank = (s: Severity) => SEVERITIES.indexOf(s);
    const worst = fresh.reduce<Severity | null>((w, e) => (w === null || rank(e.severity) > rank(w) ? e.severity : w), null);
    const next = { unseen: fresh.length, worst, latestId: summary.latestId };
    if (JSON.stringify(next) !== JSON.stringify(alerts)) {
      alerts = next;
      listeners.forEach((l) => l());
    }
  } catch {
    // Agent unreachable: keep the last count.
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer && hasAgent()) {
    const loop = async () => {
      if (document.visibilityState === "visible") await poll();
      timer = setTimeout(loop, POLL_MS);
    };
    void loop();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** Recent problems not yet looked at (up to 5), for the Events tab. */
export function useEventAlerts(): Alerts {
  return useSyncExternalStore(subscribe, () => alerts, () => alerts);
}

/** The user looked at everything up to `latestId`. */
export function markEventsSeen(latestId: number) {
  try {
    localStorage.setItem(SEEN_KEY, String(Math.max(latestId, readSeen())));
  } catch {
    // private mode: the badge just stays
  }
  if (alerts.unseen !== 0) {
    alerts = { ...alerts, unseen: 0, worst: null };
    listeners.forEach((l) => l());
  }
}
