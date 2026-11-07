"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { agentBaseUrl } from "@/lib/api/auth";
import {
  IDLE_VIDEO,
  notifyVideoVisibility,
  restartVideo,
  subscribeVideo,
  videoState,
  type VideoDecodeState,
  type VideoStatusMessage,
} from "@/lib/video/hub";

export type { VideoDecodeState, VideoStatusMessage, VideoStreamState } from "@/lib/video/hub";

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
 * Paint `serial`'s live screen into `canvasRef`. Views of the same phone share
 * one stream and decoder (see `@/lib/video/hub`); a null serial shows nothing.
 * Live fps/bitrate come from `useVideoStats`, so they only re-render the stats
 * line. Unsubscribe does not stop the agent session.
 */
export function useDeviceVideo(
  serial: string | null | undefined,
  refreshToken = 0,
): UseDeviceVideoResult {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameSizeRef = useRef<{ width: number; height: number } | null>(null);
  const configured = agentBaseUrl() !== null;

  const subscribe = useCallback(
    (onChange: () => void) => {
      frameSizeRef.current = serial ? videoState(serial).size : null;
      if (!serial) return () => {};
      // Track whether the canvas is on screen, so a tile scrolled away or in a
      // collapsed panel is not decoded into and painted for nothing.
      let visible = true;
      let observed: HTMLCanvasElement | null = null;
      const observer =
        typeof IntersectionObserver === "undefined"
          ? null
          : new IntersectionObserver((entries) => {
              const now = entries[entries.length - 1]?.isIntersecting ?? true;
              if (now === visible) return;
              visible = now;
              notifyVideoVisibility(serial);
            });
      const watch = () => {
        const el = canvasRef.current;
        if (!observer || el === observed) return;
        if (observed) observer.unobserve(observed);
        observed = el;
        visible = true;
        if (el) observer.observe(el);
      };
      watch();
      const unsubscribe = subscribeVideo(serial, {
        canvas: () => canvasRef.current,
        onState: (state) => {
          frameSizeRef.current = state.size;
          onChange();
        },
        visible: () => {
          watch(); // the canvas element can be replaced while subscribed
          return visible;
        },
      });
      return () => {
        observer?.disconnect();
        unsubscribe();
      };
    },
    [serial],
  );
  const state = useSyncExternalStore(
    subscribe,
    () => (serial ? videoState(serial) : IDLE_VIDEO),
    () => IDLE_VIDEO,
  );

  const lastToken = useRef(refreshToken);
  useEffect(() => {
    if (lastToken.current === refreshToken) return;
    lastToken.current = refreshToken;
    if (serial) restartVideo(serial);
  }, [serial, refreshToken]);

  return {
    canvasRef,
    status: state.status,
    decodeState: state.decodeState,
    error: state.error,
    configured,
    frameSize: state.frameSize,
    frameSizeRef,
  };
}
