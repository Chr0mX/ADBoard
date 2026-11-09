"use client";

import { useCallback } from "react";
import { useStoredFlag } from "@/hooks/use-stored-flag";

export const HAPTICS_KEY = "adboard-m-haptics";
export const SOUNDS_KEY = "adboard-m-sounds";

let audio: AudioContext | null = null;
function click() {
  try {
    audio ??= new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = 1400;
    gain.gain.value = 0.03;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.015);
  } catch {
    // no audio
  }
}

/**
 * Optional tap feedback. Haptics use navigator.vibrate (Android; iOS Safari
 * does not offer it), the click is a 15 ms tone.
 */
export function useFeedback() {
  const [haptics, setHaptics] = useStoredFlag(HAPTICS_KEY, true);
  const [sounds, setSounds] = useStoredFlag(SOUNDS_KEY, false);
  const tap = useCallback(() => {
    if (haptics && typeof navigator !== "undefined") navigator.vibrate?.(8);
    if (sounds) click();
  }, [haptics, sounds]);
  return { tap, haptics, setHaptics, sounds, setSounds };
}
