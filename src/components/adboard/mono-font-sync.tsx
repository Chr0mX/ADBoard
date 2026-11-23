"use client";

import { useEffect } from "react";
import { useStoredString } from "@/hooks/use-stored-flag";
import { DEFAULT_MONO_FONT, MONO_FONT_KEY, parseMonoFont } from "@/lib/ui/mono-fonts";

/**
 * Keeps `data-mono-font` on <html> equal to the saved font choice, so a change
 * made in Settings (or synced from another browser) applies at once. The first
 * paint is handled by the small script in layout.tsx.
 */
export function MonoFontSync() {
  const [stored] = useStoredString(MONO_FONT_KEY);
  const id = parseMonoFont(stored);
  useEffect(() => {
    const root = document.documentElement;
    if (id === DEFAULT_MONO_FONT) delete root.dataset.monoFont;
    else root.dataset.monoFont = id;
  }, [id]);
  return null;
}
