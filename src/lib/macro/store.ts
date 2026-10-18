"use client";

import { useSyncExternalStore } from "react";
import {
  MAX_TABS,
  cloneTab,
  macroId,
  newTab,
  sanitizeTab,
  type MacroTab,
} from "@/lib/macro/core";
import { createAgentSync } from "@/lib/sync/agent-store";
import { UNTITLED_MACRO, uniqueName as uniqueDisplayName } from "@/lib/adboard-files";
import { mergeWorkspaces } from "@/lib/sync/decide";

/** Saved in this browser. Each tab keeps its own settings, steps and phones. */
export interface MacroWorkspace {
  version: 1;
  tabs: MacroTab[];
  activeId: string | null;
}

const KEY = "adboard-macros";
const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cached: MacroWorkspace | null = null;

const SERVER: MacroWorkspace = { version: 1, tabs: [], activeId: null };

function starter(): MacroWorkspace {
  const tab = newTab("Tab 1");
  return { version: 1, tabs: [tab], activeId: tab.id };
}

/** Accept whatever is stored, repairing it rather than losing tabs. */
export function normalizeWorkspace(value: unknown): MacroWorkspace {
  if (!value || typeof value !== "object") return starter();
  const raw = value as { tabs?: unknown; activeId?: unknown };
  const warnings: string[] = [];
  const tabs: MacroTab[] = [];
  const seen = new Set<string>();
  for (const [index, item] of (Array.isArray(raw.tabs) ? raw.tabs : []).slice(0, MAX_TABS).entries()) {
    try {
      const tab = sanitizeTab(item, index, warnings);
      if (seen.has(tab.id)) tab.id = macroId("tab");
      seen.add(tab.id);
      tabs.push(tab);
    } catch {
      // Unreadable tab: drop it, keep the rest.
    }
  }
  if (tabs.length === 0) return starter();
  const activeId =
    typeof raw.activeId === "string" && tabs.some((t) => t.id === raw.activeId) ? raw.activeId : tabs[0].id;
  return { version: 1, tabs, activeId };
}

/** Shared with every browser on this ADBoard (agent /api/store/macros). */
const sync = createAgentSync({
  name: "macros",
  getLocal: () => read(),
  applyRemote: (value) => {
    const next = normalizeWorkspace(value);
    // Keep this browser's selected tab when it still exists.
    const keep = cached?.activeId && next.tabs.some((t) => t.id === cached?.activeId) ? cached.activeId : next.activeId;
    store({ ...next, activeId: keep });
  },
  merge: (local, remote, base) =>
    mergeWorkspaces(normalizeWorkspace(local), normalizeWorkspace(remote), base ? normalizeWorkspace(base) : null),
  isMeaningful: (value) => {
    const ws = value as MacroWorkspace;
    if (!ws || !Array.isArray(ws.tabs)) return false;
    return ws.tabs.length > 1 || ws.tabs.some((t) => t.steps.length > 0 || t.name !== "Tab 1");
  },
});

function read(): MacroWorkspace {
  if (typeof window === "undefined") return SERVER;
  sync.start();
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (cached && raw === cachedRaw) return cached;
  cachedRaw = raw;
  try {
    cached = raw ? normalizeWorkspace(JSON.parse(raw)) : starter();
  } catch {
    cached = starter();
  }
  return cached;
}

function save(next: MacroWorkspace) {
  store(next);
  sync.push();
}

/** Write to this browser and notify, without sharing (used for remote copies). */
function store(next: MacroWorkspace) {
  const raw = JSON.stringify(next);
  cached = next;
  cachedRaw = raw;
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // Storage full or blocked: keep working in memory for this visit.
  }
  listeners.forEach((listener) => listener());
}

/** Put a saved copy back (a local backup), shared like any edit. */
export function restoreWorkspace(value: unknown) {
  save(normalizeWorkspace(value));
}

/** Read the agent's copy now (e.g. right after restoring a version there). */
export function pullMacrosFromAgent() {
  return sync.pull();
}

