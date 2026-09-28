"use client";

import { useCallback, useSyncExternalStore } from "react";

const listeners = new Map<string, Set<() => void>>();

function subscribe(key: string, onChange: () => void) {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === key) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    set?.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function readFlag(key: string, defaultOn: boolean) {
  try {
    const value = localStorage.getItem(key);
    if (value == null) return defaultOn;
    return value === "1";
  } catch {
    return defaultOn;
  }
}

export function useStoredFlag(key: string, defaultOn: boolean) {
  const on = useSyncExternalStore(
    (onChange) => subscribe(key, onChange),
    () => readFlag(key, defaultOn),
    () => defaultOn,
  );

  const setOn = (next: boolean) => {
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // private mode
    }
    listeners.get(key)?.forEach((listener) => listener());
  };

  return [on, setOn] as const;
}

function readString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function useStoredString(key: string) {
  const value = useSyncExternalStore(
    (onChange) => subscribe(key, onChange),
    () => readString(key),
    () => null,
  );

  const setValue = useCallback((next: string | null) => {
    try {
      if (next == null) localStorage.removeItem(key);
      else localStorage.setItem(key, next);
    } catch {
      // private mode
    }
    listeners.get(key)?.forEach((listener) => listener());
  }, [key]);

  return [value, setValue] as const;
}
