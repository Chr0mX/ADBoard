"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  annexBHasVcl,
  annexBIsIdr,
  annexBToAvcc,
  buildAvcDecoderConfig,
  codecStringFromSps,
  extractSpsPps,
} from "@/lib/video/h264";

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

export interface UseDeviceVideoResult {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  status: VideoStatusMessage | null;
  decodeState: VideoDecodeState;
  error: string | null;
  configured: boolean;
  /** Decoded frame size. The click target uses this so taps match the picture. */
  frameSize: { width: number; height: number } | null;
}

/**
 * Subscribe to `/ws/devices/{serial}/video`, decode Annex-B H264 via WebCodecs
 * (AVCC + avcC), paint onto a canvas. Unsubscribe does not stop the agent session.
 */
export function useDeviceVideo(
  serial: string | null | undefined,
): UseDeviceVideoResult {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<VideoStatusMessage | null>(null);
  const [decodeState, setDecodeState] = useState<VideoDecodeState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const configured = agentBaseUrl() !== null;

  const paintFrame = useCallback((frame: VideoFrame) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      frame.close();
      return;
    }
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      setFrameSize({ width: frame.displayWidth, height: frame.displayHeight });
    }
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
    }
    frame.close();
  }, []);

  useEffect(() => {
    if (!serial) {
      setStatus(null);
      setDecodeState("idle");
      setError(null);
      setFrameSize(null);
      return;
    }
    setFrameSize(null);

    const base = agentBaseUrl();
    // "" is same-origin (packaged UI). Only null means the in-browser mock.
    if (base === null) {
      setDecodeState("idle");
      setError(null);
      return;
    }

    if (!webCodecsSupported()) {
      setDecodeState("unsupported");
      setError("WebCodecs VideoDecoder is not available in this browser");
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
    /** When set, ignore all input until the next SPS+IDR AU recreates the decoder. */
    let waitingForKeyframeConfig = false;
    let lastResetAt = 0;

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
            if (msg.codecString) codecString = msg.codecString;
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

        const buf = new Uint8Array(event.data as ArrayBuffer);
        if (buf.byteLength === 0 || !annexBHasVcl(buf)) return;

        const paramSets = extractSpsPps(buf);
        if (paramSets) {
          description = buildAvcDecoderConfig(paramSets.sps, paramSets.pps);
          codecString = codecStringFromSps(paramSets.sps);
        }

        const isKey = annexBIsIdr(buf);
        // Prefer keyframes that carry SPS/PPS so avcC stays in sync.
        const isConfigKey = isKey && !!paramSets;

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
      socket?.close();
    };
  }, [serial, paintFrame]);

  return { canvasRef, status, decodeState, error, configured, frameSize };
}
