"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  annexBHasVcl,
  annexBIsIdr,
  annexBToAvcc,
  buildAvcDecoderConfig,
  codecStringFromSps,
  extractSpsPps,
  spsDimensions,
  splitAnnexBNals,
} from "@/lib/video/h264";
import { MseH264Player } from "@/lib/video/mse-player";
import { nextVideoSize, type TrackedVideoSize } from "@/lib/video/fit-box";
import { admitFrame, anyViewVisible, newDecodeGate } from "@/lib/video/backpressure";
import { postVideoRefresh } from "@/lib/scrcpy/client";
import { agentBaseUrl, agentWsUrl, agentWsProtocols, forgetAgentToken } from "@/lib/api/auth";
import type { StreamStats } from "@/lib/devices/types";
import { createFrameSlot } from "@/lib/video/frame-slot-core";
import { fittedSize, nextCanvasSize } from "@/lib/video/canvas-size-core";
import { accelPreference, createErrorWindow, fallbackMode, parseAccelMode } from "@/lib/video/decoder-config-core";
import {
  DEFAULT_BACKGROUND_POLICY,
  SUSPEND_GRACE_MS,
  backgroundFrameDue,
  decodeStallStep,
  keepsSocketInBackground,
  needsKeyframeAfter,
  onVisibilityChange,
  readBackgroundPolicy,
  recoveryStep,
  shouldSuspend,
  streamMode,
  type BackgroundPolicy,
  type DecodeStallState,
  type StreamMode,
} from "@/lib/video/stream-policy-core";
import { createBackoff, isStale } from "@/lib/api/reconnect-core";
import { closeKind, describeClose, shouldForgetToken, type CloseKind, type CloseRecord } from "@/lib/video/close-core";
import {
  markInput,
  newStreamPerf,
  recordMessage,
  recordPaint,
  recordQueue,
  renderCountsSnapshot,
  snapshotPerf,
  type StreamPerfSnapshot,
} from "@/lib/video/perf-core";

/*
 * One live stream per phone per page. Every view of a phone (main screen,
 * grid tile, macro preview) shares one WebSocket and one decoder; each decoded
 * picture is painted into all of their canvases. Before this, each view
 * decoded the same stream again, which on an iPhone doubled the work.
 */

export type VideoStreamState = "idle" | "starting" | "streaming" | "error";

export interface VideoStatusMessage {
  serial: string;
  stream: VideoStreamState;
  note: string;
  backend: string;
  codec?: string;
  codecString?: string;
  width?: number;
  height?: number;
  framing?: string;
  /** Seconds between repeats of this frame (newer agents). Silence for three beats means a dead socket. */
  heartbeat?: number;
}

export type VideoDecodeState =
  | "connecting"
  | "waiting"
  | "decoding"
  | "unsupported"
  | "error"
  | "idle";

export interface VideoState {
  status: VideoStatusMessage | null;
  decodeState: VideoDecodeState;
  error: string | null;
  /** Decoded frame size. The click target uses this so taps match the picture. */
  frameSize: { width: number; height: number } | null;
  /** Latest tracked size, set as soon as SPS or a status frame arrives. */
  size: TrackedVideoSize | null;
}

export const IDLE_VIDEO: VideoState = {
  status: null,
  decodeState: "idle",
  error: null,
  frameSize: null,
  size: null,
};

export interface VideoView {
  canvas(): HTMLCanvasElement | null;
  onState(state: VideoState): void;
  /** False while this view is scrolled out of sight or hidden. Absent means always shown. */
  visible?(): boolean;
}

/** Keep a stream this long after its last view leaves (view switches, Strict Mode). */
const LINGER_MS = 1500;
/** At most one keyframe request per stream in this window. */
const KEYFRAME_ASK_MS = 2000;

function webCodecsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { VideoDecoder?: unknown }).VideoDecoder === "function"
  );
}

function mseSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')
  );
}

/** A picture-in-picture window shows the stream even while the page itself is hidden. */
function pipActive() {
  if (typeof document === "undefined") return false;
  if (document.pictureInPictureElement) return true;
  const docPip = (window as unknown as { documentPictureInPicture?: { window?: unknown } }).documentPictureInPicture;
  return Boolean(docPip?.window);
}

function pageHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden" && !pipActive();
}

/** Saved by Settings → Video / Performance (per browser); read here so the first stream already follows it. */
export const BG_PAUSE_KEY = "adboard-video-bg-pause";
export const BG_FPS_KEY = "adboard-video-bg-fps";

let backgroundPolicy: BackgroundPolicy = (() => {
  if (typeof window === "undefined") return DEFAULT_BACKGROUND_POLICY;
  try {
    return readBackgroundPolicy(window.localStorage.getItem(BG_PAUSE_KEY), window.localStorage.getItem(BG_FPS_KEY));
  } catch {
    return DEFAULT_BACKGROUND_POLICY;
  }
})();

export function getBackgroundVideoPolicy(): BackgroundPolicy {
  return backgroundPolicy;
}

