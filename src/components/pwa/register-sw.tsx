"use client";

import { useEffect } from "react";

/** Registers the app-shell service worker once in supported browsers. */
export function RegisterSw() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (window.location.protocol === "file:") return;
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Unsupported contexts (static file:// packs, private mode) are fine.
    });
  }, []);
  return null;
}
