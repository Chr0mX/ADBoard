"use client";

import { useEffect, useState } from "react";
import { readStandalone } from "@/lib/pwa/standalone";
import { deviceHint, type Hint } from "@/lib/pwa/device-hint";

const DISMISS_KEY = "adboard-mobile-hint-dismissed";
const FORCE_KEY = "adboard-force-desktop";

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * On "/" (the desktop app): a phone-sized touch device is offered the mobile
 * app, and an installed phone-width app is moved to it. Never loops: "/m"
 * links back with ?desktop=1, which is remembered.
 */
export function DeviceHint() {
  const [hint, setHint] = useState<Hint>("none");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("desktop") === "1") {
      try {
        sessionStorage.setItem(FORCE_KEY, "1");
      } catch {
        // private mode
      }
    }
    let forced = false;
    try {
      forced = sessionStorage.getItem(FORCE_KEY) === "1";
    } catch {
      // private mode
    }
    const next = deviceHint({
      standalone: readStandalone(),
      coarsePointer: window.matchMedia("(pointer: coarse)").matches,
      width: window.innerWidth,
      forcedDesktop: forced,
      dismissed: read(DISMISS_KEY) === "1",
    });
    if (next === "redirect") {
      window.location.replace("/m/");
      return;
    }
    // Deferred so the state update is not synchronous inside the effect.
    const id = window.setTimeout(() => setHint(next), 0);
    return () => window.clearTimeout(id);
  }, []);

  if (hint !== "banner") return null;
  return (
    <div
      role="region"
      aria-label="Mobile app"
      data-device-hint
      className="fixed inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-50 flex items-center gap-2 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-2 pl-3 shadow-lg"
    >
      <span className="min-w-0 flex-1 text-sm text-[var(--pc-ink)]">This is the desktop layout. Use the mobile app on your phone.</span>
      {/* A full page load on purpose: the mobile app has its own service worker. */}
      <a href="/m/" className="pc-toggle pc-toggle-md shrink-0" data-device-hint-open>
        Open
      </a>
      <button
        type="button"
        className="pc-toggle pc-toggle-md shrink-0"
        onClick={() => {
          try {
            localStorage.setItem(DISMISS_KEY, "1");
          } catch {
            // private mode
          }
          setHint("none");
        }}
      >
        Not now
      </button>
    </div>
  );
}
