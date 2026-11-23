"use client";

import { useEffect } from "react";
import { useStoredFlag, useStoredString } from "@/hooks/use-stored-flag";
import { BG_FPS_KEY, BG_PAUSE_KEY, setBackgroundVideoPolicy } from "@/lib/video/hub";
import { readBackgroundPolicy } from "@/lib/video/stream-policy-core";

/**
 * Hands the saved background-video setting (Settings → Video / Performance) to the video hub, so a
 * change made in Settings, in another tab or from a synced browser applies to every running stream.
 */
export function VideoSettingsSync() {
  const [pause] = useStoredFlag(BG_PAUSE_KEY, true);
  const [fps] = useStoredString(BG_FPS_KEY);
  useEffect(() => {
    setBackgroundVideoPolicy(readBackgroundPolicy(pause ? "1" : "0", fps));
  }, [pause, fps]);
  return null;
}
