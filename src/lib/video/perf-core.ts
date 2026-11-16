/**
 * Counters for one live stream, read by the benchmark (`scripts/bench`) and
 * the Display info overlay. Pure module: no browser APIs, runs under `node --test`.
 */

const RING = 256;

export interface StreamPerf {
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
  keyframeAsks: number;
  reconnects: number;
  decoderErrors: number;
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
    received: 0,
    bytes: 0,
    submitted: 0,
    decoded: 0,
    painted: 0,
    superseded: 0,
    dropped: 0,
    maxQueue: 0,
    keyframeAsks: 0,
    reconnects: 0,
    decoderErrors: 0,
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
