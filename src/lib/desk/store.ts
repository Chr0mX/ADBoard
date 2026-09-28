"use client";

import { useSyncExternalStore } from "react";

export interface AppShortcut {
  id: string;
  name: string;
  packageName: string;
  activity: string;
  group: string;
}

export interface MacroStep {
  id: string;
  kind:
    | "launch"
    | "wait"
    | "tap"
    | "swipe"
    | "text"
    | "nav"
    | "shell"
    | "screenshot"
    | "forceStop";
  packageName?: string;
  activity?: string;
  ms?: number;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  text?: string;
  nav?: "back" | "home" | "recent" | "volume_up" | "volume_down" | "power";
  command?: string;
}

export interface SavedMacro {
  id: string;
  name: string;
  folder: string;
  steps: MacroStep[];
}

export interface DeviceGroup {
  id: string;
  name: string;
  deviceIds: string[];
}

export interface DeskLibrary {
  apps: AppShortcut[];
  macros: SavedMacro[];
  variables: Record<string, string>;
  deviceVariables: Record<string, Record<string, string>>;
  tags: Record<string, string[]>;
  groups: DeviceGroup[];
}

const KEY = "phonecontrol-desk";
const listeners = new Set<() => void>();

const empty = (): DeskLibrary => ({
  apps: [],
  macros: [],
  variables: {},
  deviceVariables: {},
  tags: {},
  groups: [],
});

function read(): DeskLibrary {
  if (typeof window === "undefined") return empty();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    return { ...empty(), ...JSON.parse(raw) };
  } catch {
    return empty();
  }
}

export function getLibrary(): DeskLibrary {
  return read();
}

export function saveLibrary(next: DeskLibrary) {
  localStorage.setItem(KEY, JSON.stringify(next));
  listeners.forEach((listener) => listener());
}

export function updateLibrary(change: (library: DeskLibrary) => DeskLibrary) {
  saveLibrary(change(read()));
}

export function useLibrary(): DeskLibrary {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    read,
    empty,
  );
}

export function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}`;
}
