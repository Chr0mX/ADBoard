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
} from "@/lib/video/h264";
import { MseH264Player } from "@/lib/video/mse-player";
import { nextVideoSize, type TrackedVideoSize } from "@/lib/video/fit-box";
import { admitFrame, newDecodeGate } from "@/lib/video/backpressure";
import { postVideoRefresh } from "@/lib/scrcpy/client";
import { agentBaseUrl, agentWsUrl, agentWsProtocols } from "@/lib/api/auth";
import type { StreamStats } from "@/lib/devices/types";

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

function pageHidden() {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

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

  constructor(readonly serial: string) {}

  start() {
    if (!webCodecsSupported() && !mseSupported()) {
      this.setState({ decodeState: "unsupported", error: "H264 decode is not available in this browser" });
      return;
    }
    document.addEventListener("visibilitychange", this.onVisibility);
    this.meter = { t: performance.now(), frames: 0, bytes: 0 };
    this.statsTimer = setInterval(this.measure, 500);
    this.connect();
  }

  stop() {
    this.closed = true;
    this.generation += 1;
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.disconnect();
    publishStats(this.serial, null);
  }

  /** Reconnect from scratch (the Refresh button). Views stay attached. */
  restart() {
    if (this.closed || !this.statsTimer) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.disconnect();
    this.refreshAsked = false;
    this.setState({ frameSize: null, size: null });
    this.connect();
  }

  addView(view: VideoView) {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
    this.views.add(view);
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
      if (this.state.decodeState === "decoding") this.askKeyframe();
    });
  }

  removeView(view: VideoView) {
    this.views.delete(view);
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
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    canvas.getContext("2d")?.drawImage(source, 0, 0, width, height);
  }

  private paint(source: CanvasImageSource, width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    for (const view of this.views) {
      const canvas = view.canvas();
      if (canvas) this.drawInto(canvas, source, width, height);
    }
  }

  private paintFrame = (frame: VideoFrame) => {
    const width = frame.displayWidth > 0 ? frame.displayWidth : frame.codedWidth;
    const height = frame.displayHeight > 0 ? frame.displayHeight : frame.codedHeight;
    if (width > 0 && height > 0) this.publishSize(width, height, "frame");
    this.paint(frame, width, height);
    frame.close();
  };

  private measure = () => {
    const now = performance.now();
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
  private askKeyframe() {
    if (this.state.status?.backend !== "scrcpy") return;
    const now = Date.now();
    if (now - this.lastKeyframeAsk < KEYFRAME_ASK_MS) return;
    this.lastKeyframeAsk = now;
    void postVideoRefresh([this.serial]).catch(() => {});
  }

  private onVisibility = () => {
    if (!pageHidden() && this.gate.dropping) this.askKeyframe();
  };

  private teardownDecoder() {
    if (this.decoder) {
      try {
        if (this.decoder.state !== "closed") this.decoder.close();
      } catch {
        // ignore
      }
      this.decoder = null;
    }
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
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
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
        this.setState({ decodeState: "decoding", error: null });
        this.paintFrame(frame);
      },
      error: (err) => {
        console.warn("[video] decoder error", err);
        if (this.decoder === decoder) this.markBroken("Recovering decode…");
      },
    });
    decoder.configure({ codec, description: desc, optimizeForLatency: true });
    this.decoder = decoder;
  }

  private connect = () => {
    if (this.closed) return;
    const generation = ++this.generation;
    if (!webCodecsSupported()) {
      // LAN http:// has no WebCodecs. MSE plays the same Annex-B access units.
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
    void agentWsUrl(`/ws/devices/${encodeURIComponent(this.serial)}/video`)
      .then((url) => {
        if (generation === this.generation) this.bindSocket(url, generation);
      })
      .catch(() => {
        if (generation === this.generation) this.retryTimer = setTimeout(this.connect, 2000);
      });
  };

  private bindSocket(url: string, generation: number) {
    const socket = new WebSocket(url, agentWsProtocols());
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    const current = () => generation === this.generation && !this.closed;

    socket.onopen = () => {
      if (current()) this.setState({ decodeState: "waiting" });
    };
    socket.onmessage = (event) => {
      if (!current()) return;
      if (typeof event.data === "string") this.onStatus(event.data, generation);
      else this.onAccessUnit(new Uint8Array(event.data as ArrayBuffer));
    };
    socket.onclose = () => {
      if (!current()) return;
      this.teardownDecoder();
      this.mse?.close();
      this.mse = null;
      this.description = null;
      this.retryTimer = setTimeout(this.connect, 2000);
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
    this.setState({ status: msg });
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
    if (!this.acceptVideo || buf.byteLength === 0) return;
    this.meter.frames += 1;
    this.meter.bytes += buf.byteLength;

    if (this.mse) {
      this.mse.push(buf);
      return;
    }

    // SPS/PPS often arrive in their own access unit, before the IDR.
    const paramSets = extractSpsPps(buf);
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

    if (!annexBHasVcl(buf)) return;
    const isKey = annexBIsIdr(buf);
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
      hidden: pageHidden(),
    });
    if (verdict === "drop-ask-keyframe") this.askKeyframe();
    if (verdict !== "decode") return;

    const avcc = annexBToAvcc(buf);
    if (avcc.byteLength === 0) return;
    try {
      decoder.decode(
        new EncodedVideoChunk({ type: isKey ? "key" : "delta", timestamp: this.timestampUs, data: avcc }),
      );
      this.timestampUs += 100_000;
    } catch (err) {
      console.warn("[video] decode() threw", err);
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

export function videoState(serial: string): VideoState {
  return streams.get(serial)?.state ?? IDLE_VIDEO;
}

/** Reconnect `serial`'s stream (all of its views). */
export function restartVideo(serial: string) {
  streams.get(serial)?.restart();
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
