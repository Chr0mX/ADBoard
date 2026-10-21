"use client";

import { createAgentSync } from "@/lib/sync/agent-store";
import { migrateLegacyKeys } from "@/lib/storage-keys";

/*
 * Saves preferences and interface state in the ADBoard data folder, using
 * the same agent sync as macros. The existing browser keys stay the working
 * copy (hooks keep reading them); this module mirrors them:
 *
 * - user-config   → config/user_config.json: settings shared by every
 *   browser (keyboard, stream quality, taskbar pins, grid…). Each key keeps
 *   its own time, so the newest change wins.
 * - browser-state → config/browser_state.json: per browser (an anonymous id)
 *   layout and navigation: section, last phone, folded panels, grid view.
 *   A browser seen for the first time starts from the newest layout.
 * - builder-state → config/builder_state.json: per browser Shell Automation
 *   and Touch Macros editor state (open job, preview phone, selected step).
 *
 * Nothing secret is stored: no passwords, tokens or cookies.
 */

export const USER_KEYS = [
  "adboard-control-mode",
  "adboard-keyboard",
  "adboard-cursor-mode",
  "adboard-scrcpy",
  "adboard-display-size",
  "adboard-clipboard-sync",
  "adboard-quiet-mode",
  "adboard-taskbar-pins",
  "adboard-taskbar-hidden",
  "adboard-grid-layout",
  "adboard-grid-bar",
  "adboard-mobile-stats-mode",
  "adboard-touch-diagnostics",
  "adboard-shell-history",
] as const;

export const BROWSER_KEYS = [
  "adboard-section",
  "adboard-active-device",
  "adboard-fill-window",
  "adboard-screens-collapsed",
  "adboard-devices-collapsed",
  "adboard-grid-view",
  "adboard-macro-dock",
  "adboard-files-path",
] as const;

export const BUILDER_KEYS = ["adboard-automate-view", "adboard-shell-builder", "adboard-macro-view"] as const;

const ID_KEY = "adboard-browser-id";
const STAMPS_KEY = "adboard-prefs-stamps";
const WATCH_MS = 1500;

type Stamped = { value: string | null; at: number };
interface UserConfig {
  version: 1;
  values: Record<string, Stamped>;
}
interface BrowserEntry {
  label: string;
  updatedAt: number;
  values: Record<string, string>;
}
interface PerBrowser {
  version: 1;
  browsers: Record<string, BrowserEntry>;
}

const ls = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};
const get = (key: string) => {
  try {
    return ls()?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const set = (key: string, value: string | null) => {
  try {
    if (value === null) ls()?.removeItem(key);
    else ls()?.setItem(key, value);
  } catch {
    // storage full or blocked: this page keeps working with what it has
  }
};

/** Tell hooks in this tab that a key changed (they listen to `storage`). */
function announce(key: string, newValue: string | null) {
  try {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue, storageArea: ls() }));
  } catch {
    // very old browsers: the value applies on the next load
  }
}

function readStamps(): Record<string, number> {
  try {
    return JSON.parse(get(STAMPS_KEY) ?? "{}") as Record<string, number>;
  } catch {
    return {};
  }
}

export function browserId(): string {
  let id = get(ID_KEY);
  if (!id) {
    id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    set(ID_KEY, id);
  }
  return id;
}

