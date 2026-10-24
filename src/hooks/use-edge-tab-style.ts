"use client";

import { useStoredString } from "@/hooks/use-stored-flag";

/** How a Tools / Stats panel's tab looks while it is hidden at the screen edge. */
export type EdgeTabStyle = "text" | "icons" | "both";

const KEY = "adboard-edge-tab-style";

/** The edge tab style, default text. Shared by Settings and every floating panel. */
export function useEdgeTabStyle() {
  const [raw, setRaw] = useStoredString(KEY);
  // "words" was the first name for the text-and-icon tab; it now reads as "both".
  const style: EdgeTabStyle = raw === "icons" ? "icons" : raw === "both" || raw === "words" ? "both" : "text";
  return [style, (next: EdgeTabStyle) => setRaw(next)] as const;
}
