"use client";

import { useEffect } from "react";
import { keyboardInset, readStandalone } from "@/lib/pwa/standalone";

/**
 * Lock the app shell to the visual viewport. Critical on iOS Safari / standalone
 * PWAs where 100dvh leaves a dead strip under the home indicator.
 */
export function useVisualViewportLock(active = true) {
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    // Diagnostic switch (More → Display info): leave the page alone to see what the browser gives it.
    try {
      if (window.localStorage.getItem("adboard-m-no-vv-sync") === "1") return;
    } catch {
      // storage blocked: sync as usual
    }

    const root = document.documentElement;
    // Optional styling hook: html[data-standalone] in an installed app. The
    // layout itself never depends on it.
    if (readStandalone()) root.dataset.standalone = "1";
    else delete root.dataset.standalone;
    let frame = 0;
    const sync = () => {
      const viewport = window.visualViewport;
      // The smallest of the visual viewport, innerHeight and the layout
      // viewport. An iOS Home Screen app (standalone, black-translucent
      // status bar) can report a visual viewport taller than the area it
      // hit-tests: sized to that, the bottom taskbar painted below it and
      // ignored taps. In Safari the visual viewport is already the smallest.
      // Integers avoid subpixel gaps under the stats bar.
      const candidates = [viewport?.height, window.innerHeight, root.clientHeight].filter(
        (n): n is number => typeof n === "number" && n > 0,
      );
      const height = Math.round(candidates.length ? Math.min(...candidates) : window.innerHeight);
      const offsetTop = Math.round(viewport?.offsetTop ?? 0);
      root.style.setProperty("--pc-app-height", `${Math.max(height, 1)}px`);
      root.style.setProperty("--pc-app-top", `${offsetTop}px`);
      document.body.style.height = `${Math.max(height, 1)}px`;
      // Keyboard: the shell above already shrinks to the visual viewport. The
      // inset and data-keyboard let sheets and the bottom bar adapt.
      const kb = keyboardInset(window.innerHeight, viewport?.height ?? window.innerHeight, offsetTop);
      root.style.setProperty("--pc-keyboard", `${kb}px`);
      if (kb > 0) root.dataset.keyboard = "1";
      else delete root.dataset.keyboard;
      // iOS scrolls the (fixed) page when a field is focused; bring it back.
      if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
    };
    // One sync per frame however many events fire.
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };

    sync();
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    // iOS sometimes reports the final height one frame after rotate.
    const onOrient = () => {
      window.setTimeout(sync, 100);
      window.setTimeout(sync, 300);
    };
    window.addEventListener("orientationchange", onOrient);
    // iOS standalone settles its size late, on launch and on return from the
    // app switcher.
    const late = [100, 400, 1000].map((ms) => window.setTimeout(sync, ms));
    const onShow = () => {
      sync();
      window.setTimeout(sync, 250);
    };
    // Closing the keyboard does not always fire a resize on iOS.
    const onFocusOut = () => window.setTimeout(sync, 150);
    document.addEventListener("focusout", onFocusOut);
    const media = window.matchMedia?.("(display-mode: standalone)");
    const onMode = () => sync();
    media?.addEventListener?.("change", onMode);
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      document.removeEventListener("focusout", onFocusOut);
      media?.removeEventListener?.("change", onMode);
      late.forEach((id) => window.clearTimeout(id));
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onShow);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      window.removeEventListener("orientationchange", onOrient);
    };
  }, [active]);
}