/** The setting changed: every stream looks at its situation again (the foreground is untouched). */
export function setBackgroundVideoPolicy(next: BackgroundPolicy) {
  if (next.pause === backgroundPolicy.pause && next.fps === backgroundPolicy.fps) return;
  backgroundPolicy = next;
  for (const stream of streams.values()) stream.policyChanged();
}

/** "hardware" | "software" forces a decoder kind (benchmarks); anything else lets the browser pick. */
const forcedAccel = (() => {
  if (typeof window === "undefined") return parseAccelMode(null);
  try {
    return parseAccelMode(window.localStorage.getItem("adboard-video-accel"));
  } catch {
    return parseAccelMode(null);
  }
})();

/** Whether the browser reports a hardware H264 decoder (null until asked; perf mode only). */
let hardwareDecoderSupported: boolean | null = null;

// One 2D context per canvas, looked up once instead of on every frame.
const contexts = new WeakMap<HTMLCanvasElement, CanvasRenderingContext2D | null>();
function contextOf(canvas: HTMLCanvasElement) {
  let context = contexts.get(canvas);
  if (context === undefined) {
    context = canvas.getContext("2d");
    contexts.set(canvas, context);
  }
  return context;
}

const canvasOwners = new WeakMap<HTMLCanvasElement, { sharpen(canvas: HTMLCanvasElement): void }>();

// The size each canvas is shown at, in device pixels, kept current by one observer.
const boxes = new WeakMap<Element, { width: number; height: number }>();
const boxObserver =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((entries) => {
        for (const entry of entries) {
          const device = entry.devicePixelContentBoxSize?.[0];
          const ratio = window.devicePixelRatio || 1;
          const box = device
            ? { width: device.inlineSize, height: device.blockSize }
            : { width: Math.round(entry.contentRect.width * ratio), height: Math.round(entry.contentRect.height * ratio) };
          boxes.set(entry.target, box);
          // The canvas was enlarged (Fill, a dragged panel edge): its picture is
          // now too coarse. A still screen sends no new frame, so ask for one.
          const canvas = entry.target as HTMLCanvasElement;
          if (box.width > canvas.width * 1.1 && box.height > canvas.height * 1.1) canvasOwners.get(canvas)?.sharpen(canvas);
        }
      });
function boxOf(canvas: HTMLCanvasElement) {
  const box = boxes.get(canvas);
  if (box) return box;
  if (!boxObserver) return null;
  // First sight: measure once now, then the observer keeps it current.
  const ratio = window.devicePixelRatio || 1;
  const measured = { width: Math.round(canvas.clientWidth * ratio), height: Math.round(canvas.clientHeight * ratio) };
  boxes.set(canvas, measured);
  boxObserver.observe(canvas);
  return measured;
}

/** The parts of a status frame the UI shows (the heartbeat repeats it every few seconds). */
function sameStatus(a: VideoStatusMessage | null, b: VideoStatusMessage) {
  return (
    a !== null &&
    a.serial === b.serial &&
    a.stream === b.stream &&
    a.note === b.note &&
    a.backend === b.backend &&
    a.codec === b.codec &&
    a.codecString === b.codecString &&
    a.width === b.width &&
    a.height === b.height &&
    a.framing === b.framing
  );
}

/** Timing samples cost a clock read per message: only with ?perf=1 or localStorage adboard-perf=1. */
const perfTiming = (() => {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).has("perf") || window.localStorage.getItem("adboard-perf") === "1";
  } catch {
    return false;
  }
})();

const streams = new Map<string, SharedStream>();
const statsBySerial = new Map<string, StreamStats>();
const statsListeners = new Map<string, Set<() => void>>();

function publishStats(serial: string, stats: StreamStats | null) {
  if (stats) statsBySerial.set(serial, stats);
  else statsBySerial.delete(serial);
  statsListeners.get(serial)?.forEach((listener) => listener());
}

