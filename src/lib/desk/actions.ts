import type { MacroStep, MacroStepKind } from "@/lib/desk/store";
import type { GestureStroke, NormalizedPoint } from "@/lib/devices/types";

/*
 * Every Shell Automation action the runner can really execute, with its
 * fields, checks and how it reaches the phone. Nothing is listed here that
 * the agent cannot do: each kind maps to an agent operation in
 * `run-macro.ts` (adb shell commands, timed touches, keys or file transfers).
 */

export type ActionCategory =
  | "App Control"
  | "Device Control"
  | "Input Actions"
  | "Navigation"
  | "Files"
  | "Delays"
  | "Flow Control";

export const CATEGORIES: ActionCategory[] = [
  "App Control",
  "Device Control",
  "Input Actions",
  "Navigation",
  "Files",
  "Delays",
  "Flow Control",
];

/** How the action reaches the phone. */
export type Mechanism = "shell" | "touch" | "key" | "file" | "wait";

export const MECHANISM_LABEL: Record<Mechanism, { label: string; hint: string }> = {
  shell: { label: "Shell", hint: "Runs an adb shell command on the phone (needs ADB)" },
  touch: { label: "Touch", hint: "Simulated finger touch on the screen, at a position on the live preview" },
  key: { label: "Key", hint: "Sends an Android key (Home, Back…) through the control connection" },
  file: { label: "File", hint: "Moves a file between ADBoard and the phone (needs ADB)" },
  wait: { label: "Wait", hint: "Waits on ADBoard; nothing is sent to the phone" },
};

export type FieldKey =
  | "x"
  | "y"
  | "x2"
  | "y2"
  | "durationMs"
  | "direction"
  | "distance"
  | "text"
  | "nav"
  | "packageName"
  | "activity"
  | "command"
  | "hostPath"
  | "dest"
  | "ms"
  | "bitrate"
  | "size"
  | "intentVerb"
  | "tweak"
  | "tweakState";

export interface FieldDef {
  key: FieldKey;
  label: string;
  type: "percent" | "ms" | "number" | "text" | "select";
  placeholder?: string;
  help?: string;
  optional?: boolean;
  options?: Array<{ value: string; label: string }>;
}

export interface ActionDef {
  kind: MacroStepKind;
  label: string;
  category: ActionCategory;
  mechanism: Mechanism;
  description: string;
  fields: FieldDef[];
  /** Restarts or powers off the phone: asks before running. */
  dangerous?: boolean;
  /** Made elsewhere (Record touches in Control), not from the library. */
  recordedOnly?: boolean;
  defaults: Partial<MacroStep>;
}

const X: FieldDef = { key: "x", label: "X %", type: "percent", help: "0 = left edge, 100 = right edge" };
const Y: FieldDef = { key: "y", label: "Y %", type: "percent", help: "0 = top, 100 = bottom" };
const X2: FieldDef = { key: "x2", label: "End X %", type: "percent" };
const Y2: FieldDef = { key: "y2", label: "End Y %", type: "percent" };
const DURATION = (label: string): FieldDef => ({ key: "durationMs", label, type: "ms" });
const PACKAGE: FieldDef = { key: "packageName", label: "Package", type: "text", placeholder: "com.example.game", help: "The app id, e.g. com.android.chrome" };

