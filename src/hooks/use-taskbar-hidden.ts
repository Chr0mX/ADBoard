"use client";

import { migrateLegacyKeys } from "@/lib/storage-keys";
import { useCallback, useSyncExternalStore } from "react";
import {
  normalizeHiddenNav,
  TASKBAR_HIDDEN_KEY,
  type HideableNavId,
} from "@/lib/ui/taskbar-pins";

/*
 * Which fixed taskbar controls the user hid (volume and power). Saved under
 * one browser key and synced like the pins (see lib/prefs.ts).
 */
const listeners = new Set<() => void>();
const NONE: HideableNavId[] = [];
let cachedRaw: string | null = null;
let cached: HideableNavId[] = NONE;

function read(): HideableNavId[] {
  let raw: string | null = null;
  try {
    migrateLegacyKeys();
    raw = localStorage.getItem(TASKBAR_HIDDEN_KEY);
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    cached = raw == null ? NONE : normalizeHiddenNav(JSON.parse(raw) as unknown);
  } catch {
    cached = NONE;
  }
  return cached;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === TASKBAR_HIDDEN_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTaskbarHidden() {
  const hidden = useSyncExternalStore(subscribe, read, () => NONE);

  const setHidden = useCallback((next: HideableNavId[]) => {
    const normalized = normalizeHiddenNav(next);
    try {
      localStorage.setItem(TASKBAR_HIDDEN_KEY, JSON.stringify(normalized));
    } catch {
      // private mode
    }
    cachedRaw = JSON.stringify(normalized);
    cached = normalized;
    listeners.forEach((listener) => listener());
  }, []);

  const toggleHidden = useCallback(
    (id: HideableNavId) => {
      const current = read();
      setHidden(current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    },
    [setHidden],
  );

  return { hidden, setHidden, toggleHidden };
}
