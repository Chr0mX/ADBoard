"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useDeviceAudio } from "@/hooks/use-device-audio";
import {
  postScrcpyOptions,
  type ScrcpyOptionsPayload,
} from "@/lib/scrcpy/client";

export const SCRCPY_QUALITIES = ["low", "balanced", "high", "original"] as const;

const STORAGE_KEY = "phonecontrol-scrcpy";
const DEFAULTS: ScrcpyOptionsPayload = {
  quality: "balanced",
  audio: false,
  screenOff: false,
};

const listeners = new Set<() => void>();
let cachedRaw = "\0";
let cachedOpts = DEFAULTS;

function parseOpts(raw: string | null): ScrcpyOptionsPayload {
  if (!raw) return DEFAULTS;
  try {
    const value = JSON.parse(raw) as Partial<ScrcpyOptionsPayload>;
    const quality = SCRCPY_QUALITIES.includes(value.quality as (typeof SCRCPY_QUALITIES)[number])
      ? (value.quality as string)
      : "balanced";
    return {
      quality,
      audio: value.audio === true,
      screenOff: value.screenOff === true,
    };
  } catch {
    return DEFAULTS;
  }
}

function readOpts(): ScrcpyOptionsPayload {
  let raw = "";
  try {
    raw = localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    raw = "";
  }
  if (raw === cachedRaw) return cachedOpts;
  cachedRaw = raw;
  cachedOpts = parseOpts(raw || null);
  return cachedOpts;
}

function writeOpts(next: ScrcpyOptionsPayload) {
  const raw = JSON.stringify(next);
  try {
    localStorage.setItem(STORAGE_KEY, raw);
  } catch {
    // private mode
  }
  cachedRaw = raw;
  cachedOpts = next;
  listeners.forEach((listener) => listener());
}

function firstError(results: { ok: boolean; error?: string | null }[] | undefined) {
  return results?.find((result) => !result.ok)?.error || "";
}

/** Shared scrcpy quality / audio / screen-off state for docked and floating chrome. */
export function useScrcpyOptions({
  targetIds,
  serial,
  disabled,
}: {
  targetIds: string[];
  serial: string | null;
  disabled?: boolean;
}) {
  const options = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    readOpts,
    () => DEFAULTS,
  );
  const [note, setNote] = useState<string | null>(null);
  const audio = useDeviceAudio(serial, options.audio && !disabled);
  const ids = targetIds.join(",");
  const syncedIds = useRef("");

  useEffect(() => {
    if (!ids || syncedIds.current === ids) return;
    syncedIds.current = ids;
    void postScrcpyOptions(ids.split(","), options).catch(() => {});
  }, [ids, options]);

  const apply = async (next: ScrcpyOptionsPayload) => {
    const prev = options;
    writeOpts(next);
    if (targetIds.length === 0) return;
    try {
      const result = await postScrcpyOptions(targetIds, next);
      const error = firstError(result.results);
      if (error) setNote(error);
      else if (result.restarted && result.restarted.length > 0) {
        setNote("Stream restarted for the new setting.");
      } else if (next.screenOff !== prev.screenOff) {
        setNote(next.screenOff ? "Device screen off. The mirror stays on." : "Device screen on.");
      } else setNote(null);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not update scrcpy");
    }
  };

  const audioNote =
    options.audio && audio.note && audio.note !== "opus" ? audio.note : null;
  const audioError = options.audio && audio.stream === "error" ? audioNote : null;

  return {
    options,
    apply,
    note,
    setNote,
    audio,
    audioNote,
    audioError,
    defaults: DEFAULTS,
  };
}

export { firstError };
