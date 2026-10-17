"use client";

import { useSyncExternalStore } from "react";
import { createAgentSync } from "@/lib/sync/agent-store";
import { mergeById } from "@/lib/sync/decide";

export interface AppShortcut {
  id: string;
  name: string;
  packageName: string;
  activity: string;
  /** Extra `am start` arguments, such as `--es user bob`. */
  arguments?: string;
  /** Emoji or short label shown on the launcher tile. */
  icon?: string;
  group: string;
}

export type MacroStepKind =
  | "launch"
  | "forceStop"
  | "reboot"
  | "shutdown"
  | "wait"
  | "waitDevice"
  | "waitApp"
  | "waitScreen"
  | "timeout"
  | "tap"
  | "doubleTap"
  | "longPress"
  | "swipe"
  | "scroll"
  | "drag"
  | "pinch"
  | "text"
  | "nav"
  | "shell"
  | "screenshot"
  | "recordStart"
  | "recordStop"
  | "upload"
  | "download"
  | "deleteFile"
  | "install"
  | "gesture";

export interface MacroStep {
  id: string;
  kind: MacroStepKind;
  packageName?: string;
  activity?: string;
  ms?: number;
  /** Percent of the picture, 0–100. */
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  text?: string;
  nav?: "back" | "home" | "recent" | "volume_up" | "volume_down" | "power";
  command?: string;
  bitrate?: string;
  size?: string;
  dest?: string;
  hostPath?: string;
  /** Pointer path recorded on the control screen. Times are milliseconds from the first event. */
  samples?: GestureSample[];
  frameWidth?: number;
  frameHeight?: number;
}

export interface GestureSample {
  t: number;
  phase: "down" | "move" | "up" | "cancel";
  x: number;
  y: number;
  tool: "finger" | "mouse";
}

export interface CoordOverride {
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
}

export interface DeviceProfile {
  overrides: Record<string, CoordOverride>;
  assignedMacros: string[];
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

export interface MacroRunRecord {
  id: string;
  macroId: string;
  macroName: string;
  at: number;
  parallel: boolean;
  results: Array<{
    deviceId: string;
    deviceName: string;
    status: string;
    detail?: string;
  }>;
}

export interface DeskLibrary {
  apps: AppShortcut[];
  macros: SavedMacro[];
  variables: Record<string, string>;
  deviceVariables: Record<string, Record<string, string>>;
  tags: Record<string, string[]>;
  groups: DeviceGroup[];
  profiles: Record<string, DeviceProfile>;
  history: MacroRunRecord[];
}

const KEY = "phonecontrol-desk";
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: DeskLibrary | null = null;

export const APP_GROUPS = ["Games", "Media", "Tools", "Custom"] as const;
export const MACRO_FOLDERS = ["Testing", "Games", "Custom"] as const;

export function emptyProfile(): DeviceProfile {
  return {
    overrides: {},
    assignedMacros: [],
  };
}

/** Only the fields profiles still use (older libraries also stored unused display settings). */
function normalizeProfiles(profiles: Record<string, Partial<DeviceProfile>> | undefined): Record<string, DeviceProfile> {
  const out: Record<string, DeviceProfile> = {};
  for (const [id, profile] of Object.entries(profiles ?? {})) {
    out[id] = { overrides: profile?.overrides ?? {}, assignedMacros: profile?.assignedMacros ?? [] };
  }
  return out;
}

const empty = (): DeskLibrary => ({
  apps: [],
  macros: [],
  variables: {},
  deviceVariables: {},
  tags: {},
  groups: [],
  profiles: {},
  history: [],
});

const SERVER_LIBRARY = empty();

function normalize(parsed: Partial<DeskLibrary>): DeskLibrary {
  return {
    ...empty(),
    ...parsed,
    profiles: normalizeProfiles(parsed.profiles),
    history: parsed.history ?? [],
    tags: parsed.tags ?? {},
    groups: parsed.groups ?? [],
    variables: parsed.variables ?? {},
    deviceVariables: parsed.deviceVariables ?? {},
  };
}

/** Shared with every browser on this ADBoard (agent /api/store/desk). */
const sync = createAgentSync({
  name: "desk",
  getLocal: () => read(),
  applyRemote: (value) => storeLibrary(normalize((value ?? {}) as Partial<DeskLibrary>)),
  merge: (localRaw, remoteRaw, baseRaw) => {
    const local = normalize((localRaw ?? {}) as Partial<DeskLibrary>);
    const remote = normalize((remoteRaw ?? {}) as Partial<DeskLibrary>);
    const base = baseRaw ? normalize(baseRaw as Partial<DeskLibrary>) : null;
    return {
      ...remote,
      apps: mergeById(local.apps, remote.apps, base?.apps),
      macros: mergeById(local.macros, remote.macros, base?.macros),
      groups: mergeById(local.groups, remote.groups, base?.groups),
      history: mergeById(local.history, remote.history, base?.history).slice(0, 30),
      variables: { ...local.variables, ...remote.variables },
      deviceVariables: { ...local.deviceVariables, ...remote.deviceVariables },
      tags: { ...local.tags, ...remote.tags },
      profiles: { ...local.profiles, ...remote.profiles },
    };
  },
  isMeaningful: (value) => {
    const lib = value as DeskLibrary;
    if (!lib) return false;
    return (
      (lib.macros?.length ?? 0) > 0 ||
      (lib.groups?.length ?? 0) > 0 ||
      (lib.apps?.length ?? 0) > 0 ||
      Object.keys(lib.variables ?? {}).length > 0 ||
      Object.keys(lib.profiles ?? {}).length > 0
    );
  },
});

function read(): DeskLibrary {
  if (typeof window === "undefined") return SERVER_LIBRARY;
  sync.start();
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (cached && raw === cachedRaw) return cached;
  cachedRaw = raw;
  if (!raw) {
    cached = empty();
    return cached;
  }
  try {
    cached = normalize(JSON.parse(raw) as Partial<DeskLibrary>);
  } catch {
    cached = empty();
  }
  return cached;
}

export function getLibrary(): DeskLibrary {
  return read();
}

export function saveLibrary(next: DeskLibrary) {
  storeLibrary(next);
  sync.push();
}

/** Write to this browser and notify, without sharing (used for remote copies). */
function storeLibrary(next: DeskLibrary) {
  const raw = JSON.stringify(next);
  cached = next;
  cachedRaw = raw;
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // Storage full or blocked: keep it in memory for this visit.
  }
  listeners.forEach((listener) => listener());
}

