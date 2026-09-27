"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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

function annexBIsKeyframe(data: Uint8Array): boolean {
  let i = 0;
  while (i + 4 < data.length) {
    let sc = 0;
    if (
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 0 &&
      data[i + 3] === 1
    ) {
      sc = 4;
    } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      sc = 3;
    } else {
      i += 1;
      continue;
    }
    const nalType = data[i + sc] & 0x1f;
    if (nalType === 5 || nalType === 7) return true;
    i += sc + 1;
  }
  return false;
}

export interface UseDeviceVideoResult {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  status: VideoStatusMessage | null;
  decodeState: VideoDecodeState;
  error: string | null;
  configured: boolean;
}

/**
 * Subscribe to `/ws/devices/{serial}/video`, decode Annex-B H264 via WebCodecs,
 * and paint onto a canvas. Closing the hook only drops the UI subscription —
 * agent sessions keep running.
 */
export function useDeviceVideo(
  serial: string | null | undefined,
): UseDeviceVideoResult {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [status, setStatus] = useState<VideoStatusMessage | null>(null);
  const [decodeState, setDecodeState] = useState<VideoDecodeState>("idle");
  const [error, setError] = useState<string | null>(null);
  const configured = Boolean(agentBaseUrl());
  const codecRef = useRef("avc1.42E01E");

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
    let configuredCodec: string | null = null;
    let timestampUs = 0;
    let sawKeyframe = false;

    const teardownDecoder = () => {
      if (decoder) {
        try {
          if (decoder.state !== "closed") decoder.close();
        } catch {
          // ignore
        }
        decoder = null;
      }
      configuredCodec = null;
      sawKeyframe = false;
    };

    const ensureDecoder = (codecString: string) => {
      if (decoder && configuredCodec === codecString && decoder.state !== "closed") {
        return decoder;
      }
      teardownDecoder();
      decoder = new VideoDecoder({
        output: (frame) => {
          if (!closed) {
            setDecodeState("decoding");
            paintFrame(frame);
          } else {
            frame.close();
          }
        },
        error: (err) => {
          console.error("[video] decoder error", err);
          if (!closed) {
            setDecodeState("error");
            setError(err.message || "H264 decode failed");
          }
        },
      });
      decoder.configure({
        codec: codecString,
        optimizeForLatency: true,
      });
      configuredCodec = codecString;
      codecRef.current = codecString;
      sawKeyframe = false;
      return decoder;
    };

    const connect = () => {
      if (closed) return;
      setDecodeState("connecting");
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
            if (msg.codecString) {
              codecRef.current = msg.codecString;
            }
            if (msg.stream === "idle") {
              setDecodeState("idle");
            } else if (msg.stream === "error") {
              setDecodeState("error");
              setError(msg.note || "stream error");
            } else if (msg.stream === "starting") {
              setDecodeState("waiting");
            } else if (msg.codecString) {
              ensureDecoder(msg.codecString);
            }
          } catch {
            // ignore
          }
          return;
        }

        const buf = new Uint8Array(event.data as ArrayBuffer);
        if (buf.byteLength === 0) return;

        const dec = ensureDecoder(codecRef.current);
        if (dec.state === "closed") return;

        const isKey = annexBIsKeyframe(buf);
        if (!sawKeyframe && !isKey) {
          return;
        }
        if (isKey) sawKeyframe = true;

        try {
          dec.decode(
            new EncodedVideoChunk({
              type: isKey ? "key" : "delta",
              timestamp: timestampUs,
              data: buf,
            }),
          );
          timestampUs += 100_000;
        } catch (err) {
          console.error("[video] decode() failed", err);
          setDecodeState("error");
          setError(err instanceof Error ? err.message : "decode failed");
        }
      };

      socket.onclose = () => {
        teardownDecoder();
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
