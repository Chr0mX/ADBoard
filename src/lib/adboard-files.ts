/**
 * ADBoard file names and file formats: touch macro files, Shell Automation
 * script files and the whole-library file, plus reading the older files
 * (PhoneControl desk exports, raw job JSON) and merging an imported library
 * into the current one.
 *
 * The agent derives file names in the data folder with the same rule
 * (crates/adboard-agent/src/data_dir.rs safe_file_stem), so an exported file
 * and the saved file share a name.
 *
 * Pure module: no React, no browser APIs, so it runs under `node --test`.
 */
import type { MacroTab } from "@/lib/macro/core";
import type { MacroSchedule, QueueItem } from "@/lib/macro/automation";
import type { DeskLibrary, SavedMacro } from "@/lib/desk/store";

/* ------------------------------ names ------------------------------ */

/** Touch macro file (one or more macro tabs): `<Name>.json`. The `format` inside says what it is. */
export const MACRO_EXT = ".json";
/** Shell Automation script file (one script): `<Name>.json`. */
export const SHELL_EXT = ".json";
/** Whole library: touch macros, Shell Automation, queue, schedules, phone choices. */
export const LIBRARY_FILE = "adboard-library.json";
/** All touch macros in one file. */
export const ALL_MACROS_FILE = `adboard-macros${MACRO_EXT}`;

export const UNTITLED_MACRO = "Untitled macro";
export const UNTITLED_SCRIPT = "Untitled script";

const RESERVED = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/i;

/**
 * A file name stem that works on Windows: `<>:"/\|?*`, control characters and
 * spaces become `_`, trailing dots go, reserved names (CON, NUL, COM1…) get a
 * `_`, and it is capped at 80 characters. An empty name gives `fallback`.
 * "Daily:Login?" → "Daily_Login_".
 */