export const ACTIONS: ActionDef[] = [
  /* App Control */
  {
    kind: "launch",
    label: "Launch app",
    category: "App Control",
    mechanism: "shell",
    description: "Opens an app (am start / monkey). Optionally a specific activity with extra am arguments.",
    fields: [
      PACKAGE,
      { key: "activity", label: "Activity", type: "text", optional: true, placeholder: ".MainActivity", help: "Leave empty to open the app's launcher screen" },
    ],
    defaults: { packageName: "" },
  },
  {
    kind: "forceStop",
    label: "Force stop app",
    category: "App Control",
    mechanism: "shell",
    description: "Closes an app completely (am force-stop).",
    fields: [PACKAGE],
    defaults: { packageName: "" },
  },
  {
    kind: "clearData",
    label: "Clear app data",
    category: "App Control",
    mechanism: "shell",
    description: "Wipes an app's data and cache, like a fresh install (pm clear). Logins inside the app are lost.",
    fields: [PACKAGE],
    defaults: { packageName: "" },
  },
  {
    kind: "install",
    label: "Install APK",
    category: "App Control",
    mechanism: "file",
    description: "Installs an APK stored on ADBoard (Files tab) on the phone.",
    fields: [{ key: "hostPath", label: "APK on ADBoard", type: "text", placeholder: "Downloads/game.apk", help: "Path in ADBoard's Files tab" }],
    defaults: { hostPath: "" },
  },
  {
    kind: "uninstall",
    label: "Uninstall app",
    category: "App Control",
    mechanism: "shell",
    description: "Removes an app for the phone's user (pm uninstall --user 0).",
    fields: [PACKAGE],
    defaults: { packageName: "" },
  },

  /* Device Control */
  {
    kind: "intent",
    label: "Send intent",
    category: "App Control",
    mechanism: "shell",
    description: "Sends a broadcast or starts an activity with am, e.g. to trigger an app's automation receiver. Only intent flags are allowed.",
    fields: [
      {
        key: "intentVerb",
        label: "Type",
        type: "select",
        options: [
          { value: "broadcast", label: "Broadcast" },
          { value: "start", label: "Start activity" },
        ],
      },
      {
        key: "command",
        label: "Arguments",
        type: "text",
        placeholder: "-a com.app.START -n com.app/.Receiver --es mode fast",
        help: "-a -c -d -t -n -p -f and extras --es --ez --ei --el --ef --ed",
      },
    ],
    defaults: { intentVerb: "broadcast", command: "" },
  },
  {
    kind: "startShizuku",
    label: "Start Shizuku",
    category: "Device Control",
    mechanism: "shell",
    description: "Starts the Shizuku server over adb (Shizuku, its forks and Shizuku-Next). Useful after a reboot. Does nothing when it is already running.",
    fields: [],
    defaults: {},
  },
  {
    kind: "tweak",
    label: "Phone tweak",
    category: "Device Control",
    mechanism: "shell",
    description: "Turns a phone-wide setting on or off (Device management → Tweaks).",
    fields: [
      {
        key: "tweak",
        label: "Setting",
        type: "select",
        options: [
          { value: "devOptionsHidden", label: "Hide Developer options" },
          { value: "phantomKillerOff", label: "Phantom process killer off" },
          { value: "forceDark", label: "Force dark" },
        ],
      },
      {
        key: "tweakState",
        label: "State",
        type: "select",
        options: [
          { value: "on", label: "On" },
          { value: "off", label: "Off" },
        ],
      },
    ],
    defaults: { tweak: "phantomKillerOff", tweakState: "on" },
  },
  {
    kind: "shell",
    label: "Shell command",
    category: "Device Control",
    mechanism: "shell",
    description: "Runs one adb shell command on the phone, e.g. input keyevent 26, settings put …, pm grant …. The output is shown in the run log.",
    fields: [{ key: "command", label: "Command", type: "text", placeholder: "settings put system screen_brightness 120", help: "One line. ${NAME} variables are filled in first." }],
    defaults: { command: "" },
  },
  {
    kind: "screenshot",
    label: "Screenshot",
    category: "Device Control",
    mechanism: "shell",
    description: "Takes a screenshot and saves it on ADBoard (Files → Screenshots).",
    fields: [],
    defaults: {},
  },
  {
    kind: "recordStart",
    label: "Start screen recording",
    category: "Device Control",
    mechanism: "shell",
    description: "Starts screenrecord on the phone (max 3 minutes). Stop it with “Stop screen recording”.",
    fields: [
      { key: "bitrate", label: "Bitrate (bits/s)", type: "number", placeholder: "8000000" },
      { key: "size", label: "Size", type: "text", optional: true, placeholder: "1280x720" },
      { key: "dest", label: "Folder on phone", type: "text", optional: true, placeholder: "/sdcard/Movies" },
    ],
    defaults: { bitrate: "8000000", size: "", dest: "/sdcard/Movies" },
  },
  {
    kind: "recordStop",
    label: "Stop screen recording",
    category: "Device Control",
    mechanism: "shell",
    description: "Stops a recording started by “Start screen recording”.",
    fields: [],
    defaults: {},
  },
  {
    kind: "reboot",
    label: "Reboot",
    category: "Device Control",
    mechanism: "shell",
    description: "Restarts the phone. It goes offline until it boots again (add “Wait for phone” after it).",
    fields: [],
    dangerous: true,
    defaults: {},
  },
  {
    kind: "shutdown",
    label: "Power off",
    category: "Device Control",
    mechanism: "shell",
    description: "Turns the phone off (reboot -p). It cannot be turned on again remotely.",
    fields: [],
    dangerous: true,
    defaults: {},
  },

  /* Input Actions */
  {
    kind: "tap",
    label: "Tap",
    category: "Input Actions",
    mechanism: "touch",
    description: "Taps one point on the screen.",
    fields: [X, Y],
    defaults: { x: 50, y: 50 },
  },
  {
    kind: "doubleTap",
    label: "Double tap",
    category: "Input Actions",
    mechanism: "touch",
    description: "Two quick taps on the same point.",
    fields: [X, Y],
    defaults: { x: 50, y: 50 },
  },
  {
    kind: "longPress",
    label: "Long press",
    category: "Input Actions",
    mechanism: "touch",
    description: "Holds a finger on one point.",
    fields: [X, Y, DURATION("Hold time")],
    defaults: { x: 50, y: 50, durationMs: 800 },
  },
  {
    kind: "swipe",
    label: "Swipe",
    category: "Input Actions",
    mechanism: "touch",
    description: "Slides a finger from a start point to an end point.",
    fields: [X, Y, X2, Y2, DURATION("Swipe time")],
    defaults: { x: 50, y: 70, x2: 50, y2: 30, durationMs: 300 },
  },
  {
    kind: "drag",
    label: "Drag",
    category: "Input Actions",
    mechanism: "touch",
    description: "Presses and holds, then moves to the end point (moves icons, sliders).",
    fields: [X, Y, X2, Y2, DURATION("Total time")],
    defaults: { x: 30, y: 50, x2: 70, y2: 50, durationMs: 1200 },
  },
  {
    kind: "scroll",
    label: "Scroll",
    category: "Input Actions",
    mechanism: "touch",
    description: "A straight finger swipe up or down from a point, to scroll a list.",
    fields: [
      X,
      Y,
      {
        key: "direction",
        label: "Finger moves",
        type: "select",
        options: [
          { value: "up", label: "Up (shows content below)" },
          { value: "down", label: "Down (shows content above)" },
        ],
      },
      { key: "distance", label: "Distance %", type: "percent" },
      DURATION("Swipe time"),
    ],
    defaults: { x: 50, y: 70, direction: "up", distance: 30, durationMs: 300 },
  },
  {
    kind: "pinch",
    label: "Pinch / zoom",
    category: "Input Actions",
    mechanism: "touch",
    description: "Two fingers move apart (zoom in) or together (zoom out) around a point.",
    fields: [
      X,
      Y,
      {
        key: "direction",
        label: "Fingers",
        type: "select",
        options: [
          { value: "out", label: "Move apart (zoom in)" },
          { value: "in", label: "Move together (zoom out)" },
        ],
      },
      { key: "distance", label: "Distance %", type: "percent" },
      DURATION("Pinch time"),
    ],
    defaults: { x: 50, y: 50, direction: "out", distance: 20, durationMs: 400 },
  },
  {
    kind: "text",
    label: "Type text",
    category: "Input Actions",
    mechanism: "shell",
    description: "Types text into the focused field (input text). Letters, numbers, spaces and simple punctuation only.",
    fields: [{ key: "text", label: "Text", type: "text", placeholder: "${USERNAME}" }],
    defaults: { text: "" },
  },
  {
    kind: "gesture",
    label: "Recorded touch",
    category: "Input Actions",
    mechanism: "touch",
    description: "A touch path recorded with Record touches in Control. It replays exactly as recorded.",
    fields: [],
    recordedOnly: true,
    defaults: {},
  },

  /* Navigation */
  {
    kind: "nav",
    label: "Press key",
    category: "Navigation",
    mechanism: "key",
    description: "Presses an Android key: Home, Back, Recent apps, Power or volume.",
    fields: [
      {
        key: "nav",
        label: "Key",
        type: "select",
        options: [
          { value: "home", label: "Home" },
          { value: "back", label: "Back" },
          { value: "recent", label: "Recent apps" },
          { value: "power", label: "Power" },
          { value: "volume_up", label: "Volume up" },
          { value: "volume_down", label: "Volume down" },
        ],
      },
    ],
    defaults: { nav: "home" },
  },

  /* Files */
  {
    kind: "upload",
    label: "Send file to phone",
    category: "Files",
    mechanism: "file",
    description: "Copies a file stored on ADBoard (Files tab) to a folder on the phone.",
    fields: [
      { key: "hostPath", label: "File on ADBoard", type: "text", placeholder: "Downloads/config.json" },
      { key: "dest", label: "Folder on phone", type: "text", placeholder: "/sdcard/Download/" },
    ],
    defaults: { hostPath: "", dest: "/sdcard/Download/" },
  },
  {
    kind: "download",
    label: "Get file from phone",
    category: "Files",
    mechanism: "file",
    description: "Copies a file from the phone into a folder on ADBoard (Files tab).",
    fields: [
      { key: "command", label: "File on phone", type: "text", placeholder: "/sdcard/Download/log.txt" },
      { key: "dest", label: "Folder on ADBoard", type: "text", placeholder: "Downloads" },
    ],
    defaults: { command: "", dest: "Downloads" },
  },
  {
    kind: "deleteFile",
    label: "Delete file on phone",
    category: "Files",
    mechanism: "shell",
    description: "Deletes a file or folder on the phone (storage roots are refused).",
    fields: [{ key: "command", label: "Path on phone", type: "text", placeholder: "/sdcard/Download/old.apk" }],
    defaults: { command: "" },
  },

  /* Delays */
  {
    kind: "wait",
    label: "Wait",
    category: "Delays",
    mechanism: "wait",
    description: "Pauses for a fixed time before the next step.",
    fields: [{ key: "ms", label: "Wait", type: "ms" }],
    defaults: { ms: 1000 },
  },

  /* Flow Control */
  {
    kind: "waitApp",
    label: "Wait for app",
    category: "Flow Control",
    mechanism: "shell",
    description: "Waits until an app's process is running (pidof). Fails the step after the time limit.",
    fields: [PACKAGE, { key: "ms", label: "Time limit", type: "ms" }],
    defaults: { packageName: "", ms: 15000 },
  },
  {
    kind: "waitDevice",
    label: "Wait for phone",
    category: "Flow Control",
    mechanism: "wait",
    description: "Waits until the phone is online again (e.g. after Reboot). Fails after the time limit.",
    fields: [{ key: "ms", label: "Time limit", type: "ms" }],
    defaults: { ms: 120000 },
  },
  {
    kind: "waitScreen",
    label: "Wait for live screen",
    category: "Flow Control",
    mechanism: "wait",
    description: "Waits until the phone's live screen stream is running (needed for touch steps after a reconnect).",
    fields: [{ key: "ms", label: "Time limit", type: "ms" }],
    defaults: { ms: 20000 },
  },
  {
    kind: "timeout",
    label: "Set wait time limit",
    category: "Flow Control",
    mechanism: "wait",
    description: "Default time limit for the Wait for … steps after it that have no limit of their own.",
    fields: [{ key: "ms", label: "Time limit", type: "ms" }],
    defaults: { ms: 15000 },
  },
];

