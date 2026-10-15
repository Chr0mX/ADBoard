"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_TASKBAR_PINS,
  MAX_TASKBAR_PINS,
  LEGACY_TASKBAR_PINS_KEY,
  TASKBAR_PINS_KEY,
  normalizeTaskbarPins,
  readTaskbarPins,
  writeTaskbarPins,
  type TaskbarToolId,
} from "@/lib/ui/taskbar-pins";

const listeners = new Set<() => void>();

/** Cached client snapshot — useSyncExternalStore requires a stable reference. */
let cachedPins: TaskbarToolId[] = DEFAULT_TASKBAR_PINS;
let cachedRaw: string | null = null;

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === TASKBAR_PINS_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function emit() {
  listeners.forEach((listener) => listener());
}

function getSnapshot(): TaskbarToolId[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(TASKBAR_PINS_KEY);
    if (raw == null) {
      const legacy = localStorage.getItem(LEGACY_TASKBAR_PINS_KEY);
      if (legacy != null) {
        localStorage.setItem(TASKBAR_PINS_KEY, legacy);
        localStorage.removeItem(LEGACY_TASKBAR_PINS_KEY);
        raw = legacy;
      }
    }
  } catch {
    raw = null;
  }
  if (raw === cachedRaw) return cachedPins;
  cachedRaw = raw;
  if (raw == null) {
    cachedPins = DEFAULT_TASKBAR_PINS;
    return cachedPins;
  }
  try {
    cachedPins = normalizeTaskbarPins(JSON.parse(raw) as unknown);
  } catch {
    cachedPins = DEFAULT_TASKBAR_PINS;
  }
  return cachedPins;
}

function getServerSnapshot(): TaskbarToolId[] {
  return DEFAULT_TASKBAR_PINS;
}

export function useTaskbarPins() {
  const pins = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setPins = useCallback((next: TaskbarToolId[]) => {
    const normalized = normalizeTaskbarPins(next);
    writeTaskbarPins(normalized);
    cachedRaw = JSON.stringify(normalized);
    cachedPins = normalized;
    emit();
  }, []);

  const togglePin = useCallback(
    (id: TaskbarToolId) => {
      const current = getSnapshot();
      if (current.includes(id)) {
        setPins(current.filter((item) => item !== id));
        return;
      }
      if (current.length >= MAX_TASKBAR_PINS) return;
      setPins([...current, id]);
    },
    [setPins],
  );

  const resetPins = useCallback(() => {
    setPins([...DEFAULT_TASKBAR_PINS]);
  }, [setPins]);

  return {
    pins,
    setPins,
    togglePin,
    resetPins,
    atLimit: pins.length >= MAX_TASKBAR_PINS,
    maxPins: MAX_TASKBAR_PINS,
  };
}

// Re-export for tests that want to clear the module cache between cases.
export function __resetTaskbarPinsCacheForTests() {
  cachedPins = DEFAULT_TASKBAR_PINS;
  cachedRaw = null;
}
