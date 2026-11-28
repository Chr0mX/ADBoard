/**
 * Is the ADBoard agent there, and is it still the same process?
 *
 * Every socket of the page (12 video streams, the phone list, audio, clipboard) used to find out on its own
 * that the agent had gone, and each retried on its own backoff, up to 8 s apart. After run.bat was closed and
 * opened again the page came back late, one socket at a time, or not at all for a socket whose state was
 * left over from the old process. One watcher now answers for the whole page:
 *
 * - `down`: a probe of `/api/health` failed (or never answered). Sockets stop knocking; the watcher probes
 *   with a short, growing, jittered delay (at most 2 s) so the agent is noticed soon after it is back.
 * - `up`: the agent answered. If it answers with another `instance` than before, the agent restarted: the
 *   old token and sessions are gone, so every socket reconnects at once and the phone list is read again.
 * - `ready`: the agent has looked at the phones once (adb answered). Before that its list can be empty or
 *   show every phone offline, and a video socket opened then is refused.
 *
 * Pure module: runs under `node --test`.
 */

export type LinkPhase = "unknown" | "up" | "down";

export interface LinkState {
  phase: LinkPhase;
  /** The agent process last seen (from `/api/health` or a video heartbeat); null before the first answer. */
  instance: string | null;
  ready: boolean;
  /** When the current phase began (ms). */
  since: number;
  /** Failed probes in a row. */
  failures: number;
  /** Times the agent was found to have restarted, and outages seen, since the page loaded. */
  restarts: number;
  outages: number;
}

export type LinkEvent = "down" | "up" | "restarted" | "ready";

export function initialLink(now: number): LinkState {
  return { phase: "unknown", instance: null, ready: false, since: now, failures: 0, restarts: 0, outages: 0 };
}

export type ProbeResult = { ok: true; instance: string | null; ready: boolean } | { ok: false };

/** A probe answered (or failed): the next state and what changed. */
export function onProbe(state: LinkState, result: ProbeResult, now: number): { state: LinkState; events: LinkEvent[] } {
  const events: LinkEvent[] = [];
  if (!result.ok) {
    if (state.phase === "down") return { state: { ...state, failures: state.failures + 1 }, events };
    events.push("down");
    return {
      state: { ...state, phase: "down", since: now, failures: 1, ready: false, outages: state.outages + (state.phase === "up" ? 1 : 0) },
      events,
    };
  }
  let next: LinkState = { ...state, failures: 0 };
  // An older agent has no instance id: it can only be told apart by the outage.
  const restarted = result.instance !== null && state.instance !== null && result.instance !== state.instance;
  if (result.instance !== null) next.instance = result.instance;
  if (state.phase !== "up") {
    next = { ...next, phase: "up", since: now };
    events.push("up");
  }
  if (restarted) {
    next.restarts += 1;
    events.push("restarted");
  }
  // An agent that does not report readiness (older) counts as ready once it answers.
  const ready = result.ready;
  if (ready && (!state.ready || restarted)) events.push("ready");
  next.ready = ready;
  return { state: next, events };
}

/** A video heartbeat named the agent process: a different one means it restarted. */
export function onInstanceSeen(state: LinkState, instance: string, now: number): { state: LinkState; events: LinkEvent[] } {
  if (!instance || instance === state.instance) return { state, events: [] };
  return onProbe(state, { ok: true, instance, ready: state.ready || state.instance === null }, now);
}

/** Probe again after this long: often while the agent is away, rarely while it answers. */
export const UP_PROBE_MS = 15_000;
export const DOWN_PROBE_MIN_MS = 500;
export const DOWN_PROBE_MAX_MS = 2000;
/** Up but not ready yet: look again soon, the phone list is about to change. */
export const NOT_READY_PROBE_MS = 1000;

export function nextProbeDelay(state: LinkState, random: () => number = Math.random): number {
  if (state.phase === "up") return state.ready ? UP_PROBE_MS : NOT_READY_PROBE_MS;
  const ceiling = Math.min(DOWN_PROBE_MAX_MS, DOWN_PROBE_MIN_MS * 1.5 ** Math.max(0, state.failures - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * May a video stream open its socket now? Not while the agent is known to be away, and not for a phone the
 * agent lists as not online (the socket would be refused and wait 3 to 10 s before trying again). A phone
 * the list does not know is tried (a macro preview, a remote phone the list has not shown yet), and so is any
 * phone that has waited longer than `GATE_MAX_WAIT_MS`, in case the list is what is wrong.
 */
export const GATE_MAX_WAIT_MS = 20_000;

export type DeviceReadiness = "online" | "not-online" | "unknown";

export function mayConnect(phase: LinkPhase, device: DeviceReadiness, waitedMs: number): boolean {
  if (waitedMs >= GATE_MAX_WAIT_MS) return true;
  if (phase === "down") return false;
  return device !== "not-online";
}

/**
 * Spread a burst of reconnects (every phone at once after a restart) over a short window, so the agent is
 * not asked to start a dozen streams in the same millisecond.
 */
export function reconnectSpreadMs(index: number, random: () => number = Math.random): number {
  return Math.round(index * 60 + random() * 120);
}

/**
 * The last resort: the agent answers and is ready, yet no stream of this page has managed to open its socket
 * for a long while. Something in the page is stuck that reconnecting does not fix; reload it, but not more
 * than once per `RELOAD_EVERY_MS` (kept in sessionStorage, so it survives the reload).
 */
export const RELOAD_AFTER_MS = 60_000;
export const RELOAD_EVERY_MS = 10 * 60_000;

export function shouldReload(input: {
  phase: LinkPhase;
  ready: boolean;
  /** How long the agent has been answering. */
  upForMs: number;
  /** Streams this page wants, and how many of them have had a working socket since the agent came back. */
  wanted: number;
  connectedSinceUp: number;
  /** When this page last reloaded itself for this reason (ms), or null. */
  lastReloadAt: number | null;
  now: number;
  pageVisible: boolean;
}): boolean {
  if (input.phase !== "up" || !input.ready || !input.pageVisible) return false;
  if (input.wanted === 0 || input.connectedSinceUp > 0) return false;
  if (input.upForMs < RELOAD_AFTER_MS) return false;
  return input.lastReloadAt === null || input.now - input.lastReloadAt >= RELOAD_EVERY_MS;
}
