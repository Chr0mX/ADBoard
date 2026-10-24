"use client";

import { useStoredString } from "@/hooks/use-stored-flag";

/** How a Tools / Stats panel's tab looks while it is hidden at the screen edge. */
export type EdgeTabStyle = "words" | "icons";

const KEY = "adboard-edge-tab-style";

/** The edge tab style, default words. Shared by Settings and every floating panel. */
export function useEdgeTabStyle() {
  const [raw, setRaw] = useStoredString(KEY);
  const style: EdgeTabStyle = raw === "icons" ? "icons" : "words";
  return [style, (next: EdgeTabStyle) => setRaw(next)] as const;
}
