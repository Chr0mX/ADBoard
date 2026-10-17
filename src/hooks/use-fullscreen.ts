"use client";

import { useCallback, useSyncExternalStore } from "react";

/*
 * Browser fullscreen for the whole app (F11-style, Esc leaves). Separate from
 * "Fill window", which only changes the layout inside the page. Not offered
 * where the browser has no element fullscreen (iPhone Safari).
 */
function subscribe(onChange: () => void) {
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}

export function useFullscreen() {
  const active = useSyncExternalStore(
    subscribe,
    () => document.fullscreenElement != null,
    () => false,
  );
  const supported = useSyncExternalStore(
    subscribe,
    () => document.fullscreenEnabled === true && typeof document.documentElement.requestFullscreen === "function",
    () => false,
  );
  const toggle = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "Fullscreen was refused";
    }
  }, []);
  return { active, supported, toggle };
}
