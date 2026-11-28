import {
  annexBHasVcl,
  annexBIsIdr,
  annexBToAvcc,
  codecStringFromSps,
  extractSpsPps,
  spsDimensions,
} from "./h264";
import { createInitSegment, createMediaSegment } from "./fmp4";
import { createSegmentQueue, trimRange } from "./mse-queue-core";

/** Access units held while the MediaSource opens. Past this, wait for the next keyframe. */
const MAX_HELD = 120;

/**
 * Plays Annex-B H264 with MediaSource. Used when the page is opened by LAN IP:
 * that origin is not a secure context, so WebCodecs is missing, but MSE is not.
 */
export interface MsePlaybackHealth {
  /** HTMLMediaElement readyState: 0 nothing, 1 metadata, 2 current frame, 3 future data, 4 enough data. */
  readyState: number;
  paused: boolean;
  currentTime: number;
  bufferedEnd: number;
  /** How far playback is behind the newest buffered picture. */
  behindMs: number;
  /** MediaError code, or null. */
  error: number | null;
  sourceOpen: boolean;
  appended: number;
  played: number;
}

export class MseH264Player {
  private video: HTMLVideoElement;
  private media!: MediaSource;
  private url!: string;
  private sb: SourceBuffer | null = null;
  private queue = createSegmentQueue<Uint8Array>();
  private lastTrimAt = 0;
  private held: Uint8Array[] = [];
  private sps: Uint8Array | null = null;
  private pps: Uint8Array | null = null;
  private codec = "avc1.42E01E";
  private picture: { width: number; height: number } | null = null;
  private sourceOpen = false;
  /** Samples queued for playback since this player was made: it advances only while pictures really go in. */
  private appendedCount = 0;
  private sawKey = false;
  private sequence = 1;
  private mediaTime = 0;
  private lastPushAt = 0;
  private keyTimes: number[] = [];
  private lastSeekAt = 0;
  private raf = 0;
  private closed = false;
  private painted = false;

  constructor(
    /** Called on every animation frame with the playing video. */
    private paint: (source: HTMLVideoElement, width: number, height: number) => void,
    private onSize: (
      size: { width: number; height: number },
      source: "sps" | "frame",
    ) => void,
    private onPlaying: () => void,
    private onError: (message: string) => void,
  ) {
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.dataset.scrcpyVideo = "mse";
    this.video.style.cssText =
      "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.appendChild(this.video);
    this.attachMedia();
    this.raf = requestAnimationFrame(() => this.draw());
  }

  private attachMedia() {
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
  }

  get appended(): number {
    return this.appendedCount;
  }

  /**
   * Advances only while the video element really plays new pictures. `appended` counts what was queued, which
   * keeps growing while a stalled element shows the same picture; the stall watch needs this one.
   */
  get played(): number {
    // Playback position in ms. Not `getVideoPlaybackQuality().totalVideoFrames`: Chromium keeps counting decoded
    // frames on a paused element, so a stalled picture would still look like progress.
    return Math.round(this.video.currentTime * 1000);
  }

  /** What the hidden video element is doing, for the perf report. */
  health(): MsePlaybackHealth {
    const video = this.video;
    const bufferedEnd = video.buffered.length > 0 ? video.buffered.end(video.buffered.length - 1) : 0;
    return {
      readyState: video.readyState,
      paused: video.paused,
      currentTime: Math.round(video.currentTime * 1000) / 1000,
      bufferedEnd: Math.round(bufferedEnd * 1000) / 1000,
      behindMs: Math.max(0, Math.round((bufferedEnd - video.currentTime) * 1000)),
      error: video.error ? video.error.code : null,
      sourceOpen: this.sourceOpen,
      appended: this.appendedCount,
      played: this.played,
    };
  }

  /**
   * Get a stuck element moving again without throwing the player away: play it if it paused (an autoplay refusal,
   * a tab switch), and jump to the newest buffered picture if it fell more than a second behind.
   */
  nudge(): "played" | "jumped" | "nothing" {
    const video = this.video;
    if (this.closed) return "nothing";
    if (video.paused) {
      void video.play().catch(() => {});
      return "played";
    }
    if (video.buffered.length > 0) {
      const end = video.buffered.end(video.buffered.length - 1);
      if (end - video.currentTime > 1) {
        try {
          video.currentTime = Math.max(video.currentTime, end - 0.1);
          return "jumped";
        } catch {
          // seeking while the buffer updates; the next look tries again
        }
      }
    }
    return "nothing";
  }

