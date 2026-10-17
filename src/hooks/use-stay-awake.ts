"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { devicesClient } from "@/lib/api/client";
import type { Device } from "@/lib/devices/types";

/*
 * "Stay awake" is device state (`svc power stayon`), so it is read from the
 * phones, not stored in the browser. One shared value per target set keeps
 * the floating Tools toggle and the More tools / Settings toggle in step.
 */
const listeners = new Set<() => void>();
const state = new Map<string, boolean>();
function emit() {
  listeners.forEach((listener) => listener());
}
function keyFor(targets: Device[]) {
  return targets
    .map((d) => d.id)
    .sort()
    .join(",");
}

/** Read the phones' setting into the shared value (no React state). */
async function readStatus(online: Device[], key: string) {
  try {
    const response = await devicesClient.runCommand(online, "stayAwake", "status");
    const ok = response.results.filter((r) => r.ok);
    state.set(key, ok.length > 0 && ok.every((r) => (r.output ?? "").trim() === "on"));
    emit();
  } catch {
    // Unknown: leave the toggle as it is.
  }
}

export function useStayAwake(targets: Device[]) {
  const online = targets.filter((d) => d.status === "online");
  const key = keyFor(online);
  const on = useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => state.get(key) ?? false,
    () => false,
  );
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = useCallback(
    async (arg: "on" | "off") => {
      if (online.length === 0) {
        setNote("No online phone");
        return;
      }
      setBusy(true);
      try {
        const response = await devicesClient.runCommand(online, "stayAwake", arg);
        const ok = response.results.filter((r) => r.ok);
        const failed = response.results.filter((r) => !r.ok);
        // On only when every phone that answered is on.
        state.set(key, ok.length > 0 && ok.every((r) => (r.output ?? "").trim() === "on"));
        emit();
        if (failed.length > 0) setNote(failed.map((r) => `${r.deviceName}: ${r.error || "failed"}`).join(" · "));
        else setNote(arg === "on" ? "Phones stay awake (screen state unchanged)" : "Stay awake off");
      } catch (error) {
        setNote(error instanceof Error ? error.message : "Stay awake failed");
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  // Read the phones' current setting when the target set changes.
  useEffect(() => {
    if (!key) return;
    void readStatus(online, key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return {
    on,
    busy,
    note,
    clearNote: () => setNote(null),
    setOn: (next: boolean) => void run(next ? "on" : "off"),
    available: online.length > 0,
  };
}
