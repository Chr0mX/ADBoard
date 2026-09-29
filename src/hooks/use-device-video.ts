"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
import { postVideoRefresh } from "@/lib/scrcpy/client";
import type { StreamStats } from "@/lib/devices/types";

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

function agentBaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_AGENT_URL?.trim();
  if (!raw) return null;
  if (raw === "same" || raw === "same-origin") return "";
  return raw.replace(/\/$/, "");
}

function httpToWs(base: string): string {
  if (!base && typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss://" : "ws://";
    return `${proto}${window.location.host}`;
  }
  if (base.startsWith("https://")) return `wss://${base.slice("https://".length)}`;
  if (base.startsWith("http://")) return `ws://${base.slice("http://".length)}`;
  return base;
}

function webCodecsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as unknown as { VideoDecoder?: unknown }).VideoDecoder ===
      "function"
  );
}

function mseSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')
  );
}

export interface UseDeviceVideoResult {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  status: VideoStatusMessage | null;
  decodeState: VideoDecodeState;
  error: string | null;
  configured: boolean;
  /** Decoded frame size. The click target uses this so taps match the picture. */
  frameSize: { width: number; height: number } | null;
  /**
   * Latest non-zero video size, updated as soon as SPS or a status frame
   * arrives — before React re-renders and before the first painted frame.
   */
  frameSizeRef: React.RefObject<{
    width: number;
    height: number;
  } | null>;
}

/**
 * Subscribe to `/ws/devices/{serial}/video`, decode Annex-B H264 via WebCodecs
 * (AVCC + avcC), paint onto a canvas. Unsubscribe does not stop the agent session.
 */
const EMPTY_STATS: StreamStats = {
  fps: 0,
  bitrateKbps: 0,
  width: 0,
  height: 0,
  codec: "h264",
};