const BY_KIND = new Map(ACTIONS.map((action) => [action.kind, action]));

export function actionOf(kind: MacroStepKind): ActionDef | undefined {
  return BY_KIND.get(kind);
}

/** Ids for new steps (jobs keep the store's own id scheme). */
function stepId() {
  return `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newStep(kind: MacroStepKind): MacroStep {
  return { id: stepId(), kind, ...(actionOf(kind)?.defaults ?? {}) };
}

export function copyStep(step: MacroStep): MacroStep {
  return { ...structuredClone(step), id: stepId() };
}

/* ------------------------------ checks ------------------------------ */

const MAX_MS = 3_600_000;
// Same rules the agent applies, so problems show before running.
const PACKAGE_RE = /^[A-Za-z0-9_.]+$/;
const UNSAFE_TEXT = /[;|&`$()<>'"\\\r\n]/;

/** `${NAME}` placeholders are filled in at run time; check what is around them. */
function withoutVariables(value: string) {
  return value.replace(/\$\{[A-Z0-9_]+\}/g, "x");
}

/** Problems with a step, keyed by field ("step" for the whole step). Empty = ready to run. */
export function validateStep(step: MacroStep): Partial<Record<FieldKey | "step", string>> {
  const action = actionOf(step.kind);
  const errors: Partial<Record<FieldKey | "step", string>> = {};
  if (!action) {
    errors.step = `“${step.kind}” is not a supported action`;
    return errors;
  }
  for (const field of action.fields) {
    const raw = step[field.key as keyof MacroStep];
    const empty = raw === undefined || raw === null || raw === "";
    if (empty) {
      if (!field.optional && field.type !== "select") errors[field.key] = "Required";
      continue;
    }
    if (field.type === "percent") {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) errors[field.key] = "0 to 100";
    } else if (field.type === "ms") {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > MAX_MS) errors[field.key] = "0 to 3,600,000 ms";
    }
  }
  const pkg = step.packageName ?? "";
  if (action.fields.some((f) => f.key === "packageName") && pkg) {
    const plain = withoutVariables(pkg);
    const hasVariable = plain !== pkg;
    if (!PACKAGE_RE.test(plain) || (!hasVariable && !plain.includes("."))) errors.packageName = "Looks like com.example.app";
  }
  if (step.kind === "text" && step.text && UNSAFE_TEXT.test(withoutVariables(step.text))) {
    errors.text = "input text can't type ; | & ` $ ( ) < > ' \" \\";
  }
  if (step.kind === "intent" && step.command && /[;|&`$<>\n]/.test(withoutVariables(step.command))) {
    errors.command = "Only intent flags and values (no ; | & ` $ < >)";
  }
  if (step.kind === "shell" && step.command && (step.command.includes("\n") || step.command.length > 2000)) {
    errors.command = "One line, up to 2000 characters";
  }
  if ((step.kind === "deleteFile" || step.kind === "download") && step.command && !step.command.startsWith("/")) {
    errors.command = "Absolute phone path, starting with /";
  }
  if (step.kind === "upload" && step.dest && !step.dest.startsWith("/")) errors.dest = "Absolute phone path, starting with /";
  if (step.kind === "recordStart") {
    if (step.bitrate && !/^\d+$/.test(step.bitrate)) errors.bitrate = "Digits only";
    if (step.size && !/^\d{2,5}x\d{2,5}$/.test(step.size)) errors.size = "Like 1280x720";
    if (step.dest && !step.dest.startsWith("/")) errors.dest = "Absolute phone path, starting with /";
  }
  if (step.kind === "gesture" && !(step.samples?.length)) errors.step = "The recording is empty";
  return errors;
}

