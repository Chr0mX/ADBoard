import type { Device } from "@/lib/devices/types";

/*
 * What the page knows about the phone list, and how fresh that knowledge is.
 *
 * - The list only ever comes from the agent (or, in explicit demo mode, from the sample
 *   fleet). A failed request never replaces it: the last real list stays on screen.
 * - While the agent cannot be reached, every phone that was "online" is shown as "stale"
 *   (an old answer), never as online, so no control treats it as ready.
 * - A response that was requested before a newer answer arrived is ignored.
 *
 * Pure module: runs under `node --test`.
 */

/**
 * live: the agent answered. unreachable: it did not (network, agent down, proxy). unauthorized: it answered
 * and refused this page (signed out, wrong token): the agent is up, so "retry" alone will not fix it.
 */
export type FleetConnection = "live" | "unreachable" | "unauthorized" | "demo";

export interface FleetState {
  devices: Device[];
  connection: FleetConnection;
  /** When the list was last confirmed by the agent (ms since the epoch); null before the first answer. */
  lastOkAt: number | null;
  /** The reason the last request failed; null while live. */
  lastError: string | null;
}

export function initialFleet(demo: boolean, sample: Device[] = []): FleetState {
  return demo
    ? { devices: sample, connection: "demo", lastOkAt: null, lastError: null }
    : { devices: [], connection: "unreachable", lastOkAt: null, lastError: null };
}

/** The agent answered with `devices`: that is the truth now. */
export function applySnapshot(state: FleetState, devices: Device[], now: number): FleetState {
  if (state.connection === "demo") return state;
  return { devices, connection: "live", lastOkAt: now, lastError: null };
}

/** A request to the agent failed: keep what is known, say why, and stop trusting "online". */
export function applyFailure(state: FleetState, reason: string, refused = false): FleetState {
  if (state.connection === "demo") return state;
  return { ...state, connection: refused ? "unauthorized" : "unreachable", lastError: reason };
}

/** Is the list unconfirmed right now (so nothing may be trusted as ready)? */
export function isUnconfirmed(connection: FleetConnection): boolean {
  return connection === "unreachable" || connection === "unauthorized";
}

/**
 * The phones as the rest of the page should see them: when the list is not confirmed
 * (agent unreachable or refusing), an "online" phone is "stale". Offline and unauthorized phones stay as they were.
 */
export function withFreshness(devices: Device[], connection: FleetConnection): Device[] {
  if (!isUnconfirmed(connection)) return devices;
  if (!devices.some((d) => d.status === "online")) return devices;
  return devices.map((d) => (d.status === "online" ? { ...d, status: "stale" as const } : d));
}

/** The line shown when the agent cannot be reached. */
export function unreachableMessage(state: FleetState): string | null {
  if (state.connection === "unauthorized") {
    const known = state.devices.length > 0;
    return `ADBoard is running but refused this page${state.lastError ? ` (${state.lastError})` : ""}. Sign in again.${known ? " The last known phones are shown as stale; controls stay off until you are signed in." : ""}`;
  }
  if (state.connection !== "unreachable") return null;
  const when = state.lastOkAt === null ? null : new Date(state.lastOkAt).toLocaleTimeString();
  const known = state.devices.length > 0;
  const reason = state.lastError ? ` (${state.lastError})` : "";
  if (known) {
    return `Cannot reach the ADBoard agent${reason}. Showing the last known phones${when ? ` from ${when}` : ""}; controls stay off until it is back.`;
  }
  return `Cannot reach the ADBoard agent${reason}. Retrying.`;
}

/**
 * Orders answers: a response only counts if it was requested after the newest answer
 * already used, and a pushed list (the agent's WebSocket) cancels every request still on its way.
 */
export interface SnapshotGate {
  /** Call just before asking the agent for the list. */
  begin(): number;
  /** Call when the response for `token` arrives: is it still current? */
  accept(token: number): boolean;
  /** Call when the agent pushed a list: older requests are now stale. */
  markPush(): void;
}

export function createSnapshotGate(): SnapshotGate {
  let issued = 0;
  let floor = 0;
  return {
    begin() {
      issued += 1;
      return issued;
    },
    accept(token) {
      if (token <= floor) return false;
      floor = token;
      return true;
    },
    markPush() {
      issued += 1;
      floor = issued;
    },
  };
}
