/**
 * Where a phone's picture stopped, told apart from the socket's own health.
 *
 * A connected WebSocket does not mean video arrives, and video arriving does not mean it is shown. Each
 * stage keeps a count, and the time it last moved:
 *
 *   phone encoder ─▶ agent (sourceFrames) ─▶ this socket (sentFrames) ─▶ page (seen, received)
 *                                                    ─▶ decoder (decoded) ─▶ canvas (painted)
 *
 * The agent's two counts come with its heartbeat (every 5 s). From where the counts stop moving:
 *
 *   "socket-down"     A. no open socket (the reconnect logic owns it).
 *   "waiting"         open, but no status frame yet, or nothing produced yet on this socket.
 *   "still"           open, heartbeats arrive, the phone produces nothing: a still or dark screen. Not a
 *                        fault (the agent's stream watch restarts an encoder that ignores input).
 *   "agent-holding"   E. the phone produces pictures but the agent sends this socket none: reconnect it.
 *   "page-dropping"   B. pictures reach the page and the page throws them away: reconnect it.
 *   "not-decoding"    C. pictures are received, none decoded (the stall watch asks for a keyframe, then
 *                        rebuilds the decoder, then switches to the software decoder).
 *   "not-rendering"   D. pictures are decoded, none painted although the phone is on screen: repaint.
 *   "ok"              pictures are painted.
 *
 * Pure module: runs under `node --test`.
 */

export type VideoHealth =
  | "ok"
  | "socket-down"
  | "waiting"
  | "still"
  | "agent-holding"
  | "page-dropping"
  | "not-decoding"
  | "not-rendering";

export type HealthAction = "none" | "reconnect" | "repaint";

export interface HealthCounts {
  /** Binary messages on the socket, accepted or not. */
  seen: number;
  /** Accepted access units. */
  received: number;
  decoded: number;
  painted: number;
  /** The agent's counts from its last heartbeat (null: an agent that does not report them). */
  agentSource: number | null;
  agentSent: number | null;
}

export interface HealthTracker {
  last: HealthCounts;
  /** When each count last moved (ms), or when tracking began. */
  movedAt: Record<keyof HealthCounts, number>;
  /** When each action was last taken, to ration them. */
  actedAt: Partial<Record<HealthAction, number>>;
}

const KEYS: (keyof HealthCounts)[] = ["seen", "received", "decoded", "painted", "agentSource", "agentSent"];

export function newHealthTracker(now: number, counts: HealthCounts): HealthTracker {
  const movedAt = Object.fromEntries(KEYS.map((k) => [k, now])) as Record<keyof HealthCounts, number>;
  return { last: { ...counts }, movedAt, actedAt: {} };
}

/** Record the counts at `now`: every count that changed is stamped. */
export function observe(tracker: HealthTracker, counts: HealthCounts, now: number): HealthTracker {
  const movedAt = { ...tracker.movedAt };
  for (const key of KEYS) if (counts[key] !== tracker.last[key]) movedAt[key] = now;
  return { ...tracker, last: { ...counts }, movedAt };
}

/** How long a stage may lag the one before it before it counts as stopped. */
export const RENDER_STALL_MS = 2000;
export const DROP_STALL_MS = 3000;
export const DECODE_STALL_MS = 3000;
/** The agent's counts move only with its 5 s heartbeat: give it two beats and a half. */
export const AGENT_HOLD_MS = 12_000;
/** The phone produced something this recently, so it is not merely still. */
export const SOURCE_RECENT_MS = 7000;
/** The same repair is not tried again sooner than this. */
export const ACTION_EVERY_MS = 15_000;

export interface HealthInput {
  now: number;
  socketOpen: boolean;
  /** A status frame arrived on the current socket. */
  statusSeen: boolean;
  /** The page is visible and at least one view of the phone is really on screen. */
  onScreen: boolean;
  /** The viewer told the agent to stop sending (idle): no pictures are expected. */
  idle: boolean;
}

export function classify(tracker: HealthTracker, input: HealthInput): VideoHealth {
  if (!input.socketOpen) return "socket-down";
  if (!input.statusSeen) return "waiting";
  const { now } = input;
  const at = tracker.movedAt;
  const ago = (key: keyof HealthCounts) => now - at[key];
  // D: decoded keeps moving, painted does not, while someone can see the phone.
  if (input.onScreen && ago("decoded") < RENDER_STALL_MS && at.decoded - at.painted >= RENDER_STALL_MS) return "not-rendering";
  // B: messages arrive and are not taken in.
  if (ago("seen") < DROP_STALL_MS && at.seen - at.received >= DROP_STALL_MS) return "page-dropping";
  // C: taken in, not decoded.
  if (ago("received") < DECODE_STALL_MS && at.received - at.decoded >= DECODE_STALL_MS) return "not-decoding";
  const reporting = tracker.last.agentSource !== null && tracker.last.agentSent !== null;
  // E: the phone produces, the agent does not send this socket anything.
  if (reporting && !input.idle && ago("agentSource") < SOURCE_RECENT_MS && ago("agentSent") >= AGENT_HOLD_MS && ago("seen") >= AGENT_HOLD_MS) {
    return "agent-holding";
  }
  if (tracker.last.received === 0 && tracker.last.seen === 0) return "waiting";
  if (ago("painted") < RENDER_STALL_MS || ago("decoded") < RENDER_STALL_MS) return "ok";
  return "still";
}

/** What to do about a verdict now (at most one repair of a kind per `ACTION_EVERY_MS`). */
export function decide(tracker: HealthTracker, health: VideoHealth, now: number): { tracker: HealthTracker; action: HealthAction } {
  const action: HealthAction =
    health === "not-rendering" ? "repaint" : health === "agent-holding" || health === "page-dropping" ? "reconnect" : "none";
  if (action === "none") return { tracker, action };
  const last = tracker.actedAt[action];
  if (last !== undefined && now - last < ACTION_EVERY_MS) return { tracker, action: "none" };
  return { tracker: { ...tracker, actedAt: { ...tracker.actedAt, [action]: now } }, action };
}
