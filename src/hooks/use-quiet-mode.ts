"use client";

import { useState, useSyncExternalStore } from "react";
import { devicesClient } from "@/lib/api/client";
import { postScrcpyOptions } from "@/lib/scrcpy/client";
import { patchScrcpyOptions, useScrcpyOptions } from "@/hooks/use-scrcpy-options";
import { useStoredFlag } from "@/hooks/use-stored-flag";
import { useDeskOptional } from "@/components/phone-control/desk/desk-context";

export const QUIET_MODE_KEY = "adboard-quiet-mode";

/* Last result, shown by every surface that has the toggle. */
const listeners = new Set<() => void>();
let status: string | null = null;
function setStatus(next: string | null) {
  status = next;
  listeners.forEach((listener) => listener());
}
export function useQuietModeStatus() {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => status,
    () => null,
  );
}

/**
 * Quiet mode: one switch for the whole farm. On turns every online phone's
 * screen off (scrcpy display power; the mirror keeps working) and mutes each
 * phone's own media sound; Off turns the screens back on and restores each
 * phone's volume. Universal on purpose: it ignores Selected / Multi / All.
 * Offline phones are left out.
 */
export function useQuietMode() {
  const desk = useDeskOptional();
  const [on, setOn] = useStoredFlag(QUIET_MODE_KEY, false);
  const [busy, setBusy] = useState(false);
  const note = useQuietModeStatus();
  const { options } = useScrcpyOptions({ targetIds: [], serial: null });
  const online = (desk?.devices ?? []).filter((d) => d.status === "online");

  const toggle = async (next: boolean) => {
    if (online.length === 0) {
      setStatus("Quiet mode: no online phone");
      return;
    }
    setBusy(true);
    const failures: string[] = [];
    try {
      const [screen, mute] = await Promise.allSettled([
        postScrcpyOptions(
          online.map((d) => d.id),
          { ...options, screenOff: next },
        ),
        devicesClient.runCommand(online, "mute", next ? "on" : "off"),
      ]);
      if (screen.status === "fulfilled") {
        patchScrcpyOptions({ screenOff: next });
        for (const row of screen.value.results ?? []) {
          if (!row.ok) failures.push(`${row.deviceName || "phone"} screen: ${row.error || "failed"}`);
        }
      } else {
        failures.push(`screen: ${screen.reason instanceof Error ? screen.reason.message : "failed"}`);
      }
      if (mute.status === "fulfilled") {
        for (const row of mute.value.results) if (!row.ok) failures.push(`${row.deviceName}: ${row.error || "mute failed"}`);
      } else {
        failures.push(`mute: ${mute.reason instanceof Error ? mute.reason.message : "failed"}`);
      }
      setOn(next);
      const count = `${online.length} phone${online.length === 1 ? "" : "s"}`;
      setStatus(
        failures.length > 0
          ? failures.join(" · ")
          : next
            ? `Quiet mode on: ${count} screen off and muted`
            : `Quiet mode off: ${count} screen on, sound restored`,
      );
    } finally {
      setBusy(false);
    }
  };

  return { on, busy, note, available: online.length > 0, toggle: (next: boolean) => void toggle(next) };
}
