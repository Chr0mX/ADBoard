/** Pinnable Tools → bottom DeviceNavBar preferences. */

export const TASKBAR_PINS_KEY = "adboard-taskbar-pins";
/** Fixed phone controls the user may hide (Back, Home, Recent and Minimize never hide). */
export const TASKBAR_HIDDEN_KEY = "adboard-taskbar-hidden";
export const HIDEABLE_NAV_IDS = ["volume_down", "volume_up", "power"] as const;
export type HideableNavId = (typeof HIDEABLE_NAV_IDS)[number];
export const HIDEABLE_NAV_LABELS: Record<HideableNavId, string> = {
  volume_down: "Volume down",
  volume_up: "Volume up",
  power: "Power",
};

/** Visual group for each pinnable tool. Groups get a divider between them on the bar. */
export type TaskbarGroup = "view" | "capture" | "device";
export const TASKBAR_GROUP_LABELS: Record<TaskbarGroup, string> = {
  view: "View and input",
  capture: "Capture",
  device: "Device",
};
export const TASKBAR_TOOL_GROUP: Record<TaskbarToolId, TaskbarGroup> = {
  keyboard: "view",
  mouse: "view",
  grid: "view",
  rotate: "view",
  fullscreen: "view",
  pip: "view",
  quiet: "view",
  refresh: "view",
  desk: "view",
  macro: "view",
  record: "capture",
  replay: "capture",
  apk: "capture",
  screenshot: "capture",
  screenrec: "capture",
  stats: "device",
  devices: "device",
  cursor: "device",
  restart: "device",
  info: "device",
  quick: "device",
};

/** Hidden fixed controls, in the fixed order, without duplicates or unknown ids. */
export function normalizeHiddenNav(value: unknown): HideableNavId[] {
  if (!Array.isArray(value)) return [];
  return HIDEABLE_NAV_IDS.filter((id) => value.includes(id));
}

/** Every tool in the floating Tools icon grid (pin-from-icon targets). */
export const TASKBAR_TOOL_IDS = [
  "keyboard",
  "mouse",
  "record",
  "replay",
  "refresh",
  "apk",
  "grid",
  "stats",
  "devices",
  "desk",
  "cursor",
  "restart",
  "info",
  "quick",
  "rotate",
  "fullscreen",
  "pip",
  "quiet",
  "macro",
  "screenshot",
  "screenrec",
] as const;

/**
 * Max extra icons beside the fixed nav actions: room for every tool.
 * The bottom bar scrolls horizontally when pins overflow.
 */
export const MAX_TASKBAR_PINS = TASKBAR_TOOL_IDS.length;

export type TaskbarToolId = (typeof TASKBAR_TOOL_IDS)[number];

export const TASKBAR_TOOL_LABELS: Record<TaskbarToolId, string> = {
  keyboard: "Keyboard",
  mouse: "Touch",
  record: "Record",
  replay: "Replay",
  refresh: "Refresh",
  apk: "APK",
  grid: "Grid",
  stats: "Stats mode",
  devices: "Devices",
  desk: "Desk",
  cursor: "Cursor",
  restart: "Restart device",
  info: "Device info",
  quick: "Device actions",
  rotate: "Rotate",
  fullscreen: "Fullscreen",
  pip: "Pop out",
  quiet: "Quiet mode",
  macro: "Macros",
  screenshot: "Screenshot",
  screenrec: "Screen record",
};

const ID_SET = new Set<string>(TASKBAR_TOOL_IDS);

/** Default: nav-only taskbar (no Tools pins). */
export const DEFAULT_TASKBAR_PINS: TaskbarToolId[] = [];

export function isTaskbarToolId(value: unknown): value is TaskbarToolId {
  return typeof value === "string" && ID_SET.has(value);
}

export function normalizeTaskbarPins(value: unknown): TaskbarToolId[] {
  if (!Array.isArray(value)) return [...DEFAULT_TASKBAR_PINS];
  const seen = new Set<TaskbarToolId>();
  const next: TaskbarToolId[] = [];
  for (const item of value) {
    if (!isTaskbarToolId(item) || seen.has(item)) continue;
    seen.add(item);
    next.push(item);
    if (next.length >= MAX_TASKBAR_PINS) break;
  }
  return next;
}

/** Moves a pinned tool one place earlier (-1) or later (+1). Other pins keep their order. */
export function moveTaskbarPin(pins: TaskbarToolId[], id: TaskbarToolId, step: -1 | 1): TaskbarToolId[] {
  const from = pins.indexOf(id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= pins.length) return [...pins];
  const next = [...pins];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next;
}

export function readTaskbarPins(): TaskbarToolId[] {
  try {
    const raw = localStorage.getItem(TASKBAR_PINS_KEY);
    if (raw == null) return DEFAULT_TASKBAR_PINS;
    return normalizeTaskbarPins(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_TASKBAR_PINS;
  }
}

export function writeTaskbarPins(pins: TaskbarToolId[]) {
  try {
    localStorage.setItem(TASKBAR_PINS_KEY, JSON.stringify(normalizeTaskbarPins(pins)));
  } catch {
    // private mode
  }
}
