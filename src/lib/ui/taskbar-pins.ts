/** Pinnable Tools → bottom DeviceNavBar preferences. */

export const TASKBAR_PINS_KEY = "adboard-taskbar-pins";
/** Key used before the ADBoard rename; read once so saved pins carry over. */
export const LEGACY_TASKBAR_PINS_KEY = "rasiel-taskbar-pins";

/**
 * Max extra icons beside the fixed nav actions.
 * The bottom bar scrolls horizontally when pins overflow.
 */
export const MAX_TASKBAR_PINS = 18;

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
  "arrangement",
  "quick",
  "rotate",
  "fullscreen",
  "pip",
] as const;

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
  arrangement: "Arrangement",
  quick: "Quick actions",
  rotate: "Rotate",
  fullscreen: "Fullscreen",
  pip: "Pop out",
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