class SharedStream {
  readonly views = new Set<VideoView>();
  state: VideoState = { ...IDLE_VIDEO, decodeState: "connecting" };
  private closed = false;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private socket: WebSocket | null = null;
  private decoder: VideoDecoder | null = null;
  private mse: MseH264Player | null = null;
  private description: Uint8Array | null = null;
  private codecString = "avc1.42E01E";
  private timestampUs = 0;
  private sawKeyframe = false;
  /** Cropped SPS size. A later SPS with different dimensions needs a new decoder. */
  private pictureW = 0;
  private pictureH = 0;
  /** When set, ignore all input until the next SPS+IDR AU recreates the decoder. */
  private waitingForKeyframeConfig = false;
  private lastResetAt = 0;
  // Drop bytes that arrived before Refresh's keyframe. Those P-frames
  // decode against an older IDR and the canvas stays green.
  private acceptVideo = false;
  private refreshAsked = false;
  private gate = newDecodeGate();
  private lastKeyframeAsk = 0;
  private meter = { t: 0, frames: 0, bytes: 0 };
  private generation = 0;
  readonly perf = newStreamPerf();
  private backoff = createBackoff();
  /** Heartbeat promised by the agent on this socket, and when anything last arrived. */
  private heartbeatSeconds: number | null = null;
  private lastMessageAt = 0;
  private accel = forcedAccel;
  private decoderErrors = createErrorWindow();
  /** No view on screen for a while: socket and decoder are closed until one shows again. */
  private suspended = false;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  /** What this stream should be doing now (see stream-policy-core). Kept current by `onVisibility`. */
  private mode: StreamMode = "full";
  /** Background rate limiting: when the last picture was painted / the last keyframe was decoded. */
  private lastBackgroundPaintAt = 0;
  private lastSampleAt = 0;
  private sampleTimer: ReturnType<typeof setInterval> | null = null;
  /** After coming back to full speed: watches that a picture really arrives. */
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryAsked = false;
  /** When the last unexpected close happened, until a picture shows again (for `lastRecoveryMs`). */
  private closedAt: number | null = null;
  private socketOpenedAt = 0;
  private socketFramesAtOpen = 0;
  /** The next `disconnect` ends a connection that failed, not one this page chose to close. */
  private disconnectIsFailure = false;
  /** Access units seen on the socket, accepted or not (the stall watch needs to know frames are arriving). */
  private auSeen = 0;
  private stall: DecodeStallState = { seen: 0, decoded: 0, since: 0 };
  // The newest decoded frame, painted once per display refresh.
  private slot = createFrameSlot<VideoFrame>(
    (run) => requestAnimationFrame(run),
    (handle) => cancelAnimationFrame(handle),
    (frame) => this.paintFrame(frame),
  );

  constructor(readonly serial: string) {}