export function safeFileStem(name: string, fallback = "Untitled"): string {
  const cleaned = Array.from(name.trim())
    .map((c) => (/[<>:"/\\|?*\s]/.test(c) || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? "_" : c))
    .slice(0, 80)
    .join("")
    .replace(/\.+$/, "");
  let out = /^_*$/.test(cleaned) ? fallback.replace(/\s+/g, "_") : cleaned;
  if (RESERVED.test(out.split(".")[0])) out += "_";
  return out;
}

/** `name`, or "name 2", "name 3"… — the first display name not in `taken` (case-insensitive). */
export function uniqueName(name: string, taken: Iterable<string>, fallback = "Untitled"): string {
  const base = name.trim() || fallback;
  const used = new Set(Array.from(taken, (t) => t.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export const macroFileName = (name: string) => `${safeFileStem(name, UNTITLED_MACRO)}${MACRO_EXT}`;
export const shellFileName = (name: string) => `${safeFileStem(name, UNTITLED_SCRIPT)}${SHELL_EXT}`;

/* ------------------------- Shell script file ------------------------- */

export const SHELL_FORMAT = "adboard-shell-script";
export const LIBRARY_FORMAT = "adboard-library";
const VERSION = 1;

export interface ShellScriptFile {
  format: typeof SHELL_FORMAT;
  version: 1;
  app: "ADBoard";
  exportedAt?: string;
  script: SavedMacro;
}

export function exportShellScript(script: SavedMacro, now = new Date()): string {
  const file: ShellScriptFile = { format: SHELL_FORMAT, version: VERSION, app: "ADBoard", exportedAt: now.toISOString(), script };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** What a file picked in Shell Automation → Import holds. */
export type ShellImport =
  | { kind: "scripts"; scripts: SavedMacro[]; source: "adboard-shell-script" | "job" }
  | { kind: "library"; library: Partial<DeskLibrary>; source: "desk" | "adboard-library" };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isJob = (v: unknown): v is SavedMacro => isObject(v) && typeof v.name === "string" && Array.isArray(v.steps);

function parseJson(text: string): unknown {
  const trimmed = text.replace(/^﻿/, "").trim();
  if (!trimmed) throw new Error("File is empty");
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error("File is not valid JSON — it may be cut off or not an ADBoard file");
  }
}

function checkVersion(file: Record<string, unknown>, what: string) {
  const version = Number(file.version);
  if (!Number.isFinite(version)) throw new Error(`${what} has no version`);
  if (version > VERSION) throw new Error(`${what} was made by a newer ADBoard (format ${version}); this one reads up to ${VERSION}`);
}

/**
 * Read a Shell Automation file by its contents, not its extension: an ADBoard
 * script file, the whole-library file, or (older) a PhoneControl desk export
 * or one raw job.
 */
export function parseShellImport(text: string): ShellImport {
  const parsed = parseJson(text);
  if (!isObject(parsed)) throw new Error("Not a Shell Automation file");
  if (parsed.format === SHELL_FORMAT) {
    checkVersion(parsed, "Script file");
    if (!isJob(parsed.script)) throw new Error("Script file has no script with steps");
    return { kind: "scripts", scripts: [parsed.script], source: "adboard-shell-script" };
  }
  if (parsed.format === LIBRARY_FORMAT) {
    const library = parseLibraryFile(text);
    return { kind: "library", library: library.shellLibrary, source: "adboard-library" };
  }
  if (parsed.format === "adboard-macros") throw new Error("This is a touch macro file — import it in Macros");
  if (Array.isArray(parsed.macros) || Array.isArray(parsed.apps)) {
    return { kind: "library", library: parsed as Partial<DeskLibrary>, source: "desk" };
  }
  if (isJob(parsed)) return { kind: "scripts", scripts: [parsed], source: "job" };
  throw new Error("Not a Shell Automation file — expected an ADBoard script or library file");
}

/* --------------------------- library file --------------------------- */

export interface TouchMacros {
  version: 1;
  tabs: MacroTab[];
  activeId: string | null;
}

export interface Automation {
  queue: QueueItem[];
  schedules: MacroSchedule[];
  /** deviceId → touch macro tab id. */
  assignments: Record<string, string>;
}

export interface LibraryFile {
  format: typeof LIBRARY_FORMAT;
  version: 1;
  app: "ADBoard";
  exportedAt: string;
  touchMacros: TouchMacros;
  shellLibrary: DeskLibrary;
  automation: Automation;
}

export function exportLibraryFile(parts: { touchMacros: TouchMacros; shellLibrary: DeskLibrary; automation: Automation }, now = new Date()): string {
  const file: LibraryFile = { format: LIBRARY_FORMAT, version: VERSION, app: "ADBoard", exportedAt: now.toISOString(), ...parts };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Read an adboard-library.json. Missing parts come back empty; the caller validates each part. */
export function parseLibraryFile(text: string): LibraryFile {
  const parsed = parseJson(text);
  if (!isObject(parsed) || parsed.format !== LIBRARY_FORMAT) throw new Error("Not an ADBoard library file (adboard-library.json)");
  checkVersion(parsed, "Library file");
  const touch = isObject(parsed.touchMacros) ? parsed.touchMacros : {};
  const automation = isObject(parsed.automation) ? parsed.automation : {};
  return {
    format: LIBRARY_FORMAT,
    version: VERSION,
    app: "ADBoard",
    exportedAt: typeof parsed.exportedAt === "string" ? parsed.exportedAt : "",
    touchMacros: {
      version: 1,
      tabs: Array.isArray(touch.tabs) ? (touch.tabs as MacroTab[]) : [],
      activeId: typeof touch.activeId === "string" ? touch.activeId : null,
    },
    shellLibrary: (isObject(parsed.shellLibrary) ? parsed.shellLibrary : {}) as unknown as DeskLibrary,
    automation: {
      queue: Array.isArray(automation.queue) ? (automation.queue as QueueItem[]) : [],
      schedules: Array.isArray(automation.schedules) ? (automation.schedules as MacroSchedule[]) : [],
      assignments: isObject(automation.assignments) ? (automation.assignments as Record<string, string>) : {},
    },
  };
}

/* ------------------------------ merging ------------------------------ */

export interface MergeCount {
  added: number;
  renamed: number;
  skipped: number;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Add `incoming` items to `current`. An item with the same id and the same
 * contents is skipped (re-importing a file adds nothing); an id clash gets a
 * fresh id; with `fallbackName`, a display-name clash gets " 2". Returns the
 * id changes so references (queue, schedules, phone choices) can follow.
 */
export function mergeItems<T extends { id: string; name?: string }>(
  current: T[],
  incoming: T[],
  makeId: () => string,
  fallbackName?: string,
): { items: T[]; ids: Map<string, string>; count: MergeCount } {
  const items = [...current];
  const ids = new Map<string, string>();
  const count: MergeCount = { added: 0, renamed: 0, skipped: 0 };
  for (const item of incoming) {
    const existing = items.find((i) => i.id === item.id);
    if (existing && same(existing, item)) {
      count.skipped += 1;
      continue;
    }
    const id = existing || !item.id ? makeId() : item.id;
    if (id !== item.id) ids.set(item.id, id);
    let next = { ...item, id };
    if (fallbackName !== undefined) {
      const name = uniqueName(item.name ?? "", items.map((i) => i.name ?? ""), fallbackName);
      if (name !== item.name) count.renamed += 1;
      next = { ...next, name };
    }
    items.push(next);
    count.added += 1;
  }
  return { items, ids, count };
}

/** Keys missing from `current` are added; values already there are kept. */
const addMissing = <V>(current: Record<string, V>, incoming: Record<string, V> | undefined) => ({ ...(incoming ?? {}), ...current });

export function mergeShellLibrary(current: DeskLibrary, incoming: Partial<DeskLibrary>, makeId: (prefix: string) => string) {
  const scripts = mergeItems(current.macros, incoming.macros ?? [], () => makeId("macro"), UNTITLED_SCRIPT);
  const library: DeskLibrary = {
    ...current,
    macros: scripts.items,
    apps: mergeItems(current.apps, incoming.apps ?? [], () => makeId("app"), "App").items,
    groups: mergeItems(current.groups, incoming.groups ?? [], () => makeId("group"), "Group").items,
    variables: addMissing(current.variables, incoming.variables),
    deviceVariables: addMissing(current.deviceVariables, incoming.deviceVariables),
    tags: addMissing(current.tags, incoming.tags),
    profiles: addMissing(current.profiles, incoming.profiles),
  };
  return { library, scripts: scripts.count };
}

/** Merge a whole library file into the current data (the default import). */
export function mergeLibrary(
  current: { touchMacros: TouchMacros; shellLibrary: DeskLibrary; automation: Automation },
  incoming: LibraryFile,
  makeId: (prefix: string) => string,
) {
  const tabs = mergeItems(current.touchMacros.tabs, incoming.touchMacros.tabs, () => makeId("tab"), UNTITLED_MACRO);
  const shell = mergeShellLibrary(current.shellLibrary, incoming.shellLibrary, makeId);
  const tabId = (id: string) => tabs.ids.get(id) ?? id;
  const known = new Set(tabs.items.map((t) => t.id));
  const queue = mergeItems(
    current.automation.queue,
    incoming.automation.queue.map((q) => ({ ...q, tabId: tabId(q.tabId) })).filter((q) => known.has(q.tabId)),
    () => makeId("queue"),
  );
  const schedules = mergeItems(
    current.automation.schedules,
    incoming.automation.schedules
      .map((s) => (s.target.kind === "tab" ? { ...s, target: { kind: "tab" as const, tabId: tabId(s.target.tabId) } } : s))
      .filter((s) => s.target.kind !== "tab" || known.has(s.target.tabId)),
    () => makeId("schedule"),
  );
  const assignments = { ...current.automation.assignments };
  for (const [device, tab] of Object.entries(incoming.automation.assignments)) {
    if (!assignments[device] && known.has(tabId(tab))) assignments[device] = tabId(tab);
  }
  return {
    touchMacros: { ...current.touchMacros, tabs: tabs.items },
    shellLibrary: shell.library,
    automation: { queue: queue.items, schedules: schedules.items, assignments },
    count: { touchMacros: tabs.count, shellScripts: shell.scripts },
  };
}
