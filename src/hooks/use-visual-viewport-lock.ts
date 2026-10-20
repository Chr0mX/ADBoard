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
    const standalone =
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia?.("(display-mode: standalone)").matches === true;
    if (standalone) root.dataset.standalone = "1";
    // TEMP debug readout for the iPhone status-bar bug: open the page with ?vpdebug=1.
    const debug = new URLSearchParams(window.location.search).has("vpdebug")
      ? document.body.appendChild(Object.assign(document.createElement("pre"), {
          style: "position:fixed;left:0;bottom:0;z-index:99999;margin:0;padding:2px 4px;font:10px/1.3 monospace;background:#000c;color:#0f0;pointer-events:none",
        }))
      : null;
    // TEMP: where the stage and picture sit (top–bottom, px), to see if the picture is clipped.
    const rects = () => {
      const r = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return "none";
        const b = el.getBoundingClientRect();
        return `${Math.round(b.top)}-${Math.round(b.bottom)}`;
      };
      return `stage ${r("[data-screen-stage]")} picture ${r("[data-video-frame]")} box ${document.querySelector("[data-video-frame]")?.getAttribute("data-video-box") ?? ""}`;
    };
    const sync = () => {
      const viewport = window.visualViewport;
      if (debug) {
        const s = getComputedStyle(root);
        debug.textContent = [
          `vv.offsetTop ${viewport?.offsetTop} vv.height ${viewport?.height}`,
          `innerHeight ${window.innerHeight} clientHeight ${root.clientHeight}`,
          `--pc-app-top ${s.getPropertyValue("--pc-app-top")} --pc-app-height ${s.getPropertyValue("--pc-app-height")}`,
          rects(),
        ].join("\n");
      }
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
    };

    sync();
    const poll = debug ? window.setInterval(sync, 500) : undefined;
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
    // iOS standalone settles its size late, on launch and on return from the
    // app switcher.
    const late = [100, 400, 1000].map((ms) => window.setTimeout(sync, ms));
    const onShow = () => {
      sync();
      window.setTimeout(sync, 250);
    };
    window.addEventListener("pageshow", onShow);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      late.forEach((id) => window.clearTimeout(id));
      if (poll) window.clearInterval(poll);
      debug?.remove();
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("visibilitychange", onShow);
      viewport?.removeEventListener("resize", sync);
      viewport?.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      window.removeEventListener("orientationchange", onOrient);
    };
  }, [active]);
}
