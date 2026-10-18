"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/*
 * "Pop out (always on top)": the live screen in the browser's
 * picture-in-picture window, which the OS keeps above other windows. It is
 * view-only: taps and keys still go through the main page. The canvas the
 * decoder paints into is captured as a stream into a hidden video.
 */
export function pictureInPictureSupported() {
  return (
    typeof document !== "undefined" &&
    document.pictureInPictureEnabled === true &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function"
  );
}

/** The hidden video the PiP window shows. */
function createPipVideo(setActive: (on: boolean) => void) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.dataset.pipVideo = "1";
  video.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
  video.addEventListener("enterpictureinpicture", () => setActive(true));
  video.addEventListener("leavepictureinpicture", () => setActive(false));
  document.body.appendChild(video);
  return video;
}

/** Feed the canvas into the hidden video and wait until it has a size. */
async function attachCanvas(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  (video.srcObject as MediaStream | null)?.getTracks().forEach((track) => track.stop());
  video.srcObject = canvas.captureStream(30);
  // PiP needs the stream's size; play() itself can stay pending on a hidden
  // video, so it is not awaited.
  void video.play().catch(() => {});
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA) return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("The live picture did not start")), 3000);
    video.addEventListener(
      "loadedmetadata",
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function usePictureInPicture(canvasRef: RefObject<HTMLCanvasElement | null>) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    // Read after mount so server and first client render agree.
    const id = window.setTimeout(() => setSupported(pictureInPictureSupported()), 0);
    return () => window.clearTimeout(id);
  }, []);

  const stop = useCallback(async () => {
    const video = videoRef.current;
    if (document.pictureInPictureElement === video && video) {
      await document.exitPictureInPicture().catch(() => {});
    }
  }, []);

  useEffect(
    () => () => {
      const video = videoRef.current;
      if (!video) return;
      if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => {});
      (video.srcObject as MediaStream | null)?.getTracks().forEach((track) => track.stop());
      video.remove();
      videoRef.current = null;
    },
    [],
  );

  const toggle = useCallback(async (): Promise<string | null> => {
    if (active) {
      await stop();
      return null;
    }
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return "No live picture to pop out yet";
    const video = videoRef.current ?? createPipVideo(setActive);
    videoRef.current = video;
    try {
      await attachCanvas(video, canvas);
      await video.requestPictureInPicture();
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Picture-in-picture was refused";
    }
  }, [active, canvasRef, stop]);

  return { active, supported, toggle };
}
