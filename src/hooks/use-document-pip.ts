"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/*
 * "Pop out (always on top)" as a Document Picture-in-Picture window (Chrome and
 * Edge). The window is a real page: the live picture is drawn into it each
 * frame, and touch and mouse in that window go back through the same pointer
 * path as the main page, so the phone is controlled from the pop-out.
 */

export type PipPhase = "down" | "move" | "up" | "cancel";
export type PipPointer = (phase: PipPhase, event: PointerEvent, rect: DOMRect) => void;

type DocumentPip = { requestWindow(options: { width: number; height: number }): Promise<Window> };

/** Pop-out window width; the height follows the phone's shape. */
const WINDOW_WIDTH = 360;
/** The drawn picture is scaled down to at most this many pixels tall. */
const MAX_PICTURE_HEIGHT = 720;

function documentPip(): DocumentPip | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture ?? null;
}

export function useDocumentPip(source: RefObject<HTMLCanvasElement | null>, onPointer: PipPointer) {
  const [active, setActive] = useState(false);
  const [supported, setSupported] = useState(false);
  const windowRef = useRef<Window | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const pointerRef = useRef(onPointer);

  useEffect(() => {
    pointerRef.current = onPointer;
  });

  useEffect(() => {
    // Read after mount so server and first client render agree.
    const id = window.setTimeout(() => setSupported(documentPip() !== null), 0);
    return () => window.clearTimeout(id);
  }, []);

  const close = useCallback(() => {
    windowRef.current?.close();
  }, []);

  // Leaving the page closes the pop-out too.
  useEffect(
    () => () => {
      stopRef.current?.();
      windowRef.current?.close();
    },
    [],
  );

  const toggle = useCallback(async (): Promise<string | null> => {
    if (windowRef.current) {
      close();
      return null;
    }
    const api = documentPip();
    const canvas = source.current;
    if (!api) return "Pop out is not supported in this browser";
    if (!canvas || canvas.width === 0) return "No live picture to pop out yet";

    const height = Math.round((WINDOW_WIDTH * canvas.height) / canvas.width);
    let win: Window;
    try {
      win = await api.requestWindow({ width: WINDOW_WIDTH, height });
    } catch (error) {
      return error instanceof Error ? error.message : "Pop out was refused";
    }

    const doc = win.document;
    doc.title = "ADBoard";
    doc.body.style.cssText = "margin:0;background:#000;height:100vh;overflow:hidden;";
    const out = doc.createElement("canvas");
    out.style.cssText = "display:block;width:100%;height:100%;object-fit:contain;touch-action:none;user-select:none;";
    doc.body.append(out);
    const ctx = out.getContext("2d");

    let frame = 0;
    const draw = () => {
      const src = source.current;
      if (src && src.width > 0 && ctx) {
        const scale = Math.min(1, MAX_PICTURE_HEIGHT / src.height);
        const w = Math.round(src.width * scale);
        const h = Math.round(src.height * scale);
        if (out.width !== w || out.height !== h) {
          out.width = w;
          out.height = h;
        }
        ctx.drawImage(src, 0, 0, w, h);
      }
      frame = win.requestAnimationFrame(draw);
    };

    const onDown = (event: PointerEvent) => {
      out.setPointerCapture(event.pointerId);
      pointerRef.current("down", event, out.getBoundingClientRect());
    };
    const onMove = (event: PointerEvent) => pointerRef.current("move", event, out.getBoundingClientRect());
    const onUp = (event: PointerEvent) => pointerRef.current("up", event, out.getBoundingClientRect());
    const onCancel = (event: PointerEvent) => pointerRef.current("cancel", event, out.getBoundingClientRect());
    out.addEventListener("pointerdown", onDown);
    out.addEventListener("pointermove", onMove);
    out.addEventListener("pointerup", onUp);
    out.addEventListener("pointercancel", onCancel);

    const stop = () => {
      win.cancelAnimationFrame(frame);
      out.removeEventListener("pointerdown", onDown);
      out.removeEventListener("pointermove", onMove);
      out.removeEventListener("pointerup", onUp);
      out.removeEventListener("pointercancel", onCancel);
      if (windowRef.current === win) windowRef.current = null;
      if (stopRef.current === stop) stopRef.current = null;
      setActive(false);
    };
    win.addEventListener("pagehide", stop, { once: true });
    windowRef.current = win;
    stopRef.current = stop;
    setActive(true);
    frame = win.requestAnimationFrame(draw);
    return null;
  }, [close, source]);

  return { active, supported, toggle };
}