const MACRO_KINDS = new Set<string>([
  "launch",
  "forceStop",
  "reboot",
  "shutdown",
  "wait",
  "waitDevice",
  "waitApp",
  "waitScreen",
  "timeout",
  "tap",
  "doubleTap",
  "longPress",
  "swipe",
  "scroll",
  "drag",
  "pinch",
  "text",
  "nav",
  "shell",
  "screenshot",
  "recordStart",
  "recordStop",
  "upload",
  "download",
  "deleteFile",
  "install",
  "gesture",
]);

/** Parse a desk export. Rejects junk so a bad import does not wipe the library. */
export function parseDeskExport(raw: string): DeskLibrary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Desk file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Desk file must be an object");
  }
  const body = parsed as Partial<DeskLibrary>;
  if (body.macros !== undefined && !Array.isArray(body.macros)) {
    throw new Error("macros must be an array");
  }
  if (body.apps !== undefined && !Array.isArray(body.apps)) {
    throw new Error("apps must be an array");
  }
  for (const macro of body.macros ?? []) {
    if (!macro || typeof macro !== "object") {
      throw new Error("each macro must be an object");
    }
    if (!Array.isArray(macro.steps)) {
      throw new Error(`macro ${macro.name ?? macro.id ?? "?"} has no steps array`);
    }
    for (const step of macro.steps) {
      if (!step || typeof step !== "object" || !MACRO_KINDS.has(String(step.kind))) {
        throw new Error(`unknown macro step kind: ${String((step as MacroStep)?.kind)}`);
      }
    }
  }
  return normalize(body);
}

export function exportDeskJson(library: DeskLibrary = read()): string {
  return `${JSON.stringify(library, null, 2)}\n`;
}

export function importDeskJson(raw: string): DeskLibrary {
  const next = parseDeskExport(raw);
  saveLibrary(next);
  return next;
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
    () => SERVER_LIBRARY,
  );
}

export function newId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function profileFor(library: DeskLibrary, deviceId: string): DeviceProfile {
  return library.profiles[deviceId] ?? emptyProfile();
}
