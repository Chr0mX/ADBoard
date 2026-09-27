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
  return raw.replace(/\/$/, "");
}

function httpToWs(base: string): string {
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
}

/**
 * Subscribe to `/ws/devices/{serial}/video`, decode Annex-B H264 via WebCodecs
 * (converted to AVCC + avcC description), paint onto a canvas.
 * Unsubscribing does not stop the agent session.
 */
export function useDeviceVideo(
  serial: string | null | undefined,
): UseDeviceVideoResult {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<VideoStatusMessage | null>(null);
  const [decodeState, setDecodeState] = useState<VideoDecodeState>("idle");
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(agentBaseUrl());

  const paintFrame = useCallback((frame: VideoFrame) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      frame.close();
      return;
    }
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
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
      return;
    }

    const base = agentBaseUrl();
    if (!base) {
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
    let needsReset = false;

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

    const createDecoder = (desc: Uint8Array, codec: string) => {
      teardownDecoder();
      needsReset = false;
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
          console.warn("[video] decoder error — will reset on next IDR", err);
          needsReset = true;
          if (!closed) {
            setDecodeState("waiting");
            setError("Recovering decode…");
          }
        },
      });
      decoder.configure({
        codec,
        description: desc,
        optimizeForLatency: true,
      });
      sawKeyframe = false;
      return decoder;
    };

    const connect = () => {
      if (closed) return;
      setDecodeState("connecting");
      description = null;
      needsReset = false;
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

        if (!description) {
          // Wait for an AU that carries SPS/PPS.
          return;
        }

        if (needsReset || !decoder || decoder.state === "closed") {
          if (!isKey) return;
          createDecoder(description, codecString);
        }

        if (!sawKeyframe && !isKey) return;
        if (isKey) sawKeyframe = true;

        const avcc = annexBToAvcc(buf);
        if (avcc.byteLength === 0) return;

        try {
          if (!decoder || decoder.state !== "configured") return;
          decoder.decode(
            new EncodedVideoChunk({
              type: isKey ? "key" : "delta",
              timestamp: timestampUs,
              data: avcc,
            }),
          );
          timestampUs += 100_000;
        } catch (err) {
          console.warn("[video] decode() failed — reset on next IDR", err);
          needsReset = true;
          teardownDecoder();
          if (!closed) {
            setDecodeState("waiting");
            setError("Recovering decode…");
          }
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

  return { canvasRef, status, decodeState, error, configured };
}
