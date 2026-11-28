/**
 * Counters for one live stream, read by the benchmark (`scripts/bench`) and
 * the Display info overlay. Pure module: no browser APIs, runs under `node --test`.
 */

import type { CloseKind, CloseRecord, IntentionalClose } from "./close-core";

const RING = 256;

/** The agent's keyframe reset counters for one phone (heartbeat `resets`). */
export interface AgentResetStats {
  sent: number;
  merged: number;
  expired: number;
  escalated: number;
  outstandingAttempt: number;
  lastLatencyMs: number | null;
}

export interface StreamPerf {
  /** Every socket message (status text and video), and their bytes: what the network delivered. */
  messages: number;
  wireBytes: number;
  /** Access units that arrived on the socket. */
  received: number;
  bytes: number;
  /** Frames handed to the decoder. */
  submitted: number;
  /** Frames the decoder returned. */
  decoded: number;
  /** Frames drawn to at least one canvas. */
  painted: number;
  /** Decoded frames replaced by a newer one before they were drawn. */
  superseded: number;
  /** Frames dropped before decoding (back-pressure, hidden). */
  dropped: number;
  maxQueue: number;
  /** Times the decoder fell behind (queue at its limit) and frames were dropped until a keyframe. */
  backlogEpisodes: number;
  /** Keyframes taken in, and keyframes the decoder returned a picture for (WebCodecs path). */
  keyframesReceived: number;
  keyframesDecoded: number;
  /** SPS/PPS that differed from the ones before; and of those, how many left the running decoder configured
   * with the old ones (same picture size, so it was not rebuilt). */
  paramSetChanges: number;
  paramSetChangesKeptDecoder: number;
  /** Decoders created (the first one and every rebuild). */
  decoderBuilds: number;
  /** The phone's keyframe resets, from the agent's last heartbeat (null before one arrived). */
  agentResets: AgentResetStats | null;
  /** Times a stuck MSE video element was started again or moved to the newest picture. */
  mseNudges: number;
  keyframeAsks: number;
  /** The same asks by who made them (see `KeyframeReason`): shows what is asking when a phone gets too many. */
  keyframeAsksBy: Record<string, number>;
  reconnects: number;
  /** Reconnects because the socket went silent past its heartbeat. */
  staleReconnects: number;
  decoderErrors: number;
  /** Decoded pictures not painted because the window is in the background at a reduced FPS. */
  backgroundSkipped: number;
  /** Keyframes asked for because no picture came (after returning to full speed, or frames arriving but not decoding). */
  recoveryAsks: number;
  /** Times the decoder was rebuilt because a keyframe did not bring a picture. The connection is never touched. */
  decoderRecoveries: number;
  /** Times the viewer went idle (the agent was told to stop sending) and came back. The socket stays open. */
  idles: number;
  idleResumes: number;
  /** Sockets opened for this phone since the page loaded (a number far above `reconnects` means churn). */
  sockets: number;
  /** Sockets this page closed on purpose (suspend, stop, restart): not failures. */
  intentionalCloses: number;
  /** Sockets that ended without us closing them, by the layer that failed (see close-core). */
  closes: Record<CloseKind, number>;
  lastClose: CloseRecord | null;
  /** The last connection this page closed on purpose, and why. */
  lastIntentionalClose: IntentionalClose | null;
  /** When (performance.now) the last heartbeat and the last video picture arrived; null before the first. */
  lastHeartbeatAt: number | null;
  lastFrameAt: number | null;
  /** When (performance.now) the last picture came out of the decoder and was drawn; null before the first. */
  lastDecodedAt: number | null;
  lastPaintedAt: number | null;
  /** Where the picture stands now (see video-health-core), and the repairs it led to, by kind. */
  health: string;
  healthRepairs: Record<string, number>;
  /** The agent's counts from its last heartbeat: frames the phone produced, frames sent to this socket. */
  agentSourceFrames: number | null;
  agentSentFrames: number | null;
  agentSourceIdleMs: number | null;
  /** Reconnects started because the agent came back or restarted (not by this stream's own backoff). */
  linkReconnects: number;
  /** Decoders swapped for the software one because rebuilt decoders still produced nothing. */
  decoderFallbacks: number;
  /** Failed attempts since a connection last worked; 0 while connected. */
  retryAttempts: number;
  /** How long the last unexpected close took to turn into a picture again (ms), once it did. */
  lastRecoveryMs: number | null;
  /** "hardware" | "software" | "auto" | "mse" | "" (none yet). */
  decoder: string;
  /** Time spent handling one socket message, newest `RING` samples (ms). */
  messageMs: number[];
  /** Mark-to-next-paint times, newest `RING` samples (ms). */
  inputMs: number[];
  inputMarkedAt: number | null;
}

