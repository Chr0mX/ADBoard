import {
  annexBHasVcl,
  annexBIsIdr,
  annexBToAvcc,
  codecStringFromSps,
  extractSpsPps,
  spsDimensions,
} from "./h264";
import { createInitSegment, createMediaSegment } from "./fmp4";

/**
 * Plays Annex-B H264 with MediaSource. Used when the page is opened by LAN IP:
 * that origin is not a secure context, so WebCodecs is missing, but MSE is not.
 */
export class MseH264Player {
  private video: HTMLVideoElement;
  private media: MediaSource;
  private url: string;
  private sb: SourceBuffer | null = null;
  private queue: Uint8Array[] = [];
  private held: Uint8Array[] = [];
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private codec = "avc1.42E01E";
  private sourceOpen = false;
  private sawKey = false;
  private sequence = 1;
  private decodeTime = 0;
  private raf = 0;
  private closed = false;
  private painted = false;

  constructor(
    private canvas: () => HTMLCanvasElement | null,
    private onPicture: (size: { width: number; height: number }) => void,
    private onError: (message: string) => void,
  ) {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.style.cssText =
      "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.appendChild(this.video);
    this.media = new MediaSource();
    this.url = URL.createObjectURL(this.media);
    this.video.src = this.url;
    this.media.addEventListener("sourceopen", () => {
      this.sourceOpen = true;
      const waiting = this.held;
      this.held = [];
      for (const au of waiting) this.push(au);
      void this.video.play().catch(() => {
        if (!this.closed) this.onError("Browser blocked video playback");
      });
    });
    this.raf = requestAnimationFrame(() => this.draw());
  }

  push(au: Uint8Array) {
    if (this.closed) return;
    const sets = extractSpsPps(au);
    if (sets) {
      this.sps = sets.sps;
      this.pps = sets.pps;
      this.codec = codecStringFromSps(sets.sps);
    }
    if (!this.sourceOpen) {
      this.held.push(au);
      return;
    }
    if (!annexBHasVcl(au) || !this.sps || !this.pps) return;
    const key = annexBIsIdr(au);
    if (!this.sawKey && !key) return;
    if (!this.sb && !key) return;
    this.ensureBuffer();
    if (!this.sb) return;
    if (key) this.sawKey = true;
    const sample = annexBToAvcc(au);
    if (sample.byteLength === 0) return;
    this.enqueue(
      createMediaSegment(sample, this.sequence, this.decodeTime, key),
    );
    this.sequence += 1;
    this.decodeTime += 33;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    cancelAnimationFrame(this.raf);
    this.queue = [];
    try {
      if (this.media.readyState === "open") this.media.endOfStream();
    } catch {
      // ignore
    }
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    URL.revokeObjectURL(this.url);
    this.video.remove();
  }

  private ensureBuffer() {
    if (this.sb || !this.sourceOpen || !this.sps || !this.pps) return;
    const mime = `video/mp4; codecs="${this.codec}"`;
    const chosen = MediaSource.isTypeSupported(mime)
      ? mime
      : 'video/mp4; codecs="avc1.42E01E"';
    if (!MediaSource.isTypeSupported(chosen)) {
      this.onError("This browser cannot play the H264 stream");
      return;
    }
    this.sb = this.media.addSourceBuffer(chosen);
    this.sb.mode = "segments";
    this.sb.addEventListener("updateend", () => this.pump());
    this.sb.addEventListener("error", () => {
      if (!this.closed) this.onError("H264 playback failed");
    });
    const size = spsDimensions(this.sps) ?? { width: 16, height: 16 };
    this.enqueue(createInitSegment(this.sps, this.pps, size.width, size.height));
  }

  private enqueue(chunk: Uint8Array) {
    this.queue.push(chunk);
    this.pump();
  }

  private pump() {
    const sb = this.sb;
    if (!sb || sb.updating || this.queue.length === 0 || this.closed) return;
    if (this.video.buffered.length > 0) {
      const start = this.video.buffered.start(0);
      if (this.video.currentTime - start > 1.5) {
        try {
          sb.remove(start, Math.max(start, this.video.currentTime - 0.4));
          return;
        } catch {
          // fall through and append
        }
      }
    }
    const next = this.queue.shift();
    if (!next) return;
    try {
      sb.appendBuffer(next.slice());
    } catch (err) {
      console.warn("[video] mse append failed", err);
      if (!this.closed) this.onError("H264 playback failed");
    }
  }

  private draw = () => {
    if (this.closed) return;
    const canvas = this.canvas();
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (canvas && width > 0 && height > 0) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(this.video, 0, 0, width, height);
      if (this.video.buffered.length > 0) {
        const end = this.video.buffered.end(this.video.buffered.length - 1);
        if (end - this.video.currentTime > 0.35) {
          this.video.currentTime = Math.max(0, end - 0.05);
        }
      }
      if (!this.painted) {
        this.painted = true;
        this.onPicture({ width, height });
      }
    }
    this.raf = requestAnimationFrame(this.draw);
  };
}