  start() {
    if (!webCodecsSupported() && !mseSupported()) {
      this.setState({ decodeState: "unsupported", error: "H264 decode is not available in this browser" });
      return;
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    this.mode = this.computeMode();
    this.meter = { t: performance.now(), frames: 0, bytes: 0 };
    this.statsTimer = setInterval(this.measure, 500);
    this.connect();
  }

  stop() {
    this.closed = true;
    this.generation += 1;
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.stopSampling();
    this.clearRecovery();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.disconnect();
    publishStats(this.serial, null);
  }

  /** Reconnect from scratch (the Refresh button). Views stay attached. */
  restart() {
    if (this.closed || !this.statsTimer) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
    this.suspended = false;
    this.clearRecovery();
    this.disconnect();
    this.refreshAsked = false;
    this.backoff.reset();
    this.setState({ frameSize: null, size: null });
    this.connect();
  }

  addView(view: VideoView) {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.views.add(view);
    this.onVisibility(); // a new view can bring a suspended stream back
    // A new view would stay blank on a still screen until something moves:
    // copy the picture another view already shows, or ask for a keyframe.
    requestAnimationFrame(() => {
      if (!this.views.has(view)) return;
      const target = view.canvas();
      if (!target || target.width > 0) return;
      for (const other of this.views) {
        const source = other.canvas();
        if (source && source !== target && source.width > 0 && source.height > 0) {
          this.drawInto(target, source, source.width, source.height);
          return;
        }
      }
      // A still phone sends nothing new, and the usual keyframe ask can be throttled right after a
      // connect or a layout switch (Grid on/off): ask again, a few times, until the view has a picture.
      this.fillBlankView(view, 0);
    });
  }

  private fillBlankView(view: VideoView, attempt: number) {
    if (this.closed || !this.views.has(view) || attempt >= 5) return;
    const target = view.canvas();
    if (!target || target.width > 0) return;
    if (this.state.decodeState === "decoding" && !this.suspended) this.askKeyframe(true);
    setTimeout(() => this.fillBlankView(view, attempt + 1), 1000);
  }

  removeView(view: VideoView) {
    this.views.delete(view);
    if (this.views.size > 0) this.onVisibility(); // the views that remain may all be off screen
    if (this.views.size > 0 || this.lingerTimer) return;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (this.views.size > 0) return;
      this.stop();
      if (streams.get(this.serial) === this) streams.delete(this.serial);
    }, LINGER_MS);
  }

  private setState(patch: Partial<VideoState>) {
    const next = { ...this.state, ...patch };
    const keys = Object.keys(patch) as (keyof VideoState)[];
    if (keys.every((key) => next[key] === this.state[key])) return;
    this.state = next;
    for (const view of this.views) view.onState(next);
  }

  private publishSize(width: number, height: number, source: "sps" | "status" | "frame") {
    const next = nextVideoSize(this.state.size, width, height, source);
    if (!next || next === this.state.size) return;
    const prev = this.state.frameSize;
    this.setState({
      size: next,
      frameSize:
        prev && prev.width === next.width && prev.height === next.height
          ? prev
          : { width: next.width, height: next.height },
    });
  }

  private drawInto(canvas: HTMLCanvasElement, source: CanvasImageSource, width: number, height: number) {
    // The canvas keeps the decoded frame's own size, so every decoded pixel
    // (status bar icons included) reaches the screen. A size reported by
    // status or SPS can be smaller; the canvas is then stretched, which blurs
    // small text on a high-density display.
    canvasOwners.set(canvas, this);
    // A picture-in-picture window can be larger than the canvas on the page.
    const needed = pipActive() ? { width, height } : fittedSize({ width, height }, boxOf(canvas));
    const next = nextCanvasSize(canvas, needed);
    if (canvas.width !== next.width || canvas.height !== next.height) {
      canvas.width = next.width;
      canvas.height = next.height;
    }
    const context = contextOf(canvas);
    if (!context) return;
    // Shrinking a lot with plain bilinear sampling makes small text shimmer.
    context.imageSmoothingQuality = next.width * 2 < width ? "medium" : "low";
    context.drawImage(source, 0, 0, next.width, next.height);
  }

  private paint(source: CanvasImageSource, width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    let drawn = false;
    for (const view of this.views) {
      // Nothing to gain from drawing into a canvas nobody can see.
      if (view.visible && !view.visible()) continue;
      const canvas = view.canvas();
      if (canvas) {
        this.drawInto(canvas, source, width, height);
        drawn = true;
      }
    }
    if (drawn) recordPaint(this.perf, performance.now());
  }

  private paintFrame = (frame: VideoFrame) => {
    const width = frame.displayWidth > 0 ? frame.displayWidth : frame.codedWidth;
    const height = frame.displayHeight > 0 ? frame.displayHeight : frame.codedHeight;
    if (width > 0 && height > 0) this.publishSize(width, height, "frame");
    this.paint(frame, width, height); // the frame slot closes it
  };

  /** A canvas grew past its picture: get a fresh frame to redraw it at the new size. */
  sharpen(canvas: HTMLCanvasElement) {
    // Already at the phone's full resolution: there is nothing sharper to draw.
    if (canvas.width >= (this.state.size?.width ?? 0)) return;
    if (!this.closed && this.state.decodeState === "decoding") this.askKeyframe();
  }

  /** Benchmark hook: an input for this phone was sent now. */
  markInput() {
    markInput(this.perf, performance.now());
  }

  private measure = () => {
    const now = performance.now();
    // A socket whose agent promised a heartbeat and went silent is dead (a
    // sleeping laptop, a dropped Wi-Fi link): reconnect instead of waiting.
    if (this.socket && !this.suspended && isStale(this.lastMessageAt, now, this.heartbeatSeconds)) {
      this.perf.staleReconnects += 1;
      this.recordClose(0, `no message for ${Math.round((now - this.lastMessageAt) / 1000)} s`, false, "stale");
      this.disconnectIsFailure = true;
      this.reconnect();
    }
    // Frames arrive but none decodes: the keyframe the decoder needs never reached it. Ask for one.
    if (this.socket && !this.suspended && this.mode === "full" && !this.mse) {
      const step = decodeStallStep(this.stall, { seen: this.auSeen, decoded: this.perf.decoded, at: now });
      this.stall = step.state;
      if (step.ask) {
        this.perf.recoveryAsks += 1;
        this.askKeyframe(true);
      }
    } else {
      this.stall = { seen: this.auSeen, decoded: this.perf.decoded, since: now };
    }
    const sample = this.meter;
    const seconds = Math.max(0.001, (now - sample.t) / 1000);
    const size = this.state.size;
    const next: StreamStats = {
      fps: sample.frames / seconds,
      bitrateKbps: (sample.bytes * 8) / 1000 / seconds,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
      codec: "h264",
    };
    this.meter = { t: now, frames: 0, bytes: 0 };
    const prev = statsBySerial.get(this.serial);
    if (
      prev &&
      Math.round(prev.fps) === Math.round(next.fps) &&
      Math.round(prev.bitrateKbps) === Math.round(next.bitrateKbps) &&
      prev.width === next.width &&
      prev.height === next.height
    ) {
      return;
    }
    publishStats(this.serial, next);
  };

  /** The agent's encoder sends the next keyframe now instead of seconds later. */
  private askKeyframe(force = false) {
    if (this.state.status?.backend !== "scrcpy") return;
    const now = Date.now();
    // `force` (recovery, background sampling) only skips the long throttle, never asks twice within a second.
    if (now - this.lastKeyframeAsk < (force ? 900 : KEYFRAME_ASK_MS)) return;
    this.lastKeyframeAsk = now;
    this.perf.keyframeAsks += 1;
    void postVideoRefresh([this.serial]).catch(() => {});
  }

  /** The situation of this stream: showing, nothing to show, or hidden window with a background rate. */
  private computeMode(): StreamMode {
    return streamMode({
      pageHidden: pageHidden(),
      anyViewVisible: anyViewVisible(this.views),
      policy: backgroundPolicy,
      canThrottle: webCodecsSupported() && !this.mse,
    });
  }

  private onVisibility = () => {
    if (this.closed) return;
    const previous = this.mode;
    const next = this.computeMode();
    this.mode = next;
    // A stream that keeps its socket in the background (thinned) is not suspended.
    const shown = next === "full" || keepsSocketInBackground(next);
    if (previous !== next) this.modeChanged(previous, next);
    const state = { suspended: this.suspended, armed: this.suspendTimer !== null };
    switch (onVisibilityChange(state, shown)) {
      case "arm":
        this.suspendTimer = setTimeout(() => {
          this.suspendTimer = null;
          if (!this.closed && shouldSuspend({ suspended: this.suspended, armed: true }, this.mode === "full" || keepsSocketInBackground(this.mode))) this.suspend();
        }, SUSPEND_GRACE_MS);
        break;
      case "disarm":
        if (this.suspendTimer) clearTimeout(this.suspendTimer);
        this.suspendTimer = null;
        break;
      case "resume":
        this.suspended = false;
        this.perf.resumes += 1;
        this.backoff.reset();
        this.connect();
        // A fresh connection must produce a picture; if it does not, ask and then start over.
        if (next === "full") this.armRecovery();
        return;
      default:
        break;
    }
    if (next === "full" && this.gate.dropping) this.askKeyframe();
  };

  /** The stream's mode changed (the window hid or showed, a view moved, or the setting changed). */
  private modeChanged(previous: StreamMode, next: StreamMode) {
    if (next === "sample-keyframes") this.startSampling();
    else this.stopSampling();
    if (keepsSocketInBackground(next)) {
      // Nothing shows while thinned: do not keep a queued picture around.
      this.slot.clear();
      this.lastBackgroundPaintAt = 0;
      this.lastSampleAt = 0;
    }
    if (next === "full" && previous !== "full") {
      // Back at full speed (Alt-Tab back, the tile scrolled in): the decoder may have missed frames,
      // so wait for a keyframe (and ask for one), then check that a picture really arrives.
      if (needsKeyframeAfter(previous, next) && this.decoder) this.gate.dropping = true;
      if (!this.suspended) {
        this.askKeyframe(true);
        this.armRecovery();
      }
    }
  }

  /** The background setting changed. */
  policyChanged() {
    this.onVisibility();
  }

  /** 1 FPS in the background: one keyframe a second is enough, so ask for exactly that. */
  private startSampling() {
    if (this.sampleTimer) return;
    this.sampleTimer = setInterval(() => {
      if (this.closed || this.mode !== "sample-keyframes" || !this.socket || !this.acceptVideo) return;
      this.askKeyframe(true);
    }, 1000);
  }

  private stopSampling() {
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.sampleTimer = null;
  }

  private clearRecovery() {
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  /** After returning to full speed: if no picture arrives, ask for a keyframe once, then start the connection over once. */
  private armRecovery() {
    this.clearRecovery();
    this.recoveryAsked = false;
    const framesBefore = this.perf.decoded;
    const started = performance.now();
    const tick = () => {
      this.recoveryTimer = null;
      if (this.closed || this.mode !== "full") return;
      const step = recoveryStep({
        elapsedMs: performance.now() - started,
        framesSince: this.perf.decoded - framesBefore,
        asked: this.recoveryAsked,
      });
      if (step === "done") return;
      if (step === "ask-keyframe") {
        this.recoveryAsked = true;
        this.perf.recoveryAsks += 1;
        this.askKeyframe(true);
      } else if (step === "reconnect") {
        // One restart per return: the backoff in reconnect() spaces it, and it does not arm itself again.
        this.perf.recoveryReconnects += 1;
        this.reconnect();
        return;
      }
      this.recoveryTimer = setTimeout(tick, 300);
    };
    this.recoveryTimer = setTimeout(tick, 300);
  }

  /** Nobody has looked at this stream for a while: stop receiving it. Views stay attached. */
  private suspend() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.suspended = true;
    this.perf.suspends += 1;
    this.disconnect();
    this.refreshAsked = false;
  }

  /** Drop the socket and connect again after the backoff delay. */
  private reconnect() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.disconnect();
    this.refreshAsked = false;
    this.perf.reconnects += 1;
    this.retryTimer = setTimeout(this.connect, this.backoff.next());
  }

  /** A view scrolled into or out of sight. Coming back needs a fresh keyframe. */
  viewVisibilityChanged() {
    this.onVisibility();
  }

  private teardownDecoder() {
    if (this.decoder) {
      try {
        if (this.decoder.state !== "closed") this.decoder.close();
      } catch {
        // ignore
      }
      this.decoder = null;
    }
    this.slot.clear();
    this.sawKeyframe = false;
  }

  private disconnect() {
    this.generation += 1;
    this.teardownDecoder();
    this.mse?.close();
    this.mse = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      // Closed by this page on purpose (suspend, stop, restart): never reported as a failure.
      if (this.disconnectIsFailure) this.disconnectIsFailure = false;
      else this.perf.intentionalCloses += 1;
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
  }

  /** Note a connection that ended without this page closing it; returns which layer it blames. */
  private recordClose(code: number, reason: string, wasClean: boolean, kindOverride?: CloseKind): CloseKind {
    const now = performance.now();
    const kind = kindOverride ?? closeKind(code);
    const record: CloseRecord = {
      code,
      reason,
      wasClean,
      kind,
      at: Date.now(),
      openForMs: Math.round(now - this.socketOpenedAt),
      frames: this.perf.received - this.socketFramesAtOpen,
    };
    this.perf.closes[kind] += 1;
    this.perf.lastClose = record;
    this.perf.retryAttempts += 1;
    this.closedAt = now;
    if (kind !== "normal") {
      console.info(`[adboard video] ${this.serial}: ${describeClose(record)} after ${record.openForMs} ms and ${record.frames} frames; retry ${this.perf.retryAttempts}`);
    }
    return kind;
  }

  /** The first picture after an unexpected close: how long the stream was gone. */
  private noteRecovered() {
    if (this.closedAt === null) return;
    this.perf.lastRecoveryMs = Math.round(performance.now() - this.closedAt);
    this.closedAt = null;
  }

  private markBroken(reason: string) {
    const now = Date.now();
    this.waitingForKeyframeConfig = true;
    this.teardownDecoder();
    // Throttle reset storms (multi-slice / bad AU spam).
    if (now - this.lastResetAt < 500) return;
    this.lastResetAt = now;
    if (!this.closed) this.setState({ decodeState: "waiting", error: reason });
  }

  private createDecoder(desc: Uint8Array, codec: string) {
    this.teardownDecoder();
    this.waitingForKeyframeConfig = false;
    this.gate = newDecodeGate();
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (this.closed || this.decoder !== decoder) {
          frame.close();
          return;
        }
        this.perf.decoded += 1;
        this.noteRecovered();
        this.setState({ decodeState: "decoding", error: null });
        if (this.mode === "throttle-paint") {
          // Hidden window at a reduced rate: every picture had to be decoded, but only about
          // FPS of them are painted.
          const now = performance.now();
          if (!backgroundFrameDue(now - this.lastBackgroundPaintAt, backgroundPolicy.fps)) {
            this.perf.backgroundSkipped += 1;
            frame.close();
            return;
          }
          this.lastBackgroundPaintAt = now;
          this.paintFrame(frame);
          frame.close();
        } else if (document.visibilityState === "hidden") {
          // Animation frames do not run in a hidden page; a picture-in-picture
          // window still shows the stream, so paint it now.
          this.paintFrame(frame);
          frame.close();
        } else if (this.slot.offer(frame)) {
          this.perf.superseded += 1;
        }
      },
      error: (err) => {
        this.perf.decoderErrors += 1;
        console.warn("[video] decoder error", err);
        if (this.decoder === decoder) {
          this.noteDecoderError();
          this.markBroken("Recovering decode…");
        }
      },
    });
    decoder.configure({
      codec,
      description: desc,
      optimizeForLatency: true,
      hardwareAcceleration: accelPreference(this.accel),
    });
    this.perf.decoder = this.accel;
    this.decoder = decoder;
    if (perfTiming && hardwareDecoderSupported === null) {
      hardwareDecoderSupported = false;
      void VideoDecoder.isConfigSupported({ codec, description: desc, hardwareAcceleration: "prefer-hardware" })
        .then((result) => {
          hardwareDecoderSupported = result.supported === true;
        })
        .catch(() => {});
    }
  }

  /** A decoder kind that keeps failing is swapped for the software decoder. */
  private noteDecoderError() {
    if (!this.decoderErrors.note(Date.now())) return;
    const next = fallbackMode(this.accel);
    if (next !== this.accel) {
      console.warn("[video] decoder keeps failing; using the software decoder for", this.serial);
      this.accel = next;
      this.decoderErrors.reset();
    }
  }

  private connect = () => {
    if (this.closed || this.suspended) return;
    // One socket per phone: a second worker (a late retry timer, a resume racing a reconnect) closes the old one
    // first instead of leaving it open behind a newer generation.
    if (this.socket) this.disconnect();
    this.mode = this.computeMode();
    this.lastSampleAt = 0;
    const generation = ++this.generation;
    if (!webCodecsSupported()) {
      // LAN http:// has no WebCodecs. MSE plays the same Annex-B access units.
      this.perf.decoder = "mse";
      this.mse = new MseH264Player(
        (source, width, height) => {
          if (generation === this.generation) this.paint(source, width, height);
        },
        (size, source) => {
          if (generation === this.generation) this.publishSize(size.width, size.height, source);
        },
        () => {
          if (generation === this.generation) this.setState({ decodeState: "decoding", error: null });
        },
        (message) => {
          if (generation === this.generation) this.setState({ decodeState: "error", error: message });
        },
      );
    }
    this.setState({ decodeState: "connecting" });
    this.description = null;
    this.waitingForKeyframeConfig = false;
    this.acceptVideo = false;
    this.heartbeatSeconds = null;
    this.lastMessageAt = performance.now();
    void agentWsUrl(`/ws/devices/${encodeURIComponent(this.serial)}/video`)
      .then((url) => {
        if (generation === this.generation) this.bindSocket(url, generation);
      })
      .catch(() => {
        forgetAgentToken();
        if (generation === this.generation) this.retryTimer = setTimeout(this.connect, this.backoff.next());
      });
  };

  private bindSocket(url: string, generation: number) {
    const socket = new WebSocket(url, agentWsProtocols());
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.perf.sockets += 1;
    this.socketOpenedAt = performance.now();
    this.socketFramesAtOpen = this.perf.received;
    const current = () => generation === this.generation && !this.closed;

    socket.onopen = () => {
      if (current()) this.setState({ decodeState: "waiting" });
    };
    socket.onmessage = (event) => {
      if (!current()) return;
      this.lastMessageAt = performance.now();
      const started = perfTiming ? this.lastMessageAt : 0;
      if (typeof event.data === "string") this.onStatus(event.data, generation);
      else this.onAccessUnit(new Uint8Array(event.data as ArrayBuffer));
      if (perfTiming) recordMessage(this.perf, performance.now() - started);
    };
    socket.onclose = (event) => {
      if (!current()) return;
      // Not ours (we close through `disconnect`, which silences this handler): the agent, a proxy or
      // the network ended it. Say which, so a freeze can be traced to a layer.
      const kind = this.recordClose(event.code, event.reason ?? "", event.wasClean);
      this.teardownDecoder();
      this.mse?.close();
      this.mse = null;
      this.description = null;
      this.perf.reconnects += 1;
      // After a restart or a failed connection the agent may be a new process with a new token. When it
      // said why it closed, it is the same process and the token is fine.
      if (shouldForgetToken(kind)) forgetAgentToken();
      this.retryTimer = setTimeout(this.connect, this.backoff.next());
    };
    socket.onerror = () => socket.close();
  }

  private onStatus(text: string, generation: number) {
    let msg: VideoStatusMessage;
    try {
      msg = JSON.parse(text) as VideoStatusMessage;
    } catch {
      return;
    }
    if (typeof msg.heartbeat === "number" && msg.heartbeat > 0) this.heartbeatSeconds = msg.heartbeat;
    // The connection works: the next drop starts from the short retry delay.
    this.backoff.reset();
    this.perf.retryAttempts = 0;
    // The heartbeat repeats the same frame; only a real change reaches the views.
    if (!sameStatus(this.state.status, msg)) this.setState({ status: msg });
    if (msg.backend === "scrcpy" && !this.refreshAsked) {
      this.refreshAsked = true;
      this.lastKeyframeAsk = Date.now();
      void postVideoRefresh([this.serial])
        .catch(() => {})
        .finally(() => {
          if (generation === this.generation) this.acceptVideo = true;
        });
    } else if (msg.backend && msg.backend !== "scrcpy") {
      this.acceptVideo = true;
    }
    if (msg.codecString) this.codecString = msg.codecString;
    if (msg.width && msg.height && msg.width > 0 && msg.height > 0) {
      this.publishSize(msg.width, msg.height, "status");
    }
    if (msg.stream === "idle") {
      this.setState({ decodeState: "idle" });
    } else if (msg.stream === "error") {
      this.setState({ decodeState: "error", error: msg.note || "stream error" });
    } else if ((msg.stream === "starting" || msg.stream === "streaming") && this.state.decodeState !== "decoding") {
      this.setState({ decodeState: "waiting" });
    }
  }

  private onAccessUnit(buf: Uint8Array) {
    if (buf.byteLength > 0) this.auSeen += 1;
    if (!this.acceptVideo || buf.byteLength === 0) return;
    this.meter.frames += 1;
    this.meter.bytes += buf.byteLength;
    this.perf.received += 1;
    this.perf.bytes += buf.byteLength;

    if (this.mse) {
      this.mse.push(buf);
      return;
    }

    // Nothing is shown (hidden page, or every view off screen): skip parsing
    // and decoding. The next keyframe is asked for when a view comes back.
    if (this.decoder && this.mode === "hold-then-suspend") {
      this.gate.dropping = true;
      this.gate.dropped += 1;
      this.perf.dropped += 1;
      return;
    }

    // Split the frame once; every check below reads the same NAL list.
    const nals = splitAnnexBNals(buf);
    // SPS/PPS often arrive in their own access unit, before the IDR.
    const paramSets = extractSpsPps(nals);
    if (paramSets) {
      this.description = buildAvcDecoderConfig(paramSets.sps, paramSets.pps);
      this.codecString = codecStringFromSps(paramSets.sps);
      const dims = spsDimensions(paramSets.sps);
      if (dims && dims.width > 0 && dims.height > 0) {
        this.publishSize(dims.width, dims.height, "sps");
        const sizeChanged =
          this.pictureW > 0 && (dims.width !== this.pictureW || dims.height !== this.pictureH);
        this.pictureW = dims.width;
        this.pictureH = dims.height;
        // The existing decoder keeps the old coded size. Drop it so this
        // access unit's IDR (or the next one) configures the new picture.
        if (sizeChanged) {
          this.waitingForKeyframeConfig = true;
          this.teardownDecoder();
        }
      }
    }

    if (!annexBHasVcl(nals)) return;
    const isKey = annexBIsIdr(nals);
    if (this.mode === "sample-keyframes") {
      // 1 FPS in the background: decode a keyframe about once a second and nothing else.
      // Keyframes decode on their own, so the dropped delta frames cost nothing later.
      const now = performance.now();
      if (!isKey || !backgroundFrameDue(now - this.lastSampleAt, backgroundPolicy.fps)) {
        this.perf.dropped += 1;
        return;
      }
      this.lastSampleAt = now;
    }
    // An earlier SPS/PPS AU is enough; the IDR does not have to repeat it.
    if (!this.description) return; // wait for SPS/PPS

    const needNewDecoder =
      this.waitingForKeyframeConfig ||
      !this.decoder ||
      this.decoder.state === "closed" ||
      this.decoder.state === "unconfigured";
    if (needNewDecoder) {
      if (!isKey) return; // wait for SPS+IDR together
      this.createDecoder(this.description, this.codecString);
    }

    if (!this.sawKeyframe && !isKey) return;
    if (isKey) this.sawKeyframe = true;

    const decoder = this.decoder;
    // Never feed a closed/broken decoder.
    if (!decoder || decoder.state !== "configured") return;

    // Back-pressure: a decoder that can't keep up (or a hidden page) drops
    // frames until a keyframe instead of queueing them without bound.
    const verdict = admitFrame(this.gate, {
      isKey,
      queueSize: decoder.decodeQueueSize,
      hidden: this.mode === "hold-then-suspend",
    });
    recordQueue(this.perf, decoder.decodeQueueSize);
    if (verdict === "drop-ask-keyframe") this.askKeyframe();
    if (verdict !== "decode") {
      this.perf.dropped += 1;
      return;
    }

    const avcc = annexBToAvcc(nals);
    if (avcc.byteLength === 0) return;
    try {
      decoder.decode(
        new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: this.timestampUs, data: avcc }),
      );
      this.timestampUs += 100_000;
      this.perf.submitted += 1;
    } catch (err) {
      console.warn("[video] decode() threw", err);
      this.noteDecoderError();
      this.markBroken("Recovering decode…");
    }
  }
}

