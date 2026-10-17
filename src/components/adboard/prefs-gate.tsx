"use client";

import { useEffect, useState } from "react";
import { prefsReady } from "@/lib/prefs";

/**
 * Waits (at most about 1.5 s) for preferences saved in the ADBoard data
 * folder before the app first renders, so the last section, phone and
 * settings come back after a restart or in a browser whose storage was
 * cleared. Without an agent it renders at once.
 */
export function PrefsGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void prefsReady().then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);
  return ready ? children : null;
}
