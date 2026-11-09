"use client";

import { useEffect } from "react";
import { useStoredFlag } from "@/hooks/use-stored-flag";

export const FULL_HEIGHT_KEY = "adboard-m-full-height";

/**
 * Experimental: on some iPhones the Home Screen app's height (innerHeight,
 * 100dvh) is shorter than the screen while 100lvh is the full screen. With the
 * switch on, html[data-m-full] sizes the shell to 100lvh (see globals.css).
 */
export function useFullHeight() {
  const [on] = useStoredFlag(FULL_HEIGHT_KEY, false);
  useEffect(() => {
    const root = document.documentElement;
    if (on) root.dataset.mFull = "1";
    else delete root.dataset.mFull;
    return () => {
      delete root.dataset.mFull;
    };
  }, [on]);
}
