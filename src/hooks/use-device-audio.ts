"use client";

import { useEffect, useRef, useState } from "react";
import { defaultOpusHead, readOpusHead, webmCluster, webmInit } from "@/lib/audio/opus-webm";
import { scrcpyWsUrlAsync } from "@/lib/scrcpy/client";

interface AudioStatus {
  stream?: string;
  note?: string;
  codec?: string;
  sampleRate?: number;
  channels?: number;
  description?: string;
}

function b64(value: string): Uint8Array {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function splitPacket(bytes: Uint8Array): { pts: number; packet: Uint8Array } | null {
  if (bytes.byteLength < 9) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pts = Number(view.getBigUint64(0));
  return { pts, packet: bytes.subarray(8) };
}

class MseOpusSink {
  private audio = document.createElement("audio");
  private media = new MediaSource();
  private buffer: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  private url = "";

  constructor(description: Uint8Array, sampleRate: number, channels: number) {
    this.audio.autoplay = true;
    this.audio.setAttribute("data-scrcpy-audio-out", "mse");
    this.url = URL.createObjectURL(this.media);
    this.audio.src = this.url;
    document.body.appendChild(this.audio);
    this.media.addEventListener("sourceopen", () => {
      if (this.media.readyState !== "open") return;
      this.buffer = this.media.addSourceBuffer('audio/webm; codecs="opus"');
      this.buffer.mode = "sequence";
      this.buffer.addEventListener("updateend", () => this.drain());
      this.enqueue(webmInit(description, sampleRate, channels));
    });
  }

  push(bytes: Uint8Array) {
    const split = splitPacket(bytes);
    if (!split || split.packet.length === 0) return;
    this.enqueue(webmCluster(split.packet, split.pts));
  }

  resume() {
    void this.audio.play().catch(() => {});
  }

  close() {
    this.audio.pause();
    this.audio.remove();
    if (this.url) URL.revokeObjectURL(this.url);
  }

  private enqueue(chunk: Uint8Array) {
    this.queue.push(chunk);
    this.drain();
  }

  private drain() {
    const buffer = this.buffer;
    if (!buffer || buffer.updating || this.queue.length === 0) return;
    const next = this.queue.shift();
    if (!next) return;
    buffer.appendBuffer(next as BufferSource);
  }
}

class WebCodecsOpusSink {
  private ctx = new AudioContext();
  private decoder: AudioDecoder;
  private next = 0;

  constructor(description: Uint8Array, sampleRate: number, channels: number) {
    this.decoder = new AudioDecoder({
      output: (data) => this.play(data),
      error: () => {},
    });
    this.decoder.configure({
      codec: "opus",
      sampleRate,
      numberOfChannels: channels,
      description: description as BufferSource,
    });
  }

  push(bytes: Uint8Array) {
    const split = splitPacket(bytes);
    if (!split || split.packet.length === 0 || this.decoder.state === "closed") return;
    this.decoder.decode(
      new EncodedAudioChunk({
        type: "key",
        timestamp: split.pts,
        data: split.packet,
      }),
    );
  }

  resume() {
    void this.ctx.resume();
  }

  close() {
    if (this.decoder.state !== "closed") this.decoder.close();
    void this.ctx.close();
  }

  private play(data: AudioData) {
    const channels = data.numberOfChannels;
    const buffer = this.ctx.createBuffer(channels, data.numberOfFrames, data.sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const samples = new Float32Array(data.numberOfFrames);
      data.copyTo(samples, { planeIndex: channel, format: "f32-planar" });
      buffer.copyToChannel(samples, channel);
    }
    data.close();
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const start = Math.max(this.next, this.ctx.currentTime + 0.02);
    source.start(start);
    this.next = start + buffer.duration;
  }
}

type Sink = { push(bytes: Uint8Array): void; resume(): void; close(): void };

function openSink(status: AudioStatus): Sink | null {
  const description = status.description ? b64(status.description) : defaultOpusHead();
  const { channels, sampleRate } = readOpusHead(description);
  const rate = status.sampleRate || sampleRate;
  const count = status.channels || channels;
  const webCodecs = typeof AudioDecoder === "function";
  if (webCodecs) {
    try {
      return new WebCodecsOpusSink(description, rate, count);
    } catch {
      // Fall through to MediaSource for insecure LAN pages.
    }
  }
  if (
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported('audio/webm; codecs="opus"')
  ) {
    return new MseOpusSink(description, rate, count);
  }
  return null;
}

export function useDeviceAudio(serial: string | null, enabled: boolean) {
  const [note, setNote] = useState<string | null>(null);
  const [stream, setStream] = useState<string | null>(null);
  const sinkRef = useRef<Sink | null>(null);
  const descRef = useRef<string | null>(null);

  useEffect(() => {
    if (!serial || !enabled) {
      sinkRef.current?.close();
      sinkRef.current = null;
      return;
    }
    let closed = false;
    let socket: WebSocket | null = null;
    const connect = () => {
      if (closed) return;
      void scrcpyWsUrlAsync(serial, "audio")
        .then((url) => {
          if (closed) return;
          socket = new WebSocket(url);
          socket.binaryType = "arraybuffer";
          socket.onmessage = (event) => {
            if (typeof event.data === "string") {
              let status: AudioStatus = {};
              try {
                status = JSON.parse(event.data) as AudioStatus;
              } catch {
                return;
              }
              const playing = status.codec === "opus" && status.stream === "streaming";
              const desc = status.description ?? "";
              if (playing && sinkRef.current && descRef.current === desc) {
                sinkRef.current.resume();
              } else {
                sinkRef.current?.close();
                const sink = playing ? openSink(status) : null;
                sinkRef.current = sink;
                descRef.current = playing ? desc : null;
                sink?.resume();
              }
              setStream(status.stream ?? null);
              if (status.note) setNote(status.note);
              else if (!sinkRef.current && status.stream === "streaming") {
                setNote("This browser cannot play Opus audio on this address.");
              }
              return;
            }
            const bytes = new Uint8Array(event.data as ArrayBuffer);
            sinkRef.current?.push(bytes);
          };
          socket.onclose = () => {
            if (!closed) setTimeout(connect, 1500);
          };
        })
        .catch(() => {
          if (!closed) setTimeout(connect, 1500);
        });
    };
    connect();
    const resume = () => sinkRef.current?.resume();
    window.addEventListener("pointerdown", resume);
    window.addEventListener("keydown", resume);
    return () => {
      closed = true;
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      socket?.close();
      sinkRef.current?.close();
      sinkRef.current = null;
      descRef.current = null;
    };
  }, [serial, enabled]);

  return {
    note,
    stream,
    resume: () => sinkRef.current?.resume(),
  };
}