/* --------------------------- touch geometry --------------------------- */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const pct = (v: number | undefined, fallback: number) => clamp01((v ?? fallback) / 100);

export interface TouchGeometry {
  /** 0–1 of the screen. */
  start: NormalizedPoint;
  end?: NormalizedPoint;
  /** Pinch: the second finger. */
  start2?: NormalizedPoint;
  end2?: NormalizedPoint;
}

/** Where a touch step lands, 0–1 of the screen (null = not a positioned touch step). */
export function touchGeometry(step: MacroStep): TouchGeometry | null {
  const start = { x: pct(step.x, 50), y: pct(step.y, 50) };
  switch (step.kind) {
    case "tap":
    case "doubleTap":
    case "longPress":
      return { start };
    case "swipe":
    case "drag":
      return { start, end: { x: pct(step.x2, 50), y: pct(step.y2, 30) } };
    case "scroll": {
      const d = (step.distance ?? 30) / 100;
      return { start, end: { x: start.x, y: clamp01(step.direction === "down" ? start.y + d : start.y - d) } };
    }
    case "pinch": {
      const d = (step.distance ?? 20) / 100;
      const outward = step.direction !== "in";
      const near = 0.02;
      const from = outward ? near : d;
      const to = outward ? d : near;
      return {
        start: { x: clamp01(start.x - from), y: start.y },
        end: { x: clamp01(start.x - to), y: start.y },
        start2: { x: clamp01(start.x + from), y: start.y },
        end2: { x: clamp01(start.x + to), y: start.y },
      };
    }
    default:
      return null;
  }
}

