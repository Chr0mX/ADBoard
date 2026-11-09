"use client";

import { useEffect } from "react";
import { documentTitle } from "@/lib/ui/document-title";

/** Keeps the browser tab / app switcher title in step with the screen. */
export function useMobileTitle(args: { section: string; sectionLabel?: string; gridView: boolean; deviceName: string | null }) {
  const { section, sectionLabel, gridView, deviceName } = args;
  useEffect(() => {
    document.title = documentTitle({ section, sectionLabel, gridView, deviceName });
  }, [section, sectionLabel, gridView, deviceName]);
}