/** Wait (briefly) until the agent's copy has been loaded. */
export function macrosReady() {
  sync.start();
  return sync.ready();
}

/** Make sure the agent has this browser's latest macros. */
export function flushMacrosToAgent() {
  return sync.flush();
}

export function getWorkspace() {
  return read();
}

export function useMacroWorkspace(): MacroWorkspace {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      const onStorage = (event: StorageEvent) => {
        if (event.key === KEY) onChange();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(onChange);
        window.removeEventListener("storage", onStorage);
      };
    },
    read,
    () => SERVER,
  );
}

function update(change: (ws: MacroWorkspace) => MacroWorkspace) {
  save(change(read()));
}

/** Change one tab only; other tabs are untouched. */
export function patchTab(id: string, change: (tab: MacroTab) => MacroTab) {
  update((ws) => ({
    ...ws,
    tabs: ws.tabs.map((tab) => (tab.id === id ? { ...change(tab), id, updatedAt: Date.now() } : tab)),
  }));
}

export function setActiveTab(id: string) {
  update((ws) => (ws.tabs.some((t) => t.id === id) ? { ...ws, activeId: id } : ws));
}

/** Display names are unique (case-insensitive): each macro is saved as its own file. */
const uniqueName = (ws: MacroWorkspace, base: string) => uniqueDisplayName(base, ws.tabs.map((t) => t.name), UNTITLED_MACRO);

export function addTab(patch: Partial<MacroTab> = {}): MacroTab | null {
  const ws = read();
  if (ws.tabs.length >= MAX_TABS) return null;
  const tab = newTab(uniqueName(ws, patch.name ?? `Tab ${ws.tabs.length + 1}`), patch);
  save({ ...ws, tabs: [...ws.tabs, tab], activeId: tab.id });
  return tab;
}

export function duplicateTab(id: string): MacroTab | null {
  const ws = read();
  const source = ws.tabs.find((t) => t.id === id);
  if (!source || ws.tabs.length >= MAX_TABS) return null;
  const copy = cloneTab(source, uniqueName(ws, `${source.name} copy`));
  const index = ws.tabs.findIndex((t) => t.id === id);
  const tabs = [...ws.tabs.slice(0, index + 1), copy, ...ws.tabs.slice(index + 1)];
  save({ ...ws, tabs, activeId: copy.id });
  return copy;
}

export function deleteTab(id: string) {
  update((ws) => {
    const index = ws.tabs.findIndex((t) => t.id === id);
    if (index < 0) return ws;
    const tabs = ws.tabs.filter((t) => t.id !== id);
    if (tabs.length === 0) return starter();
    const activeId = ws.activeId === id ? tabs[Math.min(index, tabs.length - 1)].id : ws.activeId;
    return { ...ws, tabs, activeId };
  });
}

export function moveTab(id: string, delta: -1 | 1) {
  update((ws) => {
    const index = ws.tabs.findIndex((t) => t.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= ws.tabs.length) return ws;
    const tabs = [...ws.tabs];
    [tabs[index], tabs[target]] = [tabs[target], tabs[index]];
    return { ...ws, tabs };
  });
}

/** Replace the whole workspace (whole-library import). */
export function replaceWorkspace(next: MacroWorkspace) {
  save(normalizeWorkspace(next));
}

/** Add imported tabs as new tabs (fresh ids, so nothing collides), or replace all. */
export function importTabs(tabs: MacroTab[], mode: "add" | "replace"): number {
  const ws = read();
  const room = mode === "replace" ? MAX_TABS : MAX_TABS - ws.tabs.length;
  const incoming = tabs.slice(0, Math.max(0, room)).map((tab) => cloneTab(tab, tab.name));
  if (incoming.length === 0) return 0;
  if (mode === "replace") {
    save({ version: 1, tabs: incoming, activeId: incoming[0].id });
  } else {
    const all = [...ws.tabs];
    for (const tab of incoming) all.push({ ...tab, name: uniqueName({ ...ws, tabs: all }, tab.name) });
    save({ ...ws, tabs: all, activeId: incoming[0].id });
  }
  return incoming.length;
}
