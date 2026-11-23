"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useStoredString } from "@/hooks/use-stored-flag";
import {
  parseModeChoice,
  resolveTheme,
  THEME_DARK_KEY,
  THEME_LIGHT_KEY,
  THEME_MODE_KEY,
} from "@/lib/ui/themes";
import { DEFAULT_DARK_THEME } from "@/lib/ui/themes";

const QUERY = "(prefers-color-scheme: dark)";

function subscribeSystem(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** What the operating system prefers right now (dark on the server and before hydration). */
export function useSystemDark(): boolean {
  return useSyncExternalStore(subscribeSystem, () => window.matchMedia(QUERY).matches, () => true);
}

/** The theme in effect for the saved choices; the same value the first-paint script computed. */
export function useResolvedTheme() {
  const [mode] = useStoredString(THEME_MODE_KEY);
  const [dark] = useStoredString(THEME_DARK_KEY);
  const [light] = useStoredString(THEME_LIGHT_KEY);
  const systemDark = useSystemDark();
  return { choice: parseModeChoice(mode), ...resolveTheme({ mode, dark, light, systemDark }) };
}

/**
 * Applies the theme to <html> whenever a choice changes (in Settings, in another
 * tab, or from another browser through the synced preferences) or the system
 * changes while the mode is System. layout.tsx's script does the first paint.
 */
export function ThemeSync() {
  const { isDark, id, paper } = useResolvedTheme();
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", isDark);
    if (id === DEFAULT_DARK_THEME) root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", id);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", paper);
  }, [isDark, id, paper]);
  return null;
}