/**
 * Show `serial`'s live screen in `view`. Returns the unsubscribe. The stream
 * starts with the first view and stops shortly after the last one leaves.
 */
export function subscribeVideo(serial: string, view: VideoView): () => void {
  // "" is same-origin (packaged UI). Only null means the in-browser mock.
  if (agentBaseUrl() === null) return () => {};
  let stream = streams.get(serial);
  if (!stream) {
    stream = new SharedStream(serial);
    streams.set(serial, stream);
    stream.addView(view);
    stream.start();
  } else {
    stream.addView(view);
  }
  const owner = stream;
  return () => owner.removeView(view);
}

/** A view of `serial` moved in or out of sight (its `visible()` changed). */
export function notifyVideoVisibility(serial: string) {
  streams.get(serial)?.viewVisibilityChanged();
}

export function videoState(serial: string): VideoState {
  return streams.get(serial)?.state ?? IDLE_VIDEO;
}

/** Reconnect `serial`'s stream (all of its views). */
export function restartVideo(serial: string) {
  streams.get(serial)?.restart();
}

export interface VideoPerfReport {
  streams: Record<string, StreamPerfSnapshot & { views: number; state: VideoDecodeState }>;
  /** Streams and stats listeners still held (leak check: 0 after every view left). */
  liveStreams: number;
  statsListeners: number;
  /** The browser says it has a hardware H264 decoder (null: not asked yet). */
  hardwareDecoderSupported: boolean | null;
}

