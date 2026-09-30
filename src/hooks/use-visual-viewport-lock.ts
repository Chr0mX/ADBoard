"use client";

import { useEffect } from "react";

/**
 * Lock the app shell to the visual viewport. Critical on iOS Safari / standalone
 * PWAs where 100dvh leaves a dead strip under the home indicator.
 */
export function useVisualViewportLock(active = true) {
  useEffect(() => {
    if (!active || typeof window === "undefined") return;

    const root = document.documentElement;
    const sync = () => {
      const viewport = window.visualViewport;
      // iOS: prefer visualViewport; fall back to innerHeight. Use integers to
      // avoid subpixel gaps under the stats bar.
      const height = Math.round(viewport?.height ?? window.innerHeight);
      const offsetTop = Math.round(viewport?.offsetTop ?? 0);
      root.style.setProperty("--pc-app-height", `${Math.max(height, 1)}px`);
      root.style.setProperty("--pc-app-top", `${offsetTop}px`);
      document.body.style.height = `${Math.max(height, 1)}px`;
    };

    sync();
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", sync);
    viewport?.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    // iOS sometimes reports the final height one frame after rotate.
    const onOrient = () => {
      window.setTimeout(sync, 100);
      window.setTimeout(sync, 300);
    };
    window.addEventListener("orientationchange", onOrient);
    return () => {
      viewport?.removeEventListener("resize", sync);
      viewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      window.removeEventListener("orientationchange", onOrient);
    };
  }, [active]);
}