export function useDeviceVideo(
  serial: string | null | undefined,
  refreshToken = 0,
): UseDeviceVideoResult & { stats: StreamStats } {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<VideoStatusMessage | null>(null);
  const [decodeState, setDecodeState] = useState<VideoDecodeState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const frameSizeRef = useRef<TrackedVideoSize | null>(null);
  const configured = agentBaseUrl() !== null;
  const [stats, setStats] = useState<StreamStats>(EMPTY_STATS);
  const meter = useRef({ t: 0, frames: 0, bytes: 0 });

  const publishSize = useCallback(
    (width: number, height: number, source: "sps" | "status" | "frame") => {
      const next = nextVideoSize(frameSizeRef.current, width, height, source);
      if (!next || next === frameSizeRef.current) return;
      frameSizeRef.current = next;
      setFrameSize((prev) =>
        prev && prev.width === next.width && prev.height === next.height
          ? prev
          : { width: next.width, height: next.height },
      );
    },
    [],
  );

  const paintFrame = useCallback(
    (frame: VideoFrame) => {
      const canvas = canvasRef.current;
      if (!canvas) {
        frame.close();
        return;
      }
      const displayW = frame.displayWidth > 0 ? frame.displayWidth : frame.codedWidth;
      const displayH = frame.displayHeight > 0 ? frame.displayHeight : frame.codedHeight;
      if (displayW > 0 && displayH > 0) {
        publishSize(displayW, displayH, "frame");
      }
      const shown = frameSizeRef.current;
      const width = shown?.width || displayW;
      const height = shown?.height || displayH;
      if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d");
      if (ctx && canvas.width > 0 && canvas.height > 0) {
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      }
      frame.close();
    },
    [publishSize],
  );

  useEffect(() => {
    if (!serial) {
      setStatus(null);
      setDecodeState("idle");
      setError(null);
      setFrameSize(null);
      frameSizeRef.current = null;
      return;
    }
    setFrameSize(null);
    frameSizeRef.current = null;

    const base = agentBaseUrl();
    // "" is same-origin (packaged UI). Only null means the in-browser mock.
    if (base === null) {
      setDecodeState("idle");
      setError(null);
      return;
    }

    const useMse = !webCodecsSupported();
    if (useMse && !mseSupported()) {
      setDecodeState("unsupported");
      setError("H264 decode is not available in this browser");
      return;
    }

    let closed = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let decoder: VideoDecoder | null = null;
    let description: Uint8Array | null = null;
    let codecString = "avc1.42E01E";
    let timestampUs = 0;
    let sawKeyframe = false;
    /** Cropped SPS size. A later SPS with different dimensions needs a new decoder. */
    let pictureW = 0;
    let pictureH = 0;
    /** When set, ignore all input until the next SPS+IDR AU recreates the decoder. */
    let waitingForKeyframeConfig = false;
    let lastResetAt = 0;
    let mse: MseH264Player | null = null;
    // Drop bytes that arrived before Refresh's keyframe. Those P-frames
    // decode against an older IDR and the canvas stays green.
    let acceptVideo = false;
    let refreshAsked = false;

    const openMse = () => {
      mse?.close();
      mse = new MseH264Player(
        () => canvasRef.current,
        (size, source) => {
          if (closed) return;
          publishSize(size.width, size.height, source);
        },
        () => {
          if (closed) return;
          setDecodeState("decoding");
          setError(null);
        },
        (message) => {
          if (closed) return;
          setDecodeState("error");
          setError(message);
        },
      );
    };

    const teardownDecoder = () => {
      if (decoder) {
        try {
          if (decoder.state !== "closed") decoder.close();
        } catch {
          // ignore
        }
        decoder = null;
      }
      sawKeyframe = false;
    };

    const markBroken = (reason: string) => {
      const now = Date.now();
      // Throttle reset storms (multi-slice / bad AU spam).
      if (now - lastResetAt < 500) {
        waitingForKeyframeConfig = true;
        teardownDecoder();
        return;
      }
      lastResetAt = now;
      waitingForKeyframeConfig = true;
      teardownDecoder();
      if (!closed) {
        setDecodeState("waiting");
        setError(reason);
      }
    };

    const createDecoder = (desc: Uint8Array, codec: string) => {
      teardownDecoder();
      waitingForKeyframeConfig = false;
      decoder = new VideoDecoder({
        output: (frame) => {
          if (!closed) {
            setDecodeState("decoding");
            setError(null);
            paintFrame(frame);
          } else {
            frame.close();
          }
        },
        error: (err) => {
          console.warn("[video] decoder error", err);
          markBroken("Recovering decode…");
        },
      });
      decoder.configure({
        codec,
        description: desc,
        optimizeForLatency: true,
      });
      return decoder;
    };

    const connect = () => {
      if (closed) return;
      if (useMse) openMse();
      setDecodeState("connecting");
      description = null;
      waitingForKeyframeConfig = false;
      const url = `${httpToWs(base)}/ws/devices/${encodeURIComponent(serial)}/video`;
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        if (!closed) setDecodeState("waiting");
      };

      socket.onmessage = (event) => {
        if (closed) return;
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as VideoStatusMessage;
            setStatus(msg);
            if (msg.backend === "scrcpy" && !refreshAsked) {
              refreshAsked = true;
              void postVideoRefresh([serial]).finally(() => {
                acceptVideo = true;
              });
            } else if (msg.backend && msg.backend !== "scrcpy") {
              acceptVideo = true;
            }
            if (msg.codecString) codecString = msg.codecString;
            if (msg.width && msg.height && msg.width > 0 && msg.height > 0) {
              publishSize(msg.width, msg.height, "status");
            }
            if (msg.stream === "idle") {
              setDecodeState("idle");
            } else if (msg.stream === "error") {
              setDecodeState("error");
              setError(msg.note || "stream error");
            } else if (msg.stream === "starting" || msg.stream === "streaming") {
              setDecodeState((prev) => (prev === "decoding" ? prev : "waiting"));
            }
          } catch {
            // ignore
          }
          return;
        }

        if (!acceptVideo) return;
        const buf = new Uint8Array(event.data as ArrayBuffer);
        if (buf.byteLength === 0) return;
        const sample = meter.current;
        if (sample.t === 0) sample.t = performance.now();
        sample.frames += 1;
        sample.bytes += buf.byteLength;

        // LAN http:// has no WebCodecs. MSE plays the same Annex-B access units.
        if (mse) {
          mse.push(buf);
          return;
        }

        // SPS/PPS often arrive in their own access unit, before the IDR.
        const paramSets = extractSpsPps(buf);
        if (paramSets) {
          description = buildAvcDecoderConfig(paramSets.sps, paramSets.pps);
          codecString = codecStringFromSps(paramSets.sps);
          const dims = spsDimensions(paramSets.sps);
          if (dims && dims.width > 0 && dims.height > 0) {
            publishSize(dims.width, dims.height, "sps");
            const sizeChanged =
              pictureW > 0 &&
              (dims.width !== pictureW || dims.height !== pictureH);
            pictureW = dims.width;
            pictureH = dims.height;
            // The existing decoder keeps the old coded size. Drop it so this
            // access unit's IDR (or the next one) configures the new picture.
            if (sizeChanged) {
              waitingForKeyframeConfig = true;
              teardownDecoder();
            }
          }
        }

        if (!annexBHasVcl(buf)) return;

        const isKey = annexBIsIdr(buf);
        // An earlier SPS/PPS AU is enough; the IDR does not have to repeat it.
        const isConfigKey = isKey && description != null;

        if (!description) {
          return; // wait for SPS/PPS
        }

        const needNewDecoder =
          waitingForKeyframeConfig ||
          !decoder ||
          decoder.state === "closed" ||
          decoder.state === "unconfigured";

        if (needNewDecoder) {
          if (!isConfigKey) return; // wait for SPS+IDR together
          createDecoder(description, codecString);
          sawKeyframe = false;
        }

        if (!sawKeyframe && !isKey) return;
        if (isKey) sawKeyframe = true;

        // Never feed a closed/broken decoder.
        if (!decoder || decoder.state !== "configured") return;

        const avcc = annexBToAvcc(buf);
        if (avcc.byteLength === 0) return;

        try {
          decoder.decode(
            new EncodedVideoChunk({
              type: isKey ? "key" : "delta",
              timestamp: timestampUs,
              data: avcc,
            }),
          );
          timestampUs += 100_000;
        } catch (err) {
          console.warn("[video] decode() threw", err);
          markBroken("Recovering decode…");
        }
      };

      socket.onclose = () => {
        teardownDecoder();
        description = null;
        if (!closed) {
          retryTimer = setTimeout(connect, 2000);
        }
      };

      socket.onerror = () => {
        socket?.close();
      };
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      teardownDecoder();
      mse?.close();
      socket?.close();
    };
  }, [serial, refreshToken, paintFrame, publishSize]);

  useEffect(() => {
    meter.current = { t: performance.now(), frames: 0, bytes: 0 };
    const timer = setInterval(() => {
      const now = performance.now();
      const sample = meter.current;
      const seconds = Math.max(0.001, (now - sample.t) / 1000);
      const size = frameSizeRef.current;
      const next = {
        fps: sample.frames / seconds,
        bitrateKbps: (sample.bytes * 8) / 1000 / seconds,
        width: size?.width ?? 0,
        height: size?.height ?? 0,
        codec: "h264",
      };
      setStats((prev) =>
        Math.round(prev.fps) === Math.round(next.fps) &&
        Math.round(prev.bitrateKbps) === Math.round(next.bitrateKbps) &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
      );
      meter.current = { t: now, frames: 0, bytes: 0 };
    }, 500);
    return () => clearInterval(timer);
  }, [serial, refreshToken]);

  return {
    canvasRef,
    status,
    decodeState,
    error,
    configured,
    frameSize,
    frameSizeRef,
    stats,
  };
}