/** "Chrome on Windows", "Safari on iPhone"… (shown in config/browser_state.json). */
export function browserLabel(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  const os = /iPhone|iPad/.test(ua) ? (ua.includes("iPad") ? "iPad" : "iPhone") : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "unknown";
  const name = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${name} on ${os}`;
}

/* ------------------------- shared settings ------------------------- */

function localUserConfig(): UserConfig {
  const stamps = readStamps();
  const values: Record<string, Stamped> = {};
  for (const key of USER_KEYS) {
    const value = get(key);
    if (value !== null || stamps[key]) values[key] = { value, at: stamps[key] ?? 0 };
  }
  return { version: 1, values };
}

export function mergeUserConfig(a: UserConfig, b: UserConfig): UserConfig {
  const values: Record<string, Stamped> = { ...a.values };
  for (const [key, entry] of Object.entries(b.values ?? {})) {
    const mine = values[key];
    if (!mine || (entry?.at ?? 0) >= (mine.at ?? 0)) values[key] = entry;
  }
  return { version: 1, values };
}

function applyUserConfig(remote: unknown) {
  const value = remote as UserConfig | null;
  if (!value?.values) return;
  // A change made in the last moment has no time yet: stamp it first, or the
  // shared (older) value would replace it.
  check();
  const stamps = readStamps();
  for (const key of USER_KEYS) {
    const entry = value.values[key];
    if (!entry) continue;
    // A newer local change (not yet shared) is kept.
    if ((stamps[key] ?? 0) > (entry.at ?? 0)) continue;
    if (get(key) !== entry.value) {
      set(key, entry.value);
      announce(key, entry.value);
    }
    stamps[key] = entry.at ?? 0;
  }
  set(STAMPS_KEY, JSON.stringify(stamps));
  snapshot = takeSnapshot();
}

const userSync = createAgentSync({
  name: "user-config",
  getLocal: localUserConfig,
  applyRemote: applyUserConfig,
  merge: (local, remote) => mergeUserConfig(local as UserConfig, remote as UserConfig),
  isMeaningful: (value) => Object.keys((value as UserConfig | null)?.values ?? {}).length > 0,
});

/* --------------------- per-browser layout / editors --------------------- */

export function mergePerBrowser(a: PerBrowser | null, b: PerBrowser | null): PerBrowser {
  const browsers: Record<string, BrowserEntry> = { ...(a?.browsers ?? {}) };
  for (const [id, entry] of Object.entries(b?.browsers ?? {})) {
    const mine = browsers[id];
    if (!mine || (entry?.updatedAt ?? 0) >= (mine.updatedAt ?? 0)) browsers[id] = entry;
  }
  return { version: 1, browsers };
}

/** The entry to restore for this browser: its own, else the newest one. */
export function entryToRestore(value: PerBrowser | null, id: string): { entry: BrowserEntry; own: boolean } | null {
  const browsers = value?.browsers ?? {};
  if (browsers[id]) return { entry: browsers[id], own: true };
  const newest = Object.values(browsers).sort((x, y) => (y.updatedAt ?? 0) - (x.updatedAt ?? 0))[0];
  return newest ? { entry: newest, own: false } : null;
}

function perBrowserSync(name: "browser-state" | "builder-state", keys: readonly string[], stampKey: string) {
  let known: PerBrowser | null = null;
  let restored = false;
  const local = (): PerBrowser => {
    const values: Record<string, string> = {};
    for (const key of keys) {
      const value = get(key);
      if (value !== null) values[key] = value;
    }
    let updatedAt = Number(get(stampKey) ?? 0);
    // A layout this browser already had (set before saving started) counts from now.
    if (!updatedAt && Object.keys(values).length > 0) {
      updatedAt = Date.now();
      set(stampKey, String(updatedAt));
    }
    const browsers = { ...(known?.browsers ?? {}) };
    if (Object.keys(values).length > 0 || updatedAt > 0) browsers[browserId()] = { label: browserLabel(), updatedAt, values };
    return { version: 1, browsers };
  };
  const apply = (remote: unknown) => {
    const value = remote as PerBrowser | null;
    known = value;
    if (restored) return; // after the first load this browser owns its entry
    restored = true;
    check(); // stamp any change made before this arrived
    const pick = entryToRestore(value, browserId());
    if (!pick) return;
    // Own entry: restore it (e.g. after browser data was cleared). Another
    // browser's: only fill in what this browser doesn't have yet.
    if (pick.own && Number(get(stampKey) ?? 0) > (pick.entry.updatedAt ?? 0)) return;
    for (const key of keys) {
      const v = pick.entry.values?.[key];
      if (v === undefined) continue;
      if (!pick.own && get(key) !== null) continue;
      if (get(key) !== v) {
        set(key, v);
        announce(key, v);
      }
    }
    snapshot = takeSnapshot();
  };
  return createAgentSync({
    name,
    getLocal: local,
    applyRemote: apply,
    merge: (a, b) => mergePerBrowser(a as PerBrowser, b as PerBrowser),
    isMeaningful: (value) => Object.keys((value as PerBrowser | null)?.browsers ?? {}).length > 0,
  });
}

const browserSync = perBrowserSync("browser-state", BROWSER_KEYS, "adboard-browser-state-at");
const builderSync = perBrowserSync("builder-state", BUILDER_KEYS, "adboard-builder-state-at");

/* ------------------------------ watcher ------------------------------ */

const ALL_KEYS = [...USER_KEYS, ...BROWSER_KEYS, ...BUILDER_KEYS];
let snapshot: Record<string, string | null> = {};
const takeSnapshot = () => Object.fromEntries(ALL_KEYS.map((key) => [key, get(key)]));

/** Notice local changes (any code path) and share them shortly after. */
function check() {
  const next = takeSnapshot();
  const now = Date.now();
  let user = false;
  let browser = false;
  let builder = false;
  const stamps = readStamps();
  for (const key of ALL_KEYS) {
    if (next[key] === snapshot[key]) continue;
    if ((USER_KEYS as readonly string[]).includes(key)) {
      stamps[key] = now;
      user = true;
    } else if ((BROWSER_KEYS as readonly string[]).includes(key)) browser = true;
    else builder = true;
  }
  snapshot = next;
  if (user) {
    set(STAMPS_KEY, JSON.stringify(stamps));
    userSync.push();
  }
  if (browser) {
    set("adboard-browser-state-at", String(now));
    browserSync.push();
  }
  if (builder) {
    set("adboard-builder-state-at", String(now));
    builderSync.push();
  }
}

let started = false;

/** Start saving preferences (once per page). */
export function startPrefs() {
  if (started || typeof window === "undefined") return;
  started = true;
  migrateLegacyKeys();
  snapshot = takeSnapshot();
  userSync.start();
  browserSync.start();
  builderSync.start();
  window.setInterval(check, WATCH_MS);
  const flush = () => {
    check();
    void userSync.flush();
    void browserSync.flush();
    void builderSync.flush();
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

/** Start, and wait (briefly) for saved preferences before the app first renders. */
export function prefsReady(timeoutMs = 1500): Promise<void> {
  startPrefs();
  return Promise.all([userSync.ready(timeoutMs), browserSync.ready(timeoutMs), builderSync.ready(timeoutMs)]).then(() => undefined);
}