/** The strokes the agent plays for a touch step (same gesture endpoint as Macros). */
export function touchStrokes(step: MacroStep, geometry: TouchGeometry): GestureStroke[][] {
  const ms = (fallback: number) => Math.round(Math.min(60_000, Math.max(10, step.durationMs ?? fallback)));
  const { start, end, start2, end2 } = geometry;
  switch (step.kind) {
    case "tap":
      return [[{ pointer: 0, startMs: 0, durationMs: 50, points: [start] }]];
    case "doubleTap":
      return [[
        { pointer: 0, startMs: 0, durationMs: 50, points: [start] },
        { pointer: 0, startMs: 130, durationMs: 50, points: [start] },
      ]];
    case "longPress":
      return [[{ pointer: 0, startMs: 0, durationMs: ms(800), points: [start] }]];
    case "swipe":
    case "scroll":
      return [[{ pointer: 0, startMs: 0, durationMs: ms(300), points: [start, end ?? start] }]];
    case "drag":
      // Each segment takes equal time: hold on the first, move on the second.
      return [[{ pointer: 0, startMs: 0, durationMs: ms(1200), points: [start, start, end ?? start] }]];
    case "pinch":
      return [[
        { pointer: 0, startMs: 0, durationMs: ms(400), points: [start, end ?? start] },
        { pointer: 1, startMs: 0, durationMs: ms(400), points: [start2 ?? start, end2 ?? start] },
      ]];
    default:
      return [];
  }
}

