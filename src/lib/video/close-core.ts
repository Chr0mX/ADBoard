/**
 * Why a video WebSocket ended, as far as the page can tell.
 *
 * The agent now closes with an application code (4000 to 4999) and a short reason when it ends a
 * socket itself, so a stream that stopped can be traced to the layer that failed instead of being
 * counted as "a reconnect". A browser-side close (suspend, stop, restart) is never reported here:
 * the hub counts those as intentional before the socket's `onclose` is ignored.
 *
 * Pure module: runs under `node --test`.
 */
export type CloseKind =
  /** The other side closed cleanly (1000, 1001): a restart or shutdown of the agent or a proxy. */
  | "normal"
  /** The phone or its stream: unknown device, the stream could not start, the channel shut down. */
  | "device"
  /** The remote agent that owns the phone could not be reached, or its video link ended. */
  | "agent"
  /** This browser stopped reading or answering and the agent gave up on it. */
  | "client"
  /** No close frame arrived (1005, 1006, 1015): the connection itself failed. */
  | "transport"
  /** The page gave up on a socket that stopped sending its heartbeat (code 0: there was no close at all). */
  | "stale"
  /** Anything else. */
  | "other";

export const CLOSE_KINDS: readonly CloseKind[] = ["normal", "device", "agent", "client", "transport", "stale", "other"];

export function closeKind(code: number): CloseKind {
  switch (code) {
    case 1000:
    case 1001:
      return "normal";
    case 4004: // unknown device
    case 4005: // the stream could not start
    case 4012: // the video channel was shut down
      return "device";
    case 4010: // remote agent video unreachable
    case 4011: // remote agent video link ended
      return "agent";
    case 4008: // client stopped reading
    case 4009: // client silent
      return "client";
    case 1005:
    case 1006:
    case 1015:
      return "transport";
    default:
      return "other";
  }
}

/** Which side ended a connection, as far as this page can tell. */
export type CloseInitiator =
  /** This page gave up on it (no heartbeat) or closed it on purpose. */
  | "page"
  /** The server the page is connected to: the controller, or an agent used directly. */
  | "controller"
  /** The remote agent behind the controller. */
  | "remote-agent"
  /** Nobody said anything: the network or a proxy dropped it. */
  | "network"
  /** The server closed cleanly (a restart or shutdown). */
  | "server";

export function closeInitiator(code: number, kind: CloseKind): CloseInitiator {
  if (kind === "stale") return "page";
  if (code === 4010 || code === 4011) return "remote-agent";
  switch (kind) {
    case "device":
    case "client":
      return "controller";
    case "agent":
      return "remote-agent";
    case "transport":
      return "network";
    default:
      return "server";
  }
}

export interface CloseRecord {
  serial: string;
  code: number;
  reason: string;
  wasClean: boolean;
  kind: CloseKind;
  initiator: CloseInitiator;
  /** Always false here: a close this page chose is an `IntentionalClose`, never a failure. */
  intentional: false;
  /** When it happened (ms since the epoch). */
  at: number;
  /** How long that socket had been open (ms). */
  openForMs: number;
  /** Video access units it delivered. */
  frames: number;
  /** How long before the close the last heartbeat and the last video picture arrived (null: none on this socket). */
  lastHeartbeatAgoMs: number | null;
  lastFrameAgoMs: number | null;
  /** Whether the decoder had been rebuilt on this connection, and that a reconnect follows. */
  decoderRecovered: boolean;
  reconnecting: boolean;
}

/** A connection this page closed because the viewer closed, was refreshed or was replaced: not a failure. */
export interface IntentionalClose {
  serial: string;
  reason: string;
  at: number;
  openForMs: number;
}

/**
 * How long to wait before reconnecting after a close. The backoff alone is right for a lost connection. When
 * the agent said the phone is unknown (4004) or its stream could not start (4005), asking again at once
 * only repeats the answer, so wait longer.
 */
export function retryDelayMs(code: number, backoffMs: number): number {
  if (code === 4004) return Math.max(backoffMs, 10_000);
  if (code === 4005) return Math.max(backoffMs, 3_000);
  return backoffMs;
}

export function describeClose(record: Pick<CloseRecord, "code" | "reason" | "kind">): string {
  const reason = record.reason ? `: ${record.reason}` : "";
  switch (record.kind) {
    case "normal":
      return `closed by the other side (${record.code})${reason}`;
    case "device":
      return `the phone's stream ended (${record.code})${reason}`;
    case "agent":
      return `the remote agent's video failed (${record.code})${reason}`;
    case "client":
      return `the agent dropped this page because it stopped answering (${record.code})${reason}`;
    case "transport":
      return `the connection failed with no close frame (${record.code})`;
    case "stale":
      return `no heartbeat arrived, so the connection was treated as dead${reason}`;
    default:
      return `closed (${record.code})${reason}`;
  }
}

/**
 * Should the cached agent token be thrown away after this close? When the agent said why it closed, it
 * is up and the token is fine. After a transport failure or a clean restart it may be a new process.
 */
export function shouldForgetToken(kind: CloseKind): boolean {
  return kind === "transport" || kind === "stale" || kind === "normal" || kind === "other";
}

export function newCloseCounts(): Record<CloseKind, number> {
  return { normal: 0, device: 0, agent: 0, client: 0, transport: 0, stale: 0, other: 0 };
}