export function newStreamPerf(): StreamPerf {
  return {
    messages: 0,
    wireBytes: 0,
    received: 0,
    bytes: 0,
    submitted: 0,
    decoded: 0,
    painted: 0,
    superseded: 0,
    dropped: 0,
    maxQueue: 0,
    backlogEpisodes: 0,
    keyframesReceived: 0,
    keyframesDecoded: 0,
    paramSetChanges: 0,
    paramSetChangesKeptDecoder: 0,
    decoderBuilds: 0,
    agentResets: null,
    mseNudges: 0,
    keyframeAsks: 0,
    keyframeAsksBy: {},
    reconnects: 0,
    staleReconnects: 0,
    decoderErrors: 0,
    backgroundSkipped: 0,
    recoveryAsks: 0,
    decoderRecoveries: 0,
    idles: 0,
    idleResumes: 0,
    sockets: 0,
    intentionalCloses: 0,
    closes: { normal: 0, device: 0, agent: 0, client: 0, transport: 0, stale: 0, other: 0 },
    lastClose: null,
    lastIntentionalClose: null,
    lastHeartbeatAt: null,
    lastFrameAt: null,
    lastDecodedAt: null,
    lastPaintedAt: null,
    health: "waiting",
    healthRepairs: {},
    agentSourceFrames: null,
    agentSentFrames: null,
    agentSourceIdleMs: null,
    linkReconnects: 0,
    decoderFallbacks: 0,
    retryAttempts: 0,
    lastRecoveryMs: null,
    decoder: "",
    messageMs: [],
    inputMs: [],
    inputMarkedAt: null,
  };
}

function pushRing(ring: number[], value: number) {
  ring.push(value);
  if (ring.length > RING) ring.splice(0, ring.length - RING);
}

export function recordMessage(perf: StreamPerf, ms: number) {
  pushRing(perf.messageMs, ms);
}

export function recordQueue(perf: StreamPerf, queueSize: number) {
  if (queueSize > perf.maxQueue) perf.maxQueue = queueSize;
}

/** An input was sent at `now`; the next painted frame closes the measurement. */
export function markInput(perf: StreamPerf, now: number) {
  if (perf.inputMarkedAt === null) perf.inputMarkedAt = now;
}

export function recordPaint(perf: StreamPerf, now: number) {
  perf.painted += 1;
  perf.lastPaintedAt = now;
  if (perf.inputMarkedAt !== null) {
    pushRing(perf.inputMs, now - perf.inputMarkedAt);
    perf.inputMarkedAt = null;
  }
}

/** Nearest-rank percentile (0..100). 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export interface StreamPerfSnapshot extends Omit<StreamPerf, "messageMs" | "inputMs" | "inputMarkedAt"> {
  messageMsP50: number;
  messageMsP95: number;
  inputMsP50: number;
  inputMsP95: number;
  inputSamples: number;
}

/** Cumulative counters plus percentiles of the timing rings. */
export function snapshotPerf(perf: StreamPerf): StreamPerfSnapshot {
  const { messageMs, inputMs, inputMarkedAt: _marked, ...counters } = perf;
  void _marked;
  return {
    ...counters,
    // Copies: the report is read while the counters keep changing.
    closes: { ...counters.closes },
    keyframeAsksBy: { ...counters.keyframeAsksBy },
    healthRepairs: { ...counters.healthRepairs },
    agentResets: counters.agentResets ? { ...counters.agentResets } : null,
    lastClose: counters.lastClose ? { ...counters.lastClose } : null,
    lastIntentionalClose: counters.lastIntentionalClose ? { ...counters.lastIntentionalClose } : null,
    messageMsP50: percentile(messageMs, 50),
    messageMsP95: percentile(messageMs, 95),
    inputMsP50: percentile(inputMs, 50),
    inputMsP95: percentile(inputMs, 95),
    inputSamples: inputMs.length,
  };
}

const renderCounts = new Map<string, number>();

/** Count one render of a component kind ("tile", "card", ...). Read by the benchmark. */
export function countRender(kind: string) {
  renderCounts.set(kind, (renderCounts.get(kind) ?? 0) + 1);
}

export function renderCountsSnapshot(): Record<string, number> {
  return Object.fromEntries(renderCounts);
}