/* ------------------------------ summary ------------------------------ */

const fmtMs = (ms?: number) => (ms === undefined ? "" : ms >= 1000 ? `${+(ms / 1000).toFixed(2)} s` : `${ms} ms`);

/** One line describing a step's settings. */
export function summarizeStep(step: MacroStep): string {
  const at = `${step.x ?? 50}%, ${step.y ?? 50}%`;
  switch (step.kind) {
    case "tap":
    case "doubleTap":
      return `at ${at}`;
    case "longPress":
      return `at ${at} · ${fmtMs(step.durationMs ?? 800)}`;
    case "swipe":
    case "drag":
      return `${at} → ${step.x2 ?? 50}%, ${step.y2 ?? 30}% · ${fmtMs(step.durationMs ?? (step.kind === "drag" ? 1200 : 300))}`;
    case "scroll":
      return `at ${at} · finger ${step.direction === "down" ? "down" : "up"} ${step.distance ?? 30}%`;
    case "pinch":
      return `at ${at} · ${step.direction === "in" ? "zoom out" : "zoom in"} ${step.distance ?? 20}%`;
    case "text":
      return step.text ? `“${step.text}”` : "(no text)";
    case "shell":
      return step.command || step.text || "(no command)";
    case "intent":
      return `${step.intentVerb === "start" ? "start" : "broadcast"} ${step.command || "(no arguments)"}`;
    case "startShizuku":
      return "start the Shizuku server";
    case "tweak":
      return `${actionOf("tweak")?.fields[0].options?.find((o) => o.value === step.tweak)?.label ?? "(no tweak)"} ${step.tweakState === "off" ? "off" : "on"}`;
    case "nav":
      return actionOf("nav")?.fields[0].options?.find((o) => o.value === (step.nav ?? "home"))?.label ?? "Home";
    case "launch":
      return [step.packageName, step.activity].filter(Boolean).join(" / ") || "(no package)";
    case "forceStop":
    case "clearData":
    case "uninstall":
      return step.packageName || "(no package)";
    case "install":
      return step.hostPath || step.text || "(no file)";
    case "upload":
      return `${step.hostPath || step.text || "(no file)"} → ${step.dest || "/sdcard/Download/"}`;
    case "download":
      return `${step.command || "(no path)"} → ${step.dest || "Downloads"}`;
    case "deleteFile":
      return step.command || "(no path)";
    case "wait":
      return fmtMs(step.ms ?? 500);
    case "waitApp":
      return `${step.packageName || "(no package)"} · up to ${fmtMs(step.ms ?? 15000)}`;
    case "waitDevice":
    case "waitScreen":
    case "timeout":
      return `up to ${fmtMs(step.ms ?? 15000)}`;
    case "recordStart":
      return [step.size, step.dest].filter(Boolean).join(" · ") || "default size";
    case "gesture":
      return `${step.samples?.length ?? 0} recorded pointer events`;
    default:
      return "";
  }
}