  push(au: Uint8Array) {
    if (this.closed) return;
    const sets = extractSpsPps(au);
    if (sets) {
      const codec = codecStringFromSps(sets.sps);
      const size = spsDimensions(sets.sps);
      const sizeChanged =
        size != null &&
        this.picture != null &&
        (size.width !== this.picture.width || size.height !== this.picture.height);
      if (this.sb && (codec !== this.codec || sizeChanged)) {
        this.sps = sets.sps;
        this.pps = sets.pps;
        this.codec = codec;
        this.picture = size ?? this.picture;
        this.reopen(au);
        return;
      }
      this.sps = sets.sps;
      this.pps = sets.pps;
      this.codec = codec;
      if (size && size.width > 0 && size.height > 0) {
        this.picture = size;
        this.onSize(size, "sps");
      }
    }
    if (!this.sourceOpen) {
      // A source that is slow to open must not collect frames without limit:
      // start again from the newest keyframe.
      if (this.held.length >= MAX_HELD && annexBIsIdr(au)) this.held = [];
      if (this.held.length < MAX_HELD) this.held.push(au);
      return;
    }
    if (!annexBHasVcl(au) || !this.sps || !this.pps) return;
    const key = annexBIsIdr(au);
    if (!this.sawKey && !key) return;
    if (!this.sb && !key) return;
    this.ensureBuffer();
    if (!this.sb) return;
    if (key) {
      this.sawKey = true;
      this.keyTimes.push(this.mediaTime / 1000);
      if (this.keyTimes.length > 12) this.keyTimes.shift();
    }
    const sample = annexBToAvcc(au);
    if (sample.byteLength === 0) return;
    const duration = this.frameDuration();
    const queued = this.queue.push(createMediaSegment(sample, this.sequence, this.mediaTime, key, duration), key);
    if (!queued) {
      // The SourceBuffer cannot keep up: frames are skipped until a keyframe.
      this.sawKey = false;
      return;
    }
    this.appendedCount += 1;
    this.pump();
    this.sequence += 1;
    this.mediaTime += duration;
  }

  /** Match the phone's arrival rate. A fixed 30 fps clock runs behind a 60 fps stream. */
  private frameDuration(): number {
    const now = performance.now();
    const gap = this.lastPushAt === 0 ? 16 : now - this.lastPushAt;
    this.lastPushAt = now;
    return Math.round(Math.min(80, Math.max(8, gap)));
  }

  /** New encoder size or profile needs a new SourceBuffer. Repeating SPS does not. */
  private reopen(au: Uint8Array) {
    this.queue.clear();
    this.held = [au];
    this.sb = null;
    this.sourceOpen = false;
    this.sawKey = false;
    this.mediaTime = 0;
    this.keyTimes = [];
    this.lastPushAt = 0;
    try {
      if (this.media.readyState === "open") this.media.endOfStream();
    } catch {
      // already closing
    }
    this.video.pause();
    URL.revokeObjectURL(this.url);
    this.attachMedia();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    cancelAnimationFrame(this.raf);
    this.queue.clear();
    this.held = [];
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
    // Sequence mode plays appended samples back to back. Segment mode plus a
    // fixed 33 ms clock made Original (60 fps) jump into the middle of a GOP.
    this.sb.mode = "sequence";
    this.sb.addEventListener("updateend", () => this.pump());
    this.sb.addEventListener("error", () => {
      if (!this.closed) this.onError("H264 playback failed");
    });
    const size = spsDimensions(this.sps) ?? { width: 16, height: 16 };
    this.queue.pushRequired(createInitSegment(this.sps, this.pps, size.width, size.height));
    this.pump();
  }

  private pump() {
    const sb = this.sb;
    if (!sb || sb.updating || this.closed) return;
    if (this.queue.length === 0) {
      this.trim(sb);
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    try {
      sb.appendBuffer(next.slice());
    } catch (err) {
      const quota = err instanceof DOMException && err.name === "QuotaExceededError";
      if (quota && this.video.buffered.length > 0) {
        this.queue.unshift(next);
        try {
          const start = this.video.buffered.start(0);
          sb.remove(start, start + 1);
        } catch {
          if (!this.closed) this.onError("H264 playback failed");
        }
        return;
      }
      console.warn("[video] mse append failed", err);
      if (!this.closed) this.onError("H264 playback failed");
    }
  }

  /** Remove video that was already played, so the buffer does not grow for hours. */
  private trim(sb: SourceBuffer) {
    const now = performance.now();
    if (now - this.lastTrimAt < 2000 || this.video.buffered.length === 0) return;
    const range = trimRange(this.video.buffered.start(0), this.video.currentTime);
    if (!range) return;
    this.lastTrimAt = now;
    try {
      sb.remove(range.start, range.end);
    } catch {
      // the buffer is busy; the next idle moment tries again
    }
  }

  /** Jump only to a keyframe, and not on every frame. */
  private catchUp() {
    const video = this.video;
    if (video.buffered.length === 0) return;
    const end = video.buffered.end(video.buffered.length - 1);
    if (end - video.currentTime < 0.75) return;
    const now = performance.now();
    if (now - this.lastSeekAt < 1000) return;
    const target = [...this.keyTimes]
      .reverse()
      .find((time) => time < end - 0.02 && time > video.currentTime);
    if (target == null) return;
    this.lastSeekAt = now;
    try {
      video.currentTime = target;
    } catch {
      // seek while updating
    }
  }

  private draw = () => {
    if (this.closed) return;
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (width > 0 && height > 0) {
      this.paint(this.video, width, height);
      this.catchUp();
      this.onSize({ width, height }, "frame");
      if (!this.painted) {
        this.painted = true;
        this.onPlaying();
      }
    }
    this.raf = requestAnimationFrame(this.draw);
  };
}
