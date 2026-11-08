"use client";

import { useEffect } from "react";

/** Registers the app-shell service worker once in supported browsers. */
export function RegisterSw({ script = "/sw.js", scope = "/" }: { script?: string; scope?: string }) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (window.location.protocol === "file:") return;
    // Turbopack reuses stable chunk names in dev; a SW cache-first of
    // `/_next/static` would pin stale UI. Only register for production builds.
    if (process.env.NODE_ENV === "development") {
      void navigator.serviceWorker.getRegistrations().then((regs) => {
        for (const reg of regs) if (reg.scope.endsWith(scope)) void reg.unregister();
      });
      return;
    }
    void navigator.serviceWorker.register(script, { scope }).catch(() => {
      // Unsupported contexts (static file:// packs, private mode) are fine.
    });
  }, [script, scope]);
  return null;
}