/** Counters of every live stream (benchmarks, Display info). */
export function videoPerfReport(): VideoPerfReport {
  const out: VideoPerfReport["streams"] = {};
  for (const [serial, stream] of streams) {
    out[serial] = { ...snapshotPerf(stream.perf), views: stream.views.size, state: stream.state.decodeState };
  }
  let listeners = 0;
  for (const set of statsListeners.values()) listeners += set.size;
  return { streams: out, liveStreams: streams.size, statsListeners: listeners, hardwareDecoderSupported };
}

if (perfTiming) {
  (window as unknown as { __adboardPerf?: unknown }).__adboardPerf = {
    snapshot: videoPerfReport,
    markInput: (serial: string) => streams.get(serial)?.markInput(),
    renders: renderCountsSnapshot,
  };
}

function subscribeStats(serial: string, listener: () => void) {
  let set = statsListeners.get(serial);
  if (!set) {
    set = new Set();
    statsListeners.set(serial, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && statsListeners.get(serial) === set) statsListeners.delete(serial);
  };
}

/**
 * Live fps / bitrate / size of `serial`'s stream, re-rendering only the
 * component that shows them. Does not start a stream; null while none runs.
 */
export function useVideoStats(serial: string | null | undefined): StreamStats | null {
  const subscribe = useCallback(
    (listener: () => void) => (serial ? subscribeStats(serial, listener) : () => {}),
    [serial],
  );
  return useSyncExternalStore(
    subscribe,
    () => (serial ? statsBySerial.get(serial) ?? null : null),
    () => null,
  );
}
